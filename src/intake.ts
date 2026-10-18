import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Hex } from 'viem'
import { AccountStream } from './account.ts'
import { getProtocolSummary, getTradingState } from './api.ts'
import { CONTRACTS, STATE_DIR } from './config.ts'
import { readMids } from './market.ts'
import { queueTriggerMove, sideHeadroomUsd } from './risk.ts'
import { makeClient, pct, usd } from './bot.ts'

// Read-only research process: samples how fast Papertrade's relayer works through intents and what the LP, OI and
// market looked like at the time, so intake-queue stalls can be matched to their cause. It holds no keys and never
// trades. Also follows the relayer's public queue (`pressure:current`) and every fill (`public:trades`). One JSON line per sample goes to <state dir>/intake/<date>.jsonl; a short line goes to the console.

const SAMPLE_MS = 10_000
const LOG_EVERY_MS = 60_000
const SLOW_PENDING_MS = 15_000
const MAX_LOG_RANGE = 500n // public HyperEVM RPC eth_getLogs limit (see watch.ts)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const errMsg = (err: unknown) => (err instanceof Error ? err.message.split('\n')[0] : String(err))
const ts = () => new Date().toISOString()
const STREAM_URL = 'wss://stream.papertrade.xyz/connection/websocket'

type Pressure = {
  pendingCount: number
  queuedIntents: number
  submittedIntents: number
  totalQueuedGas: number
  saturationPct: number
  blockGasLimit: number
  blockUsagePct: number[]
  papertradeShare: number[]
}
type Trade = { kind: string; notionalUsd: number; leverage: number; instrument: string; pnlUsd: number | null; positionId: number; exit: number | null }

/**
 * Papertrade's public stream (Centrifugo JSON protocol): `pressure:current` is the relayer's global intake queue
 * (intents queued for gas on HyperEVM's 3M-gas small blocks), `public:trades` is every fill. Reconnects on drop.
 */
export class PublicStream {
  pressure: Pressure | null = null
  maxPending = 0
  trades: Trade[] = []
  #ws: WebSocket | null = null
  #stopped = false

  start(): void {
    if (this.#stopped) return
    let id = 1
    const ws = new WebSocket(STREAM_URL, { headers: { Origin: 'https://exchange.papertrade.xyz' } } as never)
    this.#ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ id: id++, connect: { name: 'js' } }))
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\n').filter(Boolean)) {
        const m = JSON.parse(line)
        if (Object.keys(m).length === 0) ws.send('{}')
        else if (m.connect) for (const channel of ['pressure:current', 'public:trades']) ws.send(JSON.stringify({ id: id++, subscribe: { channel } }))
        else if (m.subscribe?.publications) for (const p of m.subscribe.publications) this.#onPressure(p.data)
        else if (m.push?.channel === 'pressure:current' && m.push.pub) this.#onPressure(m.push.pub.data)
        else if (m.push?.channel === 'public:trades' && m.push.pub) this.trades.push(...(m.push.pub.data as Trade[]))
      }
    }
    ws.onclose = () => {
      this.#ws = null
      if (!this.#stopped) setTimeout(() => this.start(), 5000)
    }
    ws.onerror = () => console.log(`${ts()} WARN  stream error; reconnecting`)
  }

  #onPressure(data: { snapshot?: Record<string, any> }): void {
    const s = data?.snapshot
    if (!s) return
    const blocks = (s.chain?.blocks ?? []) as Record<string, any>[]
    this.pressure = {
      pendingCount: s.pendingCount,
      queuedIntents: s.queuedIntents,
      submittedIntents: s.submittedIntents,
      totalQueuedGas: Number(s.totalQueuedGas),
      saturationPct: s.saturationPct,
      blockGasLimit: Number(s.blockGasLimit),
      blockUsagePct: blocks.map((b) => Math.round(b.usagePct)),
      papertradeShare: blocks.map((b) => Math.round((Number(b.papertradeGasUsed) / Number(b.gasUsed || 1)) * 100)),
    }
    this.maxPending = Math.max(this.maxPending, s.pendingCount)
  }

  /** Pressure plus the peak queue and the fills seen since the last call. */
  drain() {
    const out = { pressure: this.pressure, maxPending: this.maxPending, trades: this.trades }
    this.maxPending = this.pressure?.pendingCount ?? 0
    this.trades = []
    return out
  }

  stop(): void {
    this.#stopped = true
    this.#ws?.close()
  }
}

