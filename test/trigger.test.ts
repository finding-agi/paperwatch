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

test('the unlock fee only counts a successful HyperEVM transfer of enough HYPE from the wallet to the fee address', async () => {
  const { feePaymentProblem } = await import('../src/trigger.ts')
  const fee = '0xEFF64D64a23487f72370Df85F3ceA01941453CdE'
  const me = '0x10e942585cebf3dcf8377ff8ec38f2458662eec3'
  const min = 10n ** 17n // 0.1 HYPE
  const ok = { from: me, to: fee.toLowerCase(), value: min, chainId: 999 }
  assert.equal(feePaymentProblem(ok, 'success', me, fee, min), null)
  assert.equal(feePaymentProblem({ ...ok, value: min * 2n }, 'success', me.toUpperCase().replace('0X', '0x'), fee, min), null)
  assert.match(feePaymentProblem(ok, 'reverted', me, fee, min)!, /failed/)
  assert.match(feePaymentProblem({ ...ok, value: min - 1n }, 'success', me, fee, min)!, /less than 0.1 HYPE/)
  assert.match(feePaymentProblem({ ...ok, from: '0x' + '1'.repeat(40) }, 'success', me, fee, min)!, /different wallet/)
  assert.match(feePaymentProblem({ ...ok, to: '0x' + '2'.repeat(40) }, 'success', me, fee, min)!, /fee wallet/)
  assert.match(feePaymentProblem({ ...ok, to: null }, 'success', me, fee, min)!, /fee wallet/)
  assert.match(feePaymentProblem({ ...ok, chainId: 1 }, 'success', me, fee, min)!, /HyperEVM/)
})

test('the fee watcher picks out only transfers of at least the fee straight to the fee address', async () => {
  const { feePayments } = await import('../src/trigger.ts')
  const fee = '0xEFF64D64a23487f72370Df85F3ceA01941453CdE'
  const min = 10n ** 17n
  const txs = [
    { hash: '0x1', to: fee.toLowerCase(), value: min },
    { hash: '0x2', to: fee, value: min * 3n },
    { hash: '0x3', to: fee, value: min - 1n }, // too little
    { hash: '0x4', to: '0x' + '9'.repeat(40), value: min }, // somewhere else
    { hash: '0x5', to: null, value: min }, // contract creation
  ]
  assert.deepEqual(feePayments(txs, fee, min).map((t) => t.hash), ['0x1', '0x2'])
})

test('market orders go out at the live mid; every order needs at least $1,000 of notional', () => {
  const mkt = newOrder({ ...input, type: 'market', triggerPx: undefined, marginUsd: 40, leverage: 25 }, BTC, 80_000, 0)
  assert.ok(typeof mkt !== 'string')
  assert.equal(mkt.kind, 'market')
  assert.equal(mkt.triggerPx, 80_000)
  assert.equal(mkt.expiresAt, 3 * 60_000) // dropped if it can't go out within 3 minutes
  const lim = newOrder({ ...input, marginUsd: 40, leverage: 25 }, BTC, 80_000, 0)
  assert.ok(typeof lim !== 'string')
  assert.equal(lim.kind, 'limit')
  assert.match(newOrder({ ...input, type: 'market', marginUsd: 39.99, leverage: 25 }, BTC, 80_000) as string, /at least \$1,000/)
  assert.match(newOrder({ ...input, marginUsd: 10, leverage: 50 }, BTC, 80_000) as string, /at least \$1,000/)
  // A higher protocol minimum wins over the $1,000 floor.
  assert.match(newOrder({ ...input, marginUsd: 40, leverage: 30 }, BTC, 80_000, 0, undefined, 1500) as string, /at least \$1,500/)
})
