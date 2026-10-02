import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'

export const ATTENTION_MODES = ['essential', 'coordinator', 'detailed'] as const
export type AttentionMode = typeof ATTENTION_MODES[number]

export interface AttentionState {
  version: string
  mode: AttentionMode
  coordinatorUserId: string | null
  effectiveMode: AttentionMode
  coordinatorState: 'not_selected' | 'active' | 'unavailable'
  coordinator: { id: string; name: string } | null
}

interface AttentionRow {
  attention_version: string
  attention_mode: AttentionMode
  attention_coordinator_user_id: string | null
  coordinator_id: string | null
  coordinator_name: string | null
}

function project(row: AttentionRow): AttentionState {
  const active = row.coordinator_id !== null
  return {
    version: row.attention_version,
    mode: row.attention_mode,
    coordinatorUserId: row.attention_coordinator_user_id,
    effectiveMode: row.attention_mode === 'coordinator' && !active ? 'essential' : row.attention_mode,
    coordinatorState: row.attention_coordinator_user_id === null ? 'not_selected' : active ? 'active' : 'unavailable',
    coordinator: active ? { id: row.coordinator_id!, name: row.coordinator_name ?? '' } : null,
  }
}

/** Caller authorizes its own read; this projection never exposes an unavailable person's name. */
export async function loadAttention(db: Queryable, weddingId: string): Promise<AttentionState> {
  const { rows } = await db.query<AttentionRow>(
    `select w.attention_version::text, w.attention_mode, w.attention_coordinator_user_id,
       u.id as coordinator_id, u.name as coordinator_name
     from weddings w
     left join wedding_members m on m.wedding_id=w.id
       and m.user_id=w.attention_coordinator_user_id and m.role='coordinator'
     left join users u on u.id=m.user_id and u.deleted_at is null
     where w.id=$1 and w.archived_at is null and w.cancelled_at is null`,
    [weddingId],
  )
  if (!rows[0]) throw notFound('Свадьба не найдена')
  return project(rows[0])
}

export interface UpdateAttentionInput {
  weddingId: string
  actorUserId: string
  expectedVersion: string
  mode?: AttentionMode
  coordinatorUserId?: string | null
}

/** Must run inside the caller's transaction; rights are checked independently after the wedding lock. */
export async function updateAttention(client: Queryable, input: UpdateAttentionInput): Promise<AttentionState> {
  const { rows } = await client.query<{
    attention_version: string; attention_mode: AttentionMode; attention_coordinator_user_id: string | null
  }>(`select attention_version::text, attention_mode, attention_coordinator_user_id from weddings
      where id=$1 and archived_at is null and cancelled_at is null for update`, [input.weddingId])
  const before = rows[0]
  if (!before) throw notFound('Свадьба не найдена')

  // The route's earlier authorization may have become stale while waiting for the lock.
  const actor = await client.query<{ role: string }>(
    `select m.role from wedding_members m join users u on u.id=m.user_id
       where m.wedding_id=$1 and m.user_id=$2 and u.deleted_at is null for share of m,u`,
    [input.weddingId, input.actorUserId],
  )
  if (!actor.rows[0]) throw notFound('Свадьба не найдена')
  if (actor.rows[0].role !== 'couple') throw forbidden('Настройки внимания меняет только пара')
  if (!/^[1-9]\d*$/.test(input.expectedVersion)) throw validationFailed({ expectedVersion: 'Нужна действующая версия настроек' })
  if (before.attention_version !== input.expectedVersion) throw conflict('attention_version_conflict', 'Настройки изменились — обновите их перед сохранением')
  if (input.mode !== undefined && !ATTENTION_MODES.includes(input.mode)) throw validationFailed({ mode: 'Неизвестный режим' })

  const mode = input.mode ?? before.attention_mode
  const coordinatorId = input.coordinatorUserId === undefined ? before.attention_coordinator_user_id : input.coordinatorUserId
  // Only an explicitly chosen coordinator is validated. Keeping an unavailable choice permits a quiet-mode change.
  if (input.coordinatorUserId !== undefined && coordinatorId !== null) {
    const eligible = await client.query(
      `select m.user_id from wedding_members m join users u on u.id=m.user_id
         where m.wedding_id=$1 and m.user_id=$2 and m.role='coordinator' and u.deleted_at is null for share of m,u`,
      [input.weddingId, coordinatorId],
    )
    if (!eligible.rows[0]) throw validationFailed({ coordinatorUserId: 'Выберите действующего координатора этой свадьбы' })
  }
  if (mode === before.attention_mode && coordinatorId === before.attention_coordinator_user_id) return loadAttention(client, input.weddingId)
  await client.query(`update weddings set attention_mode=$2,attention_coordinator_user_id=$3,
      attention_version=attention_version+1 where id=$1`, [input.weddingId, mode, coordinatorId])
  const result = await loadAttention(client, input.weddingId)
  await client.query(`insert into audit_log(actor_id,action,entity,entity_id,diff)
      values($1,'wedding.attention_changed','wedding',$2,$3::jsonb)`,
    [input.actorUserId, input.weddingId, JSON.stringify({
      before: { version: before.attention_version, mode: before.attention_mode, coordinatorUserId: before.attention_coordinator_user_id },
      after: { version: result.version, mode: result.mode, coordinatorUserId: result.coordinatorUserId },
    })])
  return result
}
