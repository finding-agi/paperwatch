import { keccak256, toHex, type Address, type Hex, type LocalAccount } from 'viem'
import { AccountStream, type Position } from './account.ts'
import { submitIntent, type Instrument } from './api.ts'
import { INTENT_TTL_SEC, MAX_CLOSE_IDS } from './config.ts'
import { EXCHANGE_DOMAIN, deadlineFromNow, signIntent } from './eip712.ts'
import { LOSS_FEE, winKeep, type ImpactParams } from './fees.ts'
import { bustPriceRaw } from './risk.ts'
import type { NonceSource } from './state.ts'

export type OpenRequest = { inst: Instrument; isLong: boolean; marginRaw: bigint; leverage: number }
export type ClosedLeg = { positionId: string; netPnlUsd: number; paperMinted: number; liquidated: boolean }
export type SentIntent = { intentId: Hex; deadline: bigint }

export interface Executor {
  readonly mode: 'dry' | 'live'
  submitOpen(req: OpenRequest, midRaw: bigint): Promise<SentIntent>
  /** One close intent per batch of up to MAX_CLOSE_IDS positions. */
  submitClose(positionIds: string[], midRaw: bigint): Promise<SentIntent[]>
  waitForPosition(intentId: Hex, timeoutMs: number): Promise<Position | null>
  positions(): Map<string, Position>
  failedIntents(): Set<Hex>
  /** Free USD balance for new margin, or null when there is no real balance to respect (dry run, or not synced). */
  availableUsd(): number | null
  /** Closed legs (voluntary or liquidated) since the last call. */
  drainClosed(): ClosedLeg[]
  /** Called every tick with the latest mid; the dry-run uses it to simulate liquidations. */
  onPrice(midRaw: bigint): void
  stop(): void
}

const usd = (raw: bigint) => Number(raw) / 1e18

/** Paper-trades against the live mid using the protocol's fee and mint formulas. Never touches the relayer. */
export class DryRunExecutor implements Executor {
  readonly mode = 'dry'
  readonly #inst: Instrument
  readonly #impact: ImpactParams
  readonly #rate: () => number
  readonly #positions = new Map<string, Position>()
  #closed: ClosedLeg[] = []
  #seq = 0

  constructor(inst: Instrument, impact: ImpactParams, rate: () => number) {
    this.#inst = inst
    this.#impact = impact
    this.#rate = rate
  }

