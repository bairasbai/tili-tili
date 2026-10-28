import { createHash } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { lockOrderContext, lockOrderReadContext, lockOrderPrincipal, type OrderActor, type OrderContext } from '../orders/context.js'
import { assertVendorLive } from '../catalog/vendors.js'
import { captureLegacyCalendarSource, loadLegacyCalendarInventory, type CalendarSourceKind } from './legacy-source.js'
import { prepareLegacyCalendarScope } from './legacy-calendar-scope.js'
import { parseLegacyBoundsSpan, type LegacyBoundsSpan } from './legacy-bounds-time.js'
import { assertCalendarBoundsProofAvailable, signCalendarBoundsRead, verifyCalendarBoundsRead,
  type CalendarBoundsProofOptions } from './calendar-bounds-token.js'

export type CalendarBoundsOutcome = 'finite' | 'calendar_closed'
export type CalendarBoundsStaffing = 'unknown' | 'declared_complete'
export type CalendarBoundsSpanInput = Omit<LegacyBoundsSpan, 'suppliedStartsAt' | 'suppliedEndsAt'>
export interface CalendarBoundsOutcomeInput {
  outcome: CalendarBoundsOutcome
  closureReason: 'no_remaining_calendar_engagement' | null
  spans: CalendarBoundsSpanInput[]
}
export interface CalendarBoundsHolderInput extends CalendarBoundsOutcomeInput {
  weddingId: string; dealId: string; expectedOrderVersion: string
}
export interface CalendarBoundsProposalBody {
  expectedSourceRevision: string; expectedInventoryRevision: string; expectedHeadRevision: string
  expectedSourceFingerprint: string; holders: CalendarBoundsHolderInput[]
  manualBounds: CalendarBoundsOutcomeInput | null
  staffing: { completeness: CalendarBoundsStaffing; personIds: string[] }
}
export interface CalendarBoundsAcceptBody {
  boundsVersionId: string; expectedVersion: string; digest: string; readToken: string
}
export interface CalendarBoundsActivateBody {
  boundsVersionId: string; expectedHeadRevision: string; expectedSourceFingerprint: string; digest: string
}
export interface CalendarBoundsOwnerInput { vendorId: string; actor: OrderActor }
export interface CalendarBoundsOwnerSourceInput extends CalendarBoundsOwnerInput { sourceId: string }
export interface CalendarBoundsHolderScopeInput { weddingId: string; dealId: string; actor: OrderActor }
export interface CalendarBoundsHolderSourceInput extends CalendarBoundsHolderScopeInput { sourceId: string }
export type CalendarBoundsActivationInput = (CalendarBoundsOwnerSourceInput | CalendarBoundsHolderSourceInput) & CalendarBoundsActivateBody
export interface CalendarSourceSummary {
  sourceId: string; kind: CalendarSourceKind; originDate: string | null; sourceRevision: string; inventoryRevision: string; headRevision: string
  state: 'unresolved' | CalendarBoundsOutcome; freshness: 'current' | 'stale' | 'unavailable'
  scopeCompleteness: 'complete' | 'unknown'; holderCount: number; proposedVersionId: string | null
  effectiveVersionId: string | null; staffingCompleteness: CalendarBoundsStaffing | null; conflicted: boolean; updatedAt: string | null
}
export interface CalendarBoundsSpanView extends LegacyBoundsSpan { originalDate: string | null }
export interface CalendarBoundsHolderView {
  id: string; weddingId: string; dealId: string; slotId: string; label: string; expectedOrderVersion: string
  outcome: CalendarBoundsOutcome; closureReason: 'no_remaining_calendar_engagement' | null; spans: CalendarBoundsSpanView[]
  accepted: { customer: boolean; performer: boolean }
}
export interface CalendarBoundsManualView {
  outcome: CalendarBoundsOutcome; closureReason: 'no_remaining_calendar_engagement' | null; spans: CalendarBoundsSpanView[]
}
export interface CalendarBoundsProposalView {
  id: string; version: string; digest: string; sourceFingerprint: string; inventoryVersionId: string
  holders: CalendarBoundsHolderView[] | null; ownHolder: CalendarBoundsHolderView | null
  manualBounds: CalendarBoundsManualView | null
  staffing: { completeness: CalendarBoundsStaffing; personIds: string[] | null }; createdAt: string
}
export interface CalendarBoundsHistoryView { id: string; version: string; digest: string; createdAt: string; effective: boolean }
export interface CalendarBoundsReceiptView {
  id: string; party: 'customer' | 'performer'; userId: string | null; sessionId: string | null; digest: string; acceptedAt: string
}
export interface CalendarBoundsEditor {
  sourceFingerprint: string; inventoryVersionId: string | null; originDate: string | null
  holders: { weddingId: string; dealId: string; slotId: string; label: string; orderVersion: string; originalDayOptions: string[] }[]
  manualOriginalDayOptions: string[]
  knownPersons: { id: string; name: string | null; available: boolean }[]
  unknownPersonOrigins: { kind: string; id: string }[]
}
export interface CalendarBoundsPrivateView {
  source: CalendarSourceSummary; proposal: CalendarBoundsProposalView | null; history: CalendarBoundsHistoryView[]
  actorRole: 'owner' | 'customer' | 'performer'; acceptedByCaller: boolean; readToken: string | null
  editor: CalendarBoundsEditor | null; receipts: CalendarBoundsReceiptView[]
  readiness: { requiredReceipts: number; acceptedReceipts: number; canAccept: boolean; canActivate: boolean; hasStaleReceipts: boolean }
}
export interface CalendarBoundsSourceList { vendorId: string; sources: CalendarSourceSummary[] }
export interface OwnCalendarBoundsSourceList { weddingId: string; dealId: string; sources: CalendarSourceSummary[] }
export interface PublicLegacyCalendarOccupancy {
  state: 'busy' | 'unknown' | 'none'; occupiedPeriods: { startsAt: string; endsAt: string; timeZone: string | null }[]
  freshness: 'current' | 'stale' | 'unavailable'; updatedAt: string | null
}

