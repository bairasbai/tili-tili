import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getSlots, getWeddingEvents } from '@/lib/api/weddingData'
import { cancelOrderAssignment, cancelOrderPart, createOrderAssignment, createOrderPart, getOrder, getOrderCatalog, patchOrderBrief, patchOrderExternalContact, patchOrderPart, type OrderBriefField, type OrderCatalog, type WeddingOrder } from '@/lib/api/orders'
import { formatOrderLocal, parseOrderLocal } from '@/lib/orderTime'
import { getI18nLang, key, t } from '@/lib/i18n'
import { AsyncState, ready } from './AsyncState'

type Part = WeddingOrder['parts'][number]
type Kind = Part['kind']
type Value = string | string[] | number | boolean | null
type Values = Record<string, Value>
type Field = Omit<OrderBriefField, 'type'> & { type: OrderBriefField['type'] | 'datetime' }
type Snapshot = { order: WeddingOrder; catalog: OrderCatalog }
type Command = { key: string; scope: string; run: (key: string) => Promise<WeddingOrder> }
type Send = (run: Command['run'], scope?: string) => void
const control = 'w-full min-w-0 max-w-full min-h-11 rounded-[12px] border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm text-[var(--ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--rose-deep)]'
const button = 'press min-h-11 max-w-full rounded-[12px] border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm font-semibold text-[var(--ink)] disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--rose-deep)]'
const kindLabels: Record<Kind, string> = { timed_service: key('Работа на мероприятии'), supply: key('Поставка'), rental: key('Аренда'), deliverable: key('Готовый результат'), appointment: key('Встреча или примерка') }
const f = (name: string, label: string, type: Field['type'] = 'string', group: Field['group'] = 'optional', min?: number, max?: number): Field =>
  ({ key: name, label: key(label), type, group, ...(type === 'string' ? { maxLength: 2000 } : {}), ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })
const interval = [f('startsAt', 'Начало', 'datetime', 'core'), f('endsAt', 'Окончание', 'datetime', 'core'), f('location', 'Место'), f('setupMinutes', 'Подготовка, минут', 'integer', 'optional', 0, 10080), f('teardownMinutes', 'Демонтаж, минут', 'integer', 'optional', 0, 10080), f('travelMinutes', 'Дорога, минут', 'integer', 'optional', 0, 10080)]
const quantity = [f('quantity', 'Количество', 'integer', 'core', 1, 1000000), { ...f('unit', 'Единица измерения', 'string', 'core'), maxLength: 80 }]
const partFields: Record<Kind, Field[]> = {
  timed_service: interval, appointment: interval,
  supply: [...quantity, f('windowStartsAt', 'Доставка от', 'datetime'), f('windowEndsAt', 'Доставка до', 'datetime'), f('location', 'Место'), f('recipient', 'Кто получает'), f('substitutions', 'Допустимые замены')],
  rental: [...quantity, f('handoverAt', 'Передача', 'datetime'), f('returnAt', 'Возврат', 'datetime'), f('location', 'Место'), f('recipient', 'Кто получает'), f('condition', 'Описание состояния'), f('depositTerms', 'Пожелания по залогу')],
  deliverable: [{ ...f('items', 'Что передать', 'string_array', 'core'), maxLength: 500, maxItems: 100 }, f('dueAt', 'Срок передачи', 'datetime', 'core'), f('recipient', 'Кто получает'), f('reviewProcess', 'Как проверить результат')],
}

async function load(dealId: string): Promise<Snapshot> {
  const [order, catalog] = await Promise.all([getOrder(dealId), getOrderCatalog(dealId)])
  if (!order || !catalog || order.dealId !== dealId || !/^[1-9]\d*$/.test(order.version) || !['couple', 'vendor'].includes(catalog.actorRole)
    || typeof catalog.draftEditable !== 'boolean' || !Array.isArray(catalog.eligiblePositions) || !Array.isArray(catalog.assignmentTimeZones)
    || !Array.isArray(order.parts) || !Array.isArray(order.assignments) || !Array.isArray(catalog.category?.fields)) throw new Error('Unconfirmed order')
  return { order, catalog }
}

/** Optional, private draft. Ordinary collapse retains an uncertain operation's
 * exact replay key/body. Deal and session boundaries destroy private state. */
