import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, forbidden, notFound, unauthorized, validationFailed } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { ref } from '../contract/schemas.generated.js'
import type { components } from '../contract/api.generated.js'
import { assertRealDate } from '../wedding/dates.js'
import { notifyTaskAssignment } from '../notify/task-notifications.js'

type TaskWrite = components['schemas']['TaskPatch']
type TaskCreate = components['schemas']['TaskCreate']
type DueMode = 'relative' | 'fixed'
interface TaskRow {
  id: string; title: string; period: string | null; done_at: Date | null; source: string
  kind: string; due: string | null; due_mode: DueMode
  assignee_id: string | null; assignee_name: string | null
  reminder_days_before: number | null; reminder_time: string
}
const COLUMNS = `t.id, t.title, t.period, t.done_at, t.source, t.kind, t.due::text as due,
  t.due_mode, t.assignee_id, u.name as assignee_name, t.reminder_days_before, left(t.reminder_time::text,5) as reminder_time`
const toTask = (r: TaskRow) => ({
  id: r.id, title: r.title, period: r.period, done: r.done_at !== null,
  custom: r.source !== 'system', due: r.due, dueMode: r.due_mode,
  assignee: r.assignee_id ? { userId: r.assignee_id, name: r.assignee_name } : null,
  reminderDaysBefore: r.reminder_days_before, reminderTime: r.reminder_time,
})
const has = (body: TaskWrite, field: keyof TaskWrite) => Object.prototype.hasOwnProperty.call(body, field)

/** Числовой период — месяцы, произвольная подпись периода не создаёт выдуманный срок. */
function monthsOf(period: string | null): number | null {
  if (!period || !/^\d+$/.test(period)) return null
  const n = Number(period)
  if (!Number.isSafeInteger(n) || n > 120) {
    throw validationFailed({ period: 'числовой период должен быть от 0 до 120 месяцев' })
  }
  return n
}

/**
 * Порядок блокировок: свадьба → пользователи → задача. Перенос и удаление
 * участников держат ту же свадьбу; удаление аккаунта держит пользователя.
 * Проверка до транзакции не защищала от назначения уже удалённому человеку.
 */
async function lockContext(client: Queryable, request: FastifyRequest, assigneeId?: string | null) {
  const weddingId = request.member!.weddingId
  const caller = request.caller!.userId
  const { rows: weddings } = await client.query<{ date: string | null }>(
    'select date::text as date from weddings where id=$1 and archived_at is null and cancelled_at is null for update', [weddingId])
  if (!weddings[0]) throw notFound('Свадьба не найдена')
  const { rows: users } = await client.query<{ id: string; deleted_at: Date | null }>(
    'select id, deleted_at from users where id=any($1::uuid[]) order by id for share', [[caller, ...(assigneeId ? [assigneeId] : [])]])
  if (!users.some(u => u.id === caller && u.deleted_at === null)) throw unauthorized('Аккаунт удалён')
  const { rows: members } = await client.query<{ user_id: string; role: string }>(
    'select user_id, role from wedding_members where wedding_id=$1 and user_id=any($2::uuid[])',
    [weddingId, [caller, ...(assigneeId ? [assigneeId] : [])]])
  const mine = members.find(m => m.user_id === caller)
  if (!mine) throw notFound('Свадьба не найдена')
  if (!['couple', 'helper', 'coordinator'].includes(mine.role)) throw forbidden('Нет доступа к задачам')
  if (assigneeId && (!users.some(u => u.id === assigneeId && u.deleted_at === null)
    || !members.some(m => m.user_id === assigneeId && ['couple', 'helper', 'coordinator'].includes(m.role)))) {
    throw validationFailed({ assigneeId: 'ответственный должен быть живым участником команды этой свадьбы' })
  }
  return weddings[0].date
}

async function load(client: Queryable, weddingId: string, taskId: string) {
  const { rows } = await client.query<TaskRow>(
    `select ${COLUMNS} from tasks t left join users u on u.id=t.assignee_id
      where t.id=$1 and t.wedding_id=$2`, [taskId, weddingId])
  if (!rows[0]) throw notFound('Задача не найдена')
  return toTask(rows[0])
}