type NormalizedOutcome = Omit<CalendarBoundsOutcomeInput, 'spans'> & { spans: LegacyBoundsSpan[] }
type NormalizedHolder = Omit<CalendarBoundsHolderInput, 'spans'> & { spans: LegacyBoundsSpan[] }
interface Declaration { holders: NormalizedHolder[]; manualBounds: NormalizedOutcome | null; staffing: CalendarBoundsProposalBody['staffing'] }
interface MaterialHolder {
  weddingId: string; dealId: string; slotId: string; orderVersion: string
  holderSnapshot: Record<string, unknown>; holderFingerprint: string; calendarInputs: unknown
}
interface SourceMaterial {
  encoding: 'legacy-calendar-bounds-source/1'; sourceId: string; kind: CalendarSourceKind; vendorId: string
  weddingId: string | null; companyId: string | null; originDate: string | null; sourceRevision: string
  scopeCompleteness: 'complete' | 'unknown'; unavailableReason: string | null; inventoryMaterial: unknown
  holders: MaterialHolder[]; context: { weddingIds: string[]; dealIds: string[]; slotIds: string[]; dayIds: string[]; sourceIds: string[] }
  personScope: { identities: string[]; unknownOrigins: { kind: string; id: string }[] }
  vendorOwnerId: string | null; ownerAvailable: boolean; policyMode: string; policyRevision: string
}
interface SourceState {
  material: SourceMaterial; fingerprint: string; inventoryRevision: string; inventoryVersionId: string | null
  inventoryDigest: string | null; inventoryCurrent: boolean; headRevision: string; proposedVersion: string
  proposedVersionId: string | null; effectiveEventId: string | null
  effect: { state: CalendarSourceSummary['state']; freshness: CalendarSourceSummary['freshness']; effectiveVersionId: string | null; conflicted: boolean; updatedAt: string | null }
}
interface VersionRow {
  id: string; source_id: string; inventory_version_id: string; version: string; digest: string
  source_fingerprint: string; declaration: Declaration; staffing_completeness: CalendarBoundsStaffing; created_at: Date
}
interface HolderRow { id: string; wedding_id: string; deal_id: string; slot_id: string; expected_order_version: string; outcome: CalendarBoundsOutcome; closure_reason: CalendarBoundsOutcomeInput['closureReason'] }
interface Seat { role: 'owner' | 'customer' | 'performer'; actor: OrderActor; weddingId?: string; dealId?: string }
const INT8 = 9223372036854775807n
const ownerKeys = ['vendorId', 'actor', 'sourceId']
const holderKeys = ['weddingId', 'dealId', 'actor', 'sourceId']
const proposalKeys = ['expectedSourceRevision', 'expectedInventoryRevision', 'expectedHeadRevision', 'expectedSourceFingerprint', 'holders', 'manualBounds', 'staffing']
const activateKeys = ['boundsVersionId', 'expectedHeadRevision', 'expectedSourceFingerprint', 'digest']
const outcomeKeys = ['outcome', 'closureReason', 'spans']
function invalid(field: string): never { throw validationFailed({ [field]: 'Нужен точный допустимый состав данных' }) }
function changed(): never { throw conflict('legacy_calendar_bounds_changed', 'Границы или состав источника изменились — обновите данные') }
function incomplete(): never { throw conflict('legacy_calendar_scope_incomplete', 'Нужен полный подтверждённый состав прежнего обязательства') }
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid('bounds')
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid('bounds')
    const own = Reflect.ownKeys(value)
    if (own.some(k => typeof k !== 'string') || (keys && (own.length !== keys.length || own.some(k => !keys.includes(k as string))))) invalid('bounds')
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const k of own) {
      const d = Object.getOwnPropertyDescriptor(value, k)
      if (!d || !Object.hasOwn(d, 'value')) invalid('bounds')
      result[k as string] = d.value
    }
    return result
  } catch { return invalid('bounds') }
}
function id(value: unknown): string { if (!isUuid(value) || value.length !== 36) invalid('id'); return value.toLowerCase() }
function revision(value: unknown, zero = true): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > INT8 || BigInt(value).toString() !== value || (!zero && value === '0')) invalid('version')
  return value
}
function digest(value: unknown): string { if (typeof value !== 'string' || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) invalid('digest'); return value }
function actorOf(value: unknown): OrderActor {
  const a = record(value, ['userId', 'sessionId', 'policyVersion'])
  if (typeof a.policyVersion !== 'string' || !a.policyVersion || a.policyVersion.length > 100) invalid('policyVersion')
  return { userId: id(a.userId), sessionId: id(a.sessionId), policyVersion: a.policyVersion }
}
function ids(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit) incomplete()
  const values = value.map(id).sort()
  if (new Set(values).size !== values.length) invalid('personIds')
  return values
}
function normalizeOutcome(value: unknown): NormalizedOutcome {
  const o = record(value, outcomeKeys)
  if (o.outcome !== 'finite' && o.outcome !== 'calendar_closed') invalid('outcome')
  if (!Array.isArray(o.spans) || o.spans.length > 64) incomplete()
  if (o.outcome === 'finite' ? o.closureReason !== null || o.spans.length === 0 : o.closureReason !== 'no_remaining_calendar_engagement' || o.spans.length !== 0) invalid('closureReason')
  const spans = o.spans.map(parseLegacyBoundsSpan).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.endsAt.localeCompare(b.endsAt))
  for (let i = 1; i < spans.length; i++) if (Date.parse(spans[i]!.startsAt) < Date.parse(spans[i - 1]!.endsAt)) invalid('spans')
  return { outcome: o.outcome, closureReason: o.closureReason as NormalizedOutcome['closureReason'], spans }
}
function declarationOf(value: Record<string, unknown>): Declaration {
  if (!Array.isArray(value.holders) || value.holders.length > 128) incomplete()
  const holders = value.holders.map(raw => {
    const h = record(raw, ['weddingId', 'dealId', 'expectedOrderVersion', ...outcomeKeys])
    return { weddingId: id(h.weddingId), dealId: id(h.dealId), expectedOrderVersion: revision(h.expectedOrderVersion, false),
      ...normalizeOutcome({ outcome: h.outcome, closureReason: h.closureReason, spans: h.spans }) }
  }).sort((a, b) => a.weddingId.localeCompare(b.weddingId) || a.dealId.localeCompare(b.dealId))
  if (new Set(holders.map(h => h.weddingId + ':' + h.dealId)).size !== holders.length) invalid('holders')
  const manualBounds = value.manualBounds === null ? null : normalizeOutcome(value.manualBounds)
  if (holders.reduce((n, h) => n + h.spans.length, manualBounds?.spans.length ?? 0) > 512) incomplete()
  const staffing = record(value.staffing, ['completeness', 'personIds'])
  if (staffing.completeness !== 'unknown' && staffing.completeness !== 'declared_complete') invalid('staffing')
  return { holders, manualBounds, staffing: { completeness: staffing.completeness, personIds: ids(staffing.personIds, 256) } }
}
async function dbNow(client: Queryable): Promise<Date> {
  const row = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]
  if (!row || !(row.now instanceof Date) || !Number.isFinite(row.now.getTime())) incomplete()
  return row.now
}
async function state(client: Queryable, sourceId: string): Promise<SourceState> {
  const r = (await client.query<{ material: SourceMaterial | null; fingerprint: string; inventory_revision: string; inventory_version_id: string | null; inventory_digest: string | null; inventory_current: boolean; head_revision: string; proposed_version: string; proposed_version_id: string | null; effective_event_id: string | null; effect: SourceState['effect'] }>(`
    select x.material, legacy_calendar_bounds_fingerprint(x.material) fingerprint,
      i.revision::text inventory_revision,i.current_version_id::text inventory_version_id,v.digest inventory_digest,
      (v.id is not null and legacy_calendar_present(s) and encode(sha256(convert_to(legacy_calendar_current_inventory_material(s)::text,'UTF8')),'hex')=v.digest) inventory_current,
      coalesce(h.revision,0)::text head_revision,coalesce(h.proposed_version,0)::text proposed_version,
      h.proposed_version_id::text,h.effective_event_id::text,legacy_calendar_bounds_current_effect(s.id) effect
    from legacy_calendar_sources s join legacy_calendar_heads i on i.source_id=s.id
    left join legacy_calendar_versions v on v.id=i.current_version_id
    left join legacy_calendar_bounds_heads h on h.source_id=s.id
    cross join lateral (select legacy_calendar_bounds_source_material(s.id) material) x where s.id=$1`, [sourceId])).rows[0]
  if (!r?.material) throw notFound('Источник календаря не найден')
  if (r.material.encoding !== 'legacy-calendar-bounds-source/1' || !r.effect) incomplete()
  if (r.material.holders.length > 128 || r.material.personScope.identities.length > 256 || r.material.context.sourceIds.length > 128) incomplete()
  return { material: r.material, fingerprint: r.fingerprint, inventoryRevision: r.inventory_revision, inventoryVersionId: r.inventory_version_id,
    inventoryDigest: r.inventory_digest, inventoryCurrent: r.inventory_current, headRevision: r.head_revision, proposedVersion: r.proposed_version,
    proposedVersionId: r.proposed_version_id, effectiveEventId: r.effective_event_id, effect: r.effect }
}
async function owner(client: Queryable, vendorId: string, actor: OrderActor): Promise<void> {
  await loadLegacyCalendarInventory(client, { vendorId, actor })
}
async function holder(client: Queryable, input: CalendarBoundsHolderSourceInput, s: SourceState, context?: OrderContext): Promise<Seat> {
  const c = context ?? await lockOrderContext(client, input.weddingId, input.dealId, input.actor, false)
  if (s.material.weddingId !== input.weddingId || c.vendorId !== s.material.vendorId) throw notFound('Источник календаря не найден')
  const own = s.material.holders.some(h => h.weddingId === input.weddingId && h.dealId === input.dealId)
  if (!own && !(await client.query('select 1 from legacy_calendar_bounds_holders where source_id=$1 and wedding_id=$2 and deal_id=$3 limit 1', [input.sourceId, input.weddingId, input.dealId])).rowCount) throw notFound('Источник календаря не найден')
  // The actual owner speaks for the performer even when also a couple member.
  // The other human must supply the customer receipt; native distinct-user and
  // distinct-session checks still forbid one person accepting both sides.
  return { role: s.material.vendorOwnerId === input.actor.userId ? 'performer' : 'customer',
    actor: input.actor, weddingId: input.weddingId, dealId: input.dealId }
}
function summary(s: SourceState, staffing: CalendarBoundsStaffing | null): CalendarSourceSummary {
  return { sourceId: s.material.sourceId, kind: s.material.kind, originDate: s.material.originDate, sourceRevision: s.material.sourceRevision, inventoryRevision: s.inventoryRevision,
    headRevision: s.headRevision, state: s.effect.state, freshness: s.effect.freshness, scopeCompleteness: s.material.scopeCompleteness,
    holderCount: s.material.holders.length, proposedVersionId: s.proposedVersionId, effectiveVersionId: s.effect.effectiveVersionId,
    staffingCompleteness: staffing, conflicted: s.effect.conflicted, updatedAt: s.effect.updatedAt }
}
function currentProposal(s: SourceState, v: VersionRow): boolean {
  return s.proposedVersionId === v.id && s.inventoryVersionId === v.inventory_version_id && s.inventoryCurrent &&
    s.fingerprint === v.source_fingerprint && s.material.scopeCompleteness === 'complete' && s.material.unavailableReason === null
}
async function version(client: Queryable, sourceId: string, versionId: string): Promise<VersionRow> {
  const row = (await client.query<VersionRow>(`select id::text,source_id::text,inventory_version_id::text,version::text,digest,source_fingerprint,
    declaration,staffing_completeness,created_at from legacy_calendar_bounds_versions where source_id=$1 and id=$2`, [sourceId, versionId])).rows[0]
  if (!row) throw notFound('Версия границ календаря не найдена')
  return row
}
function ownerInput(input: unknown, extra: readonly string[] = []): CalendarBoundsOwnerSourceInput & Record<string, unknown> {
  const o = record(input, [...ownerKeys, ...extra])
  return { ...o, vendorId: id(o.vendorId), sourceId: id(o.sourceId), actor: actorOf(o.actor) }
}
function holderInput(input: unknown, extra: readonly string[] = []): CalendarBoundsHolderSourceInput & Record<string, unknown> {
  const o = record(input, [...holderKeys, ...extra])
  return { ...o, weddingId: id(o.weddingId), dealId: id(o.dealId), sourceId: id(o.sourceId), actor: actorOf(o.actor) }
}
/** Nonlocking opaque locator, before the mandatory full write prefix. */
async function locateSource(client: Queryable, input: CalendarBoundsOwnerSourceInput | CalendarBoundsHolderSourceInput): Promise<{ vendor_id: string; wedding_id: string | null }> {
  const isOwner = 'vendorId' in input
  const row = (await client.query<{ vendor_id: string; wedding_id: string | null }>(isOwner ? `
    select s.vendor_id::text,s.wedding_id::text from legacy_calendar_sources s join vendors v on v.id=s.vendor_id
    where s.id=$1 and s.vendor_id=$2 and v.user_id=$3` : `
    select s.vendor_id::text,s.wedding_id::text from legacy_calendar_sources s join deals d on d.wedding_id=s.wedding_id and d.vendor_id=s.vendor_id
    join vendors v on v.id=s.vendor_id where s.id=$1 and d.wedding_id=$2 and d.id=$3 and
      (v.user_id=$4 or exists(select 1 from wedding_members m where m.wedding_id=d.wedding_id and m.user_id=$4 and m.role='couple'))`,
  isOwner ? [input.sourceId, input.vendorId, input.actor.userId] : [input.sourceId, input.weddingId, input.dealId, input.actor.userId])).rows[0]
  if (!row) throw notFound('Источник календаря не найден')
  if ('weddingId' in input) {
    const own = await client.query(`select 1 where
      exists(select 1 from legacy_calendar_bounds_holders where source_id=$1 and wedding_id=$2 and deal_id=$3)
      or exists(select 1 from jsonb_array_elements(legacy_calendar_bounds_source_material($1)->'holders') h
        where h->>'weddingId'=$2::uuid::text and h->>'dealId'=$3::uuid::text)`,
    [input.sourceId, input.weddingId, input.dealId])
    if (!own.rowCount) throw notFound('Источник календаря не найден')
  }
  return row
}
/** Preliminary nonlocking authority only; locked checks still follow the full prefix. */
export async function assertLegacyCalendarSourceAccess(client: Queryable,
  input: CalendarBoundsOwnerSourceInput | CalendarBoundsHolderSourceInput): Promise<void> {
  const raw = record(input)
  const i = Object.hasOwn(raw, 'vendorId') ? ownerInput(input) : holderInput(input)
  await locateSource(client, i)
}
async function prepare(client: Queryable, input: CalendarBoundsOwnerSourceInput | CalendarBoundsHolderSourceInput) {
  const located = await locateSource(client, input)
  const scope = await prepareLegacyCalendarScope(client, { sourceIds: [input.sourceId], vendorIds: [located.vendor_id],
    weddingIds: located.wedding_id ? [located.wedding_id] : [], actor: input.actor })
  await scope.assertCurrent()
  return scope
}
async function seat(client: Queryable, input: CalendarBoundsOwnerSourceInput | CalendarBoundsHolderSourceInput, s: SourceState): Promise<Seat> {
  if ('vendorId' in input) {
    await owner(client, input.vendorId, input.actor)
    if (s.material.vendorId !== input.vendorId) throw notFound('Источник календаря не найден')
    return { role: 'owner', actor: input.actor }
  }
  return holder(client, input, s)
}
async function principalCurrent(client: Queryable, sourceId: string, h: { weddingId: string; dealId: string }, party: 'customer' | 'performer', actor: OrderActor): Promise<boolean> {
  return (await client.query<{ valid: boolean }>('select legacy_calendar_bounds_principal_current($1,$2,$3,$4,$5,$6,$7) valid',
    [sourceId, h.weddingId, h.dealId, party, actor.userId, actor.sessionId, actor.policyVersion])).rows[0]?.valid === true
}
async function project(client: Queryable, s: SourceState, who: Seat, selectedVersionId: string | null = s.proposedVersionId): Promise<CalendarBoundsPrivateView> {
  const versionRows = (await client.query<VersionRow>(`select id::text,source_id::text,inventory_version_id::text,version::text,digest,source_fingerprint,
    declaration,staffing_completeness,created_at from legacy_calendar_bounds_versions v where source_id=$1
    and ($2::uuid is null or exists(select 1 from legacy_calendar_bounds_holders h where h.bounds_version_id=v.id and h.wedding_id=$2 and h.deal_id=$3))
    order by v.version desc`, [s.material.sourceId, who.weddingId ?? null, who.dealId ?? null])).rows
  const v = selectedVersionId ? versionRows.find(r => r.id === selectedVersionId) ?? null : null
  if (selectedVersionId && !v) throw notFound('Версия границ календаря не найдена')
  const history = versionRows.map(r => ({ id: r.id, version: r.version, digest: r.digest, createdAt: r.created_at.toISOString(), effective: r.id === s.effect.effectiveVersionId }))
  const view: CalendarBoundsPrivateView = { source: summary(s, v?.staffing_completeness ?? null), proposal: null, history,
    actorRole: who.role, acceptedByCaller: false, readToken: null, editor: null, receipts: [],
    readiness: { requiredReceipts: 0, acceptedReceipts: 0, canAccept: false, canActivate: false, hasStaleReceipts: false } }
  if (who.role === 'owner') {
    const labels = (await client.query<{ id: string; label: string }>('select id::text,label from slots where id=any($1::uuid[]) order by id', [s.material.holders.map(h => h.slotId)])).rows
    const people = (await client.query<{ id: string; name: string | null; available: boolean }>(`select id::text,case when deleted_at is null then name else null end name,
      deleted_at is null available from users where id=any($1::uuid[]) order by id`, [s.material.personScope.identities])).rows
    const options = (await client.query<{ deal_id: string | null; dates: string[] }>(`select d.deal_id::text,
      array(select x::text from unnest(legacy_calendar_bounds_original_day_options($1,d.deal_id)) x order by x) dates
      from (select unnest($2::uuid[]) deal_id union all select null::uuid) d`,
    [s.material.sourceId, s.material.holders.map(h => h.dealId)])).rows
    view.editor = { sourceFingerprint: s.fingerprint, inventoryVersionId: s.inventoryVersionId, originDate: s.material.originDate,
      holders: s.material.holders.map(h => ({ weddingId: h.weddingId, dealId: h.dealId, slotId: h.slotId, label: labels.find(l => l.id === h.slotId)?.label ?? '', orderVersion: h.orderVersion,
        originalDayOptions: options.find(o => o.deal_id === h.dealId)?.dates ?? [] })),
      manualOriginalDayOptions: options.find(o => o.deal_id === null)?.dates ?? [],
      knownPersons: s.material.personScope.identities.map(person => ({ id: person, name: people.find(p => p.id === person)?.name ?? null, available: people.find(p => p.id === person)?.available ?? false })),
      unknownPersonOrigins: s.material.personScope.unknownOrigins.map(o => ({ kind: o.kind, id: o.id })) }
  }
  if (!v) return view
  const allHolders = (await client.query<HolderRow>(`select id::text,wedding_id::text,deal_id::text,slot_id::text,expected_order_version::text,outcome,closure_reason
    from legacy_calendar_bounds_holders where bounds_version_id=$1 order by wedding_id,deal_id`, [v.id])).rows
  const rawReceipts = (await client.query<{ id: string; holder_id: string; party: 'customer' | 'performer'; user_id: string | null; session_id: string | null; policy_version: string; digest: string; accepted_at: Date; valid: boolean }>(`
    select r.id::text,r.holder_id::text,r.party,r.user_id::text,r.session_id::text,r.policy_version,r.digest,r.accepted_at,
      (r.policy_version=$2 and r.digest=$3 and legacy_calendar_bounds_principal_current(r.source_id,h.wedding_id,h.deal_id,r.party,r.user_id,r.session_id,$2)
        and not exists(select 1 from legacy_calendar_bounds_receipts other where other.bounds_version_id=r.bounds_version_id and other.holder_id=r.holder_id
          and other.party<>r.party and (other.user_id=r.user_id or other.session_id=r.session_id))) valid
    from legacy_calendar_bounds_receipts r join legacy_calendar_bounds_holders h on h.id=r.holder_id and h.bounds_version_id=r.bounds_version_id
    where r.bounds_version_id=$1 order by r.holder_id,r.party`, [v.id, who.actor.policyVersion, v.digest])).rows
  const isCurrent = currentProposal(s, v)
  const validReceipts = rawReceipts.filter(r => isCurrent && r.valid)
  const visible = who.role === 'owner' ? allHolders : allHolders.filter(h => h.wedding_id === who.weddingId && h.deal_id === who.dealId)
  if (who.role !== 'owner' && visible.length !== 1) throw notFound('Версия границ календаря не найдена')
  const spanRows = (await client.query<{ owner_key: string; original_date: string | null; span_mode: LegacyBoundsSpan['spanMode']; local_starts_at: string; local_ends_at: string; supplied_starts_at: string; supplied_ends_at: string; time_zone: string; starts_at: Date; ends_at: Date; coverage: LegacyBoundsSpan['coverage'] }>(`
    select owner_key::text,original_date::text,span_mode,local_starts_at,local_ends_at,supplied_starts_at,supplied_ends_at,time_zone,starts_at,ends_at,coverage
    from legacy_calendar_bounds_spans where bounds_version_id=$1 and owner_key=any($2::uuid[]) order by owner_key,span_index`,
  [v.id, who.role === 'owner' ? [...visible.map(h => h.id), v.id] : visible.map(h => h.id)])).rows
  const spansFor = (ownerKey: string): CalendarBoundsSpanView[] => spanRows.filter(r => r.owner_key === ownerKey).map(r => ({
    spanMode: r.span_mode, localStartsAt: r.local_starts_at, localEndsAt: r.local_ends_at, startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString(),
    suppliedStartsAt: r.supplied_starts_at, suppliedEndsAt: r.supplied_ends_at, timeZone: r.time_zone, coverage: { ...r.coverage }, originalDate: r.original_date }))
  const labels = (await client.query<{ id: string; label: string }>('select id::text,label from slots where id=any($1::uuid[])', [visible.map(h => h.slot_id)])).rows
  const holderViews = visible.map(h => ({ id: h.id, weddingId: h.wedding_id, dealId: h.deal_id, slotId: h.slot_id, label: labels.find(l => l.id === h.slot_id)?.label ?? '',
    expectedOrderVersion: h.expected_order_version, outcome: h.outcome, closureReason: h.closure_reason, spans: spansFor(h.id),
    accepted: { customer: validReceipts.some(r => r.holder_id === h.id && r.party === 'customer'), performer: validReceipts.some(r => r.holder_id === h.id && r.party === 'performer') } }))
  view.proposal = { id: v.id, version: v.version, digest: v.digest, sourceFingerprint: v.source_fingerprint, inventoryVersionId: v.inventory_version_id,
    holders: who.role === 'owner' ? holderViews : null, ownHolder: who.role === 'owner' ? null : holderViews[0]!,
    manualBounds: who.role === 'owner' && v.declaration.manualBounds ? { outcome: v.declaration.manualBounds.outcome, closureReason: v.declaration.manualBounds.closureReason, spans: spansFor(v.id) } : null,
    staffing: { completeness: v.staffing_completeness, personIds: who.role === 'owner' ? [...v.declaration.staffing.personIds] : null }, createdAt: v.created_at.toISOString() }
  const ownHolder = who.role === 'owner' ? null : visible[0]!
  const ownReceipt = ownHolder ? rawReceipts.find(r => r.holder_id === ownHolder.id && r.party === who.role) : undefined
  view.acceptedByCaller = !!ownReceipt && isCurrent && ownReceipt.valid && ownReceipt.user_id === who.actor.userId
  view.receipts = rawReceipts.filter(r => ownHolder ? r.holder_id === ownHolder.id : r.user_id === who.actor.userId).map(r => ({
    id: r.id, party: r.party, userId: r.user_id, sessionId: r.session_id, digest: r.digest, acceptedAt: r.accepted_at.toISOString() }))
  const complete = (await client.query<{ complete: boolean }>('select legacy_calendar_bounds_complete($1) complete', [v.id])).rows[0]?.complete === true
  const actorCurrent = who.role === 'owner' || (ownHolder && await principalCurrent(client, s.material.sourceId,
    { weddingId: ownHolder.wedding_id, dealId: ownHolder.deal_id }, who.role, who.actor))
  const agreed = isCurrent && complete && (await client.query<{ agreed: boolean }>('select legacy_calendar_bounds_agreed($1,$2) agreed', [v.id, who.actor.policyVersion])).rows[0]?.agreed === true
  view.readiness = { requiredReceipts: allHolders.length * 2, acceptedReceipts: validReceipts.length,
    canAccept: !!ownHolder && !!actorCurrent && isCurrent && complete && !ownReceipt,
    canActivate: !!actorCurrent && !!agreed, hasStaleReceipts: rawReceipts.length !== validReceipts.length }
  return view
}

