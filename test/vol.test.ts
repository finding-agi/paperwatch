import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimators, excursion, resetEvents, slackAt, volLeverage, type LeverageParams } from '../src/vol.ts'

const p: LeverageParams = {
  horizonMin: 5, tailZ: 6, resetMove: 0.005, bustBuffer: 0.0005, minBustDistance: 0.003, levMin: 10, levMax: 200, jumpFloor: 0,
}
const flat = (t: number, c: number) => ({ t: t * 60_000, o: c, h: c, l: c, c })

test('leverage falls as volatility rises, and stays inside its clamp', () => {
  const calm = volLeverage(0.0003, p)
  const wild = volLeverage(0.003, p)
  assert.ok(calm > wild)
  assert.ok(slackAt(calm, p) >= 6 * 0.0003 * Math.sqrt(5))
  assert.equal(volLeverage(0, p), Math.floor(1 / (0.0005 + 0.005 + 0.003))) // min bust distance binds
  assert.equal(volLeverage(0.05, p), 10)
  assert.equal(volLeverage(0, { ...p, levMax: 50 }), 50)
})

test('the jump floor caps leverage however calm it is', () => {
  const lev = volLeverage(0, { ...p, jumpFloor: 0.032 })
  assert.equal(lev, Math.floor(1 / (0.0005 + 0.005 + 0.032)))
  assert.ok(slackAt(lev, p) >= 0.032)
})

test('excursion takes the larger move either way over the horizon', () => {
  const k = [flat(0, 100), { t: 60_000, o: 100, h: 101, l: 99.5, c: 100 }, flat(2, 100), { t: 180_000, o: 100, h: 100, l: 98, c: 99 }]
  assert.ok(Math.abs(excursion(k, 0, 2) - 0.01) < 1e-12)
  assert.ok(Math.abs(excursion(k, 0, 3) - 0.02) < 1e-12)
})

test('reset events measure the further adverse move from the reset level', () => {
  const k = [flat(0, 100), { t: 60_000, o: 100, h: 100, l: 99.4, c: 99.5 }, { t: 120_000, o: 99.5, h: 99.6, l: 98.505, c: 99 }, flat(3, 99)]
  const [e] = resetEvents(k, 0.005, 1)
  assert.equal(e.up, false)
  assert.ok(Math.abs(e.adverse - 0.01) < 1e-9) // 99.5 reset level -> 98.505 low
})

test('estimators produce per-minute sigma independent of candle size', () => {
  // A steady 0.1% alternating move every minute: close-to-close sigma is ~0.1%/min.
  const k = Array.from({ length: 300 }, (_, i) => flat(i, i % 2 ? 100.1 : 100))
  const close60 = estimators(k, [], 1).find((e) => e.name === 'close 60m')!.sigma
  assert.ok(Math.abs(close60[299] - Math.log(100.1 / 100)) < 1e-9)
})
