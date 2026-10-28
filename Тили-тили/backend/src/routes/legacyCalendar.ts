import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, notFound } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { ref } from '../contract/schemas.generated.js'
import { readKeyHeader } from '../deals/idempotency.js'
import { assertSeatingToken } from '../wedding/access.js'
import { lockOrderContext, type OrderActor } from '../orders/context.js'
import { prepareLegacyCalendarScope } from '../resources/legacy-calendar-scope.js'
import { calendarNativeRefusal } from '../resources/calendar-errors.js'
import { assertLegacyCalendarSourceAccess, loadLegacyCalendarSources, loadLegacyCalendarEditor, loadOwnLegacyCalendarSources,
  captureLegacyCalendarBoundsInventory, proposeLegacyCalendarBounds, readLegacyCalendarBounds,
  acceptLegacyCalendarBounds, activateLegacyCalendarBounds, loadPublicLegacyCalendarOccupancy,
  type CalendarBoundsProposalBody, type CalendarBoundsAcceptBody, type CalendarBoundsActivateBody,
  type CalendarBoundsPrivateView } from '../resources/legacy-calendar.js'

interface OwnerParams { vendorId: string; sourceId: string }
interface HolderParams { weddingId: string; dealId: string; sourceId: string }
interface ReplayGuard { fingerprint: string; inventoryVersion: string | null; proposedVersion: string | null;
  head: string; effectiveEvent: string | null; role: string; userId: string; sessionId: string; policyVersion: string;
  receiptPrincipals: { id: string; valid: boolean }[] }
interface SavedReply { payload: CalendarBoundsPrivateView; guard: ReplayGuard }

/** Every mutation owns one transaction, including its replay receipt. Current
 * authority and semantic source inputs precede cached private responses. */