export async function loadLegacyCalendarSources(client: Queryable, input: CalendarBoundsOwnerInput): Promise<CalendarBoundsSourceList> {
  const value = record(input, ['vendorId', 'actor']), vendorId = id(value.vendorId), actor = actorOf(value.actor)
  const inventory = await loadLegacyCalendarInventory(client, { vendorId, actor })
  if (inventory.sources.length > 128) incomplete()
  const sources: CalendarSourceSummary[] = []
  for (const source of inventory.sources) {
    const s = await state(client, source.sourceId)
    const v = s.proposedVersionId ? await version(client, s.material.sourceId, s.proposedVersionId) : null
    sources.push(summary(s, v?.staffing_completeness ?? null))
  }
  return { vendorId, sources }
}
export async function loadLegacyCalendarEditor(client: Queryable, input: CalendarBoundsOwnerSourceInput): Promise<CalendarBoundsPrivateView> {
  const i = ownerInput(input)
  await owner(client, i.vendorId, i.actor)
  await locateSource(client, i)
  return project(client, await state(client, i.sourceId), { role: 'owner', actor: i.actor })
}
/** Preliminary read relation only; current principal and all old locked checks follow. */
async function assertReadRelation(client: Queryable, input: CalendarBoundsHolderScopeInput): Promise<void> {
  const allowed = await client.query(`select d.id from deals d
    join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
    join weddings w on w.id=d.wedding_id
    where d.wedding_id=$1 and d.id=$2 and w.archived_at is null and w.cancelled_at is null
      and (exists(select 1 from wedding_members m where m.wedding_id=d.wedding_id and m.user_id=$3 and m.role='couple')
        or exists(select 1 from vendors v join users u on u.id=v.user_id
          where v.id=d.vendor_id and v.user_id=$3 and u.deleted_at is null and v.blocked_at is null))`,
  [input.weddingId, input.dealId, input.actor.userId])
  if (!allowed.rowCount) throw notFound('Заказ не найден')
}

