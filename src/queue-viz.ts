import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { getTradingState } from './api.ts'
import { readMids } from './market.ts'
import { sideHeadroomUsd } from './risk.ts'
import { baseHeaders, servePage, serveSiteJs } from './site.ts'

// Live view of Papertrade's relayer queue: locally with `npm run queue`, or as its own Railway service with
// PT_PROCESS=queue (no volume, no keys). Relays the public stream's `pressure:current` (global intake queue
// plus the last few HyperEVM blocks) and every fill from `public:trades` to src/queue-viz.html over server-sent
// events, along with each market's OI, cap and room (polled from /state/trading) and live mids from Hyperliquid's
// best bid/offer. The stream drops browser connections from any origin but exchange.papertrade.xyz, so the page
// can't subscribe itself. Read-only: no keys, never trades.

// Railway sets PORT and needs every interface; locally the page stays on localhost.
const PORT = Number(process.env.PORT ?? process.env.PT_QUEUE_VIEW_PORT ?? 8787)
const HOST = process.env.PORT ? '0.0.0.0' : '127.0.0.1'
const STREAM_URL = 'wss://stream.papertrade.xyz/connection/websocket'
const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws'
const MID_SEND_MS = 250
const HISTORY = 1500 // replayed to a new page: ~6 min of pushes at 2-4/s, plus OI polls
const OI_POLL_MS = 5000
const ts = () => new Date().toISOString()

type Block = { n: number; t: number; gas: number; pt: number; limit: number; kind: string; txs: number }
type Fill = { seq: number; t: number; sym: string; long: boolean; kind: string; margin: number; lev: number; notional: number; wait?: number | null }

const WAIT_LOOKBACK_BLOCKS = 1200 // 20 min of 1 s blocks
const WAIT_RESOLVE_MS = 15_000 // send a fill without an estimate if its block hasn't shown up by then

/**
 * First-come-first-served wait estimates. The feed says when a fill landed but not when its intent was sent, so this
 * asks how long an intent landing in that block would have waited if the queue were strictly first come, first
 * served: walk back block by block, adding up the gas Papertrade got in each, until it covers the gas that was
 * already ahead in the queue just before that block. Every fill in a block gets the same estimate.
 */
export class WaitEstimator {
  #blocks = new Map<number, { t: number; pt: number }>() // block number -> time and Papertrade gas
  #snaps: { t: number; ahead: number }[] = [] // gas ahead of a new intent (queued + sent), over time

  record(snapshot: ReturnType<typeof condense>): void {
    this.#snaps.push({ t: snapshot.t, ahead: snapshot.queuedGas + snapshot.submittedGas })
    while (this.#snaps.length && this.#snaps[0].t < snapshot.t - (WAIT_LOOKBACK_BLOCKS + 120) * 1000) this.#snaps.shift()
    for (const b of snapshot.blocks) this.#blocks.set(b.n, { t: b.t, pt: b.pt })
    if (this.#blocks.size > WAIT_LOOKBACK_BLOCKS + 300) {
      for (const n of [...this.#blocks.keys()].sort((a, b) => a - b).slice(0, this.#blocks.size - WAIT_LOOKBACK_BLOCKS - 60)) this.#blocks.delete(n)
    }
  }

  has(block: number): boolean {
    return this.#blocks.has(block)
  }

  /** Gas ahead in the queue at time `t` (the last snapshot at or before it), or null before the history starts. */
  #aheadAt(t: number): number | null {
    let lo = 0
    let hi = this.#snaps.length - 1
    if (hi < 0 || this.#snaps[0].t > t) return null
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.#snaps[mid].t <= t) lo = mid
      else hi = mid - 1
    }
    return this.#snaps[lo].ahead
  }

  /** Seconds a fill landing in `block` at `landedMs` waited, first come first served; null if the history is too short. */
  estimate(block: number, landedMs: number): number | null {
    let drained = 0
    for (let n = block; n > block - WAIT_LOOKBACK_BLOCKS; n--) {
      const b = this.#blocks.get(n)
      if (!b) return null
      drained += b.pt
      const ahead = this.#aheadAt(b.t - 1000)
      if (ahead == null) return null
      if (ahead <= drained) return Math.max(1, Math.round((landedMs - b.t) / 1000) + 1)
    }
    return null
  }
}

/** The parts of a `pressure:current` snapshot the page draws. */
function condense(s: Record<string, any>) {
  return {
    t: s.ts,
    queued: Number(s.queuedIntents),
    submitted: Number(s.submittedIntents),
    queuedGas: Number(s.totalQueuedGas),
    submittedGas: Number(s.totalSubmittedGas),
    limit: Number(s.blockGasLimit),
    stale: Boolean(s.stale || s.chain?.stale),
    blocks: ((s.chain?.blocks ?? []) as Record<string, any>[]).map(
      (b): Block => ({
        n: b.number,
        t: b.timestampMs,
        gas: Number(b.gasUsed),
        pt: Number(b.papertradeGasUsed),
        limit: Number(b.gasLimit),
        kind: b.kind,
        txs: b.transactionCount,
      }),
    ),
  }
}

/**
 * Start the queue relay (stream subscriptions, Hyperliquid mids, OI polls) and return its two routes: the /events
 * stream and the page. `npm run queue` serves them on their own; on paperwatch.app the Limit Intents server mounts
 * them at /queue.
 */
export function startQueueRelay() {
  const history: string[] = []
  const clients = new Set<ServerResponse>()
  let connected = false
  const send = (event: string, data: unknown, keep = true) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    if (keep && history.push(msg) > HISTORY) history.shift()
    for (const res of clients) res.write(msg)
  }

