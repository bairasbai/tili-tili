import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, forbidden, notFound } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { ref } from '../contract/schemas.generated.js'
import { readKeyHeader } from '../deals/idempotency.js'
import type { Queryable } from '../plugins/db.js'
import { lockOrderContext, lockOrderPrincipal, lockOrderWedding, type OrderActor } from '../orders/context.js'
import { loadOrder, readOrder, patchOrderBrief, createOrderPart, patchOrderPart, cancelOrderPart,
  type CreateOrderPartInput, type PatchOrderPartInput, type OrderInput } from '../orders/model.js'
import { createOrderAssignment, cancelOrderAssignment, type CreateOrderAssignmentInput } from '../orders/assignments.js'
import { EXECUTION_KINDS, getCategoryBrief } from '../orders/catalog.js'
import { publishOrderTerms, loadOrderTerms, acceptOrderTerms } from '../orders/terms.js'
import { assertTermsProofAvailable } from '../orders/terms-token.js'
import { loadOrderResourcePlan, saveOrderResourcePlan, type ResourcePlanLineInput } from '../orders/resource-plan.js'
import { prepareCatalogResourceOrder, type ResourceOrderPreparationInput, type ResourceOrderPreparationResult } from '../orders/resource-order.js'
import { commitAgreedOrderResources, replaceAgreedOrderResources, loadOrderResourceCommitments,
  type CommitResourceInput } from '../resources/commitments.js'
import { lockLegacyBookingCompanies } from '../resources/booking-boundary.js'
import { lockExternalContact, patchExternalContact, validateExternalContact } from '../orders/external-contact.js'
import { assertSeatingToken } from '../wedding/access.js'

