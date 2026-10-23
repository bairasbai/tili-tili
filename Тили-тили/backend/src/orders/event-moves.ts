import { createHash } from 'node:crypto'
import type { Db, Queryable } from '../plugins/db.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockBookingActor } from '../deals/book.js'
import { lockOrderContext, lockOrderPrincipal, lockOrderWedding, type OrderActor } from './context.js'
import { signEventMoveRead, verifyEventMoveRead } from './event-move-token.js'
import { finishEventDayChange, observeEventDayChange, prepareEventDayChange } from '../deals/day-scope-write.js'
import { setTimelineActor } from '../timeline/version.js'

export interface MoveTarget { date: string; timeZone: string; location: string | null }
export interface MoveInput { weddingId: string; eventId: string; actor: OrderActor }
interface ProposalRow {
  id: string; wedding_id: string; event_id: string; baseline: { event: { date: string; time_zone: string; location: string | null } }
  target: MoveTarget; digest: string; created_at: Date
}
interface ReceiptRow {
  id: string; party: 'customer' | 'performer'; user_id: string | null; session_id: string | null; digest: string; accepted_at: Date
}
interface RootRow { deal_id: string; digest: string; material: Record<string, unknown> }
const stale = () => conflict('event_move_source_changed', 'Условия мероприятия или заказа изменились — создайте новое предложение переноса')
const receiptDto = (row: ReceiptRow) => ({ id: row.id, party: row.party, userId: row.user_id,
  sessionId: row.session_id, digest: row.digest, acceptedAt: row.accepted_at.toISOString() })
