import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { encodeFunctionData, formatEther, getAddress, parseEther, verifyMessage, zeroAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { AccountStream } from './account.ts'
import { keyStatus } from './account-frames.js'
import { RelayerError, getTradingState, submitIntent, type Instrument, type TradingState } from './api.ts'
import { CONTRACTS, INTENT_TTL_SEC, SESSION_TTL_SEC, USDC_UNIT } from './config.ts'
import { EXCHANGE_DOMAIN, deadlineFromNow, intentFromSignature, signIntent, walletTypedData } from './eip712.ts'
import { PublicStream } from './intake.ts'
import { toPriceRaw } from './market.ts'
import { sideHeadroomUsd } from './risk.ts'
import { baseHeaders, serveAccountFrames, serveAsset, serveChartJs, servePage, serveSiteJs } from './site.ts'
import { startQueueRelay } from './queue-viz.ts'
import { CandleStore } from './candles.ts'
import { Store } from './db.ts'
import { NONCE_ABI } from './state.ts'
import { Keyring } from './keyring.ts'
import { issueToken, readToken, signInMessage, type UserRecord } from './users.ts'
import { log, makeClient, usd, warnTimes } from './bot.ts'
import { Alerter } from './alerts.ts'
import { alertLeader, percentile, summarize, type Summary, type WebBeat, type WorkerBeat } from './status.ts'

// Limit Intents (its own Railway service, PT_PROCESS=trigger), a public page where anyone can place orders like "long
// BTC once it trades at or below $79,000, $225 margin at 35x" on their own Papertrade account:
// - Visitors connect a browser wallet and sign in by signing a message (no gas). They then approve a Papertrade
//   trading key (session key) for this server, which it keeps encrypted (src/users.ts) and uses only to send their
//   opens. The key can't withdraw, and the wallet can revoke it at any time.
// - This process watches Hyperliquid's best bid/offer (the book the contract prices from) and sends the open when the
//   mid crosses the trigger. It is NOT a limit order: the intent has no price field, so the fill is the mid when the
//   relayer lands it, which in a backed-up queue can be well past the trigger. Each sent intent carries a short
//   deadline, so a stale one expires instead of filling late. An order holds while the relayer queue is backed up.
// PT_MODE=live sends for real; dry signs nothing and only logs. State (wallets, sealed keys, orders) lives in Postgres
// (src/db.ts); <state dir> keeps only the candle cache, plus the local database when there is no DATABASE_URL.

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
// Opens sent per check pass (one pass a second), at most one per wallet so two orders can't spend the same margin.
const SENDS_PER_PASS = Number(process.env.PT_SENDS_PER_SECOND ?? 50)
const MAX_ATTEMPTS = 3 // sends per order; a relayer rejection or an expired intent re-arms it until then
const AUTH_TTL_MS = 7 * 86_400_000 // sign-in cookie lifetime
const SIGN_IN_TTL_MS = 5 * 60_000 // a sign-in message must be signed within this
const KEY_RENEW_SEC = 3 * 86_400 // offer a fresh trading key when the current one has less than this left
const MAX_ARMED_PER_WALLET = 20
const IDLE_STREAM_MS = 5 * 60_000 // stop following an account with no armed orders after this long unseen
const FAILED_OUTCOMES = new Set(['failed', 'expired', 'cancelled'])
// Trading unlock: a one-time PT_FEE_HYPE (default 0.1) HYPE transfer on HyperEVM to PT_FEE_ADDRESS. Wallets in
// PT_FEE_EXEMPT (comma-separated) skip it. Without PT_FEE_ADDRESS there is no fee.
const FEE_ADDRESS = process.env.PT_FEE_ADDRESS ? getAddress(process.env.PT_FEE_ADDRESS) : null
const FEE_WEI = parseEther(process.env.PT_FEE_HYPE || '0.1')
const FEE_SCAN_MS = 1000 // HyperEVM makes a small block every second
const FEE_SCAN_BATCH = 6 // blocks read per pass, in parallel: catches up after a gap without hammering the RPC
const FEE_EXEMPT = new Set((process.env.PT_FEE_EXEMPT ?? '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean))
const FEE_CHECK_MS = 3000 // one /api/fee/confirm per wallet this often; each check is two RPC reads
const REVOKE_ABI = [{ type: 'function', name: 'revokeSessionKey', stateMutability: 'nonpayable', inputs: [{ type: 'address' }], outputs: [] }] as const
const FILL_GRACE_MS = 120_000 // after the intent's deadline, how long to keep looking for its position
const REFRESH_MS = 1000 // how often the replica pulls changed rows from the database
// PT_ROLE: 'web' serves the pages and the API; 'worker' sends orders and closes and scans for unlock payments, and only
// the process holding the database's worker lock does that; 'all' (the default) is both in one process.
const ROLES = ['web', 'worker', 'all'] as const
const ROLE = (process.env.PT_ROLE || 'all') as (typeof ROLES)[number]
const CLOSE_PICKUP_MS = 120_000 // a queued close no worker has taken by then fails, so the button frees up
const FEE_WAITING_MS = 10 * 60_000 // the worker scans for unlock payments while a web instance saw someone owing the fee this recently
const PRUNE_MS = 3_600_000 // how often finished orders past the newest 50 per wallet are deleted
const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

export type OrderStatus = 'armed' | 'sending' | 'sent' | 'filled' | 'failed' | 'cancelled' | 'expired' | 'unconfirmed'
export type TriggerOrder = {
  id: string
  /** 'market' goes out on the next check at the live mid; 'limit' (or unset, for older orders) waits for its trigger. */
  kind?: 'market' | 'limit'
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
  type?: unknown
  marginPct?: unknown
  marginUsd?: unknown
  leverage?: unknown
  expiresHours?: unknown
  deadlineSec?: unknown
}

/** Validate a new order from the page against the market and the current mid; returns the order or an error. */
/** Papertrade refuses opens under $1,000 of notional; checked when an order is placed, not only when it's sent. */
export const MIN_NOTIONAL_USD = 1000
const MARKET_EXPIRY_MS = 3 * 60_000 // a market order that can't go out within this (no OI room, balance) is dropped

export function newOrder(input: OrderInput, inst: Instrument | undefined, midPx: number, now = Date.now(), wallet: Address = zeroAddress, minNotionalUsd = MIN_NOTIONAL_USD): TriggerOrder | string {
  if (!inst) return 'unknown market'
  if (input.side !== 'long' && input.side !== 'short') return 'side must be long or short'
  const kind = input.type === 'market' ? 'market' : 'limit'
  // A market order's "trigger" is the mid when it was placed: it goes straight out, and fills are compared to it.
  const triggerPx = kind === 'market' ? midPx : Number(input.triggerPx)
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
  const minNotional = Math.max(MIN_NOTIONAL_USD, minNotionalUsd)
  if (fixedMarginUsd !== undefined && fixedMarginUsd * leverage < minNotional) {
    return `position size (margin × leverage) must be at least $${minNotional.toLocaleString('en-US')}`
  }
  const expiresHours = Number(input.expiresHours ?? 24)
  if (!Number.isFinite(expiresHours) || expiresHours <= 0 || expiresHours > 24 * 30) return 'expiry must be between 0 and 30 days'
  const deadlineSec = Number(input.deadlineSec ?? 60)
  if (!Number.isInteger(deadlineSec) || deadlineSec < 15 || deadlineSec > 3600) return 'deadline must be 15–3600 seconds'
  return {
    id: randomUUID().slice(0, 8),
    kind,
    wallet,
    symbol: inst.symbol,
    isLong: input.side === 'long',
    triggerPx,
    when: triggerPx <= midPx ? 'below' : 'above',
    marginPct,
    ...(fixedMarginUsd !== undefined ? { fixedMarginUsd } : {}),
    leverage,
    createdAt: now,
    expiresAt: now + (kind === 'market' ? MARKET_EXPIRY_MS : expiresHours * 3_600_000),
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

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
const describe = (o: TriggerOrder) =>
  `${o.id} ${short(o.wallet)} ${o.isLong ? 'LONG' : 'SHORT'} ${o.symbol} ${o.kind === 'market' ? `MARKET (~${o.triggerPx})` : `${o.when === 'below' ? '<=' : '>='} ${o.triggerPx}`} (${o.fixedMarginUsd !== undefined ? usd(o.fixedMarginUsd) : `${Math.round(o.marginPct * 100)}%`} at ${o.leverage}x)`

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

/** Transfers in a block that could pay the fee: straight to the fee address, for at least `minWei`. */
export function feePayments<T extends { to: string | null; value: bigint }>(txs: T[], feeAddress: string, minWei: bigint): T[] {
  const fee = feeAddress.toLowerCase()
  return txs.filter((tx) => tx.to?.toLowerCase() === fee && tx.value >= minWei)
}

/** Friendly text for the relayer's refusals of a key registration. */
function registrationError(err: RelayerError): string {
  if (err.reason === 'noDeposit') return 'Deposit at least $10 on papertrade.xyz first, then enable trading.'
  if (err.reason === 'sessionKeyLimit') return 'This account has the most trading keys Papertrade allows. Revoke an old one, then try again.'
  if (err.code === 'deadline_expired') return 'The approval took too long. Try again.'
  return `Papertrade refused the trading key (${err.code}${err.reason ? `/${err.reason}` : ''}).`
}

type Account = { wallet: Address; stream: AccountStream; failed: Set<Hex>; usedAt: number }

export async function runTrigger(opts: { live: boolean }): Promise<void> {
  const mode = opts.live ? 'live' : 'dry'
  // Deployed (or live), both secrets are required: one signs sign-in cookies, the other encrypts trading keys at rest.
  const authSecret = process.env.PT_AUTH_SECRET || (PUBLIC || opts.live ? '' : 'local-dry-run-only-auth-secret-not-real') // stable locally, so a restart keeps you signed in
  if (authSecret.length < 32) throw new Error('set PT_AUTH_SECRET to a random string of 32+ characters (signs sign-in cookies)')
  // Trading keys at rest (src/keyring.ts): web seals with PT_KEY_PUBLIC, the worker opens with PT_KEY_PRIVATE. The old
  // PT_KEY_SECRET still works for both until it is removed; locally a fixed dry-run secret stands in.
  if (process.env.PT_KEY_SECRET && process.env.PT_KEY_SECRET.length < 32) throw new Error('PT_KEY_SECRET must be 32+ characters')
  const keys = await Keyring.load(process.env, PUBLIC || opts.live ? undefined : 'local-dry-run-only-not-a-real-secret')
  if (ROLE !== 'worker' && !keys.canSeal) throw new Error('set PT_KEY_PUBLIC (seals new trading keys)')
  if (ROLE !== 'web' && !keys.canOpen) throw new Error('set PT_KEY_PRIVATE (opens trading keys to send orders)')
  log('keys', `seals with ${keys.kid ?? (keys.canSeal ? 'PT_KEY_SECRET' : 'nothing')}; opens ${ROLE === 'web' && keys.opens.length ? `${keys.opens.join(', ')} (a web instance needs none)` : keys.opens.join(', ') || 'nothing'}`)
  if (!ROLES.includes(ROLE)) throw new Error(`PT_ROLE must be one of ${ROLES.join(', ')}`)
  const web = ROLE !== 'worker'
  const worker = ROLE !== 'web'
  // Postgres holds wallets, orders, sign-ins, closes and the activity log; reads come from the store's replica.
  const store = await Store.open(PUBLIC)
  // The worker sends only in the mode the site runs in, so a dry worker can't "fill" live orders, or the reverse.
  if (web) await store.put('mode', { mode })
  const users = { get: (wallet: string) => store.users.get(wallet.toLowerCase()) }
  const allOrders = () => [...store.orders.values()]
  const track = (type: string, wallet: string | null, data: Record<string, unknown> = {}) => store.event(type, wallet, data)
  const client = makeClient()
  let refreshing = false
  let refreshWarned = 0
  let refreshedAt = Date.now()
  setInterval(() => {
    if (refreshing) return
    refreshing = true
    store
      .refresh()
      .then(() => (refreshedAt = Date.now()))
      .catch((err) => {
        if (Date.now() - refreshWarned < 60_000) return
        refreshWarned = Date.now()
        log('warn', `database refresh: ${errMsg(err)}`)
      })
      .finally(() => (refreshing = false))
  }, REFRESH_MS)

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
      a = { wallet: id as Address, stream, failed, usedAt: Date.now() }
      accounts.set(id, a)
    }
    a.usedAt = Date.now()
    return a
  }
  // Dry runs never open account feeds (they size from PT_TRIGGER_DRY_BALANCE), so a load test can't hammer Papertrade.
  if (worker && opts.live) for (const o of allOrders()) if (o.status === 'armed' || o.status === 'sent') account(o.wallet)
  setInterval(() => {
    for (const [id, a] of accounts) {
      const busy =
        allOrders().some((o) => o.wallet === id && (o.status === 'armed' || o.status === 'sending' || o.status === 'sent')) ||
        [...store.closes.values()].some((c) => c.wallet === id && !c.done)
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
    allOrders().filter((o) => o.wallet === wallet && (o.status === 'sending' || o.status === 'sent')).reduce((s, o) => s + (o.marginUsd ?? 0), 0)

  /** Whether the wallet's trading key is usable, from the worker's account feed (the page works it out from its own). */
  const tradingStatus = (user: UserRecord | undefined) => keyStatus(user?.key, user && accounts.get(user.wallet)?.stream.state?.sessionKeys, opts.live)

  const feeOk = (wallet: Address) => !FEE_ADDRESS || FEE_EXEMPT.has(wallet.toLowerCase()) || Boolean(users.get(wallet)?.fee)
  const feeChecks = new Map<Address, number>() // last /api/fee/confirm per wallet
  const feeInfo = (wallet: Address | null) =>
    FEE_ADDRESS && { address: FEE_ADDRESS, hype: formatEther(FEE_WEI), valueHex: `0x${FEE_WEI.toString(16)}`, required: wallet ? !feeOk(wallet) : true }

  // The wallet's next intent nonce from the database counter. The first one this process uses for a wallet is checked
  // on-chain too (a counter restored from an old copy); a used one jumps to a fresh random range.
  const noncesChecked = new Set<string>()
  const nextNonce = async (wallet: Address) => {
    for (let i = 0; i < 64; i++) {
      const n = await store.takeNonce(wallet)
      if (noncesChecked.has(wallet.toLowerCase())) return n
      const used = await client.readContract({ address: CONTRACTS.sessionKeyManager, abi: NONCE_ABI, functionName: 'isNonceUsed', args: [wallet, n] })
      if (!used) {
        noncesChecked.add(wallet.toLowerCase())
        return n
      }
      await store.jumpNonce(wallet)
    }
    throw new Error('could not find an unused nonce')
  }

  /** Move an order on, only from one of the statuses in `from`; null (and nothing changes) if it had already moved. */
  const settle = async (o: TriggerOrder, from: OrderStatus[], update: Partial<TriggerOrder>, line: string) => {
    const was = o.status
    const next = await store.transition(o.id, from, update)
    if (!next) {
      log('trig', `${describe(o)}: ${line}; skipped, the order is ${store.orders.get(o.id)?.status ?? 'gone'}`)
      return null
    }
    if (o.status !== was) {
      track(`order_${o.status}`, o.wallet, {
        id: o.id, symbol: o.symbol, side: o.isLong ? 'long' : 'short', kind: o.kind ?? 'limit', leverage: o.leverage,
        marginUsd: o.marginUsd, triggerPx: o.triggerPx, firedPx: o.firedPx, intentId: o.intentId, fill: o.fill, note: o.note,
      })
    }
    log(update.status === 'filled' ? 'FILL' : 'trig', `${describe(o)}: ${line}`)
    return next
  }

  const rearmOrFail = (o: TriggerOrder, from: OrderStatus[], why: string) =>
    o.attempts < MAX_ATTEMPTS && Date.now() < o.expiresAt
      ? settle(o, from, { status: 'armed', note: `${why}; re-armed (attempt ${o.attempts}/${MAX_ATTEMPTS})` }, `${why}; re-armed`)
      : settle(o, from, { status: 'failed', note: why }, `${why}; giving up`)

  /** A display note on an armed order (why it's holding), written only when it changes. */
  const noteArmed = (o: TriggerOrder, note: string | undefined) => {
    if (o.note === note) return
    o.note = note
    void store.transition(o.id, ['armed'], { note }).catch((err) => log('warn', `${describe(o)}: note: ${errMsg(err)}`))
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
    const user = users.get(o.wallet)
    const size = sizeOrder(o, freeUsd(o.wallet) - inFlightUsd(o.wallet), inst, trading)
    if (typeof size === 'string' || !user?.key) return
    if (!opts.live) {
      await settle(o, ['armed'], { status: 'filled', attempts: o.attempts + 1, firedPx: mid.px, marginUsd: size.marginUsd, sentAt: Date.now(), note: 'dry run: nothing sent', fill: { positionId: 'dry', entryPx: mid.px, waitedS: 0 } },
        `dry: would open ${usd(size.notionalUsd, 0)} (${usd(size.marginUsd)} margin) at ~${mid.px}; nothing sent`)
      return
    }
    // Claimed as 'sending' in the database before anything is signed: only one claim can win, and a crash after it
    // leaves the order 'sending' (then 'unconfirmed' on restart), never armed again, so it is never sent twice.
    const claimed = await settle(o, ['armed'], { status: 'sending', attempts: o.attempts + 1, firedPx: mid.px, marginUsd: size.marginUsd, sentAt: Date.now(), note: undefined },
      `FIRE at ${mid.px}: ${usd(size.notionalUsd, 0)} (${usd(size.marginUsd)} margin), queue ${pub.pressure?.queuedIntents ?? '?'}`)
    if (!claimed) return
    const a = account(o.wallet)
    let signed: Awaited<ReturnType<typeof signIntent>>
    try {
      signed = await signIntent(privateKeyToAccount(keys.open(user.key.sealed)), EXCHANGE_DOMAIN, 'OpenPosition', {
        user: o.wallet,
        instrumentId: inst.id,
        isLong: o.isLong,
        size: size.marginRaw,
        leverage: o.leverage,
        useDebt: false,
        nonce: await nextNonce(o.wallet),
        deadline: deadlineFromNow(BigInt(o.deadlineSec)),
      })
      await store.transition(o.id, ['sending'], { intentId: signed.intentId })
    } catch (err) {
      // Nothing went to the relayer: put it back (if the database is down too, it stays 'sending' and is never sent).
      await settle(o, ['sending'], { status: 'armed', attempts: o.attempts - 1, intentId: undefined, note: `not sent (${errMsg(err)}); re-armed` }, `not sent: ${errMsg(err)}`).catch(() => {})
      return
    }
    const intentId = signed.intentId
    try {
      await submitIntent('openPosition', signed.signed, intentId)
    } catch (err) {
      // A relayer refusal means nothing is queued; anything else (timeout, network) might have reached it.
      if (err instanceof RelayerError) await rearmOrFail(o, ['sending'], `rejected: ${errMsg(err)}`)
      else await settle(o, ['sending'], { status: 'unconfirmed', note: `send failed (${errMsg(err)}); it may still fill, check Papertrade` }, `send failed: ${errMsg(err)}`)
      return
    }
    await settle(o, ['sending'], { status: 'sent' }, `sent ${intentId.slice(0, 10)}, deadline ${o.deadlineSec}s`)
    const pos = await waitForFill(a, intentId, o.deadlineSec * 1000 + FILL_GRACE_MS)
    if (pos) {
      const entryPx = Number(pos.entryPriceRaw) / Number(inst.priceScale)
      const waitedS = Math.round((pos.openedAtMs - o.sentAt!) / 1000)
      const slipBp = ((entryPx - o.triggerPx) / o.triggerPx) * 1e4 * (o.isLong ? 1 : -1)
      await settle(o, ['sent'], { status: 'filled', fill: { positionId: pos.positionId, entryPx, waitedS }, note: `${slipBp >= 0 ? 'worse' : 'better'} than trigger by ${Math.abs(slipBp).toFixed(1)}bp` },
        `#${pos.positionId} @ ${entryPx} after ${waitedS}s (trigger ${o.triggerPx}, sent at ${o.firedPx}, ${slipBp.toFixed(1)}bp vs trigger)`)
    } else if (a.failed.has(intentId)) await rearmOrFail(o, ['sent'], 'intent expired or failed before filling')
    else await settle(o, ['sent'], { status: 'unconfirmed', note: 'no fill seen; it may still land, check Papertrade' }, 'no fill or failure seen')
  }

  // One check a second: expire old orders, then send up to SENDS_PER_PASS triggered orders, one per wallet.
  let busy = false
  const firing = new Set<string>() // orders this process is sending, so the next pass doesn't try to claim them again
  let lastCheckAt = 0
  const check = async () => {
    if (busy || !modeOk) return
    lastCheckAt = Date.now()
    busy = true
    try {
      for (const o of allOrders()) {
        if (o.status === 'armed' && Date.now() > o.expiresAt) await settle(o, ['armed'], { status: 'expired', note: 'expired before triggering' }, 'expired')
      }
      const sentTo = new Set<string>()
      for (const o of allOrders().filter((o) => o.status === 'armed' && !firing.has(o.id))) {
        if (sentTo.size >= SENDS_PER_PASS) break
        if (sentTo.has(o.wallet) || [...firing].some((id) => store.orders.get(id)?.wallet === o.wallet)) continue
        const inst = instOf(o.symbol)
        const mid = inst && midPx(inst)
        if (!inst || !mid) {
          noteArmed(o, 'waiting for a live price')
          continue
        }
        if (o.kind !== 'market' && !crossed(o, mid.px)) {
          if (o.note && !o.note.includes('re-armed')) noteArmed(o, undefined)
          continue
        }
        let hold: string | null = null
        // The account feed first: the key's status comes from it, and the worker opens a wallet's feed only here.
        if (Date.now() - tradingAt > TRADING_STALE_MS) hold = 'waiting for fresh market state'
        else if (opts.live && !account(o.wallet).stream.state) hold = 'waiting for the account feed'
        else if (tradingStatus(users.get(o.wallet)).status !== 'active') hold = 'trading key not active; enable trading again'
        // Market orders go out like a normal trade, whatever the relayer queue; limits hold while it's backed up.
        else hold = holdReason(o, inst, trading, mid.raw, freeUsd(o.wallet) - inFlightUsd(o.wallet), o.kind === 'market' ? null : pub.pressure?.queuedIntents ?? null)
        if (hold) {
          if (o.note !== `triggered; holding: ${hold}`) log('hold', `${describe(o)}: ${hold}`)
          noteArmed(o, `triggered; holding: ${hold}`)
          continue
        }
        firing.add(o.id)
        sentTo.add(o.wallet)
        void fire(o, inst, mid)
          .catch((err) => log('warn', `${describe(o)}: ${errMsg(err)}`))
          .finally(() => firing.delete(o.id))
      }
    } finally {
      busy = false
    }
  }

  // ---- closes, sent by the worker ------------------------------------------------------------------------------------
  // A web instance queues the close (paperwatch.closes, status 'requested'); the worker takes it, signs it with the
  // wallet's trading key and sends it. The page shows "Closing…" until the position is gone, or the reason it failed.
  let closesBusy = false
  const sendCloses = async () => {
    if (closesBusy || !modeOk) return
    closesBusy = true
    try {
      for (const c of [...store.closes.values()].filter((c) => c.status === 'requested' && !c.done)) {
        if (Date.now() - c.at > CLOSE_PICKUP_MS) {
          await store.setClose(c.positionId, { status: 'failed', done: true, error: 'The close was not sent in time. Try again.' })
          continue
        }
        if (!(await store.takeClose(c.positionId))) continue
        await sendClose(c.positionId, c.wallet).catch((err) => log('warn', `close #${c.positionId}: ${errMsg(err)}`))
      }
    } finally {
      closesBusy = false
    }
  }
  const sendClose = async (id: string, wallet: Address) => {
    const fail = (error: string) => store.setClose(id, { status: 'failed', done: true, error })
    const user = users.get(wallet)
    if (!user?.key) return fail('Trading is not enabled.')
    const a = account(wallet)
    const state = opts.live ? await a.stream.ready().catch(() => null) : null
    if (opts.live && !state) return fail('Could not read the account from Papertrade. Try again.')
    if (state && !state.positions.has(id)) return fail('That position is not open on this account.')
    if (tradingStatus(user).status !== 'active') return fail('The trading key is not active. Enable trading again.')
    let signed: Awaited<ReturnType<typeof signIntent>>
    try {
      signed = await signIntent(privateKeyToAccount(keys.open(user.key.sealed)), EXCHANGE_DOMAIN, 'Close', {
        user: wallet,
        positionIds: [BigInt(id)],
        nonce: await nextNonce(wallet),
        deadline: deadlineFromNow(INTENT_TTL_SEC),
      })
      await store.setClose(id, { intentId: signed.intentId })
    } catch (err) {
      return fail(`The close could not be sent (${errMsg(err)}).`) // nothing went out
    }
    try {
      await submitIntent('closePositions', signed.signed, signed.intentId)
    } catch (err) {
      // A refusal sent nothing; anything else might have reached the relayer, so it stays "on its way".
      if (err instanceof RelayerError && err.reason === 'noOpenPositions') return fail('A close for this position is already pending on Papertrade.')
      if (err instanceof RelayerError) return fail(`Papertrade refused the close (${err.code}${err.reason ? `/${err.reason}` : ''}).`)
      log('warn', `close #${id}: send failed (${errMsg(err)}); it may still land`)
      return store.setClose(id, { status: 'sent' })
    }
    await store.setClose(id, { status: 'sent' })
    track('position_close', wallet, { positionId: id, intentId: signed.intentId })
    log('close', `${short(wallet)} #${id} sent ${signed.intentId.slice(0, 10)}`)
    // Done once the position is gone or the close failed (the page shows "Closing…" until then, 10 minutes at most).
    const intentId = signed.intentId
    void a.stream
      .waitFor((s) => (!s.positions.has(id) || a.failed.has(intentId) ? true : undefined), 10 * 60_000)
      .then(() => store.setClose(id, a.failed.has(intentId) ? { done: true, status: 'failed', error: 'The close failed on Papertrade. Try again.' } : { done: true }))
      .catch(() => store.setClose(id, { done: true }))
      .catch((err) => log('warn', `close #${id}: ${errMsg(err)}`))
  }

  // ---- the worker: one process at a time, by the database lock -------------------------------------------------------
  let holdsLock = false
  let healthSeen = false
  let modeOk = true
  const startWorker = async () => {
    await store.workerLock((why) => {
      // The lock may be gone with the connection: stop at once, and let the supervisor start a fresh process.
      log('warn', `worker lock lost (${why}); exiting`)
      process.exit(1)
    })
    holdsLock = true
    log('worker', 'holding the worker lock: sending orders and closes')
    // A restart can't tell whether an order being sent reached the relayer: never send those again.
    for (const o of allOrders()) {
      if (!o.wallet && o.status === 'armed') await store.transition(o.id, ['armed'], { status: 'cancelled', note: 'placed before wallet accounts; place it again' })
      if (o.status === 'sending') await store.transition(o.id, ['sending'], { status: 'unconfirmed', note: 'restarted while sending; check the app before placing it again' })
    }
    for (const c of store.closes.values()) {
      if (c.status === 'sending') await store.setClose(c.positionId, { status: 'sent' }) // may have gone out: keep blocking
    }
    // Move every sealed key to the current public key (after a rotation, or off PT_KEY_SECRET); keys sealed the old way
    // by a web instance still on it get picked up on the next pass.
    const rewrap = async () => {
      let n = 0
      for (const u of [...store.users.values()]) {
        if (u.key && keys.needsRewrap(u.key.sealed) && (await store.reseal(u.wallet, 'key', u.key.sealed, keys.seal(keys.open(u.key.sealed))))) n++
        if (u.pendingKey && keys.needsRewrap(u.pendingKey.sealed) && (await store.reseal(u.wallet, 'pending', u.pendingKey.sealed, keys.seal(keys.open(u.pendingKey.sealed))))) n++
      }
      if (n) log('keys', `resealed ${n} trading key(s) with ${keys.kid}`)
    }
    await rewrap().catch((err) => log('warn', `rewrap: ${errMsg(err)}`))
    setInterval(() => void rewrap().catch((err) => log('warn', `rewrap: ${errMsg(err)}`)), 60_000)
    const checkMode = async () => {
      const site = (await store.get<{ mode: string }>('mode'))?.mode
      const ok = !site || site === mode
      if (ok !== modeOk) log(ok ? 'worker' : 'warn', ok ? `mode matches the site (${mode}); sending` : `this worker is ${mode} but the site is ${site}: not sending`)
      modeOk = ok
    }
    await checkMode()
    setInterval(() => void checkMode().catch((err) => log('warn', `mode check: ${errMsg(err)}`)), 10_000)
    setInterval(() => void check().catch((err) => log('warn', `check: ${errMsg(err)}`)), CHECK_MS)
    setInterval(() => void sendCloses().catch((err) => log('warn', `closes: ${errMsg(err)}`)), CHECK_MS)
    setInterval(() => void store.pruneOrders().catch((err) => log('warn', `prune orders: ${errMsg(err)}`)), PRUNE_MS)
    if (FEE_ADDRESS) void scanFees()
    // Heartbeat for the status page: what the worker is doing, and how orders went over the last hour.
    const beat = async () => {
      const now = Date.now()
      const hour = allOrders().filter((o) => o.sentAt && now - o.sentAt < 3_600_000)
      const waits = hour.flatMap((o) => (o.status === 'filled' && o.fill && o.fill.positionId !== 'dry' ? [o.fill.waitedS] : []))
      const ages = trading.instruments.filter((i) => !i.retired).map((i) => now - (bbo.get(i.symbol)?.at ?? 0))
      const w: WorkerBeat = {
        at: now,
        mode,
        lastCheckAt,
        feeds: accounts.size,
        sends1h: hour.length,
        fails1h: hour.filter((o) => o.status === 'failed').length,
        unconfirmed1h: hour.filter((o) => o.status === 'unconfirmed').length,
        fillP50s: percentile(waits, 0.5),
        fillP95s: percentile(waits, 0.95),
        priceAgeMs: ages.length ? Math.max(...ages) : null,
        warns10m: warnTimes.filter((t) => now - t < 600_000).length,
      }
      await store.put('status:worker', w)
    }
    setInterval(() => void beat().catch((err) => log('warn', `status beat: ${errMsg(err)}`)), 10_000)
  }

  // ---- status: /api/status, the /status page, and alerts from one web replica -------------------------------------------
  const replica = process.env.RAILWAY_REPLICA_ID?.slice(0, 8) ?? 'local'
  let statusCache: { at: number; summary: Summary } | null = null
  const currentStatus = async (): Promise<Summary> => {
    if (statusCache && Date.now() - statusCache.at < 5000) return statusCache.summary
    const [rows, dbOk] = await Promise.all([store.getPrefix<WorkerBeat | WebBeat>('status:').catch(() => []), store.ping()])
    const worker = (rows.find((r) => r.id === 'status:worker')?.data as WorkerBeat | undefined) ?? null
    const webs = rows.filter((r) => r.id.startsWith('status:web:')).map((r) => r.data as WebBeat)
    const summary = summarize(Date.now(), worker, webs, dbOk, pub.pressure?.queuedIntents ?? null, MAX_QUEUED)
    statusCache = { at: Date.now(), summary }
    return summary
  }
  if (web) {
    const alerter = new Alerter()
    setInterval(async () => {
      try {
        const now = Date.now()
        const beat: WebBeat = { at: now, replica, lives: lives.size, refreshAgeMs: now - refreshedAt, warns10m: warnTimes.filter((t) => now - t < 600_000).length }
        await store.put(`status:web:${replica}`, beat)
        const webs = (await store.getPrefix<WebBeat>('status:web:')).map((r) => r.data)
        if (alertLeader(now, webs) !== replica) return
        for (const p of (await currentStatus()).parts) alerter.set(p.name, p.status !== 'ok', p.status === 'down' ? 'crit' : 'warn', `paperwatch.app ${p.name}: ${p.detail}`)
      } catch (err) {
        log('warn', `status: ${errMsg(err)}`)
      }
    }, 10_000)
  }

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
  const isAddress = (v: unknown): v is Address => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)

  // Fee watcher: while anyone who still owes the fee has the page open, read every new HyperEVM block and credit each
  // successful transfer of at least the fee to the fee address to the wallet that sent it. A user just sends HYPE and
  // trading unlocks on its own. It looks back a minute when it starts, and the unlock window can also check a hash.
  const scanSaved = await store.get<{ block: number }>('fee-scan')
  let scanned: number | null = scanSaved ? Number(scanSaved.block) : null
  // Web instances mark "someone owes the fee" in the database, since the worker serves no pages of its own.
  let feeWaitingUntil = 0
  let feeWaitingMarked = 0
  const markFeeWaiting = () => {
    if (Date.now() - feeWaitingMarked < 60_000) return
    feeWaitingMarked = Date.now()
    void store.put('fee-waiting', { until: Date.now() + FEE_WAITING_MS }).catch((err) => log('warn', `fee-waiting: ${errMsg(err)}`))
  }
  const someoneWaiting = () => Date.now() < feeWaitingUntil
  const scanFees = async () => {
    try {
      feeWaitingUntil = (await store.get<{ until: number }>('fee-waiting'))?.until ?? 0
      if (!someoneWaiting()) scanned = null
      else {
        const head = Number(await client.getBlockNumber())
        if (scanned === null || head - scanned > 1200) scanned = head - 60
        const from = scanned + 1
        const last = Math.min(head, scanned + FEE_SCAN_BATCH)
        const blocks = await Promise.all(
          Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => client.getBlock({ blockNumber: BigInt(from + i), includeTransactions: true })),
        )
        for (const block of blocks) {
          for (const tx of feePayments(block.transactions as { hash: Hex; from: Address; to: Address | null; value: bigint }[], FEE_ADDRESS!, FEE_WEI)) {
            if (store.isFeeTxUsed(tx.hash) || feeOk(tx.from)) continue
            const receipt = await client.getTransactionReceipt({ hash: tx.hash })
            if (receipt.status !== 'success') continue
            if (!(await store.setFee(tx.from, { tx: tx.hash.toLowerCase() as Hex, paidAt: Date.now(), wei: String(tx.value) }))) continue
            track('fee_paid', tx.from, { tx: tx.hash, wei: String(tx.value), via: 'scan' })
            log('fee', `${short(tx.from)} paid ${formatEther(tx.value)} HYPE in block ${block.number} (${tx.hash.slice(0, 10)}); trading unlocked`)
          }
        }
        scanned = last
        await store.put('fee-scan', { block: scanned })
      }
    } catch (err) {
      log('warn', `fee scan: ${errMsg(err)}`)
    }
    setTimeout(scanFees, FEE_SCAN_MS)
  }
  // Closes for a wallet that the page should know about: on their way, or failed within the last minute.
  const closesFor = (wallet: Address) =>
    [...store.closes.values()]
      .filter((c) => c.wallet === wallet && (!c.done || (c.status === 'failed' && Date.now() - c.updatedAt < 60_000)))
      .map((c) => ({ positionId: c.positionId, done: c.done, error: c.status === 'failed' ? c.error : null, at: c.at }))

  // `wallet` is who is signed in (can trade); `view` is whose account the box shows, which can be any connected wallet:
  // the account data is public on Papertrade, so it shows on connect, before signing in.
  // What every page shares: prices, open-interest room, the relayer queue and market limits. Built once per tick.
  const shared = () => ({
    mode,
    stakingContract: CONTRACTS.paperStaking,
    dryBalanceUsd: opts.live ? null : dryBalance,
    queued: pub.pressure?.queuedIntents ?? null,
    maxQueued: MAX_QUEUED,
    defaultLeverage: DEFAULT_LEVERAGE,
    markets: trading.instruments
      .filter((i) => !i.retired)
      .map((inst) => {
        const mid = midPx(inst)
        return {
          id: inst.id,
          symbol: inst.symbol,
          priceScale: String(inst.priceScale),
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
  })

  // What is one visitor's own: who is signed in, the stored key, the unlock fee, their orders and closes. The page follows
  // the account on Papertrade itself (balances, positions, whether the key is on-chain), so none of that is here.
  // `byWallet` (orders and closes grouped by wallet) lets the live stream build this for every page without a scan each.
  const groupByWallet = () => {
    const orders = new Map<string, TriggerOrder[]>()
    for (const o of store.orders.values()) orders.set(o.wallet, [...(orders.get(o.wallet) ?? []), o])
    return orders
  }
  const mine = (wallet: Address | null, view: Address | null, ordersOf = groupByWallet()) => {
    const own = (w: Address | null) => (w ? (ordersOf.get(w) ?? []) : [])
    return {
      wallet,
      view,
      key: wallet && users.get(wallet)?.key ? (({ sealed: _, ...k }) => k)(users.get(wallet)!.key!) : null,
      fee: feeInfo(wallet),
      // Margin already committed by this wallet's sent-but-unfilled orders, so two orders can't both spend it.
      inFlightUsd: own(view).filter((o) => o.status === 'sending' || o.status === 'sent').reduce((sum, o) => sum + (o.marginUsd ?? 0), 0),
      closes: view ? closesFor(view) : [],
      orders: own(wallet).sort((a, b) => b.createdAt - a.createdAt),
    }
  }
  const snapshot = (wallet: Address | null, view: Address | null) => ({ ...shared(), ...mine(wallet, view) })

  // ---- live updates: one server-sent-events stream per page (/api/live) -----------------------------------------------
  // Every second each replica builds the shared part once and sends the same text to every page; each page's own part
  // goes out only when it changed. A comment every 15 s keeps idle connections open through Cloudflare (100 s limit).
  type Live = { res: ServerResponse; wallet: Address | null; view: Address | null; lastMine: string }
  const lives = new Set<Live>()
  const sse = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`
  const liveTick = () => {
    if (!lives.size) return
    const sharedMsg = sse('markets', JSON.stringify(shared()))
    const ordersOf = groupByWallet()
    for (const l of lives) {
      // A page that stops reading (asleep, bad network) is dropped rather than buffered for; it reconnects on its own.
      if (l.res.writableLength > 1_000_000) {
        l.res.destroy()
        lives.delete(l)
        continue
      }
      const me = JSON.stringify(mine(l.wallet, l.view, ordersOf))
      l.res.write(me === l.lastMine ? sharedMsg : sharedMsg + sse('me', me))
      l.lastMine = me
      if (l.wallet && !feeOk(l.wallet)) markFeeWaiting()
    }
  }
  setInterval(liveTick, 1000)
  setInterval(() => {
    for (const l of lives) l.res.write(': keep-alive\n\n')
  }, 15_000)

  const candles = new CandleStore()
  // paperwatch.app is this one server: Trade at /trade (also /limits), the queue page at /queue (also /que), shared top bar.
  const queue = startQueueRelay({ trading: () => (Date.now() - tradingAt < TRADING_STALE_MS ? trading : null), midRaw: (inst) => midPx(inst)?.raw ?? null })
  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    baseHeaders(res)
    if (req.method === 'GET') {
      if (url.pathname === '/') return void res.writeHead(302, { location: '/trade' }).end()
      // /trade is the page; /limits (its old name) still works.
      if (['/trade', '/trade/', '/limits', '/limits/'].includes(url.pathname)) return servePage(res, 'trigger.html')
      if (url.pathname === '/vendor/lightweight-charts.js') return serveChartJs(res)
      if (url.pathname.startsWith('/assets/') && serveAsset(res, url.pathname.slice(8))) return
      if (['/queue', '/queue/', '/que', '/que/'].includes(url.pathname)) return queue.page(res)
      if (url.pathname === '/events') return queue.events(req, res)
      if (url.pathname === '/site.js') return serveSiteJs(res, true)
      if (url.pathname === '/status' || url.pathname === '/status/') return servePage(res, 'status.html')
      if (url.pathname === '/api/status') {
        const summary = await currentStatus()
        return json(res, summary.status === 'down' ? 503 : 200, summary)
      }
      if (url.pathname === '/account-frames.js') return serveAccountFrames(res)
      if (url.pathname === '/healthz') {
        // Note the first check each process answers, so a deploy's logs show Railway's health check ran.
        if (!healthSeen) {
          healthSeen = true
          log('health', `first /healthz answered (host ${String(req.headers.host ?? '?').slice(0, 60)})`)
        }
        return json(res, 200, { role: ROLE, worker: holdsLock, replica: process.env.RAILWAY_REPLICA_ID?.slice(0, 8) ?? null })
      }
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })
    // Every write needs our header: browsers won't send it cross-site without a preflight we never allow (CSRF).
    if (req.method !== 'GET' && req.headers['x-paperwatch'] !== '1') return json(res, 403, { error: 'missing request header' })
    const wallet = readToken(cookieOf(req), authSecret)
    const needWallet = () => {
      if (!wallet) json(res, 401, { error: 'Connect and sign in with your wallet first.' })
      return wallet
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/live') {
        const asked = url.searchParams.get('wallet')
        const view: Address | null = wallet ?? (isAddress(asked) ? (asked.toLowerCase() as Address) : null)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
        const me = JSON.stringify(mine(wallet, view))
        const l: Live = { res, wallet, view, lastMine: me }
        res.write('retry: 3000\n\n' + sse('markets', JSON.stringify(shared())) + sse('me', me))
        lives.add(l)
        req.on('close', () => lives.delete(l))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (wallet && !feeOk(wallet)) markFeeWaiting()
        const asked = url.searchParams.get('wallet')
        const view: Address | null = wallet ?? (isAddress(asked) ? (asked.toLowerCase() as Address) : null)
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
        await store.putSignIn(body.wallet, message)
        return json(res, 200, { message })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/verify') {
        const body = await readBody(req)
        if (!isAddress(body.wallet) || typeof body.signature !== 'string') return json(res, 400, { error: 'bad sign-in' })
        // Used up whether or not the signature checks out: each message signs in at most once.
        const message = await store.takeSignIn(body.wallet, SIGN_IN_TTL_MS)
        if (!message) return json(res, 400, { error: 'Sign-in expired. Try again.' })
        const ok = await verifyMessage({ address: body.wallet, message, signature: body.signature as Hex }).catch(() => false)
        if (!ok) return json(res, 401, { error: 'That signature is not from this wallet.' })
        const user = await store.ensureUser(body.wallet)
        track('sign_in', user.wallet)
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
        if (store.isFeeTxUsed(hash)) return json(res, 409, { error: 'That payment already unlocked a wallet.' })
        // One look per call, not a wait: the page asks again every few seconds until the payment confirms.
        const last = feeChecks.get(wallet!) ?? 0
        if (Date.now() - last < FEE_CHECK_MS) return json(res, 429, { error: 'Checking too often; try again in a few seconds.' })
        feeChecks.set(wallet!, Date.now())
        const receipt = await client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null)
        if (!receipt) return json(res, 202, { pending: true, error: 'Payment not confirmed yet.' })
        const tx = await client.getTransaction({ hash: hash as Hex })
        const problem = feePaymentProblem(tx, receipt.status, wallet!, FEE_ADDRESS!, FEE_WEI)
        if (problem) return json(res, 400, { error: problem })
        if (!(await store.setFee(wallet!, { tx: hash.toLowerCase() as Hex, paidAt: Date.now(), wei: String(tx.value) }))) {
          return json(res, 409, { error: 'That payment already unlocked a wallet.' })
        }
        track('fee_paid', wallet!, { tx: hash.toLowerCase(), wei: String(tx.value), via: 'hash' })
        log('fee', `${short(wallet!)} paid ${formatEther(tx.value)} HYPE (${hash.slice(0, 10)})`)
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
        const user = await store.ensureUser(wallet!)
        const live = url.searchParams.get('renew') !== '1' && user.key && (user.key.registeredAt || Date.now() - (user.key.submittedAt ?? 0) < 180_000)
        if (live && user.key!.expiry > Date.now() / 1000 + KEY_RENEW_SEC) return json(res, 409, { error: 'Trading is already enabled.' })
        const pk = generatePrivateKey()
        const keyAddress = privateKeyToAccount(pk).address
        const input = {
          user: user.wallet,
          key: keyAddress,
          expiry: BigInt(Math.floor(Date.now() / 1000)) + SESSION_TTL_SEC - 60n,
          feeAddress: zeroAddress, // what the official frontend sends
          nonce: await nextNonce(user.wallet),
          deadline: deadlineFromNow(600n),
        }
        await store.setPendingKey(user.wallet, { address: keyAddress, sealed: keys.seal(pk), input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, String(v)])) })
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
        const key = { address: pending.address, sealed: pending.sealed, expiry: Number(p.expiry), submittedAt: Date.now(), ...(opts.live ? {} : { registeredAt: Date.now() }) }
        if (!(await store.activateKey(user.wallet, key))) return json(res, 409, { error: 'Start again: a newer trading key is waiting for approval.' })
        track('trading_enabled', user.wallet, { key: pending.address, dry: !opts.live })
        log('key', `${short(user.wallet)} trading key ${short(pending.address)} ${opts.live ? 'submitted' : 'approved (dry: not sent)'}`)
        if (opts.live) {
          const keyId = pending.address.toLowerCase()
          // A short-lived feed of our own, just to see the key land on Papertrade.
          const watch = new AccountStream(user.wallet)
          watch.start()
          void watch
            .waitFor((s) => (s.sessionKeys.has(keyId) ? true : undefined), 120_000)
            .finally(() => watch.stop())
            .then(async () => {
              await store.markKeyRegistered(user.wallet, keyId)
              log('key', `${short(user.wallet)} trading key ${short(keyId)} registered`)
            })
            .catch(() => log('warn', `${short(user.wallet)} trading key ${short(keyId)} not seen on Papertrade within 2 min`))
        }
        return json(res, 200, keyStatus(key, undefined, opts.live))
      }
      // Turn trading off: forget the key here, and hand back the transaction that revokes it on Papertrade.
      if (req.method === 'POST' && url.pathname === '/api/trading/revoke') {
        if (!needWallet()) return
        const user = users.get(wallet!)
        if (!user?.key) return json(res, 400, { error: 'Trading is not enabled.' })
        const keyAddress = user.key.address
        await store.clearKey(user.wallet)
        for (const o of allOrders().filter((o) => o.wallet === user.wallet && o.status === 'armed')) await settle(o, ['armed'], { status: 'cancelled', note: 'trading turned off' }, 'cancelled (trading off)')
        track('trading_disabled', user.wallet, { key: keyAddress })
        log('key', `${short(user.wallet)} turned trading off (key ${short(keyAddress)})`)
        return json(res, 200, { tx: { to: CONTRACTS.sessionKeyManager, data: encodeFunctionData({ abi: REVOKE_ABI, functionName: 'revokeSessionKey', args: [keyAddress] }) } })
      }

      if (req.method === 'POST' && url.pathname === '/api/orders') {
        if (!needWallet() || locked()) return
        // The worker re-checks the key on-chain before sending, and holds the order if it isn't active.
        if (!users.get(wallet!)?.key) return json(res, 400, { error: 'Enable trading first.' })
        if (allOrders().filter((o) => o.wallet === wallet && o.status === 'armed').length >= MAX_ARMED_PER_WALLET) {
          return json(res, 400, { error: `You can have up to ${MAX_ARMED_PER_WALLET} open limit intents.` })
        }
        const input = (await readBody(req)) as OrderInput
        const inst = instOf(String(input.symbol ?? ''))
        const mid = inst && midPx(inst)
        if (inst && !mid) return json(res, 400, { error: 'no live price yet; try again in a few seconds' })
        const placed = newOrder(input, inst, mid?.px ?? 0, Date.now(), wallet!, Number(trading.minimumOpenNotionalRaw) / 1e18)
        if (typeof placed === 'string') return json(res, 400, { error: placed })
        const o = await store.addOrder(placed)
        track('order_placed', o.wallet, { id: o.id, symbol: o.symbol, side: o.isLong ? 'long' : 'short', kind: o.kind ?? 'limit', leverage: o.leverage, triggerPx: o.triggerPx, marginPct: o.marginPct, fixedMarginUsd: o.fixedMarginUsd })
        log('place', `${describe(o)}, expires ${new Date(o.expiresAt).toISOString()}, deadline ${o.deadlineSec}s (mid ${mid!.px})`)
        return json(res, 200, o)
      }
      // Close one open position at market: a Papertrade Close intent signed with the wallet's trading key.
      const close = url.pathname.match(/^\/api\/positions\/(\d+)\/close$/)
      if (req.method === 'POST' && close) {
        if (!needWallet()) return
        const user = users.get(wallet!)
        if (!user?.key) return json(res, 400, { error: 'Enable trading first.' })
        const id = close[1]
        // The worker checks the position is this wallet's and the key is active before it sends anything.
        if (!opts.live) {
          log('close', `${short(wallet!)} #${id}: dry run, nothing sent`)
          return json(res, 200, { dry: true })
        }
        if (!(await store.claimClose(id, wallet!))) return json(res, 409, { error: 'A close for this position is already on its way.' })
        log('close', `${short(wallet!)} #${id} queued`)
        if (holdsLock) void sendCloses()
        return json(res, 200, { queued: true })
      }

      const cancel = url.pathname.match(/^\/api\/orders\/([\w-]+)\/cancel$/)
      if (req.method === 'POST' && cancel) {
        if (!needWallet()) return
        const o = allOrders().find((x) => x.id === cancel[1] && x.wallet === wallet)
        if (!o) return json(res, 404, { error: 'no such order' })
        if (o.status !== 'armed' || !(await settle(o, ['armed'], { status: 'cancelled', note: 'cancelled' }, 'cancelled'))) {
          return json(res, 409, { error: `order is ${o.status}; only armed orders can be cancelled` })
        }
        return json(res, 200, o)
      }
      return json(res, 404, { error: 'not found' })
    } catch (err) {
      return json(res, 400, { error: errMsg(err) })
    }
  }).listen(PORT, HOST, () => {
    const armed = allOrders().filter((o) => o.status === 'armed').length
    const fee = FEE_ADDRESS ? `unlock ${formatEther(FEE_WEI)} HYPE to ${short(FEE_ADDRESS)} (${FEE_EXEMPT.size} exempt)` : 'no unlock fee'
    log('start', `${mode.toUpperCase()} ${ROLE} on ${HOST}:${PORT}; ${store.users.size} account(s), ${armed} armed order(s); ${fee}; hold while ${MAX_QUEUED}+ intents queued.`)
  })
  if (worker) void startWorker().catch((err) => {
    log('warn', `worker: ${errMsg(err)}; exiting`)
    process.exit(1)
  })
  if (!web) log('start', 'worker only: the pages are served by the web instances')

  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve)
    process.once('SIGTERM', resolve)
  })
  await store.flushEvents()
  for (const a of accounts.values()) a.stream.stop()
}
