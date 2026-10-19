// Health of paperwatch.app for /api/status, the /status page and alerts. The worker and each web replica write a
// heartbeat to the database every 10 s (kv rows status:worker and status:web:<replica>); any web replica turns them
// into one status per part. Pure functions here, so the rules are tested on their own.

export type Level = 'ok' | 'degraded' | 'down'
export type WorkerBeat = {
  at: number
  mode: string
  lastCheckAt: number
  feeds: number
  sends1h: number
  fails1h: number
  unconfirmed1h: number
  fillP50s: number | null
  fillP95s: number | null
  priceAgeMs: number | null
  warns10m: number
}
export type WebBeat = { at: number; replica: string; lives: number; refreshAgeMs: number; warns10m: number }
export type Part = { name: string; status: Level; detail: string }
export type Summary = { status: Level; parts: Part[]; updatedAt: number }

const STALE_MS = 60_000 // a heartbeat older than this means that process is gone
const RANK: Record<Level, number> = { ok: 0, degraded: 1, down: 2 }

/** The p-th percentile (0..1) of `xs`, or null when empty. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

export function summarize(now: number, worker: WorkerBeat | null, webs: WebBeat[], dbOk: boolean, queued: number | null, maxQueued: number): Summary {
  const live = webs.filter((w) => now - w.at < STALE_MS)
  const parts: Part[] = []
  parts.push(
    live.length
      ? { name: 'Website', status: 'ok', detail: `${live.length} replica${live.length === 1 ? '' : 's'}, ${live.reduce((s, w) => s + w.lives, 0)} live page(s)` }
      : { name: 'Website', status: 'down', detail: 'no web replica has reported in the last minute' },
  )
  parts.push(dbOk ? { name: 'Database', status: 'ok', detail: 'reachable' } : { name: 'Database', status: 'down', detail: 'not reachable' })
  if (!worker || now - worker.at >= STALE_MS) parts.push({ name: 'Order sending', status: 'down', detail: 'the worker has not reported in the last minute: orders and closes are not being sent' })
  else if (now - worker.lastCheckAt > 30_000) parts.push({ name: 'Order sending', status: 'degraded', detail: 'the worker is up but has not checked orders in 30 s' })
  else parts.push({ name: 'Order sending', status: 'ok', detail: `worker running (${worker.mode}), following ${worker.feeds} account(s)` })
  if (worker && now - worker.at < STALE_MS) {
    const stale = worker.priceAgeMs == null || worker.priceAgeMs > 15_000
    parts.push({ name: 'Prices', status: stale ? 'degraded' : 'ok', detail: stale ? 'Hyperliquid prices are stale: triggers wait' : 'live from Hyperliquid' })
    const bad = worker.fails1h >= 5 || worker.unconfirmed1h > 0
    const fills = worker.fillP50s == null ? 'no fills' : `fill median ${worker.fillP50s}s, p95 ${worker.fillP95s}s`
    parts.push({
      name: 'Orders (last hour)',
      status: bad ? 'degraded' : 'ok',
      detail: `${worker.sends1h} sent, ${fills}, ${worker.fails1h} failed, ${worker.unconfirmed1h} unconfirmed`,
    })
  }
  if (queued != null) {
    parts.push(
      queued >= maxQueued
        ? { name: 'Papertrade queue', status: 'degraded', detail: `${queued} intents queued: limit orders hold until it drops below ${maxQueued}` }
        : { name: 'Papertrade queue', status: 'ok', detail: `${queued} intents queued` },
    )
  }
  const status = parts.reduce<Level>((worst, p) => (RANK[p.status] > RANK[worst] ? p.status : worst), 'ok')
  return { status, parts, updatedAt: now }
}

/** The web replica that sends alerts: the lowest replica id among those reporting, so only one does. */
export function alertLeader(now: number, webs: WebBeat[]): string | null {
  const live = webs.filter((w) => now - w.at < STALE_MS).map((w) => w.replica).sort()
  return live[0] ?? null
}
