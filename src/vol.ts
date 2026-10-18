import { getTradingState } from './api.ts'
import { USER_AGENT, loadStrategyConfig } from './config.ts'
import { fetchCandles, intervalFor, type Candle } from './backtest.ts'
import { pct, usd } from './bot.ts'

/**
 * Volatility for leverage. The risk leverage has to cover is the move that happens while a close sits in the relayer:
 * once a leg is `resetMove` against entry we submit the close, and the price keeps going until it fills (80s to 5 min
 * seen live). So the target is the adverse excursion over that horizon, and every estimator here is scored on how
 * well it predicts that excursion, not on how it describes the past.
 */

const MIN_PER_YEAR = 365 * 1440
const PARK = 1 / (4 * Math.log(2))
const DERIBIT_URL = 'https://www.deribit.com/api/v2/public/get_volatility_index_data'

export type LeverageParams = {
  horizonMin: number
  tailZ: number
  resetMove: number
  bustBuffer: number
  minBustDistance: number
  levMin: number
  levMax: number
  // Slack always kept for a jump out of a calm market, which no volatility estimate sees coming. The worst seen in
  // 17 days of resets was 3.16% further during the close (Oct 7 01:55 UTC, with 5-min sigma at a normal 0.15%).
  jumpFloor: number
}

/** Room left to liquidation once a leg has hit the reset move: 1/lev - bust buffer - reset move. */
export const slackAt = (lev: number, p: Pick<LeverageParams, 'bustBuffer' | 'resetMove'>) => 1 / lev - p.bustBuffer - p.resetMove

/**
 * Highest leverage whose slack covers `tailZ` sigmas of move over the close horizon and the jump floor, clamped to
 * [levMin, levMax]. With the floor in place, volatility can only take leverage down from the floor's level.
 */
export function volLeverage(sigmaPerMin: number, p: LeverageParams): number {
  const need = Math.max(p.minBustDistance, p.jumpFloor, p.tailZ * sigmaPerMin * Math.sqrt(p.horizonMin))
  const lev = Math.floor(1 / (p.bustBuffer + p.resetMove + need))
  return Math.max(p.levMin, Math.min(p.levMax, lev))
}

// ---- estimators: per-minute sigma at the close of each 1m candle, using only candles up to and including it ----

type Series = Float64Array

/** Squared log close-to-close returns (index 0 has no prior close). */
function closeVar(k: Candle[]): Series {
  const x = new Float64Array(k.length)
  for (let i = 1; i < k.length; i++) x[i] = Math.log(k[i].c / k[i - 1].c) ** 2
  return x
}

/** Parkinson per-candle variance from the high-low range: uses the path inside the minute, not just its endpoints. */
function rangeVar(k: Candle[]): Series {
  const x = new Float64Array(k.length)
  for (let i = 0; i < k.length; i++) x[i] = PARK * Math.log(k[i].h / k[i].l) ** 2
  return x
}

function rolling(x: Series, n: number): Series {
  n = Math.max(1, Math.round(n))
  const out = new Float64Array(x.length).fill(NaN)
  let s = 0
  for (let i = 0; i < x.length; i++) {
    s += x[i]
    if (i >= n) {
      s -= x[i - n]
      out[i] = Math.sqrt(Math.max(0, s) / n)
    }
  }
  return out
}

function ewma(x: Series, halfLifeMin: number): Series {
  const out = new Float64Array(x.length).fill(NaN)
  const a = 1 - 2 ** (-1 / halfLifeMin) // half-life in candles
  let v = x[1]
  for (let i = 1; i < x.length; i++) {
    v += a * (x[i] - v)
    if (i >= 3 * halfLifeMin) out[i] = Math.sqrt(v)
  }
  return out
}

const maxOf = (...s: Series[]) => s[0].map((_, i) => Math.max(...s.map((x) => x[i])))

/** Deribit's ETH DVOL (30-day implied vol, annualized %) forward-filled onto the candles, as per-minute sigma. */
function impliedSeries(k: Candle[], dvol: Array<[number, number]>, stepMin: number): Series {
  const out = new Float64Array(k.length).fill(NaN)
  let j = -1
  for (let i = 0; i < k.length; i++) {
    while (j + 1 < dvol.length && dvol[j + 1][0] <= k[i].t + (stepMin - 1) * 60_000) j++
    if (j >= 0 && k[i].t - dvol[j][0] < 10 * 60_000) out[i] = dvol[j][1] / 100 / Math.sqrt(MIN_PER_YEAR)
  }
  return out
}