export async function legacyCalendarRoutes(app: FastifyInstance): Promise<void> {
  const db = () => { if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна'); return app.db }
  const actor = (request: FastifyRequest): OrderActor => ({ ...request.caller!, policyVersion: app.appConfig.policyVersion })
  const proof = () => ({ secret: app.appConfig.jwtAccessSecret ?? '' })
  const ownerRoot = '/vendors/:vendorId/legacy-calendar/sources'
  const holderRoot = '/weddings/:weddingId/deals/:dealId/legacy-calendar'
  const parameters = (names: string[]) => ({ type: 'object', additionalProperties: false, required: names,
    properties: Object.fromEntries(names.map(name => [name, UUID_ID])) })
  const options = (owner: boolean, source: boolean, body?: object) => ({ preHandler: app.requireConsent,
    schema: { params: parameters([...(owner ? ['vendorId'] : ['weddingId', 'dealId']), ...(source ? ['sourceId'] : [])]),
      ...(body ? { body } : {}) } })
  const ownerInput = (request: FastifyRequest) => ({ ...request.params as OwnerParams, actor: actor(request) })
  const holderInput = (request: FastifyRequest) => ({ ...request.params as HolderParams, actor: actor(request) })
  async function run<T>(action: () => Promise<T>): Promise<T> {
    try { return await action() } catch (error) { return calendarNativeRefusal(error) }
  }
  function read<T>(request: FastifyRequest, action: (client: Queryable) => Promise<T>): Promise<T> {
    return run(() => db().tx(async client => {
      const result = await action(client)
      await assertSeatingToken(request)
      return result
    }))
  }
  app.addHook('preHandler', async (request, reply) => {
    const route = request.routeOptions.url ?? ''
    if (route.includes('/legacy-calendar') || route === '/catalog/vendors/:vendorId/occupancy') reply.header('Cache-Control', 'no-store')
  })
  app.get(ownerRoot, options(true, false), request => read(request,
    client => loadLegacyCalendarSources(client, ownerInput(request))))
  app.get(ownerRoot + '/:sourceId', options(true, true), request => read(request,
    client => loadLegacyCalendarEditor(client, ownerInput(request))))
  app.get(holderRoot, options(false, false), request => read(request,
    client => loadOwnLegacyCalendarSources(client, holderInput(request))))
  app.get(holderRoot + '/:sourceId', { ...options(false, true), schema: { ...options(false, true).schema,
    querystring: { type: 'object', additionalProperties: false, properties: { boundsVersionId: UUID_ID } } } }, request => read(request,
    client => readLegacyCalendarBounds(client, { ...holderInput(request),
      ...request.query as { boundsVersionId?: string } }, proof())))

  async function guard(client: Queryable, sourceId: string, role: string, currentActor: OrderActor,
    receiptIds?: string[]): Promise<ReplayGuard> {
    const row = (await client.query<Omit<ReplayGuard, 'role' | 'userId' | 'sessionId' | 'policyVersion' | 'receiptPrincipals'>>(`select
      legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_source_material(s.id)) fingerprint,
      i.current_version_id::text "inventoryVersion",h.proposed_version_id::text "proposedVersion",
      coalesce(h.revision,0)::text head,h.effective_event_id::text "effectiveEvent"
      from legacy_calendar_sources s join legacy_calendar_heads i on i.source_id=s.id
      left join legacy_calendar_bounds_heads h on h.source_id=s.id
      where s.id=$1 and legacy_calendar_present(s)`, [sourceId])).rows[0]
    if (!row) throw conflict('legacy_calendar_bounds_changed', 'Источник календаря изменился — обновите данные')
    // Pin the authority represented by the saved private reply. A later
    // counterparty receipt need not invalidate an unchanged response-loss
    // retry, but revocation of a party already represented in it must do so.
    const receiptPrincipals = (await client.query<{ id: string; valid: boolean }>(`select r.id::text,
      coalesce(r.policy_version=$2 and legacy_calendar_bounds_principal_current(r.source_id,h.wedding_id,h.deal_id,
        r.party,r.user_id,r.session_id,$2),false) valid
      from legacy_calendar_bounds_receipts r join legacy_calendar_bounds_holders h on h.id=r.holder_id
      where r.bounds_version_id=$1 and ($3::uuid[] is null or r.id=any($3::uuid[])) order by r.id`,
    [row.proposedVersion, currentActor.policyVersion, receiptIds ?? null])).rows
    return { ...row, role, ...currentActor, receiptPrincipals }
  }
  async function mutate(request: FastifyRequest, owner: boolean, accept: boolean,
    action: (client: Queryable) => Promise<CalendarBoundsPrivateView>): Promise<CalendarBoundsPrivateView> {
    const currentActor = actor(request), route = request.routeOptions.url!
    const key = `${currentActor.userId}:${route}:${readKeyHeader(request, true)!}`
    const hash = createHash('sha256').update(`${request.url}\n${JSON.stringify(request.body ?? null)}`).digest('hex')
    const params = request.params as OwnerParams & HolderParams
    return run(() => db().tx(async client => {
      await assertLegacyCalendarSourceAccess(client, owner ? ownerInput(request) : holderInput(request))
      const scope = await prepareLegacyCalendarScope(client, { sourceIds: [params.sourceId],
        vendorIds: owner ? [params.vendorId] : [], weddingIds: owner ? [] : [params.weddingId], actor: currentActor })
      let role: string
      if (owner) {
        await loadLegacyCalendarEditor(client, ownerInput(request)); role = 'owner'
      } else {
        const context = await lockOrderContext(client, params.weddingId, params.dealId, currentActor, false)
        const own = await loadOwnLegacyCalendarSources(client, {
          weddingId: params.weddingId, dealId: params.dealId, actor: currentActor })
        if (!own.sources.some(s => s.sourceId === params.sourceId.toLowerCase())) throw notFound('Источник календаря не найден')
        role = context.actorRole
      }
      const claimed = await client.query(`insert into idempotency_keys(key,user_id,route,request_hash)
        values($1,$2,$3,$4) on conflict(key) do nothing returning key`, [key, currentActor.userId, route, hash])
      if (!claimed.rowCount) {
        const saved = (await client.query<{ request_hash: string; status: number | null; body: SavedReply }>(
          'select request_hash,status,body from idempotency_keys where key=$1 for update', [key])).rows[0]
        if (!saved || saved.status === null) throw conflict('idempotency_in_progress', 'Запрос ещё выполняется')
        if (saved.request_hash !== hash) throw conflict('idempotency_key_reused', 'Ключ уже использован для другого запроса')
        const before = saved.body?.guard, current = await guard(client, params.sourceId, role, currentActor,
          before?.receiptPrincipals?.map(p => p.id))
        if (!before || !saved.body?.payload || before.role !== current.role || before.fingerprint !== current.fingerprint ||
          before.userId !== current.userId || before.sessionId !== current.sessionId || before.policyVersion !== current.policyVersion ||
          before.inventoryVersion !== current.inventoryVersion || before.proposedVersion !== current.proposedVersion ||
          JSON.stringify(before.receiptPrincipals) !== JSON.stringify(current.receiptPrincipals) ||
          (!accept && (before.head !== current.head || before.effectiveEvent !== current.effectiveEvent))) {
          throw conflict('legacy_calendar_bounds_changed', 'Условия сохранённого ответа изменились — обновите данные')
        }
        await scope.assertCurrent(); await assertSeatingToken(request)
        return saved.body.payload
      }
      const payload = await action(client)
      const saved: SavedReply = { payload, guard: await guard(client, params.sourceId, role, currentActor) }
      await client.query('update idempotency_keys set status=200,body=$2::jsonb where key=$1', [key, JSON.stringify(saved)])
      await scope.assertCurrent(); await assertSeatingToken(request)
      return payload
    }))
  }
  app.post(ownerRoot + '/:sourceId/capture', options(true, true, ref('LegacyCalendarCaptureWrite')), request =>
    mutate(request, true, false, client => captureLegacyCalendarBoundsInventory(client, { ...ownerInput(request),
      ...request.body as { expectedSourceRevision: string; expectedInventoryRevision: string } })))
  app.post(ownerRoot + '/:sourceId/proposals', options(true, true, ref('LegacyCalendarBoundsProposalWrite')), request =>
    mutate(request, true, false, client => proposeLegacyCalendarBounds(client, { ...ownerInput(request),
      ...request.body as CalendarBoundsProposalBody })))
  app.post(holderRoot + '/:sourceId/accept', options(false, true, ref('LegacyCalendarBoundsAcceptWrite')), request =>
    mutate(request, false, true, client => acceptLegacyCalendarBounds(client, { ...holderInput(request),
      ...request.body as CalendarBoundsAcceptBody }, proof())))
  app.post(ownerRoot + '/:sourceId/activate', options(true, true, ref('LegacyCalendarBoundsActivateWrite')), request =>
    mutate(request, true, false, client => activateLegacyCalendarBounds(client, { ...ownerInput(request),
      ...request.body as CalendarBoundsActivateBody })))
  app.post(holderRoot + '/:sourceId/activate', options(false, true, ref('LegacyCalendarBoundsActivateWrite')), request =>
    mutate(request, false, false, client => activateLegacyCalendarBounds(client, { ...holderInput(request),
      ...request.body as CalendarBoundsActivateBody })))
  app.get('/catalog/vendors/:vendorId/occupancy', { preHandler: app.requireConsent,
    schema: { params: parameters(['vendorId']), querystring: { type: 'object', additionalProperties: false,
      required: ['from', 'to'], properties: { from: { type: 'string', format: 'date-time' }, to: { type: 'string', format: 'date-time' } } } } },
  request => read(request, client => loadPublicLegacyCalendarOccupancy(client, {
    vendorId: (request.params as { vendorId: string }).vendorId, actor: actor(request),
    ...request.query as { from: string; to: string } })))
}
