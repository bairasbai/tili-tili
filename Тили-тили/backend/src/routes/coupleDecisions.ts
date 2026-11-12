import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { ref } from '../contract/schemas.generated.js'
import type { components } from '../contract/api.generated.js'
import { assertSeatingToken, lockGuestReadAccess, lockSeatingAccess } from '../wedding/access.js'

type Contract = components['schemas']
type Answer = Contract['CoupleDecisionResponseWrite']['response']
type Partner = Contract['CoupleDecisionBoard']['partners'][number]

interface DecisionRow {
  id: string
  title: string
  proposer_id: string | null
  partner_id: string | null
  version: number
  author_id: string | null
  proposal: string
  proposer_response: Answer | null
  partner_response: Answer | null
  effective_version: number | null
  effective_proposal: string | null
  effective_at: Date | null
}

function decisionRows(client: Queryable, weddingId: string, actorId: string, decisionId: string | null = null) {
  return client.query<DecisionRow>(`select d.id,d.title,d.proposer_id,d.partner_id,
      latest.version,latest.author_id,latest.proposal,latest.proposer_response,latest.partner_response,
      effective.version as effective_version,effective.proposal as effective_proposal,effective.effective_at
    from wedding_decisions d
    join lateral (
      select version,author_id,proposal,proposer_response,partner_response
      from wedding_decision_versions where decision_id=d.id order by version desc limit 1
    ) latest on true
    left join lateral (
      select version,proposal,effective_at from wedding_decision_versions
      where decision_id=d.id and effective_at is not null order by version desc limit 1
    ) effective on true
    where d.wedding_id=$1 and (d.proposer_id=$2 or d.partner_id=$2) and ($3::uuid is null or d.id=$3)
    order by d.created_at desc,d.id desc`, [weddingId, actorId, decisionId])
}

async function loadDecision(client: Queryable, weddingId: string, actorId: string, decisionId: string) {
  const { rows: [row] } = await decisionRows(client, weddingId, actorId, decisionId)
  if (!row) throw notFound('Решение не найдено')
  return row
}

async function partners(client: Queryable, weddingId: string, actorId: string, onlyId?: string): Promise<Partner[]> {
  const { rows } = await client.query<Partner>(`select u.id as "userId",u.name from wedding_members m
    join users u on u.id=m.user_id and u.deleted_at is null
    where m.wedding_id=$1 and m.role='couple' and u.id<>$2 and ($3::uuid is null or u.id=$3)
    order by m.joined_at,u.id ${onlyId ? 'for share of u,m' : ''}`, [weddingId, actorId, onlyId ?? null])
  return rows
}

function project(row: DecisionRow, actorId: string, partner?: Partner): Contract['CoupleDecision'] {
  const isProposer = row.proposer_id === actorId
  return {
    id: row.id, title: row.title, partnerName: partner?.name ?? null, partnerAvailable: Boolean(partner),
    proposal: { version: row.version, text: row.proposal,
      myResponse: isProposer ? row.proposer_response : row.partner_response,
      partnerResponse: isProposer ? row.partner_response : row.proposer_response },
    effective: row.effective_at && row.effective_version !== null && row.effective_proposal !== null
      ? { version: row.effective_version, text: row.effective_proposal, activatedAt: row.effective_at.toISOString() } : null,
  }
}

async function activePartner(client: Queryable, weddingId: string, actorId: string, row: DecisionRow) {
  const partnerId = row.proposer_id === actorId ? row.partner_id : row.proposer_id
  const partner = partnerId ? (await partners(client, weddingId, actorId, partnerId))[0] : undefined
  if (!partner) throw conflict('decision_partner_unavailable', 'Партнёр больше не может согласовать это решение')
  return partner
}

const decisionParams = { type: 'object', required: ['decisionId'], properties: { decisionId: UUID_ID } } as const
type DecisionParams = { decisionId: string }

