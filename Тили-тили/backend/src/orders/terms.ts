import type { OfferComparisonTerms } from '../offers/comparison-terms.js'
import { createHash } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { validateBrief } from './catalog.js'
import { lockOrderContext, lockOrderPrincipal, type OrderContext } from './context.js'
import { deliveryAvailable, deliveryHead } from './delivery.js'
import { boundedText, checkEntityId, checkVersion, objectValues, readOrder, validatePartDetails, type OrderInput } from './model.js'
import { assertTermsProofAvailable, signOrderTermsRead, verifyOrderTermsRead,
  signLegacyAdoptionTermsRead, verifyLegacyAdoptionTermsRead,
  type TermsProofOptions, type TermsReadClaims, type LegacyAdoptionReadClaims } from './terms-token.js'
import { readResourcePlanSource } from './resource-plan.js'
import { amendmentPrices, applyOrderPriceAmendment, loadOrderPriceBreakdown, orderCanAmendPrice, priceAmendmentOf,
  type OrderPriceAmendment } from './price-amendment.js'
import { previewOfferPriceChange } from '../offers/price-breakdown.js'
import type { components } from '../contract/api.generated.js'

export type TermsParty = 'customer' | 'performer'
export interface TermsReceiptDto { id: string; party: TermsParty; userId: string | null; sessionId: string | null; digest: string; acceptedAt: string }
export interface PublishedTermsDto { id: string; version: string; sourceOrderVersion: string; sourceFingerprint: string;
  digest: string; snapshot: Record<string, unknown>; publishedBy: string | null; publishedSide: TermsParty;
  publishedAt: string; freshness: 'current' | 'stale' | 'unavailable' | 'invalid'; receipts: TermsReceiptDto[]; acceptedByCaller: boolean }
export interface TermsView { revision: string; proposedTermsId: string | null; agreedTermsId: string | null;
  history: PublishedTermsDto[]; selected: PublishedTermsDto | null; readToken: string | null; acceptedByCaller: boolean }
interface TermsHead { version: string; terms_revision: string; proposed_terms_id: string | null; agreed_terms_id: string | null }
interface SourceState { snapshot: Record<string, unknown>; canonical: string; fingerprint: string; performerAvailable: boolean; resourcePlanId: string | null }
/** Stable object keys, explicit array order and nulls. No caller-supplied digest. */
export function canonicalTermsJson(value: unknown): string {
  const ancestors = new Set<object>()
  const invalid = () => validationFailed({ source: 'Недопустимое значение в источнике условий' })
  function encode(current: unknown, depth: number): string {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number' && Number.isFinite(current)) return JSON.stringify(current)
    if (!current || typeof current !== 'object' || depth > 50 || ancestors.has(current)) throw invalid()
    ancestors.add(current)
    try {
      if (Array.isArray(current)) {
        const items: string[] = []
        for (let i = 0; i < current.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(current, i)
          if (!descriptor || !('value' in descriptor)) throw invalid()
          items.push(encode(descriptor.value, depth + 1))
        }
        return '[' + items.join(',') + ']'
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(current) as object | null) || Object.getOwnPropertySymbols(current).length) throw invalid()
      return '{' + Object.keys(current).sort().map(k => {
        const descriptor = Object.getOwnPropertyDescriptor(current, k)!
        if (!('value' in descriptor)) throw invalid()
        return JSON.stringify(k) + ':' + encode(descriptor.value, depth + 1)
      }).join(',') + '}'
    } finally { ancestors.delete(current) }
  }
  return encode(value, 0)
}
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const economicsOf = (source: SourceState) => source.snapshot.economics as { amount: string | null; currency: string }
function withPrice(source: SourceState, amount: number, amendment?: OrderPriceAmendment): SourceState {
  const snapshot = { ...source.snapshot, economics: { ...economicsOf(source), amount: String(amount), amountKnown: true },
    ...(amendment && { priceAmendment: amendment }) }
  const canonical = canonicalTermsJson(snapshot)
  return { ...source, snapshot, canonical, fingerprint: hash(canonical) }
}

function priceAmendmentChanged(): never {
  throw conflict('price_amendment_source_changed', 'Исходные условия или участники изменились — обновите заказ')
}

async function currentVendorOwner(client: Queryable, context: OrderContext): Promise<string | null> {
  if (context.vendorId === null) return null
  // actualSource already pins the current company/account before this projection.
  return (await client.query<{ user_id: string }>('select user_id from vendors where id=$1 for share', [context.vendorId])).rows[0]?.user_id ?? null
}
const party = (context: OrderContext, ownerId: string | null, actorId: string): TermsParty =>
  ownerId === actorId.toLowerCase() || context.actorRole === 'vendor' ? 'performer' : 'customer'
