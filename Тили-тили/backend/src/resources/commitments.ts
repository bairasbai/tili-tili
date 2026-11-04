import { prepareLegacyCalendarScope } from './legacy-calendar-scope.js'
import { calendarNativeRefusal } from './calendar-errors.js'
import type { Queryable } from '../plugins/db.js'
import { conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { lockOrderContext, lockOrderWedding, type OrderActor } from '../orders/context.js'
import { checkEntityId, checkVersion, objectValues, sameJson, type OrderInput } from '../orders/model.js'
import { inspectOrderResourcePlanForBooking, type BookingResourcePlanLine } from '../orders/resource-plan.js'
import { verifyAgreedOrderTermsForBooking, verifyAgreedLegacyAdoptionTerms } from '../orders/terms.js'
import { openLead } from '../vendor/leads.js'
import type { ResourceKind } from './model.js'

export interface CommitResourceInput extends OrderInput {
  expectedOrderVersion: string; expectedCommitmentRevision: string; termsId: string
  expectedTermsVersion: string; termsDigest: string; planRevisionId: string; expectedPolicyRevision: string
}
export interface CommitmentView {
  revision: string; state: 'not_reserved' | 'reserved' | 'released'; termsId: string | null
  planRevisionId: string | null; reservation: 'not_reserved' | 'reserved' | 'released'
}
interface Head { revision: string; state: CommitmentView['state']; current_version_id: string | null }
interface Version { id: string; vendor_id: string; terms_id: string; plan_revision_id: string; policy_revision: string; action: string }
interface Allocation { id: string; resource_id: string; capacity_window_id: string | null; kind: ResourceKind
  conflict_identity: string; quantity: number; line_snapshot: BookingResourcePlanLine }
interface Resource { id: string; vendor_id: string | null; kind: ResourceKind; conflict_identity: string
  person_user_id: string | null; staff_member_id: string | null; retired_at: Date | null }
interface LockedScope { weddingId: string; dealId: string; vendorId: string | null; ownerId: string | null
  head: Head; version: Version | null; allocations: Allocation[]; policyRevision: string | null }
type ReleaseReason = 'deal_cancelled' | 'wedding_erased' | 'vendor_erased'
function summary(head: Head, version: Version | null): CommitmentView {
  return { revision: head.revision, state: head.state, termsId: version?.terms_id ?? null,
    planRevisionId: version?.plan_revision_id ?? null, reservation: head.state }
}
function validateOrder(input: OrderInput): void {
  const actor = objectValues(input.actor, 'actor')
  if (Object.keys(actor).length !== 3 || Object.keys(actor).some(k => !['userId','sessionId','policyVersion'].includes(k)) ||
    typeof actor.policyVersion !== 'string' || !actor.policyVersion || actor.policyVersion.length > 100) {
    throw validationFailed({ actor: 'Нужна действующая сторона, сессия и версия согласия' })
  }
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  checkEntityId(input.actor.userId, 'userId'); checkEntityId(input.actor.sessionId, 'sessionId')
}
function validateCommit(input: CommitResourceInput, extra: readonly string[] = []): void {
  const value = objectValues(input, 'commitment')
  const allowed = ['weddingId','dealId','actor','expectedOrderVersion','expectedCommitmentRevision','termsId',
    'expectedTermsVersion','termsDigest','planRevisionId','expectedPolicyRevision', ...extra]
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) {
    throw validationFailed({ commitment: 'Нужен точный состав полей подтверждения' })
  }
  validateOrder(input); checkEntityId(input.termsId, 'termsId'); checkEntityId(input.planRevisionId, 'planRevisionId')
  for (const field of ['expectedOrderVersion','expectedTermsVersion','expectedCommitmentRevision','expectedPolicyRevision'] as const) {
    const zero = field === 'expectedCommitmentRevision' || field === 'expectedPolicyRevision'
    checkVersion(input[field], input[field], field, zero)
    if (BigInt(input[field]) > 9223372036854775807n) throw validationFailed({ [field]: 'Версия вне допустимого диапазона' })
  }
  if (typeof input.termsDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.termsDigest)) {
    throw validationFailed({ termsDigest: 'Нужен точный отпечаток согласованных условий' })
  }
}
async function head(client: Queryable, input: Pick<OrderInput, 'weddingId' | 'dealId'>, create = false): Promise<{ head: Head; version: Version | null }> {
  if (create) await client.query(`insert into deal_resource_commitments(wedding_id,deal_id) values($1,$2) on conflict(deal_id) do nothing`, [input.weddingId, input.dealId])
  const h = (await client.query<Head>(`select revision::text,state,current_version_id from deal_resource_commitments
    where wedding_id=$1 and deal_id=$2 for update`, [input.weddingId, input.dealId])).rows[0]
  if (!h) return { head: { revision: '0', state: 'not_reserved', current_version_id: null }, version: null }
  const v = h.current_version_id ? (await client.query<Version>(`select id,vendor_id,terms_id,plan_revision_id,policy_revision::text,action
    from deal_resource_commitment_versions where wedding_id=$1 and deal_id=$2 and id=$3`, [input.weddingId, input.dealId, h.current_version_id])).rows[0] : null
  if (h.current_version_id && !v) throw conflict('resource_commitment_invalid', 'История брони недоступна')
  return { head: h, version: v ?? null }
}
async function locatedAllocations(client: Queryable, input: Pick<OrderInput, 'weddingId' | 'dealId'>): Promise<Allocation[]> {
  return (await client.query<Allocation>(`select id,resource_id,capacity_window_id,kind,conflict_identity,quantity,line_snapshot
    from resource_allocations where wedding_id=$1 and deal_id=$2 and released_at is null order by id`, [input.weddingId, input.dealId])).rows
}
const unique = (ids: string[]) => [...new Set(ids)].sort()

/** No allocation UPDATE is acquired until accounts, company, stable identities,
 * resources and windows have been pinned in that order. Release tolerates dead
 * sources: an accepted allocation survives retirement and revocation. */
