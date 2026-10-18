import type { Hex } from 'viem'
import { API_URL, USER_AGENT } from './config.ts'

export type Position = {
  positionId: string
  instrumentId: number
  isLong: boolean
  useDebt: boolean
  entryPriceRaw: bigint
  marginRaw: bigint
  leverage: number
  bustPriceRaw: bigint
  openedAtMs: number
  intentId: Hex | null
}

export type ClosedPosition = {
  positionId: string
  instrumentId: number
  isLong: boolean
  marginRaw: bigint
  leverage: number
  liquidated: boolean
  netPnlRaw: bigint
  paperMintedRaw: bigint
}

export type IntentOutcome = { intentId: Hex; outcome: 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'unknown' }

export type AccountState = {
  address: string
  accountRevision: number
  indexedThroughTimestamp: number
  sessionKeys: Map<string, bigint> // session key address (lowercase) -> expiry (unix seconds)
  balance: bigint
  queued: bigint
  locked: bigint
  availableBalance: bigint
  availableQueued: bigint
  paperBalance: bigint
  paperStaked: bigint
  realizedPnlRaw: bigint
  /** Lifetime totals from the feed (18-dec USD): deposits, withdrawals, fees paid, notional traded, staking rewards claimed. */
  lifetime: { depositedRaw: bigint; withdrawnRaw: bigint; feesPaidRaw: bigint; tradedNotionalRaw: bigint; rewardsClaimedRaw: bigint }
  positions: Map<string, Position>
  pendingIntents: Set<Hex>
}

export type FrameResult = { state: AccountState; closed: ClosedPosition[]; outcomes: IntentOutcome[] }

export class OutOfSyncError extends Error {}

type Tuple = unknown[]
type Wire = Record<string, any>

export function parsePosition(t: Tuple): Position {
  return {
    positionId: String(t[0]),
    instrumentId: t[1] as number,
    isLong: t[2] as boolean,
    useDebt: t[3] as boolean,
    entryPriceRaw: BigInt(t[4] as string),
    marginRaw: BigInt(t[5] as string),
    leverage: t[6] as number,
    bustPriceRaw: BigInt(t[7] as string),
    openedAtMs: t[8] as number,
    intentId: (t[9] as Hex | null) ?? null,
  }
}

function parseClosed(t: Tuple): ClosedPosition {
  return {
    positionId: String(t[0]),
    instrumentId: t[1] as number,
    isLong: t[2] as boolean,
    marginRaw: BigInt(t[3] as string),
    leverage: t[4] as number,
    liquidated: t[5] as boolean,
    netPnlRaw: BigInt(t[6] as string),
    paperMintedRaw: BigInt(t[7] as string),
  }
}

// Wallet fields shared by snapshots and (partially) by patch `state` objects.
function walletFields(w: Wire): Partial<AccountState> {
  const out: Partial<AccountState> = {}
  if (w.indexedThroughTimestamp !== undefined) out.indexedThroughTimestamp = w.indexedThroughTimestamp
  if (w.sessionKeys !== undefined) {
    out.sessionKeys = new Map((w.sessionKeys as [string, string][]).map(([k, exp]) => [k.toLowerCase(), BigInt(exp)]))
  }
  if (w.balance !== undefined) out.balance = BigInt(w.balance)
  if (w.queued !== undefined) out.queued = BigInt(w.queued)
  if (w.locked !== undefined) out.locked = BigInt(w.locked)
  if (w.funds !== undefined) {
    out.availableBalance = BigInt(w.funds.availableBalance)
    out.availableQueued = BigInt(w.funds.availableQueued)
  }
  if (w.paper !== undefined) {
    out.paperBalance = BigInt(w.paper.balance)
    out.paperStaked = BigInt(w.paper.staked)
  }
  return out
}

const ZERO_LIFETIME: AccountState['lifetime'] = { depositedRaw: 0n, withdrawnRaw: 0n, feesPaidRaw: 0n, tradedNotionalRaw: 0n, rewardsClaimedRaw: 0n }
function lifetimeOf(l: Wire | undefined, prev: AccountState['lifetime']): AccountState['lifetime'] {
  if (!l) return prev
  const big = (v: unknown, fallback: bigint) => (v === undefined || v === null ? fallback : BigInt(v as string))
  return {
    depositedRaw: big(l.depositedRaw, prev.depositedRaw),
    withdrawnRaw: big(l.withdrawnRaw, prev.withdrawnRaw),
    feesPaidRaw: big(l.feesPaidRaw, prev.feesPaidRaw),
    tradedNotionalRaw: big(l.tradedNotionalRaw, prev.tradedNotionalRaw),
    rewardsClaimedRaw: big(l.paperRewardsClaimedRaw, prev.rewardsClaimedRaw),
  }
}

