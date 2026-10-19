import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { encodeFunctionData, formatEther, getAddress, parseEther, verifyMessage, zeroAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { AccountStream } from './account.ts'
import { RelayerError, getTradingState, submitIntent, type Instrument, type TradingState } from './api.ts'
import { CONTRACTS, SESSION_TTL_SEC, STATE_DIR, USDC_UNIT } from './config.ts'
import { EXCHANGE_DOMAIN, deadlineFromNow, intentFromSignature, signIntent, walletTypedData } from './eip712.ts'
import { PublicStream } from './intake.ts'
import { toPriceRaw } from './market.ts'
import { sideHeadroomUsd } from './risk.ts'
import { baseHeaders, serveAsset, serveChartJs, servePage, serveSiteJs } from './site.ts'
import { startQueueRelay } from './queue-viz.ts'
import { CandleStore } from './candles.ts'
import { NonceSource } from './state.ts'
import { UserStore, issueToken, openKey, readToken, sealKey, signInMessage, type UserRecord } from './users.ts'
import { log, makeClient, usd } from './bot.ts'

// Limit Intents (its own Railway service, PT_PROCESS=trigger), a public page where anyone can place orders like "long
// BTC once it trades at or below $79,000, $225 margin at 35x" on their own Papertrade account:
// - Visitors connect a browser wallet and sign in by signing a message (no gas). They then approve a Papertrade
//   trading key (session key) for this server, which it keeps encrypted (src/users.ts) and uses only to send their
//   opens. The key can't withdraw, and the wallet can revoke it at any time.
// - This process watches Hyperliquid's best bid/offer (the book the contract prices from) and sends the open when the
//   mid crosses the trigger. It is NOT a limit order: the intent has no price field, so the fill is the mid when the
//   relayer lands it, which in a backed-up queue can be well past the trigger. Each sent intent carries a short
//   deadline, so a stale one expires instead of filling late. An order holds while the relayer queue is backed up.
// Opens only: it never closes anything. PT_MODE=live sends for real; dry signs nothing and only logs. State lives in
// <state dir>: trigger-orders.json, users.json (sealed keys) and candles/.

const PORT = Number(process.env.PORT ?? process.env.PT_TRIGGER_PORT ?? 8788)
const PUBLIC = Boolean(process.env.PORT) // Railway sets PORT; locally the page stays on localhost
const HOST = PUBLIC ? '0.0.0.0' : '127.0.0.1'
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws'
// Hold a triggered order while the relayer has this many intents queued or more (~17 land per block at best).
const MAX_QUEUED = Number(process.env.PT_TRIGGER_MAX_QUEUED ?? 250)
const DEFAULT_LEVERAGE = Number(process.env.PT_LEVERAGE ?? 25)
const PRICE_STALE_MS = 10_000
const TRADING_POLL_MS = 5000
const TRADING_STALE_MS = 30_000
const CHECK_MS = 1000
const MAX_ATTEMPTS = 3 // sends per order; a relayer rejection or an expired intent re-arms it until then
const AUTH_TTL_MS = 7 * 86_400_000 // sign-in cookie lifetime
const SIGN_IN_TTL_MS = 5 * 60_000 // a sign-in message must be signed within this
const KEY_RENEW_SEC = 3 * 86_400 // offer a fresh trading key when the current one has less than this left
const MAX_ARMED_PER_WALLET = 20
const IDLE_STREAM_MS = 5 * 60_000 // stop following an account with no armed orders after this long unseen
const MAX_ACCOUNTS = 500 // account feeds open at once; past this, view-only lookups of new wallets wait
const FAILED_OUTCOMES = new Set(['failed', 'expired', 'cancelled'])
// Trading unlock: a one-time PT_FEE_HYPE (default 0.1) HYPE transfer on HyperEVM to PT_FEE_ADDRESS. Wallets in
// PT_FEE_EXEMPT (comma-separated) skip it. Without PT_FEE_ADDRESS there is no fee.
const FEE_ADDRESS = process.env.PT_FEE_ADDRESS ? getAddress(process.env.PT_FEE_ADDRESS) : null
const FEE_WEI = parseEther(process.env.PT_FEE_HYPE || '0.1')
const FEE_EXEMPT = new Set((process.env.PT_FEE_EXEMPT ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))
const PENDING_REWARD_ABI = [{ type: 'function', name: 'pendingReward', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const
const REWARD_REFRESH_MS = 60_000
const REVOKE_ABI = [{ type: 'function', name: 'revokeSessionKey', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }] as const
const FILL_GRACE_MS = 120_000 // after the intent's deadline, how long to keep looking for its position
const KEEP_DONE = 50 // finished orders kept for the page
const ORDERS_FILE = () => join(STATE_DIR, 'trigger-orders.json')
const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

export type OrderStatus = 'armed' | 'sending' | 'sent' | 'filled' | 'failed' | 'cancelled' | 'expired' | 'unconfirmed'
export type TriggerOrder = {
  id: string
  /** The Papertrade account (connected wallet) it trades. */
  wallet: Address
  symbol: string
  isLong: boolean
  triggerPx: number
  /** Fires once the mid is at or below (or above) the trigger; set from the side of the mid it was placed on. */
  when: 'below' | 'above'
  /** Share of the free balance used as margin when it fires (0 when fixedMarginUsd is set). */
  marginPct: number
  /** Margin in USD, if the order was placed with a dollar amount rather than a share of the balance. */
  fixedMarginUsd?: number
  leverage: number
  createdAt: number
  expiresAt: number
  /** The sent intent's deadline; past it the relayer drops it instead of filling late. */
  deadlineSec: number
  status: OrderStatus
  attempts: number
  note?: string
  sentAt?: number
  intentId?: Hex
  firedPx?: number
  marginUsd?: number
  fill?: { positionId: string; entryPx: number; waitedS: number }
}

export type OrderInput = {
  symbol?: unknown
  side?: unknown
  triggerPx?: unknown
  marginPct?: unknown
  marginUsd?: unknown
  leverage?: unknown
  expiresHours?: unknown
  deadlineSec?: unknown
}

/** Validate a new order from the page against the market and the current mid; returns the order or an error. */
export function newOrder(input: OrderInput, inst: Instrument | undefined, midPx: number, now = Date.now(), wallet: Address = zeroAddress): TriggerOrder | string {
  if (!inst) return 'unknown market'
  if (input.side !== 'long' && input.side !== 'short') return 'side must be long or short'
  const triggerPx = Number(input.triggerPx)
  if (!Number.isFinite(triggerPx) || triggerPx <= 0) return 'trigger price must be a positive number'
  if (Math.abs(triggerPx / midPx - 1) > 0.5) return 'trigger is more than 50% from the current price; check for a typo'
  // Margin is either a dollar amount (marginUsd) or a share of the free balance when it fires (marginPct).
  const fixedMarginUsd = input.marginUsd == null || input.marginUsd === '' ? undefined : Math.floor(Number(input.marginUsd) * 100) / 100
  if (fixedMarginUsd !== undefined && (!Number.isFinite(fixedMarginUsd) || fixedMarginUsd <= 0)) return 'margin must be a positive dollar amount'
  const marginPct = fixedMarginUsd !== undefined ? 0 : Number(input.marginPct)
  if (fixedMarginUsd === undefined && (!Number.isFinite(marginPct) || marginPct < 0.01 || marginPct > 1)) return 'margin must be 1–100% of the free balance'
  const leverage = Number(input.leverage)
  if (!Number.isInteger(leverage) || leverage < 1) return 'leverage must be a whole number of at least 1'
  if (leverage > inst.maxLeverage) return `leverage is above ${inst.symbol}'s max of ${inst.maxLeverage}x`
  const expiresHours = Number(input.expiresHours ?? 24)
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 24 * 30) return 'expiry must be between 0 and 30 days'
  const deadlineSec = Number(input.deadlineSec ?? 60)
  if (!Number.isInteger(deadlineSec) || deadlineSec < 15 || deadlineSec > 3600) return 'deadline must be 15–3600 seconds'
  return {
    id: randomUUID().slice(0, 8),
    wallet,
    symbol: inst.symbol,
    isLong: input.side === 'long',
    triggerPx,
    when: triggerPx <= midPx ? 'below' : 'above',
    marginPct,
    ...(fixedMarginUsd !== undefined ? { fixedMarginUsd } : {}),
    leverage,
    createdAt: now,
    expiresAt: now + expiresHours * 3_600_000,
    deadlineSec,
    status: 'armed',
    attempts: 0,
  }
}

export const crossed = (o: Pick<TriggerOrder, 'when' | 'triggerPx'>, midPx: number) =>
  o.when === 'below' ? midPx <= o.triggerPx : midPx >= o.triggerPx

/** Margin and notional the order would open with from `availableUsd`, or why it can't. Keeps $1 back, like the bot. */
export function sizeOrder(o: Pick<TriggerOrder, 'marginPct' | 'fixedMarginUsd' | 'leverage'>, availableUsd: number, inst: Instrument, trading: TradingState) {
  if (o.fixedMarginUsd !== undefined && o.fixedMarginUsd > availableUsd - 1) {
    return `needs ${usd(o.fixedMarginUsd)} margin but only ${usd(Math.max(availableUsd, 0))} is free`
  }
  const marginUsd = o.fixedMarginUsd ?? Math.floor(Math.min(availableUsd * o.marginPct, availableUsd - 1) * 100) / 100
  const marginRaw = BigInt(Math.round(Math.max(marginUsd, 0) * 1e6)) * USDC_UNIT
  const notionalRaw = marginRaw * BigInt(o.leverage)
  if (marginRaw <= 0n || marginRaw < trading.minimumTradeSizeRaw) {
    return `margin ${usd(Math.max(marginUsd, 0))} (of ${usd(availableUsd)} free) is below the ${usd(Number(trading.minimumTradeSizeRaw) / 1e18)} minimum`
  }
  if (notionalRaw < trading.minimumOpenNotionalRaw) return `notional is below the ${usd(Number(trading.minimumOpenNotionalRaw) / 1e18, 0)} minimum`
  if (notionalRaw > inst.maxPositionNotionalRaw) return 'notional is above the per-position max'
  return { marginRaw, marginUsd, notionalUsd: marginUsd * o.leverage }
}

/** Why a triggered order can't go out right now, or null when it can. */
export function holdReason(
  o: TriggerOrder,
  inst: Instrument,
  trading: TradingState,
  midRaw: bigint,
  availableUsd: number,
  queued: number | null,
  maxQueued = MAX_QUEUED,
): string | null {
  if (!inst.openable || inst.closeOnly || inst.retired || trading.tradingPaused || trading.pausedActions.includes('openPosition')) {
    return `${inst.symbol} opens are paused`
  }
  const size = sizeOrder(o, availableUsd, inst, trading)
  if (typeof size === 'string') return size
  if (sideHeadroomUsd(inst, o.isLong, trading.maxNetOpenInterestRaw, midRaw) < size.notionalUsd) return `no OI room for a ${o.isLong ? 'long' : 'short'}`
  if (queued != null && queued >= maxQueued) return `relayer queue backed up (${queued} intents queued, limit ${maxQueued})`
  return null
}

function loadOrders(): TriggerOrder[] {
  if (!existsSync(ORDERS_FILE())) return []
  const orders = JSON.parse(readFileSync(ORDERS_FILE(), 'utf8')) as TriggerOrder[]
  // A restart mid-send can't tell whether the intent reached the relayer: never send those again.
  for (const o of orders) {
    if (!o.wallet && o.status === 'armed') Object.assign(o, { status: 'cancelled', note: 'placed before wallet accounts; place it again' })
    if (o.status === 'sending') Object.assign(o, { status: 'unconfirmed', note: 'restarted while sending; check the app before placing it again' })
  }
  return orders
}

function saveOrders(orders: TriggerOrder[]): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = `${ORDERS_FILE()}.tmp`
  writeFileSync(tmp, JSON.stringify(orders, null, 2))
  renameSync(tmp, ORDERS_FILE())
}

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
const describe = (o: TriggerOrder) =>
  `${o.id} ${short(o.wallet)} ${o.isLong ? 'LONG' : 'SHORT'} ${o.symbol} ${o.when === 'below' ? '<=' : '>='} ${o.triggerPx} (${o.fixedMarginUsd !== undefined ? usd(o.fixedMarginUsd) : `${Math.round(o.marginPct * 100)}%`} at ${o.leverage}x)`

type FeeTx = { from: string; to: string | null; value: bigint; chainId?: number }
/**
 * Why a transaction doesn't pay the trading fee for `wallet`, or null when it does: it must have succeeded on HyperEVM,
 * come from that wallet, and send at least `minWei` straight to the fee address.
 */
export function feePaymentProblem(tx: FeeTx, status: string, wallet: string, feeAddress: string, minWei: bigint): string | null {
  if (status !== 'success') return 'That transaction failed on-chain.'
  if (tx.chainId !== undefined && tx.chainId !== 999) return 'That transaction is not on HyperEVM.'
  if (tx.from.toLowerCase() !== wallet.toLowerCase()) return 'That transaction was sent from a different wallet.'
  if (tx.to?.toLowerCase() !== feeAddress.toLowerCase()) return 'That transaction did not go to the fee wallet.'
  if (tx.value < minWei) return `That transaction sent less than ${formatEther(minWei)} HYPE.`
  return null
}

/** Friendly text for the relayer's refusals of a key registration. */
function registrationError(err: RelayerError): string {
  if (err.reason === 'noDeposit') return 'Deposit at least $10 on papertrade.xyz first, then enable trading.'
  if (err.reason === 'sessionKeyLimit') return 'This account has the most trading keys Papertrade allows. Revoke an old one, then try again.'
  if (err.code === 'deadline_expired') return 'The approval took too long. Try again.'
  return `Papertrade refused the trading key (${err.code}${err.reason ? `/${err.reason}` : ''}).`
}

type Account = { wallet: Address; stream: AccountStream; failed: Set<Hex>; usedAt: number; noncesChecked: boolean }

export async function runTrigger(opts: { live: boolean }): Promise<void> {
  const mode = opts.live ? 'live' : 'dry'
  // Deployed (or live), both secrets are required: one signs sign-in cookies, the other encrypts trading keys at rest.
  const authSecret = process.env.PT_AUTH_SECRET || (PUBLIC || opts.live ? '' : 'local-dry-run-only-auth-secret-not-real') // stable locally, so a restart keeps you signed in
  if (authSecret.length < 32) throw new Error('set PT_AUTH_SECRET to a random string of 32+ characters (signs sign-in cookies)')
  const keySecret = process.env.PT_KEY_SECRET || (PUBLIC || opts.live ? '' : 'local-dry-run-only-not-a-real-secret')
  if (keySecret.length < 32) throw new Error('set PT_KEY_SECRET to a random string of 32+ characters (encrypts trading keys at rest)')
  const users = new UserStore()

  let trading = await getTradingState()
  let tradingAt = Date.now()
  const pollTrading = async () => {
    try {
      trading = await getTradingState()
      tradingAt = Date.now()
    } catch (err) {
      log('warn', `trading state: ${errMsg(err)}`)
    }
    setTimeout(pollTrading, TRADING_POLL_MS)
  }
  setTimeout(pollTrading, TRADING_POLL_MS)
  const instOf = (symbol: string) => trading.instruments.find((i) => i.symbol === symbol)

  // Hyperliquid's best bid/offer, ~9 updates a second per coin. The mid is the same integer midpoint the contract uses.
  const bbo = new Map<string, { midRaw: bigint; at: number }>()
  const connectHl = () => {
    const ws = new WebSocket(HL_WS_URL)
    const ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ method: 'ping' })), 30_000)
    ws.onopen = () => {
      for (const inst of trading.instruments) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin: inst.symbol } }))
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      if (m.channel !== 'bbo') return
      const [bid, ask] = m.data.bbo ?? []
      const inst = instOf(m.data.coin)
      if (!bid || !ask || !inst) return
      bbo.set(inst.symbol, { midRaw: (toPriceRaw(bid.px, inst.priceScale) + toPriceRaw(ask.px, inst.priceScale)) / 2n, at: Date.now() })
    }
    ws.onclose = () => {
      clearInterval(ping)
      setTimeout(connectHl, 3000)
    }
    ws.onerror = () => log('warn', 'hyperliquid price feed error; reconnecting')
  }
  connectHl()
  const midPx = (inst: Instrument) => {
    const b = bbo.get(inst.symbol)
    return b && Date.now() - b.at < PRICE_STALE_MS ? { raw: b.midRaw, px: Number(b.midRaw) / Number(inst.priceScale) } : null
  }

  const pub = new PublicStream()
  pub.start()

  let orders = loadOrders()
  const persist = () => {
    const done = orders.filter((o) => o.status !== 'armed' && o.status !== 'sending' && o.status !== 'sent')
    const keep = KEEP_DONE * Math.max(1, new Set(orders.map((o) => o.wallet)).size)
    if (done.length > keep) {
      const drop = new Set(done.sort((a, b) => a.createdAt - b.createdAt).slice(0, done.length - keep))
      orders = orders.filter((o) => !drop.has(o))
    }
    saveOrders(orders)
  }

  // ---- accounts: one read-only Papertrade account feed per wallet in use ----------------------------------------------
  const accounts = new Map<string, Account>()
  const account = (wallet: Address): Account => {
    const id = wallet.toLowerCase()
    let a = accounts.get(id)
    if (!a) {
      const stream = new AccountStream(wallet)
      const failed = new Set<Hex>()
      stream.onError = (err) => log('stream', `${short(wallet)} reconnecting: ${errMsg(err)}`)
      stream.onFrame(({ outcomes }) => {
        for (const o of outcomes) if (FAILED_OUTCOMES.has(o.outcome)) failed.add(o.intentId)
      })
      stream.start()
      a = { wallet: id as Address, stream, failed, usedAt: Date.now(), noncesChecked: false }
      accounts.set(id, a)
    }
    a.usedAt = Date.now()
    return a
  }
  for (const o of orders) if (o.status === 'armed' || o.status === 'sent') account(o.wallet)
  setInterval(() => {
    for (const [id, a] of accounts) {
      const busy = orders.some((o) => o.wallet === id && (o.status === 'armed' || o.status === 'sending' || o.status === 'sent'))
      if (!busy && Date.now() - a.usedAt > IDLE_STREAM_MS) {
        a.stream.stop()
        accounts.delete(id)
      }
    }
  }, 60_000)

  const dryBalance = Number(process.env.PT_TRIGGER_DRY_BALANCE ?? 1000)
  const freeUsd = (wallet: Address) => {
    const s = accounts.get(wallet.toLowerCase())?.stream.state
    return s ? Number(s.availableBalance) / 1e18 : opts.live ? 0 : dryBalance
  }
  // Margin already committed by this wallet's sent-but-unfilled orders, so two orders can't both spend it.
  const inFlightUsd = (wallet: Address) =>
    orders.filter((o) => o.wallet === wallet && (o.status === 'sending' || o.status === 'sent')).reduce((s, o) => s + (o.marginUsd ?? 0), 0)

  /** Whether the wallet's trading key is usable, from the account feed (dry runs skip the on-chain part). */
  const tradingStatus = (user: UserRecord | undefined) => {
    const key = user?.key
    if (!key) return { status: 'none' as const }
    const info = { key: key.address, expiry: key.expiry }
    if (!opts.live) return { status: 'active' as const, ...info }
    const onChain = accounts.get(user.wallet)?.stream.state?.sessionKeys.get(key.address.toLowerCase())
    if (onChain && Number(onChain) > Date.now() / 1000 + 3600) return { status: 'active' as const, ...info, expiry: Number(onChain) }
    if (!key.registeredAt && Date.now() - (key.submittedAt ?? 0) < 180_000) return { status: 'pending' as const, ...info }
    return { status: 'none' as const }
  }

  const feeOk = (wallet: Address) => !FEE_ADDRESS || FEE_EXEMPT.has(wallet.toLowerCase()) || Boolean(users.get(wallet)?.fee)
  const usedFeeTxs = () => new Set(users.all().flatMap((u) => (u.fee ? [u.fee.tx.toLowerCase()] : [])))
  const feeInfo = (wallet: Address | null) =>
    FEE_ADDRESS && { address: FEE_ADDRESS, hype: formatEther(FEE_WEI), valueHex: `0x${FEE_WEI.toString(16)}`, required: wallet ? !feeOk(wallet) : true }

  const nonceSource = (user: UserRecord) => {
    const holder = { nextNonce: BigInt(user.nextNonce) }
    return new NonceSource(holder, () => {
      user.nextNonce = String(holder.nextNonce)
      users.save()
    })
  }

  const settle = (o: TriggerOrder, update: Partial<TriggerOrder>, line: string) => {
    Object.assign(o, update)
    persist()
    log(update.status === 'filled' ? 'FILL' : 'trig', `${describe(o)}: ${line}`)
  }

  const rearmOrFail = (o: TriggerOrder, why: string) => {
    if (o.attempts < MAX_ATTEMPTS && Date.now() < o.expiresAt) settle(o, { status: 'armed', note: `${why}; re-armed (attempt ${o.attempts}/${MAX_ATTEMPTS})` }, `${why}; re-armed`)
    else settle(o, { status: 'failed', note: why }, `${why}; giving up`)
  }

  const waitForFill = (a: Account, intentId: Hex, timeoutMs: number) =>
    a.stream
      .waitFor((s) => {
        if (a.failed.has(intentId)) return null
        for (const p of s.positions.values()) if (p.intentId?.toLowerCase() === intentId.toLowerCase()) return p
        return undefined
      }, timeoutMs)
      .catch(() => null)

  const fire = async (o: TriggerOrder, inst: Instrument, mid: { raw: bigint; px: number }) => {
    const a = account(o.wallet)
    const user = users.get(o.wallet)
    const size = sizeOrder(o, freeUsd(o.wallet) - inFlightUsd(o.wallet), inst, trading)
    if (typeof size === 'string' || !user?.key) return
    o.attempts++
    if (!opts.live) {
      settle(o, { status: 'filled', firedPx: mid.px, marginUsd: size.marginUsd, sentAt: Date.now(), note: 'dry run: nothing sent', fill: { positionId: 'dry', entryPx: mid.px, waitedS: 0 } },
        `dry: would open ${usd(size.notionalUsd, 0)} (${usd(size.marginUsd)} margin) at ~${mid.px}; nothing sent`)
      return
    }
    // Saved as 'sending' before the request, so a crash here can never lead to a second send.
    settle(o, { status: 'sending', firedPx: mid.px, marginUsd: size.marginUsd, sentAt: Date.now(), note: undefined }, `FIRE at ${mid.px}: ${usd(size.notionalUsd, 0)} (${usd(size.marginUsd)} margin), queue ${pub.pressure?.queuedIntents ?? '?'}`)
    let intentId: Hex
    try {
      const nonces = nonceSource(user)
      if (!a.noncesChecked) {
        await nonces.ensureUnused(makeClient(), o.wallet)
        a.noncesChecked = true
      }
      const signed = await signIntent(privateKeyToAccount(openKey(user.key.sealed, keySecret)), EXCHANGE_DOMAIN, 'OpenPosition', {
        user: o.wallet,
        instrumentId: inst.id,
        isLong: o.isLong,
        size: size.marginRaw,
        leverage: o.leverage,
        useDebt: false,
        nonce: nonces.take(),
        deadline: deadlineFromNow(BigInt(o.deadlineSec)),
      })
      intentId = signed.intentId
      o.intentId = intentId
      await submitIntent('openPosition', signed.signed, intentId)
    } catch (err) {
      // A relayer refusal means nothing is queued; anything else (timeout, network) might have reached it.
      if (err instanceof RelayerError) rearmOrFail(o, `rejected: ${errMsg(err)}`)
      else settle(o, { status: 'unconfirmed', note: `send failed (${errMsg(err)}); it may still fill, check Papertrade` }, `send failed: ${errMsg(err)}`)
      return
    }
    settle(o, { status: 'sent' }, `sent ${intentId.slice(0, 10)}, deadline ${o.deadlineSec}s`)
    const pos = await waitForFill(a, intentId, o.deadlineSec * 1000 + FILL_GRACE_MS)
    if (pos) {
      const entryPx = Number(pos.entryPriceRaw) / Number(inst.priceScale)
      const waitedS = Math.round((pos.openedAtMs - o.sentAt!) / 1000)
      const slipBp = ((entryPx - o.triggerPx) / o.triggerPx) * 1e4 * (o.isLong ? 1 : -1)
      settle(o, { status: 'filled', fill: { positionId: pos.positionId, entryPx, waitedS }, note: `${slipBp >= 0 ? 'worse' : 'better'} than trigger by ${Math.abs(slipBp).toFixed(1)}bp` },
        `#${pos.positionId} @ ${entryPx} after ${waitedS}s (trigger ${o.triggerPx}, sent at ${o.firedPx}, ${slipBp.toFixed(1)}bp vs trigger)`)
    } else if (a.failed.has(intentId)) rearmOrFail(o, 'intent expired or failed before filling')
    else settle(o, { status: 'unconfirmed', note: 'no fill seen; it may still land, check Papertrade' }, 'no fill or failure seen')
  }

  // One check a second: expire old orders, fire at most one triggered order per pass.
  let busy = false
  const check = async () => {
    if (busy) return
    busy = true
    try {
      for (const o of orders) {
        if (o.status === 'armed' && Date.now() > o.expiresAt) settle(o, { status: 'expired', note: 'expired before triggering' }, 'expired')
      }
      for (const o of orders.filter((o) => o.status === 'armed')) {
        const inst = instOf(o.symbol)
        const mid = inst && midPx(inst)
        if (!inst || !mid) {
          o.note = 'waiting for a live price'
          continue
        }
        if (!crossed(o, mid.px)) {
          if (o.note && !o.note.includes('re-armed')) o.note = undefined
          continue
        }
        let hold: string | null = null
        if (Date.now() - tradingAt > TRADING_STALE_MS) hold = 'waiting for fresh market state'
        else if (tradingStatus(users.get(o.wallet)).status !== 'active') hold = 'trading key not active; enable trading again'
        else if (opts.live && !account(o.wallet).stream.state) hold = 'waiting for the account feed'
        else hold = holdReason(o, inst, trading, mid.raw, freeUsd(o.wallet) - inFlightUsd(o.wallet), pub.pressure?.queuedIntents ?? null)
        if (hold) {
          if (o.note !== `triggered; holding: ${hold}`) log('hold', `${describe(o)}: ${hold}`)
          o.note = `triggered; holding: ${hold}`
          continue
        }
        void fire(o, inst, mid).catch((err) => log('warn', `${describe(o)}: ${errMsg(err)}`))
        break
      }
    } finally {
      busy = false
    }
  }
  setInterval(() => void check(), CHECK_MS)

  // ---- HTTP ------------------------------------------------------------------------------------------------------------
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body))
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      let raw = ''
      req.on('data', (c: Buffer) => {
        raw += c
        if (raw.length > 10_000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          reject(new Error('bad JSON'))
        }
      })
    })
  const COOKIE = 'pw_session'
  const cookieOf = (req: IncomingMessage) =>
    String(req.headers.cookie ?? '').split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  const sessionCookie = (value: string, maxAgeSec: number) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${PUBLIC ? '; Secure' : ''}`
  const signIns = new Map<string, { message: string; at: number }>() // wallet -> pending sign-in message
  const isAddress = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

  // Claimable staking rewards come from PaperStaking itself (the feed's figure lags); read at most once a minute per wallet.
  const rewards = new Map<string, { usd: number | null; at: number; busy?: boolean }>()
  const client = makeClient()
  const pendingRewardUsd = (wallet: Address) => {
    const r = rewards.get(wallet) ?? { usd: null, at: 0 }
    rewards.set(wallet, r)
    if (!r.busy && Date.now() - r.at > REWARD_REFRESH_MS) {
      r.busy = true
      client
        .readContract({ address: CONTRACTS.paperStaking, abi: PENDING_REWARD_ABI, functionName: 'pendingReward', args: [wallet] })
        .then((v) => Object.assign(r, { usd: Number(v) / 1e18, at: Date.now() }))
        .catch(() => Object.assign(r, { at: Date.now() - REWARD_REFRESH_MS + 10_000 })) // retry in ~10 s
        .finally(() => (r.busy = false))
    }
    return r.usd
  }

  // Account box, like Papertrade's portfolio: balances, open PnL at the live mid (before the win haircut), PAPER, and
  // lifetime totals, all from the wallet's account feed.
  const accountBox = (wallet: Address) => {
    const s = accounts.get(wallet)?.stream.state
    if (!s) return null
    // Each open position at the live mid; PnL is before the win haircut Papertrade takes on close.
    let openPnlUsd = 0
    const open = [...s.positions.values()].map((p) => {
      const inst = trading.instruments.find((i) => i.id === p.instrumentId)
      const mid = inst ? midPx(inst) : null
      const scale = Number(inst?.priceScale ?? 1)
      const entryPx = Number(p.entryPriceRaw) / scale
      const marginUsd = Number(p.marginRaw) / 1e18
      const pnlUsd = mid ? marginUsd * p.leverage * ((mid.px - entryPx) / entryPx) * (p.isLong ? 1 : -1) : null
      if (pnlUsd != null) openPnlUsd += pnlUsd
      return {
        id: p.positionId,
        symbol: inst?.symbol ?? `#${p.instrumentId}`,
        isLong: p.isLong,
        marginUsd,
        leverage: p.leverage,
        sizeUsd: marginUsd * p.leverage,
        entryPx,
        markPx: mid?.px ?? null,
        bustPx: Number(p.bustPriceRaw) / scale,
        pnlUsd,
        openedAt: p.openedAtMs,
      }
    })
    const usdOf = (raw: bigint) => Number(raw) / 1e18
    const balanceUsd = usdOf(s.balance)
    const l = s.lifetime
    return {
      balanceUsd,
      // The feed's balance is the free part; margin locked in open positions is still the account's, so add it back.
      equityUsd: balanceUsd + usdOf(s.locked) + openPnlUsd,
      marginInUseUsd: usdOf(s.locked),
      openPnlUsd,
      queuedUsd: usdOf(s.queued), // winnings waiting in the LP payout queue
      positions: s.positions.size,
      open: open.sort((a, b) => b.openedAt - a.openedAt),
      paper: { wallet: usdOf(s.paperBalance), staked: usdOf(s.paperStaked), rewardsUsd: pendingRewardUsd(wallet) },
      lifetime: l && {
        feesPaidUsd: usdOf(l.feesPaidRaw),
        realizedPnlUsd: usdOf(s.realizedPnlRaw),
        tradedUsd: usdOf(l.tradedNotionalRaw),
        rewardsClaimedUsd: usdOf(l.rewardsClaimedRaw),
        depositedUsd: usdOf(l.depositedRaw),
        withdrawnUsd: usdOf(l.withdrawnRaw),
      },
    }
  }

  // `wallet` is who is signed in (can trade); `view` is whose account the box shows, which can be any connected wallet:
  // the account data is public on Papertrade, so it shows on connect, before signing in.
  const snapshot = (wallet: Address | null, view: Address | null) => ({
    mode,
    wallet,
    view,
    trading: wallet ? tradingStatus(users.get(wallet)) : null,
    fee: feeInfo(wallet),
    freeUsd: view ? freeUsd(view) : null,
    inFlightUsd: view ? inFlightUsd(view) : 0,
    account: view ? accountBox(view) : null,
    queued: pub.pressure?.queuedIntents ?? null,
    maxQueued: MAX_QUEUED,
    defaultLeverage: DEFAULT_LEVERAGE,
    markets: trading.instruments
      .filter((i) => !i.retired)
      .map((inst) => {
        const mid = midPx(inst)
        return {
          symbol: inst.symbol,
          mid: mid?.px ?? null,
          maxLeverage: inst.maxLeverage,
          bustBuffer: Number(inst.bustBufferRaw) / 1e18,
          longOiUsd: mid ? (Number(inst.longOiRaw) / 1e18) * mid.px : null,
          shortOiUsd: mid ? (Number(inst.shortOiRaw) / 1e18) * mid.px : null,
          openable: inst.openable && !inst.closeOnly && !trading.tradingPaused && !trading.pausedActions.includes('openPosition'),
          roomLong: mid ? sideHeadroomUsd(inst, true, trading.maxNetOpenInterestRaw, mid.raw) : null,
          roomShort: mid ? sideHeadroomUsd(inst, false, trading.maxNetOpenInterestRaw, mid.raw) : null,
        }
      }),
    minMarginUsd: Number(trading.minimumTradeSizeRaw) / 1e18,
    minNotionalUsd: Number(trading.minimumOpenNotionalRaw) / 1e18,
    orders: wallet ? orders.filter((o) => o.wallet === wallet).sort((a, b) => b.createdAt - a.createdAt) : [],
  })

  const candles = new CandleStore()
  // paperwatch.app is this one server: Limit Intents at /limits, the queue page at /queue (also /que), shared top bar.
  const queue = startQueueRelay()
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    baseHeaders(res)
    if (req.method === 'GET') {
      if (url.pathname === '/') return void res.writeHead(302, { location: '/limits' }).end()
      if (url.pathname === '/limits' || url.pathname === '/limits/') return servePage(res, 'trigger.html')
      if (url.pathname === '/vendor/lightweight-charts.js') return serveChartJs(res)
      if (url.pathname.startsWith('/assets/') && serveAsset(res, url.pathname.slice(8))) return
      if (['/queue', '/queue/', '/que', '/que/'].includes(url.pathname)) return queue.page(res)
      if (url.pathname === '/events') return queue.events(req, res)
      if (url.pathname === '/site.js') return serveSiteJs(res, true)
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    // Every write needs our header: browsers won't send it cross-site without a preflight we never allow (CSRF).
    if (req.method !== 'GET' && req.headers['x-paperwatch'] !== '1') return json(res, 403, { error: 'missing request header' })
    const wallet = readToken(cookieOf(req), authSecret)
    if (wallet) account(wallet)
    const needWallet = () => {
      if (!wallet) json(res, 401, { error: 'Connect and sign in with your wallet first.' })
      return wallet
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const asked = url.searchParams.get('wallet')
        let view: Address | null = wallet
        if (!view && isAddress(asked)) {
          view = asked.toLowerCase() as Address
          if (accounts.has(view) || accounts.size < MAX_ACCOUNTS) account(view)
          else view = null
        }
        return json(res, 200, snapshot(wallet, view))
      }
      if (req.method === 'GET' && url.pathname === '/api/candles') {
        const inst = instOf(url.searchParams.get('symbol') ?? '')
        if (!inst) return json(res, 400, { error: 'unknown market' })
        return json(res, 200, await candles.get(inst.symbol, Number(url.searchParams.get('tf'))))
      }

      // Sign in: the wallet signs a one-time message; we answer with a signed, HttpOnly cookie.
      if (req.method === 'POST' && url.pathname === '/api/auth/message') {
        const body = await readBody(req)
        if (!isAddress(body.wallet)) return json(res, 400, { error: 'bad wallet address' })
        const host = (String(req.headers.host ?? 'paperwatch.app').match(/^[\w.:-]+$/) ?? ['paperwatch.app'])[0]
        const message = signInMessage(host, body.wallet, randomBytes(12).toString('hex'), new Date().toISOString())
        if (signIns.size > 10_000) signIns.clear()
        signIns.set(body.wallet.toLowerCase(), { message, at: Date.now() })
        return json(res, 200, { message })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
        const body = await readBody(req)
        if (!isAddress(body.wallet) || typeof body.signature !== 'string') return json(res, 400, { error: 'bad sign-in' })
        const pending = signIns.get(body.wallet.toLowerCase())
        if (!pending || Date.now() - pending.at > SIGN_IN_TTL_MS) return json(res, 400, { error: 'Sign-in expired. Try again.' })
        const ok = await verifyMessage({ address: body.wallet, message: pending.message, signature: body.signature as Hex }).catch(() => false)
        if (!ok) return json(res, 401, { error: 'That signature is not from this wallet.' })
        signIns.delete(body.wallet.toLowerCase())
        const user = users.getOrCreate(body.wallet)
        users.save()
        account(user.wallet)
        log('login', short(user.wallet))
        return json(res, 200, { wallet: user.wallet }, { 'set-cookie': sessionCookie(issueToken(user.wallet, authSecret, AUTH_TTL_MS), AUTH_TTL_MS / 1000) })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') return json(res, 200, {}, { 'set-cookie': sessionCookie('', 0) })

      // Unlock: check the wallet's HYPE payment on-chain (status, sender, recipient, amount), once per transaction.
      if (req.method === 'POST' && url.pathname === '/api/fee/confirm') {
        if (!needWallet()) return
        if (feeOk(wallet!)) return json(res, 200, { paid: true })
        const body = await readBody(req)
        const hash = String(body.hash ?? '')
        if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return json(res, 400, { error: 'bad transaction hash' })
        if (usedFeeTxs().has(hash.toLowerCase())) return json(res, 409, { error: 'That payment already unlocked a wallet.' })
        const receipt = await client.waitForTransactionReceipt({ hash: hash as Hex, timeout: 90_000, pollingInterval: 1500 }).catch(() => null)
        if (!receipt) return json(res, 202, { error: 'Payment not confirmed yet. It will be checked again shortly.' })
        const tx = await client.getTransaction({ hash: hash as Hex })
        const problem = feePaymentProblem(tx, receipt.status, wallet!, FEE_ADDRESS!, FEE_WEI)
        if (problem) return json(res, 400, { error: problem })
        const user = users.getOrCreate(wallet!)
        user.fee = { tx: hash.toLowerCase() as Hex, paidAt: Date.now(), wei: String(tx.value) }
        users.save()
        log('fee', `${short(user.wallet)} paid ${formatEther(tx.value)} HYPE (${hash.slice(0, 10)})`)
        return json(res, 200, { paid: true })
      }
      const locked = () => {
        if (feeOk(wallet!)) return false
        json(res, 402, { error: `Unlock trading first (${formatEther(FEE_WEI)} HYPE).` })
        return true
      }

      // Enable trading: a fresh trading key, approved by the wallet's own signature over Papertrade's RegisterSessionKey.
      if (req.method === 'POST' && url.pathname === '/api/trading/prepare') {
        if (!needWallet() || locked()) return
        const user = users.getOrCreate(wallet!)
        const status = tradingStatus(user)
        if (status.status === 'active' && status.expiry > Date.now() / 1000 + KEY_RENEW_SEC) return json(res, 409, { error: 'Trading is already enabled.' })
        const a = account(user.wallet)
        const nonces = nonceSource(user)
        if (!a.noncesChecked) {
          await nonces.ensureUnused(makeClient(), user.wallet)
          a.noncesChecked = true
        }
        const pk = generatePrivateKey()
        const keyAddress = privateKeyToAccount(pk).address
        const input = {
          user: user.wallet,
          key: keyAddress,
          expiry: BigInt(Math.floor(Date.now() / 1000)) + SESSION_TTL_SEC - 60n,
          feeAddress: zeroAddress, // what the official frontend sends
          nonce: nonces.take(),
          deadline: deadlineFromNow(600n),
        }
        user.pendingKey = { address: keyAddress, sealed: sealKey(pk, keySecret), input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])) }
        users.save()
        return json(res, 200, { typedData: walletTypedData(EXCHANGE_DOMAIN, 'RegisterSessionKey', input), key: keyAddress })
      }
      if (req.method === 'POST' && url.pathname === '/api/trading/register') {
        if (!needWallet() || locked()) return
        const body = await readBody(req)
        const user = users.get(wallet!)
        const pending = user?.pendingKey
        if (!user || !pending) return json(res, 400, { error: 'Start again: no trading key is waiting for approval.' })
        const p = pending.input
        const input = { user: p.user, key: p.key, expiry: BigInt(p.expiry), feeAddress: p.feeAddress, nonce: BigInt(p.nonce), deadline: BigInt(p.deadline) }
        const { signed, intentId, signer } = await intentFromSignature(EXCHANGE_DOMAIN, 'RegisterSessionKey', input, body.signature as Hex)
        if (signer !== user.wallet) return json(res, 401, { error: 'That approval was signed by a different wallet.' })
        if (opts.live) {
          try {
            await submitIntent('registerSessionKey', signed, intentId)
          } catch (err) {
            if (err instanceof RelayerError) return json(res, 400, { error: registrationError(err) })
            throw err
          }
        }
        user.key = { address: pending.address, sealed: pending.sealed, expiry: Number(p.expiry), submittedAt: Date.now(), ...(opts.live ? {} : { registeredAt: Date.now() }) }
        delete user.pendingKey
        users.save()
        log('key', `${short(user.wallet)} trading key ${short(pending.address)} ${opts.live ? 'submitted' : 'approved (dry: not sent)'}`)
        if (opts.live) {
          const keyId = pending.address.toLowerCase()
          void account(user.wallet)
            .stream.waitFor((s) => (s.sessionKeys.has(keyId) ? true : undefined), 120_000)
            .then(() => {
              if (user.key?.address.toLowerCase() === keyId) user.key.registeredAt = Date.now()
              users.save()
              log('key', `${short(user.wallet)} trading key ${short(keyId)} registered`)
            })
            .catch(() => log('warn', `${short(user.wallet)} trading key ${short(keyId)} not seen on Papertrade within 2 min`))
        }
        return json(res, 200, tradingStatus(user))
      }
      // Turn trading off: forget the key here, and hand back the transaction that revokes it on Papertrade.
      if (req.method === 'POST' && url.pathname === '/api/trading/revoke') {
        if (!needWallet()) return
        const user = users.get(wallet!)
        if (!user?.key) return json(res, 400, { error: 'Trading is not enabled.' })
        const keyAddress = user.key.address
        delete user.key
        users.save()
        for (const o of orders.filter((o) => o.wallet === user.wallet && o.status === 'armed')) settle(o, { status: 'cancelled', note: 'trading turned off' }, 'cancelled (trading off)')
        log('key', `${short(user.wallet)} turned trading off (key ${short(keyAddress)})`)
        return json(res, 200, { tx: { to: CONTRACTS.sessionKeyManager, data: encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revokeSessionKey', args: [keyAddress] }) } })
      }

      if (req.method === 'POST' && url.pathname === '/api/orders') {
        if (!needWallet() || locked()) return
        if (tradingStatus(users.get(wallet!)).status !== 'active') return json(res, 400, { error: 'Enable trading first.' })
        if (orders.filter((o) => o.wallet === wallet && o.status === 'armed').length >= MAX_ARMED_PER_WALLET) {
          return json(res, 400, { error: `You can have up to ${MAX_ARMED_PER_WALLET} open limit intents.` })
        }
        const input = (await readBody(req)) as OrderInput
        const inst = instOf(String(input.symbol ?? ''))
        const mid = inst && midPx(inst)
        if (inst && !mid) return json(res, 400, { error: 'no live price yet; try again in a few seconds' })
        const o = newOrder(input, inst, mid?.px ?? 0, Date.now(), wallet!)
        if (typeof o === 'string') return json(res, 400, { error: o })
        orders.push(o)
        persist()
        log('place', `${describe(o)}, expires ${new Date(o.expiresAt).toISOString()}, deadline ${o.deadlineSec}s (mid ${mid!.px})`)
        return json(res, 200, o)
      }
      const cancel = url.pathname.match(/^\/api\/orders\/([\w-]+)\/cancel$/)
      if (req.method === 'POST' && cancel) {
        if (!needWallet()) return
        const o = orders.find((x) => x.id === cancel[1] && x.wallet === wallet)
        if (!o) return json(res, 404, { error: 'no such order' })
        if (o.status !== 'armed') return json(res, 409, { error: `order is ${o.status}; only armed orders can be cancelled` })
        settle(o, { status: 'cancelled', note: 'cancelled' }, 'cancelled')
        return json(res, 200, o)
      }
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 400, { error: errMsg(err) })
    }
  }).listen(PORT, HOST, () => {
    const armed = orders.filter((o) => o.status === 'armed').length
    const fee = FEE_ADDRESS ? `unlock ${formatEther(FEE_WEI)} HYPE to ${short(FEE_ADDRESS)} (${FEE_EXEMPT.size} exempt)` : 'no unlock fee'
    log('start', `${mode.toUpperCase()} limit intents on ${HOST}:${PORT}; ${users.all().length} account(s), ${armed} armed order(s); ${fee}; hold while ${MAX_QUEUED}+ intents queued. Opens only, never closes.`)
  })

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  persist()
  for (const a of accounts.values()) a.stream.stop()
}
