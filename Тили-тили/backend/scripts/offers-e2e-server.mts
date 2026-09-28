/** Disposable real-API fixture for 019. No test endpoint and no production access. */
import { randomInt } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

const databaseUrl = process.env.TEST_DATABASE_URL
const fixtureFile = process.env.E2E_FIXTURE_FILE
if (!databaseUrl || !fixtureFile) throw new Error('TEST_DATABASE_URL and E2E_FIXTURE_FILE are required')
const target = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) {
  throw new Error('Only disposable local *_test databases are allowed')
}
const secret = 'b'.repeat(48)
const app = await buildApp({ env: 'test', databaseUrl, redisUrl: null,
  jwtAccessSecret: 'a'.repeat(48), jwtRefreshSecret: secret, policyVersion: '2026-09-02',
  corsOrigins: ['http://127.0.0.1:3000'], rateLimitPerSecond: 0,
  otpMaxPerIpHour: 100, otpMaxPerHourTotal: 1000 })
const users: string[] = [], phones: string[] = []
let closing = false
async function close() {
  if (closing) return
  closing = true
  try {
    for (const id of users) await app.db!.tx(client => eraseUser(client, id))
    await app.db!.query('delete from otp_codes where phone = any($1::text[])', [phones])
  } finally { await app.close() }
}
function checked<T>(response: { statusCode: number; body: string; json: () => T }, status: number): T {
  if (response.statusCode !== status) throw new Error(`Expected ${status}: ${response.statusCode} ${response.body}`)
  return response.body ? response.json() : undefined as T
}
await app.ready()
try {
  async function user(name: string) {
    const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`
    phones.push(phone)
    checked(await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone } }), 200)
    const hashes = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1', [phone])
    let code = ''
    for (let n = 0; n < 10000; n++) {
      const value = String(n).padStart(4, '0')
      if (hashCode(secret, phone, value) === hashes.rows[0]!.code_hash) { code = value; break }
    }
    const tokens = checked(await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } }), 200) as {
      accessToken: string; refreshToken: string; user: { id: string }
    }
    users.push(tokens.user.id)
    const headers = { authorization: `Bearer ${tokens.accessToken}` }
    checked(await app.inject({ method: 'POST', url: '/users/me/consent', headers, payload: { policyVersion: '2026-09-02' } }), 201)
    checked(await app.inject({ method: 'PATCH', url: '/users/me', headers, payload: { name } }), 200)
    return { name, id: tokens.user.id, tokens, headers }
  }
  const owner = await user('Аня E2E 019')
  const date = `${new Date().getUTCFullYear() + 1}-06-14`
  const wedding = checked(await app.inject({ method: 'POST', url: '/weddings', headers: owner.headers,
    payload: { partnerName: 'Боря E2E 019', date, city: { name: 'Уфа', region: 'Башкортостан' }, guestsPlanned: 88 } }), 201) as { id: string }
  const vendors = []
  for (const [name, packageName] of [['Свет E2E', 'Съёмка Свет'], ['Кадр E2E', 'Съёмка Кадр']]) {
    const person = await user(name!)
    const profile = checked(await app.inject({ method: 'PUT', url: '/vendor/profile', headers: person.headers, payload: {
      name, categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' },
      portfolioUrls: ['https://example.com/portfolio.jpg'], priceFrom: { amount: 8000000, currency: 'RUB' },
      packages: [{ name: packageName, includes: ['Съёмка 8 часов', '500 фотографий'], price: { amount: 10000000, currency: 'RUB' } }],
    } }), 200) as { id: string }
    checked(await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: person.headers }), 200)
    vendors.push({ ...person, vendorId: profile.id, packageName })
  }
  await writeFile(fixtureFile, JSON.stringify({ owner, vendors, weddingId: wedding.id, date }), { mode: 0o600 })
  await app.listen({ host: '127.0.0.1', port: 3001 })
  process.stdout.write('OFFERS_BROWSER_FIXTURE_READY\n')
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
    void close().catch(error => { console.error(error); process.exitCode = 1 })
  })
} catch (error) {
  await close()
  throw error
}
