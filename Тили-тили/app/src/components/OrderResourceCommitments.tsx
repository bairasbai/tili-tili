import { useEffect, useRef, useState } from 'react'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { getOrder, getOrderCatalog, getOrderTerms, getOrderResourcePlan, getOrderResourceCommitments, getVendorBookingPolicy, commitOrderResources, replaceOrderResources, type WeddingOrder, type OrderCatalog, type OrderTermsView, type ResourcePlanView, type ResourceCommitmentView, type ResourceCommitmentWrite, type VendorBookingPolicy } from '@/lib/api/orders'
import { t } from '@/lib/i18n'

type Terms = Omit<OrderTermsView, 'readToken'>
type Loaded = { order: WeddingOrder; catalog: OrderCatalog; commitment: ResourceCommitmentView; terms: Terms; plan: ResourcePlanView; policy: VendorBookingPolicy | null }
type Command = { kind: 'commit' | 'replace'; key: string; body: ResourceCommitmentWrite }
type Props = { dealId: string; onChanged?: () => void; openRequest?: number }
const button = 'min-h-11 max-w-full whitespace-normal break-words rounded-xl border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(v) && BigInt(v) <= 9223372036854775807n
function instant(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v)) || Number(v.slice(0, 4)) < 1 || new Date(v.slice(0, 10)).toISOString().slice(0, 10) !== v.slice(0, 10) || Number(v.slice(11, 13)) >= 24 || Number(v.slice(14, 16)) >= 60 || Number(v.slice(17, 19)) >= 60) return false
  const offset = /[+-](\d{2}):(\d{2})$/.exec(v)
  return !offset || Number(offset[1]) <= 14 && Number(offset[2]) < 60 && (Number(offset[1]) !== 14 || Number(offset[2]) === 0)
}
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200
const integer = (v: unknown, max: number, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]))
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]))
}
function zone(v: unknown): boolean { if (!text(v)) return false; try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } }
function checkCommitment(v: unknown): asserts v is ResourceCommitmentView {
  if (!exact(v, ['revision', 'state', 'termsId', 'planRevisionId', 'reservation']) || !version(v.revision, true) || !['not_reserved', 'reserved', 'released'].includes(String(v.state)) || v.reservation !== v.state || (v.state === 'not_reserved' ? v.revision !== '0' || v.termsId !== null || v.planRevisionId !== null : v.revision === '0' || !uuid(v.termsId) || !uuid(v.planRevisionId))) throw new Error('Unconfirmed commitment')
}
const buffers = ['setupMinutes', 'teardownMinutes', 'travelBeforeMinutes', 'travelAfterMinutes']
function validPlan(v: unknown): boolean {
  if (!exact(v, ['planRevisionId', 'revision', 'lines']) || !uuid(v.planRevisionId) || !version(v.revision) || !Array.isArray(v.lines) || !v.lines.length || v.lines.length > 100) return false
  return v.lines.every(l => {
    if (!exact(l, ['partId', 'assignmentId', 'programEventId', 'label', 'kind', 'quantity', 'unit', 'startsAt', 'endsAt', 'timeZone', ...buffers, 'occupiedStartsAt', 'occupiedEndsAt', 'window']) || !uuid(l.partId) || !(l.assignmentId === null || uuid(l.assignmentId)) || !(l.programEventId === null || uuid(l.programEventId)) || (l.assignmentId === null) !== (l.programEventId === null) || !text(l.label) || !['person', 'equipment', 'capacity'].includes(String(l.kind)) || !integer(l.quantity, 2147483647, 1) || !instant(l.startsAt) || !instant(l.endsAt) || Date.parse(l.endsAt) <= Date.parse(l.startsAt) || !zone(l.timeZone) || !buffers.every(k => integer(l[k], 1440)) || !instant(l.occupiedStartsAt) || !instant(l.occupiedEndsAt)) return false
    if (Date.parse(l.occupiedStartsAt) !== Date.parse(l.startsAt) - (Number(l.setupMinutes) + Number(l.travelBeforeMinutes)) * 60000 || Date.parse(l.occupiedEndsAt) !== Date.parse(l.endsAt) + (Number(l.teardownMinutes) + Number(l.travelAfterMinutes)) * 60000) return false
    return l.kind === 'capacity' ? text(l.unit) && exact(l.window, ['startsAt', 'endsAt']) && instant(l.window.startsAt) && instant(l.window.endsAt) && Date.parse(l.window.startsAt) <= Date.parse(l.occupiedStartsAt) && Date.parse(l.window.endsAt) >= Date.parse(l.occupiedEndsAt) : l.quantity === 1 && l.unit === null && l.window === null
  })
}
function proof(data: Loaded): ResourceCommitmentWrite | null { try { return checkedProof(data) } catch { return null } }
function checkedProof(data: Loaded): ResourceCommitmentWrite | null {
  const { order, catalog, commitment, terms, plan, policy } = data, term = terms.selected
  if (catalog.actorRole !== 'couple' || !catalog.draftEditable || !uuid(catalog.vendorId) || !policy || !exact(policy, ['mode', 'revision']) || policy.mode !== 'resources' || !version(policy.revision) || !version(order.version) || !exact(terms, ['revision', 'proposedTermsId', 'agreedTermsId', 'history', 'selected', 'acceptedByCaller']) || !version(terms.revision, true) || !exact(plan, ['orderVersion', 'revision', 'canEdit', 'reservation', 'current', 'editorLines', 'source', 'history']) || typeof plan.canEdit !== 'boolean' || plan.source !== 'current' || plan.orderVersion !== order.version || !version(plan.revision) || !validPlan(plan.current) || plan.current?.revision !== plan.revision || !Array.isArray(plan.history) || !plan.history.some(p => equal(p, plan.current))) return null
  if (!term || !exact(term, ['id', 'version', 'sourceOrderVersion', 'sourceFingerprint', 'digest', 'snapshot', 'publishedBy', 'publishedSide', 'publishedAt', 'freshness', 'receipts', 'acceptedByCaller']) || !uuid(term.id) || !version(term.version) || term.sourceOrderVersion !== order.version || term.freshness !== 'current' || !/^[0-9a-f]{64}$/.test(term.digest) || term.sourceFingerprint !== term.digest || !instant(term.publishedAt) || !['customer', 'performer'].includes(term.publishedSide) || !(term.publishedBy === null || uuid(term.publishedBy)) || typeof term.acceptedByCaller !== 'boolean' || term.id !== terms.agreedTermsId || term.id !== terms.proposedTermsId || !Array.isArray(terms.history) || !terms.history.some(h => equal(h, term)) || terms.acceptedByCaller !== term.acceptedByCaller || !Array.isArray(term.receipts) || term.receipts.length !== 2) return null
  if (term.version !== terms.revision || new Set(terms.history.map(h => h.id)).size !== terms.history.length) return null
  if (!term.receipts.every(r => exact(r, ['id', 'party', 'userId', 'sessionId', 'digest', 'acceptedAt']) && uuid(r.id) && uuid(r.userId) && uuid(r.sessionId) && r.digest === term.digest && instant(r.acceptedAt))) return null
  const customer = term.receipts.find(r => r.party === 'customer'), performer = term.receipts.find(r => r.party === 'performer')
  if (!customer || !performer || customer.id === performer.id || customer.userId === performer.userId || customer.sessionId === performer.sessionId) return null
  const s = term.snapshot
  if (!exact(s, ['schemaVersion', 'weddingId', 'dealId', 'source', 'categoryId', 'sourceOrderVersion', 'legacyContext', 'brief', 'assignments', 'parts', 'economics', 'resourcePlan']) || s.schemaVersion !== 2 || s.dealId !== order.dealId || s.weddingId !== catalog.weddingId || s.categoryId !== catalog.category?.categoryId || s.sourceOrderVersion !== order.version || s.source !== order.source || !equal(s.resourcePlan, plan.current) || !equal(s.brief, order.brief) || !Array.isArray(s.parts) || !Array.isArray(s.assignments) || !exact(s.legacyContext, ['mainEvent']) || !exact(s.economics, ['amount', 'amountKnown', 'currency', 'performer', 'package']) || !exact(s.economics.performer, ['vendor', 'externalName', 'externalPhone']) || !exact(s.economics.performer.vendor, ['id', 'userId', 'name', 'categoryId']) || s.economics.performer.vendor.id !== catalog.vendorId || s.economics.performer.vendor.userId !== performer.userId || s.economics.performer.vendor.categoryId !== catalog.category.categoryId) return null
  const economic = s.economics, performerSource = s.economics.performer, company = s.economics.performer.vendor, pack = economic.package
  if (economic.amountKnown !== (economic.amount !== null) || !(economic.amount === null || typeof economic.amount === 'string' && /^(0|[1-9]\d{0,18})$/.test(economic.amount) && BigInt(economic.amount) <= 9223372036854775807n) || economic.currency !== 'RUB' || !text(company.name) || performerSource.externalName !== null || performerSource.externalPhone !== null || !exact(pack, ['id', 'titleSnapshot', 'includesSnapshot']) || !(pack.id === null || uuid(pack.id)) || !(pack.titleSnapshot === null || text(pack.titleSnapshot)) || !(pack.includesSnapshot === null || Array.isArray(pack.includesSnapshot) && pack.includesSnapshot.every(text))) return null
  if (s.legacyContext.mainEvent !== null && !exact(s.legacyContext.mainEvent, ['id', 'name', 'date', 'timeZone', 'location'])) return null
  const activeParts = order.parts.filter(p => p.cancelledAt === null).map(p => ({ id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignmentId, details: p.details })).sort((a, b) => a.id.localeCompare(b.id))
  if (!equal(s.parts, activeParts) || s.assignments.length !== order.assignments.filter(a => a.cancelledAt === null).length || new Set(s.assignments.map(a => object(a) ? a.id : null)).size !== s.assignments.length) return null
  if (!s.assignments.every(a => exact(a, ['id', 'slotId', 'version', 'source', 'label', 'event']) && exact(a.event, ['id', 'name', 'kind', 'date', 'timeZone', 'location']) && order.assignments.some(o => o.cancelledAt === null && a.id === o.id && a.slotId === o.slotId && a.version === o.version && a.source === o.source && a.label === o.label && (a.event as Record<string, unknown>).id === o.programEventId))) return null
  if (plan.current?.lines.some(l => { const p = order.parts.find(p => p.id === l.partId && p.cancelledAt === null); return !p || p.assignmentId !== l.assignmentId || (l.assignmentId === null ? p.kind !== 'deliverable' : !order.assignments.some(a => a.id === l.assignmentId && a.programEventId === l.programEventId && a.cancelledAt === null)) })) return null
  const projected = commitment.planRevisionId === plan.current?.planRevisionId ? commitment.state : 'not_reserved'
  if (plan.reservation !== projected) return null
  return { expectedOrderVersion: order.version, expectedCommitmentRevision: commitment.revision, termsId: term.id, expectedTermsVersion: term.version, termsDigest: term.digest, planRevisionId: plan.current!.planRevisionId, expectedPolicyRevision: policy.revision }
}
function actionFor(data: Loaded): Command['kind'] | null {
  const body = proof(data), { commitment, catalog } = data
  if (!body) return null
  if (commitment.state === 'not_reserved' && ['candidate', 'contacted', 'negotiating'].includes(catalog.dealState ?? '')) return 'commit'
  if (commitment.state === 'reserved' && ['booked', 'paid_deposit'].includes(catalog.dealState ?? '') && (commitment.planRevisionId !== body.planRevisionId || commitment.termsId !== body.termsId)) return 'replace'
  return null
}
const privacy = (e: unknown) => e instanceof ApiError && [401, 403, 404, 410].includes(e.status)
async function load(dealId: string, invalidate: () => void, active: () => boolean): Promise<Loaded> {
  async function guarded<T>(p: Promise<T>): Promise<T> { try { return await p } catch (e) { if (privacy(e)) invalidate(); throw e } }
  async function read() {
    const [order, catalog, commitment, rawTerms, plan] = await Promise.all([guarded(getOrder(dealId)), guarded(getOrderCatalog(dealId)), guarded(getOrderResourceCommitments(dealId)), guarded(getOrderTerms(dealId)), guarded(getOrderResourcePlan(dealId))])
    checkCommitment(commitment)
    if (!order || order.dealId !== dealId || !version(order.version) || !Array.isArray(order.parts) || !Array.isArray(order.assignments) || !catalog || !uuid(catalog.weddingId) || !['couple', 'vendor'].includes(catalog.actorRole) || typeof catalog.draftEditable !== 'boolean' || !object(rawTerms)) throw new Error('Unconfirmed authority')
    // Never retain a read token: this action requires existing server receipts.
    const { readToken: _readToken, ...terms } = rawTerms
    void _readToken
    if (catalog.actorRole === 'couple' && object(plan) && plan.canEdit === false && plan.editorLines !== null) { invalidate(); throw new Error('Private projection') }
    return { order, catalog, commitment, terms, plan }
  }
  const initial = await read()
  if (!active()) throw new Error('Reader closed')
  let policy: VendorBookingPolicy | null = null
  if (uuid(initial.catalog.vendorId)) {
    try { policy = await getVendorBookingPolicy(initial.catalog.vendorId) } catch (e) {
      if (e instanceof ApiError && [401, 403, 410].includes(e.status)) { invalidate(); throw e }
      // An unavailable public company cannot erase an existing private promise.
    }
  }
  if (!active()) throw new Error('Reader closed')
  const fresh = await read()
  if (initial.catalog.actorRole !== fresh.catalog.actorRole || initial.catalog.weddingId !== fresh.catalog.weddingId || initial.catalog.vendorId !== fresh.catalog.vendorId) { invalidate(); throw new Error('Authority changed') }
  if (!equal(initial, fresh)) throw new Error('Source changed while loading')
  return { ...fresh, policy }
}

