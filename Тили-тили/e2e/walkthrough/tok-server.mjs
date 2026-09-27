// Локальный раздатчик для обхода ролей (только 127.0.0.1:3999). Токены остаются на машине.
//  GET  /tok/<phone>   — tok-<phone>.json (токены роли)
//  GET  /pub           — fixtures-public.json (идентификаторы без токенов)
//  GET  /file/<name>   — crawl/<name> (задание обхода)
//  POST /out/<name>    — тело → crawl/out/<name> (отчёт обхода, в чат не попадает)
//  GET  /otp/<phone>   — последний dev-код из be.log по маске номера (для сценария входа)
import { createServer } from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
mkdirSync(`${D}/crawl/out`, { recursive: true })
const mask = (p) => p.slice(0, 5) + '****' + p.slice(-3)
createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }
  const url = decodeURIComponent(req.url ?? '')
  const send = (file) => {
    if (!existsSync(file)) { res.statusCode = 404; return res.end('no') }
    res.setHeader('content-type', 'application/json')
    res.end(readFileSync(file))
  }
  let m
  if ((m = /^\/tok\/(\+7\d{10})$/.exec(url))) return send(`${D}/tok-${m[1]}.json`)
  if (url === '/pub') return send(`${D}/fixtures-public.json`)
  if ((m = /^\/file\/([\w.-]+)$/.exec(url))) return send(`${D}/crawl/${m[1]}`)
  if ((m = /^\/otp\/(\+7\d{10})$/.exec(url))) {
    const lines = readFileSync(`${D}/be.log`, 'utf8').split(/\r?\n/).filter((l) => l.includes('SMS не отправлена') && l.includes(mask(m[1])))
    const last = lines.at(-1)
    const code = last ? /код (\d{4})/.exec(last)?.[1] : null
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ code }))
  }
  if (req.method === 'POST' && (m = /^\/out\/([\w.-]+)$/.exec(url))) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => { writeFileSync(`${D}/crawl/out/${m[1]}`, Buffer.concat(chunks)); res.end('ok') })
    return
  }
  res.statusCode = 404
  res.end('no')
}).listen(3999, '127.0.0.1', () => console.log('tok-server2 on 127.0.0.1:3999'))