async function lockSources(client: Queryable, input: Pick<OrderInput, 'weddingId' | 'dealId'>,
  vendorId: string | null, old: Allocation[], lines: BookingResourcePlanLine[], booking: boolean,
  extraAccountIds: string[] = []): Promise<{ ownerId: string | null; policyRevision: string | null }> {
  const ids = unique([...old.map(a => a.resource_id), ...lines.map(l => l.resourceId)])
  const located = (await client.query<Resource>(`select id,vendor_id,kind,conflict_identity,person_user_id,staff_member_id,retired_at
    from vendor_resources where id=any($1::uuid[]) order by id`, [ids])).rows
  if (located.length !== ids.length) throw conflict('resource_source_changed', 'Источник ресурса недоступен')
  const company = vendorId ? (await client.query<{ user_id: string }>('select user_id from vendors where id=$1', [vendorId])).rows[0] : null
  const accountIds = unique([...extraAccountIds, ...(company ? [company.user_id] : []), ...located.flatMap(r => r.person_user_id ? [r.person_user_id] : [])])
  const accounts = (await client.query<{ id: string; deleted_at: Date | null }>(`select id,deleted_at from users where id=any($1::uuid[]) order by id for share`, [accountIds])).rows
  const currentCompany = vendorId ? (await client.query<{ user_id: string; blocked_at: Date | null }>('select user_id,blocked_at from vendors where id=$1 for share', [vendorId])).rows[0] : null
  if (company?.user_id !== currentCompany?.user_id) throw conflict('resource_source_changed', 'Владелец компании изменился — обновите данные')
  const live = (id: string | null) => id !== null && accounts.some(a => a.id === id && a.deleted_at === null)
  if (booking && (!currentCompany || currentCompany.blocked_at !== null || !live(currentCompany.user_id))) throw notFound('Компания недоступна')
  const policy = vendorId ? (await client.query<{ mode: string; revision: string }>('select mode,revision::text from vendor_availability_policy where vendor_id=$1 for share', [vendorId])).rows[0] : null
  if (booking && policy?.mode !== 'resources') throw conflict('resource_policy_required', 'Для этой брони нужен режим ресурсов компании')
  const memberIds = unique(located.flatMap(r => r.staff_member_id ? [r.staff_member_id] : []))
  const members = (await client.query<{ id: string; vendor_id: string; user_id: string | null; state: string; accepted_at: Date | null; revoked_at: Date | null }>(`select id,vendor_id,user_id,state,accepted_at,revoked_at
    from vendor_staff_members where id=any($1::uuid[]) order by id for share`, [memberIds])).rows
  const identities = [...new Map([...old.map(a => ({ kind: a.kind, identity: a.conflict_identity })),
    ...lines.map(l => ({ kind: l.kind, identity: l.conflictIdentity }))].map(k => [`${k.kind}:${k.identity}`, k])).values()]
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.identity.localeCompare(b.identity))
  // Insert in the same deterministic order: even concurrent first use shares
  // the unique-key wait before either participant reaches resource UPDATE.
  for (const key of identities) {
    await client.query('insert into resource_conflict_keys(kind,identity) values($1,$2) on conflict do nothing', [key.kind, key.identity])
    await client.query('select identity from resource_conflict_keys where kind=$1 and identity=$2 for update', [key.kind, key.identity])
  }
  const resources = (await client.query<Resource>(`select id,vendor_id,kind,conflict_identity,person_user_id,staff_member_id,retired_at
    from vendor_resources where id=any($1::uuid[]) order by id for update`, [ids])).rows
  for (const prior of located) {
    const r = resources.find(r => r.id === prior.id)
    if (!r || r.vendor_id !== prior.vendor_id || r.kind !== prior.kind || r.conflict_identity !== prior.conflict_identity ||
      r.person_user_id !== prior.person_user_id || r.staff_member_id !== prior.staff_member_id) throw conflict('resource_source_changed', 'Источник ресурса изменился — обновите данные')
  }
  for (const line of lines) {
    const r = resources.find(r => r.id === line.resourceId)
    if (!r || r.vendor_id !== vendorId || r.retired_at !== null || r.kind !== line.kind || r.conflict_identity !== line.conflictIdentity) {
      throw conflict('resource_source_changed', 'Согласованный ресурс недоступен или изменился')
    }
    if (r.kind === 'person') {
      const m = members.find(m => m.id === r.staff_member_id)
      if (!live(r.person_user_id) || r.person_user_id !== r.conflict_identity ||
        (r.staff_member_id === null ? r.person_user_id !== currentCompany?.user_id :
          !m || m.vendor_id !== vendorId || m.user_id !== r.person_user_id || m.state !== 'active' || m.accepted_at === null || m.revoked_at !== null)) {
        throw conflict('resource_person_unavailable', 'Участие человека в компании недоступно')
      }
    }
  }
  const windowIds = unique([...old.flatMap(a => a.capacity_window_id ? [a.capacity_window_id] : []), ...lines.flatMap(l => l.capacityWindowId ? [l.capacityWindowId] : [])])
  const windows = (await client.query<{ id: string }>('select id from resource_capacity_windows where id=any($1::uuid[]) order by id for update', [windowIds])).rows
  if (windows.length !== windowIds.length) throw conflict('resource_source_changed', 'Окно мощности недоступно')
  const pinned = (await client.query<Allocation>(`select id,resource_id,capacity_window_id,kind,conflict_identity,quantity,line_snapshot
    from resource_allocations where wedding_id=$1 and deal_id=$2 and released_at is null order by id for update`, [input.weddingId, input.dealId])).rows
  if (!sameJson(pinned, old)) throw conflict('resource_commitment_changed', 'Состав брони изменился — обновите заказ')
  return { ownerId: currentCompany?.user_id ?? company?.user_id ?? null, policyRevision: policy?.revision ?? null }
}

async function legacyBoundary(client: Queryable, vendorId: string, dealId: string,
  lines: BookingResourcePlanLine[], initialWitness: string | null): Promise<void> {
  try {
    await client.query('select legacy_calendar_bounds_assert_boundary($1,$2,$3::jsonb,$4)',
      [vendorId, dealId, JSON.stringify(lines), initialWitness])
  } catch (error) { calendarNativeRefusal(error) }
}
/** Only the native constructor can exempt this genuine first pending booking.
 * The immutable witness must finish the exact booking graph at outer COMMIT. */
