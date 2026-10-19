import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { Address, Hex } from 'viem'
import { Store, liteQuery } from '../src/db.ts'
import { Keyring, newKeyPair } from '../src/keyring.ts'
import { sealKey } from '../src/users.ts'

const PK = ('0x' + 'ab'.repeat(32)) as Hex
const SECRET = 's'.repeat(40)
const A = ('0x' + 'a'.repeat(40)) as Address

test('web seals with the public key alone; only the private key opens it', () => {
  const pair = newKeyPair()
  const web = new Keyring({ publicKey: pair.publicKey })
  const worker = new Keyring({ privateKeys: [pair.privateKey] })
  const sealed = web.seal(PK)
  assert.match(sealed, new RegExp(`^v2\\.${pair.kid}\\.`))
  assert.equal(web.canOpen, false)
  assert.throws(() => web.open(sealed), /no private key/)
  assert.equal(worker.open(sealed), PK)
  assert.notEqual(web.seal(PK), sealed) // fresh ephemeral key and iv each time
})

test('a tampered or wrongly labelled seal does not open', () => {
  const pair = newKeyPair()
  const ring = new Keyring({ publicKey: pair.publicKey, privateKeys: [pair.privateKey] })
  const parts = ring.seal(PK).split('.')
  const data = Buffer.from(parts[5], 'base64')
  data[0] ^= 1
  assert.throws(() => ring.open([...parts.slice(0, 5), data.toString('base64')].join('.')))
  const other = newKeyPair()
  assert.throws(() => new Keyring({ privateKeys: [other.privateKey] }).open(parts.join('.')), /no private key/)
})

test('old PT_KEY_SECRET seals still open, and rotation keeps old pairs working', () => {
  const old = newKeyPair()
  const next = newKeyPair()
  const ring = new Keyring({ publicKey: next.publicKey, privateKeys: [old.privateKey, next.privateKey], legacySecret: SECRET })
  const legacy = sealKey(PK, SECRET)
  const byOld = new Keyring({ publicKey: old.publicKey }).seal(PK)
  assert.equal(ring.open(legacy), PK)
  assert.equal(ring.open(byOld), PK)
  assert.equal(ring.needsRewrap(legacy), true)
  assert.equal(ring.needsRewrap(byOld), true)
  assert.equal(ring.needsRewrap(ring.seal(PK)), false)
  assert.equal(new Keyring({ privateKeys: [next.privateKey] }).needsRewrap(legacy), false) // nothing to seal with
})

test('without a public key it seals the old way (local runs, and before the rollout)', () => {
  const ring = new Keyring({ legacySecret: SECRET })
  const sealed = ring.seal(PK)
  assert.equal(sealed.split('.').length, 4)
  assert.equal(ring.open(sealed), PK)
  assert.throws(() => new Keyring({}).seal(PK), /PT_KEY_PUBLIC/)
})

test('reseal swaps a sealed key only if it is unchanged', async () => {
  const store = new Store(liteQuery(new PGlite()))
  await store.init()
  await store.ensureUser(A)
  await store.setPendingKey(A, { address: '0xNew' as Address, sealed: 'old-pending', input: {} })
  await store.activateKey(A, { address: '0xNew' as Address, sealed: 'old-pending', expiry: 1 })
  assert.equal(await store.reseal(A, 'key', 'something-else', 'x'), false)
  assert.equal(await store.reseal(A, 'key', 'old-pending', 'v2.k.new'), true)
  assert.equal(store.users.get(A)!.key!.sealed, 'v2.k.new')
  await store.setPendingKey(A, { address: '0xNext' as Address, sealed: 'p1', input: { a: '1' } })
  assert.equal(await store.reseal(A, 'pending', 'p1', 'v2.k.p1'), true)
  assert.deepEqual(store.users.get(A)!.pendingKey, { address: '0xNext', sealed: 'v2.k.p1', input: { a: '1' } })
})
