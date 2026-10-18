import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OutOfSyncError, applyFrame } from '../src/account.ts'

const position = (id: string, intent: string) => [id, 0, true, false, '829615', '20000000000000000000', 50, '813439', 1791860185000, intent]
const intentA = `0x${'a'.repeat(64)}`
const intentB = `0x${'b'.repeat(64)}`

const snapshot = {
  address: '0x9587C978341B4DE61FA14E4705F65FBAAEC72741',
  accountRevision: 10,
  indexedThroughBlock: 1,
  indexedThroughTimestamp: 100,
  walletRevision: 1,
  sessionKeys: [['0x871031D5EE769131FE533CE22C29438E5D9A960B', '1794321534']],
  queueRevision: '1',
  balance: '100',
  queued: '0',
  locked: '20',
  funds: { reservedBalance: '0', reservedQueued: '0', availableBalance: '80', availableQueued: '0' },
  queueNodeCount: 0,
  consumableDebt: '0',
  paper: { balance: '1', staked: '5', pendingBase: '0', rewardDebt: '0' },
  lifetime: { realizedPnlRaw: '-7' },
  operations: [],
  openPositions: [position('1', intentA)],
}

test('snapshot then patch: positions, closes and outcomes', () => {
  const { state } = applyFrame(null, snapshot)
  assert.equal(state.address, '0x9587c978341b4de61fa14e4705f65fbaaec72741')
  assert.equal(state.sessionKeys.get('0x871031d5ee769131fe533ce22c29438e5d9a960b'), 1794321534n)
  assert.equal(state.positions.get('1')?.intentId, intentA)
  assert.equal(state.realizedPnlRaw, -7n)

  const next = applyFrame(state, {
    address: snapshot.address,
    accountRevision: 11,
    baseAccountRevision: 10,
    state: { balance: '95', funds: { reservedBalance: '0', reservedQueued: '0', availableBalance: '75', availableQueued: '0' } },
    lifetime: { realizedPnlRaw: '-12' },
    closedPositions: [['1', 0, true, '20000000000000000000', 50, false, '-5000000000000000000', '129000000000000000000']],
    intentOutcomes: [[intentB, 'failed']],
    addedPositions: [position('2', intentB)],
    removedPositionIds: ['1'],
    addedOperations: [],
    removedOperationIds: [],
  })
  assert.deepEqual([...next.state.positions.keys()], ['2'])
  assert.equal(next.state.balance, 95n)
  assert.equal(next.state.paperStaked, 5n) // untouched fields carry over
  assert.equal(next.state.realizedPnlRaw, -12n)
  assert.equal(next.closed[0].netPnlRaw, -5n * 10n ** 18n)
  assert.equal(next.closed[0].paperMintedRaw, 129n * 10n ** 18n)
  assert.deepEqual(next.outcomes, [{ intentId: intentB, outcome: 'failed' }])
})

test('patch against the wrong revision is rejected', () => {
  const { state } = applyFrame(null, snapshot)
  assert.throws(
    () => applyFrame(state, { ...snapshot, baseAccountRevision: 9, addedPositions: [], removedPositionIds: [], addedOperations: [], removedOperationIds: [] }),
    OutOfSyncError,
  )
})

test('lifetime totals: read from the snapshot, patched field by field, kept when a patch has none', () => {
  const { state } = applyFrame(null, { ...snapshot, lifetime: { realizedPnlRaw: '-7', feesPaidRaw: '28', depositedRaw: '2062', withdrawnRaw: '1252', tradedNotionalRaw: '9000', paperRewardsClaimedRaw: '39' } })
  assert.deepEqual(state.lifetime, { depositedRaw: 2062n, withdrawnRaw: 1252n, feesPaidRaw: 28n, tradedNotionalRaw: 9000n, rewardsClaimedRaw: 39n })
  const base = { address: snapshot.address, baseAccountRevision: 10, addedPositions: [], removedPositionIds: [], addedOperations: [], removedOperationIds: [] }
  const patched = applyFrame(state, { ...base, accountRevision: 11, lifetime: { realizedPnlRaw: '-9', feesPaidRaw: '30' } }).state
  assert.equal(patched.lifetime.feesPaidRaw, 30n)
  assert.equal(patched.lifetime.depositedRaw, 2062n)
  assert.equal(patched.realizedPnlRaw, -9n)
  const quiet = applyFrame(patched, { ...base, baseAccountRevision: 11, accountRevision: 12 }).state
  assert.equal(quiet.lifetime.feesPaidRaw, 30n)
  assert.equal(quiet.realizedPnlRaw, -9n)
})
