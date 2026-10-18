import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WaitEstimator } from '../src/queue-viz.ts'

// Blocks 100..110, one a second, each giving Papertrade 0.3M gas; `ahead` gas queued the whole time.
function estimator(ahead: number) {
  const w = new WaitEstimator()
  const blocks = Array.from({ length: 11 }, (_, i) => ({ n: 100 + i, t: (100 + i) * 1000, gas: 0, pt: 300_000, limit: 3e6, kind: 'ordinary', txs: 1 }))
  w.record({ t: 90_000, queued: 0, submitted: 0, queuedGas: ahead, submittedGas: 0, limit: 3e6, stale: false, blocks })
  return w
}

test('wait estimate: 1.2M gas ahead at 0.3M per block lands 4 blocks later', () => {
  assert.equal(estimator(1_200_000).estimate(104, 104_000), 4)
})

test('wait estimate: an empty queue means the next block', () => {
  assert.equal(estimator(0).estimate(104, 104_000), 1)
})

test('wait estimate: unknown when the history does not reach back far enough', () => {
  assert.equal(estimator(30_000_000).estimate(104, 104_000), null)
})