/** Явная дата (и явное снятие даты) без режима — fixed; пропуск поля ничего не стирает. */
async function deadline(client: Queryable, patch: TaskWrite, date: string | null,
  previous: { due: string | null; due_mode: DueMode; period: string | null }) {
  const explicit = has(patch, 'due')
  const mode = patch.dueMode ?? (explicit ? 'fixed' : previous.due_mode)
  let due = explicit ? patch.due ?? null : previous.due
  if (due !== null) assertRealDate(due, 'due')
  if (explicit && due !== null && mode === 'relative' && date === null) {
    throw validationFailed({ due: 'для относительного срока сначала задайте дату свадьбы' })
  }
  if (!explicit && patch.dueMode === 'relative') {
    const months = monthsOf(previous.period)
    const { rows } = await client.query<{ due: string | null }>(
      `select case when $1::date is null or $2::int is null then null
       else ($1::date - make_interval(months => $2::int))::date::text end as due`, [date, months])
    due = rows[0]!.due
  }
  return { due, mode }
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  app.get('/weddings/:weddingId/tasks', { preValidation: app.requireAuth, schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { mine: { type: 'boolean', default: false } },
  } } }, async request => {
    const { mine = false } = request.query as { mine?: boolean }
    const { rows } = await db().query<TaskRow>(
      `select ${COLUMNS} from tasks t left join users u on u.id=t.assignee_id
        where t.wedding_id=$1 and t.kind='checklist' and (not $2::boolean or t.assignee_id=$3)
        order by t.sort,t.title`, [request.member!.weddingId, mine, request.caller!.userId])
    return rows.map(toTask)
  })
  app.post('/weddings/:weddingId/tasks', { schema: { body: ref('TaskCreate') } }, async (request, reply) => {
    const body = request.body as TaskCreate
    monthsOf(body.period)
    const title = body.title.trim()
    if (!title) throw validationFailed({ title: 'название не может быть пустым' })
    const result = await db().tx(async client => {
      const weddingId = request.member!.weddingId
      const date = await lockContext(client, request, body.assigneeId)
      const plan = await deadline(client, { ...body, dueMode: body.dueMode ?? (has(body, 'due') ? 'fixed' : 'relative') }, date,
        { due: null, due_mode: 'relative', period: body.period })
      const id = uuidv7()
      if (body.reminderDaysBefore != null && (!plan.due || !body.assigneeId)) {
        throw validationFailed({ reminderDaysBefore: 'для напоминания нужны срок и ответственный' })
      }
      await client.query(
        `insert into tasks (id,wedding_id,title,period,source,sort,due,due_mode,assignee_id,reminder_days_before,reminder_time)
         values ($1,$2,$3,$4,'user',(select coalesce(max(sort),-1)+1 from tasks where wedding_id=$2),$5::date,$6,$7,$8,$9::time)`,
        [id, weddingId, title, body.period, plan.due, plan.mode, body.assigneeId ?? null,
          body.reminderDaysBefore ?? null, body.reminderTime ?? '09:00'])
      await notifyTaskAssignment(client, id, request.caller!.userId, null)
      return load(client, weddingId, id)
    })
    return reply.code(201).send(result)
  })
  app.patch('/weddings/:weddingId/tasks/:taskId', { schema: { body: ref('TaskPatch') } }, async request => {
    const { taskId } = request.params as { taskId: string }
    if (!isUuid(taskId)) throw notFound('Задача не найдена')
    const body = request.body as TaskWrite
    if (body.title !== undefined && !body.title.trim()) throw validationFailed({ title: 'название не может быть пустым' })
    return db().tx(async client => {
      const weddingId = request.member!.weddingId
      const date = await lockContext(client, request, body.assigneeId)
      const { rows } = await client.query<TaskRow>(
        'select id,kind,due::text as due,due_mode,period,assignee_id,reminder_days_before from tasks where id=$1 and wedding_id=$2 for update', [taskId, weddingId])
      const previous = rows[0]
      if (!previous) throw notFound('Задача не найдена')
      if (previous.kind !== 'checklist' && (has(body, 'due') || has(body, 'dueMode') || has(body, 'assigneeId') || has(body, 'reminderDaysBefore') || has(body, 'reminderTime'))) {
        throw validationFailed({ taskId: 'назначение и сроки доступны только задачам чек-листа' })
      }
      const plan = await deadline(client, body, date, previous)
      const assignee = has(body, 'assigneeId') ? body.assigneeId : previous.assignee_id
      if (body.reminderDaysBefore != null && (!plan.due || !assignee)) {
        throw validationFailed({ reminderDaysBefore: 'для напоминания нужны срок и ответственный' })
      }
      await client.query(
        `update tasks set title=coalesce($3,title),
           done_at=case when $4::boolean is null then done_at when $4 then coalesce(done_at,now()) else null end,
           due=$5::date, due_mode=$6, assignee_id=case when $7::boolean then $8::uuid else assignee_id end,
           reminder_days_before=case when $9::boolean then $10::smallint else reminder_days_before end,
           reminder_time=coalesce($11::time,reminder_time)
         where id=$1 and wedding_id=$2`,
        [taskId, weddingId, body.title?.trim() ?? null, body.done ?? null, plan.due, plan.mode, has(body, 'assigneeId'), body.assigneeId ?? null,
          has(body, 'reminderDaysBefore'), body.reminderDaysBefore ?? null, body.reminderTime ?? null])
      await notifyTaskAssignment(client, taskId, request.caller!.userId, previous.assignee_id)
      return load(client, weddingId, taskId)
    })
  })
  app.delete('/weddings/:weddingId/tasks/:taskId', async (request, reply) => {
    const { taskId } = request.params as { taskId: string }
    if (!isUuid(taskId)) throw notFound('Задача не найдена')
    await db().tx(async client => {
      const weddingId = request.member!.weddingId
      await lockContext(client, request)
      const { rows } = await client.query<{ source: string }>(
        'select source from tasks where id=$1 and wedding_id=$2 for update', [taskId, weddingId])
      if (!rows[0]) throw notFound('Задача не найдена')
      if (rows[0].source === 'system') throw conflict('system_task', 'Задачу из шаблона удалить нельзя — её можно только отметить')
      await client.query('delete from tasks where id=$1 and wedding_id=$2', [taskId, weddingId])
    })
    return reply.code(204).send()
  })
}
