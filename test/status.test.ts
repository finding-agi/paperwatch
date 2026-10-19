import assert from 'node:assert/strict'
import { test } from 'node:test'
import { alertLeader, percentile, summarize, type WebBeat, type WorkerBeat } from '../src/status.ts'

const NOW = 1_800_000_000_000
const worker = (extra: Partial<WorkerBeat> = {}): WorkerBeat => ({
  at: NOW - 5000, mode: 'live', lastCheckAt: NOW - 1000, feeds: 3, sends1h: 10, fails1h: 0, unconfirmed1h: 0,
  fillP50s: 4, fillP95s: 9, priceAgeMs: 200, warns10m: 0, ...extra,
})
const web = (replica: string, ageMs = 5000): WebBeat => ({ at: NOW - ageMs, replica, lives: 7, refreshAgeMs: 900, warns10m: 0 })
const statusOf = (s: ReturnType<typeof summarize>, name: string) => s.parts.find((p) => p.name === name)?.status

test('all healthy is ok', () => {
  const s = summarize(NOW, worker(), [web('a'), web('b')], true, 12, 250)
  assert.equal(s.status, 'ok')
  assert.match(s.parts[0].detail, /2 replicas, 14 live page/)
})

test('a silent worker means orders are not being sent', () => {
  const s = summarize(NOW, worker({ at: NOW - 61_000 }), [web('a')], true, 12, 250)
  assert.equal(s.status, 'down')
  assert.equal(statusOf(s, 'Order sending'), 'down')
  assert.equal(summarize(NOW, null, [web('a')], true, null, 250).status, 'down')
})

test('stale prices, failures, a backed-up queue and a stuck check loop are degraded', () => {
  assert.equal(statusOf(summarize(NOW, worker({ priceAgeMs: 20_000 }), [web('a')], true, 1, 250), 'Prices'), 'degraded')
  assert.equal(statusOf(summarize(NOW, worker({ fails1h: 5 }), [web('a')], true, 1, 250), 'Orders (last hour)'), 'degraded')
  assert.equal(statusOf(summarize(NOW, worker({ unconfirmed1h: 1 }), [web('a')], true, 1, 250), 'Orders (last hour)'), 'degraded')
  assert.equal(statusOf(summarize(NOW, worker(), [web('a')], true, 300, 250), 'Papertrade queue'), 'degraded')
  assert.equal(statusOf(summarize(NOW, worker({ lastCheckAt: NOW - 40_000 }), [web('a')], true, 1, 250), 'Order sending'), 'degraded')
})

test('no database or no web replica is down', () => {
  assert.equal(summarize(NOW, worker(), [web('a')], false, 1, 250).status, 'down')
  assert.equal(statusOf(summarize(NOW, worker(), [web('a', 70_000)], true, 1, 250), 'Website'), 'down')
})

test('one alert leader: the lowest live replica id', () => {
  assert.equal(alertLeader(NOW, [web('b'), web('a', 70_000), web('c')]), 'b')
  assert.equal(alertLeader(NOW, []), null)
})

test('percentile', () => {
  assert.equal(percentile([], 0.5), null)
  assert.equal(percentile([5, 1, 3], 0.5), 3)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10)
})
