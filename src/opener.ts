import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AccountStream } from './account.ts'
import { getTradingState, type Instrument } from './api.ts'
import { legMarginRaw, loadStrategyConfig } from './config.ts'
import { LiveExecutor } from './executor.ts'
import { PublicStream } from './intake.ts'
import { startJournal } from './journal.ts'
import { readMids } from './market.ts'
import { sideHeadroomUsd } from './risk.ts'
import { NonceSource, loadSessionKey, loadState, saveState } from './state.ts'
import { log, makeClient, price, requireWalletAddress, usd } from './bot.ts'

// Open-only mode (its own Railway service, PT_PROCESS=opener): opens ONE long + short pair per start, sending both
// legs at the same instant so the relayer can put them in the same block, then does nothing else. It never closes,
// resets or unwinds anything, not even a lone leg, and leaves its positions alone on shutdown: you close each leg
// yourself. PT_MODE=live opens for real on start; dry only logs what it would do. Same sizing variables as the bot.
// In both modes it also runs the read-only LEG journal (src/journal.ts) for as long as it's up.

const CHECK_MS = 5000
const WAIT_LOG_MS = 30_000
const NO_PRESSURE_MS = 30_000 // without queue data by then, open anyway
// Hold while the relayer has this many intents queued or more (PT_OPENER_MAX_QUEUED, default 250; ~10 per block).
const MAX_QUEUED = Number(process.env.PT_OPENER_MAX_QUEUED ?? 250)
const RECENT_OPEN_MS = 10 * 60_000 // a container restart soon after an open must not open a second pair
const FILL_WAIT_MS = 10 * 60_000 // legs can sit in the intake queue for minutes
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))