  async submitOpen(req: OpenRequest, midRaw: bigint) {
    const n = ++this.#seq
    const intentId = keccak256(toHex(`dry-open-${Date.now()}-${n}`))
    const positionId = `dry-${n}`
    this.#positions.set(positionId, {
      positionId,
      instrumentId: req.inst.id,
      isLong: req.isLong,
      useDebt: false,
      entryPriceRaw: midRaw,
      marginRaw: req.marginRaw,
      leverage: req.leverage,
      bustPriceRaw: bustPriceRaw(midRaw, req.leverage, req.isLong, req.inst.bustBufferRaw),
      openedAtMs: Date.now(),
      intentId,
    })
    return { intentId, deadline: deadlineFromNow(INTENT_TTL_SEC) }
  }

  async submitClose(positionIds: string[], midRaw: bigint) {
    for (const id of positionIds) {
      const p = this.#positions.get(id)
      if (p) this.#settle(p, midRaw, false)
    }
    return [{ intentId: keccak256(toHex(`dry-close-${Date.now()}-${++this.#seq}`)), deadline: deadlineFromNow(INTENT_TTL_SEC) }]
  }

  async waitForPosition(intentId: Hex) {
    return [...this.#positions.values()].find((p) => p.intentId === intentId) ?? null
  }

  positions() {
    return this.#positions
  }

  availableUsd() {
    return null
  }

  failedIntents() {
    return new Set<Hex>()
  }

  drainClosed() {
    const out = this.#closed
    this.#closed = []
    return out
  }

  onPrice(midRaw: bigint) {
    for (const p of [...this.#positions.values()]) {
      if (p.isLong ? midRaw <= p.bustPriceRaw : midRaw >= p.bustPriceRaw) this.#settle(p, midRaw, true)
    }
  }

  stop() {}

  #settle(p: Position, exitRaw: bigint, liquidated: boolean) {
    this.#positions.delete(p.positionId)
    const margin = usd(p.marginRaw)
    const notional = margin * p.leverage
    const move = (Number(exitRaw - p.entryPriceRaw) / Number(p.entryPriceRaw)) * (p.isLong ? 1 : -1)
    const rate = this.#rate()
    let netPnlUsd: number
    let paperMinted = 0
    if (liquidated) {
      netPnlUsd = -margin
      paperMinted = rate * margin
    } else if (move > 0) {
      netPnlUsd = notional * move * winKeep(move, this.#impact)
    } else {
      const loss = Math.min(margin, -notional * move)
      netPnlUsd = -loss
      paperMinted = rate * loss * (1 - LOSS_FEE)
    }
    this.#closed.push({ positionId: p.positionId, netPnlUsd, paperMinted, liquidated })
  }
}

const FAILED_OUTCOMES = new Set(['failed', 'expired', 'cancelled'])

/** Signs intents with the session key and sends them through Papertrade's relayer; reads fills from the account stream. */
export class LiveExecutor implements Executor {
  readonly mode = 'live'
  readonly #wallet: Address
  readonly #session: LocalAccount
  readonly #stream: AccountStream
  readonly #nonces: NonceSource
  readonly #failed = new Set<Hex>()
  #closed: ClosedLeg[] = []

  constructor(wallet: Address, session: LocalAccount, stream: AccountStream, nonces: NonceSource) {
    this.#wallet = wallet
    this.#session = session
    this.#stream = stream
    this.#nonces = nonces
    stream.onFrame(({ closed, outcomes }) => {
      for (const o of outcomes) if (FAILED_OUTCOMES.has(o.outcome)) this.#failed.add(o.intentId)
      for (const c of closed) {
        this.#closed.push({
          positionId: c.positionId,
          netPnlUsd: usd(c.netPnlRaw),
          paperMinted: usd(c.paperMintedRaw),
          liquidated: c.liquidated,
        })
      }
    })
  }

  async submitOpen(req: OpenRequest) {
    const deadline = deadlineFromNow(INTENT_TTL_SEC)
    const { signed, intentId } = await signIntent(this.#session, EXCHANGE_DOMAIN, 'OpenPosition', {
      user: this.#wallet,
      instrumentId: req.inst.id,
      isLong: req.isLong,
      size: req.marginRaw,
      leverage: req.leverage,
      useDebt: false,
      nonce: this.#nonces.take(),
      deadline,
    })
    await submitIntent('openPosition', signed, intentId)
    return { intentId, deadline }
  }

  async submitClose(positionIds: string[]) {
    const sent: SentIntent[] = []
    for (let i = 0; i < positionIds.length; i += MAX_CLOSE_IDS) {
      const ids = positionIds.slice(i, i + MAX_CLOSE_IDS)
      const deadline = deadlineFromNow(INTENT_TTL_SEC)
      const { signed, intentId } = await signIntent(this.#session, EXCHANGE_DOMAIN, 'Close', {
        user: this.#wallet,
        positionIds: ids.map(BigInt),
        nonce: this.#nonces.take(),
        deadline,
      })
      await submitIntent('closePositions', signed, intentId)
      sent.push({ intentId, deadline })
    }
    return sent
  }

  async waitForPosition(intentId: Hex, timeoutMs: number) {
    const id = intentId.toLowerCase()
    try {
      return await this.#stream.waitFor((s) => {
        if (this.#failed.has(intentId)) return null
        for (const p of s.positions.values()) if (p.intentId?.toLowerCase() === id) return p
        return undefined
      }, timeoutMs)
    } catch {
      return null
    }
  }

  positions() {
    return this.#stream.state?.positions ?? new Map<string, Position>()
  }

  availableUsd() {
    const s = this.#stream.state
    return s ? usd(s.availableBalance) : null
  }

  failedIntents() {
    return this.#failed
  }

  drainClosed() {
    const out = this.#closed
    this.#closed = []
    return out
  }

  onPrice() {}

  stop() {
    this.#stream.stop()
  }
}
