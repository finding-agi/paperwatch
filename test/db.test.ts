import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { Address } from 'viem'
import { Store, liteQuery, prunable } from '../src/db.ts'
import type { TriggerOrder } from '../src/trigger.ts'

const A = '0x' + 'a'.repeat(40) as Address
const B = '0x' + 'b'.repeat(40) as Address
const TX = '0x' + '1'.repeat(64) as `0x${string}`
const emptyDir = () => mkdtempSync(join(tmpdir(), 'pw-'))

/** Two stores on one database: two server instances. */
async function pair() {
  const query = liteQuery(new PGlite())
  const one = new Store(query)
  const two = new Store(query)
  await one.init()
  await one.importLegacy(emptyDir())
  return { one, two, query }
}

const order = (id: string, wallet: Address, extra: Partial<TriggerOrder> = {}): TriggerOrder => ({
  id, wallet, symbol: 'BTC', isLong: true, triggerPx: 100, when: 'below', marginPct: 0.5, leverage: 10,
  createdAt: Date.now(), expiresAt: Date.now() + 60_000, deadlineSec: 60, status: 'armed', attempts: 0, ...extra,
})

test('init is idempotent, and the first version (one JSON blob per wallet) is imported once', async () => {
  const query = liteQuery(new PGlite())
  await query(`create schema paperwatch; create table paperwatch.users (id text primary key, data jsonb not null)`)
  await query('insert into paperwatch.users (id, data) values ($1, $2)', [A, JSON.stringify({
    wallet: A, createdAt: 1_700_000_000_000, nextNonce: '512',
    key: { address: '0xKey', sealed: 's.e.a.l', expiry: 1_800_000_000, submittedAt: 1_700_000_001_000 },
    fee: { tx: TX, paidAt: 1_700_000_002_000, wei: '100000000000000000' },
  })])
  const store = new Store(query)
  await store.init()
  await store.init()
  await store.importLegacy(emptyDir())
  await store.importLegacy(emptyDir())
  await store.refresh()
  const u = store.users.get(A)!
  assert.equal(store.users.size, 1)
  assert.equal(u.nextNonce, '512')
  assert.deepEqual(u.key, { address: '0xKey', sealed: 's.e.a.l', expiry: 1_800_000_000, submittedAt: 1_700_000_001_000, registeredAt: undefined })
  assert.deepEqual(u.fee, { tx: TX, paidAt: 1_700_000_002_000, wei: '100000000000000000' })
})

test('the JSON files are imported into empty tables', async () => {
  const dir = emptyDir()
  writeFileSync(join(dir, 'users.json'), JSON.stringify({ [A]: { wallet: A, createdAt: 1, nextNonce: '7' } }))
  writeFileSync(join(dir, 'trigger-orders.json'), JSON.stringify([order('o1', A)]))
  const store = new Store(liteQuery(new PGlite()))
  await store.init()
  await store.importLegacy(dir)
  await store.refresh()
  assert.equal(store.users.get(A)!.nextNonce, '7')
  assert.equal(store.orders.get('o1')!.status, 'armed')
})

test('only one instance can claim an armed order; a cancel and a claim cannot both win', async () => {
  const { one, two } = await pair()
  await one.addOrder(order('o1', A))
  await two.refresh()
  const claims = await Promise.all([
    one.transition('o1', ['armed'], { status: 'sending', attempts: 1 }),
    two.transition('o1', ['armed'], { status: 'sending', attempts: 1 }),
    two.transition('o1', ['armed'], { status: 'cancelled' }),
  ])
  assert.equal(claims.filter(Boolean).length, 1)
})

test('transition: keeps the replica object, removes fields set to undefined', async () => {
  const { one } = await pair()
  const o = await one.addOrder(order('o1', A, { note: 'holding' }))
  const next = await one.transition('o1', ['armed'], { note: undefined, firedPx: 99 })
  assert.equal(next, o)
  assert.equal('note' in o, false)
  assert.equal(o.firedPx, 99)
  assert.equal(await one.transition('o1', ['sent'], { status: 'filled' }), null)
})

test('nonces from two instances never repeat', async () => {
  const { one, two } = await pair()
  const start = BigInt((await one.ensureUser(A)).nextNonce)
  const got = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? one : two).takeNonce(A)))
  assert.equal(new Set(got).size, 20)
  assert.deepEqual([...got].sort((x, y) => (x < y ? -1 : 1)), Array.from({ length: 20 }, (_, i) => start + BigInt(i)))
  await one.jumpNonce(A)
  assert.notEqual(await one.takeNonce(A), start + 20n)
})

