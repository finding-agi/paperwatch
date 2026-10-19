import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { Db, diffRows, type Query } from '../src/db.ts'

const lite = async () => {
  const pg = new PGlite()
  // pg's Pool runs a parameterless multi-statement string as one simple query; PGlite needs exec() for that.
  const query: Query = async (sql, params) => (params ? pg.query(sql, params) : ((await pg.exec(sql)).at(-1) ?? { rows: [] })) as { rows: Record<string, unknown>[] }
  return { pg, query }
}

test('diffRows: upserts changed and new rows, deletes missing ones', () => {
  const last = new Map([['a', '1'], ['b', '2'], ['c', '3']])
  const next = new Map([['a', '1'], ['b', '20'], ['d', '4']])
  assert.deepEqual(diffRows(last, next), { upserts: [['b', '20'], ['d', '4']], deletes: ['c'] })
})

test('Db: sync mirrors rows, load reads them back, events append', async () => {
  const { query } = await lite()
  const db = new Db(query)
  await db.init()
  await db.init() // idempotent
  db.sync('orders', [['o1', { id: 'o1', wallet: '0xabc', status: 'armed', createdAt: 1 }], ['o2', { id: 'o2', wallet: '0xdef', status: 'sent', createdAt: 2 }]])
  db.sync('orders', [['o1', { id: 'o1', wallet: '0xabc', status: 'filled', createdAt: 1 }]])
  db.put('fee-scan', { block: 42 })
  db.event('order_placed', '0xABC', { id: 'o1' })
  await db.flush()

  const fresh = new Db(query)
  const orders = await fresh.load<{ status: string }>('orders')
  assert.deepEqual([...orders.keys()], ['o1'])
  assert.equal(orders.get('o1')!.status, 'filled')
  const { rows } = await query('select wallet, status from paperwatch.orders')
  assert.deepEqual(rows, [{ wallet: '0xabc', status: 'filled' }]) // generated columns
  assert.deepEqual(await fresh.get('fee-scan'), { block: 42 })
  const events = await query('select type, wallet, data from paperwatch.events')
  assert.deepEqual(events.rows, [{ type: 'order_placed', wallet: '0xabc', data: { id: 'o1' } }])
})

test('Db: a failed write makes flush reject until a later write succeeds, and the rows are retried', async () => {
  const { query } = await lite()
  let down = false
  const db = new Db((sql, params) => (down ? Promise.reject(new Error('connection refused')) : query(sql, params)))
  await db.init()
  down = true
  db.sync('users', [['0xa', { wallet: '0xa', nextNonce: '5' }]])
  await assert.rejects(db.flush(), /database write failed/)
  down = false
  db.sync('users', [['0xa', { wallet: '0xa', nextNonce: '6' }]])
  await db.flush()
  const users = await new Db(query).load<{ nextNonce: string }>('users')
  assert.equal(users.get('0xa')!.nextNonce, '6')
})