export async function loadOwnLegacyCalendarSources(client: Queryable, input: CalendarBoundsHolderScopeInput): Promise<OwnCalendarBoundsSourceList> {
  const v = record(input, ['weddingId', 'dealId', 'actor']), weddingId = id(v.weddingId), dealId = id(v.dealId), actor = actorOf(v.actor)
  await assertReadRelation(client, { weddingId, dealId, actor })
  const context = await lockOrderReadContext(client, weddingId, dealId, actor)
  if (!context.vendorId) return { weddingId, dealId, sources: [] }
  const rows = (await client.query<{ id: string }>(`select s.id::text from legacy_calendar_sources s where s.vendor_id=$1 and s.wedding_id=$2
    and (s.root_deal_id=$3 or exists(select 1 from legacy_calendar_bounds_holders h where h.source_id=s.id and h.wedding_id=$2 and h.deal_id=$3)
      or exists(select 1 from jsonb_array_elements(legacy_calendar_bounds_source_material(s.id)->'holders') h where h->>'weddingId'=$2::uuid::text and h->>'dealId'=$3::uuid::text))
    order by s.id limit 129`, [context.vendorId, weddingId, dealId])).rows
  if (rows.length > 128) incomplete()
  const sources: CalendarSourceSummary[] = []
  for (const r of rows) { const s = await state(client, r.id); const p = s.proposedVersionId ? await version(client, r.id, s.proposedVersionId) : null; sources.push(summary(s, p?.staffing_completeness ?? null)) }
  return { weddingId, dealId, sources }
}
export async function captureLegacyCalendarBoundsInventory(client: Queryable,
  input: CalendarBoundsOwnerSourceInput & { expectedSourceRevision: string; expectedInventoryRevision: string }): Promise<CalendarBoundsPrivateView> {
  const i = ownerInput(input, ['expectedSourceRevision', 'expectedInventoryRevision'])
  const expectedSourceRevision = revision(i.expectedSourceRevision), expectedInventoryRevision = revision(i.expectedInventoryRevision)
  const scope = await prepare(client, i)
  await owner(client, i.vendorId, i.actor)
  await captureLegacyCalendarSource(client, { vendorId: i.vendorId, sourceId: i.sourceId, actor: i.actor, expectedSourceRevision, expectedInventoryRevision })
  await scope.assertCurrent()
  return project(client, await state(client, i.sourceId), { role: 'owner', actor: i.actor })
}
async function appendSpans(client: Queryable, sourceId: string, versionId: string, holderId: string | null, spans: LegacyBoundsSpan[]): Promise<void> {
  for (const [index, span] of spans.entries()) {
    const originalRow = (await client.query<{ date: string | null }>('select legacy_calendar_bounds_span_original_date($1,$2,$3::jsonb)::text date',
      [sourceId, holderId, JSON.stringify(span)])).rows[0]
    if (!originalRow) incomplete()
    const original = originalRow.date
    if (span.spanMode === 'whole_local_day' && original === null) incomplete()
    await client.query(`insert into legacy_calendar_bounds_spans(bounds_version_id,owner_key,span_index,holder_id,owner_kind,original_date,
      span_mode,local_starts_at,local_ends_at,supplied_starts_at,supplied_ends_at,time_zone,starts_at,ends_at,coverage)
      values($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13::timestamptz,$14::timestamptz,$15::jsonb)`,
    [versionId, holderId ?? versionId, index, holderId, holderId ? 'holder' : 'manual', original, span.spanMode,
      span.localStartsAt, span.localEndsAt, span.suppliedStartsAt, span.suppliedEndsAt, span.timeZone, span.startsAt, span.endsAt, JSON.stringify(span.coverage)])
  }
}
async function audit(client: Queryable, actor: OrderActor, action: string, sourceId: string, detail: Record<string, unknown>): Promise<void> {
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'legacy_calendar_source',$3,$4::jsonb)",
    [actor.userId, action, sourceId, JSON.stringify(detail)])
}