async function receipts(client: Queryable, proposalId: string, dealId: string) {
  return (await client.query<ReceiptRow>(`select id,party,user_id,session_id,digest,accepted_at from event_move_receipts
    where proposal_id=$1 and deal_id=$2 order by accepted_at,id`, [proposalId, dealId])).rows.map(receiptDto)
}
export async function lockMoveCustomer(client: Queryable, input: MoveInput): Promise<void> {
  await lockOrderWedding(client, input.weddingId)
  await lockBookingActor(client, { weddingId: input.weddingId, actorId: input.actor.userId,
    sessionId: input.actor.sessionId, policyVersion: input.actor.policyVersion })
  const event = await client.query('select id from wedding_events where wedding_id=$1 and id=$2 for update', [input.weddingId, input.eventId])
  if (!event.rowCount) throw notFound('Мероприятие не найдено')
}
async function proposal(client: Queryable, input: MoveInput, id: string): Promise<ProposalRow> {
  const row = (await client.query<ProposalRow>(`select id,wedding_id,event_id,baseline,target,digest,created_at
    from event_move_proposals where wedding_id=$1 and event_id=$2 and id=$3 for update`, [input.weddingId, input.eventId, id])).rows[0]
  if (!row) throw notFound('Предложение переноса не найдено')
  return row
}
async function status(client: Queryable, p: ProposalRow): Promise<'pending' | 'applied' | 'cancelled' | 'stale'> {
  const effect = (await client.query<{ action: 'apply' | 'cancel' }>('select action from event_move_effects where proposal_id=$1', [p.id])).rows[0]
  if (effect) return effect.action === 'apply' ? 'applied' : 'cancelled'
  const current = (await client.query<{ current: boolean }>(`select baseline=event_move_source_snapshot(wedding_id,event_id)
    and event_move_scope_supported(baseline) is true as current from event_move_proposals where id=$1`, [p.id])).rows[0]
  return current?.current ? 'pending' : 'stale'
}
async function requirePending(client: Queryable, p: ProposalRow): Promise<void> {
  const state = await status(client, p)
  if (state === 'cancelled') throw conflict('event_move_cancelled', 'Предложение переноса отменено')
  if (state === 'applied') throw conflict('event_move_closed', 'Предложение переноса уже закрыто')
  const scope = (await client.query<{ supported: boolean }>('select event_move_scope_supported(event_move_source_snapshot($1,$2)) supported', [p.wedding_id, p.event_id])).rows[0]
  if (!scope?.supported) throw conflict('event_move_scope_incomplete', 'Перенос этого состава требует отдельного согласования обязательств')
  if (state === 'stale') throw stale()
}
export async function moveProposalDto(client: Queryable, input: MoveInput, id: string) {
  const p = await proposal(client, input, id)
  const roots = (await client.query<RootRow>('select deal_id,digest,material from event_move_roots where proposal_id=$1 order by deal_id', [p.id])).rows
  return { id: p.id, eventId: p.event_id, digest: p.digest,
    from: { date: p.baseline.event.date, timeZone: p.baseline.event.time_zone, location: p.baseline.event.location },
    to: p.target, status: await status(client, p),
    roots: await Promise.all(roots.map(async root => ({ dealId: root.deal_id, digest: root.digest, receipts: await receipts(client, p.id, root.deal_id) }))),
    createdAt: p.created_at.toISOString() }
}
export async function listMoveProposals(client: Queryable, input: MoveInput) {
  const rows = (await client.query<{ id: string }>('select id from event_move_proposals where wedding_id=$1 and event_id=$2 order by created_at,id', [input.weddingId, input.eventId])).rows
  const result = []
  for (const row of rows) result.push(await moveProposalDto(client, input, row.id))
  return result
}
export async function proposeEventMove(client: Queryable, input: MoveInput, target: MoveTarget) {
  const current = (await client.query<{ material: unknown; supported: boolean }>(`select material,event_move_scope_supported(material) supported
    from (select event_move_source_snapshot($1,$2) material) source`, [input.weddingId, input.eventId])).rows[0]!
  if (!current.supported) throw conflict('event_move_scope_incomplete', 'Перенос этого состава требует отдельного согласования обязательств')
  const id = uuidv7()
  const row = (await client.query<{ id: string }>(`insert into event_move_proposals(id,wedding_id,event_id,baseline,target,canonical_payload,digest,created_by,session_id,policy_version)
    select $1,$2,$3,$4::jsonb,$5::jsonb,payload,encode(pg_catalog.sha256(convert_to(payload,'UTF8')),'hex'),$6,$7,$8
    from (select jsonb_build_object('baseline',$4::jsonb,'target',$5::jsonb)::text payload) canonical returning id`,
  [id, input.weddingId, input.eventId, JSON.stringify(current.material), JSON.stringify(target), input.actor.userId, input.actor.sessionId, input.actor.policyVersion])).rows[0]!
  await client.query(`insert into event_move_roots(wedding_id,proposal_id,deal_id,vendor_id,material,canonical_payload,digest)
    select p.wedding_id,p.id,(r->>'dealId')::uuid,(r->'domain'->'deals'->0->>'vendor_id')::uuid,
      material,material::text,encode(pg_catalog.sha256(convert_to(material::text,'UTF8')),'hex')
    from event_move_proposals p cross join lateral jsonb_array_elements(p.baseline->'roots') r
    cross join lateral (select event_move_root_material(p.baseline,p.target,p.id,(r->>'dealId')::uuid) material) m
    where p.id=$1 and r->'domain'->'deals'->0->>'state' in ('booked','paid_deposit')`, [id])
  await audit(client, input, 'event_move.proposed', id)
  return moveProposalDto(client, input, row.id)
}
export interface RootMoveInput extends MoveInput { dealId: string; proposalId: string }
export async function listRootMoves(client: Queryable, dealId: string, actor: OrderActor) {
  const deal = (await client.query<{ wedding_id: string }>('select wedding_id from deals where id=$1', [dealId])).rows[0]
  if (!deal) throw notFound('Заказ не найден')
  await lockOrderContext(client, deal.wedding_id, dealId, actor, false)
  const rows = (await client.query<ProposalRow>(`select p.id,p.wedding_id,p.event_id,p.baseline,p.target,p.digest,p.created_at
    from event_move_proposals p join event_move_roots r on r.proposal_id=p.id
    where r.deal_id=$1 and p.wedding_id=$2 order by p.created_at,p.id`, [dealId, deal.wedding_id])).rows
  const result = []
  for (const p of rows) result.push({ id: p.id, eventId: p.event_id, status: await status(client, p), createdAt: p.created_at.toISOString() })
  return result
}
/** Locator reads no private material. Authority is re-read under the wedding,
 * principal, membership/company and proposal locks before returning any DTO. */
