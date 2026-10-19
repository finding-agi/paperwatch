// Load generator for a dry copy of the site (never production writes). One scenario per run, set by LG_SCENARIO:
//   streams  LG_N live streams (/api/live), ramped over LG_RAMP_S, held LG_HOLD_S: connects, errors, gaps between ticks
//   signins  LG_N wallets sign in and enable trading (dry), LG_C at a time: latency and errors per step
//   orders   LG_N wallets sign in, then all place a market order at once; LG_SAMPLE of them watch until it fills
//   unlock   LG_N wallets sign in, then all call /api/fee/confirm with a made-up hash, twice: latency, codes
//   poll     LG_N clients read /api/state every 5 s for LG_HOLD_S (the fallback path)
// LG_TARGET is the base URL (the load-test copy's Railway domain). Prints one JSON line of results every 10 s and at the end.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { percentile } from '../src/status.ts'

const TARGET = (process.env.LG_TARGET ?? '').replace(/\/$/, '')
if (!/^https?:\/\//.test(TARGET) || /paperwatch\.app/.test(TARGET)) throw new Error('set LG_TARGET to the load-test copy (never paperwatch.app)')
const SCENARIO = process.env.LG_SCENARIO ?? 'streams'
const N = Number(process.env.LG_N ?? 100)
const C = Number(process.env.LG_C ?? 100)
const RAMP_S = Number(process.env.LG_RAMP_S ?? 60)
const HOLD_S = Number(process.env.LG_HOLD_S ?? 60)
const SAMPLE = Number(process.env.LG_SAMPLE ?? 50)

const times: Record<string, number[]> = {}
const codes: Record<string, number> = {}
const note = (step: string, ms: number, code: number | string) => {
  ;(times[step] ??= []).push(ms)
  codes[`${step} ${code}`] = (codes[`${step} ${code}`] ?? 0) + 1
}
const report = (extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({
    t: new Date().toISOString(), scenario: SCENARIO, ...extra, codes,
    ms: Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { n: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95), max: Math.max(...v) }])),
  }))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type User = { cookie: string; wallet: string }
async function call(step: string, path: string, body?: unknown, cookie = ''): Promise<{ status: number; data: any; cookie: string }> {
  const t0 = Date.now()
  try {
    const res = await fetch(TARGET + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-paperwatch': '1', cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
    const data = await res.json().catch(() => null)
    note(step, Date.now() - t0, res.status)
    return { status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? cookie }
  } catch (err) {
    note(step, Date.now() - t0, (err as Error).name)
    return { status: 0, data: null, cookie }
  }
}

/** Sign in with a fresh wallet and (dry) enable trading. */
async function signIn(enable = true): Promise<User | null> {
  const acct = privateKeyToAccount(generatePrivateKey())
  const m = await call('message', '/api/auth/message', { wallet: acct.address })
  if (m.status !== 200) return null
  const v = await call('verify', '/api/auth/verify', { wallet: acct.address, signature: await acct.signMessage({ message: m.data.message }) })
  if (v.status !== 200) return null
  const user = { cookie: v.cookie, wallet: acct.address.toLowerCase() }
  if (!enable) return user
  const p = await call('prepare', '/api/trading/prepare', {}, user.cookie)
  if (p.status !== 200) return null
  const td = p.data.typedData
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== 'EIP712Domain'))
  const r = await call('register', '/api/trading/register', { signature: await acct.signTypedData({ domain: td.domain, types: types as never, primaryType: td.primaryType, message: td.message }) }, user.cookie)
  return r.status === 200 ? user : null
}

/** Run `fn` for 0..n-1, `c` at a time. */
async function pool<T>(n: number, c: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(c, n) }, async () => {
    while (next < n) out.push(await fn(next++))
  }))
  return out
}

async function streams() {
  let open = 0, failed = 0, ticks = 0
  const gaps: number[] = []
  const one = async () => {
    try {
      const res = await fetch(`${TARGET}/api/live`, { signal: AbortSignal.timeout((RAMP_S + HOLD_S + 30) * 1000) })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      open++
      let last = Date.now()
      const decoder = new TextDecoder()
      for await (const chunk of res.body) {
        const n = (decoder.decode(chunk as Uint8Array).match(/event: markets/g) ?? []).length
        if (n) {
          const now = Date.now()
          if (Math.random() < 0.01) gaps.push(now - last)
          last = now
          ticks += n
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'TimeoutError') failed++
    }
    open--
  }
  const timer = setInterval(() => { times.tickGap = gaps.splice(0); report({ open, failed, ticks }) }, 10_000)
  const all: Promise<void>[] = []
  for (let i = 0; i < N; i++) {
    all.push(one())
    await sleep((RAMP_S * 1000) / N)
  }
  await sleep(HOLD_S * 1000)
  clearInterval(timer)
  report({ open, failed, ticks, done: true })
  process.exit(0)
}

async function main() {
  if (SCENARIO === 'streams') return streams()
  if (SCENARIO === 'poll') {
    const end = Date.now() + HOLD_S * 1000
    await pool(N, N, async (i) => {
      await sleep((i / N) * 5000)
      while (Date.now() < end) {
        await call('state', '/api/state')
        await sleep(5000)
      }
    })
    return report({ done: true })
  }
  const enable = SCENARIO !== 'unlock'
  const t0 = Date.now()
  const users = (await pool(N, C, () => signIn(enable))).filter((u): u is User => Boolean(u))
  report({ signedIn: users.length, of: N, seconds: (Date.now() - t0) / 1000 })
  if (SCENARIO === 'orders') {
    const placed = await Promise.all(users.map(async (u) => ({ u, at: Date.now(), r: await call('order', '/api/orders', { symbol: 'BTC', side: 'long', type: 'market', marginUsd: 100, leverage: 20 }, u.cookie) })))
    const ok = placed.filter((p) => p.r.status === 200)
    report({ placed: ok.length })
    // A sample watches its order until it fills: placement to fill, as the page would see it.
    await pool(Math.min(SAMPLE, ok.length), SAMPLE, async (i) => {
      const { u, at, r } = ok[i]
      for (let k = 0; k < 120; k++) {
        const s = await call('watch', '/api/state', undefined, u.cookie)
        const o = s.data?.orders?.find((x: any) => x.id === r.data.id)
        if (o && o.status !== 'armed' && o.status !== 'sending') return note(`fill(${o.status})`, Date.now() - at, 'done')
        await sleep(2000)
      }
      note('fill', Date.now() - at, 'timeout')
    })
  }
  if (SCENARIO === 'unlock') {
    const hash = () => '0x' + [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('')
    await Promise.all(users.map((u) => call('confirm1', '/api/fee/confirm', { hash: hash() }, u.cookie)))
    await Promise.all(users.map((u) => call('confirm2', '/api/fee/confirm', { hash: hash() }, u.cookie)))
  }
  report({ done: true })
  process.exit(0)
}
void main()
