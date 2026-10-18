import type { AccountStream, Position } from './account.ts'
import type { Instrument } from './api.ts'
import type { PublicStream } from './intake.ts'
import { readMids } from './market.ts'
import { log, pct, price, usd } from './bot.ts'

// Read-only trade journal, the data for picking a restrike level: one LEG line per open and close of an `inst`
// position on the account, whoever sent it (pair-opener, the web app, anything). Each line has where the price was
// when the intent showed up as pending, where it filled, the wait, and the intake queue at that moment; closes add
// PnL and PAPER. Nothing is stored: `railway logs --service pair-opener | grep LEG`.
//
// The account feed doesn't say which position a pending close targets, so a close is matched to the intent that
// cleared in the same update (opens carry their intent id). "Sent" is when the indexer first showed the intent,
// a second or so after the click.

type Sent = { atMs: number; midRaw: bigint; queued: number | null }
const MID_POLL_MS = 2000
const EXIT_WAIT_MS = 15_000 // the fill price comes from public:trades, which can lag the account update
const INTENT_TTL_MS = 3_600_000

export function startJournal(stream: AccountStream, inst: Instrument, pub: PublicStream): void {
  const sent = new Map<string, Sent>() // pending intent id (lowercase) -> when it was first seen
  const exits = new Map<string, number>() // position id -> fill price of its close, from public:trades
  const known = new Map<string, Position>() // open positions in `inst`, as of the last update
  let pending = new Set<string>()
  let mid = 0n

  const ownPositions = () => [...(stream.state?.positions.values() ?? [])].filter((p) => p.instrumentId === inst.id)
  for (const p of ownPositions()) known.set(p.positionId, p)
  for (const id of stream.state?.pendingIntents ?? []) pending.add(id.toLowerCase())

  const pollMid = async () => {
    try {
      mid = (await readMids([inst])).get(inst.id) ?? mid
    } catch {
      // keep the last mid
    }
    setTimeout(pollMid, MID_POLL_MS)
  }
  pollMid()
  setInterval(() => {
    for (const t of pub.drain().trades) if (t.kind !== 'open' && t.exit != null) exits.set(String(t.positionId), t.exit)
    if (exits.size > 5000) exits.clear()
    for (const [id, s] of sent) if (Date.now() - s.atMs > INTENT_TTL_MS) sent.delete(id)
  }, 1000)

  const priceAt = (raw: bigint) => Number(raw) / Number(inst.priceScale)
  /** Signed move of `px` from the position's entry, positive in its favour. */
  const moveOf = (p: Position, px: number) => ((px - priceAt(p.entryPriceRaw)) / priceAt(p.entryPriceRaw)) * (p.isLong ? 1 : -1)
  const signed = (x: number) => `${x >= 0 ? '+' : '−'}${pct(Math.abs(x))}`
  const queueTxt = (s: Sent) => (s.queued == null ? 'queue ?' : `queue ${s.queued}`)

  stream.onFrame(({ state, closed }) => {
    const now = Date.now()
    const nowPending = new Set([...state.pendingIntents].map((id) => id.toLowerCase()))
    for (const id of nowPending) if (!sent.has(id)) sent.set(id, { atMs: now, midRaw: mid, queued: pub.pressure?.queuedIntents ?? null })
    const cleared = [...pending].filter((id) => !nowPending.has(id))
    pending = nowPending

    // Opens: a new position carries the id of the intent that opened it.
    const openIntents = new Set<string>()
    for (const p of state.positions.values()) {
      if (p.instrumentId !== inst.id || known.has(p.positionId)) continue
      const key = p.intentId?.toLowerCase()
      const s = key ? sent.get(key) : undefined
      if (key) openIntents.add(key)
      const side = p.isLong ? 'long' : 'short'
      log('LEG', s
        ? `${side} #${p.positionId} opened @ ${price(p.entryPriceRaw, inst)} | sent at ${price(s.midRaw, inst)} (${queueTxt(s)}) → filled after ${Math.round((now - s.atMs) / 1000)}s`
        : `${side} #${p.positionId} opened @ ${price(p.entryPriceRaw, inst)} | send time unknown`)
      if (key) sent.delete(key)
    }

    // Closes: matched to the other intents that cleared in this same update, earliest first. One close intent can
    // carry several positions, so the last one covers any extra closes.
    const closeIntents = cleared.filter((id) => !openIntents.has(id) && sent.has(id)).sort((a, b) => sent.get(a)!.atMs - sent.get(b)!.atMs)
    const closeSents = closeIntents.map((id) => sent.get(id)!)
    for (const id of closeIntents) sent.delete(id)
    let n = 0
    for (const c of closed) {
      const p = known.get(c.positionId)
      if (!p) continue
      const s = closeSents.length ? closeSents[Math.min(n++, closeSents.length - 1)] : undefined
      const side = p.isLong ? 'long' : 'short'
      const pnl = Number(c.netPnlRaw) / 1e18
      const paper = Number(c.paperMintedRaw) / 1e18
      const money = `${usd(pnl)}${paper ? `, +${paper.toFixed(0)} PAPER` : ''}`
      if (c.liquidated) {
        log('LEG', `${side} #${p.positionId} LIQUIDATED | ${money}`)
        continue
      }
      const report = () => {
        const exit = exits.get(c.positionId)
        // Without the trade print, a loss still gives the fill move exactly (losses pay no fee).
        const fillMove = exit != null ? moveOf(p, exit) : pnl < 0 ? pnl / (Number(p.marginRaw) / 1e18 * p.leverage) : null
        const sentPart = s && s.midRaw ? `sent at ${signed(moveOf(p, priceAt(s.midRaw)))} (${queueTxt(s)})` : 'send time unknown'
        const fillPart = fillMove == null ? 'fill price unknown' : `filled at ${signed(fillMove)}${exit != null ? ` @ ${exit}` : ''}`
        log('LEG', `${side} #${p.positionId} closed | ${sentPart} → ${fillPart}${s ? ` after ${Math.round((now - s.atMs) / 1000)}s` : ''} | ${money}`)
      }
      if (exits.has(c.positionId)) report()
      else setTimeout(report, EXIT_WAIT_MS)
    }

    known.clear()
    for (const p of state.positions.values()) if (p.instrumentId === inst.id) known.set(p.positionId, p)
  })
  log('journal', `logging every ${inst.symbol} open and close on this account as LEG lines`)
}
