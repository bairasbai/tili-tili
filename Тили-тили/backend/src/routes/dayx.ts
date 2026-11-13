import type { FastifyInstance } from 'fastify'
import { AppError, conflict } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { finishEnrolledFanoutAfterReceipt, runEnrolledFanout } from '../notify/enrolled.js'
import { NOTICE_PUSH_DELIVERY_JOIN_SQL, NOTICE_PUSH_STATE_SQL } from '../notify/delivery-status.js'
import { pushConfiguration, PUSH_MAX_AGE_MS } from '../notify/push.js'
import type { components } from '../contract/api.generated.js'
import { timelineShiftRoutes } from '../timeline/routes.js'
import { allowedRoles, assertSeatingToken, lockGuestReadAccess, lockPlanBReadAccess, lockSeatingAccess } from '../wedding/access.js'
import type { Queryable } from '../plugins/db.js'
import { assertPlanBImpact, assertPlanBRecipientsCurrent, assertPlanBRevision, assertPlanBUrgency, issuePlanBPreview, readPlanBImpact, selectPlanBRecipients,
  verifyPlanBPreview } from '../planb/preview.js'
import { planBSaveSchema, readPlanBScenario, savePlanBScenario, scenarioSchema, type PlanBSave, type PlanBScenario } from '../planb/scenarios.js'
import { dayXCoordinationRoutes } from './dayxCoordination.js'

const ACTIVATE_PLAN_B = '/weddings/:weddingId/planb/activate'
const PLAN_B_DETAILS = '/weddings/:weddingId/planb/scenarios/:scenario'
const scenarioParams = { type: 'object', required: ['scenario'], properties: { scenario: scenarioSchema } }

type PushChannel = components['schemas']['PlanBPushChannel']

async function planBDelivery(client: Queryable, weddingId: string, pushChannel: PushChannel) {
  const { rows } = await client.query<{
    activationId: string; guestsAffected: number; inApp: number; queued: number; providerAccepted: number
    inboxOnly: number; unconfirmed: number; read: number
  }>(`select b.id as "activationId", b.recipients as "guestsAffected", totals.*
        from broadcasts b
       cross join lateral (
         select count(*)::int as "inApp", count(*) filter (where push_state='queued')::int as queued,
                count(*) filter (where push_state='provider_accepted')::int as "providerAccepted",
                count(*) filter (where push_state='inbox_only')::int as "inboxOnly",
                count(*) filter (where push_state='unconfirmed')::int as unconfirmed,
                count(*) filter (where read_at is not null)::int as read
           from (
             select n.read_at, ${NOTICE_PUSH_STATE_SQL} as push_state
               from notifications n
               ${NOTICE_PUSH_DELIVERY_JOIN_SQL}
              where n.broadcast_id=b.id and n.cancelled_at is null
           ) notices
       ) totals
       where b.wedding_id=$1 and b.planb_current`, [weddingId, PUSH_MAX_AGE_MS])
  return rows[0] ? { ...rows[0], pushChannel, confirmedDelivered: null } : null
}

/*
 * Ответ сдвига и плана Б (`DayXBroadcast`) говорит, кого это КАСАЕТСЯ —
 * `guestsAffected`, ответившие «да»: команда сообщает им сама. Поля «скольким
 * гостям ушло» (`notifiedGuests`) больше нет: канала до гостей нет (ни SMS,
 * ни почты — «Хвосты»), и оно всегда было нулём — числом, которое ничего не
 * сообщает (D4-18, R-174). Контракт снял его в v0.30.0; появится канал —
 * появится и настоящий счётчик, а не ноль под старым именем.
 */

/**
 * Чек-лист накануне — тот же список, что на экране «План Б» во фронте
 * (app/src/pages/Smart.tsx). Придумывать свой значило бы дать паре два
 * разных списка на одном экране после первой же синхронизации.
 */
// Semantic identity is authored here; edits to a task title do not change its key.
const PLANB_CHECKLIST = [
  { systemKey: 'planb.vendor_arrival', title: 'Обзвонить всех подрядчиков за 1–2 дня: время и адрес прибытия' },
  { systemKey: 'planb.rings_passports', title: 'Кольца и паспорта — у свидетелей' },
  { systemKey: 'planb.venue_materials', title: 'Алкоголь и реквизит отвезти на площадку накануне вечером' },
  { systemKey: 'planb.weather_venue_backup', title: 'Проверить прогноз погоды и план Б площадки' },
  { systemKey: 'planb.timeline_buffer', title: 'Запас 15 минут в каждом блоке тайминга' },
  { systemKey: 'planb.emergency_kit', title: 'Powerbank, аптечка, швейный набор, присыпка от пятен' },
] as const

