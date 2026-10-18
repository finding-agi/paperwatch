import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concat, domainSeparator, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { EXCHANGE_DOMAIN, INTENT_TYPES, signIntent } from '../src/eip712.ts'

const typeString = (name: keyof typeof INTENT_TYPES) =>
  `${name}(${INTENT_TYPES[name].map((f) => `${f.type} ${f.name}`).join(',')})`

test('typehashes match SessionKeyManager on-chain constants', () => {
  assert.equal(keccak256(toBytes(typeString('OpenPosition'))), '0xfce2fb41f9ff0457a0f012e62cfd6a7cff4e8439ae20008ab6979c740ba5a983')
  assert.equal(keccak256(toBytes(typeString('Close'))), '0x9cc23a52214afa42e1ae53cdb2e79dc2d0cd33c33faca383ed3b149300adcb13')
})

test('exchange domain matches SessionKeyManager.DOMAIN_SEPARATOR()', () => {
  assert.equal(domainSeparator({ domain: EXCHANGE_DOMAIN }), '0x53a2ab5a64b3239d36b108fb4cd035ebb40ed3f71dec28e37966622670147e77')
})

test('signIntent produces frontend wire format and intent id', async () => {
  // Hardhat's public test account #1, not a real key.
  const key = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
  const { signed, intentId, signer } = await signIntent(key, EXCHANGE_DOMAIN, 'Close', {
    user: '0xAbCdEf0000000000000000000000000000000001',
    positionIds: [12n, 34n],
    nonce: 256n,
    deadline: 1_800_000_000n,
  })
  assert.equal(signer, key.address.toLowerCase())
  assert.deepEqual(signed.positionIds, ['12', '34'])
  assert.equal(signed.user, '0xabcdef0000000000000000000000000000000001')
  assert.equal(signed.nonce, '256')
  assert.ok(signed.v === '27' || signed.v === '28')
  assert.match(signed.r, /^0x[0-9a-f]{64}$/)
  assert.match(intentId, /^0x[0-9a-f]{64}$/)
  // Recompute the id independently from the typed-data digest.
  const { hashTypedData } = await import('viem')
  const digest = hashTypedData({
    domain: EXCHANGE_DOMAIN,
    types: { Close: INTENT_TYPES.Close },
    primaryType: 'Close',
    message: { user: '0xabcdef0000000000000000000000000000000001', positionIds: [12n, 34n], nonce: 256n, deadline: 1_800_000_000n },
  })
  assert.equal(intentId, keccak256(concat([keccak256(toBytes('papertrade:intent-id:v2')), digest, signer])))
})
