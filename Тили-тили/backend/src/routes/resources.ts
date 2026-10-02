import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, notFound, validationFailed } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { ref } from '../contract/schemas.generated.js'
import { readKeyHeader } from '../deals/idempotency.js'
import type { Queryable } from '../plugins/db.js'
import { createResource, createCapacityWindow, listResources, lockResourceScope, patchCapacityWindow,
  retireResource, type ResourceScope, type CreateResourceInput, type CreateCapacityWindowInput, type PatchCapacityWindowInput } from '../resources/model.js'
import { getAvailabilityPolicy, setAvailabilityPolicy, type SetAvailabilityPolicyInput } from '../resources/policy.js'

/** Company operations are independent from wedding finance and program receipts. */
export async function resourceRoutes(app: FastifyInstance): Promise<void> {
  const db = () => { if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна'); return app.db }
  const scope = (request: FastifyRequest): ResourceScope => ({ vendorId: (request.params as { vendorId: string }).vendorId,
    actor: { ...request.caller!, policyVersion: app.appConfig.policyVersion } })
  const params = (extra: string[] = []) => ({ type: 'object', additionalProperties: false,
    required: ['vendorId', ...extra], properties: Object.fromEntries(['vendorId', ...extra].map(name => [name, UUID_ID])) })
  const options = (body?: object, extra: string[] = []) => ({ preHandler: app.requireConsent,
    schema: { params: params(extra), ...(body ? { body } : {}) } })
  const root = '/vendors/:vendorId'
  app.get(root + '/resources', options(), request => db().tx(client => listResources(client, scope(request))))
  app.get(root + '/availability-policy', options(), request => db().tx(client => getAvailabilityPolicy(client, scope(request))))
  app.get(root + '/resource-options', options(), request => db().tx(async client => {
    const input = scope(request), company = await lockResourceScope(client, input)
    // Directory for this specific management purpose, not a staff/financial ACL.
    // A later create command rechecks the chosen account and membership under locks.
    const people = await client.query<{ user_id: string; name: string | null; member_id: string | null }>(`select u.id as user_id,u.name,null::uuid as member_id
      from users u where u.id=$2 and u.deleted_at is null
      union all select u.id,u.name,m.id from vendor_staff_members m join users u on u.id=m.user_id
      where m.vendor_id=$1 and m.state='active' and m.accepted_at is not null and m.revoked_at is null
        and u.deleted_at is null and u.id<>$2 order by user_id,member_id`, [input.vendorId, company.ownerId])
    return { vendorId: input.vendorId.toLowerCase(), actorRole: input.actor.userId.toLowerCase() === company.ownerId ? 'owner' : 'resource_manager',
      persons: people.rows.map(p => ({ userId: p.user_id, name: p.name, staffMemberId: p.member_id })) }
  }))

  async function authorize(client: Queryable, request: FastifyRequest, input: ResourceScope) {
    const body = request.body as Partial<CreateResourceInput> | undefined
    const createPerson = request.routeOptions.url === root + '/resources' && request.method === 'POST' && body?.kind === 'person'
    const p = request.params as { resourceId?: string; windowId?: string }
    // Locate the immutable identity before company/resource locks, matching
    // account erasure's lock order. This is scoped data, never a client flag.
    const located = p.resourceId ? (await client.query<{ person_user_id: string | null }>(
      'select person_user_id from vendor_resources where id=$1 and vendor_id=$2', [p.resourceId, input.vendorId])).rows[0] : undefined
    const company = await lockResourceScope(client, input, createPerson ? body?.personUserId : located?.person_user_id ?? undefined, !p.resourceId)
    // Applies before cached replies too: erased/revoked targeting cannot return
    // the former private identity as though it were a current accepted employee.
    if (createPerson) {
      if (body?.staffMemberId === undefined) {
        if (body?.personUserId?.toLowerCase() !== company.ownerId) throw validationFailed({ staffMemberId: 'Нужно принятое участие человека в этой компании' })
      } else {
        const member = await client.query(`select id from vendor_staff_members where id=$1 and vendor_id=$2 and user_id=$3
          and state='active' and accepted_at is not null and revoked_at is null for share`, [body.staffMemberId, input.vendorId, body.personUserId])
        if (!member.rowCount) throw validationFailed({ staffMemberId: 'Нужно принятое участие человека в этой компании' })
      }
    }
    if (p.resourceId) {
      const current = await client.query('select id from vendor_resources where id=$1 and vendor_id=$2 for share', [p.resourceId, input.vendorId])
      if (!current.rowCount) throw notFound('Ресурс не найден')
    }
    if (p.windowId) {
      const current = await client.query('select id from resource_capacity_windows where id=$1 and resource_id=$2 for share', [p.windowId, p.resourceId])
      if (!current.rowCount) throw notFound('Окно не найдено')
    }
    return company
  }
  async function authorizeCachedIdentity(client: Queryable, request: FastifyRequest, input: ResourceScope, ownerId: string, savedBody: unknown) {
    const resourceId = (request.params as { resourceId?: string }).resourceId
    if (!resourceId) return
    const row = (await client.query<{ kind: string; person_user_id: string | null; staff_member_id: string | null }>(
      'select kind,person_user_id,staff_member_id from vendor_resources where id=$1 and vendor_id=$2', [resourceId, input.vendorId])).rows[0]
    if (!row || row.kind !== 'person') return
    // A fresh historical retirement already hid unavailable identities. Its
    // exact safe reply must remain retryable after response loss. Undefined or
    // malformed fields do not qualify for this server-created narrow reply.
    if (savedBody !== null && typeof savedBody === 'object' && !Array.isArray(savedBody) &&
      'personUserId' in savedBody && savedBody.personUserId === null &&
      'staffMemberId' in savedBody && savedBody.staffMemberId === null) return
    const unavailable = () => validationFailed({ personUserId: 'Участие человека изменилось — обновите данные' })
    if (!row.person_user_id) throw unavailable()
    // The actual account was locked before the company, including a completed
    // erasure. Do not acquire account locks in the reverse order here.
    const live = await client.query('select id from users where id=$1 and deleted_at is null', [row.person_user_id])
    if (!live.rowCount) throw unavailable()
    if (row.staff_member_id === null) {
      if (row.person_user_id !== ownerId) throw unavailable()
    } else {
      const member = await client.query(`select id from vendor_staff_members where id=$1 and vendor_id=$2 and user_id=$3
        and state='active' and accepted_at is not null and revoked_at is null for share`, [row.staff_member_id, input.vendorId, row.person_user_id])
      if (!member.rowCount) throw unavailable()
    }
  }
  async function mutate(request: FastifyRequest, action: (client: Queryable, input: ResourceScope) => Promise<unknown>) {
    const route = request.routeOptions.url!, key = `${request.caller!.userId}:${route}:${readKeyHeader(request, true)!}`
    const hash = createHash('sha256').update(`${request.url}\n${JSON.stringify(request.body ?? null)}`).digest('hex')
    return db().tx(async client => {
      const input = scope(request)
      const company = await authorize(client, request, input)
      const claim = await client.query(`insert into idempotency_keys(key,user_id,route,request_hash) values($1,$2,$3,$4)
        on conflict(key) do nothing returning key`, [key, input.actor.userId, route, hash])
      if (!claim.rowCount) {
        const saved = (await client.query<{ request_hash: string; status: number | null; body: unknown }>(
          'select request_hash,status,body from idempotency_keys where key=$1 for update', [key])).rows[0]
        if (!saved || saved.status === null) throw new AppError(409, 'idempotency_in_progress', 'Запрос ещё выполняется')
        if (saved.request_hash !== hash) throw new AppError(409, 'idempotency_key_reused', 'Ключ уже использован для другого запроса')
        await authorizeCachedIdentity(client, request, input, company.ownerId, saved.body)
        return saved.body
      }
      const result = await action(client, input)
      await client.query('update idempotency_keys set status=200,body=$2::jsonb where key=$1', [key, JSON.stringify(result)])
      return result
    })
  }
  app.post(root + '/resources', options(ref('VendorResourceCreate')), request => mutate(request,
    (client, input) => createResource(client, { ...input, ...request.body as Omit<CreateResourceInput, keyof ResourceScope> })))
  app.post(root + '/resources/:resourceId/retire', options(ref('ResourceVersionWrite'), ['resourceId']), request => mutate(request,
    (client, input) => retireResource(client, { ...input, resourceId: (request.params as { resourceId: string }).resourceId,
      ...request.body as { expectedVersion: string } })))
  app.post(root + '/resources/:resourceId/windows', options(ref('ResourceCapacityWindowCreate'), ['resourceId']), request => mutate(request,
    (client, input) => createCapacityWindow(client, { ...input, resourceId: (request.params as { resourceId: string }).resourceId,
      ...request.body as Omit<CreateCapacityWindowInput, keyof ResourceScope | 'resourceId'> })))
  app.patch(root + '/resources/:resourceId/windows/:windowId', options(ref('ResourceCapacityWindowPatch'), ['resourceId','windowId']), request => mutate(request,
    (client, input) => patchCapacityWindow(client, { ...input, ...request.params as { resourceId: string; windowId: string },
      ...request.body as Omit<PatchCapacityWindowInput, keyof ResourceScope | 'resourceId' | 'windowId'> })))
  app.patch(root + '/availability-policy', options(ref('VendorAvailabilityPolicyWrite')), request => mutate(request,
    (client, input) => setAvailabilityPolicy(client, { ...input, ...request.body as Omit<SetAvailabilityPolicyInput, keyof ResourceScope> })))
}
