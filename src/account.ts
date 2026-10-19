import type { Hex } from 'viem'
import { OutOfSyncError, applyFrame } from './account-frames.js'
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

// Applying frames lives in account-frames.js, which the page loads too (it follows its own account in the browser).
export { OutOfSyncError, applyFrame, parsePosition } from './account-frames.js'

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
