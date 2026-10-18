import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex, PublicClient } from 'viem'
import { CONTRACTS, SECRETS_DIR, SESSION_TTL_SEC, STATE_DIR } from './config.ts'
import type { Pair } from './strategy.ts'


export type BotState = {
  version: 1
  nextNonce: bigint
  pairs: Pair[]
  day: { date: string; costUsd: number; paperMinted: number; legsClosed: number }
  totals: { costUsd: number; paperMinted: number; legsClosed: number; liquidations: number }
  admin: { multisigTxCount?: number; timelockBlock?: number }
}

// JSON with bigints encoded as "123n".
const replacer = (_: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)
const reviver = (_: string, v: unknown) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)

function writeAtomic(path: string, text: string, mode?: number): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, text, mode === undefined ? undefined : { mode })
  renameSync(tmp, path)
  if (mode !== undefined) chmodSync(path, mode)
}

export const today = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10)

// Same shape as the frontend's client nonces (random start on a 256 boundary), but a 64-bit start so we never
// collide with nonces a browser session on the same account picks.
export function randomNonceStart(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  return (n || 1n) * 256n
}

export type StateName = 'dry' | 'live' | 'watcher' | 'trigger'

export function statePath(mode: StateName): string {
  return join(STATE_DIR, `${mode}.json`)
}

export function loadState(mode: StateName): BotState {
  const path = statePath(mode)
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'), reviver) as BotState
  return {
    version: 1,
    nextNonce: randomNonceStart(),
    pairs: [],
    day: { date: today(), costUsd: 0, paperMinted: 0, legsClosed: 0 },
    totals: { costUsd: 0, paperMinted: 0, legsClosed: 0, liquidations: 0 },
    admin: {},
  }
}

export function saveState(mode: StateName, state: BotState): void {
  mkdirSync(STATE_DIR, { recursive: true })
  writeAtomic(statePath(mode), JSON.stringify(state, replacer, 2))
}

const NONCE_ABI = [
  {
    type: 'function',
    name: 'isNonceUsed',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'bool' }],
  },
] as const

/** Allocates session-space nonces (register/open/close/withdraw share one space per wallet) and persists the counter. */
export class NonceSource {
  readonly #state: { nextNonce: bigint }
  readonly #persist: () => void
  constructor(state: { nextNonce: bigint }, persist: () => void) {
    this.#state = state
    this.#persist = persist
  }

  take(): bigint {
    const n = this.#state.nextNonce
    this.#state.nextNonce = n + 1n
    this.#persist()
    return n
  }

  /** Skip forward past any nonce already used on-chain (e.g. state file restored from an old copy). */
  async ensureUnused(client: PublicClient, wallet: Address): Promise<void> {
    for (let i = 0; i < 64; i++) {
      const used = await client.readContract({
        address: CONTRACTS.sessionKeyManager,
        abi: NONCE_ABI,
        functionName: 'isNonceUsed',
        args: [wallet, this.#state.nextNonce],
      })
      if (!used) return
      this.#state.nextNonce = randomNonceStart()
    }
    throw new Error('could not find an unused nonce')
  }
}

export type SessionKeyFile = { wallet: Address; address: Address; privateKey: Hex; expiry: string }

const sessionPath = () => join(SECRETS_DIR, 'session-key.json')

export function loadSessionKey(): SessionKeyFile | null {
  // Deployed: the trading key comes from an env var, so the wallet's own private key never leaves your machine.
  const fromEnv = process.env.PT_SESSION_PRIVATE_KEY as Hex | undefined
  if (fromEnv) {
    const wallet = process.env.PT_WALLET_ADDRESS
    if (!wallet) throw new Error('PT_SESSION_PRIVATE_KEY needs PT_WALLET_ADDRESS')
    return { wallet: wallet as Address, address: privateKeyToAccount(fromEnv).address, privateKey: fromEnv, expiry: '0' }
  }
  const path = sessionPath()
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SessionKeyFile) : null
}

/** Generate a fresh trading key for `wallet`, valid for 30 days (minus a minute of clock slack). Stored 0600. */
export function createSessionKey(wallet: Address, nowMs = Date.now()): SessionKeyFile {
  const privateKey = generatePrivateKey()
  const key: SessionKeyFile = {
    wallet,
    address: privateKeyToAccount(privateKey).address,
    privateKey,
    expiry: String(BigInt(Math.floor(nowMs / 1000)) + SESSION_TTL_SEC - 60n),
  }
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 })
  writeAtomic(sessionPath(), JSON.stringify(key, null, 2), 0o600)
  return key
}