export async function proposeLegacyCalendarBounds(client: Queryable,
  input: CalendarBoundsOwnerSourceInput & CalendarBoundsProposalBody): Promise<CalendarBoundsPrivateView> {
  const i = ownerInput(input, proposalKeys), declaration = declarationOf(i)
  const expectedSource = revision(i.expectedSourceRevision), expectedInventory = revision(i.expectedInventoryRevision)
  const expectedHead = revision(i.expectedHeadRevision), expectedFingerprint = digest(i.expectedSourceFingerprint)
  const scope = await prepare(client, i)
  await owner(client, i.vendorId, i.actor)
  const s = await state(client, i.sourceId)
  if (s.material.vendorId !== i.vendorId) throw notFound('Источник календаря не найден')
  if (s.material.sourceRevision !== expectedSource || s.inventoryRevision !== expectedInventory || s.headRevision !== expectedHead || s.fingerprint !== expectedFingerprint) changed()
  if (!s.inventoryVersionId || !s.inventoryDigest || !s.inventoryCurrent) throw conflict('legacy_inventory_version_conflict', 'Сначала сохраните текущий состав источника')
  if (s.material.scopeCompleteness !== 'complete' || s.material.unavailableReason !== null || s.material.kind === 'orphan_day') incomplete()
  if (declaration.holders.length !== s.material.holders.length || declaration.holders.some(h => !s.material.holders.some(m => m.weddingId === h.weddingId && m.dealId === h.dealId))) invalid('holders')
  if (declaration.holders.some(h => !s.material.holders.some(m => m.weddingId === h.weddingId && m.dealId === h.dealId && m.orderVersion === h.expectedOrderVersion))) changed()
  if (s.material.kind === 'manual_day' ? declaration.holders.length !== 0 || declaration.manualBounds === null : declaration.manualBounds !== null) invalid('manualBounds')
  const material = (await client.query<{ canonical: string; digest: string; material: { sourceFingerprint: string; declaration: Declaration } }>(`
    select m::text canonical,legacy_calendar_bounds_fingerprint(m) digest,m material
    from (select legacy_calendar_bounds_material($1,$2,$3::jsonb) m) x`, [i.sourceId, s.inventoryVersionId, JSON.stringify(declaration)])).rows[0]
  if (!material?.material || material.material.sourceFingerprint !== s.fingerprint) changed()
  const context = (await client.query<{ material: SourceMaterial['personScope']; fingerprint: string }>(`
    select m material,legacy_calendar_bounds_fingerprint(m) fingerprint from (select legacy_calendar_bounds_known_person_scope($1) m) x`, [i.vendorId])).rows[0]
  if (!context) incomplete()
  if (declaration.staffing.personIds.some(person => !context.material.identities.includes(person))) invalid('personIds')
  await scope.assertCurrent()
  const versionId = uuidv7(), nextVersion = (BigInt(s.proposedVersion) + 1n).toString()
  revision(nextVersion, false)
  await client.query(`insert into legacy_calendar_bounds_heads(source_id,revision,proposed_version,proposed_version_id,effective_event_id,updated_at)
    values($1,0,0,null,null,clock_timestamp()) on conflict(source_id) do nothing`, [i.sourceId])
  await client.query(`insert into legacy_calendar_bounds_versions(id,source_id,inventory_version_id,version,previous_version_id,wedding_id,company_id,
    source_revision,inventory_revision,inventory_digest,source_fingerprint,declaration,canonical,digest,staffing_completeness,association_fingerprint,
    created_by,created_session_id,policy_version,created_at)
    values($1,$2,$3,$4::bigint,$5,$6,$7,$8::bigint,$9::bigint,$10,$11,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,clock_timestamp())`,
  [versionId, i.sourceId, s.inventoryVersionId, nextVersion, s.proposedVersionId, s.material.weddingId, s.material.companyId,
    s.material.sourceRevision, s.inventoryRevision, s.inventoryDigest, s.fingerprint, JSON.stringify(declaration), material.canonical, material.digest,
    declaration.staffing.completeness, context.fingerprint, i.actor.userId, i.actor.sessionId, i.actor.policyVersion])
  for (const h of declaration.holders) {
    const m = s.material.holders.find(current => current.weddingId === h.weddingId && current.dealId === h.dealId)!
    const holderId = uuidv7()
    const inserted = await client.query(`insert into legacy_calendar_bounds_holders(id,source_id,bounds_version_id,inventory_version_id,wedding_id,deal_id,
      slot_id,expected_order_version,day_version_id,outcome,closure_reason,holder_snapshot,holder_fingerprint)
      select $1,$2,$3,$4,i.wedding_id,i.deal_id,$7,$8::bigint,(i.snapshot#>>'{dayScope,version,id}')::uuid,$9,$10,i.snapshot,$11
      from legacy_calendar_version_holders i where i.version_id=$4 and i.wedding_id=$5 and i.deal_id=$6 and i.snapshot=$12::jsonb`,
    [holderId, i.sourceId, versionId, s.inventoryVersionId, h.weddingId, h.dealId, m.slotId, h.expectedOrderVersion,
      h.outcome, h.closureReason, m.holderFingerprint, JSON.stringify(m.holderSnapshot)])
    if (inserted.rowCount !== 1) changed()
    await appendSpans(client, i.sourceId, versionId, holderId, h.spans)
  }
  if (declaration.manualBounds) await appendSpans(client, i.sourceId, versionId, null, declaration.manualBounds.spans)
  for (const personId of declaration.staffing.personIds) await client.query(`insert into legacy_calendar_bounds_person_scope(bounds_version_id,person_identity,context_material)
    values($1,$2,$3::jsonb)`, [versionId, personId, JSON.stringify(context.material)])
  const published = await client.query(`update legacy_calendar_bounds_heads set revision=revision+1,proposed_version=proposed_version+1,
    proposed_version_id=$3,updated_at=clock_timestamp() where source_id=$1 and revision=$2::bigint and proposed_version=$4::bigint
    and proposed_version_id is not distinct from $5::uuid`, [i.sourceId, expectedHead, versionId, s.proposedVersion, s.proposedVersionId])
  if (published.rowCount !== 1) changed()
  await audit(client, i.actor, 'legacy_calendar.bounds_proposed', i.sourceId, { versionId, version: nextVersion, digest: material.digest })
  await scope.assertCurrent()
  return project(client, await state(client, i.sourceId), { role: 'owner', actor: i.actor })
}

