import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Hex } from 'viem'
import { loadStrategyConfig } from '../src/config.ts'
import { decide, reconcile, type MarketView, type Pair, type PositionView } from '../src/strategy.ts'

const cfg = loadStrategyConfig({ PT_RESET_MOVE: '0.01' })
const id = (c: string) => `0x${c.repeat(64)}` as Hex
const ENTRY = 1_000_000n // $100,000.0 at priceScale 10

function openPair(): Pair {
  return {
    id: 'p1',
    instrumentId: 0,
    status: 'open',
    createdAtMs: 0,
    legs: [
      { intentId: id('a'), isLong: true, marginRaw: 20n, leverage: 50, deadline: 9_999_999_999n, positionId: '1', entryPriceRaw: ENTRY, bustPriceRaw: 980_466n },
      { intentId: id('b'), isLong: false, marginRaw: 20n, leverage: 50, deadline: 9_999_999_999n, positionId: '2', entryPriceRaw: ENTRY, bustPriceRaw: 1_019_514n },
    ],
  }
}

const market = (over: Partial<MarketView> = {}): MarketView => ({
  midRaw: ENTRY,
  openable: true,
  headroomLongUsd: 5e6,
  headroomShortUsd: 5e6,
  queueUsd: 0,
  queueTriggerMove: 0.05,
  adminAlert: false,
  availableUsd: null,
  ...over,
})

test('holds inside the reset band, resets both legs once one is 1% against entry', () => {
  assert.deepEqual(decide([openPair()], market({ midRaw: 1_009_000n }), cfg, 0), [])
  const [d] = decide([openPair()], market({ midRaw: 1_010_000n }), cfg, 0)
  assert.deepEqual(d, { kind: 'close', pairId: 'p1', positionIds: ['1', '2'], reason: 'reset' })
})

test('queue risk flattens pairs and blocks new ones', () => {
  const ds = decide([openPair()], market({ queueTriggerMove: 0.02 }), { ...cfg, maxPairs: 2 }, 0)
  assert.equal(ds[0].kind === 'close' && ds[0].reason, 'queue-guard')
  assert.deepEqual(ds[1], { kind: 'idle', reason: 'queue-risk' })
})

test('bust guard fires before the reset when leverage is too tight', () => {
  const pair = openPair()
  pair.legs[0].bustPriceRaw = 997_500n // 0.25% below entry
  const [d] = decide([pair], market({ midRaw: 999_000n }), cfg, 0)
  assert.equal(d.kind === 'close' && d.reason, 'bust-guard')
})

test('opens the tighter side first, and respects budget and headroom', () => {
  assert.deepEqual(decide([], market({ headroomLongUsd: 2e6 }), cfg, 0), [{ kind: 'open', firstIsLong: true }])
  assert.deepEqual(decide([], market({ headroomShortUsd: 2e6 }), cfg, 0), [{ kind: 'open', firstIsLong: false }])
  assert.deepEqual(decide([], market(), cfg, cfg.maxDailyCostUsd), [{ kind: 'idle', reason: 'daily-budget' }])
  assert.deepEqual(decide([], market({ headroomLongUsd: 0 }), cfg, 0), [{ kind: 'idle', reason: 'oi-headroom' }])
})

test('stays idle when the free balance cannot cover both legs', () => {
  const both = (2 * cfg.legNotionalUsd) / cfg.leverage
  assert.deepEqual(decide([], market({ availableUsd: both }), cfg, 0), [{ kind: 'idle', reason: 'low-balance' }])
  assert.equal(decide([], market({ availableUsd: both + 1 }), cfg, 0)[0].kind, 'open')
  // A pair that needs closing still closes on a low balance.
  const [d] = decide([openPair()], market({ midRaw: 1_010_000n, availableUsd: 0 }), cfg, 0)
  assert.equal(d.kind === 'close' && d.reason, 'reset')
})

