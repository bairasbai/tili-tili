// Точечный вызов API от имени роли фикстур: node api.mjs <role> <METHOD> <path> [json-body]
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
const f = JSON.parse(readFileSync(`${D}/fixtures.json`, 'utf8'))
const [role, method, path, body] = process.argv.slice(2)
const tok = role === 'guest' ? null : f.roles[role].accessToken
const r = await fetch('http://127.0.0.1:3001' + path.replace('{W}', f.weddingId), {
  method, headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(role === 'guest' ? { 'x-guest-token': f.guestToken } : {}) },
  body: body === undefined ? undefined : body,
})
const text = await r.text()
console.log(r.status, text.replace(/"(accessToken|refreshToken|guestToken)":"[^"]+"/g, '"$1":"…"').slice(0, 1500))
