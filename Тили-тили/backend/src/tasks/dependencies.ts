import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, validationFailed } from '../errors.js'
import type { components } from '../contract/api.generated.js'

type Patch = components['schemas']['TaskPatch']
export const DEPENDENCY_COLUMNS = `t.dependency_version::text as dependency_version,
  coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'done',p.done_at is not null) order by p.title,p.id)
    from task_dependencies d join tasks p on p.id=d.prerequisite_id where d.task_id=t.id),'[]'::jsonb) as dependencies,
  (select jsonb_build_object('reason',a.diff->>'reason','at',a.at) from audit_log a
    where a.entity='task' and a.entity_id=t.id and a.action='task.dependencies.overridden'
      and (a.diff->>'completedAt')::timestamptz=t.done_at order by a.id desc limit 1) as dependency_override`

export async function replaceDependencies(client: Queryable, request: FastifyRequest, taskId: string,
  next: string[], version?: string): Promise<void> {
  const wid = request.member!.weddingId
  const role = await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2', [wid, request.caller!.userId])
  if (role.rows[0]?.role !== 'couple') throw forbidden('Зависимости задач настраивает пара')
  const task = await client.query<{ version: string }>('select dependency_version::text as version from tasks where id=$1 and wedding_id=$2', [taskId, wid])
  if (version !== undefined && version !== task.rows[0]?.version) throw conflict('task_dependencies_changed', 'Зависимости изменились. Обновите задачи перед сохранением')
  const ids = next.map(id => id.toLowerCase())
  if (ids.includes(taskId.toLowerCase()) || new Set(ids).size !== ids.length) throw validationFailed({ dependsOn: 'Задача не может зависеть от себя; повторы не допускаются' })
  const found = await client.query('select id from tasks where wedding_id=$1 and kind=\'checklist\' and id=any($2::uuid[])', [wid, ids])
  if (found.rowCount !== ids.length) throw validationFailed({ dependsOn: 'Выберите задачи чек-листа этой свадьбы' })
  const old = await client.query<{ prerequisite_id: string }>('select prerequisite_id from task_dependencies where task_id=$1 order by prerequisite_id', [taskId])
  const retained = new Set(old.rows.map(row => row.prerequisite_id))
  await client.query('delete from task_dependencies where task_id=$1 and not(prerequisite_id=any($2::uuid[]))', [taskId, ids])
  for (const id of ids.filter(id => !retained.has(id)).sort()) {
    await client.query('insert into task_dependencies(wedding_id,task_id,prerequisite_id) values($1,$2,$3)', [wid, taskId, id])
  }
}

/** The transaction already holds the wedding root. Only this task/update can use the decision. */
export async function prepareDependencyCompletion(client: Queryable, request: FastifyRequest, taskId: string,
  previous: { done_at: Date | null; dependency_version: string }, body: Patch): Promise<void> {
  if (body.dependencyOverride === undefined) return
  if (body.done !== true || body.dependsOn !== undefined) throw validationFailed({ dependencyOverride: 'Обход выполняется отдельно при завершении задачи' })
  const role = await client.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2', [request.member!.weddingId, request.caller!.userId])
  if (role.rows[0]?.role !== 'couple') throw forbidden('Завершить задачу вопреки зависимостям может только пара')
  // Repeating an already committed completion is a no-op, never a second audit decision.
  if (previous.done_at !== null) return
  if (body.dependencyVersion !== previous.dependency_version) throw conflict('task_dependencies_changed', 'Зависимости изменились. Обновите задачи перед сохранением')
  const reason = body.dependencyOverride.reason.trim()
  if (!reason) throw validationFailed({ dependencyOverride: 'Укажите причину ручного решения' })
  const pending = await client.query<{ id: string }>(`select p.id from task_dependencies d join tasks p on p.id=d.prerequisite_id
    where d.task_id=$1 and p.done_at is null order by p.id`, [taskId])
  const expected = body.dependencyOverride.prerequisiteIds.map(id => id.toLowerCase()).sort()
  if (!pending.rows.length || JSON.stringify(expected) !== JSON.stringify(pending.rows.map(row => row.id))) {
    throw conflict('task_dependencies_changed', 'Состав незавершённых предпосылок изменился. Обновите задачи')
  }
  await client.query(`select set_config('tili.task_override_target',$1,true),set_config('tili.task_override_actor',$2,true),
    set_config('tili.task_override_reason',$3,true),set_config('tili.task_override_blockers',$4,true)`,
  [taskId, request.caller!.userId, reason, '{' + expected.join(',') + '}'])
}

export function dependencyError(error: unknown): never {
  const constraint = error && typeof error === 'object' && 'constraint' in error ? error.constraint : null
  switch (constraint) {
    case 'task_dependencies_pending': throw conflict('task_dependencies_pending', 'Сначала завершите предпосылки или укажите ручное решение пары')
    case 'task_dependency_cycle': throw conflict('task_dependency_cycle', 'Эта связь создаёт круговую зависимость задач')
    case 'task_dependency_completed': throw conflict('task_dependency_completed', 'Сначала снимите отметку выполнения, затем добавьте зависимости')
    case 'task_dependency_in_use': throw conflict('task_dependency_in_use', 'Другие задачи зависят от этой. Сначала удалите эти связи')
    case 'task_dependency_limit': throw validationFailed({ dependsOn: 'У задачи может быть не больше 64 предпосылок' })
    case 'task_dependency_override_invalid': throw conflict('task_dependencies_changed', 'Ручное решение больше не соответствует текущим зависимостям')
    default: throw error
  }
}
