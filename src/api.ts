import type { Hex } from 'viem'
import { API_URL, USER_AGENT } from './config.ts'
import type { SignedIntent } from './eip712.ts'

export type IntentAction = 'registerSessionKey' | 'openPosition' | 'closePositions'

export class RelayerError extends Error {
  readonly status: number
  readonly code: string
  readonly reason: string
  readonly payload: unknown
  constructor(status: number, payload: unknown) {
    const p = (payload ?? {}) as Record<string, unknown>
    const code =
      typeof p.code === 'string' ? p.code : typeof p.error === 'string' ? p.error : status === 429 ? 'rate_limited' : 'request_failed'
    const reason = typeof p.reason === 'string' ? p.reason : ''
    const message = typeof p.message === 'string' ? p.message : ''
    super(`relayer ${status} ${code}${reason ? `/${reason}` : ''}${message ? `: ${message}` : ''}`)
    this.status = status
    this.code = code
    this.reason = reason
    this.payload = payload
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(API_URL + path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    redirect: 'error',
    signal: AbortSignal.timeout(init.timeoutMs ?? 10_000),
  })
  const body = (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok || body.error || body.ok === false) throw new RelayerError(res.status, body)
  return body as T
}

export type Instrument = {
  id: number
  symbol: string
  assetIndex: number
  priceScale: bigint
  openable: boolean
  retired: boolean
  closeOnly: boolean
  rateMultiplierRaw: bigint
  positionMultiplierRaw: bigint
  maxLeverage: number
  maxPositionNotionalRaw: bigint
  bustBufferRaw: bigint
  baseRateRaw: bigint
  referenceNotionalRaw: bigint
  longOiRaw: bigint
  shortOiRaw: bigint
  longCapRaw: bigint
  shortCapRaw: bigint
}

export type TradingState = {
  indexedThroughBlock: number
  tradingPaused: boolean
  minimumTradeSizeRaw: bigint
  minimumOpenNotionalRaw: bigint
  maxNetOpenInterestRaw: bigint
  pausedActions: string[]
  instruments: Instrument[]
}

// Tuple layout from the frontend's trading-state decoder.
export function parseInstrument(t: unknown[]): Instrument {
  const big = (i: number) => BigInt(t[i] as string)
  const active = t[4] as boolean
  const paused = t[5] as boolean
  return {
    id: t[0] as number,
    symbol: t[1] as string,
    assetIndex: t[2] as number,
    priceScale: big(3),
    openable: active && !paused,
    retired: t[7] as boolean,
    closeOnly: t[8] as boolean,
    rateMultiplierRaw: big(12),
    positionMultiplierRaw: big(13),
    maxLeverage: t[14] as number,
    maxPositionNotionalRaw: big(15),
    bustBufferRaw: big(16),
    baseRateRaw: big(17),
    referenceNotionalRaw: big(18),
    longOiRaw: big(19),
    shortOiRaw: big(20),
    longCapRaw: big(21),
    shortCapRaw: big(22),
  }
}

export async function getTradingState(): Promise<TradingState> {
  const raw = await request<{
    indexedThroughBlock: number
    tradingPaused: boolean
    minimumTradeSizeRaw: string
    minimumOpenNotionalRaw: string
    instruments: unknown[][]
    intake?: [number, string, string, string[]]
    intakeControls?: [number, string, string[]]
  }>('/state/trading')
  // Old shape: intake = [revision, min PAPER stake, max net OI, paused actions]. Since 2026-10-15 ~01:36 UTC:
  // intakeControls = [revision, min PAPER stake, paused actions], with no net-OI limit (0 = only the per-side caps).
  const paused = raw.intakeControls?.[2] ?? raw.intake?.[3]
  if (!paused) throw new Error('/state/trading has neither intake nor intakeControls')
  return {
    indexedThroughBlock: raw.indexedThroughBlock,
    tradingPaused: raw.tradingPaused,
    minimumTradeSizeRaw: BigInt(raw.minimumTradeSizeRaw),
    minimumOpenNotionalRaw: BigInt(raw.minimumOpenNotionalRaw),
    maxNetOpenInterestRaw: raw.intakeControls ? 0n : BigInt(raw.intake![2]),
    pausedActions: paused,
    instruments: raw.instruments.map(parseInstrument),
  }
}

export type ProtocolSummary = {
  block: number
  lpUsd: number
  queueUsd: number
  tvlUsd: number
  volumeUsd: number
  trackedLpUsd: number
  tailProgressUsd: number
  flatRate: number
  cliffUsd: number
  capUsd: number
  decayUsd: number
  paperSupply: number
  paperStaked: number
}

const wad = (s: string) => Number(BigInt(s)) / 1e18

export async function getProtocolSummary(): Promise<ProtocolSummary> {
  const r = await request<{
    source: { block: string }
    balances: Record<string, string>
    activity: { volume: string }
    paper: Record<string, string>
  }>('/query/protocol/summary')
  return {
    block: Number(r.source.block),
    lpUsd: wad(r.balances.lp),
    queueUsd: wad(r.balances.queue),
    tvlUsd: wad(r.balances.tvl),
    volumeUsd: wad(r.activity.volume),
    trackedLpUsd: wad(r.paper.trackedLp),
    tailProgressUsd: wad(r.paper.tailProgress),
    flatRate: wad(r.paper.rate),
    cliffUsd: wad(r.paper.cliff),
    capUsd: wad(r.paper.cap),
    decayUsd: wad(r.paper.decay),
    paperSupply: wad(r.paper.supply),
    paperStaked: wad(r.paper.staked),
  }
}

export const relayerHealth = () =>
  request<{ ok: boolean; ready: boolean; databaseReady: boolean; pricesReady: boolean }>('/relayer/health')

export type IntentAck = { intentId: Hex; action: string; state: string; queueRevision?: string }
const ACCEPTED_STATES = new Set(['queued', 'prepared', 'confirmed'])

export async function submitIntent(action: IntentAction, signed: SignedIntent, expectedIntentId: Hex): Promise<IntentAck> {
  const ack = await request<IntentAck>('/intents', { body: { action, signed }, timeoutMs: 35_000 })
  if (ack.intentId?.toLowerCase() !== expectedIntentId.toLowerCase()) {
    throw new Error(`relayer acknowledged a different intent (${ack.intentId}, expected ${expectedIntentId})`)
  }
  if (!ACCEPTED_STATES.has(ack.state)) throw new Error(`relayer did not accept ${action}: state=${ack.state}`)
  return ack
}
