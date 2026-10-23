import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, validationFailed } from '../errors.js'
import { UUID_ID } from '../ids.js'
import { withIdempotency } from '../deals/idempotency.js'
import { assertSeatingToken } from '../wedding/access.js'
import { expectedTimelineVersion, lockTimeline, sendTimelineVersion } from '../timeline/version.js'
import { knownTimeZone } from '../notify/quiet.js'
import { assertWeddingDate } from '../wedding/dates.js'
import { finishEnrolledFanoutAfterReceipt, runEnrolledFanout } from '../notify/enrolled.js'
import { acceptEventMove, applyEventMove, assertMoveRead, cancelEventMove, listMoveProposals, locateRootMove,
  lockMoveCustomer, lockRootMove, listRootMoves, moveProposalDto, proposeEventMove, readRootMove,
  type MoveInput, type MoveTarget } from '../orders/event-moves.js'

export async function eventMoveRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const actor = (request: FastifyRequest) => ({ ...request.caller!, policyVersion: app.appConfig.policyVersion })
  const input = (request: FastifyRequest): MoveInput => {
    const { weddingId, eventId } = request.params as { weddingId: string; eventId: string }
    return { weddingId, eventId, actor: actor(request) }
  }
  const params = { type: 'object', required: ['weddingId', 'eventId'], additionalProperties: false,
    properties: { weddingId: UUID_ID, eventId: UUID_ID } }
  const proposalParams = { ...params, required: [...params.required, 'proposalId'], properties: { ...params.properties, proposalId: UUID_ID } }
  const rootParams = { type: 'object', required: ['dealId', 'proposalId'], additionalProperties: false, properties: { dealId: UUID_ID, proposalId: UUID_ID } }
  const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' }
  const digestBody = { type: 'object', required: ['digest'], additionalProperties: false, properties: { digest } }
  const prefix = '/weddings/:weddingId/events/:eventId/move-proposals'
  const rootPrefix = '/deals/:dealId/event-moves/:proposalId'
  // Apply after the shared onSend security headers so private responses stay private.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.routeOptions.url?.includes('/move-proposals') || request.routeOptions.url?.startsWith('/deals/:dealId/event-moves')) {
      reply.header('Cache-Control', 'private, no-store')
    }
    return payload
  })
  app.get('/deals/:dealId/event-moves', { preHandler: app.requireConsent, schema: { params: {
    type: 'object', required: ['dealId'], additionalProperties: false, properties: { dealId: UUID_ID },
  } } }, async request => db().tx(async client => {
    const result = await listRootMoves(client, (request.params as { dealId: string }).dealId, actor(request))
    await assertSeatingToken(request)
    return result
  }))
  app.get(prefix, { schema: { params } }, async request => db().tx(async client => {
    const scope = input(request)
    await lockMoveCustomer(client, scope)
    const result = await listMoveProposals(client, scope)
    await assertSeatingToken(request)
    return result
  }))
  app.get(prefix + '/:proposalId', { schema: { params: proposalParams } }, async request => db().tx(async client => {
    const scope = input(request)
    await lockMoveCustomer(client, scope)
    const result = await moveProposalDto(client, scope, (request.params as { proposalId: string }).proposalId)
    await assertSeatingToken(request)
    return result
  }))
  app.post(prefix, { schema: { params, body: {
    type: 'object', required: ['date', 'timeZone', 'location'], additionalProperties: false,
    properties: { date: { type: 'string', format: 'date' }, timeZone: { type: 'string', minLength: 1, maxLength: 100 },
      location: { type: 'string', nullable: true, maxLength: 300 } },
  } } }, async (request, reply) => {
    const scope = input(request), body = request.body as MoveTarget
    assertWeddingDate(body.date)
    if (knownTimeZone(body.timeZone) !== body.timeZone) throw validationFailed({ timeZone: 'неизвестный часовой пояс' })
    const expected = expectedTimelineVersion(request.headers['if-match'])
    return withIdempotency(db(), request, reply, 'event-move.propose', tx => tx(async client => {
      await lockMoveCustomer(client, scope)
      const snapshot = await lockTimeline(client, scope.weddingId, true)
      if (snapshot.version !== expected) throw conflict('timeline_conflict', 'Программа уже изменена — обновите её')
      if (!(await client.query('select 1 from pg_timezone_names where name=$1', [body.timeZone])).rowCount) throw validationFailed({ timeZone: 'часовой пояс не поддерживается базой' })
      const result = await proposeEventMove(client, scope, body)
      await assertSeatingToken(request)
      sendTimelineVersion(reply, snapshot)
      return { status: 201, body: result }
    }, { afterReceipt: () => assertSeatingToken(request) }), true, async client => {
      await lockMoveCustomer(client, scope)
      await assertSeatingToken(request)
    })
  })
  app.get(rootPrefix, { preHandler: app.requireConsent, schema: { params: rootParams } }, async request => db().tx(async client => {
    const { dealId, proposalId } = request.params as { dealId: string; proposalId: string }
    const scope = await locateRootMove(client, dealId, proposalId, actor(request))
    await lockRootMove(client, scope)
    const result = await readRootMove(client, scope, app.appConfig.jwtAccessSecret ?? '')
    await assertSeatingToken(request)
    return result
  }))
  app.post(rootPrefix + '/accept', { preHandler: app.requireConsent, schema: { params: rootParams, body: {
    type: 'object', required: ['digest', 'readToken'], additionalProperties: false,
    properties: { digest, readToken: { type: 'string', minLength: 1, maxLength: 8192 } },
  } } }, async (request, reply) => {
    const { dealId, proposalId } = request.params as { dealId: string; proposalId: string }
    const body = request.body as { digest: string; readToken: string }, secret = app.appConfig.jwtAccessSecret ?? ''
    return withIdempotency(db(), request, reply, 'event-move.accept', tx => tx(async client => {
      const scope = await locateRootMove(client, dealId, proposalId, actor(request))
      const result = await acceptEventMove(client, scope, body, secret)
      await assertSeatingToken(request)
      return { status: 200, body: result }
    }, { afterReceipt: async client => {
      const scope = await locateRootMove(client, dealId, proposalId, actor(request))
      const party = await lockRootMove(client, scope)
      await assertMoveRead(scope, body.digest, body.readToken, secret, party)
      await assertSeatingToken(request)
    } }), true, async client => {
      const scope = await locateRootMove(client, dealId, proposalId, actor(request))
      await lockRootMove(client, scope)
      // A saved receipt still requires the current private seat. An old read
      // proof need not be renewed just to replay an already recorded receipt.
      await assertSeatingToken(request)
    })
  })
  app.post(prefix + '/:proposalId/apply', { schema: { params: proposalParams, body: digestBody } }, async (request, reply) => {
    const scope = input(request), { proposalId } = request.params as { proposalId: string }, body = request.body as { digest: string }
    return withIdempotency(db(), request, reply, 'event-move.apply', tx => tx(async client => runEnrolledFanout(client, {
      owner: 'event-move.apply', weddingId: scope.weddingId, actorId: scope.actor.userId, request, afterReceipt: true,
    }, async emissions => {
      await lockMoveCustomer(client, scope)
      const result = await applyEventMove(client, scope, proposalId, body.digest)
      emissions.afterLastWrite(async () => { await client.query('select event_move_assert_applied($1)', [result.effectId]) })
      sendTimelineVersion(reply, await lockTimeline(client, scope.weddingId, true))
      return { status: 200, body: result.body }
    }), { afterReceipt: finishEnrolledFanoutAfterReceipt }), true, async client => {
      await lockMoveCustomer(client, scope)
      await moveProposalDto(client, scope, proposalId)
      await assertSeatingToken(request)
    })
  })
  app.post(prefix + '/:proposalId/cancel', { schema: { params: proposalParams, body: digestBody } }, async (request, reply) => {
    const scope = input(request), { proposalId } = request.params as { proposalId: string }, body = request.body as { digest: string }
    return withIdempotency(db(), request, reply, 'event-move.cancel', tx => tx(async client => {
      await lockMoveCustomer(client, scope)
      const result = await cancelEventMove(client, scope, proposalId, body.digest)
      await assertSeatingToken(request)
      return { status: 200, body: result }
    }, { afterReceipt: () => assertSeatingToken(request) }), true, async client => {
      await lockMoveCustomer(client, scope)
      await moveProposalDto(client, scope, proposalId)
      await assertSeatingToken(request)
    })
  })
}
