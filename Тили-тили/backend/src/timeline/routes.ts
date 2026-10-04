import { runEnrolledFanout } from '../notify/enrolled.js'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import { readKeyHeader } from '../deals/idempotency.js'
import { noteVendorUpdate } from '../vendor/updates.js'
import type { Queryable } from '../plugins/db.js'
import { expectedTimelineVersion, lockTimeline, lockTimelineForRequest, sendTimelineVersion, setTimelineActor, type TimelineVersion } from './version.js'
import { readShiftPlan, type RequestedShiftScope } from './snapshot.js'
import { shiftDigest, signShiftPreview, verifyShiftPreview, SHIFT_PREVIEW_TTL_SECONDS } from './preview-token.js'

const bodySchema = {
  type: 'object', required: ['scope', 'minutes'], additionalProperties: false,
  properties: {
    scope: { oneOf: [
      { type: 'object', required: ['kind', 'date'], additionalProperties: false, properties: { kind: { const: 'day' }, date: { type: 'string', format: 'date' } } },
      { type: 'object', required: ['kind', 'eventId'], additionalProperties: false, properties: { kind: { const: 'event' }, eventId: UUID_ID } },
    ] }, minutes: { type: 'integer', minimum: -240, maximum: 240 },
  },
}
const actualTime = async (client: Queryable): Promise<Date> => (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
const nonzero = (minutes: number | undefined) => {
  if (minutes === 0) throw new AppError(422, 'empty_shift', 'Сдвиг на ноль минут ничего не меняет', { minutes: 'не может быть 0' })
}
interface ShiftReceipt { minutes: number; shiftedBlocks: number; guestsAffected: number }
interface StoredReceipt { body: ShiftReceipt; sessionId: string; snapshot: { version: string; updated_at: string | null; updated_by: string | null } }
const snapshotFromStored = (r: StoredReceipt): TimelineVersion => ({ ...r.snapshot, updated_at: r.snapshot.updated_at ? new Date(r.snapshot.updated_at) : null })

export async function timelineShiftRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const secret = () => {
    if (!app.appConfig.jwtAccessSecret) throw new AppError(503, 'auth_unavailable', 'Подписание предпросмотра недоступно')
    return app.appConfig.jwtAccessSecret
  }
  app.post('/weddings/:weddingId/timeline/shift/preview', { schema: { body: bodySchema } }, async (request, reply) => {
    const { scope, minutes } = request.body as { scope: RequestedShiftScope; minutes: number }
    nonzero(minutes)
    return db().tx(async client => {
      const snapshot = await lockTimelineForRequest(client, request, false)
      const now = await actualTime(client)
      const plan = await readShiftPlan(client, request.member!.weddingId, scope, minutes, now)
      const previewToken = plan.canConfirm ? await signShiftPreview(secret(), { weddingId: request.member!.weddingId,
        userId: request.caller!.userId, sessionId: request.caller!.sessionId, version: snapshot.version,
        scope, minutes, digest: shiftDigest(plan) }, now) : null
      sendTimelineVersion(reply, snapshot)
      const response: Omit<typeof plan, 'vendorUserIds'> & { vendorUserIds?: string[] } = { ...plan }
      delete response.vendorUserIds
      return { ...response, sourceVersion: snapshot.version, previewToken, expiresAt: new Date((Math.floor(now.getTime() / 1000) + SHIFT_PREVIEW_TTL_SECONDS) * 1000).toISOString() }
    })
  })
  app.post('/weddings/:weddingId/timeline/shift', { attachValidation: true, schema: { body: {
    type: 'object', required: ['previewToken'], additionalProperties: false, properties: {
      previewToken: { type: 'string', minLength: 1, maxLength: 8192 },
    },
  } } }, async (request, reply) => {
    const body = request.body && typeof request.body === 'object' && !Array.isArray(request.body)
      ? request.body as { previewToken?: string; minutes?: unknown } : {}
    if (request.validationError) {
      // The strict command schema rejects legacy input; preserve its explicit refusal codes.
      if ('minutes' in body) {
        if (typeof body.minutes !== 'number' || !Number.isInteger(body.minutes) || Math.abs(body.minutes) > 240) throw validationFailed({ minutes: 'нужно целое число от -240 до 240' })
        nonzero(body.minutes)
        expectedTimelineVersion(request.headers['if-match'])
      }
      throw request.validationError
    }
    const previewToken = body.previewToken!
    const expected = expectedTimelineVersion(request.headers['if-match'])
    const clientKey = readKeyHeader(request, true)!
    if (clientKey.length > 128) throw new AppError(400, 'idempotency_key_too_long', 'Idempotency-Key длиннее 128 символов')
    const key = `${request.caller!.userId}:timeline-shift-v2:${clientKey}`
    const hash = shiftDigest({ url: request.url, previewToken, version: expected })
    const result = await db().tx(async client => runEnrolledFanout(client, { owner: 'timeline.shift', weddingId: request.member!.weddingId, actorId: request.caller!.userId, request, afterReceipt: false }, async (emissions) => {
      const weddingId = request.member!.weddingId
      const snapshot = await lockTimelineForRequest(client, request, true)
      // Replay is authorized under the same current lock as a new command.
      const replay = async (): Promise<StoredReceipt | null> => {
        const row = (await client.query<{ request_hash: string; status: number | null; body: StoredReceipt }>(
          'select request_hash,status,body from idempotency_keys where key=$1 for update', [key])).rows[0]
        if (!row) return null
        if (row.request_hash !== hash) throw conflict('idempotency_key_reused', 'Этот ключ уже использован для другого предпросмотра')
        if (row.status === null) throw conflict('idempotency_in_progress', 'Подтверждение ещё выполняется')
        if (row.body.sessionId !== request.caller!.sessionId) throw validationFailed({ previewToken: 'предпросмотр относится к другой сессии' })
        reply.header('Idempotent-Replay', 'true')
        return row.body
      }
      const seen = await replay()
      if (seen) return seen
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — получите новый предпросмотр')
      const now = await actualTime(client)
      const claims = await verifyShiftPreview(secret(), previewToken, now)
      emissions.afterLastWrite(async () => { await verifyShiftPreview(secret(), previewToken, await actualTime(client)) })
      if (claims.weddingId !== weddingId || claims.userId !== request.caller!.userId || claims.sessionId !== request.caller!.sessionId || claims.version !== expected) {
        throw validationFailed({ previewToken: 'предпросмотр относится к другой сессии или версии' })
      }
      const plan = await readShiftPlan(client, weddingId, claims.scope, claims.minutes, now)
      if (!plan.canConfirm) throw conflict('shift_conflict', 'Сдвиг недоступен: требуется ручная правка программы')
      if (shiftDigest(plan) !== claims.digest) throw conflict('shift_preview_changed', 'Последствия сдвига изменились — получите новый предпросмотр')
      const claimed = await client.query(`insert into idempotency_keys(key,user_id,route,request_hash) values($1,$2,'timeline-shift-v2',$3)
        on conflict(key) do nothing returning key`, [key, request.caller!.userId, hash])
      if (claimed.rowCount === 0) {
        const raced = await replay()
        if (raced) return raced
        throw conflict('idempotency_in_progress', 'Подтверждение ещё выполняется')
      }
      await setTimelineActor(client, request.caller!.userId)
      const ids = plan.blocks.map(b => b.id)
      const moved = await client.query(`update timeline_events set starts_at=starts_at+make_interval(mins=>$3),ends_at=ends_at+make_interval(mins=>$3)
        where wedding_id=$1 and id=any($2::uuid[]) and not fixed and starts_at>clock_timestamp() returning id`, [weddingId, ids, claims.minutes])
      if (moved.rowCount !== ids.length) throw conflict('shift_preview_changed', 'Блок уже начался — получите новый предпросмотр')
      await client.query('insert into timeline_shifts(id,wedding_id,minutes,actor_id) values($1,$2,$3,$4)', [uuidv7(), weddingId, claims.minutes, request.caller!.userId])
      await client.query("insert into broadcasts(id,wedding_id,action,recipients) values($1,$2,'timeline-shift',$3)", [uuidv7(), weddingId, plan.guestsAffected])
      const text = `Тайминг сдвинут на ${claims.minutes > 0 ? '+' : ''}${claims.minutes} мин`
      await noteVendorUpdate(client, weddingId, 'timeline', text, plan.affectedVendorIds)
      const commanders = (await client.query<{ user_id: string }>("select user_id from wedding_members where wedding_id=$1 and role in ('couple','coordinator') order by user_id", [weddingId])).rows
      const recipients = new Set([...commanders.map(r => r.user_id), ...plan.affectedMemberIds, ...plan.vendorUserIds])
      recipients.delete(request.caller!.userId)
      for (const userId of [...recipients].sort()) await emissions.emit(client, { userId, kind: 'system', title: 'Тайминг сдвинут', body: text, link: '/dayx', critical: true }, now, plan.scope.timeZone)
      const accepted = await lockTimeline(client, weddingId, true)
      const receipt: StoredReceipt = { sessionId: request.caller!.sessionId, body: { minutes: claims.minutes, shiftedBlocks: ids.length, guestsAffected: plan.guestsAffected },
        snapshot: { version: accepted.version, updated_at: accepted.updated_at?.toISOString() ?? null, updated_by: accepted.updated_by } }
      await emissions.flush()
      await client.query('update idempotency_keys set status=200,body=$2 where key=$1', [key, JSON.stringify(receipt)])
      return receipt
    }))
    sendTimelineVersion(reply, snapshotFromStored(result))
    return result.body
  })
}