const median = (xs: number[]) => {
  if (!xs.length) return 0
  const a = [...xs].sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)]
}

export async function runIntakeMonitor(): Promise<void> {
  const client = makeClient()
  const dir = join(STATE_DIR, 'intake')
  mkdirSync(dir, { recursive: true })
  const write = (rec: Record<string, unknown>) =>
    appendFileSync(join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`), JSON.stringify(rec) + '\n')

  // Our own intents: the only ones whose submit-to-fill time we can see.
  const wallet = process.env.PT_WALLET_ADDRESS
  const stream = wallet ? new AccountStream(wallet) : null
  const pendingSince = new Map<Hex, number>()
  if (stream) {
    stream.onError = (err) => console.log(`${ts()} WARN  account stream reconnecting: ${errMsg(err)}`)
    stream.start()
  }

  const pub = new PublicStream()
  pub.start()

  let stopping = false
  process.once('SIGINT', () => (stopping = true))
  process.once('SIGTERM', () => (stopping = true))
  let fromBlock: bigint | null = null
  let prevVolume: number | null = null
  let prevMids = new Map<number, bigint>()
  let lastLog = 0
  console.log(`${ts()} INTAKE monitor started (sample ${SAMPLE_MS / 1000}s${wallet ? `, tracking intents of ${wallet}` : ''})`)

  while (!stopping) {
    const now = Date.now()
    try {
      const [trading, summary, head] = await Promise.all([getTradingState(), getProtocolSummary(), client.getBlockNumber()])
      const mids = await readMids(trading.instruments)

      // Relayer throughput: Exchange + BatchExecutor events and distinct relayer txs since the last sample.
      const logs: Record<string, number> = {}
      const txs = new Set<string>()
      if (fromBlock === null) fromBlock = head
      for (let start = fromBlock; start <= head; start += MAX_LOG_RANGE) {
        const end = start + MAX_LOG_RANGE - 1n < head ? start + MAX_LOG_RANGE - 1n : head
        for (const log of await client.getLogs({ address: [CONTRACTS.exchange, CONTRACTS.batchExecutor], fromBlock: start, toBlock: end })) {
          const t0 = log.topics[0]?.slice(0, 10) ?? 'none'
          logs[t0] = (logs[t0] ?? 0) + 1
          txs.add(log.transactionHash)
        }
      }
      const blocks = Number(head - fromBlock) + 1
      fromBlock = head + 1n

      const markets = trading.instruments.map((inst) => {
        const mid = mids.get(inst.id)!
        const prev = prevMids.get(inst.id)
        return {
          symbol: inst.symbol,
          mid: Number(mid) / Number(inst.priceScale),
          moveBp: prev ? (Number(mid - prev) / Number(prev)) * 1e4 : 0,
          roomLongUsd: sideHeadroomUsd(inst, true, trading.maxNetOpenInterestRaw, mid),
          roomShortUsd: sideHeadroomUsd(inst, false, trading.maxNetOpenInterestRaw, mid),
          // Base-asset units ×1e18, as strings (JSON has no bigint). The caps move every few minutes.
          longOiRaw: String(inst.longOiRaw),
          shortOiRaw: String(inst.shortOiRaw),
          longCapRaw: String(inst.longCapRaw),
          shortCapRaw: String(inst.shortCapRaw),
          openable: inst.openable,
        }
      })
      prevMids = mids
      const volumeDelta = prevVolume === null ? 0 : summary.volumeUsd - prevVolume
      prevVolume = summary.volumeUsd
      const trigger = queueTriggerMove(summary.lpUsd, trading.instruments.map((inst) => ({ inst, midRaw: mids.get(inst.id)! })))

      // Our intents: first-seen time, and wait time once they leave the pending set.
      const acct = stream?.state
      const cleared: { id: string; waitedS: number }[] = []
      if (acct) {
        for (const id of acct.pendingIntents) if (!pendingSince.has(id)) pendingSince.set(id, now)
        for (const [id, since] of pendingSince) {
          if (acct.pendingIntents.has(id)) continue
          pendingSince.delete(id)
          cleared.push({ id: id.slice(0, 10), waitedS: Math.round((now - since) / 1000) })
        }
      }
      const oldestPendingS = pendingSince.size ? Math.round((now - Math.min(...pendingSince.values())) / 1000) : 0

      const { pressure, maxPending, trades } = pub.drain()
      const opens = trades.filter((t) => t.kind === 'open').map((t) => t.notionalUsd)
      const closes = trades.filter((t) => t.kind !== 'open')
      const relayer = {
        pending: pressure?.pendingCount ?? null,
        maxPending,
        queued: pressure?.queuedIntents ?? null,
        submitted: pressure?.submittedIntents ?? null,
        queuedGas: pressure?.totalQueuedGas ?? null,
        queueBlocks: pressure ? Number((pressure.totalQueuedGas / pressure.blockGasLimit).toFixed(1)) : null,
        saturationPct: pressure?.saturationPct ?? null,
        blockUsagePct: pressure?.blockUsagePct ?? [],
        papertradeGasSharePct: pressure?.papertradeShare ?? [],
      }
      const fills = {
        opens: opens.length,
        closes: closes.length,
        liqs: closes.filter((t) => t.kind === 'liq').length,
        openNotionalMedian: Math.round(median(opens)),
        openNotionalMin: opens.length ? Math.round(Math.min(...opens)) : 0,
        opensUnder5k: opens.filter((n) => n < 5000).length,
        closedPnlUsd: Math.round(closes.reduce((a, t) => a + (t.pnlUsd ?? 0), 0)),
      }

      const rec = {
        t: new Date(now).toISOString(),
        head: Number(head),
        indexedBlock: trading.indexedThroughBlock,
        indexLagBlocks: Number(head) - trading.indexedThroughBlock,
        walletIndexLagS: acct ? Math.round(now / 1000 - acct.indexedThroughTimestamp) : null,
        blocks,
        relayerTxs: txs.size,
        events: logs,
        volumeUsd: Math.round(volumeDelta),
        lpUsd: Math.round(summary.lpUsd),
        lpCapUsd: Math.round(summary.capUsd),
        payoutQueueUsd: Math.round(summary.queueUsd),
        queueTrigger: Number(trigger.toFixed(4)),
        maxNetOiUsd: Number(trading.maxNetOpenInterestRaw) / 1e18,
        pausedActions: trading.pausedActions,
        tradingPaused: trading.tradingPaused,
        relayer,
        fills,
        markets,
        ours: { pending: pendingSince.size, oldestPendingS, cleared },
      }
      write(rec)

      const congested = (relayer.queueBlocks ?? 0) >= 10
      const slow = congested || oldestPendingS * 1000 >= SLOW_PENDING_MS || cleared.some((c) => c.waitedS * 1000 >= SLOW_PENDING_MS)
      if (slow || now - lastLog >= LOG_EVERY_MS) {
        lastLog = now
        console.log(
          `${ts()} INTAKE ${slow ? 'SLOW ' : ''}queue ${relayer.pending ?? '?'} intents (peak ${maxPending}, ~${relayer.queueBlocks ?? '?'} blocks of gas) | ` +
            `fills ${fills.opens} open (median ${usd(fills.openNotionalMedian, 0)}, ${fills.opensUnder5k} <$5k) / ${fills.closes} close | ` +
            `lag ${rec.indexLagBlocks} blk | ${rec.relayerTxs} relayer txs / ${blocks} blk | ` +
            `vol ${usd(volumeDelta / 1e6, 1)}M | LP ${usd(summary.lpUsd / 1e6)}M, trigger ${pct(trigger, 1)} | ` +
            markets.map((m) => `${m.symbol} ${m.mid.toFixed(2)} (${m.moveBp.toFixed(1)}bp) room L ${usd(m.roomLongUsd / 1e6, 1)}M / S ${usd(m.roomShortUsd / 1e6, 1)}M | `).join('') +
            `ours: ${pendingSince.size} pending${oldestPendingS ? `, oldest ${oldestPendingS}s` : ''}` +
            (cleared.length ? `, cleared ${cleared.map((c) => `${c.id} after ${c.waitedS}s`).join(', ')}` : ''),
        )
      }
    } catch (err) {
      console.log(`${ts()} WARN  intake sample failed: ${errMsg(err)}`)
    }
    if (!stopping) await sleep(Math.max(0, SAMPLE_MS - (Date.now() - now)))
  }
  stream?.stop()
  pub.stop()
}
