import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto'
import type { Hex } from 'viem'
import { openKey, sealKey } from './users.ts'

// How trading keys are sealed at rest. The web tier only ever seals, with a public key (PT_KEY_PUBLIC); only the worker
// holds the private keys that open them (PT_KEY_PRIVATE), so a breach of the internet-facing side exposes no keys.
// Sealed format: v2.<kid>.<ephemeral X25519 public key>.<iv>.<tag>.<ciphertext> (base64 parts). The kid names the key
// pair, so a rotation can add a new pair while the old one still opens what it sealed, and rewrap moves rows across.
// The first format (salt.iv.tag.data, AES with a key derived from PT_KEY_SECRET) still opens while that secret is set.
// In production the worker's private keys arrive encrypted by AWS KMS (PT_KEY_PRIVATE_KMS = kid:ciphertext, comma-
// separated) and are decrypted once at startup, with an AWS login that can only decrypt, only with this context.

const INFO = Buffer.from('paperwatch trading key v2')
export const KMS_CONTEXT = (kid: string) => ({ app: 'paperwatch', purpose: 'trading-key-seal', kid })
const KMS_REGION = (env: NodeJS.ProcessEnv) => env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-west-2'

/** KMS calls, swappable in tests. */
export type Kms = {
  decrypt(ciphertext: Buffer, context: Record<string, string>): Promise<Buffer>
  encrypt(keyId: string, plaintext: Buffer, context: Record<string, string>): Promise<Buffer>
}
export async function awsKms(env = process.env): Promise<Kms> {
  const { KMSClient, DecryptCommand, EncryptCommand } = await import('@aws-sdk/client-kms')
  const client = new KMSClient({ region: KMS_REGION(env) })
  return {
    async decrypt(CiphertextBlob, EncryptionContext) {
      const out = await client.send(new DecryptCommand({ CiphertextBlob, EncryptionContext }))
      return Buffer.from(out.Plaintext!)
    },
    async encrypt(KeyId, Plaintext, EncryptionContext) {
      const out = await client.send(new EncryptCommand({ KeyId, Plaintext, EncryptionContext }))
      return Buffer.from(out.CiphertextBlob!)
    },
  }
}
const b64 = (b: Buffer) => b.toString('base64')
const raw = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }) as Buffer

/** Short id of a public key: the first 8 hex of the SHA-256 of its DER. */
export const keyId = (publicKey: KeyObject) => createHash('sha256').update(raw(publicKey)).digest('hex').slice(0, 8)

/** A fresh pair whose private half is encrypted by KMS at once: kid:ciphertext, the form PT_KEY_PRIVATE_KMS takes. */
export async function newKmsKeyPair(kms: Kms, kmsKeyId: string): Promise<{ kid: string; publicKey: string; privateKms: string }> {
  const { kid, publicKey, privateKey } = newKeyPair()
  const blob = await kms.encrypt(kmsKeyId, Buffer.from(privateKey), KMS_CONTEXT(kid))
  return { kid, publicKey, privateKms: `${kid}:${blob.toString('base64')}` }
}

/** A fresh key pair, as the base64 DER strings PT_KEY_PUBLIC and PT_KEY_PRIVATE take. */
export function newKeyPair(): { kid: string; publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { kid: keyId(publicKey), publicKey: b64(raw(publicKey)), privateKey: b64(privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer) }
}

const aesKey = (shared: Buffer, eph: Buffer, recipient: Buffer) => Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, recipient]), INFO, 32))

export class Keyring {
  readonly #public: KeyObject | null
  readonly #kid: string | null
  readonly #private = new Map<string, KeyObject>() // kid -> private key
  readonly #legacy: string | null