async function lockHead(client: Queryable, input: OrderInput, write: boolean) {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor, write)
  const head = await client.query<TermsHead>(`select version::text,terms_revision::text,proposed_terms_id,agreed_terms_id from deal_orders
    where wedding_id=$1 and deal_id=$2 for ${write ? 'update' : 'share'}`, [input.weddingId, input.dealId])
  if (!head.rows[0]) throw notFound('Источник заказа не найден')
  return { context, head: head.rows[0] }
}
async function actualSource(client: Queryable, input: OrderInput, context: OrderContext, adoption?: LegacyAdoptionPins): Promise<SourceState> {
  const order = await readOrder(client, input)
  if (order.brief) {
    if (order.brief.categoryId !== context.categoryId) throw validationFailed({ brief: 'Категория брифа отличается от заказа' })
    const errors = validateBrief(context.categoryId, order.brief.values, order.brief.subtypeId)
    if (errors.length) throw validationFailed(Object.fromEntries(errors.map(e => [`brief.${e.field}`, e.code])))
  }
  const activeAssignments = order.assignments.filter(a => a.cancelledAt === null).sort((a, b) => a.id.localeCompare(b.id))
  const positions = await client.query<{ id: string; category_id: string; program_event_id: string | null; deal_id: string | null }>(
    'select id,category_id,program_event_id,deal_id from slots where wedding_id=$1 and id=any($2::uuid[]) order by id for share', [input.weddingId, activeAssignments.map(a => a.slotId)])
  const events = await client.query<{ id: string; name: string; kind: string; date: string | null; time_zone: string | null; location: string | null; is_main: boolean }>(
    'select id,name,kind,date::text,time_zone,location,is_main from wedding_events where wedding_id=$1 and (id=any($2::uuid[]) or is_main) order by id for share', [input.weddingId, activeAssignments.map(a => a.programEventId)])
  const assignments = activeAssignments.map(a => {
    boundedText(a.label, 'assignment.label')
    const position = positions.rows.find(s => s.id === a.slotId), event = events.rows.find(e => e.id === a.programEventId)
    if (!position || !event || position.category_id !== context.categoryId ||
      (position.deal_id !== null && position.deal_id !== input.dealId.toLowerCase()) ||
      (position.program_event_id !== null && position.program_event_id !== a.programEventId) ||
      (position.id !== context.slotId && (position.program_event_id === null || position.deal_id !== null))) throw validationFailed({ assignments: 'Назначение больше не соответствует позиции или мероприятию' })
    return { id: a.id, slotId: a.slotId, version: a.version, source: a.source, label: a.label,
      event: { id: event.id, name: event.name, kind: event.kind, date: event.date, timeZone: event.time_zone, location: event.location } }
  })
  const parts = order.parts.filter(p => p.cancelledAt === null).sort((a, b) => a.id.localeCompare(b.id)).map(p => {
    boundedText(p.title, 'part.title')
    if ((p.kind !== 'deliverable' && p.assignmentId === null) || (p.assignmentId !== null && !assignments.some(a => a.id === p.assignmentId))) throw validationFailed({ parts: 'Часть ссылается на недействующее назначение' })
    return { id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignmentId, details: validatePartDetails(p.kind, p.details) }
  })
  const economics = await client.query<{ price: string | null; currency: string; package_id: string | null; package_title_snapshot: string | null; package_includes_snapshot: unknown; offer_comparison_terms_snapshot: OfferComparisonTerms | null;
    external_name: string | null; external_phone: string | null }>('select price::text,currency,package_id,package_title_snapshot,package_includes_snapshot,offer_comparison_terms_snapshot,external_name,external_phone from deals where wedding_id=$1 and id=$2', [input.weddingId, input.dealId])
  const economic = economics.rows[0]; if (!economic) throw notFound('Источник заказа не найден')
  let vendor: { id: string; userId: string; name: string; categoryId: string } | null = null, performerAvailable = true
  if (context.vendorId) {
    const located = await client.query<{ user_id: string }>('select user_id from vendors where id=$1', [context.vendorId])
    if (!located.rows[0]) throw notFound('Исполнитель заказа не найден')
    // Lock account before vendor to avoid reversing account-deletion lock order.
    const account = await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1 for share', [located.rows[0].user_id])
    const current = await client.query<{ id: string; user_id: string; name: string; category_id: string; blocked_at: Date | null }>('select id,user_id,name,category_id,blocked_at from vendors where id=$1 for share', [context.vendorId])
    const v = current.rows[0]
    if (!v || v.user_id !== located.rows[0].user_id) throw conflict('terms_source_changed', 'Исполнитель изменился — обновите заказ')
    performerAvailable = !!account.rows[0] && account.rows[0].deleted_at === null && v.blocked_at === null
    vendor = { id: v.id, userId: v.user_id, name: v.name, categoryId: v.category_id }
  }
  const main = events.rows.find(e => e.is_main)
  const resourcePlan = await readResourcePlanSource(client, { weddingId: input.weddingId, dealId: input.dealId, vendorId: context.vendorId })
  if (resourcePlan.source === 'invalid') throw validationFailed({ resourcePlan: 'Источники плана ресурсов изменились — проверьте и сохраните новую редакцию плана' })
  performerAvailable = performerAvailable && resourcePlan.source !== 'unavailable'
  const snapshot: Record<string, unknown> = { schemaVersion: resourcePlan.plan === null ? 1 : 2, weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(),
    source: order.source, categoryId: context.categoryId, sourceOrderVersion: order.version,
    legacyContext: { mainEvent: main ? { id: main.id, name: main.name, date: main.date, timeZone: main.time_zone, location: main.location } : null },
    brief: order.brief, assignments, parts, ...(resourcePlan.plan === null ? {} : { resourcePlan: resourcePlan.plan }),
    economics: { amount: economic.price, amountKnown: economic.price !== null, currency: economic.currency,
      performer: { vendor, externalName: economic.external_name, externalPhone: economic.external_phone },
      package: { id: economic.package_id, titleSnapshot: economic.package_title_snapshot, includesSnapshot: economic.package_includes_snapshot,
        ...(economic.offer_comparison_terms_snapshot == null ? {} : { comparisonTerms: economic.offer_comparison_terms_snapshot }) } } }
  if (adoption !== undefined) {
    // Schema3 exists only as a server-built adoption draft on an actual current plan.
    if (resourcePlan.plan === null) throw conflict('resource_plan_changed', 'Для принятия нужен действующий согласованный план ресурсов')
    snapshot.schemaVersion = 3
    snapshot.legacyTransition = await materializeLegacyAdoption(client, input, context, adoption)
  }
  const canonical = canonicalTermsJson(snapshot)
  return { snapshot, canonical, fingerprint: hash(canonical), performerAvailable, resourcePlanId: resourcePlan.plan?.planRevisionId ?? null }
}

