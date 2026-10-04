import type { OfferComparisonTerms } from '../offers/comparison-terms.js'
import { createHash } from 'node:crypto'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { validateBrief } from './catalog.js'
import { lockOrderContext, type OrderContext } from './context.js'
import { boundedText, checkEntityId, checkVersion, readOrder, validatePartDetails, type OrderInput } from './model.js'
import { assertTermsProofAvailable, signOrderTermsRead, verifyOrderTermsRead, type TermsProofOptions, type TermsReadClaims } from './terms-token.js'
import { readResourcePlanSource } from './resource-plan.js'

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
const party = (context: OrderContext): TermsParty => context.actorRole === 'couple' ? 'customer' : 'performer'
async function lockHead(client: Queryable, input: OrderInput, write: boolean) {
  checkEntityId(input.weddingId, 'weddingId'); checkEntityId(input.dealId, 'dealId')
  const context = await lockOrderContext(client, input.weddingId, input.dealId, input.actor, write)
  const head = await client.query<TermsHead>(`select version::text,terms_revision::text,proposed_terms_id,agreed_terms_id from deal_orders
    where wedding_id=$1 and deal_id=$2 for ${write ? 'update' : 'share'}`, [input.weddingId, input.dealId])
  if (!head.rows[0]) throw notFound('Источник заказа не найден')
  return { context, head: head.rows[0] }
}
async function actualSource(client: Queryable, input: OrderInput, context: OrderContext): Promise<SourceState> {
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
  const snapshot = { schemaVersion: resourcePlan.plan === null ? 1 : 2, weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(),
    source: order.source, categoryId: context.categoryId, sourceOrderVersion: order.version,
    legacyContext: { mainEvent: main ? { id: main.id, name: main.name, date: main.date, timeZone: main.time_zone, location: main.location } : null },
    brief: order.brief, assignments, parts, ...(resourcePlan.plan === null ? {} : { resourcePlan: resourcePlan.plan }),
    economics: { amount: economic.price, amountKnown: economic.price !== null, currency: economic.currency,
      performer: { vendor, externalName: economic.external_name, externalPhone: economic.external_phone },
      package: { id: economic.package_id, titleSnapshot: economic.package_title_snapshot, includesSnapshot: economic.package_includes_snapshot,
        ...(economic.offer_comparison_terms_snapshot == null ? {} : { comparisonTerms: economic.offer_comparison_terms_snapshot }) } } }
  const canonical = canonicalTermsJson(snapshot)
  return { snapshot, canonical, fingerprint: hash(canonical), performerAvailable, resourcePlanId: resourcePlan.plan?.planRevisionId ?? null }
}
interface TermsRow { id: string; version: string; source_order_version: string; source_fingerprint: string; digest: string;
  snapshot: Record<string, unknown>; published_by: string | null; published_side: TermsParty; published_at: Date }