export async function dayxRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const previewSecret = () => {
    if (!app.appConfig.jwtAccessSecret) throw new AppError(503, 'auth_unavailable', 'Подписание предпросмотра недоступно')
    return app.appConfig.jwtAccessSecret
  }
  const pushChannel = (): PushChannel => {
    const channel = pushConfiguration(app.appConfig)
    return channel.state === 'configured' ? channel.state : channel.reason
  }

  await timelineShiftRoutes(app)
  await dayXCoordinationRoutes(app)

  /* ── план Б ───────────────────────────────────────────────────────── */
  /**
   * Чек-лист накануне: сценарий, отметки и прогресс.
   *
   * Пункты заводятся при первом обращении, а не при создании свадьбы:
   * иначе у всех, кто завёл свадьбу раньше, экран остался бы пустым,
   * а миграция с приписыванием строк в чужие данные — не то, что стоит
   * делать ради шести галочек.
   *
   * Отмечаются пункты обычным `PATCH /tasks/{id}`: это задачи, и второй
   * путь для того же действия разошёлся бы с первым при первой же правке.
   */
  app.get('/weddings/:weddingId/planb', async (request) => {
    const weddingId = request.member!.weddingId
    return db().tx(async (client) => {
      const role = await lockPlanBReadAccess(client, request)
      const { rows: w } = await client.query<{ planb_scenario: string | null; planb_at: Date | null; cancelled_at: Date | null }>(
        'select planb_scenario, planb_at, cancelled_at from weddings where id = $1',
        [weddingId],
      )

      const { rows: have } = await client.query<{ n: string }>(
        "select count(*)::text as n from tasks where wedding_id = $1 and kind = 'planb'",
        [weddingId],
      )
      if (Number(have[0]!.n) === 0) {
        for (const [i, item] of PLANB_CHECKLIST.entries()) {
          // The wedding lock serializes first opens; one transaction keeps the
          // system set complete without restricting user-created task titles.
          await client.query(
            `insert into tasks (id, wedding_id, title, source, sort, kind, system_template_key) values ($1,$2,$3,'system',$4,'planb',$5)`,
            [uuidv7(), weddingId, item.title, i, item.systemKey],
          )
        }
      }

      const { rows } = await client.query<{ id: string; title: string; done_at: Date | null }>(
        `select id, title, done_at from tasks
          where wedding_id = $1 and kind = 'planb' order by sort, title`,
        [weddingId],
      )
      const hasCommandRole = allowedRoles(ACTIVATE_PLAN_B, 'POST').includes(role)
      const delivery = hasCommandRole ? { delivery: await planBDelivery(client, weddingId, pushChannel()) } : {}
      await assertSeatingToken(request)
      return {
        scenario: w[0]?.planb_scenario ?? null,
        activatedAt: w[0]?.planb_at?.toISOString() ?? null,
        canActivate: hasCommandRole && w[0]?.cancelled_at === null,
        checklist: rows.map((r) => ({ id: r.id, title: r.title, done: r.done_at !== null })),
        ...delivery,
      }
    })
  })

  app.get<{ Params: { scenario: PlanBScenario } }>(PLAN_B_DETAILS, { schema: { params: scenarioParams } },
    async request => db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const plan = await readPlanBScenario(client, request.member!.weddingId, request.params.scenario)
      await assertSeatingToken(request)
      return { plan }
    }))

  app.put<{ Params: { scenario: PlanBScenario }; Body: PlanBSave }>(PLAN_B_DETAILS,
    { schema: { params: scenarioParams, body: planBSaveSchema } }, async request => db().tx(async client => {
      await lockSeatingAccess(client, request)
      const plan = await savePlanBScenario(client, request.member!.weddingId, request.params.scenario, request.body)
      await assertSeatingToken(request)
      return { plan }
    }))

  app.post('/weddings/:weddingId/planb/preview', {
    schema: { body: { type: 'object', required: ['scenario'], additionalProperties: false, properties: { scenario: scenarioSchema } } },
  }, async request => db().tx(async client => {
    await lockSeatingAccess(client, request)
    const { scenario } = request.body as { scenario: PlanBScenario }
    const weddingId = request.member!.weddingId
    const { userId, sessionId } = request.caller!
    const origin = { weddingId, userId, sessionId, scenario }
    const impact = await readPlanBImpact(client, origin)
    const preview = await issuePlanBPreview(client, origin, impact, previewSecret())
    await assertSeatingToken(request)
    return { ...preview, pushChannel: pushChannel() }
  }))

  app.post<{ Body: { activationId: string; visible: boolean } }>('/weddings/:weddingId/planb/guest-address', {
    schema: { body: {
      type: 'object', required: ['activationId', 'visible'], additionalProperties: false,
      properties: { activationId: { type: 'string', format: 'uuid' }, visible: { type: 'boolean' } },
    } },
  }, async request => db().tx(async client => {
    await lockSeatingAccess(client, request)
    const { activationId, visible } = request.body
    const ids = [request.member!.weddingId, activationId]
    const result = visible
      ? await client.query(`update broadcasts b set planb_guest_address=p.reserve_address
          from planb_scenarios p where b.wedding_id=$1 and b.id=$2 and b.planb_current
            and p.wedding_id=b.wedding_id and b.action='planb:' || p.scenario
            and b.planb_revision=p.revision and p.reserve_address is not null`, ids)
      : await client.query('update broadcasts set planb_guest_address=null where wedding_id=$1 and id=$2 and planb_current', ids)
    if (!result.rowCount) throw conflict('planb_guest_address_changed', 'Действующий сценарий изменился или адрес не задан. Откройте предпросмотр снова')
    await assertSeatingToken(request)
    return { published: visible }
  }))

  app.post(
    ACTIVATE_PLAN_B,
    {
      schema: {
        body: {
          type: 'object',
          required: ['scenario'],
          additionalProperties: false,
          properties: {
            scenario: scenarioSchema,
            previewToken: { type: 'string', minLength: 1, maxLength: 8192 },
            inAppRecipientIds: { type: 'array', uniqueItems: true, items: { type: 'string', format: 'uuid' } },
            urgentEventId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const { scenario, previewToken, inAppRecipientIds, urgentEventId } = request.body as {
        scenario: PlanBScenario; previewToken?: string; inAppRecipientIds?: string[]; urgentEventId?: string
      }
      const { userId: actorId, sessionId } = request.caller!
      const origin = { weddingId, userId: actorId, sessionId, scenario }
      const action = `planb:${scenario}`
      return withIdempotency(db(), request, reply, 'planb-activate', tx => tx(client => runEnrolledFanout(client, {
        owner: 'planb.activate', weddingId, actorId, request, afterReceipt: true,
      }, async emissions => {
        await lockSeatingAccess(client, request)
        const preview = await verifyPlanBPreview(client, origin, previewToken, previewSecret())
        const impact = await readPlanBImpact(client, origin)
        assertPlanBRevision(impact, preview.planRevision)
        // The wedding is pinned before taking the current broadcast lock. The
        // retention sweep only deletes broadcasts and unlinks their own notices.
        const current = (await client.query<{ id: string; action: string; recipients: number; planb_revision: string | null }>(
          'select id,action,recipients,planb_revision from broadcasts where wedding_id=$1 and planb_current for update', [weddingId],
        )).rows[0]
        if (current?.action === action && current.planb_revision === impact.planRevision) {
          return { status: 200, body: { scenario, activationId: current.id, guestsAffected: current.recipients,
            ...(inAppRecipientIds === undefined ? {} : { alreadyActive: true }) } }
        }
        assertPlanBImpact(impact, preview.digest)
        const urgent = urgentEventId ? await assertPlanBUrgency(client, impact, urgentEventId, preview.urgentEventId) : null
        const recipients = selectPlanBRecipients(impact, inAppRecipientIds)
        emissions.afterLastWrite(async () => {
          await assertPlanBRecipientsCurrent(client, origin, impact, preview.expiresAt)
          if (urgent) await assertPlanBUrgency(client, impact, urgent.id, preview.urgentEventId)
        })
        const guestsAffected = impact.guests.length
        const activationId = uuidv7()
        if (current) await client.query('update broadcasts set planb_current=false where id=$1', [current.id])
        await client.query('update weddings set planb_scenario=$2,planb_at=clock_timestamp() where id=$1', [weddingId, scenario])
        await client.query(
          `insert into broadcasts(id,wedding_id,action,recipients,planb_current,planb_revision,planb_urgent_event_id,planb_urgent_event_version)
           values($1,$2,$3,$4,true,$5,$6,$7)`,
          [activationId, weddingId, action, guestsAffected, impact.planRevision, urgent?.id ?? null, urgent?.version ?? null],
        )
        const now = new Date()
        for (const recipient of recipients) {
          await emissions.emit(client, {
            userId: recipient.userId,
            broadcastId: activationId,
            kind: 'system',
            title: 'Активирован план Б',
            body: 'Сценарий включён — проверьте точку сбора и тайминг',
            link: '/dayx',
          }, now, impact.timeZone)
        }
        return { status: 200, body: { scenario, activationId, guestsAffected } }
      }), { afterReceipt: finishEnrolledFanoutAfterReceipt }), true, async client => {
        await lockSeatingAccess(client, request)
      })
    },
  )
}