export async function locateRootMove(client: Queryable, dealId: string, proposalId: string, actor: OrderActor): Promise<RootMoveInput> {
  const row = (await client.query<{ wedding_id: string; event_id: string }>(`select p.wedding_id,p.event_id from event_move_proposals p
    join event_move_roots r on r.proposal_id=p.id join deals d on d.id=r.deal_id and d.wedding_id=p.wedding_id
    where p.id=$1 and r.deal_id=$2`, [proposalId, dealId])).rows[0]
  if (!row) throw notFound('Предложение переноса не найдено')
  return { weddingId: row.wedding_id, eventId: row.event_id, dealId, proposalId, actor }
}
export async function lockRootMove(client: Queryable, input: RootMoveInput) {
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor, false)
  await client.query('select id from wedding_events where wedding_id=$1 and id=$2 for share', [input.weddingId, input.eventId])
  await proposal(client, input, input.proposalId)
  return context.actorRole === 'couple' ? 'customer' as const : 'performer' as const
}
export async function readRootMove(client: Queryable, input: RootMoveInput, secret: string) {
  const party = await lockRootMove(client, input)
  const p = await proposal(client, input, input.proposalId)
  const root = (await client.query<RootRow>('select deal_id,digest,material from event_move_roots where proposal_id=$1 and deal_id=$2', [p.id, input.dealId])).rows[0]
  if (!root) throw notFound('Предложение переноса не найдено')
  const state = await status(client, p)
  const readToken = state === 'pending' ? await signEventMoveRead(secret, { purpose: 'event-move-read', weddingId: input.weddingId,
    dealId: input.dealId, proposalId: p.id, digest: root.digest, userId: input.actor.userId,
    sessionId: input.actor.sessionId, policyVersion: input.actor.policyVersion, party }, new Date()) : null
  return { id: p.id, eventId: p.event_id, dealId: input.dealId, digest: root.digest, material: root.material,
    receipts: await receipts(client, p.id, input.dealId), readToken, status: state }
}
export async function assertMoveRead(input: RootMoveInput, digest: string, token: string, secret: string,
  party: 'customer' | 'performer'): Promise<void> {
  const claims = await verifyEventMoveRead(secret, token, new Date())
  if (claims.weddingId !== input.weddingId || claims.dealId !== input.dealId || claims.proposalId !== input.proposalId
    || claims.digest !== digest || claims.userId !== input.actor.userId || claims.sessionId !== input.actor.sessionId
    || claims.policyVersion !== input.actor.policyVersion || claims.party !== party) throw validationFailed({ readToken: 'Откройте именно эти условия переноса в текущей сессии' })
}
export async function acceptEventMove(client: Queryable, input: RootMoveInput, body: { digest: string; readToken: string }, secret: string) {
  const party = await lockRootMove(client, input), p = await proposal(client, input, input.proposalId)
  await requirePending(client, p)
  await assertMoveRead(input, body.digest, body.readToken, secret, party)
  const root = (await client.query<{ digest: string }>('select digest from event_move_roots where proposal_id=$1 and deal_id=$2', [p.id, input.dealId])).rows[0]!
  if (root.digest !== body.digest) throw validationFailed({ digest: 'Нужно согласовать точный прочитанный текст переноса' })
  const existing = (await client.query<ReceiptRow>('select id,party,user_id,session_id,digest,accepted_at from event_move_receipts where proposal_id=$1 and deal_id=$2 and party=$3', [p.id, input.dealId, party])).rows[0]
  if (existing && (existing.user_id !== input.actor.userId || existing.session_id !== input.actor.sessionId || existing.digest !== body.digest)) {
    throw conflict('event_move_party_changed', 'Согласие этой стороны уже записано в другой сессии')
  }
  if (!existing) {
    await client.query(`insert into event_move_receipts(id,wedding_id,proposal_id,deal_id,party,user_id,session_id,policy_version,digest,read_proof_hash)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [uuidv7(), input.weddingId, p.id, input.dealId, party,
      input.actor.userId, input.actor.sessionId, input.actor.policyVersion, body.digest, createHash('sha256').update(body.readToken).digest('hex')])
    await audit(client, input, 'event_move.accepted', p.id, { dealId: input.dealId, party })
  }
  return { id: p.id, dealId: input.dealId, digest: body.digest, receipts: await receipts(client, p.id, input.dealId) }
}
export async function applyEventMove(client: Queryable, input: MoveInput, proposalId: string, digest: string) {
  const p = await proposal(client, input, proposalId)
  if (digest !== p.digest) throw validationFailed({ digest: 'Нужно точное предложение переноса' })
  const effect = (await client.query<{ action: 'apply' | 'cancel' }>('select action from event_move_effects where proposal_id=$1', [p.id])).rows[0]
  if (effect) throw conflict(effect.action === 'cancel' ? 'event_move_cancelled' : 'event_move_closed',
    effect.action === 'cancel' ? 'Предложение переноса отменено' : 'Предложение переноса уже применено')
  // The outer complete vendor mutex precedes this read. A genuinely occupied
  // target discovered after the wait keeps its normal availability refusal;
  // it must never be replaced by a partial move or a forged source baseline.
  const unavailable = await client.query(`select b.id from event_move_roots r join vendor_busy_dates b
    on b.vendor_id=r.vendor_id and b.date=$2::date left join deals d on d.id=b.deal_id
    left join legacy_day_groups g on g.day_id=b.id where r.proposal_id=$1 and
      (b.source<>'deal' or d.wedding_id is distinct from $3::uuid or d.vendor_id is distinct from r.vendor_id
        or d.state not in ('booked','paid_deposit','done') or (g.day_id is not null and
          (g.wedding_id is distinct from $3::uuid or g.classification='opaque'))) limit 1`, [p.id, p.target.date, input.weddingId])
  if (unavailable.rowCount) throw conflict('date_taken', 'Эта дата у подрядчика уже занята')
  await requirePending(client, p)
  // The enclosing fanout prefix pins the complete company/user union. Lock all
  // actual accepting sessions, in a stable order, before trusting their seats.
  const parties = (await client.query<{ user_id: string | null; session_id: string | null }>(`select distinct user_id,session_id from event_move_receipts
    where proposal_id=$1 order by user_id,session_id`, [p.id])).rows
  for (const party of parties) {
    if (!party.user_id || !party.session_id) throw conflict('event_move_not_agreed', 'Нужно действующее согласие обеих сторон каждого заказа')
    await lockOrderPrincipal(client, { userId: party.user_id, sessionId: party.session_id, policyVersion: input.actor.policyVersion })
  }
  const agreed = (await client.query<{ agreed: boolean }>('select event_move_agreed($1,$2) agreed', [p.id, input.actor.policyVersion])).rows[0]!.agreed
  if (!agreed) throw conflict('event_move_not_agreed', 'Нужно согласие пары и исполнителя для каждого заказа')
  const roots = (await client.query<{ deal_id: string }>('select deal_id from event_move_roots where proposal_id=$1 order by deal_id', [p.id])).rows.map(row => row.deal_id)
  const plan = await prepareEventDayChange(client, input.weddingId, input.eventId, roots)
  const effectId = uuidv7()
  await client.query(`insert into event_move_effects(id,wedding_id,event_id,proposal_id,action,digest,actor_id,session_id,policy_version,planned_versions)
    values($1,$2,$3,$4,'apply',$5,$6,$7,$8,$9::jsonb)`, [effectId, input.weddingId, input.eventId, p.id, p.digest,
    input.actor.userId, input.actor.sessionId, input.actor.policyVersion, JSON.stringify(plan.plannedVersions)])
  await observeEventDayChange(client, plan, p.target.date)
  await setTimelineActor(client, input.actor.userId)
  await client.query('update wedding_events set date=$3::date,time_zone=$4,location=$5 where wedding_id=$1 and id=$2',
    [input.weddingId, input.eventId, p.target.date, p.target.timeZone, p.target.location])
  await finishEventDayChange(client, plan)
  await audit(client, input, 'event_move.applied', p.id)
  return { effectId, body: await moveProposalDto(client, input, p.id) }
}
export async function cancelEventMove(client: Queryable, input: MoveInput, proposalId: string, digest: string) {
  const p = await proposal(client, input, proposalId)
  if (digest !== p.digest) throw validationFailed({ digest: 'Нужно точное предложение переноса' })
  const state = await status(client, p)
  if (state === 'applied' || state === 'cancelled') throw conflict('event_move_closed', 'Предложение переноса уже закрыто')
  await client.query(`insert into event_move_effects(id,wedding_id,event_id,proposal_id,action,digest,actor_id,session_id,policy_version,planned_versions)
    values($1,$2,$3,$4,'cancel',$5,$6,$7,$8,'[]'::jsonb)`, [uuidv7(), input.weddingId, input.eventId, p.id, p.digest,
    input.actor.userId, input.actor.sessionId, input.actor.policyVersion])
  await audit(client, input, 'event_move.cancelled', p.id)
  return moveProposalDto(client, input, p.id)
}
async function audit(client: Queryable, input: MoveInput, action: string, id: string, extra: Record<string, unknown> = {}) {
  await client.query('insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,$3,$4,$5::jsonb)',
    [input.actor.userId, action, 'event_move', id, JSON.stringify({ weddingId: input.weddingId, eventId: input.eventId, ...extra })])
}

/** Export re-reads the private seat under locks; the account handler's earlier
 * wedding list is not authority. Vendors never receive the bundle baseline. */
export async function eventMoveExport(db: Db, actor: OrderActor, afterRead: () => Promise<void>) {
  return db.tx(async client => {
    const candidates = (await client.query<{ wedding_id: string }>(`select wedding_id from wedding_members where user_id=$1 and role='couple'
      union select d.wedding_id from deals d join vendors v on v.id=d.vendor_id where v.user_id=$1 order by wedding_id`, [actor.userId])).rows.map(row => row.wedding_id)
    await client.query('select id from weddings where id=any($1::uuid[]) order by id for share', [candidates])
    await lockOrderPrincipal(client, actor)
    const couple = (await client.query<{ wedding_id: string }>(`select wedding_id from wedding_members
      where wedding_id=any($1::uuid[]) and user_id=$2 and role='couple' order by wedding_id for share`, [candidates, actor.userId])).rows.map(row => row.wedding_id)
    const companies = (await client.query<{ id: string }>(`select v.id from vendors v join users u on u.id=v.user_id
      where v.user_id=$1 and v.blocked_at is null and u.deleted_at is null order by v.id for share of v,u`, [actor.userId])).rows.map(row => row.id)
    const eventMoveProposals = (await client.query(`select p.id,p.wedding_id,p.event_id,p.digest,p.target,p.created_by,p.session_id,p.policy_version,p.created_at,
      jsonb_build_object('date',p.baseline->'event'->'date','timeZone',p.baseline->'event'->'time_zone','location',p.baseline->'event'->'location') as "from"
      from event_move_proposals p where p.wedding_id=any($1::uuid[]) order by p.created_at,p.id`, [couple])).rows
    const eventMoveRoots = (await client.query(`select r.proposal_id,r.deal_id,r.material,r.digest from event_move_roots r
      where r.wedding_id=any($1::uuid[]) or (r.wedding_id=any($2::uuid[]) and r.vendor_id=any($3::uuid[])
        and exists(select 1 from deals d where d.id=r.deal_id and d.wedding_id=r.wedding_id and d.vendor_id=r.vendor_id))
      order by r.proposal_id,r.deal_id`, [couple, candidates, companies])).rows
    const rootIds = eventMoveRoots.map(row => ({ proposalId: row.proposal_id, dealId: row.deal_id }))
    const eventMoveReceipts = (await client.query(`select a.id,a.proposal_id,a.deal_id,a.party,a.user_id,a.session_id,a.digest,a.accepted_at
      from event_move_receipts a where exists(select 1 from jsonb_to_recordset($1::jsonb) as r("proposalId" uuid,"dealId" uuid)
        where r."proposalId"=a.proposal_id and r."dealId"=a.deal_id) order by a.accepted_at,a.id`, [JSON.stringify(rootIds)])).rows
    const eventMoveEffects = (await client.query(`select e.id,e.proposal_id,e.action,e.actor_id,e.session_id,e.created_at
      from event_move_effects e where exists(select 1 from jsonb_to_recordset($1::jsonb) as r("proposalId" uuid,"dealId" uuid)
        where r."proposalId"=e.proposal_id) order by e.created_at,e.id`, [JSON.stringify(rootIds)])).rows
    await afterRead()
    return { eventMoveProposals, eventMoveRoots, eventMoveReceipts, eventMoveEffects }
  })
}
