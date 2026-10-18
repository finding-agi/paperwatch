import { decodeAbiParameters, encodeAbiParameters, type PublicClient } from 'viem'
import type { Instrument } from './api.ts'
import { BBO_PRECOMPILE, USER_AGENT } from './config.ts'

const HL_INFO_URL = process.env.PT_HL_INFO_URL || 'https://api.hyperliquid.xyz/info'

/** Decimal price string -> raw integer at the instrument's price scale, truncated like the contract's integer mid. */
export function toPriceRaw(px: string, priceScale: bigint): bigint {
  const decimals = String(priceScale).length - 1
  const [whole, frac = ''] = px.split('.')
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals))
}

/**
 * Mids for every instrument in one request to Hyperliquid's info API: the same book the BBO precompile reads, and
 * far cheaper than the public HyperEVM RPC, which rate-limits per-tick precompile calls.
 */
export async function readMids(instruments: Instrument[]): Promise<Map<number, bigint>> {
  const res = await fetch(HL_INFO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ type: 'allMids' }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`hyperliquid allMids HTTP ${res.status}`)
  const mids = (await res.json()) as Record<string, string>
  const out = new Map<number, bigint>()
  for (const inst of instruments) {
    const px = mids[inst.symbol]
    if (!px) throw new Error(`hyperliquid has no mid for ${inst.symbol}`)
    out.set(inst.id, toPriceRaw(px, inst.priceScale))
  }
  return out
}

export type Bbo = { bid: bigint; ask: bigint; mid: bigint }

/** Read Hyperliquid's BBO the same way PriceOracle does; mid is the integer midpoint the Exchange executes at. */
export async function readBbo(client: PublicClient, assetIndex: number): Promise<Bbo> {
  const { data } = await client.call({
    to: BBO_PRECOMPILE,
    data: encodeAbiParameters([{ type: 'uint32' }], [assetIndex]),
  })
  if (!data) throw new Error(`BBO precompile returned no data for asset ${assetIndex}`)
  const [bid, ask] = decodeAbiParameters([{ type: 'uint64' }, { type: 'uint64' }], data)
  // PriceOracle reverts on these too, so the Exchange would reject trades as well.
  if (bid === 0n || ask === 0n || ask < bid) throw new Error(`bad BBO for asset ${assetIndex}: ${bid}/${ask}`)
  return { bid, ask, mid: (bid + ask) / 2n }
}
