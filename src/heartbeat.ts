import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATE_DIR } from './config.ts'

export type Heartbeat = {
  ts: number
  pid: number
  mode: 'dry' | 'live'
  instrument: string
  mid: string
  pairs: number
  legIds: string[] // live positions the bot owns
  idleReason: string
  lastError: string
  stopped: boolean // clean shutdown, as opposed to a crash or hang
}

const path = (mode: 'dry' | 'live') => join(STATE_DIR, `heartbeat-${mode}.json`)

export function writeHeartbeat(hb: Heartbeat): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const p = path(hb.mode)
  writeFileSync(`${p}.tmp`, JSON.stringify(hb))
  renameSync(`${p}.tmp`, p)
}

export function readHeartbeat(mode: 'dry' | 'live'): Heartbeat | null {
  const p = path(mode)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Heartbeat
  } catch {
    return null // caught mid-rename; next check will read it
  }
}
