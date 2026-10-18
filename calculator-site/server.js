import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('./index.html', import.meta.url))
const port = Number(process.env.PORT) || 3000

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' })
  res.end(html)
}).listen(port, () => console.log(`listening on ${port}`))
