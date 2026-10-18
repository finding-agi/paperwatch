import { createPublicClient, http, type Address, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { AccountStream } from './account.ts'
import { RelayerError, getProtocolSummary, getTradingState, type Instrument, type ProtocolSummary, type TradingState } from './api.ts'
import { INTENT_TTL_SEC, RPC_URL, bustSlack, legMarginRaw, loadStrategyConfig, maxAdverseMove, type StrategyConfig } from './config.ts'
import { deadlineFromNow } from './eip712.ts'
import { DryRunExecutor, LiveExecutor, type ClosedLeg, type Executor } from './executor.ts'
import { impactParams, mintRate, pairCycle } from './fees.ts'
import { readMids } from './market.ts'
import { queueTriggerMove, sideHeadroomUsd } from './risk.ts'
import { NonceSource, loadSessionKey, loadState, saveState, today, type BotState } from './state.ts'
import { adverseMove, attach, decide, isLive, reconcile, type Decision, type LegRef, type MarketView, type Pair } from './strategy.ts'
import { AdminWatcher } from './watch.ts'
import { writeHeartbeat } from './heartbeat.ts'

export const log = (tag: string, msg: string) => console.log(`${new Date().toISOString()} ${tag.padEnd(6)} ${msg}`)
export const pct = (x: number, digits = 2) => `${(x * 100).toFixed(digits)}%`
export const usd = (x: number, digits = 2) =>
  `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
export const price = (raw: bigint, inst: Instrument) => (Number(raw) / Number(inst.priceScale)).toFixed(String(inst.priceScale).length - 1)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// viem errors carry a multi-line message; the first line (shortMessage) is enough for the log.
const errMsg = (err: unknown) =>
  err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message.split('\n')[0]) : String(err)

export const makeClient = (): PublicClient => createPublicClient({ transport: http(RPC_URL, { timeout: 10_000 }) })

export function requireWalletAddress(): Address {
  const wallet = process.env.PT_WALLET_ADDRESS
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('set PT_WALLET_ADDRESS in .env')
  return wallet as Address
}

function validate(cfg: StrategyConfig, inst: Instrument, trading: TradingState): void {
  if (cfg.leverage > inst.maxLeverage) throw new Error(`leverage ${cfg.leverage}x exceeds ${inst.symbol} max ${inst.maxLeverage}x`)
  const slack = bustSlack(cfg, Number(inst.bustBufferRaw) / 1e18)
  if (slack < cfg.minBustDistance) {
    throw new Error(
      `at ${cfg.leverage}x a leg is only ${pct(slack)} from bust when it is ${pct(maxAdverseMove(cfg))} against entry ` +
        `(need ${pct(cfg.minBustDistance)}); lower PT_LEVERAGE or ${cfg.mode === 'spread' ? 'PT_TAKE_MOVE' : 'PT_RESET_MOVE'}`,
    )
  }
  const margin = legMarginRaw(cfg)
  if (margin < trading.minimumTradeSizeRaw) throw new Error('margin per leg is below the protocol minimum')
  if (margin * BigInt(cfg.leverage) < trading.minimumOpenNotionalRaw) throw new Error('notional per leg is below the protocol minimum')
  if (margin * BigInt(cfg.leverage) > inst.maxPositionNotionalRaw) throw new Error('notional per leg exceeds the per-position max')
}

function rollDay(state: BotState): void {
  const d = today()
  if (state.day.date !== d) state.day = { date: d, costUsd: 0, paperMinted: 0, legsClosed: 0 }
}

export async function runBot(opts: { live: boolean }): Promise<void> {
  const cfg = loadStrategyConfig()
  const mode = opts.live ? 'live' : 'dry'
  const client = makeClient()
  let trading = await getTradingState()
  let summary: ProtocolSummary = await getProtocolSummary()
  const home = trading.instruments.find((i) => i.symbol === cfg.instrument)
  if (!home) throw new Error(`instrument ${cfg.instrument} not listed`)
  validate(cfg, home, trading)

  const state = loadState(mode)
  const persist = () => saveState(mode, state)
  const impact = impactParams(home)
  const rate = () => mintRate(summary)
  const marginRaw = legMarginRaw(cfg)

  let executor: Executor
  if (opts.live) {
    const wallet = requireWalletAddress()
    const key = loadSessionKey()
    if (!key || key.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('no session key for this wallet; run `npm run session`')
    const stream = new AccountStream(wallet)
    stream.onError = (err) => log('stream', `reconnecting: ${errMsg(err)}`)
    stream.start()
    const acct = await stream.ready()
    const expiry = acct.sessionKeys.get(key.address.toLowerCase())
    if (!expiry || Number(expiry) * 1000 < Date.now() + 3_600_000) {
      stream.stop()
      throw new Error('session key is not registered or expires within an hour; run `npm run session`')
    }
    const nonces = new NonceSource(state, persist)
    await nonces.ensureUnused(client, wallet)
    executor = new LiveExecutor(wallet, privateKeyToAccount(key.privateKey), stream, nonces)
  } else {
    executor = new DryRunExecutor(home, impact, rate)
    state.pairs = [] // simulated positions don't survive a restart
  }

  // In spread mode the haircut is paid on the take, which over a cycle matches the restrike losses it offsets.
  const econ = pairCycle(cfg.mode === 'spread' ? cfg.takeMove : cfg.resetMove, impact, rate())
  const rule = cfg.mode === 'spread' ? `spread: restrike ${pct(cfg.restrikeMove)}, take ${pct(cfg.takeMove)}` : `reset ${pct(cfg.resetMove)}`
  log('start', `${mode.toUpperCase()} ${cfg.instrument} | ${usd(cfg.legNotionalUsd, 0)}/leg at ${cfg.leverage}x (margin ${usd(Number(marginRaw) / 1e18)}) | ${rule} | max ${cfg.maxPairs} pair(s) | budget ${usd(cfg.maxDailyCostUsd, 0)}/day`)
  log('econ', `mint ${rate().toFixed(2)} PAPER/$ | expected haircut ${pct(econ.costPerLossUsd, 1)} of each loss | ~${usd(econ.costPerPaper, 4)}/PAPER`)
  if (opts.live) {
    log('LIVE', 'submitting real intents in 5s (Ctrl-C to abort)')
    await sleep(5000)
  }

  let stopping = false
  const stop = () => {
    if (!stopping) log('stop', 'finishing this tick…')
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)

  const watcher = new AdminWatcher(client, state.admin)
  let adminAlert = false
  let lastTrading = Date.now()
  let lastSummary = Date.now()
  let lastAdmin = 0
  let lastStatus = 0
  let cooldownUntil = 0
  let idleReason = ''
  let lastError = ''
  let mid = 0n
  const beat = (stopped: boolean) =>
    writeHeartbeat({
      ts: Date.now(),
      pid: process.pid,
      mode,
      instrument: home.symbol,
      mid: mid.toString(),
      pairs: state.pairs.length,
      legIds: state.pairs.flatMap((p) => p.legs.filter(isLive).map((l) => l.positionId!)),
      idleReason,
      lastError,
      stopped,
    })

  const coolDownIfLimited = (err: unknown) => {
    if (err instanceof RelayerError && err.code === 'rate_limited') cooldownUntil = Date.now() + 15_000
  }

  const record = (closed: ClosedLeg[]) => {
    const owned = new Set(state.pairs.flatMap((p) => p.legs.map((l) => l.positionId).filter((id) => id !== undefined)))
    for (const c of closed) {
      if (!owned.has(c.positionId)) continue
      state.day.costUsd -= c.netPnlUsd
      state.day.paperMinted += c.paperMinted
      state.day.legsClosed++
      state.totals.costUsd -= c.netPnlUsd
      state.totals.paperMinted += c.paperMinted
      state.totals.legsClosed++
      if (c.liquidated) state.totals.liquidations++
      log(c.liquidated ? 'LIQ' : 'fill', `#${c.positionId} pnl ${usd(c.netPnlUsd)}${c.paperMinted ? ` | +${c.paperMinted.toFixed(0)} PAPER` : ''}`)
    }
  }

  const openPair = async (firstIsLong: boolean, inst: Instrument) => {
    const pair: Pair = { id: `p${Date.now()}`, instrumentId: inst.id, status: 'opening', legs: [], createdAtMs: Date.now() }
    state.pairs.push(pair)
    persist()
    // Submit both legs at once so the relayer batches them into the same block and they share an entry price.
    // A rejected or unfilled leg leaves the pair broken, and the next tick closes whatever did fill.
    const sides = [firstIsLong, !firstIsLong]
    const submitted = await Promise.allSettled(
      sides.map((isLong) => executor.submitOpen({ inst, isLong, marginRaw, leverage: cfg.leverage }, mid)),
    )
    const legs: LegRef[] = []
    submitted.forEach((r, i) => {
      const side = sides[i] ? 'long' : 'short'
      if (r.status === 'rejected') {
        log('open', `${pair.id} ${side} leg rejected: ${errMsg(r.reason)}`)
        coolDownIfLimited(r.reason)
        pair.status = 'broken'
        return
      }
      const leg: LegRef = { intentId: r.value.intentId, isLong: sides[i], marginRaw, leverage: cfg.leverage, deadline: r.value.deadline }
      legs.push(leg)
      pair.legs.push(leg)
    })
    persist()
    const fills = await Promise.all(legs.map((leg) => executor.waitForPosition(leg.intentId, cfg.openWaitMs)))
    fills.forEach((pos, i) => {
      const leg = legs[i]
      const side = leg.isLong ? 'long' : 'short'
      if (!pos) {
        log('open', `${pair.id} ${side} leg not filled within ${cfg.openWaitMs / 1000}s; unwinding`)
        pair.status = 'broken'
        return
      }
      attach(leg, pos)
      log('open', `${pair.id} ${side} #${pos.positionId} @ ${price(pos.entryPriceRaw, inst)} (bust ${price(pos.bustPriceRaw, inst)})`)
    })
    if (pair.status === 'opening') pair.status = 'open'
  }

  const closePair = async (d: Extract<Decision, { kind: 'close' }>) => {
    const pair = state.pairs.find((p) => p.id === d.pairId)
    if (!pair) return
    try {
      await executor.submitClose(d.positionIds, mid)
      pair.status = 'closing'
      pair.closeRequestedAtMs = Date.now()
      pair.closeReason = d.reason
      log('close', `${pair.id} ${d.reason}: ${d.positionIds.map((id) => `#${id}`).join(' ')}`)
    } catch (err) {
      // The relayer already holds a close for these legs (fills can take over a minute): keep waiting on it.
      if (err instanceof RelayerError && err.reason === 'noOpenPositions') {
        pair.status = 'closing'
        pair.closeRequestedAtMs = Date.now()
        return
      }
      log('close', `${pair.id} close failed: ${errMsg(err)}`)
      coolDownIfLimited(err)
    }
  }

  // Spread mode: close one losing leg on its own. Its side reopens on a later tick, once this close has landed, so the
  // pair stays hedged while the close waits in the relayer (that can take minutes; an open takes seconds).
  const restrikeLeg = async (d: Extract<Decision, { kind: 'restrike' }>) => {
    const pair = state.pairs.find((p) => p.id === d.pairId)
    const leg = pair?.legs.find((l) => l.positionId === d.positionId)
    if (!pair || !leg) return
    const side = leg.isLong ? 'long' : 'short'
    // Set before sending: if the send times out but the relayer took it, the leg's disappearance still reads as ours.
    leg.retiring = true
    try {
      const [sent] = await executor.submitClose([d.positionId], mid)
      leg.closeIntentId = sent.intentId
      leg.closeDeadline = sent.deadline
      log('close', `${pair.id} restrike ${side} #${d.positionId} at ${pct(adverseMove(leg, mid))} against`)
    } catch (err) {
      // The relayer already holds a close for this leg: wait on it, up to an intent's lifetime.
      if (err instanceof RelayerError && err.reason === 'noOpenPositions') {
        leg.closeDeadline = deadlineFromNow(INTENT_TTL_SEC)
        return
      }
      log('close', `${pair.id} restrike ${side} close failed: ${errMsg(err)}`)
      coolDownIfLimited(err)
    }
  }

  // Spread mode: put a restruck side back. As in openPair, a rejected or unfilled leg breaks the pair and the next
  // tick closes what is left.
  const reopenLeg = async (d: Extract<Decision, { kind: 'reopen' }>, inst: Instrument) => {
    const pair = state.pairs.find((p) => p.id === d.pairId)
    if (!pair) return
    const side = d.isLong ? 'long' : 'short'
    let leg: LegRef
    try {
      const sent = await executor.submitOpen({ inst, isLong: d.isLong, marginRaw, leverage: cfg.leverage }, mid)
      leg = { intentId: sent.intentId, isLong: d.isLong, marginRaw, leverage: cfg.leverage, deadline: sent.deadline }
    } catch (err) {
      log('open', `${pair.id} ${side} reopen rejected: ${errMsg(err)}`)
      coolDownIfLimited(err)
      pair.status = 'broken'
      return
    }
    pair.legs.push(leg)
    persist()
    const pos = await executor.waitForPosition(leg.intentId, cfg.openWaitMs)
    if (!pos) {
      log('open', `${pair.id} ${side} reopen not filled within ${cfg.openWaitMs / 1000}s; unwinding`)
      pair.status = 'broken'
      return
    }
    attach(leg, pos)
    log('open', `${pair.id} ${side} #${pos.positionId} @ ${price(pos.entryPriceRaw, inst)} (bust ${price(pos.bustPriceRaw, inst)}) reopened`)
  }

  while (!stopping) {
    const now = Date.now()
    try {
      if (now - lastTrading >= 5000) {
        trading = await getTradingState()
        lastTrading = now
      }
      if (now - lastSummary >= 15_000) {
        summary = await getProtocolSummary()
        lastSummary = now
      }
      if (now - lastAdmin >= 60_000) {
        lastAdmin = now
        try {
          for (const a of await watcher.check()) {
            log('ADMIN', `${a.message}${a.pause ? ' -> pausing new opens' : ''}`)
            if (a.pause) adminAlert = true
          }
        } catch (err) {
          log('error', `admin watcher: ${errMsg(err)}`)
        }
      }

      const inst = trading.instruments.find((i) => i.id === home.id)!
      const midById = await readMids(trading.instruments)
      const mids = trading.instruments.map((i) => ({ inst: i, midRaw: midById.get(i.id)! }))
      mid = midById.get(inst.id)!
      executor.onPrice(mid)
      rollDay(state)
      record(executor.drainClosed())
      state.pairs = reconcile(state.pairs, executor.positions(), executor.failedIntents(), now, cfg)

      const market: MarketView = {
        midRaw: mid,
        openable: inst.openable && !trading.tradingPaused && !trading.pausedActions.includes('openPosition'),
        headroomLongUsd: sideHeadroomUsd(inst, true, trading.maxNetOpenInterestRaw, mid),
        headroomShortUsd: sideHeadroomUsd(inst, false, trading.maxNetOpenInterestRaw, mid),
        queueUsd: summary.queueUsd,
        queueTriggerMove: queueTriggerMove(summary.lpUsd, mids),
        adminAlert,
        availableUsd: executor.availableUsd(),
      }

      if (now >= cooldownUntil) {
        for (const d of decide(state.pairs, market, cfg, state.day.costUsd)) {
          if (d.kind === 'idle') {
            if (d.reason !== idleReason) log('idle', `not opening: ${d.reason}`)
            idleReason = d.reason
          } else {
            idleReason = ''
            if (d.kind === 'close') await closePair(d)
            else if (d.kind === 'restrike') await restrikeLeg(d)
            else if (d.kind === 'reopen') await reopenLeg(d, inst)
            else await openPair(d.firstIsLong, inst)
          }
        }
      }
      persist()

      if (now - lastStatus >= 30_000) {
        lastStatus = now
        const pairs = state.pairs
          .map((p) => {
            const legs = p.legs.filter(isLive).map((l) => `${l.isLong ? 'L' : 'S'} ${pct(-adverseMove(l, mid))}`)
            return `${p.id} ${p.status}${legs.length ? ` [${legs.join(', ')}]` : ''}`
          })
          .join('; ')
        const perPaper = state.day.paperMinted > 0 ? ` (${usd(state.day.costUsd / state.day.paperMinted, 4)}/PAPER)` : ''
        log(
          'status',
          `${inst.symbol} ${price(mid, inst)} | ${pairs || 'no pairs'} | today ${usd(state.day.costUsd)} for ${state.day.paperMinted.toFixed(0)} PAPER${perPaper} | ` +
            `rate ${rate().toFixed(2)}/$ | LP ${usd(summary.lpUsd / 1e6)}M, queue trigger ${pct(market.queueTriggerMove, 1)} | ` +
            `room L ${usd(market.headroomLongUsd / 1e6, 1)}M / S ${usd(market.headroomShortUsd / 1e6, 1)}M`,
        )
      }
      lastError = ''
    } catch (err) {
      coolDownIfLimited(err)
      lastError = errMsg(err)
      log('error', lastError)
    }
    beat(false)
    if (!stopping) await sleep(Math.max(0, cfg.tickMs - (Date.now() - now)))
  }

  const open = state.pairs.flatMap((p) => p.legs.filter(isLive).map((l) => l.positionId!))
  if (opts.live && cfg.closeOnExit && open.length) {
    log('stop', `closing ${open.length} leg(s)`)
    try {
      await executor.submitClose(open, mid)
      for (let i = 0; i < 60 && open.some((id) => executor.positions().has(id)); i++) await sleep(1000)
      record(executor.drainClosed())
      const left = open.filter((id) => executor.positions().has(id))
      if (left.length) log('error', `${left.length} leg(s) still open after 60s; run \`npm run close-all\``)
    } catch (err) {
      log('error', `close on exit failed: ${errMsg(err)}; run \`npm run close-all\``)
    }
  } else if (opts.live && open.length) {
    log('stop', `${open.length} leg(s) left open (PT_CLOSE_ON_EXIT=0)`)
  }
  persist()
  beat(true)
  executor.stop()
  const t = state.totals
  log(
    'done',
    `lifetime ${mode}: ${t.legsClosed} legs closed, ${t.liquidations} liquidations, cost ${usd(t.costUsd)}, ${t.paperMinted.toFixed(0)} PAPER` +
      (t.paperMinted > 0 ? ` (${usd(t.costUsd / t.paperMinted, 4)}/PAPER)` : ''),
  )
}