/** Every estimator as per-minute sigma; windows are in minutes and `stepMin` is the candle size. */
export function estimators(k: Candle[], dvol: Array<[number, number]>, stepMin = 1): Array<{ name: string; sigma: Series }> {
  const perMin = (s: Series) => s.map((x) => x / Math.sqrt(stepMin))
  const cv = closeVar(k)
  const rv = rangeVar(k)
  const roll = (x: Series, min: number) => perMin(rolling(x, min / stepMin))
  const park30 = roll(rv, 30)
  const park240 = roll(rv, 240)
  const close4h = roll(cv, 240)
  const implied = impliedSeries(k, dvol, stepMin)
  return [
    { name: 'close 15m', sigma: roll(cv, 15) },
    { name: 'close 60m', sigma: roll(cv, 60) },
    { name: 'close 4h', sigma: close4h },
    { name: 'close 24h', sigma: roll(cv, 1440) },
    { name: 'range 30m', sigma: park30 },
    { name: 'range 4h', sigma: park240 },
    { name: 'ewma range hl15', sigma: perMin(ewma(rv, 15 / stepMin)) },
    { name: 'ewma close hl60', sigma: perMin(ewma(cv, 60 / stepMin)) },
    { name: 'max(range 30m, 4h)', sigma: maxOf(park30, park240) },
    { name: 'implied (DVOL)', sigma: implied },
    { name: 'max(close 4h, DVOL)', sigma: maxOf(close4h, implied) },
  ]
}

// ---- data ----

/** Hyperliquid candles without the one still forming: 1m up to ~3.4 days back, 5m up to ~17. */
export async function fetchVolCandles(coin: string, days: number): Promise<{ k: Candle[]; stepMin: number }> {
  const stepMin = intervalFor(days) === '1m' ? 1 : intervalFor(days) === '5m' ? 5 : 15
  const k = await fetchCandles(coin, days)
  while (k.length && k[k.length - 1].t + stepMin * 60_000 > Date.now()) k.pop()
  return { k, stepMin }
}

export async function fetchDvol(currency: string, fromMs: number): Promise<Array<[number, number]>> {
  const byTs = new Map<number, number>()
  let end = Date.now()
  while (end > fromMs) {
    const url = `${DERIBIT_URL}?currency=${currency}&resolution=60&start_timestamp=${fromMs}&end_timestamp=${end}`
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`deribit DVOL HTTP ${res.status}`)
    const { result } = (await res.json()) as { result: { data: number[][]; continuation: number | null } }
    for (const [t, , , , c] of result.data) byTs.set(t, c)
    if (!result.continuation || !result.data.length || result.continuation >= end) break
    end = result.continuation
  }
  return [...byTs].sort((a, b) => a[0] - b[0])
}

// ---- scoring ----

