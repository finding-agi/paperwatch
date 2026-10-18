import type { Hex } from 'viem'
import type { StrategyConfig } from './config.ts'

// A pair is one long and one short of the same size on the same instrument. Both legs mark off the same BBO mid,
// so the pair's raw PnL is zero; the only cost is the haircut on whichever leg closes in profit.
//
// Spread mode closes a losing leg on its own once it is restrikeMove against entry and reopens that side at the new
// price ("restrike"). That walks the long's entry below the short's, so when either leg reaches takeMove in profit,
// both close with the pair net positive. The restrike losses mint PAPER with no haircut; only the take pays one.

export type LegRef = {
  intentId: Hex
  isLong: boolean
  marginRaw: bigint
  leverage: number
  deadline: bigint // unix seconds; an unfilled open intent is dead after this
  positionId?: string
  entryPriceRaw?: bigint
  bustPriceRaw?: bigint
  failed?: boolean // open intent rejected, failed or expired
  gone?: boolean // position no longer open (closed or liquidated)
  retiring?: boolean // spread mode: we closed this leg on its own, so its disappearance is expected
  closeIntentId?: Hex // spread mode: this leg's own close while it is in flight (unknown if the relayer already had one)
  closeDeadline?: bigint // unix seconds; that close is dead after this
}

export type PairStatus = 'opening' | 'open' | 'closing' | 'broken'

export type Pair = {
  id: string
  instrumentId: number
  status: PairStatus
  legs: LegRef[]
  createdAtMs: number
  closeRequestedAtMs?: number
  closeReason?: string
}

export type PositionView = { positionId: string; entryPriceRaw: bigint; bustPriceRaw: bigint; intentId: Hex | null }

export type MarketView = {
  midRaw: bigint
  openable: boolean
  headroomLongUsd: number
  headroomShortUsd: number
  queueUsd: number
  queueTriggerMove: number
  adminAlert: boolean
  availableUsd: number | null // null: don't check (dry run)
}

// Kept free on top of both legs' margin, so rounding and a fill a hair off the mid can't leave one leg rejected.
export const BALANCE_RESERVE_USD = 1

export type Decision =
  | { kind: 'close'; pairId: string; positionIds: string[]; reason: string }
  | { kind: 'restrike'; pairId: string; positionId: string; isLong: boolean }
  | { kind: 'reopen'; pairId: string; isLong: boolean }
  | { kind: 'open'; firstIsLong: boolean }
  | { kind: 'idle'; reason: string }

export const isLive = (l: LegRef) => l.positionId !== undefined && !l.gone
const closeInFlight = (l: LegRef) => l.closeDeadline !== undefined

/** How far price has moved against this leg since entry, as a fraction of entry. */
export function adverseMove(leg: LegRef, midRaw: bigint): number {
  const entry = Number(leg.entryPriceRaw)
  const mid = Number(midRaw)
  return leg.isLong ? (entry - mid) / entry : (mid - entry) / entry
}

/** Remaining distance to the hard-bust trigger, as a fraction of the current mid. */
export function bustDistance(leg: LegRef, midRaw: bigint): number {
  const bust = Number(leg.bustPriceRaw)
  const mid = Number(midRaw)
  return leg.isLong ? (mid - bust) / mid : (bust - mid) / mid
}

export function attach(leg: LegRef, p: PositionView): void {
  leg.positionId = p.positionId
  leg.entryPriceRaw = p.entryPriceRaw
  leg.bustPriceRaw = p.bustPriceRaw
}

/**
 * Fold the latest account view into the tracked pairs: attach filled legs, mark failed or vanished ones, advance
 * statuses, and drop pairs with nothing left open. Mutates the pairs and returns the ones still tracked.
 */
export function reconcile(
  pairs: Pair[],
  positions: Map<string, PositionView>,
  failedIntents: Set<Hex>,
  nowMs: number,
  cfg: Pick<StrategyConfig, 'openWaitMs' | 'closeWaitMs'>,
): Pair[] {
  const byIntent = new Map<string, PositionView>()
  for (const p of positions.values()) if (p.intentId) byIntent.set(p.intentId.toLowerCase(), p)

  for (const pair of pairs) {
    for (const leg of pair.legs) {
      if (leg.positionId === undefined) {
        const p = byIntent.get(leg.intentId.toLowerCase())
        if (p) attach(leg, p)
        else if (failedIntents.has(leg.intentId) || nowMs > Number(leg.deadline) * 1000) leg.failed = true
      }
      if (leg.positionId !== undefined && !positions.has(leg.positionId)) leg.gone = true
      // A leg's own close that failed or expired is no longer in flight, so decide() may send another.
      const closeDead = (leg.closeIntentId && failedIntents.has(leg.closeIntentId)) || nowMs > Number(leg.closeDeadline) * 1000
      if (closeInFlight(leg) && !leg.gone && closeDead) {
        delete leg.closeIntentId
        delete leg.closeDeadline
      }
    }

    const filled = pair.legs.filter((l) => l.positionId !== undefined)
    if (pair.status === 'opening') {
      if (filled.length === 2 && filled.every(isLive)) pair.status = 'open'
      else if (pair.legs.some((l) => l.failed || l.gone) || nowMs - pair.createdAtMs > cfg.openWaitMs * 2) pair.status = 'broken'
    } else if (pair.status === 'open') {
      // A leg we closed on purpose is expected to vanish. Anything else (a liquidation, a reopen that failed) breaks
      // the pair; otherwise forget the restruck legs so the pair only tracks what is open or in flight.
      if (pair.legs.some((l) => l.failed || (l.gone && !l.retiring))) pair.status = 'broken'
      else pair.legs = pair.legs.filter((l) => !(l.gone && l.retiring))
    } else if (pair.status === 'closing' && nowMs - (pair.closeRequestedAtMs ?? nowMs) > cfg.closeWaitMs) {
      // Close didn't land in time; hand it back to decide() so it is retried.
      pair.status = pair.legs.some((l) => l.gone) ? 'broken' : 'open'
    }
  }

  const settled = (l: LegRef) => l.gone || l.failed
  return pairs.filter((p) => !(p.status !== 'opening' && p.legs.every(settled)))
}

