import { privateKeyToAccount } from 'viem/accounts'
import { AccountStream, type AccountState } from './account.ts'
import { Alerter } from './alerts.ts'
import { getProtocolSummary, getTradingState, type Instrument } from './api.ts'
import { loadStrategyConfig } from './config.ts'
import { LiveExecutor } from './executor.ts'
import { mintRate } from './fees.ts'
import { readHeartbeat } from './heartbeat.ts'
import { readMids } from './market.ts'
import { queueTriggerMove, sideHeadroomUsd } from './risk.ts'
import { makeClient, pct, price, requireWalletAddress, usd } from './bot.ts'
import { NonceSource, loadSessionKey, loadState, saveState } from './state.ts'
import { AdminWatcher } from './watch.ts'

const TICK_MS = 10_000
const HEARTBEAT_STALE_MS = 60_000
const SUMMARY_EVERY_MS = 30 * 60_000
const INTAKE_LOG_AFTER_MS = 15_000 // opens normally fill in 2-4s
const INTAKE_LOG_EVERY_MS = 30_000
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (err: unknown) =>
  err instanceof Error ? ((err as { shortMessage?: string }).shortMessage ?? err.message.split('\n')[0]) : String(err)

/** Net long-minus-short USD notional per instrument across every open position on the account. */
function netNotional(acct: AccountState, instruments: Instrument[], mids: Map<number, bigint>) {
  const out = new Map<number, number>()
  for (const p of acct.positions.values()) {
    const notional = (Number(p.marginRaw) / 1e18) * p.leverage
    out.set(p.instrumentId, (out.get(p.instrumentId) ?? 0) + (p.isLong ? notional : -notional))
  }
  return [...out].map(([id, net]) => ({ inst: instruments.find((i) => i.id === id), net, mid: mids.get(id) }))
}

/**
 * Independent safety process for the live bot. Watches the bot's heartbeat, the account, the protocol and admin
 * activity, and alerts on trouble. If the bot dies with legs open, it closes those legs with the session key.
 */