test('reconcile: a vanished leg breaks the pair, which then gets closed', () => {
  const positions = new Map<string, PositionView>([['2', { positionId: '2', entryPriceRaw: ENTRY, bustPriceRaw: 1_019_514n, intentId: id('b') }]])
  const [pair] = reconcile([openPair()], positions, new Set(), 1000, cfg)
  assert.equal(pair.status, 'broken')
  assert.deepEqual(decide([pair], market(), cfg, 0)[0], { kind: 'close', pairId: 'p1', positionIds: ['2'], reason: 'broken' })
})

test('reconcile: attaches fills by intent id and drops fully closed pairs', () => {
  const opening: Pair = { ...openPair(), status: 'opening' }
  for (const leg of opening.legs) delete leg.positionId
  const positions = new Map<string, PositionView>([
    ['7', { positionId: '7', entryPriceRaw: ENTRY, bustPriceRaw: 980_466n, intentId: id('a') }],
    ['8', { positionId: '8', entryPriceRaw: ENTRY, bustPriceRaw: 1_019_514n, intentId: id('b') }],
  ])
  const [pair] = reconcile([opening], positions, new Set(), 1000, cfg)
  assert.equal(pair.status, 'open')
  assert.deepEqual(pair.legs.map((l) => l.positionId), ['7', '8'])

  pair.status = 'closing'
  pair.closeRequestedAtMs = 1000
  assert.deepEqual(reconcile([pair], new Map(), new Set(), 2000, cfg), [])
})

test('reconcile: a failed open intent breaks the pair', () => {
  const opening: Pair = { ...openPair(), status: 'opening' }
  opening.legs[1].positionId = undefined
  const positions = new Map<string, PositionView>([['1', { positionId: '1', entryPriceRaw: ENTRY, bustPriceRaw: 980_466n, intentId: id('a') }]])
  const [pair] = reconcile([opening], positions, new Set([id('b')]), 1000, cfg)
  assert.equal(pair.status, 'broken')
})

test('backtest simulator: one reset per threshold crossed, fast moves flagged', async () => {
  const { simulate } = await import('../src/backtest.ts')
  const impact = { baseRate: 0.1, rateMultiplier: 15000, positionMultiplier: 483.979, referenceNotional: 100000 }
  const flat = (t: number, c: number) => ({ t, o: c, h: c, l: c, c })
  const one = simulate([flat(0, 100), { t: 1, o: 100, h: 101.2, l: 100, c: 101 }], 0.01, 50, 0.0005, 1000, impact, 26)
  assert.equal(one.resets, 1)
  assert.ok(Math.abs(one.lossUsd - 10) < 1e-9) // $1000 × 1%
  assert.ok(Math.abs(one.paper - 10 * 26 * 0.98) < 1e-6)
  const gap = simulate([flat(0, 100), { t: 1, o: 100, h: 100, l: 97, c: 97 }], 0.01, 50, 0.0005, 1000, impact, 26)
  assert.equal(gap.resets, 3)
  assert.equal(gap.fastMoves, 1) // 3% in one candle is past the 1.95% bust distance at 50x
})

// Spread mode: restrike a leg 0.1% against its own entry, take both once either leg is 0.4% up.
const spread = loadStrategyConfig({ PT_STRATEGY: 'spread', PT_RESTRIKE_MOVE: '0.001', PT_TAKE_MOVE: '0.004' })

test('spread: holds inside the bands, restrikes only the losing leg', () => {
  assert.deepEqual(decide([openPair()], market({ midRaw: 1_000_900n }), spread, 0), [])
  assert.deepEqual(decide([openPair()], market({ midRaw: 1_001_000n }), spread, 0), [
    { kind: 'restrike', pairId: 'p1', positionId: '2', isLong: false },
  ])
  assert.deepEqual(decide([openPair()], market({ midRaw: 999_000n }), spread, 0), [
    { kind: 'restrike', pairId: 'p1', positionId: '1', isLong: true },
  ])
})

