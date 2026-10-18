import type { Instrument } from './api.ts'
import { WAD } from './config.ts'

/** Hard-bust trigger price, same integer math as the frontend: zero-equity price pulled toward entry by the bust buffer. */
export function bustPriceRaw(entryRaw: bigint, leverage: number, isLong: boolean, bufferRaw: bigint): bigint {
  const step = entryRaw / BigInt(leverage)
  const zero = isLong ? entryRaw - step : entryRaw + step
  return isLong ? zero + (zero * bufferRaw) / WAD : zero - (zero * bufferRaw) / WAD
}

const UNCAPPED = new Set([(1n << 128n) - 1n, (1n << 256n) - 1n])

/**
 * USD notional a new position on one side can add before the relayer rejects it. The limit is the side's cap, or
 * the other side's OI plus the max net OI, whichever is lower (same rule as the frontend order ticket).
 */
export function sideHeadroomUsd(inst: Instrument, isLong: boolean, maxNetOiRaw: bigint, midRaw: bigint): number {
  const own = isLong ? inst.longOiRaw : inst.shortOiRaw
  const other = isLong ? inst.shortOiRaw : inst.longOiRaw
  const cap = isLong ? inst.longCapRaw : inst.shortCapRaw
  const netLimit = maxNetOiRaw > 0n ? other + (maxNetOiRaw * inst.priceScale) / midRaw : null
  const limit = cap > 0n && !UNCAPPED.has(cap) && (netLimit === null || cap < netLimit) ? cap : netLimit
  if (limit === null) return Infinity
  const room = limit > own ? limit - own : 0n
  return Number((room * midRaw) / inst.priceScale) / 1e18
}

/** USD value of an instrument's net (long − short) open interest; positive means traders are net long. */
export function netExposureUsd(inst: Instrument, midRaw: bigint): number {
  return (Number(inst.longOiRaw - inst.shortOiRaw) / 1e18) * (Number(midRaw) / Number(inst.priceScale))
}

/**
 * Rough price move (as a fraction) that would leave the LP unable to pay winners, so new wins start queueing.
 * Conservative: assumes every market moves together in the traders' favour and ignores the win haircut.
 */
export function queueTriggerMove(lpUsd: number, markets: Array<{ inst: Instrument; midRaw: bigint }>): number {
  const net = markets.reduce((sum, m) => sum + Math.abs(netExposureUsd(m.inst, m.midRaw)), 0)
  return net === 0 ? Infinity : Math.max(lpUsd, 0) / net
}