export async function coupleDecisionRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const write = (request: FastifyRequest, action: (client: Queryable, weddingId: string, actorId: string) => Promise<Contract['CoupleDecision']>) =>
    db().tx(async client => {
      // The wedding lock also serializes changes to membership and other answers.
      await lockSeatingAccess(client, request)
      const result = await action(client, request.member!.weddingId, request.caller!.userId)
      await assertSeatingToken(request)
      return result
    })

  app.get('/weddings/:weddingId/decisions', async (request, reply): Promise<Contract['CoupleDecisionBoard']> => {
    reply.header('Cache-Control', 'no-store')
    return db().tx(async client => {
      await lockGuestReadAccess(client, request)
      const { weddingId } = request.member!
      const actorId = request.caller!.userId
      const { rows: [wedding] } = await client.query<{ read_only: boolean }>(
        'select cancelled_at is not null as read_only from weddings where id=$1', [weddingId])
      const available = await partners(client, weddingId, actorId)
      const byId = new Map(available.map(p => [p.userId, p]))
      const { rows } = await decisionRows(client, weddingId, actorId)
      return { readOnly: wedding!.read_only, partners: available, items: rows.map(row => {
        const partnerId = row.proposer_id === actorId ? row.partner_id : row.proposer_id
        return project(row, actorId, partnerId ? byId.get(partnerId) : undefined)
      }) }
    })
  })

  app.post<{ Body: Contract['CoupleDecisionCreate'] }>('/weddings/:weddingId/decisions', {
    schema: { body: ref('CoupleDecisionCreate') },
  }, async (request, reply) => {
    const partnerId = request.body.partnerId.toLowerCase()
    const { requestId } = request.body
    const title = request.body.title.trim(), proposal = request.body.proposal.trim()
    const result = await write(request, async (client, weddingId, actorId) => {
      const { rows: [prior] } = await client.query<{ id: string; partner_id: string | null; title: string; proposal: string }>(
        `select d.id,d.partner_id,d.title,v.proposal from wedding_decisions d
          join wedding_decision_versions v on v.decision_id=d.id and v.version=1
          where d.wedding_id=$1 and d.proposer_id=$2 and d.request_id=$3`, [weddingId, actorId, requestId])
      if (prior && (prior.partner_id !== partnerId || prior.title !== title || prior.proposal !== proposal)) {
        throw conflict('decision_request_reused', 'Этот запрос уже использован для другого предложения')
      }
      const partner = (await partners(client, weddingId, actorId, partnerId))[0]
      if (prior) return project(await loadDecision(client, weddingId, actorId, prior.id), actorId, partner)
      if (!partner) throw validationFailed({ partnerId: 'Выберите второго участника пары этой свадьбы' })
      const id = uuidv7()
      await client.query(`insert into wedding_decisions(id,wedding_id,proposer_id,partner_id,request_id,title)
        values($1,$2,$3,$4,$5,$6)`, [id, weddingId, actorId, partnerId, requestId, title])
      await client.query(`insert into wedding_decision_versions(decision_id,version,author_id,proposal)
        values($1,1,$2,$3)`, [id, actorId, proposal])
      return project(await loadDecision(client, weddingId, actorId, id), actorId, partner)
    })
    return reply.code(201).header('Cache-Control', 'no-store').send(result)
  })

  app.put<{ Params: DecisionParams; Body: Contract['CoupleDecisionProposalWrite'] }>('/weddings/:weddingId/decisions/:decisionId/proposal', {
    schema: { params: decisionParams, body: ref('CoupleDecisionProposalWrite') },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return write(request, async (client, weddingId, actorId) => {
      const current = await loadDecision(client, weddingId, actorId, request.params.decisionId)
      const partner = await activePartner(client, weddingId, actorId, current)
      const { expectedVersion } = request.body
      const proposal = request.body.proposal.trim()
      if (current.version === expectedVersion + 1 && current.author_id === actorId && current.proposal === proposal) {
        return project(current, actorId, partner)
      }
      if (current.version !== expectedVersion) throw conflict('decision_version_changed', 'Предложение изменилось. Обновите решение')
      if (current.proposal === proposal) return project(current, actorId, partner)
      if (current.version === 2_147_483_647) throw conflict('decision_version_limit', 'Достигнут предел редакций решения')
      await client.query(`insert into wedding_decision_versions(decision_id,version,author_id,proposal)
        values($1,$2,$3,$4)`, [current.id, current.version + 1, actorId, proposal])
      return project(await loadDecision(client, weddingId, actorId, current.id), actorId, partner)
    })
  })

  app.put<{ Params: DecisionParams; Body: Contract['CoupleDecisionResponseWrite'] }>('/weddings/:weddingId/decisions/:decisionId/response', {
    schema: { params: decisionParams, body: ref('CoupleDecisionResponseWrite') },
  }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return write(request, async (client, weddingId, actorId) => {
      const current = await loadDecision(client, weddingId, actorId, request.params.decisionId)
      const partner = await activePartner(client, weddingId, actorId, current)
      const { version, response } = request.body
      if (current.version !== version) throw conflict('decision_version_changed', 'Предложение изменилось. Обновите решение')
      const isProposer = current.proposer_id === actorId
      const prior = isProposer ? current.proposer_response : current.partner_response
      if (prior === response) return project(current, actorId, partner)
      if (current.effective_version === version) throw conflict('decision_already_approved', 'Редакция уже согласована обоими партнёрами')
      const other = isProposer ? current.partner_response : current.proposer_response
      await client.query(`update wedding_decision_versions set
          proposer_response=case when $3 then $4 else proposer_response end,
          partner_response=case when $3 then partner_response else $4 end,
          effective_at=case when $5 then now() else null end
        where decision_id=$1 and version=$2`, [current.id, version, isProposer, response, response === 'approved' && other === 'approved'])
      return project(await loadDecision(client, weddingId, actorId, current.id), actorId, partner)
    })
  })
}
