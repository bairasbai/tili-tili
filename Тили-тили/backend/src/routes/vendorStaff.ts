import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { components } from '../contract/api.generated.js'
import { ref } from '../contract/schemas.generated.js'
import { AppError, notFound, validationFailed } from '../errors.js'
import { UUID_ID } from '../ids.js'
import type { OrderActor } from '../orders/context.js'
import type { Queryable } from '../plugins/db.js'
import { acceptStaffInvite, createStaffDuty, declineStaffInvite, inviteStaff, listOwnStaffDuties,
  listOrderStaffDuties, listStaff, revokeStaff, revokeStaffDuty, updateStaffRole } from '../vendor/staff.js'
import { assertSeatingToken } from '../wedding/access.js'

type Schemas = components['schemas']
type CompanyParams = { vendorId: string }
type MemberParams = CompanyParams & { memberId: string }
type DealParams = { dealId: string }
type DutyParams = DealParams & { dutyId: string }

const ids = (...names: string[]) => ({
  type: 'object', additionalProperties: false, required: names,
  properties: Object.fromEntries(names.map(name => [name, UUID_ID])),
})

export async function vendorStaffRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store')
  })

  function run<T>(request: FastifyRequest, action: (client: Queryable, actor: OrderActor) => Promise<T>): Promise<T> {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
    return app.db.tx(async client => {
      const result = await action(client, actor)
      await assertSeatingToken(request)
      return result
    })
  }

  async function orderScope(client: Queryable, request: FastifyRequest, actor: OrderActor) {
    const { dealId } = request.params as DealParams
    const row = (await client.query<{ wedding_id: string; vendor_id: string }>(
      `select d.wedding_id,d.vendor_id from deals d join vendors v on v.id=d.vendor_id
       where d.id=$1 and v.user_id=$2 and v.blocked_at is null`, [dealId, actor.userId])).rows[0]
    if (!row) throw notFound('Действующий заказ компании не найден')
    return { actor, dealId, vendorId: row.vendor_id, weddingId: row.wedding_id }
  }

  async function strictVersion(request: FastifyRequest): Promise<void> {
    const body = request.body as { expectedVersion?: unknown } | null | undefined
    if (typeof body?.expectedVersion !== 'string') throw validationFailed({ expectedVersion: 'Нужна точная версия строкой' })
  }

  const company = ids('vendorId')
  const member = ids('vendorId', 'memberId')
  const deal = ids('dealId')
  const duty = ids('dealId', 'dutyId')
  const auth = { preHandler: app.requireConsent }

  app.get('/vendor/companies/:vendorId/staff', { ...auth,
    schema: { params: company, response: { 200: { type: 'array', items: ref('VendorStaffMember') } } },
  }, request => run(request, (client, actor) => listStaff(client, { actor, ...(request.params as CompanyParams) })))

  app.post('/vendor/companies/:vendorId/staff', { ...auth,
    schema: { params: company, body: ref('VendorStaffInviteInput'), response: { 201: ref('VendorStaffInvitation') } },
  }, async (request, reply) => {
    const result = await run(request, (client, actor) => inviteStaff(client, {
      actor, ...(request.params as CompanyParams), ...(request.body as Schemas['VendorStaffInviteInput']),
    }))
    return reply.code(201).send(result)
  })

  app.put('/vendor/companies/:vendorId/staff/:memberId/role', { ...auth, preValidation: strictVersion,
    schema: { params: member, body: ref('VendorStaffRoleInput'), response: { 200: ref('VendorStaffMember') } },
  }, request => run(request, (client, actor) => updateStaffRole(client, {
    actor, ...(request.params as MemberParams), ...(request.body as Schemas['VendorStaffRoleInput']),
  })))

  app.post('/vendor/companies/:vendorId/staff/:memberId/revoke', { ...auth, preValidation: strictVersion,
    schema: { params: member, body: ref('VendorStaffVersionInput'), response: { 200: ref('VendorStaffMember') } },
  }, request => run(request, (client, actor) => revokeStaff(client, {
    actor, ...(request.params as MemberParams), ...(request.body as Schemas['VendorStaffVersionInput']),
  })))

  const invitation = { ...auth, schema: {
    body: ref('VendorStaffTokenInput'), response: { 200: ref('VendorStaffMember') },
  } }
  app.post('/users/me/vendor-staff/invitations/accept', invitation, request => run(request,
    (client, actor) => acceptStaffInvite(client, { actor, ...(request.body as Schemas['VendorStaffTokenInput']) })))
  app.post('/users/me/vendor-staff/invitations/decline', invitation, request => run(request,
    (client, actor) => declineStaffInvite(client, { actor, ...(request.body as Schemas['VendorStaffTokenInput']) })))

  app.get('/vendor/deals/:dealId/staff-duties', { ...auth,
    schema: { params: deal, response: { 200: { type: 'array', items: ref('VendorStaffDuty') } } },
  }, request => run(request, async (client, actor) => listOrderStaffDuties(client, await orderScope(client, request, actor))))

  app.post('/vendor/deals/:dealId/staff-duties', { ...auth,
    schema: { params: deal, body: ref('VendorStaffDutyInput'), response: { 201: ref('VendorStaffDuty') } },
  }, async (request, reply) => {
    const result = await run(request, async (client, actor) => createStaffDuty(client, {
      ...(await orderScope(client, request, actor)), ...(request.body as Schemas['VendorStaffDutyInput']),
    }))
    return reply.code(201).send(result)
  })

  app.post('/vendor/deals/:dealId/staff-duties/:dutyId/revoke', { ...auth, preValidation: strictVersion,
    schema: { params: duty, body: ref('VendorStaffVersionInput'), response: { 200: ref('VendorStaffDuty') } },
  }, request => run(request, async (client, actor) => revokeStaffDuty(client, {
    ...(await orderScope(client, request, actor)), dutyId: (request.params as DutyParams).dutyId,
    ...(request.body as Schemas['VendorStaffVersionInput']),
  })))

  app.get('/users/me/vendor-staff/duties', { ...auth,
    schema: {
      querystring: { type: 'object', additionalProperties: false, properties: { after: UUID_ID } },
      response: { 200: ref('VendorStaffDutiesPage') },
    },
  }, request => run(request, (client, actor) => listOwnStaffDuties(client, actor, (request.query as { after?: string }).after)))
}