export async function runWatcher(): Promise<void> {
  const cfg = loadStrategyConfig()
  const wallet = requireWalletAddress()
  const autoCloseMs = Number(process.env.PT_WATCH_AUTOCLOSE_SEC ?? 120) * 1000
  const botMode = process.env.PT_MODE === 'live' ? 'live' : 'dry'
  const client = makeClient()
  const alerter = new Alerter()
  const wstate = loadState('watcher') // own nonce space and admin cursor, separate from the bot's
  const persist = () => saveState('watcher', wstate)
  const admin = new AdminWatcher(client, wstate.admin)
  const key = loadSessionKey()
  const sessionOk = key?.wallet.toLowerCase() === wallet.toLowerCase()

  const stream = new AccountStream(wallet)
  stream.onError = (err) => console.log(`${new Date().toISOString()} WARN  account stream reconnecting: ${errMsg(err)}`)
  stream.start()
  await stream.ready()
  const executor = sessionOk ? new LiveExecutor(wallet, privateKeyToAccount(key!.privateKey), stream, new NonceSource(wstate, persist)) : null

  await alerter.send('info', `watcher started for ${wallet}${sessionOk ? '' : ' (no session key: alerts only, cannot auto-close)'}`)
  if (autoCloseMs === 0) await alerter.send('info', 'auto-close disabled (PT_WATCH_AUTOCLOSE_SEC=0)')

  let stopping = false
  process.once('SIGINT', () => (stopping = true))
  process.once('SIGTERM', () => (stopping = true))
  let lastSummary = 0
  let lastAdmin = 0
  let autoClosedFor = 0 // heartbeat ts we already acted on
  let unhedgedTicks = 0
  let lastIndexedBlock = -1
  let lastIndexAdvanceMs = Date.now()
  // Intake queue research: when our intents sit unfilled, record what the market and LP looked like.
  const pendingSince = new Map<string, { ms: number; mid: bigint | undefined }>()
  let lastIntakeLog = 0
  let lastIntakeParams = ''

  while (!stopping) {
    const now = Date.now()
    try {
      const [trading, summary] = await Promise.all([getTradingState(), getProtocolSummary()])
      // Papertrade removed its public health endpoint; a stalled indexer is the visible symptom of an outage.
      if (trading.indexedThroughBlock !== lastIndexedBlock) {
        lastIndexedBlock = trading.indexedThroughBlock
        lastIndexAdvanceMs = now
      }
      const mids = await readMids(trading.instruments)
      const acct = stream.state
      const hb = readHeartbeat(botMode)
      const botState = loadState(botMode)

      // Bot liveness. A clean stop is reported but never auto-closed.
      const hbAge = hb ? now - hb.ts : Infinity
      const crashed = !!hb && !hb.stopped && hbAge > HEARTBEAT_STALE_MS
      const ownLegs = (hb?.legIds ?? []).filter((id) => acct?.positions.has(id))
      const downFor = alerter.set('bot-down', crashed, ownLegs.length ? 'crit' : 'warn',
        `${botMode} bot heartbeat is ${Math.round(hbAge / 1000)}s old${ownLegs.length ? ` with ${ownLegs.length} leg(s) open` : ''}`)
      alerter.set('bot-stopped-with-legs', !!hb?.stopped && ownLegs.length > 0, 'warn',
        `bot was stopped with ${ownLegs.length} leg(s) left open; nothing is managing them`)
      alerter.set('bot-error', !!hb && !crashed && hb.lastError !== '', 'warn', `bot error: ${hb?.lastError}`)

      if (crashed && ownLegs.length && autoCloseMs > 0 && downFor >= autoCloseMs - HEARTBEAT_STALE_MS && autoClosedFor !== hb!.ts) {
        autoClosedFor = hb!.ts
        if (!executor) await alerter.send('crit', 'cannot auto-close: no session key for this wallet')
        else {
          try {
            await executor.submitClose(ownLegs)
            await alerter.send('crit', `bot down: submitted close for its ${ownLegs.length} leg(s) (${ownLegs.map((id) => `#${id}`).join(' ')})`)
          } catch (err) {
            await alerter.send('crit', `auto-close failed: ${errMsg(err)}; run npm run close-all`)
          }
        }
      }

      if (acct) {
        // Delta: a leg left alone is a naked leveraged bet. Ignore single ticks (pairs open one leg at a time).
        const worst = netNotional(acct, trading.instruments, mids).sort((a, b) => Math.abs(b.net) - Math.abs(a.net))[0]
        const unhedged = !!worst && Math.abs(worst.net) >= cfg.legNotionalUsd * 0.5
        unhedgedTicks = unhedged ? unhedgedTicks + 1 : 0
        alerter.set('unhedged', unhedgedTicks >= 2, 'crit',
          `account is net ${worst && worst.net > 0 ? 'long' : 'short'} ${usd(Math.abs(worst?.net ?? 0), 0)} on ${worst?.inst?.symbol ?? '?'}`)

        let closest: { d: number; label: string } | null = null
        for (const p of acct.positions.values()) {
          const inst = trading.instruments.find((i) => i.id === p.instrumentId)
          const mid = mids.get(p.instrumentId)
          if (!inst || !mid) continue
          const d = p.isLong ? Number(mid - p.bustPriceRaw) / Number(mid) : Number(p.bustPriceRaw - mid) / Number(mid)
          if (!closest || d < closest.d) closest = { d, label: `#${p.positionId} ${inst.symbol} ${p.isLong ? 'long' : 'short'} bust ${price(p.bustPriceRaw, inst)}` }
        }
        alerter.set('near-bust', !!closest && closest.d < cfg.minBustDistance, 'crit', `${closest?.label} is ${pct(closest?.d ?? 0)} from liquidation`)

        const expiry = key && sessionOk ? acct.sessionKeys.get(key.address.toLowerCase()) : undefined
        const daysLeft = expiry ? (Number(expiry) * 1000 - now) / 86_400_000 : 0
        alerter.set('session-expiring', sessionOk && daysLeft < 3, 'warn',
          expiry ? `bot session key expires in ${daysLeft.toFixed(1)} days; run npm run session` : 'bot session key is not registered')
      }

      // Intake queue. Log how long our intents wait and the LP/OI/price context, to see what the queue tracks.
      const home0 = trading.instruments.find((i) => i.symbol === cfg.instrument)
      const homeMid = home0 ? mids.get(home0.id) : undefined
      const intakeParams = `maxNetOI ${usd(Number(trading.maxNetOpenInterestRaw) / 1e24, 0)}M, paused [${trading.pausedActions.join(',')}]`
      if (intakeParams !== lastIntakeParams) {
        if (lastIntakeParams) console.log(`${new Date().toISOString()} INTAKE params changed: ${lastIntakeParams} -> ${intakeParams}`)
        lastIntakeParams = intakeParams
      }
      if (acct && home0 && homeMid) {
        const ctx = () => {
          const roomL = sideHeadroomUsd(home0, true, trading.maxNetOpenInterestRaw, homeMid)
          const roomS = sideHeadroomUsd(home0, false, trading.maxNetOpenInterestRaw, homeMid)
          const lag = Math.round(now / 1000 - acct.indexedThroughTimestamp)
          return `LP ${usd(summary.lpUsd / 1e6)}M (cap ${usd(summary.capUsd / 1e6)}M), queue ${usd(summary.queueUsd / 1e6)}M | ` +
            `room L ${usd(roomL / 1e6, 1)}M / S ${usd(roomS / 1e6, 1)}M | ${intakeParams} | wallet index lag ${lag}s`
        }
        for (const id of acct.pendingIntents) if (!pendingSince.has(id)) pendingSince.set(id, { ms: now, mid: homeMid })
        for (const [id, p] of pendingSince) {
          if (acct.pendingIntents.has(id as `0x${string}`)) continue
          pendingSince.delete(id)
          const waited = now - p.ms
          if (waited >= INTAKE_LOG_AFTER_MS) {
            const move = p.mid ? Number(homeMid - p.mid) / Number(p.mid) : 0
            console.log(`${new Date().toISOString()} INTAKE cleared ${id.slice(0, 10)} after ~${Math.round(waited / 1000)}s, ` +
              `${cfg.instrument} moved ${pct(move, 2)} meanwhile | ${ctx()}`)
          }
        }
        const oldest = Math.min(...[...pendingSince.values()].map((p) => p.ms), now)
        if (now - oldest >= INTAKE_LOG_AFTER_MS && now - lastIntakeLog >= INTAKE_LOG_EVERY_MS) {
          lastIntakeLog = now
          console.log(`${new Date().toISOString()} INTAKE ${pendingSince.size} intent(s) pending, oldest ${Math.round((now - oldest) / 1000)}s | ` +
            `${cfg.instrument} ${price(homeMid, home0)} | ${ctx()}`)
        }
      }

      // Protocol.
      const trigger = queueTriggerMove(summary.lpUsd, trading.instruments.map((inst) => ({ inst, midRaw: mids.get(inst.id)! })))
      alerter.set('queue-active', summary.queueUsd > 0, 'crit', `payout queue is active (${usd(summary.queueUsd, 0)} owed); winning legs will be queued`)
      alerter.set('queue-near', summary.queueUsd === 0 && trigger < cfg.queueGuardMove, 'warn',
        `a ~${pct(trigger, 1)} move would empty the LP (${usd(summary.lpUsd / 1e6)}M); bot is flattening`)
      alerter.set('indexer-stalled', now - lastIndexAdvanceMs > 120_000, 'crit',
        `Papertrade's indexer hasn't advanced past block ${lastIndexedBlock} in ${Math.round((now - lastIndexAdvanceMs) / 1000)}s; the relayer is likely down`)
      const home = trading.instruments.find((i) => i.symbol === cfg.instrument)
      alerter.set('market-closed', trading.tradingPaused || !home?.openable, 'warn', `${cfg.instrument} is not open for new positions`)

      if (now - lastAdmin >= 60_000) {
        lastAdmin = now
        try {
          for (const a of await admin.check()) await alerter.send(a.pause ? 'crit' : 'info', `admin activity: ${a.message}`)
          persist()
        } catch (err) {
          console.log(`${new Date().toISOString()} WARN  admin check failed: ${errMsg(err)}`)
        }
      }

      if (now - lastSummary >= SUMMARY_EVERY_MS) {
        lastSummary = now
        const d = botState.day
        const perPaper = d.paperMinted > 0 ? ` (${usd(d.costUsd / d.paperMinted, 4)}/PAPER)` : ''
        const bot = !hb ? 'never run' : hb.stopped ? 'stopped' : crashed ? 'DOWN' : `up, ${hb.pairs} pair(s)${hb.idleReason ? `, idle: ${hb.idleReason}` : ''}`
        await alerter.send('info',
          `summary | bot ${bot} | today ${usd(d.costUsd)} for ${d.paperMinted.toFixed(0)} PAPER${perPaper} | ` +
            `staked ${acct ? (Number(acct.paperStaked) / 1e18).toFixed(0) : '?'} PAPER | rate ${mintRate(summary).toFixed(2)}/$ | ` +
            `LP ${usd(summary.lpUsd / 1e6)}M, queue trigger ${pct(trigger, 1)}`)
      }
      alerter.set('watcher-error', false, 'warn', '')
    } catch (err) {
      alerter.set('watcher-error', true, 'warn', `watcher check failed: ${errMsg(err)}`)
    }
    if (!stopping) await sleep(Math.max(0, TICK_MS - (Date.now() - now)))
  }
  stream.stop()
  persist()
}
