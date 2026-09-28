/** Disposable real-API fixture for stage 020 browser acceptance. */
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

const refreshSecret = 'b'.repeat(48)
const app = await buildApp({
  env: 'test',
  databaseUrl,
  redisUrl: null,
  jwtAccessSecret: 'a'.repeat(48),
  jwtRefreshSecret: refreshSecret,
  policyVersion: '2026-09-02',
  corsOrigins: ['http://127.0.0.1:3000'],
  rateLimitPerSecond: 0,
  otpMaxPerIpHour: 100,
  otpMaxPerHourTotal: 1000,
})
const users: string[] = []
const phones: string[] = []
let closing = false

async function close() {
  if (closing) return
  closing = true
  try {
    for (const id of users) await app.db!.tx((client) => eraseUser(client, id))
    await app.db!.query('delete from otp_codes where phone = any($1::text[])', [phones])
  } finally {
    await app.close()
  }
}

function checked<T>(response: { statusCode: number; body: string; json: () => T }, status: number): T {
  if (response.statusCode !== status) throw new Error(`Expected ${status}: ${response.statusCode} ${response.body}`)
  return response.body ? response.json() : undefined as T
}

await app.ready()
try {
  const phone = `+79${randomInt(100_000_000, 1_000_000_000)}`
  phones.push(phone)
  checked(await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone } }), 200)
  const hashes = await app.db!.query<{ code_hash: string }>(
    'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
    [phone],
  )
  let code = ''
  for (let n = 0; n < 10000; n++) {
    const candidate = String(n).padStart(4, '0')
    if (hashCode(refreshSecret, phone, candidate) === hashes.rows[0]!.code_hash) {
      code = candidate
      break
    }
  }
  if (!code) throw new Error('OTP fixture code not found')

  const tokens = checked(await app.inject({
    method: 'POST',
    url: '/auth/otp/verify',
    payload: { phone, code },
  }), 200) as { accessToken: string; refreshToken: string; user: { id: string } }
  users.push(tokens.user.id)
  const headers = { authorization: `Bearer ${tokens.accessToken}` }
  checked(await app.inject({
    method: 'POST',
    url: '/users/me/consent',
    headers,
    payload: { policyVersion: '2026-09-02' },
  }), 201)
  checked(await app.inject({
    method: 'PATCH',
    url: '/users/me',
    headers,
    payload: { name: 'Пара E2E 020' },
  }), 200)

  const date = `${new Date().getUTCFullYear() + 1}-06-14`
  const wedding = checked(await app.inject({
    method: 'POST',
    url: '/weddings',
    headers,
    payload: {
      partnerName: 'Партнёр E2E 020',
      date,
      city: { name: 'Уфа', region: 'Башкортостан' },
      guestsPlanned: 2,
    },
  }), 201) as { id: string }

  const menu = checked(await app.inject({
    method: 'PUT',
    url: `/weddings/${wedding.id}/menu-poll`,
    headers,
    payload: {
      question: 'Что будете есть E2E?',
      options: [
        { name: 'Стейк E2E', icon: '🥩' },
        { name: 'Паста E2E', icon: '🍝' },
      ],
    },
  }), 200) as { options: { id: string; name: string }[] }

  const bus = checked(await app.inject({
    method: 'POST',
    url: `/weddings/${wedding.id}/logistics/buses`,
    headers,
    payload: { name: 'Автобус семьи E2E', from: 'Центр Уфы', time: '14:00', seats: 2 },
  }), 201) as { id: string }

  const hotel = checked(await app.inject({
    method: 'POST',
    url: `/weddings/${wedding.id}/logistics/hotels`,
    headers,
    payload: { name: 'Отель семьи E2E', rooms: 1 },
  }), 201) as { id: string }

  const gift = checked(await app.inject({
    method: 'POST',
    url: `/weddings/${wedding.id}/wishlist`,
    headers,
    payload: { name: 'Подарок семьи E2E', price: { amount: 500_000, currency: 'RUB' } },
  }), 201) as { id: string }

  await writeFile(fixtureFile, JSON.stringify({
    owner: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
    weddingId: wedding.id,
    date,
    menu: menu.options,
    busId: bus.id,
    hotelId: hotel.id,
    giftId: gift.id,
  }), { mode: 0o600 })

  await app.listen({ host: '127.0.0.1', port: 3001 })
  process.stdout.write('FAMILY020_BROWSER_FIXTURE_READY\n')
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void close().catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
    })
  }
} catch (error) {
  await close()
  throw error
}
