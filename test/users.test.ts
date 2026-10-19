import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateKeyToAccount } from 'viem/accounts'
import { intentFromSignature, walletTypedData, EXCHANGE_DOMAIN } from '../src/eip712.ts'
import { issueToken, openKey, readToken, sealKey, signInMessage } from '../src/users.ts'

// Hardhat's public test account #1, not a real key.
const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const SECRET = 'x'.repeat(40)

test('trading keys round-trip through sealing, and a wrong secret cannot open them', () => {
  const sealed = sealKey(PK, SECRET)
  assert.ok(!sealed.includes(PK.slice(2, 20)))
  assert.equal(openKey(sealed, SECRET), PK)
  assert.throws(() => openKey(sealed, 'y'.repeat(40)))
  assert.notEqual(sealKey(PK, SECRET), sealed) // fresh salt and iv every time
})

test('sign-in cookies verify, expire, and reject tampering or another secret', () => {
  const wallet = '0xAbCdEf0000000000000000000000000000000001'
  const token = issueToken(wallet, SECRET, 60_000, 1_000)
  assert.equal(readToken(token, SECRET, 2_000), wallet.toLowerCase())
  assert.equal(readToken(token, SECRET, 70_000), null)
  assert.equal(readToken(token, 'z'.repeat(40), 2_000), null)
  const [body, mac] = token.split('.')
  const forged = Buffer.from('0xabcdef0000000000000000000000000000000002.99999999999999').toString('base64url')
  assert.equal(readToken(`${forged}.${mac}`, SECRET, 2_000), null)
  assert.equal(readToken(`${body}.${mac}x`, SECRET, 2_000), null)
  assert.equal(readToken(undefined, SECRET), null)
})

test('the sign-in message names the site, wallet, chain and nonce', () => {
  const m = signInMessage('paperwatch.app', '0xAbCdEf0000000000000000000000000000000001', 'abc123', '2026-10-18T00:00:00.000Z')
  assert.match(m, /^paperwatch\.app wants you to sign in/)
  assert.match(m, /Chain ID: 999/)
  assert.match(m, /Nonce: abc123/)
})

test('a wallet signature over the RegisterSessionKey typed data turns into a relayer intent from that wallet', async () => {
  const wallet = privateKeyToAccount(PK)
  const input = { user: wallet.address, key: '0x1111111111111111111111111111111111111111', expiry: 1_800_000_000n, feeAddress: '0x0000000000000000000000000000000000000000', nonce: 512n, deadline: 1_800_000_100n }
  const typed = walletTypedData(EXCHANGE_DOMAIN, 'RegisterSessionKey', input)
  assert.equal(typed.message.nonce, '512')
  // What a browser wallet does with eth_signTypedData_v4 (viem wants bigints where the JSON has strings).
  const { EIP712Domain: _, ...types } = typed.types
  const signature = await wallet.signTypedData({ domain: EXCHANGE_DOMAIN, types, primaryType: 'RegisterSessionKey', message: input } as never)
  const { signed, signer } = await intentFromSignature(EXCHANGE_DOMAIN, 'RegisterSessionKey', input, signature)
  assert.equal(signer, wallet.address.toLowerCase())
  assert.equal(signed.key, '0x1111111111111111111111111111111111111111')
  assert.equal(signed.expiry, '1800000000')
})

test('links to our own files get a content stamp; anything else is left alone', async () => {
  const { versioned } = await import('../src/site.ts')
  const html = '<script src="/site.js"></script><link href="/assets/favicon.png"><img src="/assets/nope.png"><a href="/trade">'
  const out = versioned(html)
  assert.match(out, /src="\/site\.js\?v=[0-9a-f]{10}"/)
  assert.match(out, /href="\/assets\/favicon\.png\?v=[0-9a-f]{10}"/)
  assert.ok(out.includes('src="/assets/nope.png"')) // unknown file: untouched
  assert.ok(out.includes('href="/trade"'))
  assert.equal(versioned(html), out) // stable while the files don't change
  assert.match(versioned("src: url('/assets/manrope.woff2')"), /manrope\.woff2\?v=[0-9a-f]{10}'\)/)
})
