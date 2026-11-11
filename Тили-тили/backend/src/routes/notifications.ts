import type { FastifyInstance } from 'fastify'
import { AppError, notFound } from '../errors.js'
import { uuidv7, isUuid } from '../ids.js'
import { pruneTaskNotifications } from '../notify/task-notifications.js'
import { PUSH_MAX_AGE_MS, pushConfiguration } from '../notify/push.js'
import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { prepareExistingNoticeScope } from '../notify/notice-transactions.js'
import { lockOrderPrincipal } from '../orders/context.js'
import { assertSeatingToken } from '../wedding/access.js'
import { consentState } from '../auth/consent.js'
import { unauthorized } from '../errors.js'

const subscriptionChanged = () => new AppError(409, 'push_subscription_scope_changed',
  'Подписка изменилась — обновите данные и повторите действие')
interface SubscriptionIdentity { id: string; user_id: string }
async function subscriptionCaller(client: Queryable, request: FastifyRequest, currentConsent: boolean,
  pin: boolean): Promise<void> {
  const caller = request.caller!
  if (pin && currentConsent) {
    await lockOrderPrincipal(client, { userId: caller.userId, sessionId: caller.sessionId,
      policyVersion: request.server.appConfig.policyVersion })
  } else {
    const user = (await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1', [caller.userId])).rows[0]
    if (!user || user.deleted_at) throw unauthorized('Аккаунт удалён')
    const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null' +
      (pin ? ' for share' : ''), [caller.sessionId, caller.userId])
    if (!session.rowCount) throw unauthorized('Сессия завершена')
    if (currentConsent) {
      const state = await consentState(client, caller.userId, request.server.appConfig.policyVersion)
      if (state === 'none') throw new AppError(403, 'forbidden', 'Нужно согласие на обработку персональных данных')
      if (state === 'outdated') throw new AppError(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить')
    }
  }
  await assertSeatingToken(request)
}

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get('/notifications', { preHandler: app.requireConsent }, async (request) => {
    await pruneTaskNotifications(db(), new Date(), request.caller!.userId)
    /* Отдаём всё, что создано, не глядя на `deliver_after`: тихие часы —
     * про звук в 23:00, а не про право знать. Открыв приложение ночью сам,
     * человек должен увидеть новость, а не пустой экран. */
    const { rows } = await db().query<{
      id: string
      kind: string
      title: string
      body: string
      link: string | null
      read_at: Date | null
      created_at: Date
      push_state: 'inbox_only' | 'queued' | 'provider_accepted' | 'unconfirmed'
      provider_accepted_at: Date | null
    }>(
      `select n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at,
              delivery.provider_accepted_at,
              case
                when delivery.provider_accepted_at is not null then 'provider_accepted'
                when n.push_disposition = 'inbox_only' then 'inbox_only'
                when n.push_disposition = 'planned' and n.pushed_at is null
                  and n.deliver_after > now() - $2::double precision * interval '1 millisecond'
                  and (n.expires_at is null or n.expires_at > now())
                  and (delivery.attempt_count = 0 or delivery.pending) then 'queued'
                else 'unconfirmed'
              end as push_state
         from (
           select id, kind, title, body, link, read_at, created_at,
                  push_disposition, pushed_at, deliver_after, expires_at
             from notifications where user_id = $1 and cancelled_at is null
            order by created_at desc, id desc limit 100
         ) n
         cross join lateral (
           select min(d.provider_accepted_at) as provider_accepted_at, count(*) as attempt_count,
                  bool_or(d.status in ('queued','claimed','retry_wait')) as pending
             from notification_push_deliveries d where d.notification_id = n.id
         ) delivery
        order by n.created_at desc, n.id desc`,
      [request.caller!.userId, PUSH_MAX_AGE_MS],
    )
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      kind: r.kind,
      link: r.link,
      read: r.read_at !== null,
      createdAt: r.created_at.toISOString(),
      push: {
        state: r.push_state,
        providerAcceptedAt: r.provider_accepted_at?.toISOString() ?? null,
        confirmedDeliveryAt: null,
      },
    }))
  })

  app.post('/notifications/:id/read', { preHandler: app.requireConsent }, async (request, reply) => {
    const { id } = request.params as { id: string }
    if (!isUuid(id)) throw notFound('Уведомление не найдено')
    // Повторная отметка не двигает время: «когда прочитал» — это первый раз.
    const res = await db().query(
      'update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 and cancelled_at is null',
      [id, request.caller!.userId],
    )
    if (res.rowCount === 0) throw notFound('Уведомление не найдено')
    return reply.code(204).send()
  })

  /* «Прочитать все» одним запросом (план миграции §2.3): поштучный обход —
   * сотня запросов на тап, и обрыв посередине оставлял половину непрочитанной.
   * Повтор пустой: уже прочитанные не трогаются, время прочтения не двигается. */
  app.post('/notifications/read-all', { preHandler: app.requireConsent }, async (request) => {
    const res = await db().query('update notifications set read_at = now() where user_id = $1 and read_at is null and cancelled_at is null', [
      request.caller!.userId,
    ])
    return { marked: res.rowCount ?? 0 }
  })

  /* ── подписки Web Push ────────────────────────────────────────────── */

  app.get('/notifications/channels', { preHandler: app.requireConsent }, async () => {
    const channel = pushConfiguration(app.appConfig)
    const webPush = channel.state === 'configured'
      ? { state: channel.state, applicationServerKey: channel.vapid.publicKey }
      : channel
    return { inApp: true, webPush }
  })

  app.post(
    '/users/me/push-subscriptions',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['endpoint', 'keys'],
          additionalProperties: false,
          properties: {
            endpoint: { type: 'string', minLength: 1, maxLength: 2000, pattern: '^https://[^ ]+$' },
            applicationServerKey: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' },
            keys: {
              type: 'object',
              required: ['p256dh', 'auth'],
              additionalProperties: false,
              properties: {
                p256dh: { type: 'string', minLength: 1, maxLength: 200 },
                auth: { type: 'string', minLength: 1, maxLength: 200 },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      /* Без ключей VAPID отправить push физически нечем. Принять подписку
       * и промолчать значило бы сделать заглушку, которая притворяется
       * работающей: клиент показал бы «уведомления включены», а их бы
       * не было. Ключи и библиотека доставки — за владельцем. */
      const channel = pushConfiguration(app.appConfig)
      if (channel.state !== 'configured') {
        throw new AppError(
          501,
          'push_not_configured',
          channel.reason === 'invalid_configuration' ? 'Настройки Web Push требуют исправления. Уведомления доступны в приложении.'
            : 'Web Push ещё не настроен: нет ключей VAPID. Уведомления приходят в приложении.',
        )
      }

      const body = request.body as { endpoint: string; keys: Record<string, string>; applicationServerKey?: string }
      if (body.applicationServerKey !== undefined && body.applicationServerKey !== channel.vapid.publicKey) {
        throw new AppError(409, 'push_configuration_changed', 'Настройки Web Push изменились — обновите состояние и повторите действие')
      }
      // Один и тот же браузер переподписывается тем же endpoint — это
      // не второй телефон, а тот же самый.
      await db().tx(async client => {
        const initial = (await client.query<SubscriptionIdentity>(
          'select id,user_id from push_subscriptions where endpoint=$1', [body.endpoint])).rows[0] ?? null
        try {
          const scope = await prepareExistingNoticeScope(client, { noticeIds: [],
            subscriptionIds: initial ? [initial.id] : [], subscriptionMutation: true,
            allNoticeUserIds: [request.caller!.userId, ...(initial ? [initial.user_id] : [])],
            beforeNotices: pinned => subscriptionCaller(pinned, request, true, true) })
          const current = (await client.query<SubscriptionIdentity>(
            'select id,user_id from push_subscriptions where endpoint=$1', [body.endpoint])).rows[0] ?? null
          if (JSON.stringify(current) !== JSON.stringify(initial)) throw subscriptionChanged()
          await scope.assertParents()
          const changed = await client.query(
            `insert into push_subscriptions (id, user_id, endpoint, keys) values ($1,$2,$3,$4)
             on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys
             where push_subscriptions.id=$5::uuid and push_subscriptions.user_id=$6::uuid`,
            [uuidv7(), request.caller!.userId, body.endpoint, JSON.stringify(body.keys), initial?.id ?? null, initial?.user_id ?? null])
          if (changed.rowCount !== 1) throw subscriptionChanged()
          // The conditional unique-conflict wait can happen after preparation.
          // Do not acquire a discovered owner: reject its unprepared identity.
          await subscriptionCaller(client, request, true, false)
        } catch (error) {
          if (error instanceof AppError && error.code === 'resource_source_changed') throw subscriptionChanged()
          throw error
        }
      })
      return reply.code(201).send()
    },
  )

  app.delete(
    '/users/me/push-subscriptions',
    {
      // выход доступен и при согласии под прежней редакцией (F4)
      preHandler: app.requireAuth,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { endpoint: { type: 'string', minLength: 1, maxLength: 2048 } },
        },
      },
    },
    async (request, reply) => {
      /* Отписка работает всегда, даже когда подписка невозможна: «выключить»
       * не должно упираться в то, что «включить» пока нельзя.
       *
       * С `endpoint` снимается одна подписка — этого устройства: тумблер
       * «Push на этом устройстве» иначе выключал push и на ноутбуке, а тумблер
       * там продолжал гореть (D4-10, R-180). Адрес подписки знает только само
       * устройство, поэтому чужую по нему не снять; условие по `user_id`
       * остаётся — общий телефон мог перепривязать endpoint другому. Без
       * параметра — все подписки человека, как при выходе отовсюду. */
      const { endpoint } = request.query as { endpoint?: string }
      await db().tx(async client => {
        try {
          const scope = await prepareExistingNoticeScope(client, { noticeIds: [],
            subscriptionUserIds: [request.caller!.userId], subscriptionMutation: true,
            allNoticeUserIds: [request.caller!.userId],
            beforeNotices: pinned => subscriptionCaller(pinned, request, false, true) })
          await scope.assertParents()
          await client.query(
            'delete from push_subscriptions where user_id = $1 and ($2::text is null or endpoint = $2)',
            [request.caller!.userId, endpoint ?? null])
          // Outdated consent is still allowed; only current identity is required.
          await subscriptionCaller(client, request, false, false)
        } catch (error) {
          if (error instanceof AppError && error.code === 'resource_source_changed') throw subscriptionChanged()
          throw error
        }
      })
      return reply.code(204).send()
    },
  )
}
