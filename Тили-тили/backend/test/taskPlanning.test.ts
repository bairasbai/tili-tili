import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

const DB = process.env.TEST_DATABASE_URL
const ACCESS = 'a'.repeat(48)
const REFRESH = 'b'.repeat(48)

describe.skipIf(!DB)('017: планирование задач — API, права, перенос и жизненный цикл', () => {
  let app: FastifyInstance
  let counter = 0
  let run = String(randomInt(100_000, 1_000_000))
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null, corsOrigins: [],
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
      payload: { partnerName: 'Тест задач', city: { name: 'Уфа', region: 'Башкортостан' }, ...(date ? { date } : {}) } })
    expect(res.statusCode, res.body).toBe(201)
    return { ...owner, weddingId: res.json().id as string }
  }
  type Wedding = Awaited<ReturnType<typeof wedding>>
  const post = (w: Wedding, body: Record<string, unknown>) => app.inject({ method: 'POST',
    url: `/weddings/${w.weddingId}/tasks`, headers: auth(w.token), payload: { title: 'Задача', period: '3', ...body } })
  const patch = (w: Wedding, taskId: string, body: Record<string, unknown>) => app.inject({ method: 'PATCH',
    url: `/weddings/${w.weddingId}/tasks/${taskId}`, headers: auth(w.token), payload: body })
  const list = (w: Wedding, query = '') => app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/tasks${query}`, headers: auth(w.token) })
  async function member(w: Wedding, role = 'helper') {
    const u = await user()
    await app.db!.query('insert into wedding_members (wedding_id,user_id,role) values ($1,$2,$3)', [w.weddingId, u.id, role])
    return u
  }
  const shift = (w: Wedding) => app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/reschedule`,
    headers: { ...auth(w.token), 'idempotency-key': randomUUID() }, payload: { date: '2027-07-14' } })

  it('создаёт назначенную задачу, возвращает планирование и фильтрует mine', async () => {
    const w = await wedding()
    const other = await member(w)
    const mine = await post(w, { assigneeId: w.id, due: '2027-05-10' })
    const theirs = await post(w, { assigneeId: other.id })
    expect(mine.statusCode, mine.body).toBe(201)
    expect(mine.json()).toMatchObject({ due: '2027-05-10', dueMode: 'fixed', assignee: { userId: w.id } })
    expect(theirs.statusCode).toBe(201)
    const selected = await list(w, '?mine=true')
    expect(selected.statusCode).toBe(200)
    expect(selected.json().map((t: { id: string }) => t.id)).toEqual([mine.json().id])
    const helperList = await list({ ...w, token: other.token }, '?mine=true')
    expect(helperList.json().map((t: { id: string }) => t.id)).toEqual([theirs.json().id])
  })
  it('точная дата PATCH по умолчанию становится fixed и не переносится', async () => {
    const w = await wedding()
    const created = await post(w, {})
    const changed = await patch(w, created.json().id, { due: '2027-05-01' })
    expect(changed.statusCode).toBe(200)
    expect(changed.json().dueMode).toBe('fixed')
    expect((await shift(w)).statusCode).toBe(200)
    expect((await list(w)).json().find((t: { id: string }) => t.id === created.json().id).due).toBe('2027-05-01')
  })
  it('relative следует за свадьбой, fixed сохраняет дату', async () => {
    const w = await wedding()
    const relative = await post(w, { due: '2027-05-01', dueMode: 'relative' })
    const fixed = await post(w, { due: '2027-05-01', dueMode: 'fixed' })
    expect(relative.statusCode).toBe(201)
    expect((await shift(w)).statusCode).toBe(200)
    const tasks = (await list(w)).json() as { id: string; due: string }[]
    expect(tasks.find(t => t.id === relative.json().id)?.due).toBe('2027-05-31')
    expect(tasks.find(t => t.id === fixed.json().id)?.due).toBe('2027-05-01')
  })
  it('явное снятие срока не восстанавливается при первой дате свадьбы', async () => {
    const w = await wedding(null)
    const created = await post(w, {})
    const cleared = await patch(w, created.json().id, { due: null })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json()).toMatchObject({ due: null, dueMode: 'fixed' })
    expect((await shift(w)).statusCode).toBe(200)
    expect((await list(w)).json().find((t: { id: string }) => t.id === created.json().id).due).toBeNull()
  })
  it('не принимает относительную точную дату без даты свадьбы', async () => {
    const w = await wedding(null)
    expect((await post(w, { due: '2027-05-01', dueMode: 'relative' })).statusCode).toBe(422)
    expect((await post(w, { due: '2027-05-01', dueMode: 'fixed' })).statusCode).toBe(201)
  })
  it('обрабатывает снятие ответственного и смену режима срока', async () => {
    const w = await wedding()
    const created = await post(w, { assigneeId: w.id, due: '2027-05-01' })
    const changed = await patch(w, created.json().id, { assigneeId: null, dueMode: 'relative' })
    expect(changed.statusCode).toBe(200)
    expect(changed.json()).toMatchObject({ assignee: null, dueMode: 'relative', due: '2027-03-14' })
  })
  it.each(['2027-02-30', '2027-13-01', '2027-1-1', ''])('отклоняет неверную дату %s без записи', async due => {
    const w = await wedding()
    const before = (await list(w)).json().length
    expect((await post(w, { due })).statusCode).toBe(422)
    expect((await list(w)).json()).toHaveLength(before)
  })
  it('слишком большой числовой период — 422, а не ошибка PostgreSQL', async () => {
    const w = await wedding()
    expect((await post(w, { period: '99999999999999999999' })).statusCode).toBe(422)
  })
  it('посторонний, удалённый и vendor не могут быть ответственными', async () => {
    const w = await wedding()
    const stranger = await user()
    expect((await post(w, { assigneeId: stranger.id })).statusCode).toBe(422)
    const deleted = await member(w)
    await app.db!.query('update users set deleted_at=now() where id=$1', [deleted.id])
    expect((await post(w, { assigneeId: deleted.id })).statusCode).toBe(422)
    const vendor = await member(w, 'vendor')
    expect((await post(w, { assigneeId: vendor.id })).statusCode).toBe(422)
  })
  it('чужая задача — 404, помощник не получает деньги и документы через назначение', async () => {
    const a = await wedding()
    const b = await wedding()
    const helper = await member(a)
    const created = await post(a, { assigneeId: helper.id })
    expect((await patch(b, created.json().id, { title: 'Чужая правка' })).statusCode).toBe(404)
    for (const area of ['budget', 'documents']) {
      expect((await app.inject({ method: 'GET', url: `/weddings/${a.weddingId}/${area}`, headers: auth(helper.token) })).statusCode).toBe(403)
    }
  })
  it('удаление участника снимает назначение, не удаляя задачу', async () => {
    const w = await wedding()
    const helper = await member(w)
    const task = (await post(w, { assigneeId: helper.id })).json()
    const removal = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/members/${helper.id}`, headers: auth(w.token) })
    expect(removal.statusCode).toBe(204)
    expect((await list(w)).json().find((t: { id: string }) => t.id === task.id).assignee).toBeNull()
  })
  it('мягкое удаление аккаунта снимает назначение', async () => {
    const w = await wedding()
    const helper = await member(w)
    const task = (await post(w, { assigneeId: helper.id })).json()
    const deletion = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(helper.token) })
    expect(deletion.statusCode, deletion.body).toBe(204)
    expect((await list(w)).json().find((t: { id: string }) => t.id === task.id).assignee).toBeNull()
  })
  it('назначение одновременно с удалением участника не оставляет висячую связь', async () => {
    const w = await wedding()
    const helper = await member(w)
    const task = (await post(w, {})).json()
    const [assigned, removed] = await Promise.all([
      patch(w, task.id, { assigneeId: helper.id }),
      app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/members/${helper.id}`, headers: auth(w.token) }),
    ])
    expect([200, 422]).toContain(assigned.statusCode)
    expect(removed.statusCode).toBe(204)
    expect((await list(w)).json().find((t: { id: string }) => t.id === task.id).assignee).toBeNull()
  })
  it('старые операции done/title и системный planb остаются рабочими', async () => {
    const w = await wedding()
    const planb = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/planb`, headers: auth(w.token) })
    const id = planb.json().checklist[0].id
    expect((await patch(w, id, { done: true })).json().done).toBe(true)
    expect((await patch(w, id, { assigneeId: w.id })).statusCode).toBe(422)
    const sys = (await list(w)).json()[0]
    expect((await patch(w, sys.id, { title: 'Новое название', done: true })).json()).toMatchObject({ title: 'Новое название', done: true })
    expect((await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/tasks/${sys.id}`, headers: auth(w.token) })).statusCode).toBe(409)
  })
})
