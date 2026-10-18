import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TradingState } from '../src/api.ts'
import { crossed, holdReason, newOrder, sizeOrder } from '../src/trigger.ts'
import { BTC, BTC_MID, MAX_NET_OI } from './fixtures.ts'

const WAD = 10n ** 18n
const trading = (over: Partial<TradingState> = {}): TradingState => ({
  indexedThroughBlock: 1,
  tradingPaused: false,
  minimumTradeSizeRaw: 10n * WAD,
  minimumOpenNotionalRaw: 1000n * WAD,
  maxNetOpenInterestRaw: MAX_NET_OI,
  pausedActions: [],
  instruments: [BTC],
  ...over,
})
const input = { symbol: 'BTC', side: 'long', triggerPx: 79000, marginPct: 0.25, leverage: 35, expiresHours: 24, deadlineSec: 60 }

test('a trigger under the mid fires at or below it; one above fires at or above', () => {
  const below = newOrder(input, BTC, 80000, 0)
  assert.ok(typeof below !== 'string')
  assert.equal(below.when, 'below')
  assert.equal(crossed(below, 79001), false)
  assert.equal(crossed(below, 79000), true)
  assert.equal(crossed(below, 78000), true)
  const above = newOrder({ ...input, triggerPx: 81000 }, BTC, 80000, 0)
  assert.ok(typeof above !== 'string')
  assert.equal(above.when, 'above')
  assert.equal(crossed(above, 80999), false)
  assert.equal(crossed(above, 81500), true)
  assert.equal(above.expiresAt, 24 * 3_600_000)
})

test('bad orders are refused with a reason', () => {
  assert.equal(newOrder(input, undefined, 80000), 'unknown market')
  assert.match(newOrder({ ...input, leverage: 5000 }, BTC, 80000) as string, /max of 1000x/)
  assert.match(newOrder({ ...input, leverage: 2.5 }, BTC, 80000) as string, /whole number/)
  assert.match(newOrder({ ...input, marginPct: 0 }, BTC, 80000) as string, /1–100%/)
  assert.match(newOrder({ ...input, triggerPx: 7900 }, BTC, 80000) as string, /typo/)
  assert.match(newOrder({ ...input, side: 'up' }, BTC, 80000) as string, /long or short/)
  assert.match(newOrder({ ...input, deadlineSec: 5 }, BTC, 80000) as string, /15–3600/)
})

test('size comes from the free balance at fire time, in whole cents, keeping $1 back', () => {
  const s = sizeOrder({ marginPct: 0.25, leverage: 35 }, 800.4, BTC, trading())
  assert.ok(typeof s !== 'string')
  assert.equal(s.marginUsd, 200.1)
  assert.equal(s.marginRaw, 200_100_000n * 10n ** 12n)
  assert.ok(Math.abs(s.notionalUsd - 7003.5) < 1e-9)
  const all = sizeOrder({ marginPct: 1, leverage: 10 }, 300, BTC, trading())
  assert.ok(typeof all !== 'string')
  assert.equal(all.marginUsd, 299)
  assert.match(sizeOrder({ marginPct: 0.01, leverage: 10 }, 300, BTC, trading()) as string, /below the \$10\.00 minimum/)
  assert.match(sizeOrder({ marginPct: 0.1, leverage: 2 }, 300, BTC, trading()) as string, /notional is below/)
})

test('a triggered order holds for paused opens, OI room and a backed-up queue', () => {
  const short = newOrder({ ...input, side: 'short' }, BTC, 80000, 0)
  const long = newOrder(input, BTC, 80000, 0)
  assert.ok(typeof short !== 'string' && typeof long !== 'string')
  assert.equal(holdReason(short, BTC, trading(), BTC_MID, 800, 10), null)
  assert.match(holdReason(long, BTC, trading(), BTC_MID, 800, 10)!, /no OI room for a long/) // fixture: longs capped
  assert.match(holdReason(short, BTC, trading({ pausedActions: ['openPosition'] }), BTC_MID, 800, 10)!, /paused/)
  assert.match(holdReason(short, BTC, trading(), BTC_MID, 800, 300, 250)!, /queue backed up/)
  assert.equal(holdReason(short, BTC, trading(), BTC_MID, 800, null), null) // no queue data: don't block
})

test('a dollar margin is used as-is, and holds when the free balance cannot cover it', () => {
  const o = newOrder({ ...input, marginPct: undefined, marginUsd: 225.009 }, BTC, 80000, 0)
  assert.ok(typeof o !== 'string')
  assert.equal(o.fixedMarginUsd, 225)
  assert.equal(o.marginPct, 0)
  const s = sizeOrder(o, 449.52, BTC, trading())
  assert.ok(typeof s !== 'string')
  assert.equal(s.marginUsd, 225)
  assert.ok(Math.abs(s.notionalUsd - 225 * 35) < 1e-9)
  assert.match(sizeOrder(o, 200, BTC, trading()) as string, /needs \$225\.00 margin but only \$200\.00 is free/)
  assert.match(newOrder({ ...input, marginUsd: -5 }, BTC, 80000) as string, /positive dollar amount/)
})

test('candle history merges by bucket: fresh data wins, old buckets age out', async () => {
  const { mergeCandles } = await import('../src/candles.ts')
  const c = (time: number, close: number) => ({ time, open: close, high: close, low: close, close, volume: 1 })
  const merged = mergeCandles([c(100, 1), c(200, 2), c(300, 3)], [c(300, 3.5), c(400, 4)], 200)
  assert.deepEqual(merged.map((x) => [x.time, x.close]), [[200, 2], [300, 3.5], [400, 4]])
})