/** Caller pins selecting the adoption draft; expected* preconditions apply only
 * when supplied (publish). Re-materialization for read/accept/verify derives the
 * pins from the stored server-built snapshot and compares the full canonical. */
export interface LegacyAdoptionPins { sourceId: string; sourceVersionId: string; effectiveBoundsVersionId: string }
export interface PublishAdoptionInput extends LegacyAdoptionPins { expectedSourceFingerprint: string; expectedSourceHeadRevision: string }
export interface AdoptionTransition extends LegacyAdoptionPins { sourceFingerprint: string; effectiveBoundsDigest: string }
const ADOPTION_DISPOSITION = 'replace_this_holder_company_barrier_with_this_resource_plan'
function boundsChanged(): never { throw conflict('legacy_calendar_bounds_changed', 'Границы или состав источника изменились — обновите данные') }

/** Server-built legacyTransition material from current locked rows. Every value
 * comes from the bounds evidence itself; nothing is trusted from the caller
 * beyond the selecting pins, which are compared against the actual rows. */
async function materializeLegacyAdoption(client: Queryable, input: OrderInput, context: OrderContext,
  pins: LegacyAdoptionPins & { expectedSourceFingerprint?: string; expectedSourceHeadRevision?: string }): Promise<Record<string, unknown>> {
  if (!context.vendorId) throw conflict('resource_vendor_required', 'Для принятия нужен действующий исполнитель')
  if (!['booked', 'paid_deposit'].includes(context.state)) {
    throw conflict('legacy_adoption_state', 'Принятие требует подтверждённого заказа без завершения или отмены')
  }
  const commitment = (await client.query<{ revision: string; state: string; current_version_id: string | null }>(
    'select revision::text,state,current_version_id::text from deal_resource_commitments where wedding_id=$1 and deal_id=$2',
    [input.weddingId, input.dealId])).rows[0]
  if (commitment && (commitment.revision !== '0' || commitment.state !== 'not_reserved' || commitment.current_version_id !== null)) {
    throw conflict('legacy_adoption_state', 'Принятие требует пустой брони ресурсов без истории')
  }
  const source = (await client.query<{ vendor_id: string; present: boolean; head_revision: string | null; inventory_version_id: string | null;
    effect: { state: string; freshness: string; effectiveVersionId: string | null } | null }>(`
    select s.vendor_id::text,legacy_calendar_present(s) present,h.revision::text head_revision,i.current_version_id::text inventory_version_id,
      legacy_calendar_bounds_current_effect(s.id) effect
    from legacy_calendar_sources s
    left join legacy_calendar_heads i on i.source_id=s.id
    left join legacy_calendar_bounds_heads h on h.source_id=s.id where s.id=$1`, [pins.sourceId])).rows[0]
  if (!source || !source.present || source.vendor_id !== context.vendorId ||
    source.inventory_version_id !== pins.sourceVersionId || !source.effect ||
    source.effect.freshness !== 'current' || source.effect.state !== 'finite' ||
    source.effect.effectiveVersionId !== pins.effectiveBoundsVersionId ||
    (pins.expectedSourceHeadRevision !== undefined && (source.head_revision ?? '0') !== pins.expectedSourceHeadRevision)) boundsChanged()
  const bounds = (await client.query<{ id: string; digest: string; source_fingerprint: string }>(
    'select id::text,digest,source_fingerprint from legacy_calendar_bounds_versions where source_id=$1 and id=$2',
    [pins.sourceId, pins.effectiveBoundsVersionId])).rows[0]
  if (!bounds || (pins.expectedSourceFingerprint !== undefined && bounds.source_fingerprint !== pins.expectedSourceFingerprint)) boundsChanged()
  const holder = (await client.query<{ id: string; outcome: string; holder_fingerprint: string; holder_snapshot: { dayScope?: unknown } }>(
    'select id::text,outcome,holder_fingerprint,holder_snapshot from legacy_calendar_bounds_holders where bounds_version_id=$1 and wedding_id=$2 and deal_id=$3',
    [pins.effectiveBoundsVersionId, input.weddingId, input.dealId])).rows[0]
  if (!holder || holder.outcome !== 'finite') {
    throw conflict('legacy_adoption_state', 'Принятие требует собственного ограниченного прежнего обязательства')
  }
  const group = (await client.query<{ total: number; fingerprints: string[] | null }>(
    'select count(*)::int total,array_agg(holder_fingerprint order by holder_fingerprint) fingerprints from legacy_calendar_bounds_holders where bounds_version_id=$1',
    [pins.effectiveBoundsVersionId])).rows[0]
  if (!group || !Array.isArray(group.fingerprints) || group.total < 1 || group.fingerprints.length !== group.total) boundsChanged()
  const spans = (await client.query<{ span_mode: string; local_starts_at: string; local_ends_at: string; supplied_starts_at: string; supplied_ends_at: string;
    time_zone: string; starts_at: Date; ends_at: Date; coverage: unknown; original_date: string | null }>(`
    select span_mode,local_starts_at,local_ends_at,supplied_starts_at,supplied_ends_at,time_zone,starts_at,ends_at,coverage,original_date::text
    from legacy_calendar_bounds_spans where bounds_version_id=$1 and owner_key=$2 order by span_index`,
    [pins.effectiveBoundsVersionId, holder.id])).rows
  const dayScope = holder.holder_snapshot?.dayScope
  let originalDay: Record<string, unknown> | null = null
  if (dayScope !== null && dayScope !== undefined) {
    const version = (dayScope as { version?: Record<string, unknown> }).version
    if (!version || typeof version.dayId !== 'string' || typeof version.serviceDate !== 'string' ||
      typeof version.recordedAt !== 'string' || typeof version.revision !== 'string') {
      throw validationFailed({ adoption: 'Нужен точный состав данных прежнего обязательства' })
    }
    originalDay = { identity: version.dayId, date: version.serviceDate, source: 'deal_day_scope', createdAt: version.recordedAt, revision: version.revision }
  }
  return {
    purpose: 'adopt-legacy-calendar', sourceId: pins.sourceId, sourceVersionId: pins.sourceVersionId,
    sourceFingerprint: bounds.source_fingerprint,
    fullGroupFingerprint: hash(canonicalTermsJson(group.fingerprints)),
    holderFingerprint: holder.holder_fingerprint,
    effectiveBoundsVersionId: pins.effectiveBoundsVersionId, effectiveBoundsDigest: bounds.digest,
    originalDay, disposition: ADOPTION_DISPOSITION,
    retainedHolderCount: group.total - 1,
    bounds: spans.map(s => ({ spanMode: s.span_mode, localStartsAt: s.local_starts_at, localEndsAt: s.local_ends_at,
      startsAt: s.starts_at.toISOString(), endsAt: s.ends_at.toISOString(),
      suppliedStartsAt: s.supplied_starts_at, suppliedEndsAt: s.supplied_ends_at,
      timeZone: s.time_zone, coverage: s.coverage, originalDate: s.original_date })),
  }
}