/** Apply one `wallet` event: a full snapshot, or a patch against the previous accountRevision. */
export function applyFrame(prev: AccountState | null, frame: Wire): FrameResult {
  if (frame.baseAccountRevision === undefined) {
    const positions = new Map<string, Position>()
    for (const t of frame.openPositions as Tuple[]) {
      const p = parsePosition(t)
      positions.set(p.positionId, p)
    }
    const state = {
      address: String(frame.address).toLowerCase(),
      accountRevision: frame.accountRevision,
      ...walletFields(frame),
      realizedPnlRaw: BigInt(frame.lifetime.realizedPnlRaw),
      lifetime: lifetimeOf(frame.lifetime, ZERO_LIFETIME),
      positions,
      pendingIntents: new Set((frame.operations as Tuple[]).map((op) => op[0] as Hex)),
    } as AccountState
    return { state, closed: [], outcomes: [] }
  }

  if (!prev || frame.baseAccountRevision !== prev.accountRevision) throw new OutOfSyncError('account stream out of sync')
  const positions = new Map(prev.positions)
  for (const id of frame.removedPositionIds as string[]) positions.delete(String(id))
  for (const t of frame.addedPositions as Tuple[]) {
    const p = parsePosition(t)
    positions.set(p.positionId, p)
  }
  const pendingIntents = new Set(prev.pendingIntents)
  for (const id of frame.removedOperationIds as Hex[]) pendingIntents.delete(id)
  for (const op of frame.addedOperations as Tuple[]) pendingIntents.add(op[0] as Hex)
  const state: AccountState = {
    ...prev,
    ...walletFields(frame.state ?? {}),
    accountRevision: frame.accountRevision,
    realizedPnlRaw: frame.lifetime?.realizedPnlRaw !== undefined ? BigInt(frame.lifetime.realizedPnlRaw) : prev.realizedPnlRaw,
    lifetime: lifetimeOf(frame.lifetime, prev.lifetime ?? ZERO_LIFETIME),
    positions,
    pendingIntents,
  }
  return {
    state,
    closed: ((frame.closedPositions ?? []) as Tuple[]).map(parseClosed),
    outcomes: ((frame.intentOutcomes ?? []) as [Hex, IntentOutcome['outcome']][]).map(([intentId, outcome]) => ({
      intentId,
      outcome,
    })),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Long-lived reader for /state/user/live (server-sent events), with reconnect and patch application. */
export class AccountStream {
  readonly wallet: string
  #state: AccountState | null = null
  #listeners = new Set<(r: FrameResult) => void>()
  #abort: AbortController | null = null
  #running = false
  #lastEventAt = 0
  onError: (err: unknown) => void = () => {}

  constructor(wallet: string) {
    this.wallet = wallet.toLowerCase()
  }

  get state(): AccountState | null {
    return this.#state
  }

  onFrame(fn: (r: FrameResult) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  start(): void {
    if (this.#running) return
    this.#running = true
    void this.#loop()
  }

  stop(): void {
    this.#running = false
    this.#abort?.abort()
  }

  /** Resolve with pick(state) once it returns something other than undefined. */
  waitFor<T>(pick: (s: AccountState) => T | undefined, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const check = () => {
        const v = this.#state ? pick(this.#state) : undefined
        if (v === undefined) return false
        cleanup()
        resolve(v)
        return true
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out after ${timeoutMs}ms waiting for account state`))
      }, timeoutMs)
      const off = this.onFrame(() => void check())
      const cleanup = () => {
        clearTimeout(timer)
        off()
      }
      check()
    })
  }

  ready(timeoutMs = 15_000): Promise<AccountState> {
    return this.waitFor((s) => s, timeoutMs)
  }

  async #loop(): Promise<void> {
    let backoff = 1000
    while (this.#running) {
      try {
        await this.#connect()
        backoff = 1000
      } catch (err) {
        if (!this.#running) break
        this.onError(err)
      }
      if (!this.#running) break
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }

  async #connect(): Promise<void> {
    const ctrl = new AbortController()
    this.#abort = ctrl
    const res = await fetch(`${API_URL}/state/user/live?wallet=${encodeURIComponent(this.wallet)}`, {
      headers: { accept: 'text/event-stream', 'user-agent': USER_AGENT },
      signal: ctrl.signal,
    })
    if (!res.ok || !res.body) throw new Error(`account stream HTTP ${res.status}`)
    this.#lastEventAt = Date.now()
    // The server heartbeats every 10s; treat 35s of silence as a dead connection.
    const watchdog = setInterval(() => {
      if (Date.now() - this.#lastEventAt > 35_000) ctrl.abort()
    }, 5000)
    try {
      const decoder = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n')
        this.#lastEventAt = Date.now()
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          this.#handle(raw)
        }
      }
    } catch (err) {
      if (err instanceof OutOfSyncError) this.#state = null
      throw err
    } finally {
      clearInterval(watchdog)
    }
  }

  #handle(raw: string): void {
    let event = 'message'
    const data: string[] = []
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (event !== 'wallet' || data.length === 0) return
    const result = applyFrame(this.#state, JSON.parse(data.join('\n')))
    this.#state = result.state
    for (const fn of this.#listeners) fn(result)
  }
}
