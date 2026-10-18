import { spawn, type ChildProcess } from 'node:child_process'

// Container entrypoint: runs the bot and the watcher side by side and restarts either if it exits. The bot runs in
// dry mode unless PT_MODE=live. On SIGTERM (Railway redeploy/stop) both get SIGTERM, so the bot closes its pairs
// (the opener closes nothing).

const live = process.env.PT_MODE === 'live'
const log = (msg: string) => console.log(`${new Date().toISOString()} super  ${msg}`)

type Proc = { name: string; args: string[]; child?: ChildProcess; restarts: number }
// PT_PROCESS=intake (intake monitor), queue (live queue page), opener (opens one pair per start, never closes) or
// trigger (opens at a price you set from its page, never closes) runs only that process, as its own Railway service,
// never the bot. Of those, only the opener and trigger read PT_MODE.
const SOLO = ['intake', 'queue', 'opener', 'trigger']
const TRADES = ['opener', 'trigger']
const solo = SOLO.includes(process.env.PT_PROCESS ?? '') ? process.env.PT_PROCESS! : null
const procs: Proc[] = solo
  ? [{ name: solo, args: [solo, ...(TRADES.includes(solo) && live ? ['--live'] : [])], restarts: 0 }]
  : [{ name: 'bot', args: ['run', ...(live ? ['--live'] : [])], restarts: 0 }]
if (!solo && process.env.PT_WALLET_ADDRESS) procs.push({ name: 'watch', args: ['watch'], restarts: 0 })
else if (!solo) log('PT_WALLET_ADDRESS not set: running the bot without the watcher')

let stopping = false

function start(p: Proc): void {
  const child = spawn(process.execPath, ['src/cli.ts', ...p.args], { stdio: ['ignore', 'pipe', 'pipe'] })
  p.child = child
  const prefix = (chunk: Buffer) => chunk.toString().replace(/^(?=.)/gm, `[${p.name}] `)
  child.stdout!.on('data', (c: Buffer) => process.stdout.write(prefix(c)))
  child.stderr!.on('data', (c: Buffer) => process.stderr.write(prefix(c)))
  child.on('exit', (code, signal) => {
    p.child = undefined
    if (stopping) return
    p.restarts++
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(p.restarts, 5))
    log(`${p.name} exited (${signal ?? code}); restart #${p.restarts} in ${delay / 1000}s`)
    setTimeout(() => !stopping && start(p), delay)
  })
}

function shutdown(signal: NodeJS.Signals): void {
  if (stopping) return
  stopping = true
  log(`${signal}: stopping children`)
  for (const p of procs) p.child?.kill('SIGTERM')
  const done = setInterval(() => {
    if (procs.every((p) => !p.child)) {
      clearInterval(done)
      process.exit(0)
    }
  }, 250)
  setTimeout(() => process.exit(1), 85_000) // the bot's close-on-exit waits up to 60s
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
log(`starting ${procs.map((p) => p.name).join(' + ')}${solo && !TRADES.includes(solo) ? '' : ` (${live ? 'LIVE' : 'dry'})`}`)
for (const p of procs) start(p)