export async function readLegacyCalendarBounds(client: Queryable,
  input: CalendarBoundsHolderSourceInput & { boundsVersionId?: string }, proof: CalendarBoundsProofOptions): Promise<CalendarBoundsPrivateView> {
  const data = record(input), historical = Object.hasOwn(data, 'boundsVersionId')
  const i = holderInput(input, historical ? ['boundsVersionId'] : [])
  await assertReadRelation(client, i)
  const context = await lockOrderReadContext(client, i.weddingId, i.dealId, i.actor)
  await locateSource(client, i)
  const s = await state(client, i.sourceId), who = await holder(client, i, s, context)
  const view = await project(client, s, who, historical ? id(i.boundsVersionId) : s.proposedVersionId)
  if (historical) { view.readiness.canAccept = false; view.readiness.canActivate = false }
  if (!historical && view.proposal && currentProposal(s, await version(client, i.sourceId, view.proposal.id))) {
    const valid = await principalCurrent(client, i.sourceId, i, who.role === 'customer' ? 'customer' : 'performer', i.actor)
    const complete = (await client.query<{ complete: boolean }>('select legacy_calendar_bounds_complete($1) complete', [view.proposal.id])).rows[0]?.complete === true
    if (valid && complete) {
      const fresh = await state(client, i.sourceId)
      if (!currentProposal(fresh, await version(client, i.sourceId, view.proposal.id))) return project(client, fresh, who)
      assertCalendarBoundsProofAvailable(proof)
      view.readToken = await signCalendarBoundsRead(proof.secret, { purpose: 'calendar-bounds-read', sourceId: i.sourceId,
        inventoryVersionId: view.proposal.inventoryVersionId, boundsVersionId: view.proposal.id, version: view.proposal.version,
        digest: view.proposal.digest, weddingId: i.weddingId, dealId: i.dealId, userId: i.actor.userId,
        sessionId: i.actor.sessionId, policyVersion: i.actor.policyVersion }, await dbNow(client))
    }
  }
  return view
}

