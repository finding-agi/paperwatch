import { getProtocolSummary, getTradingState } from './api.ts'
import { USER_AGENT, loadStrategyConfig } from './config.ts'
import { LOSS_FEE, impactParams, mintRate, winKeep, type ImpactParams } from './fees.ts'
import { pct, usd } from './bot.ts'

const HL_INFO_URL = process.env.PT_HL_INFO_URL || 'https://api.hyperliquid.xyz/info'

export type Candle = { t: number; o: number; h: number; l: number; c: number }

// Hyperliquid only keeps the latest ~5000 candles per interval, so longer windows need coarser candles.
export const intervalFor = (days: number) => (days <= 3.4 ? '1m' : days <= 17 ? '5m' : '15m')
const INTERVAL_MS: Record<string, number> = { '1m': 60_000, '5m': 300_000, '15m': 900_000 }

export async function fetchCandles(coin: string, days: number): Promise<Candle[]> {
  const interval = intervalFor(days)
  const end = Date.now()
  let start = end - days * 86_400_000
  const out: Candle[] = []
  while (start < end) {
    const res = await fetch(HL_INFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval, startTime: start, endTime: end } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`candleSnapshot HTTP ${res.status}`)
    const batch = (await res.json()) as Array<{ t: number; o: string; h: string; l: string; c: string }>
    if (!batch.length) break
    for (const k of batch) if (!out.length || k.t > out[out.length - 1].t) out.push({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })
    const last = batch[batch.length - 1].t
    if (last <= start) break
    start = last + INTERVAL_MS[interval]
  }
  return out
}

export type SimResult = { resets: number; fastMoves: number; lossUsd: number; costUsd: number; paper: number }

/**
 * Replay one pair of `notional` per leg: close both legs and reopen once either is `resetMove` against entry, filling
 * at the threshold (the bot polls every couple of seconds, so it acts close to the level). A candle that travels
 * several thresholds counts several resets in its dominant direction. `fastMoves` counts candles that went past the
 * bust level from entry: with 1m candles that's the gap risk a slow relayer would turn into a liquidation.
 */
export function simulate(candles: Candle[], resetMove: number, leverage: number, bustBuffer: number, notional: number, impact: ImpactParams, rate: number): SimResult {
  const r: SimResult = { resets: 0, fastMoves: 0, lossUsd: 0, costUsd: 0, paper: 0 }
  if (!candles.length) return r
  const bustMove = 1 / leverage - bustBuffer
  const loss = notional * resetMove
  let entry = candles[0].c
  for (const k of candles) {
    const up = (k.h - entry) / entry
    const down = (entry - k.l) / entry
    const move = Math.max(up, down)
    if (move < resetMove) continue
    if (move >= bustMove) r.fastMoves++
    const goingUp = up >= down
    const steps = Math.max(1, Math.floor(goingUp ? Math.log(1 + up) / Math.log(1 + resetMove) : Math.log(1 - down) / Math.log(1 - resetMove)))
    r.resets += steps
    r.lossUsd += loss * steps
    r.paper += rate * loss * (1 - LOSS_FEE) * steps
    r.costUsd += loss * (1 - winKeep(resetMove, impact)) * steps
    entry *= (goingUp ? 1 + resetMove : 1 - resetMove) ** steps
  }
  return r
}

export async function runBacktest(args: string[]): Promise<void> {
  const cfg = loadStrategyConfig()
  const days = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 7)
  const [trading, summary] = await Promise.all([getTradingState(), getProtocolSummary()])
  const inst = trading.instruments.find((i) => i.symbol === cfg.instrument)!
  const impact = impactParams(inst)
  const bustBuffer = Number(inst.bustBufferRaw) / 1e18
  const rate = mintRate(summary)
  const candles = await fetchCandles(inst.symbol, days)
  const spanDays = (candles[candles.length - 1].t - candles[0].t) / 86_400_000

  console.log(`${inst.symbol} ${intervalFor(days)} candles over ${spanDays.toFixed(1)} days | ${usd(cfg.legNotionalUsd, 0)}/leg | mint rate ${rate.toFixed(2)} PAPER/$ (today's; it keeps decaying)`)
  console.log('  reset   lev   resets/day  fast   cost/day   PAPER/day   $/PAPER   margin/pair')
  for (const move of [0.0025, 0.004, 0.005, 0.0075, 0.01, 0.015, 0.02]) {
    // Highest leverage that still leaves minBustDistance at the reset level, capped by your configured leverage.
    const lev = Math.min(cfg.leverage, Math.floor(1 / (move + bustBuffer + cfg.minBustDistance)))
    const s = simulate(candles, move, lev, bustBuffer, cfg.legNotionalUsd, impact, rate)
    const perDay = (x: number) => x / spanDays
    const mark = move === cfg.resetMove ? '  <- configured' : ''
    console.log(
      `  ${pct(move).padStart(5)}  ${String(lev).padStart(4)}x  ${perDay(s.resets).toFixed(1).padStart(9)}  ${String(s.fastMoves).padStart(4)}  ` +
        `${usd(perDay(s.costUsd)).padStart(9)}  ${perDay(s.paper).toFixed(0).padStart(10)}  ${(s.paper ? usd(s.costUsd / s.paper, 4) : '-').padStart(8)}  ` +
        `${usd((2 * cfg.legNotionalUsd) / lev).padStart(10)}${mark}`,
    )
  }
  console.log('\nfast = candles that moved past the bust level from entry (only meaningful with 1m candles).')
  console.log('Scale cost/day and PAPER/day linearly with notional. Past volatility, not a forecast.')
}

export type RestrikeResult = { restrikes: number; takes: number; lossUsd: number; costUsd: number; paper: number }