/** Server-side extraction of adoption pins from a stored terms snapshot. The
 * caller's own snapshot.schemaVersion never selects schema3; only this stored,
 * previously server-built material does. */
function adoptionTransitionOf(snapshot: Record<string, unknown>): AdoptionTransition | null {
  if (snapshot.schemaVersion !== 3) return null
  const t = snapshot.legacyTransition
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null
  const o = t as Record<string, unknown>
  if (o.purpose !== 'adopt-legacy-calendar' || o.disposition !== ADOPTION_DISPOSITION) return null
  if (!isUuid(o.sourceId) || !isUuid(o.sourceVersionId) || !isUuid(o.effectiveBoundsVersionId)) return null
  if (typeof o.sourceFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(o.sourceFingerprint)) return null
  if (typeof o.effectiveBoundsDigest !== 'string' || !/^[0-9a-f]{64}$/.test(o.effectiveBoundsDigest)) return null
  return { sourceId: o.sourceId, sourceVersionId: o.sourceVersionId, effectiveBoundsVersionId: o.effectiveBoundsVersionId,
    sourceFingerprint: o.sourceFingerprint, effectiveBoundsDigest: o.effectiveBoundsDigest }
}

interface TermsRow { id: string; version: string; source_order_version: string; source_fingerprint: string; digest: string;
  snapshot: Record<string, unknown>; published_by: string | null; published_side: TermsParty; published_at: Date }