/** Largest move either way over the next `h` candles, from candle i's close. */
export function excursion(k: Candle[], i: number, h: number): number {
  let hi = -Infinity
  let lo = Infinity
  for (let j = i + 1; j <= i + h && j < k.length; j++) {
    hi = Math.max(hi, k[j].h)
    lo = Math.min(lo, k[j].l)
  }
  return Math.max(hi / k[i].c - 1, 1 - lo / k[i].c)
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

/**
 * Reset events from the pair strategy: each time price is `resetMove` from the entry, measure how much further it went
 * in the same direction (the losing leg's direction) over the close horizon, from the reset level. The bot only knows
 * the candles before the one that triggered, so the forecast uses i - 1.
 */
export function resetEvents(k: Candle[], resetMove: number, h: number) {
  const out: Array<{ i: number; up: boolean; adverse: number }> = []
  let entry = k[0]?.c
  for (let i = 1; i < k.length - h; i++) {
    const up = k[i].h >= entry * (1 + resetMove)
    const down = k[i].l <= entry * (1 - resetMove)
    if (!up && !down) continue
    const goingUp = up && (!down || k[i].h / entry - 1 >= 1 - k[i].l / entry)
    const level = entry * (goingUp ? 1 + resetMove : 1 - resetMove)
    let worst = 0
    for (let j = i; j <= i + h; j++) worst = Math.max(worst, goingUp ? k[j].h / level - 1 : 1 - k[j].l / level)
    out.push({ i, up: goingUp, adverse: worst })
    // The close fills about h minutes later and the bot reopens at the price then.
    entry = k[i + h].c
    i += h
  }
  return out
}

type Score = {
  name: string
  n: number
  k: number // tail multiplier calibrated on the first half
  qlike: number
  tailRatio: number // 99.9th / median of move-in-sigmas: how fat the tails look through this estimator
  breaches: number
  tested: number
  avgNeed: number // average buffer needed on the test half
  avgLev: number
  atMax: number
  eventZ: number // worst reset-event excursion in sigmas
  eventBreaches: number
}

export function scoreEstimators(
  k: Candle[],
  ests: Array<{ name: string; sigma: Series }>,
  p: LeverageParams,
  quantileTarget: number,
  stepMin = 1,
): { scores: Score[]; events: ReturnType<typeof resetEvents> } {
  const h = Math.ceil(p.horizonMin / stepMin)
  const exc = k.map((_, i) => (i + h < k.length ? excursion(k, i, h) : NaN))
  // Realized per-minute variance over the next hour, for QLIKE (the standard loss for ranking variance forecasts).
  const cv = closeVar(k)
  const hour = 60 / stepMin
  const fwd = new Float64Array(k.length).fill(NaN)
  for (let i = 0; i + hour < k.length; i++) {
    let s = 0
    for (let j = i + 1; j <= i + hour; j++) s += cv[j]
    fwd[i] = s / 60
  }
  const events = resetEvents(k, p.resetMove, h)
  const half = Math.floor(k.length / 2)
  const scores: Score[] = []
  for (const { name, sigma } of ests) {
    const valid = (i: number) => Number.isFinite(sigma[i]) && sigma[i] > 0 && Number.isFinite(exc[i])
    const ratio = (i: number) => exc[i] / (sigma[i] * Math.sqrt(p.horizonMin))
    const train: number[] = []
    for (let i = 0; i < half; i++) if (valid(i)) train.push(ratio(i))
    const tailZ = quantile(train, quantileTarget)
    // Bias, fitted on the first half: QLIKE punishes a forecast that is consistently low, which the tail multiplier
    // already absorbs for leverage, so each estimator is rescaled before it's scored.
    let bias = 0
    let bn = 0
    for (let i = 0; i < half; i++) if (valid(i) && fwd[i] > 0) (bias += fwd[i] / sigma[i] ** 2), bn++
    bias /= bn
    const all: number[] = []
    let n = 0
    let ql = 0
    let qn = 0
    let breaches = 0
    let tested = 0
    let need = 0
    let lev = 0
    let atMax = 0
    for (let i = 0; i < k.length; i++) {
      if (!valid(i)) continue
      n++
      all.push(ratio(i))
      if (fwd[i] > 0 && i >= half) {
        const r = fwd[i] / (bias * sigma[i] ** 2)
        ql += r - Math.log(r) - 1
        qn++
      }
      if (i < half) continue
      const L = volLeverage(sigma[i], { ...p, tailZ })
      tested++
      need += tailZ * sigma[i] * Math.sqrt(p.horizonMin)
      lev += L
      if (L === p.levMax) atMax++
      if (exc[i] > slackAt(L, p)) breaches++
    }
    let eventZ = 0
    let eventBreaches = 0
    for (const e of events) {
      const s = sigma[e.i - 1]
      if (!(s > 0)) continue
      eventZ = Math.max(eventZ, e.adverse / (s * Math.sqrt(p.horizonMin)))
      if (e.adverse > slackAt(volLeverage(s, { ...p, tailZ }), p)) eventBreaches++
    }
    scores.push({
      name, n, k: tailZ, qlike: ql / qn, tailRatio: quantile(all, quantileTarget) / quantile(all, 0.5), breaches, tested,
      avgNeed: need / tested, avgLev: lev / tested, atMax: atMax / tested, eventZ, eventBreaches,
    })
  }
  return { scores, events }
}

// ---- CLI ----

function flag(args: string[], name: string, fallback: number): number {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  return raw === undefined ? fallback : Number(raw)
}

export const DEFAULT_ESTIMATOR = 'max(close 4h, DVOL)'

export async function runVol(args: string[]): Promise<void> {
  const cfg = loadStrategyConfig()
  const trading = await getTradingState()
  const inst = trading.instruments.find((i) => i.symbol === cfg.instrument)!
  const p: LeverageParams = {
    horizonMin: flag(args, 'horizon', 5), // worst close fill seen live
    tailZ: flag(args, 'z', 6),
    resetMove: cfg.resetMove,
    bustBuffer: Number(inst.bustBufferRaw) / 1e18,
    minBustDistance: cfg.minBustDistance,
    levMin: flag(args, 'min', cfg.leverage),
    levMax: flag(args, 'max', 50),
    jumpFloor: 0,
  }
  const evaluate = args.includes('--eval')
  // The eval compares estimators on their own, so the floor is off there unless asked for.
  p.jumpFloor = flag(args, 'jump', evaluate ? 0 : 0.032)
  const days = flag(args, 'days', evaluate ? 3.4 : 1.1)
  const { k, stepMin } = await fetchVolCandles(inst.symbol, days)
  const dvol = await fetchDvol(inst.symbol, k[0].t - 60 * 60_000).catch((err: unknown) => {
    console.log(`(no DVOL: ${err instanceof Error ? err.message : String(err)})`)
    return [] as Array<[number, number]>
  })
  const ests = estimators(k, dvol, stepMin)
  const last = k.length - 1
  const px = k[last].c
  const sq = Math.sqrt(p.horizonMin)
  const margin = cfg.legNotionalUsd / cfg.leverage

  if (!evaluate) {
    const pick = args.find((a) => a.startsWith('--est='))?.slice(6) ?? DEFAULT_ESTIMATOR
    console.log(`${inst.symbol} ${px} at ${new Date(k[last].t + stepMin * 60_000).toISOString().slice(11, 16)} UTC | close horizon ${p.horizonMin} min | tail ${p.tailZ}σ | jump floor ${pct(p.jumpFloor, 1)} | leverage ${p.levMin}-${p.levMax}x`)
    console.log('  estimator               σ/min   annualized   1σ over horizon     buffer needed   leverage')
    for (const { name, sigma } of ests) {
      const s = sigma[last]
      if (!Number.isFinite(s)) {
        console.log(`  ${name.padEnd(22)}  (not enough data)`)
        continue
      }
      const move = s * sq
      console.log(
        `  ${name.padEnd(22)} ${pct(s, 3).padStart(7)}   ${pct(s * Math.sqrt(MIN_PER_YEAR), 0).padStart(9)}   ` +
          `${pct(move, 3).padStart(7)} (${usd(move * px)})   ${pct(p.tailZ * move, 2).padStart(12)}   ${String(volLeverage(s, p)).padStart(6)}x${name === pick ? '  <-' : ''}`,
      )
    }
    const s = ests.find((e) => e.name === pick)?.sigma[last]
    if (s === undefined) throw new Error(`no estimator named "${pick}"`)
    const L = volLeverage(s, p)
    console.log(`\n${pick}: ${L}x, ${usd(margin * L, 0)}/leg at ${usd(margin)} margin. Slack after a reset: ${pct(slackAt(L, p), 2)}.`)
    console.log('Run with --eval (--days=17 for 5m candles) to score the estimators.')
    return
  }

  const q = flag(args, 'q', 0.999)
  const { scores, events } = scoreEstimators(k, ests, p, q, stepMin)
  const spanDays = (k[last].t - k[0].t) / 86_400_000
  const worst = events.reduce((m, e) => Math.max(m, e.adverse), 0)
  console.log(`${inst.symbol} ${stepMin}m candles over ${spanDays.toFixed(1)} days | close horizon ${p.horizonMin} min | leverage ${p.levMin}-${p.levMax}x`)
  console.log(`Tail multiplier calibrated on the first half at the ${pct(q, 1)} quantile, then tested on the second half.`)
  console.log(`${events.length} reset events at ${pct(p.resetMove)}; worst further move during a close: ${pct(worst, 2)} (${usd(worst * px)}).\n`)
  console.log('  estimator              QLIKE  tail/med   tail z   test breaches   avg buffer   avg lev   at max   event z   event breaches')
  for (const s of [...scores].sort((a, b) => a.qlike - b.qlike)) {
    console.log(
      `  ${s.name.padEnd(21)} ${s.qlike.toFixed(3).padStart(6)}  ${s.tailRatio.toFixed(1).padStart(8)}   ${s.k.toFixed(1).padStart(6)}   ` +
        `${`${s.breaches}/${s.tested}`.padStart(13)}   ${pct(s.avgNeed, 2).padStart(10)}   ${s.avgLev.toFixed(1).padStart(7)}   ` +
        `${pct(s.atMax, 0).padStart(6)}   ${s.eventZ.toFixed(1).padStart(7)}   ${String(s.eventBreaches).padStart(14)}`,
    )
  }
  console.log(`
QLIKE: how well it forecasts the next hour's variance, after removing its average bias (lower is better).
tail/med: ${pct(q, 1)} move over its median, in its own sigmas. Lower = it sees risky periods coming instead of being surprised.
tail z: sigmas of ${p.horizonMin}-min move needed to cover ${pct(q, 1)} of first-half periods; this becomes the safety multiplier.
test breaches: second-half periods where the move would have eaten the slack at the leverage it picked.
avg buffer / avg lev: room to liquidation it reserves, and the leverage it picks (higher at equal breaches = better).
event z / breaches: the same check on actual reset moments (right after a ${pct(p.resetMove)} move), the case that matters.`)
}
