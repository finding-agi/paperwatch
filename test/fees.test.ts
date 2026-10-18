import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WIN_FEE, impactParams, mintRate, winKeep } from '../src/fees.ts'
import { BTC } from './fixtures.ts'

const btc = impactParams(BTC)
const summary = { flatRate: 100, cliffUsd: 2e6, decayUsd: 120e6 }

test('win haircut matches the docs (BTC keeps ~88% at 1%, ~74% at 0.1%, before the win fee)', () => {
  assert.ok(Math.abs(winKeep(0.01, btc) / (1 - WIN_FEE) - 0.88) < 0.005)
  assert.ok(Math.abs(winKeep(0.001, btc) / (1 - WIN_FEE) - 0.74) < 0.005)
  assert.equal(winKeep(0.00001, btc), 0) // inside the 0.2bp deadband
  assert.ok(winKeep(1, btc) < 0.9 * 0.98)
})

test('mint curve: flat below the cliff, 100·(S/(S+H))² above it', () => {
  assert.equal(mintRate({ ...summary, trackedLpUsd: 1e6, tailProgressUsd: 500e6 }), 100)
  assert.ok(Math.abs(mintRate({ ...summary, trackedLpUsd: 5e6, tailProgressUsd: 100e6 }) - 29.75) < 0.01) // docs: ≈30
  assert.ok(Math.abs(mintRate({ ...summary, trackedLpUsd: 5e6, tailProgressUsd: 113.81e6 }) - 26.34) < 0.01) // live mints
})