function amendmentFingerprint(row: TermsRow, context: OrderContext, head: TermsHead, source: SourceState): string | null {
  const amendment = priceAmendmentOf(row.snapshot)
  if (!amendment) return null
  const economic = economicsOf(source)
  const prices = amendmentPrices(String(amendment.previousPrice.amount), economic.currency, amendment.difference)
  if (!prices) return null
  const alreadyAgreed = head.agreed_terms_id === row.id
  if (!alreadyAgreed && (head.proposed_terms_id !== row.id || head.agreed_terms_id !== amendment.agreementId || !orderCanAmendPrice(context))) return null
  const liveAmount = alreadyAgreed ? prices.proposedPrice.amount : prices.currentPrice.amount
  if (economic.amount !== String(liveAmount)) return null
  return withPrice(source, prices.proposedPrice.amount, amendment).fingerprint
}
async function project(client: Queryable, input: OrderInput, context: OrderContext, head: TermsHead, source: SourceState | null, termsId?: string): Promise<TermsView> {
  if (termsId !== undefined) checkEntityId(termsId, 'termsId')
  const rows = await client.query<TermsRow>('select id,version::text,source_order_version::text,source_fingerprint,digest,snapshot,published_by,published_side,published_at from deal_terms_versions where wedding_id=$1 and deal_id=$2 order by version desc', [input.weddingId, input.dealId])
  const receipts = await client.query<{ id: string; terms_id: string; party: TermsParty; user_id: string | null; session_id: string | null; digest: string; accepted_at: Date }>('select id,terms_id,party,user_id,session_id,digest,accepted_at from deal_terms_receipts where wedding_id=$1 and deal_id=$2 order by accepted_at,id', [input.weddingId, input.dealId])
  // A schema3 row proves freshness by re-materializing its own stored transition
  // under the current locks; an unmaterializable transition is stale, never trusted.
  const legacy = new Map<string, string | null>()
  const legacyFingerprint = async (row: TermsRow): Promise<string | null> => {
    if (!legacy.has(row.id)) {
      let fingerprint: string | null = null
      const pins = adoptionTransitionOf(row.snapshot)
      if (pins) {
        try { fingerprint = (await actualSource(client, input, context, pins)).fingerprint }
        catch (error) { if (!(error instanceof AppError)) throw error }
      }
      legacy.set(row.id, fingerprint)
    }
    return legacy.get(row.id)!
  }
  const history: PublishedTermsDto[] = []
  for (const r of rows.rows) {
    const accepted = receipts.rows.filter(receipt => receipt.terms_id === r.id)
    let freshness: PublishedTermsDto['freshness']
    if (source === null) freshness = 'invalid'
    else if ('priceAmendment' in r.snapshot) {
      const actual = amendmentFingerprint(r, context, head, source)
      freshness = actual !== r.source_fingerprint ? 'stale' : !source.performerAvailable ? 'unavailable' : 'current'
    }
    else if (r.snapshot.schemaVersion === 3) {
      const actual = await legacyFingerprint(r)
      freshness = actual === null || actual !== r.source_fingerprint ? 'stale' : !source.performerAvailable ? 'unavailable' : 'current'
    } else {
      freshness = r.source_fingerprint !== source.fingerprint ? 'stale' : !source.performerAvailable ? 'unavailable' : 'current'
    }
    history.push({ id: r.id, version: r.version, sourceOrderVersion: r.source_order_version, sourceFingerprint: r.source_fingerprint,
      digest: r.digest, snapshot: r.snapshot, publishedBy: r.published_by, publishedSide: r.published_side, publishedAt: r.published_at.toISOString(),
      freshness,
      receipts: accepted.map(a => ({ id: a.id, party: a.party, userId: a.user_id, sessionId: a.session_id, digest: a.digest, acceptedAt: a.accepted_at.toISOString() })),
      acceptedByCaller: accepted.some(a => a.user_id === input.actor.userId.toLowerCase()) })
  }
  const selectedId = termsId?.toLowerCase() ?? head.proposed_terms_id
  const selected = history.find(t => t.id === selectedId) ?? null
  if (termsId !== undefined && selected === null) throw notFound('Редакция условий не найдена')
  return { revision: head.terms_revision, proposedTermsId: head.proposed_terms_id, agreedTermsId: head.agreed_terms_id, history, selected, readToken: null, acceptedByCaller: selected?.acceptedByCaller ?? false }
}
const now = async (client: Queryable) => (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
function publishAdoptionOf(value: unknown): PublishAdoptionInput {
  const a = objectValues(value, 'adoption')
  const allowed = ['sourceId', 'sourceVersionId', 'expectedSourceFingerprint', 'expectedSourceHeadRevision', 'effectiveBoundsVersionId']
  if (Object.keys(a).length !== allowed.length || Object.keys(a).some(k => !allowed.includes(k))) {
    throw validationFailed({ adoption: 'Нужен точный состав полей принятия' })
  }
  checkEntityId(a.sourceId, 'adoption.sourceId'); checkEntityId(a.sourceVersionId, 'adoption.sourceVersionId')
  checkEntityId(a.effectiveBoundsVersionId, 'adoption.effectiveBoundsVersionId')
  if (typeof a.expectedSourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(a.expectedSourceFingerprint)) {
    throw validationFailed({ 'adoption.expectedSourceFingerprint': 'Нужен точный отпечаток источника' })
  }
  checkVersion(a.expectedSourceHeadRevision as string, a.expectedSourceHeadRevision as string, 'adoption.expectedSourceHeadRevision', true)
  return { sourceId: (a.sourceId as string).toLowerCase(), sourceVersionId: (a.sourceVersionId as string).toLowerCase(),
    effectiveBoundsVersionId: (a.effectiveBoundsVersionId as string).toLowerCase(),
    expectedSourceFingerprint: a.expectedSourceFingerprint as string,
    expectedSourceHeadRevision: a.expectedSourceHeadRevision as string }
}
export interface PublishTermsInput extends OrderInput { expectedOrderVersion: string; expectedTermsRevision: string; adoption?: PublishAdoptionInput }
type PublishPriceAmendmentInput = OrderInput & components['schemas']['OrderPriceAmendmentWrite']
async function appendTerms(client: Queryable, input: OrderInput, head: TermsHead, edition: SourceState, side: TermsParty): Promise<TermsHead> {
  const id = uuidv7(), version = (BigInt(head.terms_revision) + 1n).toString()
  await client.query('insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,canonical_payload,snapshot,digest,published_by,published_side,resource_plan_id) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$6,$9,$10,$11)',
    [id, input.weddingId, input.dealId, version, head.version, edition.fingerprint, edition.canonical, JSON.stringify(edition.snapshot), input.actor.userId, side, edition.resourcePlanId])
  await client.query('update deal_orders set terms_revision=$3,proposed_terms_id=$4 where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId, version, id])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.terms_published','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ termsId: id, termsVersion: version, sourceOrderVersion: head.version, digest: edition.fingerprint })])
  return { ...head, terms_revision: version, proposed_terms_id: id }
}

export async function publishOrderTerms(client: Queryable, input: PublishTermsInput): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, true)
  checkVersion(head.version, input.expectedOrderVersion, 'expectedOrderVersion')
  checkVersion(head.terms_revision, input.expectedTermsRevision, 'expectedTermsRevision', true)
  const adoption = input.adoption === undefined ? undefined : publishAdoptionOf(input.adoption)
  const source = await actualSource(client, input, context, adoption)
  if (!source.performerAvailable) throw conflict('terms_performer_unavailable', 'Исполнитель или выбранный ресурс недоступен для новых условий')
  const before = await project(client, input, context, head, source)
  const ownerId = await currentVendorOwner(client, context)
  // Pre-fix editions may have attributed the current performer's deliberate
  // acceptance to the customer side. A new explicit publication repairs the
  // edition without rewriting that history or transferring its receipts.
  const misassignedOwner = ownerId !== null && before.selected?.receipts.some(r => r.party === 'customer' && r.userId === ownerId)
  if (before.selected?.sourceFingerprint === source.fingerprint && !misassignedOwner) return before
  const updated = await appendTerms(client, input, head, source, party(context, ownerId, input.actor.userId))
  return project(client, input, context, updated, source)
}