async function initialCommitWitness(client: Queryable, input: CommitResourceInput, vendorId: string): Promise<string> {
  const deal = (await client.query<{ booked_at: Date | null }>('select booked_at from deals where wedding_id=$1 and id=$2',
    [input.weddingId, input.dealId])).rows[0]
  if (!deal || deal.booked_at !== null) throw conflict('resource_initial_booking_required', 'Прежняя бронь требует отдельного перехода на ресурсы')
  try {
    const row = (await client.query<{ id: string }>('select legacy_calendar_bounds_prepare_initial_commit($1,$2,$3,$4,$5::bigint,$6,$7,$8)::text id',
      [input.weddingId, input.dealId, input.termsId, input.planRevisionId, input.expectedPolicyRevision,
        input.actor.userId, input.actor.sessionId, input.actor.policyVersion])).rows[0]
    if (!row?.id || !vendorId) throw conflict('resource_initial_booking_required', 'Нужна настоящая первичная бронь согласованных ресурсов')
    return row.id
  } catch (error) {
    // This constructor's refusal is an initial-booking precondition, not a
    // licence to mask later graph or outer-COMMIT integrity errors.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514' &&
      (error as { constraint?: string }).constraint === 'legacy_calendar_initial_commit') {
      throw conflict('resource_initial_booking_required', 'Первичная бронь требует текущих согласованных условий без истории прежней брони')
    }
    throw error
  }
}
async function checkAvailability(client: Queryable, lines: BookingResourcePlanLine[], removed: Allocation[]): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.kind === 'capacity') continue
    if (lines.slice(0, i).some(other => other.kind === line.kind && other.conflictIdentity === line.conflictIdentity &&
      Date.parse(other.occupiedStartsAt) < Date.parse(line.occupiedEndsAt) && Date.parse(line.occupiedStartsAt) < Date.parse(other.occupiedEndsAt))) {
      throw conflict('resource_booking_conflict', 'Занятые интервалы одного ресурса пересекаются')
    }
    const conflictRow = await client.query(`select id from resource_allocations where released_at is null and kind=$1 and conflict_identity=$2
      and not(id=any($5::uuid[])) and tstzrange(occupied_starts_at,occupied_ends_at,'[)') && tstzrange($3::timestamptz,$4::timestamptz,'[)') limit 1`,
    [line.kind, line.conflictIdentity, line.occupiedStartsAt, line.occupiedEndsAt, removed.map(a => a.id)])
    if (conflictRow.rowCount) throw conflict('resource_booking_conflict', 'Ресурс занят в согласованный интервал')
  }
  const demand = new Map<string, bigint>()
  for (const line of lines) if (line.capacityWindowId) demand.set(line.capacityWindowId, (demand.get(line.capacityWindowId) ?? 0n) + BigInt(line.quantity))
  for (const [id, quantity] of demand) {
    const window = (await client.query<{ capacity: number; legacy_used: number; live: string }>(`select capacity,legacy_used,
      (select coalesce(sum(quantity),0)::text from resource_allocations where capacity_window_id=$1 and released_at is null and not(id=any($2::uuid[]))) as live
      from resource_capacity_windows where id=$1`, [id, removed.map(a => a.id)])).rows[0]
    if (!window || BigInt(window.legacy_used) + BigInt(window.live) + quantity > BigInt(window.capacity)) {
      throw conflict('resource_capacity_exhausted', 'В выбранном окне недостаточно свободной мощности')
    }
  }
}
async function writeVersion(client: Queryable, scope: LockedScope, action: 'commit' | 'replace' | 'release' | 'adopt',
  proof: { termsId: string; planRevisionId: string; policyRevision: string }, actorId: string | null, reason: ReleaseReason | null = null,
  preset?: { id: string; adoptionProofId: string }) {
  const id = preset?.id ?? uuidv7(), revision = (BigInt(scope.head.revision) + 1n).toString(), state = action === 'release' ? 'released' : 'reserved'
  if (preset) {
    await client.query(`insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,revision,previous_version_id,
      terms_id,plan_revision_id,policy_revision,action,state,reason,created_by,legacy_adoption_proof_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, scope.weddingId, scope.dealId, scope.vendorId, revision, scope.head.current_version_id, proof.termsId, proof.planRevisionId, proof.policyRevision, action, state, reason, actorId, preset.adoptionProofId])
  } else {
    await client.query(`insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,revision,previous_version_id,
      terms_id,plan_revision_id,policy_revision,action,state,reason,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, scope.weddingId, scope.dealId, scope.vendorId, revision, scope.head.current_version_id, proof.termsId, proof.planRevisionId, proof.policyRevision, action, state, reason, actorId])
  }
  return { id, revision, state: state as 'reserved' | 'released' }
}
async function publishHead(client: Queryable, scope: LockedScope, version: { id: string; revision: string; state: 'reserved' | 'released' }): Promise<void> {
  await client.query('update deal_resource_commitments set revision=$3,state=$4,current_version_id=$5 where wedding_id=$1 and deal_id=$2',
    [scope.weddingId, scope.dealId, version.revision, version.state, version.id])
}

