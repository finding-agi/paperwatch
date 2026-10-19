// Papertrade's account feed (/state/user/live), shared by the server (src/account.ts) and the browser (/account-frames.js
// on paperwatch.app): applying its frames, the account box the page shows, and whether a trading key is active. Plain
// JavaScript so both can load the same file; the types live in account-frames.d.ts.

export class OutOfSyncError extends Error {}

export function parsePosition(t) {
  return {
    positionId: String(t[0]),
    instrumentId: t[1],
    isLong: t[2],
    useDebt: t[3],
    entryPriceRaw: BigInt(t[4]),
    marginRaw: BigInt(t[5]),
    leverage: t[6],
    bustPriceRaw: BigInt(t[7]),
    openedAtMs: t[8],
    intentId: t[9] ?? null,
  }
}

function parseClosed(t) {
  return {
    positionId: String(t[0]),
    instrumentId: t[1],
    isLong: t[2],
    marginRaw: BigInt(t[3]),
    leverage: t[4],
    liquidated: t[5],
    netPnlRaw: BigInt(t[6]),
    paperMintedRaw: BigInt(t[7]),
  }
}

// Wallet fields shared by snapshots and (partially) by patch `state` objects.
function walletFields(w) {
  const out = {}
  if (w.indexedThroughTimestamp !== undefined) out.indexedThroughTimestamp = w.indexedThroughTimestamp
  if (w.sessionKeys !== undefined) out.sessionKeys = new Map(w.sessionKeys.map(([k, exp]) => [k.toLowerCase(), BigInt(exp)]))
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

const ZERO_LIFETIME = { depositedRaw: 0n, withdrawnRaw: 0n, feesPaidRaw: 0n, tradedNotionalRaw: 0n, rewardsClaimedRaw: 0n }
function lifetimeOf(l, prev) {
  if (!l) return prev
  const big = (v, fallback) => (v === undefined || v === null ? fallback : BigInt(v))
  return {
    depositedRaw: big(l.depositedRaw, prev.depositedRaw),
    withdrawnRaw: big(l.withdrawnRaw, prev.withdrawnRaw),
    feesPaidRaw: big(l.feesPaidRaw, prev.feesPaidRaw),
    tradedNotionalRaw: big(l.tradedNotionalRaw, prev.tradedNotionalRaw),
    rewardsClaimedRaw: big(l.paperRewardsClaimedRaw, prev.rewardsClaimedRaw),
  }
}

/** Apply one `wallet` event: a full snapshot, or a patch against the previous accountRevision. */
export function applyFrame(prev, frame) {
  if (frame.baseAccountRevision === undefined) {
    const positions = new Map()
    for (const t of frame.openPositions) {
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
      pendingIntents: new Set(frame.operations.map((op) => op[0])),
    }
    return { state, closed: [], outcomes: [] }
  }

  if (!prev || frame.baseAccountRevision !== prev.accountRevision) throw new OutOfSyncError('account stream out of sync')
  const positions = new Map(prev.positions)
  for (const id of frame.removedPositionIds) positions.delete(String(id))
  for (const t of frame.addedPositions) {
    const p = parsePosition(t)
    positions.set(p.positionId, p)
  }
  const pendingIntents = new Set(prev.pendingIntents)
  for (const id of frame.removedOperationIds) pendingIntents.delete(id)
  for (const op of frame.addedOperations) pendingIntents.add(op[0])
  const state = {
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
    closed: (frame.closedPositions ?? []).map(parseClosed),
    outcomes: (frame.intentOutcomes ?? []).map(([intentId, outcome]) => ({ intentId, outcome })),
  }
}

/**
 * Whether a wallet's trading key is usable: on-chain (in the feed) with over an hour left, or just submitted and not
 * seen yet (pending, for 3 minutes). Dry runs never send, so a stored key counts as active.
 */
export function keyStatus(key, sessionKeys, live, now = Date.now()) {
  if (!key) return { status: 'none' }
  const info = { key: key.address, expiry: key.expiry }
  if (!live) return { status: 'active', ...info }
  const onChain = sessionKeys?.get(key.address.toLowerCase())
  if (onChain && Number(onChain) > now / 1000 + 3600) return { status: 'active', ...info, expiry: Number(onChain) }
  if (!key.registeredAt && now - (key.submittedAt ?? 0) < 180_000) return { status: 'pending', ...info }
  return { status: 'none' }
}

/**
 * The account box, like Papertrade's portfolio: balances, open PnL at the live mid (before the win haircut Papertrade
 * takes on close), PAPER and lifetime totals. `markets` carry id, symbol, priceScale and mid; `closes` are the closes
 * on their way for this wallet ({ positionId, done, error, at }).
 */
export function accountBox(s, markets, closes = [], stakingContract = null, now = Date.now()) {
  const usdOf = (raw) => Number(raw) / 1e18
  const closeOf = new Map(closes.map((c) => [c.positionId, c]))
  let openPnlUsd = 0
  const open = [...s.positions.values()].map((p) => {
    const m = markets.find((x) => x.id === p.instrumentId)
    const scale = Number(m?.priceScale ?? 1)
    const entryPx = Number(p.entryPriceRaw) / scale
    const marginUsd = Number(p.marginRaw) / 1e18
    const mid = m?.mid ?? null
    const pnlUsd = mid ? marginUsd * p.leverage * ((mid - entryPx) / entryPx) * (p.isLong ? 1 : -1) : null
    if (pnlUsd != null) openPnlUsd += pnlUsd
    const c = closeOf.get(p.positionId)
    return {
      id: p.positionId,
      symbol: m?.symbol ?? `#${p.instrumentId}`,
      isLong: p.isLong,
      marginUsd,
      leverage: p.leverage,
      sizeUsd: marginUsd * p.leverage,
      entryPx,
      markPx: mid,
      bustPx: Number(p.bustPriceRaw) / scale,
      pnlUsd,
      openedAt: p.openedAtMs,
      closing: Boolean(c && !c.done && now - c.at < 10 * 60_000),
      closeError: c?.error ?? null,
    }
  })
  const balanceUsd = usdOf(s.balance)
  const l = s.lifetime
  return {
    balanceUsd,
    // The feed's balance is the free part; margin locked in open positions is still the account's, so add it back.
    equityUsd: balanceUsd + usdOf(s.locked) + openPnlUsd,
    marginInUseUsd: usdOf(s.locked),
    openPnlUsd,
    queuedUsd: usdOf(s.queued), // winnings waiting in the LP payout queue
    positions: s.positions.size,
    open: open.sort((a, b) => b.openedAt - a.openedAt),
    paper: { wallet: usdOf(s.paperBalance), staked: usdOf(s.paperStaked), stakingContract },
    lifetime: l && {
      feesPaidUsd: usdOf(l.feesPaidRaw),
      realizedPnlUsd: usdOf(s.realizedPnlRaw),
      tradedUsd: usdOf(l.tradedNotionalRaw),
      rewardsClaimedUsd: usdOf(l.rewardsClaimedRaw),
      depositedUsd: usdOf(l.depositedRaw),
      withdrawnUsd: usdOf(l.withdrawnRaw),
    },
  }
}
