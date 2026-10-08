import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { acceptOrderTerms, getOrder, getOrderCatalog, getOrderTerms, publishOrderTerms, type OrderBriefField, type OrderCatalog, type OrderTermsView, type PublishedOrderTerms, type WeddingOrder } from '@/lib/api/orders'
import { formatOrderLocal } from '@/lib/orderTime'
import { getI18nLang, key, t } from '@/lib/i18n'

type Row = { label: string; value: string }
type EventFact = { id: string; name: string; kind?: string; date: string | null; timeZone: string | null; location: string | null }
type Presented = { rows: Row[]; brief: Row[]; events: { title: string; rows: Row[] }[]; parts: { title: string; rows: Row[] }[]; resources: { title: string; rows: Row[] }[] | null; zone: string | null }
type Loaded = { order: WeddingOrder; catalog: OrderCatalog; terms: OrderTermsView }
type Command = { key: string; kind: 'publish' | 'accept'; run: (key: string) => Promise<OrderTermsView> }
const button = 'press min-h-11 max-w-full rounded-[12px] border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--rose-deep)]'
const unknown = () => t('Не указано')
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const version = (v: unknown, zero = false): v is string => typeof v === 'string' && (zero ? /^(0|[1-9]\d{0,18})$/ : /^[1-9]\d{0,18}$/).test(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4000
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw new Error('Unsupported frozen facts')
  return v as Record<string, unknown>
}
function nullableText(v: unknown): string | null { if (v !== null && !text(v)) throw new Error('Invalid text'); return v }
function id(v: unknown): string { if (!uuid(v)) throw new Error('Invalid identity'); return v }
function source(v: unknown): void { if (v !== 'legacy' && v !== 'structured') throw new Error('Invalid source') }
function date(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 1 || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw new Error('Invalid calendar date')
  return v
}
function zone(v: unknown): string | null {
  if (v === null) return null
  if (!text(v) || !v) throw new Error('Invalid zone')
  new Intl.DateTimeFormat('en', { timeZone: v }); return v
}
function instant(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) throw new Error('Invalid instant')
  date(v.slice(0, 10)); const offset = /[+-](\d{2}):(\d{2})$/.exec(v)
  if (Number(v.slice(11, 13)) > 23 || Number(v.slice(14, 16)) > 59 || Number(v.slice(17, 19)) > 59 || (offset && (Number(offset[1]) > 14 || Number(offset[2]) > 59 || (Number(offset[1]) === 14 && Number(offset[2]) !== 0)))) throw new Error('Invalid instant')
  return v
}
function calendar(v: string | null): string { return v === null ? unknown() : new Intl.DateTimeFormat(getI18nLang(), { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(v)) }
function clock(v: unknown, z: string | null): string {
  const time = instant(v); if (time === null) return unknown()
  if (z && !formatOrderLocal(time, z)) throw new Error('Unrenderable local instant')
  return new Intl.DateTimeFormat(getI18nLang(), { timeZone: z ?? 'UTC', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', ...(new Date(time).getUTCMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}), timeZoneName: 'shortOffset' }).format(new Date(time)) +
    (z === null ? ` · ${t('Часовой пояс мероприятия не указан; показано UTC')}` : '')
}
function money(v: unknown, currency: unknown): string {
  if (v === null) return unknown()
  if (typeof v !== 'string' || !/^\d{1,19}$/.test(v) || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new Error('Invalid amount')
  const fmt = new Intl.NumberFormat(getI18nLang(), { style: 'currency', currency }), digits = fmt.resolvedOptions().maximumFractionDigits
  if (digits === undefined) throw new Error('Unsupported currency precision')
  const scale = 10n ** BigInt(digits), amount = BigInt(v), parts = fmt.formatToParts(amount / scale)
  // Only the integral part enters Intl as BigInt. Fractional minor units never
  // pass through Number, including amounts above Number.MAX_SAFE_INTEGER.
  return parts.map(p => p.type === 'fraction' ? (amount % scale).toString().padStart(digits, '0') : p.value).join('')
}
const row = (label: string, value: string): Row => ({ label, value })
const eventKinds: Record<string, string> = { registration: key('Регистрация'), nikah: key('Никах'), ceremony: key('Церемония'), banquet: key('Банкет'), second_day: key('Второй день'), other: key('Другое мероприятие') }
const eventRows = (e: EventFact): Row[] => [...(e.kind ? [row(key('Вид мероприятия'), t(eventKinds[e.kind]))] : []), row(key('Дата мероприятия'), calendar(e.date)), row(key('Часовой пояс'), e.timeZone ?? unknown()), row(key('Место'), e.location ?? unknown())]
function eventFact(v: unknown, main = false): EventFact {
  const e = object(v, ['id', 'name', ...(main ? [] : ['kind']), 'date', 'timeZone', 'location'])
  if (!text(e.name) || !e.name.trim() || (!main && !['registration', 'nikah', 'ceremony', 'banquet', 'second_day', 'other'].includes(String(e.kind)))) throw new Error('Invalid event')
  return { id: id(e.id), name: e.name, ...(main ? {} : { kind: String(e.kind) }), date: date(e.date), timeZone: zone(e.timeZone), location: nullableText(e.location) }
}
const kinds = { timed_service: key('Работа на мероприятии'), appointment: key('Встреча или примерка'), supply: key('Поставка'), rental: key('Аренда'), deliverable: key('Готовый результат') }
const common = { location: key('Место'), recipient: key('Кто получает') }
const fields = {
  timed_service: { startsAt: key('Начало'), endsAt: key('Окончание'), location: common.location, setupMinutes: key('Подготовка, минут'), teardownMinutes: key('Демонтаж, минут'), travelMinutes: key('Дорога, минут') },
  appointment: { startsAt: key('Начало'), endsAt: key('Окончание'), location: common.location, setupMinutes: key('Подготовка, минут'), teardownMinutes: key('Демонтаж, минут'), travelMinutes: key('Дорога, минут') },
  supply: { quantity: key('Количество'), unit: key('Единица измерения'), windowStartsAt: key('Доставка от'), windowEndsAt: key('Доставка до'), ...common, substitutions: key('Допустимые замены') },
  rental: { quantity: key('Количество'), unit: key('Единица измерения'), handoverAt: key('Передача'), returnAt: key('Возврат'), ...common, condition: key('Описание состояния'), depositTerms: key('Пожелания по залогу') },
  deliverable: { items: key('Что передать'), dueAt: key('Срок передачи'), recipient: common.recipient, reviewProcess: key('Как проверить результат') },
}
function value(v: unknown, field: OrderBriefField): string {
  if (v === null) return unknown()
  if (field.type === 'date') return calendar(date(v))
  if (field.type === 'boolean') { if (typeof v !== 'boolean') throw new Error('Invalid boolean'); return t(v ? 'Да' : 'Нет') }
  if (field.type === 'integer') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || (field.min !== undefined && v < field.min) || (field.max !== undefined && v > field.max)) throw new Error('Invalid integer')
    return String(v)
  }
  if (field.type === 'string_array') {
    if (!Array.isArray(v) || !v.every(text) || v.length > (field.maxItems ?? 100) || v.some(item => item.length > (field.maxLength ?? 4000))) throw new Error('Invalid list')
    return v.length ? v.join('\n') : t('Список пуст')
  }
  if (field.type !== 'string' || !text(v) || v.length > (field.maxLength ?? 4000) || (field.options && !field.options.includes(v))) throw new Error('Invalid field')
  return v
}
/** Each supported schema is an immutable payload, not the current draft. Any unknown field
 * or omitted material fact blocks acceptance rather than hiding that fact. */
function present(term: PublishedOrderTerms, catalog: OrderCatalog, dealId: string): Presented {
  const schema = term.snapshot.schemaVersion
  const s = object(term.snapshot, ['schemaVersion', 'weddingId', 'dealId', 'source', 'categoryId', 'sourceOrderVersion', 'legacyContext', 'brief', 'assignments', 'parts', 'economics', ...(schema === 2 ? ['resourcePlan'] : [])])
  if ((schema !== 1 && schema !== 2) || id(s.dealId) !== dealId || id(s.weddingId) !== catalog.weddingId || s.categoryId !== catalog.category.categoryId || s.sourceOrderVersion !== term.sourceOrderVersion || !version(s.sourceOrderVersion)) throw new Error('Unsupported source')
  source(s.source)
  const context = object(s.legacyContext, ['mainEvent']), main = context.mainEvent === null ? null : eventFact(context.mainEvent, true)
  const economics = object(s.economics, ['amount', 'amountKnown', 'currency', 'performer', 'package'])
  if (economics.amountKnown !== (economics.amount !== null) || typeof economics.currency !== 'string' || !/^[A-Z]{3}$/.test(economics.currency)) throw new Error('Invalid money source')
  const performer = object(economics.performer, ['vendor', 'externalName', 'externalPhone']), pack = object(economics.package, ['id', 'titleSnapshot', 'includesSnapshot'])
  if (pack.id !== null) id(pack.id)
  const rows: Row[] = [row(key('Услуга'), t(catalog.category.label)), row(key('Цена этой редакции'), money(economics.amount, economics.currency))]
  if (performer.vendor !== null) {
    const vendor = object(performer.vendor, ['id', 'userId', 'name', 'categoryId']); id(vendor.id); id(vendor.userId)
    if (vendor.categoryId !== s.categoryId || !text(vendor.name) || !vendor.name.trim()) throw new Error('Invalid performer')
    rows.push(row(key('Исполнитель'), vendor.name))
  } else rows.push(row(key('Внешний контакт'), nullableText(performer.externalName) ?? unknown()))
  const externalName = nullableText(performer.externalName), externalPhone = nullableText(performer.externalPhone)
  if (performer.vendor !== null && externalName !== null) rows.push(row(key('Внешний контакт'), externalName))
  if (externalPhone !== null) rows.push(row(key('Телефон контакта'), externalPhone))
  rows.push(row(key('Пакет этой редакции'), nullableText(pack.titleSnapshot) ?? unknown()))
  if (pack.includesSnapshot !== null && (!Array.isArray(pack.includesSnapshot) || !pack.includesSnapshot.every(text))) throw new Error('Invalid frozen package')
  rows.push(row(key('Состав пакета этой редакции'), pack.includesSnapshot === null ? unknown() : (pack.includesSnapshot as string[]).join('\n') || t('Список пуст')))
  rows.push(row(key('Источник описания'), t(s.source === 'legacy' ? 'Сведения из прежнего заказа' : 'Структурированный состав заказа')))
  const brief: Row[] = []
  if (s.brief !== null) {
    const b = object(s.brief, ['categoryId', 'subtypeId', 'values'])
    if (b.categoryId !== s.categoryId) throw new Error('Incompatible brief')
    const subtype = b.subtypeId === undefined ? undefined : catalog.category.subtypes?.find(item => item.id === b.subtypeId)
    if (b.subtypeId !== undefined && !subtype) throw new Error('Unknown subtype')
    if (subtype) brief.push(row(key('Вариант услуги'), t(subtype.label)))
    // Catalog subtypes replace the generic brief, matching the publisher's
    // persisted-source validator; incompatible generic fields remain hidden.
    const definitions = subtype?.fields ?? catalog.category.fields
    const values = object(b.values, definitions.map(f => f.key))
    for (const [name, v] of Object.entries(values)) { const field = definitions.find(f => f.key === name); if (!field || !text(field.label)) throw new Error('Unknown brief field'); brief.push(row(field.label, value(v, field))) }
  }
  if (!Array.isArray(s.assignments) || !Array.isArray(s.parts) || s.assignments.length > 100 || s.parts.length > 500) throw new Error('Invalid work list')
  const assignmentIds = new Set<string>(), assignments = s.assignments.map(v => {
    const a = object(v, ['id', 'slotId', 'version', 'source', 'label', 'event']); const aId = id(a.id); id(a.slotId); source(a.source)
    if (assignmentIds.has(aId) || !version(a.version) || !text(a.label) || !a.label.trim()) throw new Error('Invalid assignment')
    assignmentIds.add(aId); return { id: aId, label: a.label, event: eventFact(a.event) }
  })
  const partScopes = new Map<string, { assignmentId: string | null; title: string }>()
  const partIds = new Set<string>(), parts = s.parts.map(v => {
    const p = object(v, ['id', 'kind', 'version', 'source', 'title', 'assignmentId', 'details']); const pId = id(p.id); source(p.source)
    if (partIds.has(pId) || !version(p.version) || !text(p.title) || !p.title.trim() || typeof p.kind !== 'string' || !Object.hasOwn(fields, p.kind)) throw new Error('Invalid part')
    partIds.add(pId); const kind = p.kind as keyof typeof fields
    const assignment = p.assignmentId === null ? undefined : assignments.find(a => a.id === id(p.assignmentId))
    if ((p.assignmentId !== null && !assignment) || (kind !== 'deliverable' && !assignment)) throw new Error('Unscoped work')
    partScopes.set(pId, { assignmentId: assignment?.id ?? null, title: p.title })
    const d = object(p.details, Object.keys(fields[kind])), z = assignment ? assignment.event.timeZone : main?.timeZone ?? null
    const detailRows = Object.entries(fields[kind]).map(([name, label]) => {
      const v = d[name]; let displayed: string
      if (name.endsWith('At')) displayed = clock(v, z)
      else if (name === 'quantity' || name.endsWith('Minutes')) displayed = value(v, { key: name, label, type: 'integer', group: 'core', min: name === 'quantity' ? 1 : 0, max: name === 'quantity' ? 1000000 : 10080 })
      else displayed = value(v, { key: name, label, type: name === 'items' ? 'string_array' : 'string', group: 'core', maxLength: name === 'unit' ? 80 : name === 'items' ? 500 : 2000, maxItems: 100 })
      return row(label, displayed)
    })
    for (const [a, b, equal] of [['startsAt', 'endsAt', false], ['windowStartsAt', 'windowEndsAt', false], ['handoverAt', 'returnAt', true]] as const) {
      if (d[a] !== undefined && d[a] !== null && d[b] !== undefined && d[b] !== null && (equal ? Date.parse(String(d[b])) < Date.parse(String(d[a])) : Date.parse(String(d[b])) <= Date.parse(String(d[a])))) throw new Error('Invalid interval')
    }
    return { title: p.title, rows: [row(key('Вид работы'), t(kinds[kind])), row(key('Мероприятие для работы'), assignment ? `${assignment.label} · ${assignment.event.name}` : t('Без назначения на мероприятие')), ...detailRows] }
  })
  let resources: Presented['resources'] = null
  if (schema === 2) {
    const plan = object(s.resourcePlan, ['planRevisionId', 'revision', 'lines']); id(plan.planRevisionId)
    if (!version(plan.revision) || !Array.isArray(plan.lines) || plan.lines.length > 100) throw new Error('Invalid frozen resource plan')
    rows.push(row(key('Редакция плана ресурсов'), plan.revision))
    resources = plan.lines.map(v => {
      const r = object(v, ['partId', 'assignmentId', 'programEventId', 'label', 'kind', 'quantity', 'unit', 'startsAt', 'endsAt', 'timeZone', 'setupMinutes', 'teardownMinutes', 'travelBeforeMinutes', 'travelAfterMinutes', 'occupiedStartsAt', 'occupiedEndsAt', 'window'])
      const partScope = partScopes.get(id(r.partId)), assignment = r.assignmentId === null ? null : assignments.find(a => a.id === id(r.assignmentId))
      if (!partScope || partScope.assignmentId !== r.assignmentId || (r.assignmentId !== null && !assignment) || r.programEventId !== (assignment?.event.id ?? null)) throw new Error('Unscoped resource promise')
      const z = zone(r.timeZone)
      if (z === null || !text(r.label) || !r.label.trim() || !['person', 'equipment', 'capacity'].includes(String(r.kind)) || typeof r.quantity !== 'number' || !Number.isSafeInteger(r.quantity) || r.quantity < 1 || r.quantity > 2147483647) throw new Error('Invalid resource promise')
      const a = instant(r.startsAt), b = instant(r.endsAt), occupiedA = instant(r.occupiedStartsAt), occupiedB = instant(r.occupiedEndsAt)
      if (!a || !b || !occupiedA || !occupiedB || Date.parse(a) >= Date.parse(b)) throw new Error('Invalid resource interval')
      for (const name of ['setupMinutes', 'teardownMinutes', 'travelBeforeMinutes', 'travelAfterMinutes']) {
        if (typeof r[name] !== 'number' || !Number.isSafeInteger(r[name]) || r[name] < 0 || r[name] > 1440) throw new Error('Invalid explicit resource buffer')
      }
      if (Date.parse(occupiedA) !== Date.parse(a) - (Number(r.setupMinutes) + Number(r.travelBeforeMinutes)) * 60000 ||
        Date.parse(occupiedB) !== Date.parse(b) + (Number(r.teardownMinutes) + Number(r.travelAfterMinutes)) * 60000) throw new Error('Unshown occupied interval')
      const resourceKinds = { person: key('Человек'), equipment: key('Оборудование'), capacity: key('Производственная мощность') }
      const resourceRows = [row(key('Вид ресурса'), t(resourceKinds[r.kind as keyof typeof resourceKinds])), row(key('Количество'), String(r.quantity)),
        row(key('Единица измерения'), nullableText(r.unit) ?? unknown()), row(key('Часовой пояс'), z), row(key('Начало'), clock(a, z)), row(key('Окончание'), clock(b, z)),
        row(key('Подготовка, минут'), String(r.setupMinutes)), row(key('Демонтаж, минут'), String(r.teardownMinutes)),
        row(key('Дорога до работы, минут'), String(r.travelBeforeMinutes)), row(key('Дорога после работы, минут'), String(r.travelAfterMinutes)),
        row(key('Занятость от'), clock(occupiedA, z)), row(key('Занятость до'), clock(occupiedB, z)),
        row(key('Мероприятие для работы'), assignment ? `${assignment.label} · ${assignment.event.name}` : t('Без назначения на мероприятие'))]
      if (r.kind === 'capacity') {
        const w = object(r.window, ['startsAt', 'endsAt']), wa = instant(w.startsAt), wb = instant(w.endsAt)
        if (!text(r.unit) || !r.unit.trim() || r.unit.length > 80 || !wa || !wb || Date.parse(wa) >= Date.parse(wb) || Date.parse(wa) > Date.parse(occupiedA) || Date.parse(wb) < Date.parse(occupiedB)) throw new Error('Invalid frozen capacity window')
        resourceRows.push(row(key('Окно мощности от'), clock(wa, z)), row(key('Окно мощности до'), clock(wb, z)))
      } else if (r.quantity !== 1 || r.unit !== null || r.window !== null) throw new Error('Invalid individual resource')
      return { title: `${partScope.title} · ${r.label}`, rows: resourceRows }
    })
  }
  return { rows, brief, events: [...(main ? [{ title: main.name, rows: eventRows(main) }] : []), ...assignments.map(a => ({ title: `${a.label} · ${a.event.name}`, rows: eventRows(a.event) }))], parts, resources, zone: main?.timeZone ?? null }
}
function checkView(v: OrderTermsView): void {
  if (!v || !version(v.revision, true) || !Array.isArray(v.history) || typeof v.acceptedByCaller !== 'boolean' || (v.readToken !== null && typeof v.readToken !== 'string')) throw new Error('Unconfirmed terms')
  for (const term of v.history) {
    id(term.id); if (!version(term.version) || !version(term.sourceOrderVersion) || !/^[0-9a-f]{64}$/.test(term.digest) || !/^[0-9a-f]{64}$/.test(term.sourceFingerprint) || !['customer', 'performer'].includes(term.publishedSide) || !['current', 'stale', 'unavailable', 'invalid'].includes(term.freshness) || typeof term.acceptedByCaller !== 'boolean' || !Array.isArray(term.receipts)) throw new Error('Invalid terms metadata')
    if (term.publishedBy !== null) id(term.publishedBy); if (instant(term.publishedAt) === null) throw new Error('Missing publication time')
    const parties = new Set<string>()
    for (const receipt of term.receipts) { id(receipt.id); if (receipt.userId !== null) id(receipt.userId); if (receipt.sessionId !== null) id(receipt.sessionId)
      if (!['customer', 'performer'].includes(receipt.party) || parties.has(receipt.party) || receipt.digest !== term.digest || instant(receipt.acceptedAt) === null) throw new Error('Invalid actual receipt'); parties.add(receipt.party) }
    if (term.acceptedByCaller && !term.receipts.some(receipt => receipt.userId !== null)) throw new Error('Unconfirmed personal attribution')
  }
  if (new Set(v.history.map(term => term.id)).size !== v.history.length) throw new Error('Repeated history')
  for (const pointer of [v.proposedTermsId, v.agreedTermsId]) if (pointer !== null && (!uuid(pointer) || !v.history.some(term => term.id === pointer))) throw new Error('Unknown terms pointer')
  if (v.selected !== null && (!v.history.some(term => JSON.stringify(term) === JSON.stringify(v.selected)) || v.acceptedByCaller !== v.selected.acceptedByCaller)) throw new Error('Unconfirmed selected terms')
  if (v.readToken !== null && (v.selected?.id !== v.proposedTermsId || v.selected?.freshness !== 'current')) throw new Error('Unscoped proof')
}
async function load(dealId: string, termsId?: string): Promise<Loaded> {
  const [order, catalog, terms] = await Promise.all([getOrder(dealId), getOrderCatalog(dealId), getOrderTerms(dealId, termsId)])
  if (!order || order.dealId !== dealId || !version(order.version) || !catalog || !uuid(catalog.weddingId) || !['couple', 'vendor'].includes(catalog.actorRole) || typeof catalog.draftEditable !== 'boolean' || !Array.isArray(catalog.category?.fields)) throw new Error('Unconfirmed order authority')
  checkView(terms); return { order, catalog, terms }
}

/** An optional reader. Collapse preserves only an uncertain intention in memory;
 * a session/deal boundary destroys the entire private reader. No polling. */
export function OrderTerms({ dealId }: { dealId: string }) {
  const [expired, setExpired] = useState(false)
  useEffect(() => { const changed = onSessionChanged(() => setExpired(true)), died = onSessionExpired(() => setExpired(true)); return () => { changed(); died() } }, [])
  return <TermsSection key={dealId} dealId={dealId} expired={expired} />
}
function TermsSection({ dealId, expired }: { dealId: string; expired: boolean }) {
  const [open, setOpen] = useState(false), [activated, setActivated] = useState(false)
  return <details open={open} onToggle={e => { setOpen(e.currentTarget.open); if (e.currentTarget.open) setActivated(true) }} className="min-w-0 max-w-full break-words rounded-2xl border border-[var(--line)] p-3">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Согласование условий')}</summary>
    {activated && <div hidden={!open}>{expired ? <p role="alert">{t('Сессия изменилась — откройте заказ после входа заново')}</p> : <TermsReader dealId={dealId} />}</div>}
  </details>
}
function TermsReader({ dealId }: { dealId: string }) {
  const [data, setData] = useState<Loaded | null>(null), [busy, setBusy] = useState(false), [closed, setClosed] = useState(false)
  const [message, setMessage] = useState<string | null>(null), [reviewed, setReviewed] = useState(false), [factsOpened, setFactsOpened] = useState(false), [pending, setPending] = useState<Command | null>(null), [needsRefresh, setNeedsRefresh] = useState(false)
  const alive = useRef(true), flight = useRef(false), authority = useRef<{ role: string; wedding: string } | null>(null), labelId = useId()
  const deny = (error: unknown) => {
    if (!alive.current) return
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) { setClosed(true); setData(null); setPending(null) }
    setMessage(explainError(error)); setReviewed(false)
  }
  const refresh = async (termsId?: string) => {
    const next = await load(dealId, termsId)
    if (!alive.current) return
    if (authority.current && (authority.current.role !== next.catalog.actorRole || authority.current.wedding !== next.catalog.weddingId)) throw new ApiError('http', 403, 'order_access_changed', t('Доступ к заказу изменился. Откройте раздел заново.'))
    authority.current = { role: next.catalog.actorRole, wedding: next.catalog.weddingId }; setData(next); setReviewed(false); setFactsOpened(false); setNeedsRefresh(false)
  }
  useEffect(() => {
    alive.current = true; let active = true
    void load(dealId).then(next => { if (active) { authority.current = { role: next.catalog.actorRole, wedding: next.catalog.weddingId }; setData(next) } }).catch(error => {
      if (active) { if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) setClosed(true); setMessage(explainError(error)) }
    })
    return () => { active = false; alive.current = false }
  }, [dealId])
  const reread = async (termsId?: string) => {
    if (flight.current || closed || pending) return
    flight.current = true; setBusy(true); setReviewed(false); setNeedsRefresh(true)
    setData(old => old ? { ...old, terms: { ...old.terms, readToken: null } } : null)
    try { await refresh(termsId) } catch (error) { deny(error) } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  const execute = async (command: Command) => {
    if (flight.current || closed || !data?.catalog.draftEditable) return
    flight.current = true; setBusy(true); setReviewed(false); setMessage(null)
    setData(old => old ? { ...old, terms: { ...old.terms, readToken: null } } : null)
    let confirmed = false
    try {
      const reply = await command.run(command.key); checkView(reply); confirmed = true
      if (!alive.current) return
      setPending(null); setNeedsRefresh(true)
      // Saved response bodies may describe an older proposal. Only a fresh GET
      // supplies the next reader's proof and current authority/material facts.
      await refresh(); if (alive.current) setMessage(t(command.kind === 'publish' ? 'Редакция опубликована. Откройте подробности и проверьте её.' : 'Ответ сохранён. Показана актуальная редакция условий.'))
    } catch (error) {
      if (!alive.current) return
      if (error instanceof ApiError && (error.status === 409 || error.status === 422)) { setPending(null); setNeedsRefresh(true); setMessage(t('Условия нужно обновить и проверить заново перед новым действием.')) }
      else if (!confirmed && (!(error instanceof ApiError) || error.isDown)) { setPending(command); setMessage(t('Ответ не получен. Проверьте результат тем же запросом.')) }
      else deny(error)
    } finally { flight.current = false; if (alive.current) setBusy(false) }
  }
  if (closed) return <p role="alert" className="text-sm">{message}</p>
  if (!data) return <div className="pt-2">{message ? <><p role="alert">{message}</p><button className={button} disabled={busy} onClick={() => void reread()}>{t('Повторить')}</button></> : <p>{t('Загружаем…')}</p>}</div>
  const { terms, catalog, order } = data, selected = terms.selected
  let facts: Presented | null = null
  try { if (selected) facts = present(selected, catalog, dealId) } catch { /* Do not conceal unrenderable material facts and permit acceptance. */ }
  const selectedParty = catalog.actorRole === 'couple' ? 'customer' : 'performer', acceptedParty = selected?.receipts.some(r => r.party === selectedParty)
  const current = selected?.id === terms.proposedTermsId && selected?.freshness === 'current', blocked = busy || !!pending || needsRefresh
  const canAccept = !!facts && current && !!terms.readToken && catalog.draftEditable && !acceptedParty && !blocked
  const numberOf = (id: string | null) => id === null ? t('Нет') : terms.history.find(term => term.id === id)?.version ?? unknown()
  return <div className="min-w-0 space-y-3 pt-2">
    <p className="text-xs text-[var(--soft)]">{t('Необязательное согласование описания заказа. Принятие этой редакции не меняет оплату или бронь.')}</p>
    <p className="text-xs">{t('Предложенная редакция')}: {numberOf(terms.proposedTermsId)} · {t('Согласованная редакция')}: {numberOf(terms.agreedTermsId)}</p>
    {terms.agreedTermsId !== null && <p className="text-xs" role="note">{t('Цена по согласованным условиям защищена от прямой правки. Изменение цены через новые условия пока недоступно.')}</p>}
    {!catalog.draftEditable && <p className="text-xs">{t('Заказ закрыт для изменений. История условий доступна для просмотра.')}</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {pending ? <button className={button} disabled={busy} onClick={() => void execute(pending)}>{t('Проверить результат запроса')}</button> : <button className={button} disabled={busy} onClick={() => void reread()}>{t('Открыть актуальные условия')}</button>}
    {terms.history.length > 0 && <label className="block text-sm">{t('Редакция для просмотра')}<select className="block min-h-11 max-w-full rounded-xl border border-[var(--line)] px-3" value={selected?.id ?? ''} disabled={blocked} onChange={e => void reread(e.target.value)}>{terms.history.map(term => <option key={term.id} value={term.id}>{t('Редакция')} {term.version}{term.id === terms.agreedTermsId ? ` · ${t('Согласована')}` : ''}{term.id === terms.proposedTermsId ? ` · ${t('Предложена')}` : ''}</option>)}</select></label>}
    {!selected && <p>{t('Условия ещё не опубликованы')}</p>}
    {selected && <>
      <p className="text-sm">{t('Редакция')} {selected.version} · {t('Опубликована со стороны')} {t(selected.publishedSide === 'customer' ? 'пары' : 'исполнителя')}</p>
      <p className="text-xs">{t('Время публикации')}: {clock(selected.publishedAt, facts?.zone ?? null)}</p>
      {selected.freshness !== 'current' && <p role="alert" className="text-sm">{t(selected.freshness === 'stale' ? 'Описание заказа изменилось. Эта редакция сохранена как история.' : selected.freshness === 'unavailable' ? 'Исполнитель недоступен для нового согласования.' : 'Текущий черновик нельзя проверить. История принятия сохранена.')}</p>}
      {!facts ? <p role="alert">{t('Эту редакцию нельзя полностью показать. Принятие недоступно.')}</p> : <details key={`${selected.id}:${terms.readToken ?? ''}`} className="min-w-0" onToggle={e => { if (e.currentTarget.open) setFactsOpened(true) }}><summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Подробности сохранённой редакции')}</summary>
        <Facts rows={facts.rows} />
        <h4 className="text-sm font-semibold mt-3">{t('Пожелания в этой редакции')}</h4>{facts.brief.length ? <Facts rows={facts.brief} /> : <p className="text-xs">{t('Пожелания не описаны')}</p>}
        <h4 className="text-sm font-semibold mt-3">{t('Мероприятия этой редакции')}</h4>{facts.events.length ? facts.events.map((event, index) => <div key={index} className="mt-2"><p className="text-sm font-semibold">{event.title}</p><Facts rows={event.rows} /></div>) : <p className="text-xs">{t('Мероприятия не описаны')}</p>}
        <h4 className="text-sm font-semibold mt-3">{t('Работы этой редакции')}</h4>{facts.parts.length ? facts.parts.map((part, index) => <div key={index} className="mt-2"><p className="text-sm font-semibold">{part.title}</p><Facts rows={part.rows} /></div>) : <p className="text-xs">{t('Работы не описаны')}</p>}
        {facts.resources !== null && <><h4 className="text-sm font-semibold mt-3">{t('Ресурсы этой редакции')}</h4><p className="text-xs">{t('План ресурсов не является резервом. Занятость проверяется отдельно.')}</p>{facts.resources.length ? facts.resources.map((resource, index) => <div key={index} className="mt-2"><p className="text-sm font-semibold">{resource.title}</p><Facts rows={resource.rows} /></div>) : <p className="text-xs">{t('Ресурсы не указаны')}</p>}</>}
      </details>}
      <div className="space-y-1 text-xs" aria-label={t('Ответы сторон по этой редакции')}>{selected.receipts.length ? selected.receipts.map(receipt => <p key={receipt.id}>{t(receipt.party === 'customer' ? 'Принято со стороны пары' : 'Принято со стороны исполнителя')} · {clock(receipt.acceptedAt, facts?.zone ?? null)}{receipt.userId === null ? ` · ${t('Аккаунт автора удалён')}` : ''}</p>) : <p>{t('Принятие этой редакции пока не записано')}</p>}{selected.acceptedByCaller && <p>{t('Ваше принятие этой редакции записано')}</p>}{acceptedParty && !selected.acceptedByCaller && <p>{t('Ответ вашей стороны уже записан другим участником')}</p>}</div>
      {canAccept && <div className="space-y-2">{!factsOpened && <p className="text-xs">{t('Откройте подробности перед принятием')}</p>}<label htmlFor={labelId} className="flex gap-2 items-start text-sm"><input id={labelId} type="checkbox" disabled={!factsOpened} checked={reviewed} onChange={e => setReviewed(e.target.checked)} className="mt-1" />{t('Я ознакомился с этой редакцией и хочу принять её условия')}</label>
        <button className={button} disabled={!reviewed || !factsOpened} onClick={() => { if (reviewed && factsOpened && canAccept) { const body = { expectedTermsVersion: selected.version, digest: selected.digest, readToken: terms.readToken! }; void execute({ key: newIdempotencyKey(), kind: 'accept', run: key => acceptOrderTerms(dealId, selected.id, body, key) }) } }}>{t('Принять эту редакцию')}</button></div>}
    </>}
    {catalog.draftEditable && <button className={button} disabled={blocked} onClick={() => { if (!blocked) { const body = { expectedOrderVersion: order.version, expectedTermsRevision: terms.revision }; void execute({ key: newIdempotencyKey(), kind: 'publish', run: key => publishOrderTerms(dealId, body, key) }) } }}>{t('Предложить текущий состав заказа')}</button>}
  </div>
}
function Facts({ rows }: { rows: Row[] }) { return <dl className="min-w-0 space-y-2 text-xs">{rows.map((item, index) => <div key={index}><dt className="font-semibold">{t(item.label)}</dt><dd className="whitespace-pre-wrap break-words">{item.value}</dd></div>)}</dl> }