test('spread: the take closes both legs, ahead of a restrike', () => {
  const pair = openPair()
  pair.legs[0].entryPriceRaw = 997_000n // long restruck lower earlier, so the spread is in our favour
  // +0.1% from the short's entry is a restrike for the short, but the long is already 0.4% up.
  assert.deepEqual(decide([pair], market({ midRaw: 1_001_000n }), spread, 0), [
    { kind: 'close', pairId: 'p1', positionIds: ['1', '2'], reason: 'take' },
  ])
})

test('spread: waits on a restrike close, then reopens that side once it lands', () => {
  const pair = openPair()
  Object.assign(pair.legs[1], { retiring: true, closeIntentId: id('c'), closeDeadline: 9_999_999_999n })
  assert.deepEqual(decide([pair], market({ midRaw: 1_001_500n }), spread, 0), [])

  const positions = new Map<string, PositionView>([['1', { positionId: '1', entryPriceRaw: ENTRY, bustPriceRaw: 980_466n, intentId: id('a') }]])
  const [after] = reconcile([pair], positions, new Set(), 1000, spread)
  assert.equal(after.status, 'open')
  assert.deepEqual(after.legs.map((l) => l.positionId), ['1'])
  assert.deepEqual(decide([after], market({ midRaw: 1_001_500n }), spread, 0), [{ kind: 'reopen', pairId: 'p1', isLong: false }])
})

test('spread: a side that cannot reopen gets the other leg flattened', () => {
  const pair = openPair()
  pair.legs = [pair.legs[0]]
  const [d] = decide([pair], market({ headroomShortUsd: 0 }), spread, 0)
  assert.deepEqual(d, { kind: 'close', pairId: 'p1', positionIds: ['1'], reason: 'unhedged-oi-headroom' })
  const [low] = decide([pair], market({ availableUsd: 0 }), spread, 0)
  assert.equal(low.kind === 'close' && low.reason, 'unhedged-low-balance')
})

test('spread: holds a loser whose side has no room to reopen', () => {
  assert.deepEqual(decide([openPair()], market({ midRaw: 1_001_000n, headroomShortUsd: 0 }), spread, 0), [])
})

test('spread: the take skips a leg whose own close is in flight', () => {
  const pair = openPair()
  Object.assign(pair.legs[1], { retiring: true, closeIntentId: id('c'), closeDeadline: 9_999_999_999n })
  assert.deepEqual(decide([pair], market({ midRaw: 1_004_000n }), spread, 0), [
    { kind: 'close', pairId: 'p1', positionIds: ['1'], reason: 'take' },
  ])
})

test('spread: waits while a reopened leg is still filling', () => {
  const pair = openPair()
  pair.legs[1] = { intentId: id('d'), isLong: false, marginRaw: 20n, leverage: 50, deadline: 9_999_999_999n }
  assert.deepEqual(decide([pair], market({ midRaw: 1_005_000n }), spread, 0), [])
})

test('reconcile: a restrike close that failed is retried; a reopen that failed breaks the pair', () => {
  const pair = openPair()
  Object.assign(pair.legs[1], { retiring: true, closeIntentId: id('c'), closeDeadline: 9_999_999_999n })
  const positions = new Map<string, PositionView>([
    ['1', { positionId: '1', entryPriceRaw: ENTRY, bustPriceRaw: 980_466n, intentId: id('a') }],
    ['2', { positionId: '2', entryPriceRaw: ENTRY, bustPriceRaw: 1_019_514n, intentId: id('b') }],
  ])
  const [retry] = reconcile([pair], positions, new Set([id('c')]), 1000, spread)
  assert.equal(retry.legs[1].closeDeadline, undefined)
  assert.equal(decide([retry], market({ midRaw: 1_001_000n }), spread, 0)[0].kind, 'restrike')

  const reopening = openPair()
  reopening.legs[1] = { intentId: id('d'), isLong: false, marginRaw: 20n, leverage: 50, deadline: 9_999_999_999n }
  const [broken] = reconcile([reopening], positions, new Set([id('d')]), 1000, spread)
  assert.equal(broken.status, 'broken')
  assert.deepEqual(decide([broken], market(), spread, 0)[0], { kind: 'close', pairId: 'p1', positionIds: ['1'], reason: 'broken' })
})
