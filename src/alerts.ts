import { execFile } from 'node:child_process'

export type Level = 'info' | 'warn' | 'crit'

const REPEAT_MS = 10 * 60_000

/**
 * Condition-based alerts: each key fires when it turns on, repeats every 10 minutes while it stays on, and sends a
 * "resolved" note when it clears. Delivered to stdout, an optional webhook, and optional macOS notifications.
 */
export class Alerter {
  readonly #active = new Map<string, { since: number; lastSent: number }>()
  readonly #webhook = process.env.PT_ALERT_WEBHOOK_URL || ''
  readonly #desktop = process.env.PT_ALERT_DESKTOP !== '0' && process.platform === 'darwin'

  /** Report whether condition `key` currently holds. Returns how long it has held, in ms (0 if not active). */
  set(key: string, active: boolean, level: Level, message: string): number {
    const now = Date.now()
    const prev = this.#active.get(key)
    if (!active) {
      if (prev) {
        this.#active.delete(key)
        void this.send('info', `resolved: ${key}`)
      }
      return 0
    }
    if (!prev) {
      this.#active.set(key, { since: now, lastSent: now })
      void this.send(level, message)
      return 0
    }
    if (now - prev.lastSent >= REPEAT_MS) {
      prev.lastSent = now
      void this.send(level, `${message} (ongoing ${Math.round((now - prev.since) / 60_000)}m)`)
    }
    return now - prev.since
  }

  async send(level: Level, message: string): Promise<void> {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`
    console.log(line)
    if (this.#desktop && level !== 'info') {
      execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title "papertrade ${level}"`], () => {})
    }
    if (this.#webhook) {
      try {
        // `content` for Discord, `text` for Slack.
        await fetch(this.#webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `[${level}] ${message}`, text: `[${level}] ${message}` }),
          signal: AbortSignal.timeout(5000),
        })
      } catch (err) {
        console.log(`${new Date().toISOString()} WARN  webhook failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
}