  constructor(opts: { publicKey?: string; privateKeys?: string[]; legacySecret?: string }) {
    this.#public = opts.publicKey ? createPublicKey({ key: Buffer.from(opts.publicKey, 'base64'), format: 'der', type: 'spki' }) : null
    this.#kid = this.#public && keyId(this.#public)
    for (const p of opts.privateKeys ?? []) {
      const key = createPrivateKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'pkcs8' })
      this.#private.set(keyId(createPublicKey(key)), key)
    }
    this.#legacy = opts.legacySecret || null
  }

  /** PT_KEY_PUBLIC (one key: what new keys are sealed with), PT_KEY_PRIVATE (comma-separated), PT_KEY_SECRET (old format). */
  static fromEnv(env = process.env, localSecret?: string): Keyring {
    return new Keyring({
      publicKey: env.PT_KEY_PUBLIC?.trim() || undefined,
      privateKeys: (env.PT_KEY_PRIVATE ?? '').split(',').map((k) => k.trim()).filter(Boolean),
      legacySecret: env.PT_KEY_SECRET || localSecret,
    })
  }

  /**
   * Like fromEnv, plus the KMS-encrypted private keys in PT_KEY_PRIVATE_KMS, decrypted now. Each must decrypt under
   * its own kid and turn out to be that kid's key, or this throws (the worker then doesn't start).
   */
  static async load(env = process.env, localSecret?: string, kms?: Kms): Promise<Keyring> {
    const entries = (env.PT_KEY_PRIVATE_KMS ?? '').split(',').map((e) => e.trim()).filter(Boolean)
    const privateKeys = (env.PT_KEY_PRIVATE ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    if (entries.length) {
      const client = kms ?? (await awsKms(env))
      for (const entry of entries) {
        const [kid, blob] = entry.split(':')
        if (!kid || !blob) throw new Error('PT_KEY_PRIVATE_KMS entries are kid:ciphertext')
        const key = (await client.decrypt(Buffer.from(blob, 'base64'), KMS_CONTEXT(kid))).toString()
        const got = keyId(createPublicKey(createPrivateKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'pkcs8' })))
        if (got !== kid) throw new Error(`PT_KEY_PRIVATE_KMS: the key labelled ${kid} is ${got}`)
        privateKeys.push(key)
      }
    }
    return new Keyring({ publicKey: env.PT_KEY_PUBLIC?.trim() || undefined, privateKeys, legacySecret: env.PT_KEY_SECRET || localSecret })
  }

  get kid(): string | null {
    return this.#kid
  }
  get canSeal(): boolean {
    return Boolean(this.#public || this.#legacy)
  }
  get canOpen(): boolean {
    return this.#private.size > 0 || Boolean(this.#legacy)
  }
  /** Key ids this keyring can open. */
  get opens(): string[] {
    return [...this.#private.keys(), ...(this.#legacy ? ['legacy'] : [])]
  }

  seal(privateKey: Hex): string {
    if (!this.#public) {
      if (!this.#legacy) throw new Error('no key to seal with (set PT_KEY_PUBLIC)')
      return sealKey(privateKey, this.#legacy)
    }
    const eph = generateKeyPairSync('x25519')
    const ephRaw = raw(eph.publicKey)
    const key = aesKey(diffieHellman({ privateKey: eph.privateKey, publicKey: this.#public }), ephRaw, raw(this.#public))
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`v2.${this.#kid}`))
    const data = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
    return ['v2', this.#kid, b64(ephRaw), b64(iv), b64(cipher.getAuthTag()), b64(data)].join('.')
  }

  open(sealed: string): Hex {
    const parts = sealed.split('.')
    if (parts[0] !== 'v2') {
      if (!this.#legacy) throw new Error('this key was sealed with PT_KEY_SECRET, which is not set here')
      return openKey(sealed, this.#legacy)
    }
    const [, kid, ephB64, ivB64, tagB64, dataB64] = parts
    const priv = this.#private.get(kid)
    if (!priv) throw new Error(`no private key for key id ${kid} here`)
    const ephRaw = Buffer.from(ephB64, 'base64')
    const eph = createPublicKey({ key: ephRaw, format: 'der', type: 'spki' })
    const key = aesKey(diffieHellman({ privateKey: priv, publicKey: eph }), ephRaw, raw(createPublicKey(priv)))
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
    decipher.setAAD(Buffer.from(`v2.${kid}`))
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8') as Hex
  }

  /** Whether a sealed key should move to the current public key (and this keyring can open it to do so). */
  needsRewrap(sealed: string): boolean {
    if (!this.#public) return false
    const [v, kid] = sealed.split('.')
    if (v === 'v2' && kid === this.#kid) return false
    return v === 'v2' ? this.#private.has(kid) : Boolean(this.#legacy)
  }
}