type DraftProps = { dealId: string; initiallyOpen?: boolean | undefined; onExternalContactChanged?: (() => void) | undefined }
export function OrderDraft({ dealId, initiallyOpen = false, onExternalContactChanged }: DraftProps) {
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const clear = () => setExpired(true)
    const stopExpired = onSessionExpired(clear), stopChanged = onSessionChanged(clear)
    return () => { stopExpired(); stopChanged() }
  }, [])
  return <OrderSection key={dealId} dealId={dealId} expired={expired} initiallyOpen={initiallyOpen} onExternalContactChanged={onExternalContactChanged} />
}
function OrderSection({ dealId, expired, initiallyOpen, onExternalContactChanged }: DraftProps & { expired: boolean }) {
  const [open, setOpen] = useState(initiallyOpen ?? false)
  const [activated, setActivated] = useState(initiallyOpen ?? false)
  return <details open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setActivated(true) }} className="min-w-0 max-w-full break-words rounded-2xl border border-[var(--line)] p-3">
    <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold">{t('Состав заказа')}</summary>
    {activated && <div hidden={!open}>{expired ? <p role="alert">{t('Сессия истекла — войдите снова')}</p> : <OrderRead dealId={dealId} onExternalContactChanged={onExternalContactChanged} />}</div>}
  </details>
}
function OrderRead({ dealId, onExternalContactChanged }: DraftProps) {
  const q = useApi(() => load(dealId), [dealId])
  return <><AsyncState q={q} {...(q.forbiddenText === undefined ? {} : { forbiddenText: q.forbiddenText })} />{ready(q) && !q.refreshing && q.data && <OrderEditor dealId={dealId} initial={q.data} onExternalContactChanged={onExternalContactChanged} />}</>
}

