import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { components, paths } from '../src/contract/api.generated.js'

const DB = process.env.TEST_DATABASE_URL
const POLICY = '2026-09-02'
const SECRET = 'a'.repeat(48)
const year = new Date().getUTCFullYear() + 1
const day = (number: number) => `${year}-06-${String(number).padStart(2, '0')}`
type Actor = { id: string; token: string }
type Schema = components['schemas']
type QuizFields = Pick<paths['/weddings']['post']['requestBody']['content']['application/json'],
  'venue' | 'guestsPlanned' | 'format' | 'planner'>

describe.skipIf(!DB)('FR009: предпросмотр переноса даты', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => {
    try {
      await app?.db?.query('delete from weddings where id=any($1::uuid[])', [weddings])
      await app?.db?.query('delete from users where id=any($1::uuid[])', [users])
    } finally { await app?.close() }
  })

  async function session(id: string): Promise<Actor> {
    const sid = randomUUID()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid, id, randomUUID()])
    return { id, token: await signAccessToken(SECRET, { sub: id, sid }) }
  }
  async function user(name: string) {
    const id = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`, name])
    users.push(id)
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [randomUUID(), id, POLICY])
    return session(id)
  }
  function call(actor: Actor, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, key?: string) {
    return app.inject({ method, url, payload,
      headers: { authorization: `Bearer ${actor.token}`, ...(key ? { 'idempotency-key': key } : {}) } })
  }
  async function wedding(date?: string, answers: QuizFields = {}) {
    const owner = await user('Пара FR009')
    const response = await call(owner, 'POST', '/weddings', {
      partnerName: 'Синтетический тест переноса', city: { name: 'Уфа', region: 'Башкортостан' },
      ...(date ? { date } : {}), prebooked: ['photo'], ...answers,
    })
    expect(response.statusCode, response.body).toBe(201)
    const id = response.json<{ id: string }>().id
    weddings.push(id)
    return { owner, id, path: `/weddings/${id}` }
  }
  async function preview(actor: Actor, path: string, date: string) {
    const result = await call(actor, 'POST', path + '/reschedule/preview', { date })
    expect(result.statusCode, result.body).toBe(200)
    expect(result.headers['cache-control']).toBe('no-store')
    return result.json<Schema['WeddingReschedulePreview']>()
  }
  const move = (actor: Actor, path: string, date: string, previewToken: string, key: string = randomUUID()) =>
    call(actor, 'POST', path + '/reschedule', { date, previewToken }, key)
  async function get<T>(actor: Actor, path: string) {
    const response = await call(actor, 'GET', path)
    expect(response.statusCode, response.body).toBe(200)
    return response.json<T>()
  }
  const savedDate = async (actor: Actor, path: string) => (await get<Schema['Wedding']>(actor, path)).date

  it('предлагает первую дату и сохраняет сроки, прежнюю внешнюю отметку и отдельное мероприятие после повторного входа', async () => {
    const { id, path, owner } = await wedding()
    const extra = randomUUID(), fixed = randomUUID()
    await app.db!.query(`insert into wedding_events(id,wedding_id,name,kind,date,time_zone)
      values($1,$2,'Второй день','second_day',$3,'Asia/Yekaterinburg')`, [extra, id, day(24)])
    await app.db!.query(`insert into tasks(id,wedding_id,title,kind,source,period,due,due_mode)
      values($1,$2,'Фиксированный срок','checklist','user','3',$3,'fixed')`, [fixed, id, day(9)])
    const initial = await preview(owner, path, day(15))
    expect(initial).toMatchObject({ currentDate: null, newDate: day(15), canConfirm: true })
    expect(initial.tasks.length).toBeGreaterThan(0)
    expect(initial.timeline.length).toBeGreaterThan(0)
    expect(initial.tasks.some(task => task.id === fixed)).toBe(false)
    expect(initial.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ main: true, before: null, after: day(15) }),
      expect.objectContaining({ id: extra, main: false, before: day(24), after: day(24) }),
    ]))
    expect(await savedDate(owner, path)).toBeNull()
    const task = initial.tasks[0]!
    expect((await app.db!.query('select due from tasks where id=$1', [task.id])).rows[0].due).toBeNull()
    const key = randomUUID()
    const confirmed = await move(owner, path, day(15), initial.previewToken, key)
    expect(confirmed.statusCode, confirmed.body).toBe(200)
    const replayed = await move(owner, path, day(15), initial.previewToken, key)
    expect(replayed.statusCode, replayed.body).toBe(200)
    expect(replayed.headers['idempotent-replay']).toBe('true')
    const reopened = await session(owner.id)
    expect(await savedDate(reopened, path)).toBe(day(15))
    const slots = (await call(reopened, 'GET', path + '/slots')).json<Schema['Slot'][]>()
    expect(slots.find(slot => slot.categoryId === 'photo')?.prebooked).toBe(true)
    const readDue = async (taskId: string) => (await app.db!.query('select due::text as due from tasks where id=$1', [taskId])).rows[0].due
    expect(await readDue(task.id)).toBe(task.after)
    expect(await readDue(fixed)).toBe(day(9))
    const blocks = (await app.db!.query('select id,starts_at,ends_at from timeline_events where wedding_id=$1', [id])).rows
    for (const block of initial.timeline) {
      const saved = blocks.find(row => row.id === block.id)
      expect(saved?.starts_at?.toISOString() ?? null).toBe(block.afterStart ? new Date(block.afterStart).toISOString() : null)
      expect(saved?.ends_at?.toISOString() ?? null).toBe(block.afterEnd ? new Date(block.afterEnd).toISOString() : null)
    }
    const next = await preview(reopened, path, day(18))
    expect(next.tasks.find(row => row.id === task.id)?.before).toBe(task.after)
    expect(next.events.find(row => row.id === extra)?.after).toBe(day(24))
  })

  it('ограничивает доступ парой и отклоняет чужую сессию, дату и изменившуюся задачу', async () => {
    const { id, path, owner } = await wedding(day(10))
    const helper = await user('Помощник FR009')
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [id, helper.id])
    expect((await call(helper, 'POST', path + '/reschedule/preview', { date: day(15) })).statusCode).toBe(403)
    const outside = await user('Чужой аккаунт FR009')
    expect((await call(outside, 'POST', path + '/reschedule/preview', { date: day(15) })).statusCode).toBe(404)
    const initial = await preview(owner, path, day(15))
    const otherSession = await session(owner.id)
    expect((await move(otherSession, path, day(15), initial.previewToken)).json().error.code).toBe('reschedule_preview_changed')
    expect((await move(owner, path, day(16), initial.previewToken)).json().error.code).toBe('reschedule_preview_changed')
    await app.db!.query('update tasks set title=$2 where id=$1', [initial.tasks[0]!.id, 'Уточнённая задача'])
    const stale = await move(owner, path, day(15), initial.previewToken)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('reschedule_preview_changed')
    expect(await savedDate(owner, path)).toBe(day(10))
    const [left, right] = await Promise.all([preview(owner, path, day(15)), preview(owner, path, day(16))])
    const responses = await Promise.all([move(owner, path, day(15), left.previewToken), move(owner, path, day(16), right.previewToken)])
    expect(responses.map(result => result.statusCode).sort(), responses.map(result => result.body).join('\n')).toEqual([200, 409])
    expect(responses.find(result => result.statusCode === 409)!.json().error.code).toBe('reschedule_preview_changed')
  })

  it('пересчитывает календарный месяц шаблона и сохраняет правила ручных сроков', async () => {
    const initialDate = `${year}-03-30`, targetDate = `${year}-04-30`
    const februaryEnd = new Date(Date.UTC(year, 2, 0)).toISOString().slice(0, 10)
    const { path, owner } = await wedding(initialDate)
    const taskPath = path + '/tasks'
    const tasks = await get<Schema['Task'][]>(owner, taskPath)
    const menu = tasks.find(row => row.title === 'Утвердить окончательное меню')!
    const timing = tasks.find(row => row.title === 'Утвердить тайминг дня')!
    const fixed = tasks.find(row => row.title === 'Финальная рассадка гостей')!
    expect(menu.due).toBe(februaryEnd)
    const changeDue = async (taskId: string, due: string, dueMode: 'relative' | 'fixed') => {
      const response = await call(owner, 'PATCH', `${taskPath}/${taskId}`, { due, dueMode })
      expect(response.statusCode, response.body).toBe(200)
    }
    await changeDue(timing.id, `${year}-03-05`, 'relative')
    await changeDue(fixed.id, `${year}-03-03`, 'fixed')
    const created = await call(owner, 'POST', taskPath, { title: 'Пользовательская задача', period: '1' })
    expect(created.statusCode, created.body).toBe(201)
    const custom = created.json<Schema['Task']>()
    expect(custom.due).toBe(februaryEnd)

    const proposed = await preview(owner, path, targetDate)
    expect(proposed.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: menu.id, before: februaryEnd, after: `${year}-03-30` }),
      expect.objectContaining({ id: timing.id, before: `${year}-03-05`, after: `${year}-04-05` }),
      expect.objectContaining({ id: custom.id, before: februaryEnd, after: `${year}-03-31` }),
    ]))
    expect(proposed.tasks.some(row => row.id === fixed.id)).toBe(false)
    expect((await get<Schema['Task'][]>(owner, taskPath)).find(row => row.id === menu.id)?.due).toBe(februaryEnd)
    const moved = await move(owner, path, targetDate, proposed.previewToken)
    expect(moved.statusCode, moved.body).toBe(200)
    const saved = await get<Schema['Task'][]>(await session(owner.id), taskPath)
    for (const id of [menu.id, timing.id, custom.id]) {
      expect(saved.find(row => row.id === id)?.due).toBe(proposed.tasks.find(row => row.id === id)?.after)
    }
    expect(saved.find(row => row.id === fixed.id)?.due).toBe(`${year}-03-03`)
  })

  it.each([false, true])('SC-001: пропуски, отметка о брони, поручение и сроки после нового входа (короткая подготовка: %s)', async shortPlan => {
    const { initialDate, movedDate, previousWeekDue, expectedWeekDue } = shortPlan
      ? (await app.db!.query<{ initialDate: string; movedDate: string; previousWeekDue: string; expectedWeekDue: string }>(`select
          (today+30)::text as "initialDate", (today+33)::text as "movedDate",
          (today+23)::text as "previousWeekDue", (today+26)::text as "expectedWeekDue"
          from (select (now() at time zone 'Asia/Yekaterinburg')::date as today) local`)).rows[0]!
      : { initialDate: undefined, movedDate: day(15), previousWeekDue: null, expectedWeekDue: day(8) }
    const answers: QuizFields = shortPlan ? { venue: 'Синтетический зал', guestsPlanned: 30, format: 'intimate', planner: 'self' } : {}
    const { id, path, owner } = await wedding(initialDate, answers)
    const first = await get<Schema['Wedding']>(owner, path)
    expect(first).toMatchObject({
      id, date: initialDate ?? null, venue: answers.venue ?? null, style: null,
      format: answers.format ?? null, planner: answers.planner ?? null, guestsPlanned: answers.guestsPlanned ?? null,
      budgetTotal: null,
    })
    const tasks = await get<Schema['Task'][]>(owner, path + '/tasks')
    const task = tasks.find(row => row.title === 'Составить список гостей')!
    const weekTask = tasks.find(row => row.period === 'last_week')!
    expect(weekTask.due).toBe(previousWeekDue)
    expect(task).toMatchObject({ planPriority: 'foundation', done: false, dueMode: 'relative' })
    expect(tasks.find(row => row.planPriority === 'date')?.done).toBe(shortPlan)
    expect(tasks.find(row => row.title === 'Найти фотографа')).toMatchObject({ done: true })
    if (shortPlan) {
      expect(task.due).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    } else {
      expect(tasks.find(row => row.planPriority === 'date')).toMatchObject({ done: false, due: null })
      expect(tasks.every(row => row.due === null)).toBe(true)
    }
    const invite = await call(owner, 'POST', path + '/task-delegations', { taskId: task.id })
    expect(invite.statusCode, invite.body).toBe(201)
    const grant = invite.json<Schema['TaskDelegationInvitation']>()
    const helper = await user('Помощник короткого плана')
    const accepted = await call(helper, 'POST', '/users/me/task-delegations/accept', { code: grant.code })
    expect(accepted.statusCode, accepted.body).toBe(204)
    const proposed = await preview(owner, path, movedDate)
    if (!shortPlan) expect(proposed.tasks.some(row => row.id === tasks.find(t => t.planPriority === 'date')?.id)).toBe(false)
    const changed = proposed.tasks.find(row => row.id === task.id)
    expect(proposed).toMatchObject({ currentDate: first.date, newDate: movedDate, canConfirm: true })
    expect(changed).toMatchObject({ before: task.due, after: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
    expect(proposed.tasks.find(row => row.id === weekTask.id)).toMatchObject({ before: weekTask.due, after: expectedWeekDue })
    expect(await savedDate(owner, path)).toBe(first.date)
    const committed = await move(owner, path, proposed.newDate, proposed.previewToken)
    expect(committed.statusCode, committed.body).toBe(200)
    const [ownerAgain, helperAgain] = await Promise.all([session(owner.id), session(helper.id)])
    const owned = await get<(Schema['Wedding'] & { role: string })[]>(ownerAgain, '/weddings')
    expect(owned).toEqual([expect.objectContaining({ id, role: 'couple', date: movedDate,
      venue: first.venue, format: first.format, planner: first.planner, guestsPlanned: first.guestsPlanned, style: null, budgetTotal: null })])
    const savedTasks = await get<Schema['Task'][]>(ownerAgain, path + '/tasks')
    expect(savedTasks.find(row => row.planPriority === 'date')?.done).toBe(true)
    expect(savedTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: task.id, due: changed!.after, done: false }),
      expect.objectContaining({ id: weekTask.id, due: expectedWeekDue }),
      expect.objectContaining({ title: 'Найти фотографа', done: true }),
    ]))
    const slots = await get<Schema['Slot'][]>(ownerAgain, path + '/slots')
    expect(slots.find(slot => slot.categoryId === 'photo')).toMatchObject({ prebooked: true, deal: null })
    const board = await get<Schema['TaskDelegationBoard']>(ownerAgain, path + '/task-delegations')
    expect(board.items).toEqual([expect.objectContaining({ id: grant.id, taskId: task.id, accepted: true })])
    const delegated = await get<Schema['DelegatedTask'][]>(helperAgain, '/users/me/task-delegations')
    expect(delegated).toEqual([expect.objectContaining({ id: grant.id, title: task.title, due: changed!.after })])
    expect((await call(helperAgain, 'GET', path + '/budget')).statusCode).toBe(404)
  })

  it('отличает отсутствие отметки, свежую дату, предварительную бронь и конфликт', async () => {
    const { path, owner } = await wedding(day(10))
    const slots = (await call(owner, 'GET', path + '/slots')).json<Schema['Slot'][]>()
    const cake = slots.find(slot => slot.categoryId === 'cake')!, host = slots.find(slot => slot.categoryId === 'host')!
    const external = await call(owner, 'POST', path + '/slots/' + cake.id + '/external',
      { vendorName: 'Внешний кондитер', price: { amount: 100, currency: 'RUB' } }, randomUUID())
    expect(external.statusCode, external.body).toBe(200)
    const vendor = await user('Исполнитель FR009')
    const profile = await call(vendor, 'PUT', '/vendor/profile', {
      name: 'Ведущий FR009', categoryId: 'host', city: { name: 'Уфа', region: 'Башкортостан' },
      priceFrom: { amount: 100, currency: 'RUB' },
    })
    expect(profile.statusCode, profile.body).toBe(200)
    expect((await call(vendor, 'POST', '/vendor/profile/publish')).statusCode).toBe(200)
    const vendorId = profile.json<{ id: string }>().id
    const booking = await call(owner, 'POST', path + '/slots/' + host.id + '/book',
      { vendorId, price: { amount: 100, currency: 'RUB' } }, randomUUID())
    expect(booking.statusCode, booking.body).toBe(200)
    const unknown = await preview(owner, path, day(15))
    expect(unknown.bookings).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Внешний кондитер', availability: 'unknown', moves: true }),
      expect.objectContaining({ name: 'Ведущий FR009', availability: 'unknown', moves: true }),
    ]))
    const confirmAvailability = () => call(vendor, 'PUT', '/vendor/calendar/availability', { dates: [day(15)] })
    expect((await confirmAvailability()).statusCode).toBe(204)
    const hostAvailability = async () => (await preview(owner, path, day(15))).bookings.find(row => row.name === 'Ведущий FR009')?.availability
    const clear = await preview(owner, path, day(15))
    expect(clear.bookings.find(row => row.name === 'Ведущий FR009')?.availability).toBe('calendar_clear')
    await app.db!.query("update vendor_free_date_confirmations set confirmed_at=now()-interval '25 hours' where vendor_id=$1 and date=$2", [vendorId, day(15)])
    expect(await hostAvailability()).toBe('unknown')
    const expired = await move(owner, path, day(15), clear.previewToken)
    expect(expired.statusCode).toBe(409)
    expect(expired.json().error.code).toBe('reschedule_preview_changed')
    expect((await confirmAvailability()).statusCode).toBe(204)
    const other = await wedding(day(15))
    const otherSlots = (await call(other.owner, 'GET', other.path + '/slots')).json<Schema['Slot'][]>()
    const otherHost = otherSlots.find(slot => slot.categoryId === 'host')!.id
    const otherDeal = randomUUID()
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'candidate',100)",
      [otherDeal, other.id, otherHost, vendorId])
    await app.db!.query('update slots set deal_id=$2 where id=$1', [otherHost, otherDeal])
    const advance = (state: string) => call(other.owner, 'PATCH', `/deals/${otherDeal}`, { state }, randomUUID())
    const hold = await advance('negotiating')
    expect(hold.statusCode, hold.body).toBe(200)
    const held = await preview(owner, path, day(15))
    expect(held.canConfirm).toBe(true)
    expect(held.bookings.find(row => row.name === 'Ведущий FR009')?.availability).toBe('hold')
    expect(held.bookings.some(row => row.id === otherDeal)).toBe(false)
    await app.db!.query("update deals set negotiating_until=now()-interval '1 hour' where id=$1", [otherDeal])
    expect(await hostAvailability()).toBe('calendar_clear')
    const taken = await advance('booked')
    expect(taken.statusCode, taken.body).toBe(200)
    const stale = await move(owner, path, day(15), held.previewToken)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('reschedule_preview_changed')
    const blocked = await preview(owner, path, day(15))
    expect(blocked.canConfirm).toBe(false)
    expect(blocked.bookings.find(row => row.name === 'Ведущий FR009')?.availability).toBe('busy')
    expect((await move(owner, path, day(15), blocked.previewToken)).json().error.code).toBe('reschedule_preview_blocked')
    expect(await savedDate(owner, path)).toBe(day(10))
  })
})
