// Идентификаторы для маршрутов обхода (без токенов) → fixtures-public.json. Плюс лид флориста, заявка на верификацию, жалоба, свежая ссылка гостя.
import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const D = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })())
const API = 'http://127.0.0.1:3001'
const f = JSON.parse(readFileSync(`${D}/fixtures.json`, 'utf8'))
const pub = JSON.parse(readFileSync(`${D}/fixtures-public.json`, 'utf8'))
const tok = (role) => f.roles[role].accessToken
const call = async (role, method, path, body, extra = {}) => {
  await new Promise((res) => setTimeout(res, 150)) // лимит 10 запросов в секунду на пользователя
  const r = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok(role)}`, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* пусто */ }
  return { status: r.status, json, text }
}
const W = f.weddingId
const items = (r) => (Array.isArray(r.json) ? r.json : r.json?.items ?? [])
const problems = []

// пара: слоты, чаты, гости, задачи, документы
const slots = items(await call('couple', 'GET', `/weddings/${W}/slots`))
pub.photoSlotId = f.photoSlotId
pub.emptySlotId = slots.find((s) => !s.deal)?.id ?? null
pub.slotsCount = slots.length
const guests = items(await call('couple', 'GET', `/weddings/${W}/guests`))
pub.guests = guests.map((g) => g.id)
const tasks = items(await call('couple', 'GET', `/weddings/${W}/tasks`))
pub.taskId = tasks[0]?.id ?? null
const docs = await call('couple', 'GET', `/deals/${f.dealId}/documents`)
pub.documentId = items(docs)[0]?.id ?? null

// лид флориста: чат пары с флористом + сообщение
const fchat = await call('couple', 'POST', `/chats/vendor/${f.floristVendorId}`)
if (fchat.status >= 400) problems.push(['chat florist', fchat.status, fchat.text.slice(0, 120)])
pub.floristChatId = fchat.json?.id ?? null
if (pub.floristChatId) {
  const m = await call('couple', 'POST', `/chats/${pub.floristChatId}/messages`, { text: 'Здравствуйте! Нужен букет и оформление зала' })
  if (m.status >= 400) problems.push(['msg florist', m.status, m.text.slice(0, 120)])
}
const fleads = items(await call('florist', 'GET', '/vendor/leads'))
pub.floristLeadId = fleads[0]?.id ?? null
const vleads = items(await call('vendor', 'GET', '/vendor/leads'))
pub.vendorLeadId = vleads[0]?.id ?? null
pub.vendorLeadState = vleads[0]?.state ?? null
const vchats = items(await call('vendor', 'GET', '/chats'))
pub.vendorChatId = vchats[0]?.id ?? null

// заявка на верификацию от фотографа
const ver = await call('vendor', 'POST', '/vendor/verification', { kind: 'passport', fileUrl: 'https://example.com/passport.jpg' })
if (ver.status >= 400 && ver.status !== 409) problems.push(['verification', ver.status, ver.text.slice(0, 160)])
pub.verificationRequestId = ver.json?.id ?? null

// жалоба пары на флориста
const comp = await call('couple', 'POST', '/complaints', { targetKind: 'vendor', targetId: f.floristVendorId, category: 'spam', text: 'Обход ролей: проверка панели' })
if (comp.status >= 400) problems.push(['complaint', comp.status, comp.text.slice(0, 120)])
pub.complaintId = comp.json?.id ?? null

// панель: очереди
const mod = items(await call('staff', 'GET', '/admin/moderation/vendors'))
pub.moderationVendorId = mod.find((v) => v.id === f.vendorId)?.id ?? mod[0]?.id ?? null
const vers = items(await call('staff', 'GET', '/admin/verifications'))
pub.adminVerificationId = vers.find((v) => v.vendorId === f.vendorId)?.id ?? vers[0]?.id ?? pub.verificationRequestId
const conc = items(await call('staff', 'GET', '/admin/concierge'))
pub.conciergeCount = conc.length

// свежая ссылка второму гостю — для /i/:code в браузере
const link = await call('couple', 'POST', `/weddings/${W}/guests/${pub.guests[1]}/invite-link`)
pub.freshGuestCode = link.json?.url?.split('/').pop() ?? null
if (!pub.freshGuestCode) problems.push(['invite-link', link.status, link.text.slice(0, 120)])

// уведомления пары — id для маршрута
const notif = items(await call('couple', 'GET', '/notifications'))
pub.notificationsCount = notif.length

writeFileSync(`${D}/fixtures-public.json`, JSON.stringify(pub, null, 2))
console.log(JSON.stringify({ ...pub, problems }, null, 1))
