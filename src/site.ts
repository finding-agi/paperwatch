import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'

// The shared top bar (src/site.js) links the two pages. On paperwatch.app one server serves both (/trade and /queue).
// Run alone (`npm run queue` / `npm run trigger`), each page links to the other's local dev server.
export function serveSiteJs(res: ServerResponse, together = false): void {
  const queue = together ? '/queue' : process.env.PT_QUEUE_URL ?? 'http://localhost:8788/queue'
  const limits = together ? '/trade' : process.env.PT_TRIGGER_URL ?? 'http://localhost:8788/trade'
  // Read per request so edits show on reload. Its own asset links get version stamps too (see versioned()).
  const js = versioned(readFileSync(join(import.meta.dirname, 'site.js'), 'utf8').replace('__QUEUE_URL__', queue).replace('__TRIGGER_URL__', limits))
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' }).end(js)
}

/** The account-feed module the trade page shares with the server (it follows the connected wallet's own feed). */
export function serveAccountFrames(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' }).end(readFileSync(FILES['/account-frames.js']))
}

// The chart library, served from our own origin (pinned in package.json) instead of a CDN, so no third party can
// change the code that runs next to a connected wallet.
const CHART_JS = join(import.meta.dirname, '..', 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js')
export function serveChartJs(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }).end(readFileSync(CHART_JS))
}

// Brand files and the Manrope font (self-hosted from node_modules, so the CSP needs no outside font host).
const ASSETS: Record<string, [string, string]> = {
  'logo.png': [join(import.meta.dirname, 'assets', 'logo.png'), 'image/png'],
  'favicon.png': [join(import.meta.dirname, 'assets', 'favicon.png'), 'image/png'],
  'apple-touch-icon.png': [join(import.meta.dirname, 'assets', 'apple-touch-icon.png'), 'image/png'],
  'manrope.woff2': [join(import.meta.dirname, '..', 'node_modules', '@fontsource-variable', 'manrope', 'files', 'manrope-latin-wght-normal.woff2'), 'font/woff2'],
}
/** Serve /assets/<name> from a fixed list (no paths from the request ever reach the filesystem); false if unknown. */
export function serveAsset(res: ServerResponse, name: string): boolean {
  const asset = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined // never Object.prototype keys like __proto__
  if (!asset) return false
  res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'public, max-age=86400' }).end(readFileSync(asset[0]))
  return true
}

// Cache busting. Cloudflare sits in front of paperwatch.app and tells browsers to keep scripts and images for hours,
// whatever we send, so a deploy could show a new page with an old top bar. Every link to one of our files carries a
// hash of that file (?v=…): a changed file gets a new URL, which browsers and Cloudflare fetch fresh.
const FILES: Record<string, string> = {
  '/site.js': join(import.meta.dirname, 'site.js'),
  '/account-frames.js': join(import.meta.dirname, 'account-frames.js'),
  '/vendor/lightweight-charts.js': CHART_JS,
  ...Object.fromEntries(Object.entries(ASSETS).map(([name, [file]]) => [`/assets/${name}`, file])),
}
const hashOf = (...parts: (string | Buffer)[]) => parts.reduce((h, p) => h.update(p), createHash('sha256')).digest('hex').slice(0, 10)
// site.js's served text also depends on the page URLs and on the stamps of the files it links, so its stamp does too.
const stamp = (path: string): string =>
  path === '/site.js'
    ? hashOf(readFileSync(FILES[path]), process.env.PT_QUEUE_URL ?? '', process.env.PT_TRIGGER_URL ?? '', ...Object.keys(ASSETS).map((n) => stamp(`/assets/${n}`)))
    : hashOf(readFileSync(FILES[path]))
/** Add ?v=<hash of the file> to every link to one of our own files in `text` (HTML, or the site.js source). */
export function versioned(text: string): string {
  return text.replace(/(["'(])(\/(?:site\.js|account-frames\.js|vendor\/[\w.-]+|assets\/[\w.-]+))(["')])/g, (all, open, path, close) =>
    Object.hasOwn(FILES, path) ? `${open}${path}?v=${stamp(path)}${close}` : all,
  )
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
 * (every <script> in our pages gets it), network only to this origin, Hyperliquid's websocket and HyperEVM RPC, and Papertrade's account feed, nothing framed.
 * Injected HTML can't run script or send data anywhere else, so it can't ask a connected wallet to sign things.
 */
export function servePage(res: ServerResponse, file: string): void {
  const nonce = randomBytes(16).toString('base64')
  const html = versioned(readFileSync(join(import.meta.dirname, file), 'utf8')).replaceAll('<script', `<script nonce="${nonce}"`)
  baseHeaders(res)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self' wss://api.hyperliquid.xyz https://rpc.hyperliquid.xyz https://exchange.papertrade.xyz",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  }).end(html)
}
