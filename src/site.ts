import { randomBytes } from 'node:crypto'
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

// The chart library, served from our own origin (pinned in package.json) instead of a CDN, so no third party can
// change the code that runs next to a connected wallet.
const CHART_JS = join(import.meta.dirname, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js')
export function serveChartJs(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }).end(readFileSync(CHART_JS))
}

/** Headers for every response: no MIME sniffing, no framing (clickjacking), no referrer leaks, HTTPS once deployed. */
export function baseHeaders(res: ServerResponse): void {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('x-frame-options', 'DENY')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  if (process.env.PORT) res.setHeader('strict-transport-security', 'max-age=31536000')
}

/**
 * Serve a page under a strict Content-Security-Policy: scripts only from this origin or with this response's nonce
 * (every <script> in our pages gets it), network only to this origin and Hyperliquid's websocket, nothing framed.
 * Injected HTML can't run script or send data anywhere else, so it can't ask a connected wallet to sign things.
 */
export function servePage(res: ServerResponse, file: string): void {
  const nonce = randomBytes(16).toString('base64')
  const html = readFileSync(join(import.meta.dirname, file), 'utf8').replaceAll('<script', `<script nonce="${nonce}"`)
  baseHeaders(res)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' wss://api.hyperliquid.xyz",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  }).end(html)
}