export async function publishOrderPriceAmendment(client: Queryable, input: PublishPriceAmendmentInput): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, true)
  if (!orderCanAmendPrice(context) || !head.agreed_terms_id) {
    throw conflict('price_amendment_unavailable', 'Для изменения цены нужны действующие согласованные условия и исполнитель с аккаунтом')
  }
  checkEntityId(input.expectedAgreementId, 'expectedAgreementId')
  checkVersion(head.version, input.expectedOrderVersion, 'expectedOrderVersion')
  checkVersion(head.terms_revision, input.expectedTermsRevision, 'expectedTermsRevision')
  if (head.agreed_terms_id !== input.expectedAgreementId.toLowerCase()) priceAmendmentChanged()

  const source = await actualSource(client, input, context)
  const { selected: agreed } = await project(client, input, context, head, source, head.agreed_terms_id)
  if (agreed?.freshness !== 'current') priceAmendmentChanged()
  const current = await loadOrderPriceBreakdown(client, context.dealId)
  if (!current) throw conflict('price_amendment_unavailable', 'Нет сохранённых ставок для изменения цены')
  const preview = previewOfferPriceChange(current, input.changes)
  const economic = economicsOf(source)
  const prices = amendmentPrices(economic.amount, economic.currency, preview.difference)
  if (!prices || !preview.difference) throw conflict('price_amendment_unavailable', 'Для изменения цены нужна известная ненулевая разница в допустимых пределах')
  if (prices.proposedPrice.amount !== input.expectedAmount) priceAmendmentChanged()
  const changes = input.changes.map(change => {
    const formula = current.components.find(line => line.kind === change.kind)?.formula
    if (formula?.quantity == null || formula.rate === null) priceAmendmentChanged()
    return { ...change, previousQuantity: formula.quantity, unit: formula.unit, rate: formula.rate }
  })
  const edition = withPrice(source, prices.proposedPrice.amount, {
    agreementId: head.agreed_terms_id, previousPrice: prices.currentPrice, difference: preview.difference,
    changes, components: preview.proposed.components,
  })
  const owner = await currentVendorOwner(client, context)
  const updated = await appendTerms(client, input, head, edition, party(context, owner, input.actor.userId))
  return project(client, input, context, updated, source)
}

async function readTermsView(client: Queryable, input: OrderInput & { termsId?: string }, context: OrderContext, head: TermsHead): Promise<TermsView> {
  let source: SourceState | null
  try { source = await actualSource(client, input, context) }
  catch (error) {
    // A malformed current draft cannot hide a valid immutable earlier agreement.
    // Invalid source has no calculated fingerprint and never gets a read proof.
    if (!(error instanceof AppError) || error.statusCode !== 422) throw error
    source = null
  }
  return project(client, input, context, head, source, input.termsId)
}

export async function readVendorOrderNextAction(client: Queryable, input: OrderInput) {
  const { context, head } = await lockHead(client, input, false)
  if (context.actorRole !== 'vendor') throw notFound('Заказ не найден')
  if (context.state === 'cancelled') return { action: 'closed' } as const
  if (deliveryAvailable(context)) {
    const delivery = await deliveryHead(client, context)
    if (delivery?.kind === 'accepted') return { action: 'delivered' } as const
    if (delivery?.kind === 'submitted') return { action: 'wait_delivery' } as const
    if (delivery?.kind === 'changes_requested') return { action: 'revise_delivery' } as const
  }

  if (head.proposed_terms_id !== null) {
    const { selected } = await readTermsView(client, input, context, head)
    if (!selected || selected.freshness === 'invalid' || selected.freshness === 'stale') return { action: 'update_terms' } as const
    if (selected.freshness === 'unavailable') return { action: 'terms_unavailable' } as const
    if (selected.id !== head.agreed_terms_id) {
      return { action: selected.receipts.some(receipt => receipt.party === 'performer') ? 'wait_terms' : 'review_terms' } as const
    }
  } else {
    const { brief } = await readOrder(client, input)
    return { action: brief === null || Object.keys(brief.values).length === 0 ? 'prepare_brief' : 'publish_terms' } as const
  }

  return { action: deliveryAvailable(context) ? 'submit_delivery' : 'wait_booking' } as const
}