export async function acceptLegacyCalendarBounds(client: Queryable,
  input: CalendarBoundsHolderSourceInput & CalendarBoundsAcceptBody, proof: CalendarBoundsProofOptions): Promise<CalendarBoundsPrivateView> {
  const i = holderInput(input, ['boundsVersionId', 'expectedVersion', 'digest', 'readToken'])
  const boundsVersionId = id(i.boundsVersionId), expectedVersion = revision(i.expectedVersion, false), expectedDigest = digest(i.digest)
  if (typeof i.readToken !== 'string') invalid('readToken')
  assertCalendarBoundsProofAvailable(proof)
  const scope = await prepare(client, i)
  const s = await state(client, i.sourceId), who = await holder(client, i, s), v = await version(client, i.sourceId, boundsVersionId)
  if (!currentProposal(s, v) || v.version !== expectedVersion || v.digest !== expectedDigest) changed()
  const party = who.role === 'customer' ? 'customer' : 'performer'
  if (!await principalCurrent(client, i.sourceId, i, party, i.actor)) changed()
  const h = (await client.query<{ id: string }>('select id::text from legacy_calendar_bounds_holders where source_id=$1 and bounds_version_id=$2 and wedding_id=$3 and deal_id=$4',
    [i.sourceId, boundsVersionId, i.weddingId, i.dealId])).rows[0]
  if (!h) throw notFound('Источник календаря не найден')
  const claims = await verifyCalendarBoundsRead(proof.secret, i.readToken, await dbNow(client))
  if (claims.sourceId !== i.sourceId || claims.inventoryVersionId !== v.inventory_version_id || claims.boundsVersionId !== v.id ||
    claims.version !== v.version || claims.digest !== v.digest || claims.weddingId !== i.weddingId || claims.dealId !== i.dealId ||
    claims.userId !== i.actor.userId || claims.sessionId !== i.actor.sessionId || claims.policyVersion !== i.actor.policyVersion) invalid('readToken')
  const existing = (await client.query<{ user_id: string | null; session_id: string | null; policy_version: string; digest: string }>(`select user_id::text,session_id::text,policy_version,digest
    from legacy_calendar_bounds_receipts where bounds_version_id=$1 and holder_id=$2 and party=$3 for update`, [v.id, h.id, party])).rows[0]
  if (existing) {
    if (existing.user_id !== i.actor.userId || existing.session_id !== i.actor.sessionId || existing.policy_version !== i.actor.policyVersion || existing.digest !== v.digest) {
      throw conflict('legacy_calendar_receipt_conflict', 'Прежнее подтверждение не действует — нужно новое предложение')
    }
  } else {
    const receiptId = uuidv7()
    await client.query(`insert into legacy_calendar_bounds_receipts(id,source_id,bounds_version_id,holder_id,party,user_id,session_id,policy_version,purpose,digest,read_claims,proof_hash,read_iat,read_exp,accepted_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,'calendar-bounds-read',$9,$10::jsonb,$11,$12::bigint,$13::bigint,clock_timestamp())`,
    [receiptId, i.sourceId, v.id, h.id, party, i.actor.userId, i.actor.sessionId, i.actor.policyVersion, v.digest, JSON.stringify(claims),
      createHash('sha256').update(i.readToken, 'utf8').digest('hex'), claims.iat, claims.exp])
    await audit(client, i.actor, 'legacy_calendar.bounds_accepted', i.sourceId, { boundsVersionId: v.id, holderId: h.id, receiptId, party, digest: v.digest })
  }
  await scope.assertCurrent()
  return project(client, await state(client, i.sourceId), who)
}

