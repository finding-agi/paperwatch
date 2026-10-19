import { createCipheriv, createDecipheriv, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { STATE_DIR } from './config.ts'
import type { Db } from './db.ts'
import { randomNonceStart } from './state.ts'

// Accounts for the public Limit Intents page. Each visitor signs in with their own wallet (a signed message, no gas),
// then approves a Papertrade trading key (session key) for it. The server holds that key, encrypted at rest, so it
// can send the visitor's limit intents when they trigger while their browser is closed. A Papertrade session key can
// open and close positions but can't withdraw, and the wallet can revoke it on-chain at any time.

export type UserRecord = {
  wallet: Address
  createdAt: number
  /** Next intent nonce for this wallet's session-key space. Stored as a decimal string. */
  nextNonce: string
  key?: {
    address: Address
    /** AES-256-GCM: salt, iv, tag and ciphertext, all base64, dot-separated. */
    sealed: string
    expiry: number // unix seconds
    /** When the wallet's approval went to Papertrade's relayer. */
    submittedAt?: number
    /** Set once the account feed shows the key registered on Papertrade. */
    registeredAt?: number
  }
  /** The one-time trading unlock: a HYPE transfer to the fee wallet, checked on-chain. */
  fee?: { tx: Hex; paidAt: number; wei: string }
  /** A key waiting for the wallet's approval: the RegisterSessionKey fields (decimal strings) it will sign. */
  pendingKey?: { address: Address; sealed: string; input: Record<string, string> }
}

/** Encrypt a private key with a key derived from `secret` (scrypt, fresh salt per record). */
export function sealKey(privateKey: Hex, secret: string): string {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(secret, salt, 32), iv)
  const data = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  return [salt, iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.')
}

export function openKey(sealed: string, secret: string): Hex {
  const [salt, iv, tag, data] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(secret, salt, 32), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8') as Hex
}

/** Signed sign-in cookie value: base64url(wallet.expiry) + "." + HMAC. */
export function issueToken(wallet: Address, secret: string, ttlMs: number, now = Date.now()): string {
  const body = Buffer.from(`${wallet.toLowerCase()}.${now + ttlMs}`).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

export function readToken(token: string | undefined, secret: string, now = Date.now()): Address | null {
  if (!token) return null
  const [body, mac] = token.split('.')
  if (!body || !mac) return null
  const want = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'))
  const got = Buffer.from(mac)
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  const [wallet, exp] = Buffer.from(body, 'base64url').toString().split('.')
  if (!/^0x[0-9a-f]{40}$/.test(wallet) || !(Number(exp) > now)) return null
  return wallet as Address
}

/** The text a wallet signs to sign in (EIP-4361 style). */
export function signInMessage(host: string, wallet: Address, nonce: string, issuedAt: string): string {
  return [
    `${host} wants you to sign in with your Ethereum account:`,
    wallet,
    '',
    'Sign in to Paperwatch Limit Intents. This only proves you own this wallet: it sends no transaction and costs no gas.',
    '',
    `URI: https://${host}`,
    'Version: 1',
    'Chain ID: 999',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

export class UserStore {
  #users: Record<string, UserRecord>
  readonly #file = join(STATE_DIR, 'users.json')
  readonly #db: Db | null

  constructor(db: Db | null = null, users?: Record<string, UserRecord>) {
    this.#db = db
    this.#users = users ?? (existsSync(this.#file) ? JSON.parse(readFileSync(this.#file, 'utf8')) : {})
  }

  /** With a database, load from it; the first time (an empty table), copy in users.json. */
  static async open(db: Db | null): Promise<UserStore> {
    if (!db) return new UserStore()
    const rows = await db.load<UserRecord>('users')
    if (rows.size) return new UserStore(db, Object.fromEntries(rows))
    const store = new UserStore(db)
    if (store.all().length) store.save()
    return store
  }

  get(wallet: string): UserRecord | undefined {
    return this.#users[wallet.toLowerCase()]
  }

  getOrCreate(wallet: Address): UserRecord {
    const id = wallet.toLowerCase()
    this.#users[id] ??= { wallet: id as Address, createdAt: Date.now(), nextNonce: String(randomNonceStart()) }
    return this.#users[id]
  }

  all(): UserRecord[] {
    return Object.values(this.#users)
  }

  /** Write users.json (kept as a fallback copy) and mirror changed users to the database. */
  save(): void {
    mkdirSync(STATE_DIR, { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#users, null, 2), { mode: 0o600 })
    renameSync(tmp, this.#file)
    this.#db?.sync('users', Object.entries(this.#users))
  }
}