/** Price points inside a candle, in the usual intrabar order (down candles visit the high first). */
const pathOf = (k: Candle) => (k.c >= k.o ? [k.o, k.l, k.h, k.c] : [k.o, k.h, k.l, k.c])

/**
 * Replay the restrike ("spread") plan on one pair of `notional` per leg, filling exactly at each level (no intake
 * queue delay; the journal measures that). A leg `restrike` against its own entry is closed alone, its loss mints
 * PAPER with no haircut, and it reopens at that price. Once either leg is `take` in profit, both close (the winner
 * pays the win haircut, the other leg settles at its own move) and a fresh pair opens.
 */
export function simulateRestrike(candles: Candle[], restrike: number, take: number, notional: number, impact: ImpactParams, rate: number): RestrikeResult {
  const r: RestrikeResult = { restrikes: 0, takes: 0, lossUsd: 0, costUsd: 0, paper: 0 }
  if (!candles.length) return r
  let longEntry = candles[0].o
  let shortEntry = candles[0].o
  // Settles one leg at `move` (its own direction): a loss mints PAPER, a win is paid after the haircut.
  const settle = (move: number) => {
    if (move < 0) {
      const loss = -move * notional
      r.lossUsd += loss
      r.costUsd += loss
      r.paper += rate * loss * (1 - LOSS_FEE)
    } else {
      r.costUsd -= move * notional * winKeep(move, impact)
    }
  }
  let px = candles[0].o
  for (const k of candles) {
    for (const target of pathOf(k)) {
      // Walk toward `target`, stopping at every level crossed on the way.
      for (;;) {
        if (target > px) {
          const shortHit = shortEntry * (1 + restrike)
          const takeHit = longEntry * (1 + take)
          const next = Math.min(shortHit, takeHit)
          if (next > target) break
          px = next
          if (takeHit <= shortHit) {
            settle(take)
            settle((shortEntry - px) / shortEntry)
            r.takes++
            longEntry = shortEntry = px
          } else {
            settle(-restrike)
            r.restrikes++
            shortEntry = px
          }
        } else {
          const longHit = longEntry * (1 - restrike)
          const takeHit = shortEntry * (1 - take)
          const next = Math.max(longHit, takeHit)
          if (next < target) break
          px = next
          if (takeHit >= longHit) {
            settle(take)
            settle((px - longEntry) / longEntry)
            r.takes++
            longEntry = shortEntry = px
          } else {
            settle(-restrike)
            r.restrikes++
            longEntry = px
          }
        }
      }
      px = target
    }
  }
  return r
}

export async function runRestrikeBacktest(args: string[]): Promise<void> {
  const cfg = loadStrategyConfig()
  const days = Number(args.find((a) => a.startsWith('--days='))?.slice(7) ?? 3.4)
  const [trading, summary] = await Promise.all([getTradingState(), getProtocolSummary()])
  const inst = trading.instruments.find((i) => i.symbol === cfg.instrument)!
  const impact = impactParams(inst)
  const rate = mintRate(summary)
  const candles = await fetchCandles(inst.symbol, days)
  const spanDays = (candles[candles.length - 1].t - candles[0].t) / 86_400_000
  const perDay = (x: number) => x / spanDays

  console.log(`${inst.symbol} ${intervalFor(days)} candles over ${spanDays.toFixed(1)} days | ${usd(cfg.legNotionalUsd, 0)}/leg | mint rate ${rate.toFixed(2)} PAPER/$ (today's)`)
  console.log('restrike = close the losing leg this far against its entry; take = close both once a leg is this far ahead.')
  console.log('  restrike  take   restrikes/d  takes/d   cost/day   PAPER/day   $/PAPER')
  const rows: Array<{ x: number; t: number; s: RestrikeResult }> = []
  for (const x of [0.0005, 0.001, 0.0015, 0.002, 0.003]) {
    for (const t of [0.002, 0.003, 0.004, 0.006, 0.008]) rows.push({ x, t, s: simulateRestrike(candles, x, t, cfg.legNotionalUsd, impact, rate) })
  }
  const best = rows.reduce((a, b) => (b.s.paper && b.s.costUsd / b.s.paper < a.s.costUsd / a.s.paper ? b : a))
  for (const { x, t, s } of rows) {
    console.log(
      `  ${pct(x).padStart(7)}  ${pct(t, 1).padStart(5)}  ${perDay(s.restrikes).toFixed(1).padStart(10)}  ${perDay(s.takes).toFixed(1).padStart(7)}  ` +
        `${usd(perDay(s.costUsd)).padStart(9)}  ${perDay(s.paper).toFixed(0).padStart(10)}  ${(s.paper ? usd(s.costUsd / s.paper, 4) : '-').padStart(8)}` +
        `${x === best.x && t === best.t ? '  <- cheapest PAPER' : ''}`,
    )
  }
  // The pair-reset strategy at the same take level, for comparison.
  console.log('\nFor comparison, plain pair reset (close both at the level, no restrikes):')
  const bustBuffer = Number(inst.bustBufferRaw) / 1e18
  for (const move of [0.002, 0.003, 0.004]) {
    const s = simulate(candles, move, cfg.leverage, bustBuffer, cfg.legNotionalUsd, impact, rate)
    console.log(`  reset ${pct(move, 1).padStart(5)}: ${perDay(s.paper).toFixed(0)} PAPER/day for ${usd(perDay(s.costUsd))}/day = ${s.paper ? usd(s.costUsd / s.paper, 4) : '-'}/PAPER`)
  }
  console.log('\nFills are exact at each level here. Real closes wait in the intake queue; compare with the LEG lines.')
  console.log('Scale cost/day and PAPER/day linearly with notional. Past volatility, not a forecast.')
}