export async function activateLegacyCalendarBounds(client: Queryable, input: CalendarBoundsActivationInput): Promise<CalendarBoundsPrivateView> {
  const raw = record(input), i = Object.hasOwn(raw, 'vendorId') ? ownerInput(input, activateKeys) : holderInput(input, activateKeys)
  const boundsVersionId = id(i.boundsVersionId), expectedHead = revision(i.expectedHeadRevision), expectedFingerprint = digest(i.expectedSourceFingerprint), expectedDigest = digest(i.digest)
  const scope = await prepare(client, i), s = await state(client, i.sourceId), who = await seat(client, i, s)
  const v = await version(client, i.sourceId, boundsVersionId)
  if (s.headRevision !== expectedHead || s.fingerprint !== expectedFingerprint || v.digest !== expectedDigest || !currentProposal(s, v)) changed()
  const principals = (await client.query<{ user_id: string | null; session_id: string | null }>(`select distinct user_id::text,session_id::text
    from legacy_calendar_bounds_receipts where bounds_version_id=$1 order by user_id,session_id`, [v.id])).rows
  for (const p of principals) {
    if (!p.user_id || !p.session_id) throw conflict('legacy_calendar_bounds_not_agreed', 'Нужно действующее подтверждение каждой стороны каждого обязательства')
    await lockOrderPrincipal(client, { userId: p.user_id, sessionId: p.session_id, policyVersion: i.actor.policyVersion })
  }
  if (!(await client.query<{ agreed: boolean }>('select legacy_calendar_bounds_agreed($1,$2) agreed', [v.id, i.actor.policyVersion])).rows[0]?.agreed) {
    throw conflict('legacy_calendar_bounds_not_agreed', 'Нужно действующее подтверждение каждой стороны каждого обязательства')
  }
  await scope.assertCurrent()
  const effect = (await client.query<{ id: string }>('select legacy_calendar_bounds_activate($1,$2,$3,$4)::text id',
    [v.id, i.actor.userId, i.actor.sessionId, i.actor.policyVersion])).rows[0]
  if (!effect?.id) incomplete()
  if (effect.id !== s.effectiveEventId) await audit(client, i.actor, 'legacy_calendar.bounds_activated', i.sourceId, { boundsVersionId: v.id, effectId: effect.id, digest: v.digest })
  await scope.assertCurrent()
  return project(client, await state(client, i.sourceId), who)
}

function utc(value: unknown): string {
  if (typeof value !== 'string') invalid('period')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value)
  if (!match || match[0] !== value) invalid('period')
  const canonical = match[1] + '.' + (match[2] ?? '').padEnd(3, '0') + 'Z', date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical || date.getUTCFullYear() < 1) invalid('period')
  return canonical
}
export async function loadPublicLegacyCalendarOccupancy(client: Queryable,
  input: { vendorId: string; from: string; to: string; actor: OrderActor }): Promise<PublicLegacyCalendarOccupancy> {
  const i = record(input, ['vendorId', 'from', 'to', 'actor']), vendorId = id(i.vendorId), actor = actorOf(i.actor), from = utc(i.from), to = utc(i.to)
  if (Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 370 * 86_400_000) invalid('period')
  await lockOrderPrincipal(client, actor)
  await assertVendorLive(client, vendorId)
  const sources = (await client.query<{ effect: SourceState['effect']; updated_at: Date | null }>(`
    select legacy_calendar_bounds_current_effect(s.id) effect,h.updated_at from legacy_calendar_sources s
    left join legacy_calendar_bounds_heads h on h.source_id=s.id where s.vendor_id=$1 and legacy_calendar_present(s) order by s.id limit 129`, [vendorId])).rows
  if (sources.length > 128) incomplete()
  const periods = (await client.query<{ starts_at: Date; ends_at: Date; time_zone: string | null }>(`
    select distinct starts_at,ends_at,time_zone from (
      select o.occupied_starts_at starts_at,o.occupied_ends_at ends_at,
        case when c.id is null then null else (select line->>'timeZone' from jsonb_array_elements(c.canonical::jsonb->'lines') line
          where (line->>'lineIndex')::integer=o.origin_line_index limit 1) end time_zone
      from resource_occupancy o left join resource_occupancy_origin_certificates c on c.id=o.certificate_id
      where o.released_at is null and o.vendor_identity=$1
      union all select w.starts_at,w.ends_at,null::text from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id
        where r.vendor_id=$1 and w.legacy_used>0
    ) periods where tstzrange(starts_at,ends_at,'[)') && tstzrange($2::timestamptz,$3::timestamptz,'[)')
    order by starts_at,ends_at,time_zone`, [vendorId, from, to])).rows
  const unknown = sources.some(s => !s.effect || s.effect.state === 'unresolved' || s.effect.freshness !== 'current')
  const unavailable = sources.some(s => !s.effect || s.effect.freshness === 'unavailable')
  const stale = sources.some(s => s.effect?.freshness === 'stale')
  const dates = sources.flatMap(s => s.updated_at ? [s.updated_at.getTime()] : [])
  return { state: unknown ? 'unknown' : periods.length ? 'busy' : 'none',
    occupiedPeriods: periods.map(p => ({ startsAt: p.starts_at.toISOString(), endsAt: p.ends_at.toISOString(), timeZone: p.time_zone })),
    freshness: unavailable ? 'unavailable' : stale ? 'stale' : 'current', updatedAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null }
}
