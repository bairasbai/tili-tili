// Фикстуры для обхода ролей (одноразовые аккаунты dev-базы). Секреты — окружение поверх backend/.env (backend-env.mjs).
// Пишет $LIVE_DIR/fixtures.json: токены по ролям, идентификаторы, гостевой токен.
import { readFileSync, writeFileSync } from 'node:fs'
import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { env, pg } from './backend-env.mjs'

const OUT = (process.env.LIVE_DIR || (() => { throw new Error('LIVE_DIR не задан — см. README.md') })()) + '/fixtures.json'
if (/^prod/.test(env.NODE_ENV ?? '')) throw new Error('не для прода')
const API = `http://127.0.0.1:${env.PORT || 3001}`
const db = new pg.Client({ connectionString: env.DATABASE_URL })
await db.connect()

let RUN = String(randomInt(100_000, 1_000_000))
for (let i = 0; i < 20; i++) {
  const { rows } = await db.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
  if (!rows.length) break
  RUN = String(randomInt(100_000, 1_000_000))
}
let n = 0
const phone = () => `+79${RUN}${String(++n).padStart(3, '0')}`

const call = async (method, path, body, token, extra = {}) => {
  await new Promise((res) => setTimeout(res, 150)) // лимит 10 запросов в секунду на пользователя
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* пусто */ }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text.slice(0, 200)}`)
  return json
}

async function login(ph) {
  await call('POST', '/auth/otp', { phone: ph })
  const { rows } = await db.query('select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1', [ph])
  let code = null
  for (let i = 0; i < 10000; i++) {
    const c = String(i).padStart(4, '0')
    if (createHmac('sha256', env.JWT_REFRESH_SECRET).update(`${ph}:${c}`).digest('hex') === rows[0].code_hash) { code = c; break }
  }
  const v = await call('POST', '/auth/otp/verify', { phone: ph, code, device: 'crawl' })
  await call('POST', '/users/me/consent', { policyVersion: env.POLICY_VERSION ?? '2026-09-02', adult: true }, v.accessToken)
  return { phone: ph, userId: v.user.id, accessToken: v.accessToken, refreshToken: v.refreshToken }
}

const key = () => ({ 'idempotency-key': randomUUID() })
const DATE = '2027-09-04'

// 1. Пара со свадьбой.
const couple = await login(phone())
await call('PATCH', '/users/me', { name: 'Аня Обход' }, couple.accessToken)
const wedding = await call('POST', '/weddings', { partnerName: 'Тимур', date: DATE, city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 120_000_000, currency: 'RUB' } }, couple.accessToken)
const W = wedding.id
const T = couple.accessToken

// 2. Помощник и координатор.
const helper = await login(phone())
const coordinator = await login(phone())
for (const [role, who] of [['helper', helper], ['coordinator', coordinator]]) {
  const inv = await call('POST', `/weddings/${W}/invites`, { role, label: `Обход ${role}` }, T)
  await call('POST', `/invites/${inv.code}/accept`, {}, who.accessToken)
}

// 3. Подрядчик с анкетой (фотограф) и второй (флорист) — для чата и брони.
async function vendorWith(categoryId, name) {
  const owner = await login(phone())
  const prof = await call('PUT', '/vendor/profile', {
    name, categoryId, city: { name: 'Уфа', region: 'Башкортостан' }, about: 'Обход ролей: анкета для проверки', phone: '+79170000000',
    priceFrom: { amount: 4_000_000, currency: 'RUB' }, mediaRights: true,
    packages: [{ name: 'Полный день', price: { amount: 9_000_000, currency: 'RUB' }, includes: ['10 часов', '300 кадров'] }],
  }, owner.accessToken)
  await call('POST', '/vendor/profile/publish', {}, owner.accessToken)
  return { ...owner, vendorId: prof.id }
}
const photographer = await vendorWith('photo', `Студия Обход ${RUN}`)
const florist = await vendorWith('florist', `Цветы Обход ${RUN}`)

// 4. Данные свадьбы: гости, задача, статья бюджета, заметка, желание, автобус, отель, опрос меню.
const guests = []
for (const [name, plusOne] of [['Ольга Обход', true], ['Марк Обход', false], ['Лена Обход', false]]) {
  guests.push(await call('POST', `/weddings/${W}/guests`, { name, plusOne }, T))
}
await call('POST', `/weddings/${W}/tasks`, { title: 'Обход: своя задача', period: '3–1 месяц' }, T)
await call('POST', `/weddings/${W}/budget/items`, { title: 'Обход: фейерверк', categoryId: 'b4', amount: { amount: 3_000_000, currency: 'RUB' } }, T)
await call('POST', `/weddings/${W}/notes`, { text: 'Обход: заметка команды' }, T)
await call('POST', `/weddings/${W}/wishlist`, { name: 'Обход: кофемашина', price: { amount: 2_500_000, currency: 'RUB' }, group: true, icon: '☕' }, T)
await call('POST', `/weddings/${W}/logistics/buses`, { name: 'Автобус обхода', from: 'Уфа, Гостиный двор', time: '14:30', seats: 20 }, T)
await call('POST', `/weddings/${W}/logistics/hotels`, { name: 'Отель обхода', rooms: 5, price: { amount: 450_000, currency: 'RUB' }, deadline: '2027-08-20' }, T)
await call('PUT', `/weddings/${W}/menu-poll`, { question: 'Что будете на горячее?', options: [{ name: 'Рыба' }, { name: 'Мясо' }, { name: 'Овощи' }] }, T)

// 5. Чат с фотографом (лид), бронь фотографа с пакетом, аванс, договор.
const chat = await call('POST', `/chats/vendor/${photographer.vendorId}`, {}, T)
await call('POST', `/chats/${chat.id}/messages`, { text: 'Здравствуйте! Свободны на нашу дату?' }, T)
await call('POST', `/chats/${chat.id}/messages`, { text: 'Да, свободен. Расскажите про площадку' }, photographer.accessToken)
const slots = await call('GET', `/weddings/${W}/slots`, undefined, T)
const photoSlot = slots.find(s => s.categoryId === 'photo')
const prof = await call('GET', `/catalog/vendors/${photographer.vendorId}`, undefined, T)
const pkg = prof.packages?.[0]
const booked = await call('POST', `/weddings/${W}/slots/${photoSlot.id}/book`, { vendorId: photographer.vendorId, packageId: pkg?.id, price: { amount: 9_000_000, currency: 'RUB' } }, T, key())
await call('POST', `/weddings/${W}/slots/${photoSlot.id}/pay`, { amount: { amount: 3_000_000, currency: 'RUB' } }, T, key())
const dealId = booked.deal.id
await call('POST', `/deals/${dealId}/contract`, { templateCode: 'photographer', fields: { customerFullName: 'Аня Обход', performerFullName: 'Студия Обход' } }, T, key())

// 6. Гость с токеном.
const link = await call('POST', `/weddings/${W}/guests/${guests[0].id}/invite-link`, {}, T)
const code = link.url.split('/').pop()
const redeemed = await call('GET', `/invite/${code}`)

// 7. Заявка консьержу и жалоба — для панели.
await call('POST', '/catalog/concierge', { categoryId: 'firework', comment: 'Обход: заявка консьержу' }, T).catch(() => null)

// 8. Сотрудник — существующий аккаунт панели.
const staffPhone = process.argv[2]
const staff = staffPhone ? await login(staffPhone) : null
// Чистая база (CI): сотрудника ещё нет — одноразовый номер получает признак панели. Сервер читает is_staff из базы
// на каждом запросе (routes/admin.ts), так что выданный токен сразу работает в панели.
if (staff && env.WALK_MAKE_STAFF === '1') await db.query('update users set is_staff = true where phone = $1', [staffPhone])

const fixtures = {
  run: RUN, weddingId: W, date: DATE, dealId, chatId: chat.id, photoSlotId: photoSlot.id,
  vendorId: photographer.vendorId, floristVendorId: florist.vendorId,
  guestToken: redeemed.guestToken, guestCode: code, guestId: guests[0].id,
  roles: {
    couple: { accessToken: couple.accessToken, refreshToken: couple.refreshToken, phone: couple.phone, userId: couple.userId },
    helper: { accessToken: helper.accessToken, refreshToken: helper.refreshToken, phone: helper.phone },
    coordinator: { accessToken: coordinator.accessToken, refreshToken: coordinator.refreshToken, phone: coordinator.phone },
    vendor: { accessToken: photographer.accessToken, refreshToken: photographer.refreshToken, phone: photographer.phone },
    florist: { accessToken: florist.accessToken, refreshToken: florist.refreshToken, phone: florist.phone },
    ...(staff ? { staff: { accessToken: staff.accessToken, refreshToken: staff.refreshToken, phone: staff.phone } } : {}),
  },
}
writeFileSync(OUT, JSON.stringify(fixtures, null, 2))
await db.end()
console.log(JSON.stringify({ run: RUN, weddingId: W, dealId, chatId: chat.id, vendorId: photographer.vendorId, guest: !!redeemed.guestToken, roles: Object.keys(fixtures.roles) }))
