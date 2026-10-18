import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bustPriceRaw, queueTriggerMove, sideHeadroomUsd } from '../src/risk.ts'
import { BTC, BTC_MID, MAX_NET_OI } from './fixtures.ts'

test('bust price matches a live position (short 25x @ 82961.5 -> bust 86238.9)', () => {
  assert.equal(bustPriceRaw(829615n, 25, false, BTC.bustBufferRaw), 862389n)
  assert.ok(bustPriceRaw(829615n, 25, true, BTC.bustBufferRaw) < 829615n)
})

test('OI headroom: long side capped by max net OI, short side by its cap', () => {
  assert.equal(sideHeadroomUsd(BTC, true, MAX_NET_OI, BTC_MID), 0)
  assert.ok(Math.abs(sideHeadroomUsd(BTC, false, MAX_NET_OI, BTC_MID) - 5.038e6) < 0.01e6)
})

test('queue trigger is LP over net exposure', () => {
  const move = queueTriggerMove(5e6, [{ inst: BTC, midRaw: BTC_MID }])
  assert.ok(Math.abs(move - 5e6 / ((1312.8148 - 792.9034) * 82789.5)) < 1e-4)
})

test('hyperliquid mid strings convert to raw prices like the contract (truncating)', async () => {
  const { toPriceRaw } = await import('../src/market.ts')
  assert.equal(toPriceRaw('82823.25', 10n), 828232n)
  assert.equal(toPriceRaw('82823', 10n), 828230n)
  assert.equal(toPriceRaw('2488.055', 100n), 248805n)
})