/** Private draft editing never changes accepted prices, payments or date holds. */
export async function orderRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const actor = (request: FastifyRequest): OrderActor => ({ ...request.caller!, policyVersion: app.appConfig.policyVersion })
  const termsProof = () => ({ secret: app.appConfig.jwtAccessSecret ?? '' })
  app.addHook('preHandler', async (request, reply) => {
    if (request.routeOptions.url?.startsWith('/deals/:dealId/order')) reply.header('Cache-Control', 'no-store')
  })
  const params = { type: 'object', required: ['dealId'], properties: { dealId: UUID_ID } }
  async function input(client: Queryable, request: FastifyRequest): Promise<OrderInput> {
    const { dealId } = request.params as { dealId: string }
    const row = await client.query<{ wedding_id: string }>('select wedding_id from deals where id=$1', [dealId])
    if (!row.rows[0]) throw notFound('Заказ не найден')
    return { weddingId: row.rows[0].wedding_id, dealId, actor: actor(request) }
  }
  app.get('/deals/:dealId/order', { preHandler: app.requireConsent, schema: { params } }, async (request, reply) => {
    const result = await db().tx(async client => loadOrder(client, await input(client, request)))
    reply.header('ETag', `"${result.version}"`)
    return result
  })
  app.get('/deals/:dealId/order/catalog', { preHandler: app.requireConsent, schema: { params } }, request => db().tx(async client => {
    const scope = await input(client, request)
    const context = await lockOrderContext(client, scope.weddingId, scope.dealId, scope.actor, false)
    const category = getCategoryBrief(context.categoryId)
    if (!category) throw new AppError(422, 'unknown_category', 'Категория заказа не поддерживается')
    const wedding = (await client.query<{ tz: string | null }>('select tz from weddings where id=$1', [scope.weddingId])).rows[0]!
    const zones = await client.query<{ assignment_id: string; program_event_id: string; time_zone: string | null }>(
      `select a.id as assignment_id,a.program_event_id,e.time_zone from order_assignments a
       join wedding_events e on e.id=a.program_event_id and e.wedding_id=a.wedding_id
       where a.wedding_id=$1 and a.deal_id=$2 order by a.id for share of e`, [scope.weddingId, scope.dealId])
    const positions = context.actorRole === 'couple' ? await client.query<{ id: string; program_event_id: string | null; label: string }>(
      `select s.id,s.program_event_id,s.label from slots s where s.wedding_id=$1 and s.category_id=$2
       and ((s.id=$3 and s.deal_id=$4) or (s.deal_id is null and s.program_event_id is not null))
       and not exists(select 1 from order_assignments a where a.wedding_id=s.wedding_id and a.slot_id=s.id
         and a.cancelled_at is null and a.deal_id<>$4) order by s.created_at,s.id for share of s`,
      [scope.weddingId, context.categoryId, context.slotId, scope.dealId]) : { rows: [] }
    return { weddingId: scope.weddingId, primarySlotId: context.slotId, actorRole: context.actorRole, timeZone: wedding.tz,
      dealState: context.state, vendorId: context.vendorId,
      draftEditable: context.state !== 'cancelled',
      assignmentTimeZones: zones.rows.map(row => ({ assignmentId: row.assignment_id, programEventId: row.program_event_id, timeZone: row.time_zone })),
      eligiblePositions: positions.rows.map(row => ({ slotId: row.id, programEventId: row.program_event_id, isPrimary: row.id === context.slotId, label: row.label })),
      category, executionKinds: EXECUTION_KINDS }
  }))
  async function mutate(request: FastifyRequest, action: (client: Queryable, scope: OrderInput) => Promise<unknown>,
    beforeReplay?: (client: Queryable, scope: OrderInput) => Promise<void>,
    replayResult?: (client: Queryable, scope: OrderInput) => Promise<unknown>,
    finalize?: () => Promise<void>) {
    const clientKey = readKeyHeader(request, true)!
    const route = request.routeOptions.url!
    const key = `${request.caller!.userId}:${route}:${clientKey}`
    const hash = createHash('sha256').update(`${request.url}\n${JSON.stringify(request.body ?? null)}`).digest('hex')
    return db().tx(async client => {
      const scope = await input(client, request)
      // Also precedes replay: a saved response must not bypass revoked membership/session/consent.
      await lockOrderContext(client, scope.weddingId, scope.dealId, scope.actor)
      if (beforeReplay) await beforeReplay(client, scope)
      const claimed = await client.query(`insert into idempotency_keys(key,user_id,route,request_hash)
        values($1,$2,$3,$4) on conflict(key) do nothing returning key`, [key, scope.actor.userId, route, hash])
      if (!claimed.rows[0]) {
        const existing = (await client.query<{ request_hash: string; status: number | null; body: unknown }>(
          'select request_hash,status,body from idempotency_keys where key=$1 for update', [key])).rows[0]
        if (!existing || existing.status === null) throw new AppError(409, 'idempotency_in_progress', 'Запрос ещё выполняется')
        if (existing.request_hash !== hash) throw new AppError(409, 'idempotency_key_reused', 'Ключ уже использован для другого запроса')
        const result = replayResult ? await replayResult(client, scope) : existing.body
        if (finalize) await finalize()
        return result
      }
      const result = await action(client, scope)
      await client.query('update idempotency_keys set status=200,body=$2::jsonb where key=$1', [key, JSON.stringify(result)])
      if (finalize) await finalize()
      return result
    })
  }
  const options = (body: object, extraParams: Record<string, object> = {}) => ({ preHandler: app.requireConsent,
    schema: { params: { ...params, required: ['dealId', ...Object.keys(extraParams)], properties: { ...params.properties, ...extraParams } }, body } })
  app.get('/vendors/:vendorId/booking-policy', { preHandler: app.requireConsent,
    schema: { params: { type: 'object', required: ['vendorId'], properties: { vendorId: UUID_ID } } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { vendorId } = request.params as { vendorId: string }
    return db().tx(async client => {
      await lockOrderPrincipal(client, actor(request))
      await lockLegacyBookingCompanies(client, [vendorId])
      const company = await client.query(`select v.id from vendors v join users u on u.id=v.user_id
        where v.id=$1 and v.published_at is not null and v.blocked_at is null and u.deleted_at is null`, [vendorId])
      if (!company.rowCount) throw notFound('Подрядчик недоступен')
      const policy = (await client.query<{ mode: 'legacy_day' | 'resources'; revision: string }>(
        'select mode,revision::text from vendor_availability_policy where vendor_id=$1 for share', [vendorId])).rows[0]
      return { mode: policy?.mode ?? 'legacy_day', revision: policy?.revision ?? '0' }
    })
  })
  app.post('/weddings/:weddingId/slots/:slotId/resource-order', { preHandler: app.requireConsent,
    schema: { params: { type: 'object', required: ['weddingId', 'slotId'], properties: { weddingId: UUID_ID, slotId: UUID_ID } },
      body: ref('ResourceOrderPreparationWrite') } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const clientKey = readKeyHeader(request, true)!, route = request.routeOptions.url!
    const currentActor = actor(request), key = `${currentActor.userId}:${route}:${clientKey}`
    const hash = createHash('sha256').update(`${request.url}\n${JSON.stringify(request.body ?? null)}`).digest('hex')
    const scope = request.params as { weddingId: string; slotId: string }
    const body = request.body as Omit<ResourceOrderPreparationInput, 'weddingId' | 'slotId' | 'actor'>
    return db().tx(async client => {
      await lockOrderWedding(client, scope.weddingId)
      await lockOrderPrincipal(client, currentActor)
      const member = (await client.query<{ role: string }>(
        'select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [scope.weddingId, currentActor.userId])).rows[0]
      if (!member) throw notFound('Свадьба не найдена')
      if (member.role !== 'couple') throw forbidden('Исполнителя и финансовый заказ выбирает участник пары')
      const slot = await client.query('select id from slots where wedding_id=$1 and id=$2 for update', [scope.weddingId, scope.slotId])
      if (!slot.rowCount) throw notFound('Позиция услуги не найдена')
      const claimed = await client.query(`insert into idempotency_keys(key,user_id,route,request_hash)
        values($1,$2,$3,$4) on conflict(key) do nothing returning key`, [key, currentActor.userId, route, hash])
      if (!claimed.rowCount) {
        const cached = (await client.query<{ request_hash: string; status: number | null; body: ResourceOrderPreparationResult }>(
          'select request_hash,status,body from idempotency_keys where key=$1 for update', [key])).rows[0]
        if (!cached || cached.status === null) throw conflict('idempotency_in_progress', 'Запрос ещё выполняется')
        if (cached.request_hash !== hash) throw conflict('idempotency_key_reused', 'Ключ уже использован для другого запроса')
        const fresh = await prepareCatalogResourceOrder(client, { ...scope, ...body, actor: currentActor,
          expectedSelectedDealId: cached.body.dealId })
        return { ...fresh, created: cached.body.created }
      }
      const result = await prepareCatalogResourceOrder(client, { ...scope, ...body, actor: currentActor })
      await client.query('update idempotency_keys set status=200,body=$2::jsonb where key=$1', [key, JSON.stringify(result)])
      return result
    })
  })
  const coupleBeforeReplay = async (client: Queryable, scope: OrderInput) => {
    const member = (await client.query<{ role: string }>(
      'select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [scope.weddingId, scope.actor.userId])).rows[0]
    if (member?.role !== 'couple') throw forbidden('Бронь ресурсов подтверждает участник пары')
  }
  app.get('/deals/:dealId/order/resource-commitments', { preHandler: app.requireConsent, schema: { params } }, request =>
    db().tx(async client => loadOrderResourceCommitments(client, await input(client, request))))
  for (const [suffix, action] of [['', commitAgreedOrderResources], ['/replace', replaceAgreedOrderResources]] as const) {
    app.post(`/deals/:dealId/order/resource-commitments${suffix}`, options(ref('OrderResourceCommitmentWrite')), request =>
      mutate(request, (client, scope) => action(client, { ...scope,
        ...request.body as Omit<CommitResourceInput, keyof OrderInput> }), coupleBeforeReplay,
      (client, scope) => loadOrderResourceCommitments(client, scope)))
  }
  app.get('/deals/:dealId/order/resource-plan', { preHandler: app.requireConsent, schema: { params } }, request =>
    db().tx(async client => loadOrderResourcePlan(client, await input(client, request))))
  app.patch('/deals/:dealId/order/resource-plan', options(ref('OrderResourcePlanWrite')), request =>
    mutate(request, (client, scope) => saveOrderResourcePlan(client, { ...scope,
      ...request.body as { expectedVersion: string; expectedPlanRevision: string; lines: ResourcePlanLineInput[] } }), async (client, scope) => {
      // Pair access alone cannot replay a former company owner's editor payload.
      const owner = await client.query(`select v.id from vendors v join deals d on d.vendor_id=v.id
        where d.wedding_id=$1 and d.id=$2 and v.user_id=$3 and v.blocked_at is null for share of v`,
      [scope.weddingId, scope.dealId, scope.actor.userId])
      if (!owner.rowCount) throw forbidden('План ресурсов изменяет действующий владелец компании')
    }))
  app.patch('/deals/:dealId/order/external-contact', {
    ...options(ref('OrderExternalContactWrite')),
    preValidation: async request => { validateExternalContact(request.body) },
  }, async request => {
    const ownedDb = db()
    await mutate(request, (client, scope) => patchExternalContact(client, { ...scope,
      ...request.body as { expectedVersion: string; name: string; phone: string | null } }),
    async (client, scope) => { await lockExternalContact(client, scope) },
    (client, scope) => readOrder(client, scope), () => assertSeatingToken(request))
    // A committed command does not authorize its response after a concurrent revoke.
    return ownedDb.tx(async client => {
      const scope = await input(client, request)
      await lockExternalContact(client, scope, false)
      const current = await readOrder(client, scope)
      await assertSeatingToken(request)
      return current
    })
  })
  app.patch('/deals/:dealId/order/brief', options(ref('OrderBriefWrite')), request =>
    mutate(request, (client, scope) => patchOrderBrief(client, { ...scope, ...request.body as { expectedVersion: string; brief: { subtypeId?: string; values: Record<string, unknown> } | null } })))
  app.post('/deals/:dealId/order/parts', options(ref('OrderPartCreate')), request =>
    mutate(request, (client, scope) => createOrderPart(client, { ...scope, ...request.body as Omit<CreateOrderPartInput, keyof OrderInput> })))
  app.patch('/deals/:dealId/order/parts/:partId', options(ref('OrderPartPatch'), { partId: UUID_ID }), request => mutate(request, (client, scope) => patchOrderPart(client,
      { ...scope, partId: (request.params as { partId: string }).partId, ...request.body as Omit<PatchOrderPartInput, keyof OrderInput | 'partId'> })))
  app.post('/deals/:dealId/order/parts/:partId/cancel', options(ref('OrderPartCancel'), { partId: UUID_ID }), request =>
    mutate(request, (client, scope) => cancelOrderPart(client, { ...scope, partId: (request.params as { partId: string }).partId,
      ...request.body as { expectedVersion: string; expectedPartVersion: string } })))
  app.post('/deals/:dealId/order/assignments', options(ref('OrderAssignmentCreate')), request =>
    mutate(request, (client, scope) => createOrderAssignment(client, { ...scope, ...request.body as Omit<CreateOrderAssignmentInput, keyof OrderInput> })))
  app.post('/deals/:dealId/order/assignments/:assignmentId/cancel', options(ref('OrderAssignmentCancel'), { assignmentId: UUID_ID }), request =>
    mutate(request, (client, scope) => cancelOrderAssignment(client, { ...scope, assignmentId: (request.params as { assignmentId: string }).assignmentId,
      ...request.body as { expectedVersion: string; expectedAssignmentVersion: string } })))
  app.get('/deals/:dealId/order/terms', { preHandler: app.requireConsent, schema: { params,
    querystring: { type: 'object', additionalProperties: false, properties: { termsId: UUID_ID } } } }, request => db().tx(async client => {
    const scope = await input(client, request), query = request.query as { termsId?: string }
    return loadOrderTerms(client, { ...scope, ...query }, termsProof())
  }))
  app.post('/deals/:dealId/order/terms/proposals', options(ref('OrderTermsPublish')), request =>
    mutate(request, (client, scope) => {
      assertTermsProofAvailable(termsProof())
      return publishOrderTerms(client, { ...scope, ...request.body as { expectedOrderVersion: string; expectedTermsRevision: string } })
    }))
  app.post('/deals/:dealId/order/terms/:termsId/accept', options(ref('OrderTermsAccept'), { termsId: UUID_ID }), request =>
    mutate(request, (client, scope) => acceptOrderTerms(client, { ...scope, termsId: (request.params as { termsId: string }).termsId,
      ...request.body as { expectedTermsVersion: string; digest: string; readToken: string } }, termsProof())))
}
