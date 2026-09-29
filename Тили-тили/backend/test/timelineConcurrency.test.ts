import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { QueryResultRow } from 'pg'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const ACCESS = 'a'.repeat(48)
const REFRESH = 'b'.repeat(48)

describe.skipIf(!DB)('021: согласованность снимка тайминга — реальные транзакции', () => {
  let app: FastifyInstance
  let counter = 0
  let run = String(randomInt(100_000, 1_000_000))
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null, corsOrigins: ['https://planner.example'],
      jwtAccessSecret: ACCESS, jwtRefreshSecret: REFRESH, policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000, otpMaxPerIpHour: 1_000_000 })
    await app.ready()
    while ((await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${run}%`])).rows.length) {
      run = String(randomInt(100_000, 1_000_000))
    }
  })
  afterAll(async () => { await app?.close() })
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  async function user() {
    const phone = `+79${run}${String(++counter).padStart(3, '0')}`
    const otp = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone } })
    expect(otp.statusCode).toBe(200)
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone=$1 and consumed_at is null order by created_at desc limit 1', [phone])
    let code = ''
    for (let i = 0; i < 10_000; i++) {
      const candidate = String(i).padStart(4, '0')
      if (hashCode(REFRESH, phone, candidate) === rows[0]!.code_hash) { code = candidate; break }
    }
    const login = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    expect(login.statusCode).toBe(200)
    const { accessToken: token, user: me } = login.json() as { accessToken: string; user: { id: string } }
    const consent = await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(token),
      payload: { policyVersion: '2026-09-02', adult: true } })
    expect(consent.statusCode).toBe(201)
    return { token, id: me.id }
  }
  async function wedding(date: string | null = '2027-06-14') {
    const owner = await user()
    const res = await app.inject({ method: 'POST', url: '/weddings', headers: auth(owner.token),
      payload: { partnerName: 'Тест тайминга', city: { name: 'Уфа', region: 'Башкортостан' }, ...(date ? { date } : {}) } })
    expect(res.statusCode, res.body).toBe(201)
    return { ...owner, weddingId: res.json().id as string }
  }

  type Wedding = Awaited<ReturnType<typeof wedding>>
  const list = (w: Wedding) => app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`, headers: auth(w.token) })
  const put = (w: Wedding, etag: string, payload: unknown[]) => app.inject({ method: 'PUT',
    url: `/weddings/${w.weddingId}/timeline`, headers: { ...auth(w.token), 'if-match': etag }, payload })
  const blankEvent = (name: string) => ({ name, timingMode: 'flexible', forGuests: true,
    assigneeUserIds: [], dealIds: [], dependsOn: [], outdoor: true })

  it('GET не сочетает старые события с новой версией между двумя SELECT', async () => {
    const w = await wedding()
    const original = (await list(w)).json() as { id: string; name: string }[]
    const db = app.db!
    const query = db.query.bind(db)
    let release!: () => void
    const eventRead = new Promise<void>(resolve => { release = resolve })
    // Inject a real transaction into the gap of an event-only SELECT followed
    // by a version-only SELECT. A single-statement read has no such gap.
    db.query = async <T extends QueryResultRow>(sql: string, values?: readonly unknown[]) => {
      if (/^select timeline_version from weddings/i.test(sql.trim())) {
        await eventRead
        await db.tx(async client => {
          await client.query('select id from weddings where id=$1 for update', [w.weddingId])
          await client.query('update timeline_events set name=$2 where id=$1', [original[0]!.id, 'Новая версия'])
          await client.query('update weddings set timeline_version=timeline_version+1 where id=$1', [w.weddingId])
        })
      }
      const result = await query<T>(sql, values)
      if (/from timeline_events e where e\.wedding_id/i.test(sql) && !sql.includes('timeline_version')) release()
      return result
    }
    try {
      const snapshot = await list(w)
      const first = (snapshot.json() as { name: string }[])[0]!
      const version = snapshot.headers.etag
      expect([
        { etag: '"timeline-1"', name: original[0]!.name },
        { etag: '"timeline-2"', name: 'Новая версия' },
      ]).toContainEqual({ etag: version, name: first.name })
    } finally {
      db.query = query
    }
  })

  it('пустой тайминг также получает ETag и принимает следующую версию', async () => {
    const w = await wedding()
    const initial = await list(w)
    const empty = await put(w, initial.headers.etag!, [])
    expect(empty.statusCode, empty.body).toBe(200)
    const read = await list(w)
    expect(read.json()).toEqual([])
    expect(read.headers.etag).toBe(empty.headers.etag)
    const next = await put(w, read.headers.etag!, [blankEvent('Новый блок')])
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json()[0].id).toBeTruthy()
  })

  it('две одновременные записи одной версии: ровно одна принимается', async () => {
    const w = await wedding()
    const initial = await list(w)
    const replies = await Promise.all([
      put(w, initial.headers.etag!, [blankEvent('A')]),
      put(w, initial.headers.etag!, [blankEvent('B')]),
    ])
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409])
    const winner = replies.find(r => r.statusCode === 200)!
    const final = await list(w)
    expect(final.body).toBe(winner.body)
    expect(final.headers.etag).toBe(winner.headers.etag)
  })

  it('autogen возвращает версию своего preview без мутации', async () => {
    const w = await wedding()
    const before = await list(w)
    const preview = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/timeline/autogen`, headers: auth(w.token) })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers.etag).toBe(before.headers.etag)
    expect((await list(w)).body).toBe(before.body)
  })

  it('отрицательная длительность не обходит ограничения графа', async () => {
    const w = await wedding()
    const before = await list(w)
    const invalid = await put(w, before.headers.etag!, [{ ...blankEvent('Неверный интервал'),
      startsAt: '2027-06-14T15:00:00Z', endsAt: '2027-06-14T14:00:00Z' }])
    expect(invalid.statusCode, invalid.body).toBe(422)
    expect((await list(w)).body).toBe(before.body)
    expect((await list(w)).headers.etag).toBe(before.headers.etag)
  })

  it('разрешённый CORS-клиент может прочитать ETag и отправить PUT/If-Match', async () => {
    const w = await wedding()
    const get = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), origin: 'https://planner.example' } })
    expect(String(get.headers['access-control-expose-headers']).toLowerCase().split(/,\s*/)).toContain('etag')
    const options = await app.inject({ method: 'OPTIONS', url: `/weddings/${w.weddingId}/timeline`, headers: {
      origin: 'https://planner.example', 'access-control-request-method': 'PUT',
      'access-control-request-headers': 'authorization,content-type,if-match',
    } })
    expect(options.statusCode, options.body).toBe(204)
    expect(String(options.headers['access-control-allow-methods']).split(/,\s*/)).toContain('PUT')
    expect(String(options.headers['access-control-allow-headers']).toLowerCase()).toContain('if-match')
  })

  it.each(['shift', 'reschedule'])('%s инвалидирует открытый редактор и сохраняет IDs', async mutation => {
    const w = await wedding()
    const before = await list(w)
    const response = await app.inject({ method: 'POST',
      url: `/weddings/${w.weddingId}/${mutation === 'shift' ? 'timeline/shift' : 'reschedule'}`,
      headers: { ...auth(w.token), 'idempotency-key': randomUUID() },
      payload: mutation === 'shift' ? { minutes: 15 } : { date: '2027-07-14' } })
    expect(response.statusCode, response.body).toBe(200)
    const stale = await put(w, before.headers.etag!, before.json())
    expect(stale.statusCode, stale.body).toBe(409)
    const after = await list(w)
    expect(after.headers.etag).not.toBe(before.headers.etag)
    expect(after.json().map((e: { id: string }) => e.id)).toEqual(before.json().map((e: { id: string }) => e.id))
  })
})
