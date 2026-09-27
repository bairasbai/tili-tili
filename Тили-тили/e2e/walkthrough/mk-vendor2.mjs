// Ещё один подрядчик (видеограф) для проверки действий по заявке: логин + анкета + публикация → tok-файл, fixtures-public.phones.vendor2.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { env, pg } from './backend-env.mjs'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
if (/^prod/.test(env.NODE_ENV ?? '')) throw new Error('не для прода')
const API = `http://127.0.0.1:${env.PORT || 3001}`
const db = new pg.Client({ connectionString: env.DATABASE_URL })
await db.connect()
const pub = JSON.parse(readFileSync(`${D}/fixtures-public.json`, 'utf8'))
const phone = `+79${pub.run}201`
const call = async (method, path, body, token) => {
  await new Promise((res) => setTimeout(res, 150)) // лимит 10 запросов в секунду на пользователя
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}
await call('POST', '/auth/otp', { phone })
const { rows } = await db.query('select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1', [phone])
let code = null
for (let i = 0; i < 10000; i++) { const c = String(i).padStart(4, '0'); if (createHmac('sha256', env.JWT_REFRESH_SECRET).update(`${phone}:${c}`).digest('hex') === rows[0].code_hash) { code = c; break } }
const v = await call('POST', '/auth/otp/verify', { phone, code, device: 'crawl' })
await call('POST', '/users/me/consent', { policyVersion: env.POLICY_VERSION ?? '2026-09-02', adult: true }, v.accessToken)
const prof = await call('PUT', '/vendor/profile', { name: `Видео Обход ${pub.run}`, categoryId: 'video', city: { name: 'Уфа', region: 'Башкортостан' }, about: 'Обход: заявки', phone: '+79170000002', priceFrom: { amount: 5_000_000, currency: 'RUB' }, mediaRights: true, packages: [{ name: 'Клип', price: { amount: 7_000_000, currency: 'RUB' }, includes: ['3 минуты'] }] }, v.accessToken)
await call('POST', '/vendor/profile/publish', {}, v.accessToken)
writeFileSync(`${D}/tok-${phone}.json`, JSON.stringify({ role: 'vendor2', userId: v.user.id, weddingId: null, tokens: { accessToken: v.accessToken, refreshToken: v.refreshToken } }))
pub.phones.vendor2 = phone
pub.vendor2Id = prof.id
writeFileSync(`${D}/fixtures-public.json`, JSON.stringify(pub, null, 2))
await db.end()
console.log(JSON.stringify({ vendor2Id: prof.id }))