  // Fills wait here until their block shows up in a queue snapshot, then go out with a wait estimate.
  const waits = new WaitEstimator()
  let unresolved: { fill: Fill; at: number }[] = []
  const flushFills = () => {
    const ready: Fill[] = []
    unresolved = unresolved.filter(({ fill, at }) => {
      const block = Math.floor(fill.seq / 1e6)
      if (!waits.has(block) && Date.now() - at < WAIT_RESOLVE_MS) return true
      ready.push({ ...fill, wait: waits.has(block) ? waits.estimate(block, fill.t) : null })
      return false
    })
    if (ready.length) send('fills', ready)
  }
  setInterval(flushFills, 1000)

  const connect = () => {
    let id = 1
    const ws = new WebSocket(STREAM_URL, { headers: { Origin: 'https://exchange.papertrade.xyz' } } as never)
    ws.onopen = () => ws.send(JSON.stringify({ id: id++, connect: { name: 'js' } }))
    ws.onmessage = (e) => {
      for (const line of String(e.data).split('\n').filter(Boolean)) {
        const m = JSON.parse(line)
        if (Object.keys(m).length === 0) ws.send('{}')
        else if (m.connect) {
          connected = true
          send('status', { connected }, false)
          for (const channel of ['pressure:current', 'public:trades']) ws.send(JSON.stringify({ id: id++, subscribe: { channel } }))
        } else if (m.push?.channel === 'pressure:current' && m.push.pub?.data?.snapshot) {
          const snapshot = condense(m.push.pub.data.snapshot)
          waits.record(snapshot)
          send('pressure', snapshot)
          flushFills()
        }
        else if (m.push?.channel === 'public:trades' && m.push.pub) {
          // Every fill, trimmed to what the page draws. Size is margin, the intent's own size field.
          const fills = (m.push.pub.data as Record<string, any>[]).filter((t) => t.leverage > 0).map((t): Fill => ({
            seq: t.seq,
            t: t.ts,
            sym: t.instrument,
            long: t.side === 'long',
            kind: t.kind,
            margin: Math.round(t.notionalUsd / t.leverage),
            lev: Number(t.leverage),
            notional: Math.round(t.notionalUsd),
          }))
          for (const fill of fills) unresolved.push({ fill, at: Date.now() })
          flushFills()
        }
      }
    }
    ws.onclose = () => {
      connected = false
      send('status', { connected }, false)
      console.log(`${ts()} WARN  stream closed; reconnecting`)
      setTimeout(connect, 3000)
    }
  }
  connect()

  // Live mids for the book's middle row: Hyperliquid's best bid/offer, about 9 updates a second per coin.
  const mids: Record<string, number> = {}
  let midSentAt = 0
  const connectHl = () => {
    const ws = new WebSocket(HL_WS_URL)
    ws.onopen = () => {
      for (const coin of ['BTC', 'ETH']) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }))
    }
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data))
      const [bid, ask] = m.channel === 'bbo' ? m.data.bbo : []
      if (!bid || !ask) return
      mids[m.data.coin] = (Number(bid.px) + Number(ask.px)) / 2
      if (Date.now() - midSentAt >= MID_SEND_MS) {
        midSentAt = Date.now()
        send('mid', { t: midSentAt, mids }, false)
      }
    }
    ws.onclose = () => setTimeout(connectHl, 3000)
  }
  connectHl()

  // USD a new position can still add on each side before that side's OI cap (null = uncapped).
  const pollOi = async () => {
    try {
      const trading = await getTradingState()
      const midsRaw = await readMids(trading.instruments)
      const room = (v: number) => (Number.isFinite(v) ? Math.round(v) : null)
      send('oi', {
        t: Date.now(),
        markets: trading.instruments.map((inst) => {
          const mid = midsRaw.get(inst.id)!
          const usdOf = (raw: bigint) => Math.round((Number(raw) / 1e18) * (Number(mid) / Number(inst.priceScale)))
          const long = room(sideHeadroomUsd(inst, true, trading.maxNetOpenInterestRaw, mid))
          const short = room(sideHeadroomUsd(inst, false, trading.maxNetOpenInterestRaw, mid))
          return {
            symbol: inst.symbol,
            long,
            short,
            longOi: usdOf(inst.longOiRaw),
            shortOi: usdOf(inst.shortOiRaw),
            longCap: long == null ? null : usdOf(inst.longCapRaw),
            shortCap: short == null ? null : usdOf(inst.shortCapRaw),
          }
        }),
      })
    } catch (err) {
      console.log(`${ts()} WARN  OI poll failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
    setTimeout(pollOi, OI_POLL_MS)
  }
  pollOi()

  return {
    events(req: IncomingMessage, res: ServerResponse) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      res.write(`event: status\ndata: ${JSON.stringify({ connected })}\n\nevent: mid\ndata: ${JSON.stringify({ t: Date.now(), mids })}\n\n${history.join('')}`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
    },
    page(res: ServerResponse) {
      servePage(res, 'queue-viz.html') // read per request, so edits show on reload
    },
  }
}

export async function runQueueView(): Promise<void> {
  const relay = startQueueRelay()
  createServer((req, res) => {
    baseHeaders(res)
    if (req.url === '/events') return relay.events(req, res)
    if (req.url === '/site.js') return serveSiteJs(res)
    relay.page(res)
  }).listen(PORT, HOST, () => console.log(`${ts()} queue view listening on ${HOST}:${PORT}`))

  await new Promise<void>((resolve) => process.once('SIGINT', resolve))
}