async function reserve(client: Queryable, input: CommitResourceInput, replacement: boolean): Promise<CommitmentView> {
  validateCommit(input)
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor)
  if (context.actorRole !== 'couple') throw forbidden('Бронь ресурсов подтверждает участник пары')
  if (!context.vendorId) throw conflict('resource_vendor_required', 'Для брони нужен действующий исполнитель')
  const selected = (await client.query<{ deal_id: string | null; prebooked_at: Date | null }>('select deal_id,prebooked_at from slots where wedding_id=$1 and id=$2', [input.weddingId, context.slotId])).rows[0]
  if (!selected || selected.prebooked_at !== null || (selected.deal_id !== null && selected.deal_id !== input.dealId.toLowerCase())) {
    throw conflict('resource_slot_changed', 'Позиция уже относится к другому обязательству')
  }
  const order = (await client.query<{ version: string }>('select version::text from deal_orders where wedding_id=$1 and deal_id=$2 for update', [input.weddingId, input.dealId])).rows[0]
  if (!order) throw notFound('Заказ не найден')
  checkVersion(order.version, input.expectedOrderVersion, 'expectedOrderVersion')
  const h = await head(client, input, true), old = await locatedAllocations(client, input)
  if (h.head.state === 'reserved' && selected.deal_id !== input.dealId.toLowerCase()) {
    throw conflict('resource_slot_changed', 'Выбранный финансовый заказ изменился')
  }
  const plan = await inspectOrderResourcePlanForBooking(client, { ...input, vendorId: context.vendorId })
  if (plan.planRevisionId !== input.planRevisionId.toLowerCase() || !plan.lines.length) throw conflict('resource_plan_changed', 'Нужен точный непустой согласованный план')
  const source = await lockSources(client, input, context.vendorId, old, plan.lines, true)
  checkVersion(source.policyRevision ?? '0', input.expectedPolicyRevision, 'expectedPolicyRevision', true)
  const proof = await verifyAgreedOrderTermsForBooking(client, input)
  const same = h.head.state === 'reserved' && h.version?.terms_id === proof.termsId && h.version.plan_revision_id === proof.planRevisionId &&
    h.version.policy_revision === source.policyRevision
  const initialRetry = !replacement && input.expectedCommitmentRevision === '0' && h.head.revision === '1' && h.version?.action === 'commit' && same
  if (!initialRetry) checkVersion(h.head.revision, input.expectedCommitmentRevision, 'expectedCommitmentRevision', true)
  if (same) {
    await legacyBoundary(client, context.vendorId, input.dealId, plan.lines, null)
    return summary(h.head, h.version)
  }
  if (context.state === 'done') throw conflict('resource_deal_finished', 'Выполненный заказ не принимает новую бронь')
  if (replacement) {
    if (h.head.state !== 'reserved' || !['booked','paid_deposit'].includes(context.state)) throw conflict('resource_replacement_required', 'Заменять можно действующую бронь ресурсов')
  } else if (h.head.state !== 'not_reserved' || !['candidate','contacted','negotiating'].includes(context.state)) {
    throw conflict('resource_initial_booking_required', 'Первичная бронь ресурсов требует заказа на этапе согласования')
  }
  const witness = replacement ? null : await initialCommitWitness(client, input, context.vendorId)
  await legacyBoundary(client, context.vendorId, input.dealId, plan.lines, witness)
  const available = [...old], matched = plan.lines.map(line => {
    const index = available.findIndex(a => sameJson(a.line_snapshot, line))
    return index < 0 ? null : available.splice(index, 1)[0]!
  })
  const newLines = plan.lines.filter((_line, index) => matched[index] === null)
  await checkAvailability(client, newLines, available)
  const scope: LockedScope = { weddingId: input.weddingId, dealId: input.dealId, vendorId: context.vendorId, ...h,
    allocations: old, ...source }
  const version = await writeVersion(client, scope, replacement ? 'replace' : 'commit', { ...proof, policyRevision: source.policyRevision! }, input.actor.userId)
  if (available.length) await client.query(`update resource_allocations set released_at=clock_timestamp(),release_reason='replaced'
    where wedding_id=$1 and deal_id=$2 and id=any($3::uuid[]) and released_at is null`, [input.weddingId, input.dealId, available.map(a => a.id)])
  for (let index = 0; index < plan.lines.length; index++) {
    const line = plan.lines[index]!, allocationId = matched[index]?.id ?? uuidv7()
    if (!matched[index]) await client.query(`insert into resource_allocations(id,wedding_id,deal_id,vendor_id,origin_version_id,origin_line_index,
      line_snapshot,resource_id,capacity_window_id,kind,conflict_identity,quantity,occupied_starts_at,occupied_ends_at)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`, [allocationId, input.weddingId, input.dealId, context.vendorId,
      version.id, index, JSON.stringify(line), line.resourceId, line.capacityWindowId, line.kind, line.conflictIdentity, line.quantity, line.occupiedStartsAt, line.occupiedEndsAt])
    await client.query(`insert into deal_resource_commitment_members(wedding_id,deal_id,version_id,line_index,allocation_id) values($1,$2,$3,$4,$5)`,
      [input.weddingId, input.dealId, version.id, index, allocationId])
  }
  await publishHead(client, scope, version)
  if (!replacement) {
    const claimed = await client.query(`update slots set deal_id=$3 where wedding_id=$1 and id=$2 and prebooked_at is null
      and (deal_id is null or deal_id=$3)`, [input.weddingId, context.slotId, input.dealId])
    if (claimed.rowCount !== 1) throw conflict('resource_slot_changed', 'Позиция уже относится к другому обязательству')
    await client.query("update deals set state='booked',booked_at=clock_timestamp(),negotiating_until=null where wedding_id=$1 and id=$2", [input.weddingId, input.dealId])
    await client.query("insert into deal_events(id,deal_id,from_state,to_state,actor_id) values($1,$2,$3,'booked',$4)", [uuidv7(), input.dealId, context.state, input.actor.userId])
    await openLead(client, input.weddingId, context.vendorId, null, true)
  }
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'order',$3,$4::jsonb)",
    [input.actor.userId, replacement ? 'order.resources_replaced' : 'order.resources_committed', input.dealId,
      JSON.stringify({ beforeRevision: h.head.revision, revision: version.revision, termsId: proof.termsId, planRevisionId: proof.planRevisionId })])
  return { revision: version.revision, state: 'reserved', termsId: proof.termsId, planRevisionId: proof.planRevisionId, reservation: 'reserved' }
}
async function mapExclusion<T>(action: () => Promise<T>): Promise<T> {
  try { return await action() } catch (error) {
    // Re-throw; never continue issuing queries in an aborted transaction.
    if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23P01') {
      throw conflict('resource_booking_conflict', 'Ресурс занят в согласованный интервал')
    }
    throw error
  }
}
export async function commitAgreedOrderResources(client: Queryable, input: CommitResourceInput): Promise<CommitmentView> {
  return mapExclusion(() => reserve(client, input, false))
}
export async function replaceAgreedOrderResources(client: Queryable, input: CommitResourceInput): Promise<CommitmentView> {
  return mapExclusion(() => reserve(client, input, true))
}
export async function loadOrderResourceCommitments(client: Queryable, input: OrderInput): Promise<CommitmentView> {
  validateOrder(input)
  await lockOrderContext(client, input.weddingId, input.dealId, input.actor, false)
  const current = await head(client, input)
  return summary(current.head, current.version)
}