test('a sign-in message works once, on any instance, and not after it expires', async () => {
  const { one, two } = await pair()
  await one.putSignIn(A, 'hello')
  assert.equal(await two.takeSignIn(A, 60_000), 'hello')
  assert.equal(await one.takeSignIn(A, 60_000), null)
  await one.putSignIn(A, 'again')
  await new Promise((ok) => setTimeout(ok, 20))
  assert.equal(await two.takeSignIn(A, 1), null)
})

test('one close at a time per position; a finished one frees it', async () => {
  const { one, two } = await pair()
  const [x, y] = await Promise.all([one.claimClose('42', A), two.claimClose('42', A)])
  assert.equal(Number(x) + Number(y), 1)
  assert.equal(await one.claimClose('42', A), false)
  await two.setClose('42', { done: true })
  assert.equal(await one.claimClose('42', A), true)
  await two.refresh()
  assert.equal(two.closes.get('42')!.done, false)
})

test('one payment unlocks one wallet', async () => {
  const { one, two } = await pair()
  const fee = { tx: TX, paidAt: Date.now(), wei: '1' }
  const [x, y] = await Promise.all([one.setFee(A, fee), two.setFee(B, fee)])
  assert.equal(Number(x) + Number(y), 1)
  await one.refresh()
  assert.equal(one.isFeeTxUsed(TX.toUpperCase().replace('0X', '0x')), true)
})

test('a trading key activates only while it is the one waiting', async () => {
  const { one } = await pair()
  await one.ensureUser(A)
  await one.setPendingKey(A, { address: '0xNew' as Address, sealed: 'x', input: {} })
  assert.equal(await one.activateKey(A, { address: '0xOld' as Address, sealed: 'y', expiry: 1 }), null)
  const u = await one.activateKey(A, { address: '0xNew' as Address, sealed: 'x', expiry: 2, submittedAt: 5000 })
  assert.equal(u!.key!.address, '0xNew')
  assert.equal(u!.pendingKey, undefined)
  await one.markKeyRegistered(A, '0xnew')
  assert.ok(one.users.get(A)!.key!.registeredAt)
  await one.clearKey(A)
  assert.equal(one.users.get(A)!.key, undefined)
})

test('refresh brings another instance\'s changes into the replica', async () => {
  const { one, two } = await pair()
  await two.refresh()
  await one.ensureUser(A)
  await one.addOrder(order('o1', A))
  await one.transition('o1', ['armed'], { status: 'sending' })
  await two.refresh()
  assert.equal(two.users.has(A), true)
  assert.equal(two.orders.get('o1')!.status, 'sending')
})

test('prunable / pruneOrders keep the newest 50 finished orders per wallet', async () => {
  const { one, two } = await pair()
  for (let i = 0; i < 53; i++) await one.addOrder(order(`d${i}`, A, { status: 'filled', createdAt: i }))
  await one.addOrder(order('live', A, { createdAt: 0 }))
  assert.deepEqual([...prunable(one.orders.values())].sort(), ['d0', 'd1', 'd2'])
  await one.pruneOrders()
  await two.refresh()
  assert.equal(two.orders.size, 51)
  assert.equal(two.orders.has('live'), true)
})

test('events append in order', async () => {
  const { one, query } = await pair()
  one.event('sign_in', A.toUpperCase().replace('0X', '0x'))
  one.event('order_placed', A, { id: 'o1' })
  await one.flushEvents()
  const { rows } = await query('select type, wallet, data from paperwatch.events order by id')
  assert.deepEqual(rows, [
    { type: 'sign_in', wallet: A, data: {} },
    { type: 'order_placed', wallet: A, data: { id: 'o1' } },
  ])
})

test('close queue: requested -> taken once -> sent or failed; a failed one frees the position', async () => {
  const { one, two } = await pair()
  assert.equal(await one.claimClose('7', A), true)
  await two.refresh()
  assert.equal(two.closes.get('7')!.status, 'requested')
  const [x, y] = await Promise.all([one.takeClose('7'), two.takeClose('7')])
  assert.equal(Number(Boolean(x)) + Number(Boolean(y)), 1)
  await two.setClose('7', { status: 'failed', done: true, error: 'refused' })
  await one.refresh()
  assert.deepEqual([one.closes.get('7')!.status, one.closes.get('7')!.error], ['failed', 'refused'])
  assert.equal(await one.claimClose('7', A), true)
  assert.deepEqual([one.closes.get('7')!.status, one.closes.get('7')!.error], ['requested', null])
})
