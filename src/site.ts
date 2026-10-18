import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'

// The shared top bar (src/site.js) links the Queue and Trigger pages, which are separate services. Their URLs come
// from PT_QUEUE_URL / PT_TRIGGER_URL; locally they default to the two dev ports. Deployed without PT_TRIGGER_URL,
// the Trigger link shows greyed out.
export function serveSiteJs(res: ServerResponse): void {
  const deployed = Boolean(process.env.PORT)
  const queue = process.env.PT_QUEUE_URL ?? (deployed ? 'https://paperwatch.app' : 'http://localhost:8787')
  const trigger = process.env.PT_TRIGGER_URL ?? (deployed ? '' : 'http://localhost:8788')
  // Read per request so edits show on reload.
  const js = readFileSync(join(import.meta.dirname, 'site.js'), 'utf8').replace('__QUEUE_URL__', queue).replace('__TRIGGER_URL__', trigger)
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }).end(js)
}