/** Why a new leg on each of `sides` (true = long) can't be opened right now, or null if it can. */
function openBlocker(mkt: MarketView, cfg: StrategyConfig, spentTodayUsd: number, sides: boolean[], checkBalance = true): string | null {
  if (mkt.adminAlert) return 'admin-alert'
  if (mkt.queueUsd > 0 || mkt.queueTriggerMove < cfg.queueGuardMove) return 'queue-risk'
  if (!mkt.openable) return 'market-closed'
  if (spentTodayUsd >= cfg.maxDailyCostUsd) return 'daily-budget'
  if (sides.some((isLong) => (isLong ? mkt.headroomLongUsd : mkt.headroomShortUsd) < cfg.legNotionalUsd)) return 'oi-headroom'
  // Without room for every leg, one could fill and another bounce, and the bot would pay to unwind it every tick.
  const need = (sides.length * cfg.legNotionalUsd) / cfg.leverage + BALANCE_RESERVE_USD
  if (checkBalance && mkt.availableUsd !== null && mkt.availableUsd < need) return 'low-balance'
  return null
}

/** Spread mode, for an open pair with nothing to flatten: take, reopen a restruck side, or restrike a loser. */
function decideSpread(pair: Pair, legs: LegRef[], mkt: MarketView, cfg: StrategyConfig, spentTodayUsd: number, close: (reason: string) => void): Decision | null {
  // Nothing open, or a reopen is still filling (the open wait breaks the pair if it never does).
  if (!legs.length || pair.legs.some((l) => l.positionId === undefined && !l.failed)) return null
  // Take first, even mid-restrike: it closes everything not already closing, so a restruck side isn't reopened just to close it.
  if (legs.some((l) => -adverseMove(l, mkt.midRaw) >= cfg.takeMove)) {
    close('take')
    return null
  }
  if (legs.some(closeInFlight)) return null
  const missing = [true, false].find((isLong) => !pair.legs.some((l) => l.isLong === isLong && !l.failed && !l.gone))
  if (missing !== undefined) {
    // The restruck leg has closed: reopen that side, or flatten the other leg rather than leave it unhedged.
    const blocked = openBlocker(mkt, cfg, spentTodayUsd, [missing])
    if (!blocked) return { kind: 'reopen', pairId: pair.id, isLong: missing }
    close(`unhedged-${blocked}`)
    return null
  }
  const loser = legs
    .filter((l) => adverseMove(l, mkt.midRaw) >= cfg.restrikeMove)
    .sort((a, b) => adverseMove(b, mkt.midRaw) - adverseMove(a, mkt.midRaw))[0]
  // Only restrike when the side can reopen once the close lands (its margin comes back then, so the balance check
  // waits for the reopen). Otherwise hold: the loser keeps minting on its eventual close and the take still applies.
  if (!loser || openBlocker(mkt, cfg, spentTodayUsd, [loser.isLong], false)) return null
  return { kind: 'restrike', pairId: pair.id, positionId: loser.positionId!, isLong: loser.isLong }
}

export function decide(pairs: Pair[], mkt: MarketView, cfg: StrategyConfig, spentTodayUsd: number): Decision[] {
  const out: Decision[] = []
  const queueRisk = mkt.queueUsd > 0 || mkt.queueTriggerMove < cfg.queueGuardMove

  for (const pair of pairs) {
    if (pair.status === 'opening' || pair.status === 'closing') continue
    const legs = pair.legs.filter(isLive)
    // A leg whose own close is in flight is left out: the relayer refuses a second close for it.
    const closable = legs.filter((l) => !closeInFlight(l))
    const close = (reason: string) => {
      if (closable.length) out.push({ kind: 'close', pairId: pair.id, positionIds: closable.map((l) => l.positionId!), reason })
    }
    if (pair.status === 'broken') close('broken')
    else if (queueRisk) close('queue-guard')
    else if (legs.some((l) => bustDistance(l, mkt.midRaw) <= cfg.minBustDistance)) close('bust-guard')
    else if (cfg.mode === 'pair') {
      if (legs.some((l) => adverseMove(l, mkt.midRaw) >= cfg.resetMove)) close('reset')
    } else {
      const d = decideSpread(pair, legs, mkt, cfg, spentTodayUsd, close)
      if (d) out.push(d)
    }
  }

  if (pairs.length >= cfg.maxPairs) return out
  const blocked = openBlocker(mkt, cfg, spentTodayUsd, [true, false])
  if (blocked) out.push({ kind: 'idle', reason: blocked })
  // Open the tighter side first, so a rejection costs nothing to unwind.
  else out.push({ kind: 'open', firstIsLong: mkt.headroomLongUsd <= mkt.headroomShortUsd })
  return out
}