/** A voluntary, collapsed reader. Only an explicit couple action reserves work. */
export function OrderResourceCommitments({ dealId, onChanged, openRequest = 0 }: Props) {
  const [expired, setExpired] = useState(false)
  useEffect(() => { const clear = () => setExpired(true), a = onSessionChanged(clear), b = onSessionExpired(clear); return () => { a(); b() } }, [])
  return <CommitmentsSection key={dealId} dealId={dealId} expired={expired} onChanged={onChanged} openRequest={openRequest} />
}
function CommitmentsSection({ dealId, expired, onChanged, openRequest = 0 }: Props & { expired: boolean }) {
  const [open, setOpen] = useState(false), [activated, setActivated] = useState(false)
  const heading = useRef<HTMLElement>(null)
  const disclosure = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (openRequest <= 0 || expired) return
    if (disclosure.current) disclosure.current.open = true
    heading.current?.focus()
  }, [openRequest, expired])
  return <details ref={disclosure} open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setActivated(true) }} className="min-w-0 max-w-full break-words rounded-2xl border border-[var(--line)] p-3">
    <summary ref={heading} className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Бронь ресурсов заказа')}</summary>
    {activated && <div hidden={!open}>{expired ? <p role="alert">{t('Сессия изменилась — откройте заказ после входа заново')}</p> : <CommitmentsReader dealId={dealId} onChanged={onChanged} />}</div>}
  </details>
}
function CommitmentsReader({ dealId, onChanged }: Props) {
  const [data, setData] = useState<Loaded | null>(null), [busy, setBusy] = useState(true), [closed, setClosed] = useState(false), [pending, setPending] = useState<Command | null>(null), [message, setMessage] = useState<string | null>(null)
  const alive = useRef(false), generation = useRef(0), flight = useRef(false), authority = useRef<{ wedding: string; role: string; vendor: string | null | undefined } | null>(null)
  const invalidate = () => { if (alive.current) { generation.current++; setClosed(true); setData(null); setPending(null); setMessage(t('Доступ к брони закрыт. Откройте заказ после входа заново.')) } }
  const refresh = async () => {
    const gen = ++generation.current
    const current = () => alive.current && generation.current === gen
    const next = await load(dealId, () => { if (current()) invalidate() }, current)
    if (!alive.current || generation.current !== gen) return false
    if (authority.current && (authority.current.wedding !== next.catalog.weddingId || authority.current.role !== next.catalog.actorRole || authority.current.vendor !== next.catalog.vendorId)) { invalidate(); return false }
    authority.current = { wedding: next.catalog.weddingId, role: next.catalog.actorRole, vendor: next.catalog.vendorId }; setData(next); return true
  }
  useEffect(() => {
    alive.current = true
    let currentEffect = true
    const clear = () => { invalidate(); alive.current = false }, changed = onSessionChanged(clear), expired = onSessionExpired(clear)
    const initialRead = refresh(), initialGeneration = generation.current
    void initialRead.catch(() => { if (currentEffect && alive.current && generation.current === initialGeneration) setMessage(t('Не удалось подтвердить актуальную бронь. Обновите сведения.')) }).finally(() => { if (currentEffect && alive.current && generation.current === initialGeneration) setBusy(false) })
    return () => { currentEffect = false; alive.current = false; changed(); expired() }
    // This reader is mounted anew at every deal/session boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId])
  const reread = async () => {
    if (flight.current || closed || pending) return
    flight.current = true; setBusy(true); setData(null); setMessage(null)
    try { await refresh() } catch (e) { if (privacy(e)) invalidate(); else if (alive.current) setMessage(t('Не удалось подтвердить актуальную бронь. Обновите сведения.')) } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const execute = async (command: Command, retry = false) => {
    if (flight.current || closed || (!retry && (!data || actionFor(data) !== command.kind || !equal(proof(data), command.body)))) return
    flight.current = true; setBusy(true); setMessage(null)
    let answered = false
    try {
      // The reply may be a replay. Only a new authoritative read is displayed.
      await (command.kind === 'commit' ? commitOrderResources : replaceOrderResources)(dealId, command.body, command.key)
      answered = true
      if (!alive.current) return
      setPending(null); setData(null)
      if (await refresh()) {
        setMessage(t('Запрос обработан. Показана актуальная бронь.'))
        // Parent financial cards refresh only after an independently confirmed
        // read. Their own refresh failure cannot undo this server operation.
        try { void Promise.resolve(onChanged?.()).catch(() => {}) } catch { /* Parent owns its reader. */ }
      }
    } catch (e) {
      if (!alive.current) return
      if (privacy(e)) invalidate()
      else if (!answered && e instanceof ApiError && e.isDown) { setPending(command); setData(null); setMessage(t('Ответ не получен. Проверьте результат тем же запросом.')) }
      else {
        setPending(null)
        if (answered) { setData(null); setMessage(t('Запрос обработан, но актуальная бронь не подтверждена. Обновите сведения.')) }
        else {
          // A refusal changes no promise. Confirm its current state by GET.
          setData(null)
          try { await refresh() } catch (error) { if (privacy(error)) invalidate() }
          if (alive.current) setMessage(t(e instanceof ApiError && [409, 422].includes(e.status) ? 'Бронь не изменена. Проверьте актуальный план и согласование условий.' : 'Не удалось выполнить запрос. Обновите сведения перед новым действием.'))
        }
      }
    } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  if (closed) return <p role="alert">{t('Доступ к брони закрыт. Откройте заказ после входа заново.')}</p>
  const current = data?.commitment, body = data ? proof(data) : null, action = data ? actionFor(data) : null
  return <div className="min-w-0 space-y-3 pt-2 text-sm">
    <p className="text-xs text-[var(--soft)]">{t('План и согласование условий сами по себе не бронируют ресурсы. Действие выполняется только по вашему запросу.')}</p>
    {message && <p role="status">{message}</p>}
    {busy && <p>{t('Проверяем актуальную бронь…')}</p>}
    {current && <><p className="font-semibold">{t(current.state === 'reserved' ? 'Ресурсы зарезервированы' : current.state === 'released' ? 'Резерв ресурсов освобождён' : 'Ресурсы не зарезервированы')}</p><p>{t('Редакция брони')}: {current.revision}</p>
      {current.state === 'reserved' && data?.plan?.current && validPlan(data.plan.current) && current.planRevisionId !== data.plan.current.planRevisionId && <p>{t('Действует прежняя бронь. Новый план ещё не зарезервирован.')}</p>}
      {data?.catalog.actorRole === 'vendor' && <p>{t('Исполнитель видит бронь. Подтвердить или заменить её может пара.')}</p>}
      {!body && <p>{t('Для нового действия нужны актуальный непустой план, режим ресурсов и отдельные подтверждения пары и исполнителя одной редакции условий.')}</p>}
    </>}
    {pending ? <button className={button} disabled={busy} onClick={() => void execute(pending, true)}>{t('Проверить результат запроса')}</button> : <button className={button} disabled={busy} onClick={() => void reread()}>{t('Обновить сведения о брони')}</button>}
    {body && action === 'commit' && !pending && <button className={button} disabled={busy} onClick={() => void execute({ kind: 'commit', key: newIdempotencyKey(), body })}>{t('Забронировать заказ и ресурсы по согласованному плану')}</button>}
    {body && action === 'replace' && !pending && <div className="space-y-2"><p>{t('Прежняя бронь сохраняется до успешной замены. При конфликте ресурсов она останется действовать.')}</p><button className={button} disabled={busy} onClick={() => void execute({ kind: 'replace', key: newIdempotencyKey(), body })}>{t('Заменить бронь по новым согласованным условиям')}</button></div>}
  </div>
}
