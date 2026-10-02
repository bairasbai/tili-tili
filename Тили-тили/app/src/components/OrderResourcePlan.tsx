import { useEffect, useId, useRef, useState } from 'react'
import { getOrder, getOrderCatalog, getOrderResourcePlan, saveOrderResourcePlan, type WeddingOrder, type OrderCatalog, type ResourcePlanView, type ResourcePlanLineInput, type ResourcePlanWrite } from '@/lib/api/orders'
import { getVendorProfile } from '@/lib/api/vendor'
import { getVendorResources, type VendorResource } from '@/lib/api/resources'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { formatOrderLocal, parseOrderLocal } from '@/lib/orderTime'
import { getI18nLang, key, t } from '@/lib/i18n'

const control = 'block w-full min-w-0 max-w-full rounded-[12px] border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm'
const button = 'min-h-11 max-w-full whitespace-normal rounded-[12px] border border-[var(--line)] px-3 py-2 text-sm disabled:opacity-40'
const kinds = { person: key('Человек'), equipment: key('Оборудование'), capacity: key('Мощность или вместимость') }
const buffers = { setupMinutes: key('Подготовка до работы, минут'), teardownMinutes: key('Демонтаж после работы, минут'), travelBeforeMinutes: key('Дорога до работы, минут'), travelAfterMinutes: key('Дорога после работы, минут') }
type BufferKey = keyof typeof buffers
type PublicPlan = NonNullable<ResourcePlanView['current']>
type PublicLine = PublicPlan['lines'][number]
type Loaded = { order: WeddingOrder; catalog: OrderCatalog; plan: ResourcePlanView; vendorId: string | null; resources: VendorResource[] }
type Draft = { localId: number; partId: string; resourceId: string; capacityWindowId: string; quantity: string; timeZone: string; startsAt: string; endsAt: string; startOffset: string; endOffset: string; setupMinutes: string; teardownMinutes: string; travelBeforeMinutes: string; travelAfterMinutes: string; original?: ResourcePlanLineInput }
type Command = { key: string; body: ResourcePlanWrite }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(v)
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const only = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).every(k => fields.includes(k)) && fields.every(k => Object.hasOwn(v, k))
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 200
function equivalent(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => equivalent(item, b[i]))
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => Object.hasOwn(b, k) && equivalent(a[k], b[k]))
}
function instant(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) return false
  const y = Number(v.slice(0, 4)), m = Number(v.slice(5, 7)), d = Number(v.slice(8, 10)), offset = /[+-](\d{2}):(\d{2})$/.exec(v)
  return y > 0 && m >= 1 && m <= 12 && d > 0 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && Number(v.slice(11, 13)) < 24 && Number(v.slice(14, 16)) < 60 && Number(v.slice(17, 19)) < 60 && (!offset || (Number(offset[1]) <= 14 && Number(offset[2]) < 60 && (Number(offset[1]) !== 14 || Number(offset[2]) === 0)))
}
function zone(v: unknown): v is string { if (typeof v !== 'string' || !v || v.length > 100) return false; try { new Intl.DateTimeFormat('en', { timeZone: v }); return true } catch { return false } }
const inputKeys = ['partId', 'resourceId', 'capacityWindowId', 'quantity', 'startsAt', 'endsAt', 'timeZone', ...Object.keys(buffers)]
function validInput(v: unknown): v is ResourcePlanLineInput {
  return object(v) && only(v, inputKeys) && uuid(v.partId) && uuid(v.resourceId) && (v.capacityWindowId === null || uuid(v.capacityWindowId)) && integer(v.quantity, 1, 2_147_483_647) && instant(v.startsAt) && instant(v.endsAt) && Date.parse(v.endsAt) > Date.parse(v.startsAt) && zone(v.timeZone) && Object.keys(buffers).every(k => integer(v[k], 0, 1440))
}
function validLine(v: unknown): v is PublicLine {
  if (!object(v) || !only(v, ['partId', 'assignmentId', 'programEventId', 'label', 'kind', 'quantity', 'unit', 'startsAt', 'endsAt', 'timeZone', ...Object.keys(buffers), 'occupiedStartsAt', 'occupiedEndsAt', 'window']) || !uuid(v.partId) || !(v.assignmentId === null || uuid(v.assignmentId)) || !(v.programEventId === null || uuid(v.programEventId)) || (v.assignmentId === null) !== (v.programEventId === null) || !text(v.label) || !Object.hasOwn(kinds, String(v.kind)) || !integer(v.quantity, 1, 2_147_483_647) || !instant(v.startsAt) || !instant(v.endsAt) || Date.parse(v.endsAt) <= Date.parse(v.startsAt) || !zone(v.timeZone) || !Object.keys(buffers).every(k => integer(v[k], 0, 1440)) || !instant(v.occupiedStartsAt) || !instant(v.occupiedEndsAt)) return false
  if (Date.parse(v.occupiedStartsAt) !== Date.parse(v.startsAt) - (Number(v.setupMinutes) + Number(v.travelBeforeMinutes)) * 60000 || Date.parse(v.occupiedEndsAt) !== Date.parse(v.endsAt) + (Number(v.teardownMinutes) + Number(v.travelAfterMinutes)) * 60000) return false
  if (v.kind !== 'capacity') return v.quantity === 1 && v.unit === null && v.window === null
  return text(v.unit) && object(v.window) && only(v.window, ['startsAt', 'endsAt']) && instant(v.window.startsAt) && instant(v.window.endsAt) && Date.parse(v.window.startsAt) <= Date.parse(v.occupiedStartsAt) && Date.parse(v.window.endsAt) >= Date.parse(v.occupiedEndsAt)
}
function validPublic(v: unknown): v is PublicPlan {
  return object(v) && only(v, ['planRevisionId', 'revision', 'lines']) && uuid(v.planRevisionId) && version(v.revision) && Array.isArray(v.lines) && v.lines.length <= 100 && v.lines.every(validLine)
}
function checkPlan(v: unknown, role: string): asserts v is ResourcePlanView {
  if (!object(v) || !only(v, ['orderVersion', 'revision', 'canEdit', 'reservation', 'current', 'editorLines', 'source', 'history']) || !version(v.orderVersion) || !version(v.revision, true) || typeof v.canEdit !== 'boolean' || !['not_reserved', 'reserved', 'released'].includes(String(v.reservation)) || !['current', 'invalid', 'unavailable'].includes(String(v.source)) || !(v.current === null || validPublic(v.current)) || !Array.isArray(v.history) || !v.history.every(validPublic) || new Set(v.history.map(p => p.planRevisionId)).size !== v.history.length) throw new Error('Unconfirmed plan')
  if (v.current !== null && (v.current.revision !== v.revision || !v.history.some(p => equivalent(p, v.current)))) throw new Error('Unconfirmed plan head')
  if (v.current === null && v.source === 'current' && v.revision !== '0') throw new Error('Missing plan head')
  if (v.reservation !== 'not_reserved' && (v.current === null || v.revision === '0' || v.current.lines.length === 0)) throw new Error('Unconfirmed reservation plan')
  if (role === 'couple' && !v.canEdit && v.editorLines !== null) throw new ApiError('http', 403, 'plan_private_projection', '')
  // canEdit proves exact vendor ownership on the server, including an owner
  // who is also a couple member. The catalog role alone cannot grant editing.
  if (!(v.editorLines === null || (Array.isArray(v.editorLines) && v.editorLines.length <= 100 && v.editorLines.every(validInput))) || (v.canEdit && v.editorLines === null)) throw new Error('Unconfirmed plan editor')
}
function validResource(v: unknown): v is VendorResource {
  return object(v) && uuid(v.id) && text(v.label) && version(v.version) && Object.hasOwn(kinds, String(v.kind)) && ['current', 'unavailable'].includes(String(v.source)) && (v.retiredAt === null || instant(v.retiredAt)) && (v.kind === 'capacity' ? text(v.capacityUnit) : v.capacityUnit === null) && Array.isArray(v.windows) && v.windows.every(w => object(w) && uuid(w.id) && version(w.version) && instant(w.startsAt) && instant(w.endsAt) && Date.parse(w.endsAt) > Date.parse(w.startsAt) && integer(w.capacity, 1, 2_147_483_647) && integer(w.used, 0, Number(w.capacity))) && (v.source !== 'current' || v.retiredAt === null)
}
const privacy = (e: unknown) => e instanceof ApiError && [401, 403, 404, 410].includes(e.status)
function friendly(e: unknown): string {
  if (privacy(e)) return t('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.')
  if (e instanceof ApiError && [409, 422].includes(e.status)) return t('Сведения изменились. Обновите их и проверьте введённый план.')
  return t('Не удалось подтвердить план ресурсов. Попробуйте ещё раз.')
}
async function load(dealId: string, denied: (e: unknown) => void, expectedVendor?: string | null): Promise<Loaded> {
  async function guard<T>(request: Promise<T>): Promise<T> { try { return await request } catch (e) { if (privacy(e)) denied(e); throw e } }
  const [order, catalog, plan] = await Promise.all([guard(getOrder(dealId)), guard(getOrderCatalog(dealId)), guard(getOrderResourcePlan(dealId))])
  if (!order || order.dealId !== dealId || !version(order.version) || !Array.isArray(order.parts) || !Array.isArray(order.assignments) || !catalog || !uuid(catalog.weddingId) || !['couple', 'vendor'].includes(catalog.actorRole) || typeof catalog.draftEditable !== 'boolean') throw new Error('Unconfirmed order')
  checkPlan(plan, catalog.actorRole)
  if (plan.orderVersion !== order.version || (plan.canEdit && !catalog.draftEditable)) throw new Error('Mixed order versions')
  if (plan.source === 'current' && plan.current?.lines.some(line => {
    const part = order.parts.find(p => p.id === line.partId && p.cancelledAt === null)
    const assignment = line.assignmentId === null ? null : order.assignments.find(a => a.id === line.assignmentId && a.cancelledAt === null)
    return !part || part.assignmentId !== line.assignmentId || (line.assignmentId === null ? part.kind !== 'deliverable' : !assignment || assignment.programEventId !== line.programEventId)
  })) throw new Error('Unconfirmed work scope')
  let vendorId: string | null = null, resources: VendorResource[] = []
  if (plan.canEdit) {
    const profile = await guard(getVendorProfile())
    if (!profile || !uuid(profile.id)) throw new Error('Unconfirmed company')
    vendorId = profile.id
    if (expectedVendor !== undefined && expectedVendor !== vendorId) { const error = new ApiError('http', 403, 'plan_company_changed', ''); denied(error); throw error }
    resources = await guard(getVendorResources(vendorId))
    if (!Array.isArray(resources) || !resources.every(validResource) || new Set(resources.map(r => r.id)).size !== resources.length) throw new Error('Unconfirmed resources')
    // Revalidate private order authority after waiting for company data. Company
    // resource management alone never proves permission to this particular order.
    const [freshCatalog, freshPlan] = await Promise.all([guard(getOrderCatalog(dealId)), guard(getOrderResourcePlan(dealId))])
    checkPlan(freshPlan, freshCatalog.actorRole)
    if (freshCatalog.actorRole !== catalog.actorRole || freshCatalog.weddingId !== catalog.weddingId || !freshCatalog.draftEditable || !freshPlan.canEdit) throw new ApiError('http', 403, 'plan_access_changed', '')
    if (freshPlan.orderVersion !== order.version || !equivalent(freshPlan, plan)) throw new Error('Plan changed while loading')
  }
  return { order, catalog, plan, vendorId, resources }
}
const blank = (id: number): Draft => ({ localId: id, partId: '', resourceId: '', capacityWindowId: '', quantity: '', timeZone: '', startsAt: '', endsAt: '', startOffset: '', endOffset: '', setupMinutes: '', teardownMinutes: '', travelBeforeMinutes: '', travelAfterMinutes: '' })
function drafts(plan: ResourcePlanView): Draft[] { return (plan.editorLines ?? []).map((line, index) => ({ ...blank(index + 1), ...Object.fromEntries(Object.keys(buffers).map(k => [k, String(line[k as BufferKey])])), partId: line.partId, resourceId: line.resourceId, capacityWindowId: line.capacityWindowId ?? '', quantity: String(line.quantity), timeZone: line.timeZone, startsAt: formatOrderLocal(line.startsAt, line.timeZone) ?? '', endsAt: formatOrderLocal(line.endsAt, line.timeZone) ?? '', original: line })) }
function numeric(s: string, min: number, max: number): number | null { if (!/^(0|[1-9]\d{0,9})$/.test(s)) return null; const n = Number(s); return integer(n, min, max) ? n : null }
function lineInput(d: Draft, data: Loaded): ResourcePlanLineInput | null {
  const resource = data.resources.find(r => r.id === d.resourceId && r.source === 'current' && r.retiredAt === null), part = data.order.parts.find(p => p.id === d.partId && p.cancelledAt === null)
  if (!resource || !part || (part.assignmentId !== null && !data.order.assignments.some(a => a.id === part.assignmentId && a.cancelledAt === null)) || (part.assignmentId === null && part.kind !== 'deliverable') || !zone(d.timeZone)) return null
  const quantity = resource.kind === 'capacity' ? numeric(d.quantity, 1, 2_147_483_647) : 1, b = Object.fromEntries(Object.keys(buffers).map(k => [k, numeric(d[k as BufferKey], 0, 1440)]))
  if (quantity === null || Object.values(b).some(v => v === null)) return null
  const resolve = (name: 'startsAt' | 'endsAt', offset: string): string | null => {
    const original = d.original
    // A quantity-only edit must preserve the original seconds and milliseconds.
    if (original && d.timeZone === original.timeZone && d[name] === formatOrderLocal(original[name], original.timeZone) && !offset) return original[name]
    const result = parseOrderLocal(d[name], d.timeZone, offset === '' ? undefined : Number(offset))
    return result.status === 'valid' ? result.candidate.instant : null
  }
  const startsAt = resolve('startsAt', d.startOffset), endsAt = resolve('endsAt', d.endOffset)
  if (!startsAt || !endsAt || Date.parse(endsAt) <= Date.parse(startsAt)) return null
  const setupMinutes = b.setupMinutes!, teardownMinutes = b.teardownMinutes!, travelBeforeMinutes = b.travelBeforeMinutes!, travelAfterMinutes = b.travelAfterMinutes!
  const capacityWindowId = resource.kind === 'capacity' ? d.capacityWindowId : null
  if (resource.kind === 'capacity') {
    const w = resource.windows.find(w => w.id === capacityWindowId)
    if (!w || Date.parse(w.startsAt) > Date.parse(startsAt) - (setupMinutes + travelBeforeMinutes) * 60000 || Date.parse(w.endsAt) < Date.parse(endsAt) + (teardownMinutes + travelAfterMinutes) * 60000) return null
  }
  return { partId: d.partId, resourceId: resource.id, capacityWindowId, quantity, startsAt, endsAt, timeZone: d.timeZone, setupMinutes, teardownMinutes, travelBeforeMinutes, travelAfterMinutes }
}
function showTime(value: string, timeZone: string): string { return new Intl.DateTimeFormat(getI18nLang(), { timeZone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) }
function PublicReader({ plan, order }: { plan: PublicPlan; order: WeddingOrder }) {
  return <div className="min-w-0 space-y-3"><p className="text-xs">{t('Редакция плана')}: {plan.revision}</p>{!plan.lines.length && <p>{t('План очищен. Ресурсы не указаны.')}</p>}{plan.lines.map((line, index) => <article key={index} className="min-w-0 space-y-1 rounded-[12px] border border-[var(--line)] p-3">
    <p className="font-semibold">{line.label}</p><p>{t(kinds[line.kind])} · {line.quantity}{line.unit ? ' ' + line.unit : ''}</p>
    <p>{t('Текущее название работы')}: {order.parts.find(p => p.id === line.partId)?.title ?? t('Название работы больше недоступно')}</p><p>{line.assignmentId === null ? t('Без назначения на мероприятие') : t('Текущее название назначения') + ': ' + (order.assignments.find(a => a.id === line.assignmentId)?.label ?? t('Название назначения больше недоступно'))}</p>
    <p>{t('Начало использования')}: {showTime(line.startsAt, line.timeZone)}</p><p>{t('Окончание использования')}: {showTime(line.endsAt, line.timeZone)}</p><p>{t('Часовой пояс')}: {line.timeZone}</p>
    {Object.entries(buffers).map(([name, label]) => <p key={name}>{t(label)}: {line[name as BufferKey]}</p>)}
    <p>{t('Полный период с подготовкой и дорогой')}: {showTime(line.occupiedStartsAt, line.timeZone)} — {showTime(line.occupiedEndsAt, line.timeZone)}</p>
    {line.window && <p>{t('Выбранное окно мощности')}: {showTime(line.window.startsAt, line.timeZone)} — {showTime(line.window.endsAt, line.timeZone)}</p>}
  </article>)}</div>
}

/** Voluntary in-memory planning. Saving never declares a reservation. */
export function OrderResourcePlan({ dealId }: { dealId: string }) {
  const [expired, setExpired] = useState(false)
  useEffect(() => { const clear = () => setExpired(true), a = onSessionChanged(clear), b = onSessionExpired(clear); return () => { a(); b() } }, [])
  return <PlanSection key={dealId} dealId={dealId} expired={expired} />
}
function PlanSection({ dealId, expired }: { dealId: string; expired: boolean }) {
  const [open, setOpen] = useState(false), [activated, setActivated] = useState(false), [denied, setDenied] = useState<string | null>(null)
  return <details open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setActivated(true) }} className="min-w-0 max-w-full break-words rounded-[16px] border border-[var(--line)] p-3">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('План ресурсов заказа')}</summary>
    {activated && <div hidden={!open}>{expired || denied ? <p role="alert">{expired ? t('Сессия изменилась — откройте заказ после входа заново') : denied}</p> : <PlanReader dealId={dealId} deny={setDenied} />}</div>}
  </details>
}
function PlanReader({ dealId, deny }: { dealId: string; deny: (s: string) => void }) {
  const [data, setData] = useState<Loaded | null>(null), [rows, setRows] = useState<Draft[]>([]), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null), [pending, setPending] = useState<Command | null>(null), [needsRead, setNeedsRead] = useState(false), [review, setReview] = useState(false)
  const alive = useRef(true), generation = useRef(0), flight = useRef(false), authority = useRef<{ role: string; wedding: string; vendor: string | null; edit: boolean } | null>(null), localId = useRef(100)
  const refresh = async (preserve = false) => {
    const gen = ++generation.current
    let next: Loaded
    try { next = await load(dealId, e => { if (alive.current && generation.current === gen) deny(friendly(e)) }, authority.current?.vendor) }
    catch (e) {
      // Shape/source checks can also discover a privacy boundary before the
      // loaded authority is compared. They must erase a previous owner editor.
      if (alive.current && generation.current === gen && privacy(e)) deny(friendly(e))
      throw e
    }
    if (!alive.current || generation.current !== gen) return
    const a = authority.current
    if (a && (a.role !== next.catalog.actorRole || a.wedding !== next.catalog.weddingId || a.vendor !== next.vendorId || (a.edit && !next.plan.canEdit))) { deny(t('Доступ к плану ресурсов закрыт. Откройте заказ после входа заново.')); return }
    authority.current = { role: next.catalog.actorRole, wedding: next.catalog.weddingId, vendor: next.vendorId, edit: next.plan.canEdit }
    setData(next); setNeedsRead(false)
    if (preserve) setReview(true)
    else { setRows(drafts(next.plan)); setDirty(false); setReview(false) }
  }
  useEffect(() => {
    alive.current = true; flight.current = true; setBusy(true)
    void refresh().catch(e => { if (alive.current) { setError(friendly(e)); setNeedsRead(true) } }).finally(() => { flight.current = false; if (alive.current) setBusy(false) })
    return () => { alive.current = false }
    // The reader is remounted for every deal/session boundary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const reread = () => {
    if (flight.current || pending) return
    flight.current = true; setBusy(true); setError(null)
    void refresh(dirty).catch(e => { if (alive.current) { setError(friendly(e)); setNeedsRead(true) } }).finally(() => { flight.current = false; if (alive.current) setBusy(false) })
  }
  const execute = async (command: Command) => {
    if (flight.current || !data?.plan.canEdit) return
    flight.current = true; setBusy(true); setError(null); setMessage(null)
    let received = false
    try {
      const reply = await saveOrderResourcePlan(dealId, command.body, command.key)
      if (!alive.current) return
      received = true; setPending(null); setNeedsRead(true)
      checkPlan(reply, data.catalog.actorRole)
      const sameLine = (a: ResourcePlanLineInput, b: ResourcePlanLineInput) => inputKeys.every(k => k === 'startsAt' || k === 'endsAt' ? Date.parse(a[k]) === Date.parse(b[k]) : a[k as keyof ResourcePlanLineInput] === b[k as keyof ResourcePlanLineInput])
      if (!reply.canEdit || BigInt(reply.orderVersion) < BigInt(command.body.expectedVersion) || BigInt(reply.revision) < BigInt(command.body.expectedPlanRevision) || !reply.editorLines || reply.editorLines.length !== command.body.lines.length || !reply.editorLines.every((line, i) => !!command.body.lines[i] && sameLine(line, command.body.lines[i]!))) throw new Error('Unconfirmed save')
      await refresh()
      if (alive.current) setMessage(t('План сохранён.'))
    } catch (e) {
      if (!alive.current) return
      if (privacy(e)) { deny(friendly(e)); return }
      const refused = e instanceof ApiError && [400, 409, 422].includes(e.status)
      setError(friendly(e))
      if (received || refused) { setPending(null); setNeedsRead(true); setReview(true) }
      else setPending(command)
    } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const submit = () => {
    if (flight.current || pending || needsRead || review || !data?.plan.canEdit || !dirty) return
    const lines = rows.map(row => lineInput(row, data))
    if (lines.some(v => v === null) || new Set(lines.map(v => JSON.stringify(v))).size !== lines.length) { setError(t('Выберите действующую работу и ресурс, укажите количество, время, часовой пояс и все дополнительные минуты.')); return }
    const body: ResourcePlanWrite = { expectedVersion: data.order.version, expectedPlanRevision: data.plan.revision, lines: lines as ResourcePlanLineInput[] }
    void execute({ key: newIdempotencyKey(), body })
  }
  const blocked = busy || !!pending || needsRead
  return <div className="min-w-0 space-y-3 pt-3">
    <p className="text-sm text-[var(--soft)]">{t('Необязательный план для этого заказа. Сохранение не резервирует людей, оборудование или мощность.')}</p>
    {busy && <p role="status">{t('Проверяем сведения плана…')}</p>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {pending ? <><p>{t('Ответ на сохранение не подтверждён. Повторится тот же запрос без изменения плана.')}</p><button type="button" disabled={busy} className={button} onClick={() => { void execute(pending) }}>{t('Проверить сохранение плана')}</button></> : <button type="button" disabled={busy} className={button} onClick={reread}>{t('Обновить сведения плана')}</button>}
    {data && <>
      <p className="text-xs">{t(data.plan.reservation === 'reserved' ? 'Ресурсы этой редакции зарезервированы' : data.plan.reservation === 'released' ? 'Бронь ресурсов этой редакции снята' : 'Ресурсы не зарезервированы')}</p>
      {data.plan.source !== 'current' && <p role="alert">{t(data.plan.source === 'invalid' ? 'Связи плана изменились. Проверьте работу, мероприятие и выбранные ресурсы.' : 'Выбранные ресурсы больше недоступны. История плана сохранена.')}</p>}
      {data.plan.current ? <PublicReader plan={data.plan.current} order={data.order} /> : <p>{t('План ресурсов ещё не указан')}</p>}
      {data.plan.canEdit && <form noValidate onSubmit={e => { e.preventDefault(); submit() }} className="min-w-0 space-y-3">
        <p className="text-xs">{t('Период использования выбирается отдельно от доставки или срока передачи результата. Дополнительные минуты указываются явно; 0 означает, что они не нужны.')}</p>
        <fieldset disabled={blocked} className="min-w-0 space-y-3"><legend className="text-sm font-semibold">{t('Ресурсы для работ заказа')}</legend>
          {rows.map((row, index) => <LineEditor key={row.localId} row={row} index={index} data={data} update={next => { setRows(old => old.map(item => item.localId === row.localId ? next : item)); setDirty(true); setMessage(null) }} remove={() => { setRows(old => old.filter(item => item.localId !== row.localId)); setDirty(true); setMessage(null) }} />)}
          <button type="button" disabled={rows.length >= 100} className={button} onClick={() => { setRows(old => [...old, blank(++localId.current)]); setDirty(true); setMessage(null) }}>{t('Добавить ресурс в план')}</button>
        </fieldset>
        {review && <p role="alert">{t('Ввод сохранён. Проверьте его по обновлённым сведениям перед новым сохранением.')}</p>}
        {review && !needsRead && <button type="button" disabled={blocked} className={button} onClick={() => setReview(false)}>{t('Проверил обновлённые сведения')}</button>}
        <button type="submit" disabled={blocked || review || !dirty} className={button}>{t('Сохранить план ресурсов')}</button>
      </form>}
      {!!data.plan.history.length && <details className="min-w-0"><summary className="min-h-11 cursor-pointer py-2 text-sm">{t('История планов ресурсов')}</summary>{data.plan.history.map(plan => <PublicReader key={plan.planRevisionId} plan={plan} order={data.order} />)}</details>}
    </>}
  </div>
}
const zoneNames: Record<string, string> = { 'Europe/Moscow': key('Москва'), 'Asia/Yekaterinburg': key('Екатеринбург / Уфа'), 'Europe/Berlin': key('Берлин'), 'Asia/Dubai': key('Дубай'), 'America/New_York': key('Нью-Йорк'), UTC: key('Всемирное время UTC') }
function zones(selected: string): string[] { return [...new Set([...Object.keys(zoneNames), ...(selected ? [selected] : []), ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [])])] }
function LineEditor({ row, index, data, update, remove }: { row: Draft; index: number; data: Loaded; update: (row: Draft) => void; remove: () => void }) {
  const id = useId(), resource = data.resources.find(r => r.id === row.resourceId), activeParts = data.order.parts.filter(p => p.cancelledAt === null && (p.assignmentId === null ? p.kind === 'deliverable' : data.order.assignments.some(a => a.id === p.assignmentId && a.cancelledAt === null)))
  const input = (name: keyof Draft, value: string) => update({ ...row, [name]: value })
  return <fieldset className="min-w-0 space-y-2 rounded-[12px] border border-[var(--line)] p-3"><legend className="text-sm">{t('Ресурс плана')} {index + 1}</legend>
    <label htmlFor={id + '-part'} className="block text-xs">{t('Работа для ресурса')}</label><select id={id + '-part'} className={control} value={row.partId} onChange={e => input('partId', e.target.value)}><option value="">{t('Выберите действующую работу')}</option>{activeParts.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select>
    <label htmlFor={id + '-resource'} className="block text-xs">{t('Ресурс компании для этой работы')}</label><select id={id + '-resource'} className={control} value={row.resourceId} onChange={e => update({ ...row, resourceId: e.target.value, capacityWindowId: '', quantity: '' })}><option value="">{t('Выберите действующий ресурс')}</option>{data.resources.filter(r => r.source === 'current' && r.retiredAt === null).map((r, index, available) => <option key={r.id} value={r.id}>{r.label} · {t(kinds[r.kind])}{available.filter(other => other.label === r.label && other.kind === r.kind).length > 1 ? ' · №' + (index + 1) : ''}</option>)}</select>
    {row.resourceId && (!resource || resource.source !== 'current' || resource.retiredAt !== null) && <p role="alert">{t('Выбранный ресурс больше недоступен. Выберите другой.')}</p>}
    <label htmlFor={id + '-zone'} className="block text-xs">{t('Часовой пояс периода использования')}</label><select id={id + '-zone'} className={control} value={row.timeZone} onChange={e => update({ ...row, timeZone: e.target.value, startOffset: '', endOffset: '' })}><option value="">{t('Выберите часовой пояс')}</option>{zones(row.timeZone).map(z => <option key={z} value={z}>{zoneNames[z] ? t(zoneNames[z]) + ' (' + z + ')' : z.replaceAll('_', ' ')}</option>)}</select>
    {resource?.kind === 'capacity' && <>
      <label htmlFor={id + '-window'} className="block text-xs">{t('Окно мощности для работы')}</label><select id={id + '-window'} className={control} value={row.capacityWindowId} onChange={e => input('capacityWindowId', e.target.value)}><option value="">{t('Выберите заявленное окно')}</option>{resource.windows.map(w => <option key={w.id} value={w.id}>{zone(row.timeZone) ? showTime(w.startsAt, row.timeZone) + ' — ' + showTime(w.endsAt, row.timeZone) : t('Время окна пока не показано — выберите часовой пояс')} · {w.capacity} {resource.capacityUnit} · {t('Учтено в обязательствах:')} {w.used}</option>)}</select>
      <label htmlFor={id + '-quantity'} className="block text-xs">{t('Количество для этого заказа')}</label><input id={id + '-quantity'} className={control} type="number" min="1" max="2147483647" step="1" value={row.quantity} onChange={e => input('quantity', e.target.value)} /><p className="text-xs">{t('Единица ресурса')}: {resource.capacityUnit}</p>
    </>}
    {resource && resource.kind !== 'capacity' && <p className="text-xs">{t('Для одного человека или отдельного предмета количество равно 1')}</p>}
    <PlanClock name={key('Начало использования')} value={row.startsAt} zone={row.timeZone} offset={row.startOffset} change={v => update({ ...row, startsAt: v, startOffset: '' })} choose={v => input('startOffset', v)} />
    <PlanClock name={key('Окончание использования')} value={row.endsAt} zone={row.timeZone} offset={row.endOffset} change={v => update({ ...row, endsAt: v, endOffset: '' })} choose={v => input('endOffset', v)} />
    <details className="min-w-0"><summary className="min-h-11 cursor-pointer py-2 text-xs">{t('Подготовка, демонтаж и дорога')}</summary><button type="button" className={button} onClick={() => update({ ...row, setupMinutes: '0', teardownMinutes: '0', travelBeforeMinutes: '0', travelAfterMinutes: '0' })}>{t('Дополнительное время не требуется')}</button>{Object.entries(buffers).map(([name, label]) => <div key={name}><label htmlFor={id + '-' + name} className="block text-xs">{t(label)}</label><input id={id + '-' + name} className={control} type="number" min="0" max="1440" step="1" value={row[name as BufferKey]} onChange={e => input(name as BufferKey, e.target.value)} /></div>)}</details>
    <button type="button" className={button} onClick={remove}>{t('Убрать строку плана')}</button>
  </fieldset>
}
function PlanClock({ name, value, zone: z, offset, change, choose }: { name: string; value: string; zone: string; offset: string; change: (v: string) => void; choose: (v: string) => void }) {
  const id = useId(), result = parseOrderLocal(value, z || null)
  return <div className="min-w-0 space-y-1"><label htmlFor={id} className="block text-xs">{t(name)}</label><input id={id} className={control} type="datetime-local" value={value} onChange={e => change(e.target.value)} />
    {value && result.status === 'gap' && <p role="alert">{t('Такого местного времени нет из-за перевода часов. Выберите другое время.')}</p>}
    {result.status === 'ambiguous' && <><label htmlFor={id + '-offset'} className="block text-xs">{t('Какое повторение времени выбрать:')} {t(name)}</label><select id={id + '-offset'} className={control} value={offset} onChange={e => choose(e.target.value)}><option value="">{t('Выберите повторение времени')}</option>{result.candidates.map((c, index) => <option key={c.instant} value={String(c.offsetMinutes)}>{t(index === 0 ? 'Первое повторение' : 'Второе повторение')} (UTC{c.offsetMinutes < 0 ? '−' : '+'}{Math.floor(Math.abs(c.offsetMinutes) / 60)}:{String(Math.abs(c.offsetMinutes) % 60).padStart(2, '0')})</option>)}</select></>}
  </div>
}