/** The public shape carries no authorisation. Only a scope constructed here,
 * on this client and this PostgreSQL transaction, can release allocations. */
export interface PreparedDealResourceRelease { readonly prepared: true }
interface ReleaseBinding { client: Queryable; txid: string; pid: number; scope: LockedScope; consumed: boolean }
const releaseBindings = new WeakMap<PreparedDealResourceRelease, ReleaseBinding>()
async function transaction(client: Queryable): Promise<{ txid: string; pid: number }> {
  return (await client.query<{ txid: string; pid: number }>('select txid_current()::text as txid,pg_backend_pid() as pid')).rows[0]!
}
export async function prepareDealResourceRelease(client: Queryable, input: { weddingId: string; dealId: string }): Promise<PreparedDealResourceRelease> {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  await prepareLegacyCalendarScope(client, { weddingIds: [input.weddingId] })
  const wedding = await client.query<{ id: string; owner_id: string }>('select id,owner_id from weddings where id=$1 for update', [input.weddingId])
  if (!wedding.rowCount) throw notFound('Свадьба не найдена')
  const deal = (await client.query<{ vendor_id: string | null }>(`select d.vendor_id from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
    where d.wedding_id=$1 and d.id=$2 for update of d,s`, [input.weddingId, input.dealId])).rows[0]
  if (!deal) throw notFound('Заказ не найден')
  const order = await client.query('select deal_id from deal_orders where wedding_id=$1 and deal_id=$2 for update', [input.weddingId, input.dealId])
  if (!order.rowCount) throw notFound('Заказ не найден')
  const h = await head(client, input), allocations = await locatedAllocations(client, input), vendorId = h.version?.vendor_id ?? deal.vendor_id
  const sources = await lockSources(client, input, vendorId, allocations, [], false, [wedding.rows[0]!.owner_id])
  const scope: LockedScope = { ...input, vendorId, ...h, allocations, ...sources }
  const token: PreparedDealResourceRelease = Object.freeze({ prepared: true })
  releaseBindings.set(token, { client, ...await transaction(client), scope, consumed: false })
  return token
}
export async function releasePreparedDealResources(client: Queryable, token: PreparedDealResourceRelease, reason: ReleaseReason): Promise<CommitmentView> {
  const binding = token && typeof token === 'object' ? releaseBindings.get(token) : undefined
  const tx = await transaction(client)
  if (!binding || binding.client !== client || binding.txid !== tx.txid || binding.pid !== tx.pid) throw forbidden('Освобождение требует подготовленного контекста этой транзакции')
  if (!['deal_cancelled','wedding_erased','vendor_erased'].includes(reason)) throw validationFailed({ reason: 'Неизвестное основание освобождения' })
  const scope = binding.scope
  const source = (await client.query<{ state: string; vendor_id: string | null; archived_at: Date | null; cancelled_at: Date | null }>(`select d.state,d.vendor_id,w.archived_at,w.cancelled_at
    from deals d join weddings w on w.id=d.wedding_id where d.wedding_id=$1 and d.id=$2`, [scope.weddingId, scope.dealId])).rows[0]
  if (!source) throw conflict('resource_release_source_missing', 'Источник нужно освободить до удаления свадьбы')
  if (reason === 'deal_cancelled' && source.state !== 'cancelled') throw conflict('resource_release_requires_cancellation', 'Сначала требуется отмена финансового заказа')
  if (reason === 'wedding_erased' && source.archived_at === null && source.cancelled_at === null) {
    const eligible = (await client.query<{ erased_owner: boolean }>(`select u.deleted_at is not null and not exists(
      select 1 from wedding_members m join users heir on heir.id=m.user_id where m.wedding_id=w.id
        and m.role='couple' and m.user_id<>w.owner_id and (heir.deleted_at is null or heir.deleted_at>clock_timestamp()-interval '30 days')
      ) as erased_owner from weddings w join users u on u.id=w.owner_id where w.id=$1`, [scope.weddingId])).rows[0]
    if (!eligible?.erased_owner) throw conflict('resource_release_requires_erasure', 'Свадьба ещё не подлежит удалению')
  }
  if (reason === 'vendor_erased') {
    const erased = (await client.query<{ external_name: string | null }>('select external_name from deals where wedding_id=$1 and id=$2', [scope.weddingId, scope.dealId])).rows[0]
    if (!scope.vendorId || source.vendor_id !== null || erased?.external_name !== 'Удалённый подрядчик') {
      throw conflict('resource_release_requires_erasure', 'Источник заказа ещё не переведён в удалённого исполнителя')
    }
  }
  if (binding.consumed || scope.head.state !== 'reserved') return summary(scope.head, scope.version)
  if (!scope.version) throw conflict('resource_commitment_invalid', 'История брони недоступна')
  const version = await writeVersion(client, scope, 'release', { termsId: scope.version.terms_id,
    planRevisionId: scope.version.plan_revision_id, policyRevision: scope.version.policy_revision }, null, reason)
  await client.query(`update resource_allocations set released_at=clock_timestamp(),release_reason=$3
    where wedding_id=$1 and deal_id=$2 and released_at is null`, [scope.weddingId, scope.dealId, reason])
  await publishHead(client, scope, version)
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'order.resources_released','order',$1,$2::jsonb)",
    [scope.dealId, JSON.stringify({ beforeRevision: scope.head.revision, revision: version.revision, reason })])
  scope.head = { revision: version.revision, state: 'released', current_version_id: version.id }
  scope.version = { ...scope.version, id: version.id, action: 'release' }
  binding.consumed = true
  return summary(scope.head, scope.version)
}
export async function releaseCancelledDealResources(client: Queryable, input: OrderInput): Promise<CommitmentView> {
  validateOrder(input)
  await prepareLegacyCalendarScope(client, { weddingIds: [input.weddingId], actor: input.actor })
  // UPDATE first, then the ordinary read context: cancelled deals remain
  // readable, whereas the ordinary write context deliberately denies them.
  await lockOrderWedding(client, input.weddingId, true)
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor, false)
  if (context.actorRole !== 'couple') throw forbidden('Освобождение подтверждает участник пары')
  if (context.state !== 'cancelled') throw conflict('resource_release_requires_cancellation', 'Сначала требуется отмена финансового заказа')
  const scope = await prepareDealResourceRelease(client, { weddingId: input.weddingId, dealId: input.dealId })
  return releasePreparedDealResources(client, scope, 'deal_cancelled')
}


