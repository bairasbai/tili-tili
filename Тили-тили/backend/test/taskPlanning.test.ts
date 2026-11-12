import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import type { components } from '../src/contract/api.generated.js'
import { sendTaskReminders } from '../src/notify/task-notifications.js'

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
  const setApplicability = (w: Wedding, taskId: string, expectedRevision: string, reason: string | null) => app.inject({ method: 'PUT',
    url: `/weddings/${w.weddingId}/tasks/${taskId}/applicability`, headers: auth(w.token), payload: { expectedRevision, reason } })
  async function listTasks(w: Wedding, query = '') {
    const response = await list(w, query)
    expect(response.statusCode, response.body).toBe(200)
    return response.json<components['schemas']['Task'][]>()
  }
  async function member(w: Wedding, role = 'helper') {
    const u = await user()
    await app.db!.query('insert into wedding_members (wedding_id,user_id,role) values ($1,$2,$3)', [w.weddingId, u.id, role])
    return u
  }
  const shift = (w: Wedding, date = '2027-07-14') => app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/reschedule`,
    headers: { ...auth(w.token), 'idempotency-key': randomUUID() }, payload: { date } })

  it('считает одинаковые сроки этапов при создании и выборе первой даты', async () => {
    const eventDate = '2028-02-29'
    const dated = await wedding(eventDate)
    const undated = await wedding(null)
    const stages = ['12', 'last_week', 'wedding_day', 'after_wedding']
    const select = (tasks: components['schemas']['Task'][]) =>
      Object.fromEntries(tasks.filter(t => !t.custom && stages.includes(t.period ?? '')).map(t => [t.period, t.due]))
    expect(select(await listTasks(undated))).toEqual({ '12': null, last_week: null, wedding_day: null, after_wedding: null })
    const manual = await post(undated, { period: 'wedding_day' })
    expect(manual.statusCode, manual.body).toBe(201)
    const changed = await shift(undated, eventDate)
    expect(changed.statusCode, changed.body).toBe(200)
    const expected = { '12': '2027-02-28', last_week: '2028-02-22', wedding_day: '2028-02-29', after_wedding: '2028-03-07' }
    expect(select(await listTasks(dated))).toEqual(expected)
    const current = await listTasks(undated)
    expect(select(current)).toEqual(expected)
    expect(current.find(t => t.id === manual.json().id)).toMatchObject({ due: null, custom: true })
    expect(current.find(t => t.id === manual.json().id)).not.toHaveProperty('planPriority')

    const week = current.find(t => !t.custom && t.period === 'last_week')!
    const updated = await patch(undated, week.id!, { title: 'Связаться с командой', due: '2028-02-20' })
    expect(updated.statusCode, updated.body).toBe(200)
    expect(updated.json()).toMatchObject({ planPriority: 'coordination', dueMode: 'fixed' })
    const moved = await shift(undated, '2028-03-09')
    expect(moved.statusCode, moved.body).toBe(200)
    const later = await listTasks(undated)
    expect(later.find(t => t.id === week.id)).toMatchObject({ due: '2028-02-20', title: 'Связаться с командой' })
    expect(select(later)).toMatchObject({ last_week: '2028-02-20', wedding_day: '2028-03-09', after_wedding: '2028-03-16' })
    expect((await patch(undated, week.id!, { dueMode: 'relative' })).json()).toMatchObject({ due: '2028-03-02', planPriority: 'coordination' })
  })

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
  it('исключает шаблонную задачу с причиной, сохраняет данные и прекращает напоминания', async () => {
    const w = await wedding()
    const partner = { ...w, ...await member(w, 'couple') }
    const helper = { ...w, ...await member(w) }
    const coordinator = { ...w, ...await member(w, 'coordinator') }
    const outsider = await wedding()
    const week = () => app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/week`, headers: auth(w.token) })
    const beforeWeek = await week()
    expect(beforeWeek.statusCode, beforeWeek.body).toBe(200)
    const today = beforeWeek.json<components['schemas']['WeddingWeek']>().range.today
    const template = (await listTasks(w, '?includeExcluded=true')).find(t => t.applicability)!
    const planned = await patch(w, template.id!, { due: today, assigneeId: helper.id, reminderDaysBefore: 0, reminderTime: '09:00' })
    expect(planned.statusCode, planned.body).toBe(200)
    const current = (await listTasks(w, '?includeExcluded=true')).find(t => t.id === template.id)!
    const revision = current.applicability!.revision
    expect((await week()).body).toContain(template.id)
    expect((await setApplicability(helper, template.id!, revision, 'не требуется')).statusCode).toBe(403)
    expect((await setApplicability(outsider, template.id!, revision, 'не требуется')).statusCode).toBe(404)
    expect((await list(coordinator, '?includeExcluded=true')).statusCode).toBe(403)
    expect((await list(helper, '?includeExcluded=true')).statusCode).toBe(403)
    expect((await setApplicability(w, template.id!, revision, '  \t ')).statusCode).toBe(422)
    const custom = await post(w, {})
    expect((await setApplicability(w, custom.json().id, revision, 'не требуется')).statusCode).toBe(404)

    const excluded = await setApplicability(w, template.id!, revision, '  Без этой услуги  ')
    expect(excluded.statusCode, excluded.body).toBe(200)
    const saved = excluded.json<components['schemas']['Task']>()
    expect(saved).toMatchObject({ id: template.id, due: today, done: false, assignee: { userId: helper.id },
      reminderDaysBefore: 0, applicability: { reason: 'Без этой услуги' } })
    expect((await listTasks(partner, '?includeExcluded=true')).find(t => t.id === template.id)).toEqual(saved)
    expect((await listTasks(w)).some(t => t.id === template.id)).toBe(false)
    expect((await listTasks(helper, '?mine=true')).some(t => t.id === template.id)).toBe(false)
    expect((await week()).body).not.toContain(template.id)
    expect((await patch(helper, template.id!, { done: true })).statusCode).toBe(404)
    const exportedTasks = async (member: Wedding) => {
      const response = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(member.token) })
      expect(response.statusCode, response.body).toBe(200)
      return response.json<{ tasks: Record<string, unknown>[] }>().tasks
    }
    const exportedTask = { wedding_id: w.weddingId, title: saved.title }
    expect(await exportedTasks(partner)).toContainEqual(expect.objectContaining({ ...exportedTask, excluded_reason: 'Без этой услуги' }))
    for (const member of [helper, coordinator]) {
      expect(await exportedTasks(member)).not.toContainEqual(expect.objectContaining(exportedTask))
    }
    const { rows: [schedule] } = await app.db!.query<{ at: Date }>(
      `select ($1::date + time '09:10') at time zone coalesce(nullif(u.tz,''),w.tz,'Europe/Moscow') as at
       from weddings w cross join users u where w.id=$2 and u.id=$3`, [today, w.weddingId, helper.id])
    const reminderClock = schedule!.at
    await sendTaskReminders(app, reminderClock)
    const notices = () => app.db!.query<{ task_event: string; cancelled_at: Date | null }>(
      'select task_event,cancelled_at from notifications where task_id=$1 order by task_version,task_event', [template.id])
    expect((await notices()).rows).toEqual([{ task_event: 'assignment', cancelled_at: expect.any(Date) }])

    expect((await setApplicability(partner, template.id!, revision, null)).statusCode).toBe(409)
    const restored = await setApplicability(partner, template.id!, saved.applicability!.revision, null)
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json()).toMatchObject({ id: template.id, due: today, done: false, assignee: { userId: helper.id },
      reminderDaysBefore: 0, applicability: { reason: null } })
    expect((await week()).body).toContain(template.id)
    const restoredExport = (await exportedTasks(partner)).find(task => task.wedding_id === w.weddingId && task.title === saved.title)
    expect(restoredExport).toBeDefined()
    expect(restoredExport).not.toHaveProperty('excluded_reason')
    await sendTaskReminders(app, reminderClock)
    expect((await notices()).rows).toEqual([{ task_event: 'assignment', cancelled_at: expect.any(Date) },
      { task_event: 'reminder', cancelled_at: null }])
    const history = await app.db!.query('select action,diff from audit_log where entity_id=$1 and entity=$2 order by id', [template.id, 'task'])
    expect(history.rows).toEqual([{ action: 'task.excluded', diff: null }, { action: 'task.restored', diff: null }])
  })

  it('сериализует конкурирующие решения пары и повтор того же результата', async () => {
    const w = await wedding()
    const partner = { ...w, ...await member(w, 'couple') }
    const template = (await listTasks(w, '?includeExcluded=true')).find(t => t.applicability)!
    const revision = template.applicability!.revision
    const decisions = await Promise.all([
      setApplicability(w, template.id!, revision, 'Первый выбор'),
      setApplicability(partner, template.id!, revision, 'Второй выбор'),
    ])
    expect(decisions.map(r => r.statusCode).sort()).toEqual([200, 409])
    const winner = decisions.find(r => r.statusCode === 200)!.json<components['schemas']['Task']>()
    const retry = await setApplicability(w, template.id!, revision, winner.applicability!.reason)
    expect(retry.statusCode, retry.body).toBe(200)
    expect(retry.json()).toEqual(winner)
    const history = await app.db!.query('select action from audit_log where entity_id=$1 and entity=$2', [template.id, 'task'])
    expect(history.rows).toEqual([{ action: 'task.excluded' }])
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
