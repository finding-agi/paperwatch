import type { Instrument, ProtocolSummary } from './api.ts'

export const WIN_FEE = 0.02
export const LOSS_FEE = 0.02 // carved from the LP's side; PAPER mints on loss × (1 − fee) while the queue is empty
export const DEADBAND = 1 / 50_000 // wins are measured as if the exit were 0.2 bp worse

export type ImpactParams = { baseRate: number; rateMultiplier: number; positionMultiplier: number; referenceNotional: number }

const wad = (x: bigint) => Number(x) / 1e18

export const impactParams = (i: Instrument): ImpactParams => ({
  baseRate: wad(i.baseRateRaw),
  rateMultiplier: wad(i.rateMultiplierRaw),
  positionMultiplier: wad(i.positionMultiplierRaw),
  referenceNotional: wad(i.referenceNotionalRaw),
})

/** Fraction of a winning close's raw gain that is actually paid: deadband, then impact haircut, then 2% win fee. */
export function winKeep(move: number, p: ImpactParams): number {
  const m = move - DEADBAND
  if (m <= 0) return 0
  const term1 = 1 / (m * p.rateMultiplier)
  const term2 = p.referenceNotional / (1e6 * m * p.positionMultiplier)
  return (m / move) * ((1 - p.baseRate) / (1 + term1 + term2)) * (1 - WIN_FEE)
}

/** Marginal PAPER per $1 of loss basis: flat below the cliff, then 100·(S/(S+H))² with H the one-way tail high-water mark. */
export function mintRate(s: Pick<ProtocolSummary, 'trackedLpUsd' | 'tailProgressUsd' | 'flatRate' | 'cliffUsd' | 'decayUsd'>): number {
  if (s.trackedLpUsd < s.cliffUsd) return s.flatRate
  return s.flatRate * (s.decayUsd / (s.decayUsd + s.tailProgressUsd)) ** 2
}

/** Expected economics of one pair reset at `move`: haircut cost and PAPER per $1 of realized loss. */
export function pairCycle(move: number, p: ImpactParams, rate: number) {
  const cost = 1 - winKeep(move, p)
  const paper = rate * (1 - LOSS_FEE)
  return { costPerLossUsd: cost, paperPerLossUsd: paper, costPerPaper: cost / paper }
}