export async function runOpener(opts: { live: boolean }): Promise<void> {
  const cfg = loadStrategyConfig()
  const mode = opts.live ? 'LIVE' : 'DRY'
  const marginRaw = legMarginRaw(cfg)
  const marginUsd = Number(marginRaw) / 1e18
  const trading = await getTradingState()
  const home = trading.instruments.find((i) => i.symbol === cfg.instrument)
  if (!home) throw new Error(`instrument ${cfg.instrument} not listed`)
  if (cfg.leverage > home.maxLeverage) throw new Error(`leverage ${cfg.leverage}x exceeds ${home.symbol} max ${home.maxLeverage}x`)
  if (marginRaw < trading.minimumTradeSizeRaw) throw new Error('margin per leg is below the protocol minimum')
  if (marginRaw * BigInt(cfg.leverage) < trading.minimumOpenNotionalRaw) throw new Error('notional per leg is below the protocol minimum')
  if (marginRaw * BigInt(cfg.leverage) > home.maxPositionNotionalRaw) throw new Error('notional per leg exceeds the per-position max')
  log('start', `${mode} opener: one ${cfg.instrument} long + short, ${usd(cfg.legNotionalUsd, 0)}/leg at ${cfg.leverage}x (margin ${usd(marginUsd)}). Never closes anything.`)

  // The account feed is read-only, so dry mode follows it too (for the journal) whenever the wallet is set.
  const wallet = opts.live ? requireWalletAddress() : (process.env.PT_WALLET_ADDRESS as Address | undefined)
  let stream: AccountStream | null = null
  if (wallet) {
    stream = new AccountStream(wallet)
    stream.onError = (err) => log('stream', `reconnecting: ${errMsg(err)}`)
    stream.start()
    await stream.ready()
  }
  let executor: LiveExecutor | null = null
  if (opts.live && wallet && stream) {
    const key = loadSessionKey()
    if (!key || key.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('no session key for this wallet; set PT_SESSION_PRIVATE_KEY')
    const acct = stream.state!
    const expiry = acct.sessionKeys.get(key.address.toLowerCase())
    if (!expiry || Number(expiry) * 1000 < Date.now() + 3_600_000) throw new Error('session key is not registered or expires within an hour')
    const state = loadState('live')
    const nonces = new NonceSource(state, () => saveState('live', state))
    await nonces.ensureUnused(makeClient(), wallet)
    executor = new LiveExecutor(wallet, privateKeyToAccount(key.privateKey), stream, nonces)
  }

  // A restart soon after an open (crash, platform restart) must not open a second pair.
  const justOpened = () => {
    const recent = [...(stream?.state?.positions.values() ?? [])].filter((p) => p.instrumentId === home.id && Date.now() - p.openedAtMs < RECENT_OPEN_MS)
    if (!recent.length) return false
    log('skip', `${recent.length} ${cfg.instrument} position(s) opened in the last 10 min (${recent.map((p) => `#${p.positionId}`).join(' ')}); not opening another pair. Restart later for a new one.`)
    return true
  }

  // Wait until both sides can open, the balance covers both margins and fewer than MAX_QUEUED intents are queued
  // (a shorter queue gives the two legs a better chance of landing together).
  const pub = new PublicStream()
  pub.start()
  if (stream) startJournal(stream, home, pub)
  const started = Date.now()
  let lastWaitLog = 0
  let lastWaitKind = ''
  let inst: Instrument = home
  let mid = 0n
  let queueAtSend = 'no queue data' // logged with the result, as data for automating the timing later
  for (;;) {
    let wait = ''
    try {
      if (stream?.state?.pendingIntents.size) wait = 'intents still pending on the account'
      else if (justOpened()) return idle()
      const t = await getTradingState()
      inst = t.instruments.find((i) => i.id === home.id)!
      mid = (await readMids([inst])).get(inst.id)!
      const pressure = pub.pressure // the journal drains the trades
      const backlog = pressure ? pressure.totalQueuedGas / pressure.blockGasLimit : null
      if (pressure && backlog != null) queueAtSend = `${backlog.toFixed(1)} blocks (${pressure.queuedIntents} queued, ${pressure.submittedIntents} sent)`
      const free = executor?.availableUsd()
      if (wait) {
        // keep waiting
      } else if (!inst.openable || t.tradingPaused || t.pausedActions.includes('openPosition')) wait = `${inst.symbol} opens are paused`
      else if (sideHeadroomUsd(inst, true, t.maxNetOpenInterestRaw, mid) < cfg.legNotionalUsd) wait = 'no OI room for the long'
      else if (sideHeadroomUsd(inst, false, t.maxNetOpenInterestRaw, mid) < cfg.legNotionalUsd) wait = 'no OI room for the short'
      else if (free != null && free < 2 * marginUsd + 1) wait = `balance ${usd(free)} can't cover both margins (${usd(2 * marginUsd)})`
      else if (pressure && pressure.queuedIntents >= MAX_QUEUED) wait = `intake queue backed up (${pressure.queuedIntents} intents queued, limit ${MAX_QUEUED})`
      else if (!pressure && Date.now() - started < NO_PRESSURE_MS) wait = 'waiting for queue data'
    } catch (err) {
      wait = `check failed: ${errMsg(err)}`
    }
    if (!wait) break
    // Log when the reason changes, and every 30 s while it holds.
    const kind = wait.replace(/[\d.,$]+/g, '#')
    if (kind !== lastWaitKind || Date.now() - lastWaitLog >= WAIT_LOG_MS) {
      log('wait', wait)
      lastWaitLog = Date.now()
      lastWaitKind = kind
    }
    await sleep(CHECK_MS)
  }

  if (!executor) {
    log('dry', `would open ${inst.symbol} long + short now at ~${price(mid, inst)}; nothing sent. Set PT_MODE=live to open for real.`)
    return idle()
  }

  // Both legs leave together; which block each lands in is up to the relayer. Nothing below may throw: an exit here
  // would restart this process before the legs show up as positions.
  const ex = executor
  const sides = [true, false]
  const sentAt = Date.now()
  log('send', `long + short at ~${price(mid, inst)}, queue ${queueAtSend}`)
  const sent = await Promise.allSettled(sides.map((isLong) => ex.submitOpen({ inst, isLong, marginRaw, leverage: cfg.leverage })))
  const fills = await Promise.all(
    sent.map(async (r, i) => {
      const side = sides[i] ? 'long' : 'short'
      if (r.status === 'rejected') {
        log('open', `${side} leg rejected: ${errMsg(r.reason)}`)
        return null
      }
      const pos = await ex.waitForPosition(r.value.intentId, FILL_WAIT_MS)
      const waitedS = Math.round((Date.now() - sentAt) / 1000)
      log('open', pos ? `${side} #${pos.positionId} @ ${price(pos.entryPriceRaw, inst)} after ${waitedS}s (bust ${price(pos.bustPriceRaw, inst)})` : `${side} leg didn't fill within ${FILL_WAIT_MS / 60_000} min`)
      return pos ? { pos, waitedS } : null
    }),
  )
  const [long, short] = fills.map((f) => f?.pos ?? null)
  if (long && short) {
    // One greppable line per pair (`railway logs --service pair-opener | grep RESULT`): block gap, entry gap, fill
    // times and the queue when sent.
    const gapS = Math.abs(long.openedAtMs - short.openedAtMs) / 1000
    const gap = Number(long.entryPriceRaw - short.entryPriceRaw) / Number(inst.priceScale)
    const gapBp = (Number(long.entryPriceRaw - short.entryPriceRaw) / Number(short.entryPriceRaw)) * 1e4
    log('RESULT', `${inst.symbol} ${gapS === 0 ? 'same block' : `${gapS}s apart`} | entry gap ${gap.toFixed(2)} (${gapBp.toFixed(1)}bp) | ` +
      `filled after ${fills[0]!.waitedS}s / ${fills[1]!.waitedS}s | queue at send ${queueAtSend}`)
    log('done', 'pair open. Close each leg yourself.')
  } else {
    log('WARN', `only ${long ? 'the long' : short ? 'the short' : 'neither leg'} filled; nothing will be closed for you.`)
  }
  return idle()
}

/** Stay up (the journal keeps logging), so the supervisor doesn't restart this and open another pair. */
function idle(): Promise<void> {
  log('idle', 'no more opens until the next start')
  setInterval(() => {}, 3_600_000)
  return new Promise(() => {})
}