function OrderEditor({ dealId, initial, onExternalContactChanged }: DraftProps & { initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial), [busy, setBusy] = useState(false), [closed, setClosed] = useState(false)
  const [message, setMessage] = useState<string | null>(null), [pending, setPending] = useState<Command | null>(null)
  const [needsRefresh, setNeedsRefresh] = useState(false), [review, setReview] = useState(false), [epochs, setEpochs] = useState<Record<string, number>>({})
  const [savedAwaitingRefresh, setSavedAwaitingRefresh] = useState<Command | null>(null)
  const [adding, setAdding] = useState(false), [editing, setEditing] = useState<string | null>(null), [assigning, setAssigning] = useState(false)
  const alive = useRef(true), inFlight = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const { order, catalog } = snapshot
  const complete = (command: Command) => {
    setSavedAwaitingRefresh(null); setEpochs(previous => ({ ...previous, [command.scope]: (previous[command.scope] ?? 0) + 1 }))
    if (command.scope === 'new') setAdding(false)
    if (command.scope.startsWith('part:')) setEditing(null)
    if (command.scope === 'assignment') setAssigning(false)
    if (command.scope === 'external-contact') { setMessage(t('Внешний контакт сохранён')); onExternalContactChanged?.() }
    else setMessage(t('Черновик сохранён'))
  }
  const deny = (error: unknown) => {
    if (!alive.current) return
    if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) { setClosed(true); setPending(null) }
    setMessage(explainError(error))
  }
  const refresh = async (conflict: boolean) => {
    const next = await load(dealId)
    if (!alive.current) return false
    if (next.catalog.actorRole !== catalog.actorRole || next.catalog.weddingId !== catalog.weddingId) {
      setClosed(true); setPending(null); setMessage(t('Доступ к заказу изменился. Откройте раздел заново.')); return false
    }
    setSnapshot(next); setNeedsRefresh(false)
    if (conflict) { setReview(true); setMessage(t('Заказ изменился. Ваш ввод сохранён — проверьте свежие данные перед сохранением.')) }
    return true
  }
  const execute = async (command: Command) => {
    if (inFlight.current || closed || review || needsRefresh || !catalog.draftEditable) return
    inFlight.current = true; setBusy(true); setMessage(null)
    let confirmed = false
    try {
      const result = await command.run(command.key)
      if (!alive.current) return
      if (!result || result.dealId !== dealId || !/^[1-9]\d*$/.test(result.version)) throw new Error('Unconfirmed write')
      confirmed = true
      setPending(null); setNeedsRefresh(true); setSavedAwaitingRefresh(command)
      // A replay can legitimately return an older saved body. Fetch current
      // order AND authority/zone metadata instead of treating it as latest.
      const current = await refresh(false)
      if (alive.current && current) complete(command)
    } catch (error) {
      if (!alive.current) return
      if (error instanceof ApiError && error.status === 409) {
        setPending(null); setNeedsRefresh(true); setReview(true)
        try { await refresh(true) } catch (readError) { if (alive.current) deny(readError) }
      } else if ((!(error instanceof ApiError) || error.isDown) && !confirmed) {
        setPending(command); setMessage(t('Ответ не получен. Повторите тот же запрос, чтобы проверить сохранение.'))
      } else deny(error)
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const send: Send = (run, scope = 'other') => { if (!pending) void execute({ key: newIdempotencyKey(), scope, run }) }
  const reload = async () => {
    if (inFlight.current || closed) return
    inFlight.current = true; setBusy(true)
    try {
      const current = await refresh(review)
      if (alive.current && current && savedAwaitingRefresh) complete(savedAwaitingRefresh)
    } catch (error) { if (alive.current) deny(error) }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const blocked = busy || !!pending || review || needsRefresh || !catalog.draftEditable
  if (closed) return <p role="alert" className="text-sm mt-3">{message}</p>
  return <div className="min-w-0 space-y-3 pt-2">
    <p className="text-xs text-[var(--soft)]">{t('Необязательный черновик пожеланий и работ. Он не меняет цену, бронь или договор и не подтверждает наличие или готовность.')}</p>
    {!catalog.draftEditable && <p className="text-xs">{t('Заказ закрыт для изменений. Сохранённый состав доступен для просмотра.')}</p>}
    {message && <p role="status" className="text-sm break-words">{message}</p>}
    {pending && <button type="button" disabled={busy} onClick={() => void execute(pending)} className={button}>{t('Проверить сохранение')}</button>}
    {needsRefresh && <button type="button" disabled={busy} onClick={() => void reload()} className={button}>{t('Обновить заказ')}</button>}
    {review && !needsRefresh && <button type="button" disabled={busy} onClick={() => { setReview(false); setMessage(null) }} className={button}>{t('Проверил изменения, продолжить')}</button>}
    {order.externalContact && <section className="min-w-0 rounded-xl border border-[var(--line)] p-3 space-y-2">
      <h3 className="text-sm font-semibold">{t('Внешняя договорённость')}</h3>
      <p className="text-xs text-[var(--soft)]">{t('Сведения внесены парой. Подтверждения исполнителя нет.')}</p>
      {catalog.actorRole === 'couple' && ['booked', 'paid_deposit'].includes(catalog.dealState ?? '')
        ? <ExternalContactForm key={epochs['external-contact'] ?? 0} order={order} disabled={blocked} send={send} />
        : <p className="text-sm break-words">{order.externalContact.name}{order.externalContact.phone ? ` · ${order.externalContact.phone}` : ''}</p>}
    </section>}
    <details className="min-w-0"><summary className="min-h-11 py-2 cursor-pointer text-sm font-semibold">{t('Пожелания по услуге')}</summary>
      <BriefForm key={epochs.brief ?? 0} order={order} catalog={catalog} disabled={blocked} send={send} />
    </details>
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-semibold">{t('Работы и результаты')}</h3>
      {!order.parts.length && <p className="text-xs text-[var(--soft)]">{t('Работы пока не описаны')}</p>}
      {order.parts.map(part => <div key={part.id} className="min-w-0 rounded-xl border border-[var(--line)] p-3 space-y-2">
        <p className="text-sm break-words"><strong>{part.title}</strong> · {t(kindLabels[part.kind])}</p>
        <details className="min-w-0"><summary className="min-h-11 py-2 cursor-pointer text-xs">{t('Подробности работы')}</summary><PartDescription part={part} catalog={catalog} /></details>
        {part.cancelledAt ? <p className="text-xs">{t('Отменено в черновике')}</p> : catalog.draftEditable && <>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={blocked} onClick={() => { setEditing(part.id); setAdding(false) }} className={button}>{t('Изменить работу')}</button>
            <button type="button" disabled={blocked} onClick={() => send(key => cancelOrderPart(dealId, part.id, { expectedVersion: order.version, expectedPartVersion: part.version }, key))} className={button}>{t('Убрать работу из черновика')}</button></div>
          {editing === part.id && <PartForm key={`${part.id}-${epochs[`part:${part.id}`] ?? 0}`} part={part} order={order} catalog={catalog} disabled={blocked} send={send} dealId={dealId} />}
        </>}
      </div>)}
      {catalog.draftEditable && <button type="button" disabled={blocked} onClick={() => { setAdding(!adding); setEditing(null) }} className={button}>{t(adding ? 'Закрыть добавление' : 'Добавить работу или результат')}</button>}
      {adding && catalog.draftEditable && <PartForm key={`new-${epochs.new ?? 0}`} order={order} catalog={catalog} disabled={blocked} send={send} dealId={dealId} />}
    </div>
    <div className="min-w-0 space-y-2">
      <h3 className="text-sm font-semibold">{t('Мероприятия этого заказа')}</h3>
      {!order.assignments.length && <p className="text-xs text-[var(--soft)]">{t('Мероприятия пока не назначены')}</p>}
      {order.assignments.map(a => <div key={a.id} className="min-w-0 flex flex-wrap items-center gap-2 text-sm"><span className="min-w-0 break-words">{a.label}</span>
        {a.cancelledAt ? <span className="text-xs">{t('Отменено в черновике')}</span> : catalog.draftEditable && catalog.actorRole === 'couple' && <button type="button" disabled={blocked} onClick={() => send(key => cancelOrderAssignment(dealId, a.id, { expectedVersion: order.version, expectedAssignmentVersion: a.version }, key))} className={button}>{t('Убрать назначение')}</button>}
      </div>)}
      {catalog.actorRole === 'couple' && catalog.draftEditable && <>
        <p className="text-xs text-[var(--soft)]">{t('Отмена назначения убирает связанные работы из черновика; финансовая сделка сохраняется.')}</p>
        <button type="button" disabled={blocked} onClick={() => setAssigning(!assigning)} className={button}>{t('Назначить на мероприятие')}</button>
        {assigning && <AssignmentForm key={epochs.assignment ?? 0} order={order} catalog={catalog} disabled={blocked} send={send} dealId={dealId} onDenied={deny} />}
      </>}
    </div>
  </div>
}

function PartDescription({ part, catalog }: { part: Part; catalog: OrderCatalog }) {
  const zone = part.assignmentId ? catalog.assignmentTimeZones.find(item => item.assignmentId === part.assignmentId)?.timeZone ?? null : catalog.timeZone
  const display = (value: unknown, field: Field) => {
    if (value === null || value === undefined) return t('Не указано')
    if (field.type === 'datetime') {
      if (!zone) return t('Время сохранено; часовой пояс мероприятия не указан.')
      try { return new Intl.DateTimeFormat(getI18nLang(), { timeZone: zone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset' }).format(new Date(String(value))) }
      catch { return t('Время не удалось отобразить') }
    }
    if (Array.isArray(value)) return value.join(', ')
    if (typeof value === 'boolean') return t(value ? 'Да' : 'Нет')
    return String(value)
  }
  const values: Record<string, unknown> = part.details
  return <dl className="min-w-0 space-y-2 text-xs">{partFields[part.kind].map(field => <div key={field.key} className="min-w-0"><dt className="font-semibold">{t(field.label)}</dt><dd className="break-words whitespace-pre-wrap">{display(values[field.key], field)}</dd></div>)}</dl>
}

function raw(value: unknown, field: Field, zone: string | null): string {
  if (value === undefined || value === null) return ''
  if (field.type === 'datetime') return typeof value === 'string' ? formatOrderLocal(value, zone) ?? '' : ''
  if (field.type === 'string_array') return Array.isArray(value) ? value.join('\n') : ''
  return String(value)
}
/** Rebase untouched inputs after a conflict; retain only fields the user edited.
 * Server-only values never turn an unknown boolean/number into false/zero. */
function useFields(fields: Field[], initial: Record<string, unknown>, zone: string | null) {
  const baseline = JSON.stringify([fields, initial, zone])
  const defaults = Object.fromEntries(fields.map(field => [field.key, raw(initial[field.key], field, zone)]))
  const [draft, setDraft] = useState({ baseline, values: defaults, edited: {} as Record<string, boolean>, offsets: {} as Record<string, string> })
  if (draft.baseline !== baseline) setDraft({ ...draft, baseline, values: { ...draft.values, ...Object.fromEntries(fields.map(field => [field.key, draft.edited[field.key] ? draft.values[field.key] ?? '' : defaults[field.key] ?? ''])) } })
  const update = (name: string, value: string) => setDraft(previous => ({ ...previous, values: { ...previous.values, [name]: value }, edited: { ...previous.edited, [name]: true }, offsets: { ...previous.offsets, [name]: '' } }))
  const offset = (name: string, value: string) => setDraft(previous => ({ ...previous, offsets: { ...previous.offsets, [name]: value }, edited: { ...previous.edited, [name]: true } }))
  const collect = (onlyEdited = false): Values => {
    const result: Values = {}
    for (const field of fields) {
      if (onlyEdited && !draft.edited[field.key]) continue
      const value = draft.values[field.key] ?? ''
      if (value === '') { result[field.key] = null; continue }
      if (field.type === 'integer') {
        const number = Number(value)
        if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(number) || number < (field.min ?? -Infinity) || number > (field.max ?? Infinity)) throw new Error(t('Проверьте число в поле:') + ' ' + t(field.label))
        result[field.key] = number
      } else if (field.type === 'boolean') {
        if (!['true', 'false'].includes(value)) throw new Error(t('Проверьте поле:') + ' ' + t(field.label))
        result[field.key] = value === 'true'
      }
      else if (field.type === 'datetime') {
        const choice = draft.offsets[field.key]
        const converted = parseOrderLocal(value, zone, choice ? Number(choice) : undefined)
        if (converted.status !== 'valid') throw new Error(t('Уточните местное время в поле:') + ' ' + t(field.label))
        result[field.key] = converted.candidate.instant
      } else if (field.type === 'string_array') {
        const items = value.split('\n').map(item => item.trim()).filter(Boolean)
        if (items.length > (field.maxItems ?? 64) || items.some(item => item.length > (field.maxLength ?? 2000))) throw new Error(t('Слишком длинный список:') + ' ' + t(field.label))
        result[field.key] = items
      } else {
        if (value.length > (field.maxLength ?? 2000) || (field.options && !field.options.includes(value))) throw new Error(t('Проверьте поле:') + ' ' + t(field.label))
        result[field.key] = value
      }
    }
    return result
  }
  return { values: draft.values, edited: draft.edited, offsets: draft.offsets, update, offset, collect }
}
type FieldDraft = ReturnType<typeof useFields>
const contactFields: Field[] = [
  { ...f('name', 'Имя внешнего исполнителя', 'string', 'core'), maxLength: 120 },
  { ...f('phone', 'Телефон внешнего исполнителя', 'string', 'core'), maxLength: 32 },
]
function ExternalContactForm({ order, disabled, send }: { order: WeddingOrder; disabled: boolean; send: Send }) {
  const draft = useFields(contactFields, order.externalContact ?? {}, null), [error, setError] = useState<string | null>(null)
  return <form onSubmit={event => {
    event.preventDefault(); if (disabled) return
    const name = (draft.values.name ?? '').trim(), rawPhone = draft.values.phone ?? '', phone = rawPhone.trim() || null
    if (name.length < 2 || name.length > 120 || rawPhone.length > 32 || Array.from(name + rawPhone).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) { setError(t('Проверьте имя и телефон внешнего исполнителя')); return }
    setError(null)
    const body = { expectedVersion: order.version, name, phone }
    send(key => patchOrderExternalContact(order.dealId, body, key), 'external-contact')
  }} className="min-w-0 space-y-2">
    <fieldset disabled={disabled} className="min-w-0 space-y-2"><Fields fields={contactFields} draft={draft} zone={null} /></fieldset>
    {error && <p role="alert" className="text-xs">{error}</p>}
    <button type="submit" disabled={disabled} className={button}>{t('Сохранить внешний контакт')}</button>
  </form>
}
function Fields({ fields, draft, zone }: { fields: Field[]; draft: FieldDraft; zone: string | null }) {
  const id = useId()
  const render = (field: Field) => {
    const name = `${id}-${field.key}`, value = draft.values[field.key] ?? ''
    const time = field.type === 'datetime' && value ? parseOrderLocal(value, zone) : null
    return <div key={field.key} className="min-w-0 space-y-1">
      <label htmlFor={name} className="block text-xs font-semibold">{t(field.label)}</label>
      {field.type === 'boolean' || field.options ? <select id={name} value={value} onChange={event => draft.update(field.key, event.target.value)} className={control}>
        <option value="">{t('Не указано')}</option>
        {(field.options ?? ['true', 'false']).map(option => <option key={option} value={option}>{field.type === 'boolean' ? t(option === 'true' ? 'Да' : 'Нет') : t(option)}</option>)}
      </select> : field.type === 'string_array' ? <><textarea id={name} value={value} onChange={event => draft.update(field.key, event.target.value)} className={control} rows={3} /><p className="text-xs text-[var(--soft)]">{t('Каждый пункт с новой строки')}</p></>
        : <input id={name} type={field.type === 'integer' ? 'number' : field.type === 'datetime' ? 'datetime-local' : field.type === 'date' ? 'date' : 'text'} value={value} min={field.min} max={field.max} step={field.type === 'integer' ? 1 : undefined} maxLength={field.maxLength} placeholder={t('Не указано')} onChange={event => draft.update(field.key, event.target.value)} className={control} />}
      {field.type === 'datetime' && <>
        <p className="text-xs text-[var(--soft)]">{zone ? t('Местное время:') + ' ' + zone : t('Часовой пояс мероприятия не указан. Время нельзя сохранить без уточнения.')}</p>
        {time?.status === 'gap' && <p role="alert" className="text-xs">{t('Такого местного времени нет из-за перевода часов. Выберите другое время.')}</p>}
        {time?.status === 'ambiguous' && <><label htmlFor={`${name}-occurrence`} className="block text-xs">{t('Это время встречается дважды. Выберите вариант.')}</label>
          <select id={`${name}-occurrence`} className={control} value={draft.offsets[field.key] ?? ''} onChange={event => draft.offset(field.key, event.target.value)}>
            <option value="">{t('Выберите вариант времени')}</option>{time.candidates.map((candidate, index) => <option key={candidate.instant} value={candidate.offsetMinutes}>{t(index === 0 ? 'Первое наступление' : 'Второе наступление')} ({candidate.offsetMinutes >= 0 ? '+' : '−'}{Math.floor(Math.abs(candidate.offsetMinutes) / 60)}:{String(Math.abs(candidate.offsetMinutes) % 60).padStart(2, '0')})</option>)}
          </select></>}
      </>}
    </div>
  }
  return <div className="min-w-0 space-y-3">{fields.filter(field => field.group === 'core').map(render)}
    {fields.some(field => field.group === 'optional') && <details className="min-w-0"><summary className="min-h-11 cursor-pointer py-2 text-xs">{t('Дополнительные подробности')}</summary><div className="space-y-3 min-w-0">{fields.filter(field => field.group === 'optional').map(render)}</div></details>}
  </div>
}

function BriefForm({ order, catalog, disabled, send }: { order: WeddingOrder; catalog: OrderCatalog; disabled: boolean; send: Send }) {
  const [subtype, setSubtype] = useState({ value: order.brief?.subtypeId ?? '', edited: false, baseline: order.brief?.subtypeId ?? '' })
  if (subtype.baseline !== (order.brief?.subtypeId ?? '')) setSubtype({ ...subtype, baseline: order.brief?.subtypeId ?? '', value: subtype.edited ? subtype.value : order.brief?.subtypeId ?? '' })
  const sub = catalog.category.subtypes?.find(item => item.id === subtype.value)
  const fields = sub?.fields ?? catalog.category.fields
  const values = useFields(fields, order.brief?.values ?? {}, null), [error, setError] = useState<string | null>(null), id = useId()
  const changed = subtype.edited || Object.values(values.edited).some(Boolean)
  return <form className="min-w-0 space-y-3 py-2" onSubmit={event => {
    event.preventDefault(); if (disabled || !changed) return
    try {
      const body = { expectedVersion: order.version, brief: { ...(subtype.value ? { subtypeId: subtype.value } : {}), values: values.collect() } }
      setError(null); send(key => patchOrderBrief(order.dealId, body, key), 'brief')
    } catch (error) { setError(error instanceof Error ? error.message : explainError(error)) }
  }}>
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      {catalog.category.subtypes?.length ? <div className="min-w-0"><label htmlFor={`${id}-subtype`} className="block text-xs font-semibold">{t('Вариант услуги')}</label><select id={`${id}-subtype`} value={subtype.value} onChange={event => setSubtype(previous => ({ ...previous, value: event.target.value, edited: true }))} className={control}><option value="">{t('Не указано')}</option>{catalog.category.subtypes.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></div> : null}
      <Fields fields={fields} draft={values} zone={null} />
    </fieldset>
    {error && <p role="alert" className="text-xs">{error}</p>}
    <button type="submit" disabled={disabled || !changed} className={button}>{t('Сохранить пожелания')}</button>
    {order.brief && <button type="button" disabled={disabled} className={button} onClick={() => send(key => patchOrderBrief(order.dealId, { expectedVersion: order.version, brief: null }, key), 'brief')}>{t('Очистить пожелания')}</button>}
  </form>
}

function PartForm({ part, order, catalog, disabled, send, dealId }: { part?: Part; order: WeddingOrder; catalog: OrderCatalog; disabled: boolean; send: Send; dealId: string }) {
  const [kind, setKind] = useState<Kind>(part?.kind ?? catalog.category.suggestedKinds[0] ?? 'deliverable')
  const [title, setTitle] = useState(part?.title ?? ''), [titleEdited, setTitleEdited] = useState(false), [titleBaseline, setTitleBaseline] = useState(part?.title ?? '')
  if (titleBaseline !== (part?.title ?? '')) { setTitleBaseline(part?.title ?? ''); if (!titleEdited) setTitle(part?.title ?? '') }
  const [assignmentId, setAssignmentId] = useState(part?.assignmentId ?? ''), [error, setError] = useState<string | null>(null)
  const zone = assignmentId ? catalog.assignmentTimeZones.find(item => item.assignmentId === assignmentId)?.timeZone ?? null : catalog.timeZone
  const fields = partFields[kind], values = useFields(fields, part?.details ?? {}, zone), id = useId()
  const assignments = order.assignments.filter(item => !item.cancelledAt)
  const available = !assignmentId ? kind === 'deliverable' : assignments.some(item => item.id === assignmentId)
  const dirty = titleEdited || Object.values(values.edited).some(Boolean)
  return <form className="min-w-0 space-y-3 rounded-xl border border-[var(--line)] p-3" onSubmit={event => {
    event.preventDefault(); if (disabled || !available || (part && !dirty)) return
    if (!title.trim()) { setError(t('Введите название работы')); return }
    try {
      const details = values.collect(!!part)
      if (part) {
        const body = { expectedVersion: order.version, expectedPartVersion: part.version, ...(titleEdited ? { title: title.trim() } : {}), ...(Object.keys(details).length ? { details } : {}) }
        send(key => patchOrderPart(dealId, part.id, body, key), `part:${part.id}`)
      } else {
        const body = { expectedVersion: order.version, kind, assignmentId: assignmentId || null, title: title.trim(), details }
        send(key => createOrderPart(dealId, body, key), 'new')
      }
      setError(null)
    } catch (error) { setError(error instanceof Error ? error.message : explainError(error)) }
  }}>
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      {!part && <><label htmlFor={`${id}-kind`} className="block text-xs font-semibold">{t('Вид работы')}</label><select id={`${id}-kind`} className={control} value={kind} onChange={event => setKind(event.target.value as Kind)}>{catalog.executionKinds.map(value => <option key={value} value={value}>{t(kindLabels[value])}</option>)}</select></>}
      <label htmlFor={`${id}-title`} className="block text-xs font-semibold">{t('Название работы')}</label><input id={`${id}-title`} className={control} value={title} maxLength={200} onChange={event => { setTitle(event.target.value); setTitleEdited(true) }} />
      {!part && <><label htmlFor={`${id}-assignment`} className="block text-xs font-semibold">{t('Мероприятие для работы')}</label><select id={`${id}-assignment`} value={assignmentId} onChange={event => setAssignmentId(event.target.value)} className={control}><option value="">{t(kind === 'deliverable' ? 'Без привязки к мероприятию' : 'Выберите назначенное мероприятие')}</option>{assignments.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></>}
      {!available && <p className="text-xs" role="status">{t('Для этой работы нужно действующее назначение на мероприятие.')}</p>}
      <Fields fields={fields} draft={values} zone={zone} />
    </fieldset>
    {error && <p role="alert" className="text-xs">{error}</p>}
    <button type="submit" disabled={disabled || !available || (part ? !dirty : !title.trim())} className={button}>{t(part ? 'Сохранить работу' : 'Добавить в черновик')}</button>
  </form>
}

function AssignmentForm({ order, catalog, disabled, send, dealId, onDenied }: { order: WeddingOrder; catalog: OrderCatalog; disabled: boolean; send: Send; dealId: string; onDenied: (error: unknown) => void }) {
  const q = useApi(async () => {
    try { const [slots, events] = await Promise.all([getSlots(catalog.weddingId), getWeddingEvents(catalog.weddingId)]); return { slots, events } }
    catch (error) { if (error instanceof ApiError && [401, 403, 404, 410].includes(error.status)) onDenied(error); throw error }
  }, [catalog.weddingId])
  const [eventId, setEventId] = useState(''), [slotId, setSlotId] = useState(''), [label, setLabel] = useState(''), id = useId()
  const positions = catalog.eligiblePositions.filter(position => eventId && (position.programEventId === null || position.programEventId === eventId)
    && q.data?.slots.some(slot => slot.id === position.slotId && slot.categoryId === catalog.category.categoryId)
    && !order.assignments.some(a => !a.cancelledAt && a.slotId === position.slotId))
  const selectionValid = positions.some(position => position.slotId === slotId) && !!q.data?.events.some(event => event.id === eventId)
  return <div className="min-w-0"><AsyncState q={q} {...(q.forbiddenText === undefined ? {} : { forbiddenText: q.forbiddenText })} />{ready(q) && q.data && <form className="min-w-0 space-y-3" onSubmit={event => {
    event.preventDefault(); if (disabled || !selectionValid || !label.trim()) return
    const body = { expectedVersion: order.version, slotId, programEventId: eventId, label: label.trim() }
    send(key => createOrderAssignment(dealId, body, key), 'assignment')
  }}>
    <fieldset disabled={disabled} className="min-w-0 space-y-3">
      <p className="text-xs text-[var(--soft)]">{t('Выберите существующую позицию. Новая бронь здесь не создаётся.')}</p>
      <label htmlFor={`${id}-event`} className="block text-xs font-semibold">{t('Мероприятие')}</label><select id={`${id}-event`} className={control} value={eventId} onChange={event => { setEventId(event.target.value); setSlotId('') }}><option value="">{t('Выберите мероприятие')}</option>{q.data.events.map(event => <option key={event.id} value={event.id}>{event.name}</option>)}</select>
      <label htmlFor={`${id}-slot`} className="block text-xs font-semibold">{t('Позиция заказа')}</label><select id={`${id}-slot`} className={control} value={slotId} onChange={event => setSlotId(event.target.value)}><option value="">{t('Выберите позицию')}</option>{positions.map(position => <option key={position.slotId} value={position.slotId}>{position.label}</option>)}</select>
      {slotId && !selectionValid && <p role="status" className="text-xs">{t('Выбранная позиция больше недоступна. Выберите действующую позицию.')}</p>}
      <label htmlFor={`${id}-label`} className="block text-xs font-semibold">{t('Название назначения')}</label><input id={`${id}-label`} className={control} value={label} maxLength={200} onChange={event => setLabel(event.target.value)} />
    </fieldset>
    <button type="submit" disabled={disabled || !selectionValid || !label.trim()} className={button}>{t('Сохранить назначение')}</button>
  </form>}</div>
}