/** Stage 372: same financial root adoption. One verified legacy holder of the
 * effective bounds becomes an action='adopt' commitment (revision 1) in one TX;
 * no slot claim, no deal state/bookedAt/DATE/payment mutation. */
export interface AdoptLegacyResourceInput extends CommitResourceInput {
  sourceId: string; sourceVersionId: string; expectedSourceFingerprint: string
  expectedSourceHeadRevision: string; effectiveBoundsVersionId: string
}
export type AdoptLegacyHolderInput = Omit<AdoptLegacyResourceInput, 'actor' | 'sourceId' | 'expectedSourceHeadRevision'>
export interface GroupAdoptionView { sourceId: string; adopted: { weddingId: string; dealId: string; commitment: CommitmentView }[] }
const adoptionKeys = ['sourceId', 'sourceVersionId', 'expectedSourceFingerprint', 'expectedSourceHeadRevision', 'effectiveBoundsVersionId'] as const
function validateAdoption(input: AdoptLegacyResourceInput): void {
  validateCommit(input, [...adoptionKeys])
  checkEntityId(input.sourceId, 'sourceId'); checkEntityId(input.sourceVersionId, 'sourceVersionId')
  checkEntityId(input.effectiveBoundsVersionId, 'effectiveBoundsVersionId')
  if (typeof input.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedSourceFingerprint)) {
    throw validationFailed({ expectedSourceFingerprint: 'Нужен точный отпечаток источника' })
  }
  checkVersion(input.expectedSourceHeadRevision, input.expectedSourceHeadRevision, 'expectedSourceHeadRevision', true)
  if (BigInt(input.expectedSourceHeadRevision) > 9223372036854775807n) throw validationFailed({ expectedSourceHeadRevision: 'Версия вне допустимого диапазона' })
}
function boundsChanged(): never { throw conflict('legacy_calendar_bounds_changed', 'Границы или состав источника изменились — обновите данные') }
interface AdoptionCandidate {
  input: AdoptLegacyResourceInput; vendorId: string
  h: Awaited<ReturnType<typeof head>>; old: Allocation[]
  plan: Awaited<ReturnType<typeof inspectOrderResourcePlanForBooking>>
}
interface FreshAdoption extends AdoptionCandidate {
  kind: 'fresh'; source: Awaited<ReturnType<typeof lockSources>>
  proof: Awaited<ReturnType<typeof verifyAgreedLegacyAdoptionTerms>>
  previousEventId: string; proofId: string; versionId: string; eventId: string
}
type CheckedAdoption = FreshAdoption | { kind: 'applied'; candidate: AdoptionCandidate; view: CommitmentView }
async function locateAdoption(client: Queryable, input: AdoptLegacyResourceInput): Promise<AdoptionCandidate> {
  validateAdoption(input)
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor)
  if (!context.vendorId) throw conflict('resource_vendor_required', 'Для принятия нужен действующий исполнитель')
  if (!['booked', 'paid_deposit'].includes(context.state)) {
    throw conflict('legacy_adoption_state', 'Принятие требует подтверждённого заказа без завершения или отмены')
  }
  const selected = (await client.query<{ deal_id: string | null }>('select deal_id from slots where wedding_id=$1 and id=$2',
    [input.weddingId, context.slotId])).rows[0]
  if (!selected || selected.deal_id !== input.dealId.toLowerCase()) throw conflict('resource_slot_changed', 'Выбранный финансовый заказ изменился')
  const order = (await client.query<{ version: string }>('select version::text from deal_orders where wedding_id=$1 and deal_id=$2 for update', [input.weddingId, input.dealId])).rows[0]
  if (!order) throw notFound('Заказ не найден')
  checkVersion(order.version, input.expectedOrderVersion, 'expectedOrderVersion')
  const h = await head(client, input, true), old = await locatedAllocations(client, input)
  const plan = await inspectOrderResourcePlanForBooking(client, { ...input, vendorId: context.vendorId })
  if (plan.planRevisionId !== input.planRevisionId.toLowerCase() || !plan.lines.length) throw conflict('resource_plan_changed', 'Нужен точный непустой согласованный план')
  return { input, vendorId: context.vendorId, h, old, plan }
}
async function verifyAdoption(client: Queryable, candidate: AdoptionCandidate,
  source: Awaited<ReturnType<typeof lockSources>>): Promise<CheckedAdoption> {
  const { input, h, plan, old } = candidate
  checkVersion(source.policyRevision ?? '0', input.expectedPolicyRevision, 'expectedPolicyRevision', true)
  const boundsHead = (await client.query<{ revision: string; effective_event_id: string | null }>(
    `select h.revision::text,h.effective_event_id::text from legacy_calendar_bounds_heads h
      join legacy_calendar_sources s on s.id=h.source_id
      where h.source_id=$1 and s.vendor_id=$2 and exists(select 1 from legacy_calendar_bounds_holders holder
        where holder.source_id=s.id and holder.wedding_id=$3 and holder.deal_id=$4)
      for share of h`, [input.sourceId, candidate.vendorId, input.weddingId, input.dealId])).rows[0]
  if (!boundsHead || boundsHead.revision !== input.expectedSourceHeadRevision || !boundsHead.effective_event_id) boundsChanged()
  if (h.head.state === 'reserved' && h.version?.action === 'adopt' && h.version.terms_id === input.termsId.toLowerCase() &&
    h.version.plan_revision_id === plan.planRevisionId && h.version.policy_revision === source.policyRevision) {
    // A new key is not a saved idempotency replay: validate the immutable original
    // operation rather than re-materializing schema3 on its now nonempty head.
    const applied = (await client.query<{ source_id: string; source_version_id: string; bounds_version_id: string;
      source_fingerprint: string; terms_version: string; terms_digest: string }>(`
      select p.source_id::text,p.source_version_id::text,p.bounds_version_id::text,p.source_fingerprint,
        t.version::text terms_version,t.digest terms_digest
      from legacy_calendar_adoption_proofs p
      join deal_resource_commitment_versions v on v.id=p.commitment_version_id and v.wedding_id=p.wedding_id and v.deal_id=p.deal_id
        and v.action='adopt' and v.revision=1 and v.legacy_adoption_proof_id=p.id
      join deal_terms_versions t on t.id=p.terms_id and t.wedding_id=p.wedding_id and t.deal_id=p.deal_id
      where p.wedding_id=$1 and p.deal_id=$2 and v.id=$3 and p.terms_id=$4 and p.plan_revision_id=$5`,
    [input.weddingId, input.dealId, h.head.current_version_id, input.termsId, plan.planRevisionId])).rows[0]
    if (!applied || applied.source_id !== input.sourceId.toLowerCase() || applied.source_version_id !== input.sourceVersionId.toLowerCase() ||
      applied.bounds_version_id !== input.effectiveBoundsVersionId.toLowerCase() || applied.source_fingerprint !== input.expectedSourceFingerprint) boundsChanged()
    checkVersion('0', input.expectedCommitmentRevision, 'expectedCommitmentRevision', true)
    checkVersion(applied.terms_version, input.expectedTermsVersion, 'expectedTermsVersion')
    if (applied.terms_digest !== input.termsDigest) throw validationFailed({ termsDigest: 'Редакция согласованных условий не совпадает' })
    return { kind: 'applied', candidate, view: summary(h.head, h.version) }
  }
  checkVersion(h.head.revision, input.expectedCommitmentRevision, 'expectedCommitmentRevision', true)
  if (h.head.revision !== '0' || h.head.state !== 'not_reserved' || h.head.current_version_id !== null || old.length !== 0) {
    throw conflict('legacy_adoption_state', 'Принятие требует пустой брони ресурсов без истории')
  }
  const proof = await verifyAgreedLegacyAdoptionTerms(client, input)
  if (proof.transition.sourceId !== input.sourceId.toLowerCase() || proof.transition.sourceVersionId !== input.sourceVersionId.toLowerCase() ||
    proof.transition.effectiveBoundsVersionId !== input.effectiveBoundsVersionId.toLowerCase() || proof.transition.sourceFingerprint !== input.expectedSourceFingerprint) boundsChanged()
  return { ...candidate, kind: 'fresh', source, proof, previousEventId: boundsHead.effective_event_id,
    proofId: uuidv7(), versionId: uuidv7(), eventId: uuidv7() }
}
async function releaseAdoptedBarriers(client: Queryable, adoption: FreshAdoption): Promise<void> {
  const { input, vendorId, proof, proofId, versionId, eventId, previousEventId } = adoption
  try {
    await client.query(`insert into legacy_calendar_adoption_proofs(id,source_id,source_version_id,wedding_id,deal_id,
      bounds_version_id,terms_id,plan_revision_id,commitment_version_id,source_fingerprint,bounds_digest)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [proofId, input.sourceId, input.sourceVersionId, input.weddingId, input.dealId, input.effectiveBoundsVersionId,
      proof.termsId, proof.planRevisionId, versionId, proof.transition.sourceFingerprint, proof.transition.effectiveBoundsDigest])
    await client.query(`insert into legacy_calendar_resolution_events(id,source_id,bounds_version_id,action,previous_event_id,
      actor_id,session_id,policy_version,material)
      values($1,$2,$3,'adopted',$4,$5,$6,$7,legacy_calendar_bounds_adoption_material($8))`,
    [eventId, input.sourceId, input.effectiveBoundsVersionId, previousEventId,
      input.actor.userId, input.actor.sessionId, input.actor.policyVersion, proofId])
    // Release only this verified holder. A group performs this for every verified
    // selected holder before checking any new line; other barriers remain live.
    await client.query(`update resource_occupancy o set released_at=clock_timestamp(),release_reason='adopted',release_event_id=$1
      from resource_occupancy_origin_certificates c
      where o.certificate_id=c.id and c.vendor_identity=$2 and o.released_at is null
        and exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where (line.value->>'lineIndex')::int=o.origin_line_index
            and (r.value->>'weddingId')::uuid=$3 and (r.value->>'dealId')::uuid=$4)`,
    [eventId, vendorId, input.weddingId, input.dealId])
  } catch (error) { calendarNativeRefusal(error) }
}
async function publishAdoption(client: Queryable, adoption: FreshAdoption): Promise<CommitmentView> {
  const { input, vendorId, h, old, plan, source, proof, proofId, versionId } = adoption
  const scope: LockedScope = { weddingId: input.weddingId, dealId: input.dealId, vendorId, ...h, allocations: old, ...source }
  const version = await writeVersion(client, scope, 'adopt',
    { termsId: proof.termsId, planRevisionId: proof.planRevisionId, policyRevision: source.policyRevision! },
    input.actor.userId, null, { id: versionId, adoptionProofId: proofId })
  for (let index = 0; index < plan.lines.length; index++) {
    const line = plan.lines[index]!, allocationId = uuidv7()
    await client.query(`insert into resource_allocations(id,wedding_id,deal_id,vendor_id,origin_version_id,origin_line_index,
      line_snapshot,resource_id,capacity_window_id,kind,conflict_identity,quantity,occupied_starts_at,occupied_ends_at)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`, [allocationId, input.weddingId, input.dealId, vendorId,
      version.id, index, JSON.stringify(line), line.resourceId, line.capacityWindowId, line.kind, line.conflictIdentity, line.quantity, line.occupiedStartsAt, line.occupiedEndsAt])
    await client.query(`insert into deal_resource_commitment_members(wedding_id,deal_id,version_id,line_index,allocation_id) values($1,$2,$3,$4,$5)`,
      [input.weddingId, input.dealId, version.id, index, allocationId])
  }
  await publishHead(client, scope, version)
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.resources_adopted','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ beforeRevision: h.head.revision, revision: version.revision,
      termsId: proof.termsId, planRevisionId: proof.planRevisionId, sourceId: input.sourceId.toLowerCase(),
      boundsVersionId: input.effectiveBoundsVersionId.toLowerCase() })])
  return { revision: version.revision, state: 'reserved', termsId: proof.termsId, planRevisionId: proof.planRevisionId, reservation: 'reserved' }
}
export async function adoptLegacyOrderResources(client: Queryable, input: AdoptLegacyResourceInput): Promise<CommitmentView> {
  return mapExclusion(async () => {
    const candidate = await locateAdoption(client, input)
    const source = await lockSources(client, input, candidate.vendorId, candidate.old, candidate.plan.lines, true)
    const checked = await verifyAdoption(client, candidate, source)
    if (checked.kind === 'fresh') await releaseAdoptedBarriers(client, checked)
    await legacyBoundary(client, candidate.vendorId, input.dealId, candidate.plan.lines, null)
    if (checked.kind === 'applied') return checked.view
    await checkAvailability(client, candidate.plan.lines, [])
    return publishAdoption(client, checked)
  })
}
interface GroupAdoptionInput {
  actor: OrderActor; sourceId: string; expectedSourceHeadRevision: string; holders: AdoptLegacyHolderInput[]
}
/** Validate all selected roots, pin the sorted union once, release only their
 * proved barriers, then check aggregate demand and publish the whole group. */
export async function adoptLegacyResourceGroup(client: Queryable, input: GroupAdoptionInput): Promise<GroupAdoptionView> {
  return mapExclusion(async () => {
    const value = objectValues(input, 'adoption'), allowed = ['actor', 'sourceId', 'expectedSourceHeadRevision', 'holders']
    if (Object.keys(value).length !== allowed.length || Object.keys(value).some(k => !allowed.includes(k))) {
      throw validationFailed({ adoption: 'Нужен точный состав полей группового принятия' })
    }
    const actor = objectValues(input.actor, 'actor')
    if (Object.keys(actor).length !== 3 || Object.keys(actor).some(k => !['userId','sessionId','policyVersion'].includes(k)) ||
      typeof actor.policyVersion !== 'string' || !actor.policyVersion || actor.policyVersion.length > 100) {
      throw validationFailed({ actor: 'Нужна действующая сторона, сессия и версия согласия' })
    }
    checkEntityId(input.actor.userId, 'userId'); checkEntityId(input.actor.sessionId, 'sessionId'); checkEntityId(input.sourceId, 'sourceId')
    checkVersion(input.expectedSourceHeadRevision, input.expectedSourceHeadRevision, 'expectedSourceHeadRevision', true)
    if (BigInt(input.expectedSourceHeadRevision) > 9223372036854775807n) throw validationFailed({ expectedSourceHeadRevision: 'Версия вне допустимого диапазона' })
    if (!Array.isArray(input.holders) || input.holders.length < 1 || input.holders.length > 32) {
      throw validationFailed({ holders: 'Нужен непустой ограниченный список принимаемых обязательств' })
    }
    const holders = input.holders.map(h => ({ ...h, actor: input.actor, sourceId: input.sourceId,
      expectedSourceHeadRevision: input.expectedSourceHeadRevision }) as AdoptLegacyResourceInput)
    for (const holder of holders) validateAdoption(holder)
    const key = (h: AdoptLegacyResourceInput) => `${h.weddingId.toLowerCase()}:${h.dealId.toLowerCase()}`
    if (new Set(holders.map(key)).size !== holders.length) throw validationFailed({ holders: 'Обязательства в группе повторяются' })
    const sorted = [...holders].sort((a, b) => key(a).localeCompare(key(b)))
    await prepareLegacyCalendarScope(client, { sourceIds: [input.sourceId.toLowerCase()],
      weddingIds: unique(sorted.map(h => h.weddingId.toLowerCase())), actor: input.actor })
    const candidates: AdoptionCandidate[] = []
    for (const holder of sorted) candidates.push(await locateAdoption(client, holder))
    const first = candidates[0]!
    if (candidates.some(c => c.vendorId !== first.vendorId)) boundsChanged()
    const source = await lockSources(client, first.input, first.vendorId, first.old, candidates.flatMap(c => c.plan.lines), true)
    // lockSources pins the first root's allocation set; pin every other root
    // under the same already-held accounts/company/identity/resource/window union.
    for (const c of candidates.slice(1)) {
      const pinned = (await client.query<Allocation>(`select id,resource_id,capacity_window_id,kind,conflict_identity,quantity,line_snapshot
        from resource_allocations where wedding_id=$1 and deal_id=$2 and released_at is null order by id for update`,
      [c.input.weddingId, c.input.dealId])).rows
      if (!sameJson(pinned, c.old)) throw conflict('resource_commitment_changed', 'Состав брони изменился — обновите заказ')
    }
    const checked: CheckedAdoption[] = []
    for (const c of candidates) checked.push(await verifyAdoption(client, c, source))
    const fresh = checked.filter((c): c is FreshAdoption => c.kind === 'fresh')
    for (const c of fresh) await releaseAdoptedBarriers(client, c)
    for (const c of candidates) await legacyBoundary(client, c.vendorId, c.input.dealId, c.plan.lines, null)
    await checkAvailability(client, fresh.flatMap(c => c.plan.lines), [])
    const adopted: GroupAdoptionView['adopted'] = []
    for (const c of checked) {
      const holder = c.kind === 'fresh' ? c.input : c.candidate.input
      adopted.push({ weddingId: holder.weddingId.toLowerCase(), dealId: holder.dealId.toLowerCase(),
        commitment: c.kind === 'fresh' ? await publishAdoption(client, c) : c.view })
    }
    return { sourceId: input.sourceId.toLowerCase(), adopted }
  })
}
