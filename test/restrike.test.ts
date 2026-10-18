import assert from 'node:assert/strict'
import { test } from 'node:test'
import { simulateRestrike, type Candle } from '../src/backtest.ts'
import { LOSS_FEE, impactParams, winKeep } from '../src/fees.ts'
import { BTC } from './fixtures.ts'

const impact = impactParams(BTC)
const candle = (t: number, o: number, h: number, l: number, c: number): Candle => ({ t, o, h, l, c })

test('restrike: a 0.1% dip closes the long alone and reopens it lower; nothing else fires', () => {
  const r = simulateRestrike([candle(0, 100, 100, 99.89, 99.89)], 0.001, 0.004, 10_000, impact, 10)
  assert.equal(r.restrikes, 1)
  assert.equal(r.takes, 0)
  assert.ok(Math.abs(r.lossUsd - 10) < 1e-9) // $10k × 0.1%
  assert.ok(Math.abs(r.paper - 10 * 10 * (1 - LOSS_FEE)) < 1e-9)
})

test('take: a straight 0.4% rise restrikes the short 3 times, then the long takes and the short settles', () => {
  const r = simulateRestrike([candle(0, 100, 100.401, 100, 100.401)], 0.001, 0.004, 10_000, impact, 10)
  assert.equal(r.restrikes, 3) // short at +0.1%, +0.2%, +0.3%
  assert.equal(r.takes, 1)
  // Long: +0.4% paid after the haircut. Short (reopened at ~100.30): ~−0.1% loss at the take.
  const shortEntry = 100 * 1.001 ** 3
  const takePx = 100 * 1.004
  const shortLoss = ((takePx - shortEntry) / shortEntry) * 10_000
  const expectedCost = 30 + shortLoss - 0.004 * 10_000 * winKeep(0.004, impact)
  assert.ok(Math.abs(r.costUsd - expectedCost) < 1e-6)
})