export async function loadOrderTerms(client: Queryable, input: OrderInput & { termsId?: string }, proof: TermsProofOptions): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, false)
  assertTermsProofAvailable(proof)
  const view = await readTermsView(client, input, context, head)
  if (view.selected?.id === head.proposed_terms_id && view.selected.freshness === 'current') {
    const transition = adoptionTransitionOf(view.selected.snapshot)
    view.readToken = transition
      ? await signLegacyAdoptionTermsRead(proof.secret, { purpose: 'order-legacy-adoption-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: view.selected.id,
        version: view.selected.version, digest: view.selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion,
        sourceId: transition.sourceId, sourceVersionId: transition.sourceVersionId, boundsVersionId: transition.effectiveBoundsVersionId,
        boundsDigest: transition.effectiveBoundsDigest, sourceFingerprint: transition.sourceFingerprint }, await now(client))
      : await signOrderTermsRead(proof.secret, { purpose: 'order-terms-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: view.selected.id,
        version: view.selected.version, digest: view.selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion }, await now(client))
  }
  return view
}
export interface AcceptTermsInput extends OrderInput { termsId: string; expectedTermsVersion: string; digest: string; readToken: string }
async function assertPriceAmendmentSigner(client: Queryable, input: OrderInput, receipt: TermsReceiptDto, ownerId: string | null) {
  if (!receipt.userId || !receipt.sessionId) priceAmendmentChanged()
  try { await lockOrderPrincipal(client, { userId: receipt.userId, sessionId: receipt.sessionId, policyVersion: input.actor.policyVersion }) }
  catch (error) {
    if (!(error instanceof AppError) || ![401, 403].includes(error.statusCode)) throw error
    priceAmendmentChanged()
  }
  if (receipt.party === 'performer') {
    if (receipt.userId !== ownerId) priceAmendmentChanged()
  } else {
    const { rows: [member] } = await client.query<{ role: string }>(
      'select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [input.weddingId, receipt.userId])
    if (member?.role !== 'couple' || receipt.userId === ownerId) priceAmendmentChanged()
  }
}
export async function acceptOrderTerms(client: Queryable, input: AcceptTermsInput, proof: TermsProofOptions): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, true)
  assertTermsProofAvailable(proof)
  const source = await actualSource(client, input, context), view = await project(client, input, context, head, source, input.termsId), selected = view.selected!
  if (selected.id !== head.proposed_terms_id) throw conflict('terms_superseded', 'Предложена другая редакция условий')
  checkVersion(selected.version, input.expectedTermsVersion, 'expectedTermsVersion')
  if (selected.freshness !== 'current') throw conflict('terms_source_changed', 'Источник условий изменился — нужна новая редакция')
  if (typeof input.digest !== 'string' || input.digest !== selected.digest) throw validationFailed({ digest: 'Редакция условий не совпадает' })
  const transition = adoptionTransitionOf(selected.snapshot)
  if (transition) {
    const claims = await verifyLegacyAdoptionTermsRead(proof.secret, input.readToken, await now(client))
    const binding: LegacyAdoptionReadClaims = { purpose: 'order-legacy-adoption-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: selected.id,
      version: selected.version, digest: selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion,
      sourceId: transition.sourceId, sourceVersionId: transition.sourceVersionId, boundsVersionId: transition.effectiveBoundsVersionId,
      boundsDigest: transition.effectiveBoundsDigest, sourceFingerprint: transition.sourceFingerprint }
    if (Object.keys(binding).some(k => claims[k as keyof LegacyAdoptionReadClaims] !== binding[k as keyof LegacyAdoptionReadClaims])) throw validationFailed({ readToken: 'Подтверждение относится к другой стороне, сессии или редакции' })
  } else {
    const claims = await verifyOrderTermsRead(proof.secret, input.readToken, await now(client))
    const binding: TermsReadClaims = { purpose: 'order-terms-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: selected.id,
      version: selected.version, digest: selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion }
    if (Object.keys(binding).some(k => claims[k as keyof TermsReadClaims] !== binding[k as keyof TermsReadClaims])) throw validationFailed({ readToken: 'Подтверждение относится к другой стороне, сессии или редакции' })
  }
  const owner = await currentVendorOwner(client, context)
  const side = party(context, owner, input.actor.userId)
  if (side === 'performer' && context.vendorId === null) throw conflict('terms_external_performer', 'Внешний контакт не является аккаунтом исполнителя')
  if (selected.receipts.some(r => r.party !== side && (r.userId === input.actor.userId.toLowerCase() || r.sessionId === input.actor.sessionId.toLowerCase()))) {
    throw forbidden('Пара и исполнитель подтверждают условия разными людьми; опубликуйте новую редакцию условий')
  }
  // One customer-party receipt, not one fabricated personal receipt for every partner.
  if (selected.receipts.some(r => r.party === side)) return view
  const other = selected.receipts.find(r => r.party !== side)
  const agreed = context.vendorId !== null && other !== undefined
  const amendment = priceAmendmentOf(selected.snapshot)
  let updatedSource = source
  if (amendment && other) {
    const economic = economicsOf(source)
    const prices = amendmentPrices(economic.amount, economic.currency, amendment.difference)
    if (!orderCanAmendPrice(context) || !prices || amendment.previousPrice.amount !== prices.currentPrice.amount) priceAmendmentChanged()
    await assertPriceAmendmentSigner(client, input, other, owner)
    await applyOrderPriceAmendment(client, context, input.actor.userId, selected.id, amendment, prices.proposedPrice.amount)
    updatedSource = withPrice(source, prices.proposedPrice.amount)
  }
  await client.query('insert into deal_terms_receipts(id,wedding_id,deal_id,terms_id,party,user_id,session_id,digest) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [uuidv7(), input.weddingId, input.dealId, selected.id, side, input.actor.userId, input.actor.sessionId, selected.digest])
  if (agreed) await client.query('update deal_orders set agreed_terms_id=$3 where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId, selected.id])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.terms_accepted','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ termsId: selected.id, party: side, digest: selected.digest, agreed })])
  return project(client, input, context, { ...head, agreed_terms_id: agreed ? selected.id : head.agreed_terms_id }, updatedSource, selected.id)
}

/** Allocation kernel only: callers first acquire final source/window locks.
 * Recompute the real material source; an old agreed pointer is not permission
 * to reserve a changed draft. No read token or private lines leave this helper. */
export async function verifyAgreedOrderTermsForBooking(client:Queryable,input:OrderInput & {
  expectedOrderVersion:string;termsId:string;expectedTermsVersion:string;termsDigest:string;planRevisionId:string
}):Promise<{termsId:string;planRevisionId:string;digest:string}> {
  checkEntityId(input.termsId,'termsId');checkEntityId(input.planRevisionId,'planRevisionId')
  const {context,head}=await lockHead(client,input,true)
  checkVersion(head.version,input.expectedOrderVersion,'expectedOrderVersion')
  if(head.agreed_terms_id!==input.termsId.toLowerCase()||head.proposed_terms_id!==head.agreed_terms_id)
    throw conflict('resource_terms_not_agreed','Для брони обе стороны должны принять текущую редакцию условий')
  const source=await actualSource(client,input,context),view=await project(client,input,context,head,source,input.termsId),selected=view.selected!
  checkVersion(selected.version,input.expectedTermsVersion,'expectedTermsVersion')
  if(selected.freshness!=='current'||source.resourcePlanId!==input.planRevisionId.toLowerCase()||selected.snapshot.schemaVersion!==2)
    throw conflict('resource_terms_source_changed','Согласованный план или источник изменился — нужны актуальные условия')
  if(typeof input.termsDigest!=='string'||selected.digest!==input.termsDigest||selected.sourceFingerprint!==selected.digest)
    throw validationFailed({termsDigest:'Редакция согласованных условий не совпадает'})
  const customer=selected.receipts.find(r=>r.party==='customer'),performer=selected.receipts.find(r=>r.party==='performer')
  if(!customer||!performer||!customer.userId||!performer.userId||!customer.sessionId||!performer.sessionId||
    customer.userId===performer.userId||customer.sessionId===performer.sessionId||
    customer.digest!==selected.digest||performer.digest!==selected.digest)
    throw conflict('resource_terms_not_agreed','Нужны отдельные подтверждения пары и исполнителя одной редакции')
  return {termsId:selected.id,planRevisionId:source.resourcePlanId,digest:selected.digest}
}

/** Adoption kernel mirror of verifyAgreedOrderTermsForBooking: only an actual
 * server-built schema3 draft passes, re-materialized under the final locks. */
export async function verifyAgreedLegacyAdoptionTerms(client: Queryable, input: OrderInput & {
  expectedOrderVersion: string; termsId: string; expectedTermsVersion: string; termsDigest: string; planRevisionId: string
}): Promise<{ termsId: string; planRevisionId: string; digest: string; transition: AdoptionTransition }> {
  checkEntityId(input.termsId, 'termsId'); checkEntityId(input.planRevisionId, 'planRevisionId')
  const { context, head } = await lockHead(client, input, true)
  checkVersion(head.version, input.expectedOrderVersion, 'expectedOrderVersion')
  if (head.agreed_terms_id !== input.termsId.toLowerCase() || head.proposed_terms_id !== head.agreed_terms_id)
    throw conflict('resource_terms_not_agreed', 'Для принятия обе стороны должны принять текущую редакцию условий')
  const source = await actualSource(client, input, context), view = await project(client, input, context, head, source, input.termsId), selected = view.selected!
  checkVersion(selected.version, input.expectedTermsVersion, 'expectedTermsVersion')
  const transition = adoptionTransitionOf(selected.snapshot)
  if (!transition || selected.freshness !== 'current' || source.resourcePlanId !== input.planRevisionId.toLowerCase())
    throw conflict('resource_terms_source_changed', 'Согласованный переход или источник изменился — нужны актуальные условия')
  if (typeof input.termsDigest !== 'string' || selected.digest !== input.termsDigest || selected.sourceFingerprint !== selected.digest)
    throw validationFailed({ termsDigest: 'Редакция согласованных условий не совпадает' })
  const customer = selected.receipts.find(r => r.party === 'customer'), performer = selected.receipts.find(r => r.party === 'performer')
  if (!customer || !performer || !customer.userId || !performer.userId || !customer.sessionId || !performer.sessionId ||
    customer.userId === performer.userId || customer.sessionId === performer.sessionId ||
    customer.digest !== selected.digest || performer.digest !== selected.digest)
    throw conflict('resource_terms_not_agreed', 'Нужны отдельные подтверждения пары и исполнителя одной редакции')
  return { termsId: selected.id, planRevisionId: source.resourcePlanId!, digest: selected.digest, transition }
}
