import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'

// The shared top bar (src/site.js) links the two pages. On paperwatch.app one server serves both (/limits and /queue).
// Run alone (`npm run queue` / `npm run trigger`), each page links to the other's local dev server.
export function serveSiteJs(res: ServerResponse, together = false): void {
  const queue = together ? '/queue' : process.env.PT_QUEUE_URL ?? 'http://localhost:8788/queue'
  const limits = together ? '/limits' : process.env.PT_TRIGGER_URL ?? 'http://localhost:8788/limits'
  // Read per request so edits show on reload.
  const js = readFileSync(join(import.meta.dirname, 'site.js'), 'utf8').replace('__QUEUE_URL__', queue).replace('__TRIGGER_URL__', limits)
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }).end(js)
}
