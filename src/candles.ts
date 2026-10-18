import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR, USER_AGENT } from './config.ts'

// Real candles for the Limit Intents chart, from Hyperliquid's info API (the same book the contract prices from).
// Hyperliquid only serves the latest ~5000 candles per interval: 30+ days of 15m/1h/4h, but only ~17 days of 5m. So
// every candle fetched is also kept in <state dir>/candles/, and the 5m history grows from there (up to KEEP_DAYS).

const HL_INFO_URL = process.env.PT_HL_INFO_URL || 'https://api.hyperliquid.xyz/info'
export const INTERVALS: Record<number, string> = { 300: '5m', 900: '15m', 3600: '1h', 14400: '4h' }
const FIRST_DAYS = 31
const KEEP_DAYS = 60
const REFRESH_MS = 15_000

/** One candle as the chart takes it: time in unix seconds (bucket start), prices as numbers. */
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number }

/** Combine stored and fresh candles: fresh wins on the same bucket, sorted, oldest dropped past `keepFromSec`. */
export function mergeCandles(stored: Candle[], fresh: Candle[], keepFromSec: number): Candle[] {
  const byTime = new Map<number, Candle>()
  for (const c of stored) byTime.set(c.time, c)
  for (const c of fresh) byTime.set(c.time, c)
  return [...byTime.values()].filter((c) => c.time >= keepFromSec).sort((a, b) => a.time - b.time)
}

type Wire = { t: number; o: string; h: string; l: string; c: string; v: string }
const fromWire = (w: Wire): Candle => ({ time: Math.floor(w.t / 1000), open: +w.o, high: +w.h, low: +w.l, close: +w.c, volume: +w.v })

async function fetchCandles(coin: string, interval: string, startMs: number): Promise<Candle[]> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: startMs, endTime: Date.now() } }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!res.ok) throw new Error(`hyperliquid candleSnapshot HTTP ${res.status}`)
  return ((await res.json()) as Wire[]).map(fromWire)
}

/** Cached, persisted candle history per coin and interval; refreshes at most every REFRESH_MS. */
export class CandleStore {
  #series = new Map<string, { candles: Candle[]; fetchedAt: number; pending?: Promise<Candle[]> }>()

  #file(coin: string, interval: string) {
    return join(STATE_DIR, 'candles', `${coin}-${interval}.json`)
  }

  async get(coin: string, tfSec: number): Promise<Candle[]> {
    const interval = INTERVALS[tfSec]
    if (!interval) throw new Error('timeframe must be one of 5m, 15m, 1h, 4h')
    const key = `${coin}-${interval}`
    let entry = this.#series.get(key)
    if (!entry) {
      const file = this.#file(coin, interval)
      const stored = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Candle[]) : []
      entry = { candles: stored, fetchedAt: 0 }
      this.#series.set(key, entry)
    }
    if (Date.now() - entry.fetchedAt < REFRESH_MS) return entry.candles
    entry.pending ??= (async () => {
      const e = entry!
      try {
        // After the first load, only ask for what's new (from the last stored bucket, which may still be open).
        const last = e.candles.at(-1)?.time
        const start = last ? last * 1000 : Date.now() - FIRST_DAYS * 86_400_000
        const fresh = await fetchCandles(coin, interval, start)
        e.candles = mergeCandles(e.candles, fresh, Math.floor(Date.now() / 1000) - KEEP_DAYS * 86_400)
        e.fetchedAt = Date.now()
        const file = this.#file(coin, interval)
        mkdirSync(join(STATE_DIR, 'candles'), { recursive: true })
        writeFileSync(`${file}.tmp`, JSON.stringify(e.candles))
        renameSync(`${file}.tmp`, file)
        return e.candles
      } catch (err) {
        if (e.candles.length) return e.candles // Hyperliquid hiccup: serve what we have, retry next call
        throw err
      } finally {
        e.pending = undefined
      }
    })()
    return entry.pending
  }
}