async function project(client: Queryable, input: OrderInput, head: TermsHead, source: SourceState | null, termsId?: string): Promise<TermsView> {
  if (termsId !== undefined) checkEntityId(termsId, 'termsId')
  const rows = await client.query<TermsRow>('select id,version::text,source_order_version::text,source_fingerprint,digest,snapshot,published_by,published_side,published_at from deal_terms_versions where wedding_id=$1 and deal_id=$2 order by version desc', [input.weddingId, input.dealId])
  const receipts = await client.query<{ id: string; terms_id: string; party: TermsParty; user_id: string | null; session_id: string | null; digest: string; accepted_at: Date }>('select id,terms_id,party,user_id,session_id,digest,accepted_at from deal_terms_receipts where wedding_id=$1 and deal_id=$2 order by accepted_at,id', [input.weddingId, input.dealId])
  const history = rows.rows.map(r => {
    const accepted = receipts.rows.filter(receipt => receipt.terms_id === r.id)
    return { id: r.id, version: r.version, sourceOrderVersion: r.source_order_version, sourceFingerprint: r.source_fingerprint,
      digest: r.digest, snapshot: r.snapshot, publishedBy: r.published_by, publishedSide: r.published_side, publishedAt: r.published_at.toISOString(),
      freshness: source === null ? 'invalid' as const : r.source_fingerprint !== source.fingerprint ? 'stale' as const : !source.performerAvailable ? 'unavailable' as const : 'current' as const,
      receipts: accepted.map(a => ({ id: a.id, party: a.party, userId: a.user_id, sessionId: a.session_id, digest: a.digest, acceptedAt: a.accepted_at.toISOString() })),
      acceptedByCaller: accepted.some(a => a.user_id === input.actor.userId.toLowerCase()) }
  })
  const selectedId = termsId?.toLowerCase() ?? head.proposed_terms_id
  const selected = history.find(t => t.id === selectedId) ?? null
  if (termsId !== undefined && selected === null) throw notFound('Редакция условий не найдена')
  return { revision: head.terms_revision, proposedTermsId: head.proposed_terms_id, agreedTermsId: head.agreed_terms_id, history, selected, readToken: null, acceptedByCaller: selected?.acceptedByCaller ?? false }
}
const now = async (client: Queryable) => (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
export interface PublishTermsInput extends OrderInput { expectedOrderVersion: string; expectedTermsRevision: string }
export async function publishOrderTerms(client: Queryable, input: PublishTermsInput): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, true)
  checkVersion(head.version, input.expectedOrderVersion, 'expectedOrderVersion')
  checkVersion(head.terms_revision, input.expectedTermsRevision, 'expectedTermsRevision', true)
  const source = await actualSource(client, input, context)
  if (!source.performerAvailable) throw conflict('terms_performer_unavailable', 'Исполнитель или выбранный ресурс недоступен для новых условий')
  const before = await project(client, input, head, source)
  if (before.selected?.sourceFingerprint === source.fingerprint) return before
  const id = uuidv7(), version = (BigInt(head.terms_revision) + 1n).toString()
  await client.query('insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,canonical_payload,snapshot,digest,published_by,published_side,resource_plan_id) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$6,$9,$10,$11)',
    [id, input.weddingId, input.dealId, version, head.version, source.fingerprint, source.canonical, JSON.stringify(source.snapshot), input.actor.userId, party(context), source.resourcePlanId])
  await client.query('update deal_orders set terms_revision=$3,proposed_terms_id=$4 where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId, version, id])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.terms_published','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ termsId: id, termsVersion: version, sourceOrderVersion: head.version, digest: source.fingerprint })])
  return project(client, input, { ...head, terms_revision: version, proposed_terms_id: id }, source)
}
export async function loadOrderTerms(client: Queryable, input: OrderInput & { termsId?: string }, proof: TermsProofOptions): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, false)
  assertTermsProofAvailable(proof)
  let source: SourceState | null
  try { source = await actualSource(client, input, context) }
  catch (error) {
    // A malformed current draft cannot hide a valid immutable earlier agreement.
    // Invalid source has no calculated fingerprint and never gets a read proof.
    if (!(error instanceof AppError) || error.statusCode !== 422) throw error
    source = null
  }
  const view = await project(client, input, head, source, input.termsId)
  if (view.selected?.id === head.proposed_terms_id && view.selected.freshness === 'current') {
    view.readToken = await signOrderTermsRead(proof.secret, { purpose: 'order-terms-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: view.selected.id,
      version: view.selected.version, digest: view.selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion }, await now(client))
  }
  return view
}
export interface AcceptTermsInput extends OrderInput { termsId: string; expectedTermsVersion: string; digest: string; readToken: string }
export async function acceptOrderTerms(client: Queryable, input: AcceptTermsInput, proof: TermsProofOptions): Promise<TermsView> {
  const { context, head } = await lockHead(client, input, true)
  assertTermsProofAvailable(proof)
  const source = await actualSource(client, input, context), view = await project(client, input, head, source, input.termsId), selected = view.selected!
  if (selected.id !== head.proposed_terms_id) throw conflict('terms_superseded', 'Предложена другая редакция условий')
  checkVersion(selected.version, input.expectedTermsVersion, 'expectedTermsVersion')
  if (selected.freshness !== 'current') throw conflict('terms_source_changed', 'Источник условий изменился — нужна новая редакция')
  if (typeof input.digest !== 'string' || input.digest !== selected.digest) throw validationFailed({ digest: 'Редакция условий не совпадает' })
  const claims = await verifyOrderTermsRead(proof.secret, input.readToken, await now(client))
  const binding: TermsReadClaims = { purpose: 'order-terms-read', weddingId: input.weddingId.toLowerCase(), dealId: input.dealId.toLowerCase(), termsId: selected.id,
    version: selected.version, digest: selected.digest, userId: input.actor.userId.toLowerCase(), sessionId: input.actor.sessionId.toLowerCase(), policyVersion: input.actor.policyVersion }
  if (Object.keys(binding).some(k => claims[k as keyof TermsReadClaims] !== binding[k as keyof TermsReadClaims])) throw validationFailed({ readToken: 'Подтверждение относится к другой стороне, сессии или редакции' })
  const side = party(context)
  if (side === 'performer' && context.vendorId === null) throw conflict('terms_external_performer', 'Внешний контакт не является аккаунтом исполнителя')
  // One customer-party receipt, not one fabricated personal receipt for every partner.
  if (selected.receipts.some(r => r.party === side)) return view
  await client.query('insert into deal_terms_receipts(id,wedding_id,deal_id,terms_id,party,user_id,session_id,digest) values($1,$2,$3,$4,$5,$6,$7,$8)',
    [uuidv7(), input.weddingId, input.dealId, selected.id, side, input.actor.userId, input.actor.sessionId, selected.digest])
  const agreed = context.vendorId !== null && selected.receipts.some(r => r.party !== side)
  if (agreed) await client.query('update deal_orders set agreed_terms_id=$3 where wedding_id=$1 and deal_id=$2', [input.weddingId, input.dealId, selected.id])
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,'order.terms_accepted','order',$2,$3::jsonb)",
    [input.actor.userId, input.dealId, JSON.stringify({ termsId: selected.id, party: side, digest: selected.digest, agreed })])
  return project(client, input, { ...head, agreed_terms_id: agreed ? selected.id : head.agreed_terms_id }, source, selected.id)
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
  const source=await actualSource(client,input,context),view=await project(client,input,head,source,input.termsId),selected=view.selected!
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
