import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { ApiError } from '@/lib/api/client'
import { getPurchaseHistory, getPurchases, putPurchase, type Purchase, type PurchaseList, type PurchaseStatus, type PurchaseWrite, type RentalDetails } from '@/lib/api/purchases'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { getI18nLang, key, t } from '@/lib/i18n'
import { fmt, parsePaymentRubles, paymentRubles } from '@/lib/money'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'

const statusLabels: Record<PurchaseStatus, string> = {
  needed: key('Нужно купить'), ordered: key('Заказано'), received: key('Получено'),
  delivered: key('Передано на площадку'), done: key('Завершено'), cancelled: key('Отменено'), returned: key('Возвращено'),
}
const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rose-ink)]'
const inputClass = `block w-full rounded-xl bg-[var(--bg)] px-3 py-2 text-sm text-[var(--ink)] ${focus}`
const statusLabel = (status: PurchaseStatus, rental: boolean) =>
  rental && status === 'needed' ? t('Нужно арендовать') : rental && status === 'ordered' ? t('Аренда забронирована') : t(statusLabels[status])
type RentalDraft = Record<keyof RentalDetails, string>
const emptyRental: RentalDraft = {
  pickupOn: '', returnOn: '', depositAmount: '0', paidAmount: '0', refundedAmount: '0', disputedAmount: '0',
}
const rentalDraftOf = (rental: RentalDetails): RentalDraft => ({
  pickupOn: rental.pickupOn, returnOn: rental.returnOn, depositAmount: paymentRubles(rental.depositAmount),
  paidAmount: paymentRubles(rental.paidAmount), refundedAmount: paymentRubles(rental.refundedAmount),
  disputedAmount: paymentRubles(rental.disputedAmount),
})
const rentalInput = (draft: RentalDraft): RentalDetails | null => {
  const depositAmount = parsePaymentRubles(draft.depositAmount, true), paidAmount = parsePaymentRubles(draft.paidAmount, true)
  const refundedAmount = parsePaymentRubles(draft.refundedAmount, true), disputedAmount = parsePaymentRubles(draft.disputedAmount, true)
  if (depositAmount === null || paidAmount === null || refundedAmount === null || disputedAmount === null) return null
  return { pickupOn: draft.pickupOn, returnOn: draft.returnOn, depositAmount, paidAmount, refundedAmount, disputedAmount }
}
type Draft = {
  id: string; version: number; title: string; quantity: string; unit: string; categoryId: string
  estimated: string; agreed: string; seller: string; sellerUrl: string; dueOn: string
  assigneeId: string; eventId: string; linkedDealId: string; status: PurchaseStatus; statusOptions: PurchaseStatus[]; rental: RentalDraft | null
}
const draftOf = (purchase: Purchase): Draft => ({
  ...purchase, estimated: purchase.estimatedAmount == null ? '' : paymentRubles(purchase.estimatedAmount),
  agreed: purchase.agreedAmount == null ? '' : paymentRubles(purchase.agreedAmount), seller: purchase.seller ?? '',
  sellerUrl: purchase.sellerUrl ?? '', dueOn: purchase.dueOn ?? '', assigneeId: purchase.assigneeId ?? '',
  eventId: purchase.eventId ?? '', linkedDealId: purchase.linkedDealId ?? '',
  statusOptions: [purchase.status, ...purchase.nextStatuses],
  rental: purchase.rental ? rentalDraftOf(purchase.rental) : null,
})

export default function WeddingPurchases() {
  const { weddingId } = useStore()
  const session = useLegacySessionKey(weddingId ?? '')
  return <PurchaseScreen key={session} weddingId={weddingId} />
}

function PurchaseScreen({ weddingId }: { weddingId: string | null }) {
  const [params] = useSearchParams()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const region = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLFormElement>(null)
  const latestButton = useRef<HTMLButtonElement>(null)
  const nextFocus = useRef<{ target: 'editor' | 'latest' | 'region'; origin: Element | null } | null>(null)
  const begin = useLegacyActionScope(weddingId ?? '', weddingId)
  const q = useApi(() => weddingId ? getPurchases(weddingId) : noWedding(), [weddingId])
  const online = useLiveAccess(q.reload)
  const list = online && ready(q) && !q.refreshing ? q.data : null
  const focused = params.get('purchase')
  const items = list?.items ?? []
  const focusItem = items.find(purchase => purchase.id === focused)
  const visible = focusItem ? [focusItem, ...items.filter(purchase => purchase.id !== focused)] : items

  useLayoutEffect(() => {
    const request = nextFocus.current
    if (!request || busy || (request.target === 'editor' && q.refreshing)) return
    nextFocus.current = null
    if (document.activeElement !== request.origin && document.activeElement !== document.body) return
    if (request.target === 'editor') (editor.current?.querySelector('input') ?? region.current)?.focus()
    if (request.target === 'latest') latestButton.current?.focus()
    if (request.target === 'region') region.current?.focus()
  }, [draft, conflict, busy, q.refreshing])

  function focusAfterChange(target: NonNullable<typeof nextFocus.current>['target']) {
    nextFocus.current = { target, origin: document.activeElement }
  }

  const create = (rental: boolean) => {
    if (!list) return
    setError(null)
    setConflict(false)
    focusAfterChange('editor')
    setDraft({ id: crypto.randomUUID(), version: 0, title: '', quantity: '1', unit: '',
      categoryId: list.categories[0]?.id ?? '', estimated: '', agreed: '', seller: '', sellerUrl: '', dueOn: '',
      assigneeId: '', eventId: '', linkedDealId: '', status: 'needed', statusOptions: ['needed'], rental: rental ? { ...emptyRental } : null })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!weddingId || !draft || busy || conflict || q.refreshing || !list || list.readOnly) return
    const estimated = draft.estimated.trim() ? parsePaymentRubles(draft.estimated, true) : null
    const agreed = draft.agreed.trim() ? parsePaymentRubles(draft.agreed, true) : null
    const rental = draft.rental ? rentalInput(draft.rental) : null
    if ((draft.estimated.trim() && estimated === null) || (draft.agreed.trim() && agreed === null) || (draft.rental && !rental)) {
      setError(t('Укажите стоимость в рублях, до двух знаков после запятой'))
      return
    }
    const body: PurchaseWrite = {
      version: draft.version, title: draft.title.trim(), quantity: draft.quantity.trim().replace(',', '.'), unit: draft.unit.trim(),
      categoryId: draft.categoryId, estimatedAmount: estimated, agreedAmount: agreed, seller: draft.seller.trim() || null,
      sellerUrl: draft.sellerUrl.trim() || null, dueOn: draft.dueOn || null, assigneeId: draft.assigneeId || null,
      eventId: draft.eventId || null, linkedDealId: draft.linkedDealId || null, status: draft.status, ...(rental ? { rental } : {}),
    }
    const action = begin()
    setBusy(true)
    setError(null)
    try {
      await putPurchase(weddingId, draft.id, body, action.assertCurrent)
      action.assertCurrent()
      if (editor.current?.contains(document.activeElement)) focusAfterChange('region')
      setDraft(null)
      setHistory(null)
      q.reload()
    } catch (cause) {
      if (action.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && cause.code === 'stale_wedding_purchase') {
          if (editor.current?.contains(document.activeElement)) focusAfterChange('latest')
          setConflict(true)
        }
      }
    } finally {
      if (action.isCurrent()) setBusy(false)
    }
  }

  const loadLatest = async () => {
    if (!weddingId || !list || list.readOnly || !draft || busy) return
    const action = begin()
    setBusy(true)
    setError(null)
    try {
      const latest = await getPurchases(weddingId)
      action.assertCurrent()
      const purchase = latest.items.find(item => item.id === draft.id)
      if (document.activeElement === latestButton.current) focusAfterChange('editor')
      setDraft(purchase && !latest.readOnly ? draftOf(purchase) : null)
      setConflict(false)
      q.reload()
    } catch (cause) {
      if (action.isCurrent()) {
        setError(explainError(cause))
        if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
          setDraft(null)
          setConflict(false)
          q.reload()
        }
      }
    } finally {
      if (action.isCurrent()) setBusy(false)
    }
  }

  return <div className="pb-28">
    <TopBar title={t('Покупки и аренда')} back />
    <div ref={region} role="region" aria-label={t('Покупки и аренда')} tabIndex={-1} className={`px-5 mt-3 space-y-3 ${focus}`}>
      {!online ? <p role="status">{t('Нет связи с сервером')}</p>
        : q.refreshing ? <p role="status">{t('Проверяем доступ…')}</p>
        : <AsyncState q={q} forbiddenText={t('Бюджет ведёт пара — у вашей роли к нему доступа нет.')} />}
      {list && <Link to="/wedding/item-sets" className="press card-s block rounded-xl px-4 py-2.5 font-semibold">{t('Наборы вещей')} →</Link>}
      {list && error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
      {list && !list.readOnly && !draft && <div className="flex flex-wrap gap-2">
        <button onClick={() => create(false)} className="press grad rounded-xl px-4 py-2.5 font-semibold text-[var(--on-grad)]">{t('Добавить покупку')}</button>
        <button onClick={() => create(true)} className={`press card-s rounded-xl px-4 py-2.5 font-semibold ${focus}`}>{t('Добавить аренду')}</button>
      </div>}
      {draft && list && !list.readOnly && <>
        {conflict && <div className="card p-4 text-sm">
          <p role="status">{t('Черновик остался в форме. Загрузка актуальной версии заменит введённые данные.')}</p>
          <button ref={latestButton} type="button" aria-disabled={busy} onClick={() => void loadLatest()} className={`press mt-2 rounded-xl bg-[var(--bg)] px-3 py-2 aria-disabled:opacity-50 ${focus}`}>
            {t('Загрузить актуальную версию')}
          </button>
        </div>}
        <PurchaseEditor formRef={editor} draft={draft} list={list} setDraft={value => {
          if (!value) {
            if (editor.current?.contains(document.activeElement)) focusAfterChange('region')
            setConflict(false); setError(null); q.reload()
          }
          setDraft(value)
        }} busy={busy} saveBlocked={conflict || q.refreshing} save={save} />
      </>}
      {list?.readOnly && <p className="text-sm text-[var(--soft)]">{t('Свадьба отменена — история доступна только для чтения')}</p>}
      {list && !items.length && !draft && <p className="text-sm text-[var(--soft)]">{t('Покупок пока нет')}</p>}
      {visible.map(purchase => <article key={purchase.id} className="card p-4 space-y-2">
        <div className="flex flex-wrap justify-between items-start gap-2">
          <h2 className="font-bold break-words min-w-0">{purchase.title}</h2>
          <span className="text-sm font-semibold text-[var(--soft)]">{statusLabel(purchase.status, !!purchase.rental)}</span>
        </div>
        <p className="text-sm">{purchase.quantity} {purchase.unit}{purchase.dueOn && <> · {t('Срок')} {purchase.dueOn}</>}</p>
        <PurchaseCosts estimated={purchase.estimatedAmount} agreed={purchase.agreedAmount} rental={!!purchase.rental} />
        {purchase.rental && <RentalDepositDetails rental={purchase.rental} />}
        {list && <p className="text-xs text-[var(--soft)]">
          {list.categories.find(category => category.id === purchase.categoryId)?.label}
          {purchase.assigneeId && <> · {list.members.find(member => member.id === purchase.assigneeId)?.label ?? t('Ответственный недоступен')}</>}
          {purchase.eventId && <> · {list.events.find(event => event.id === purchase.eventId)?.label}</>}
        </p>}
        {purchase.seller && <p className="text-sm break-words">{purchase.seller}</p>}
        {purchase.sellerUrl && <a href={purchase.sellerUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">{t('Открыть ссылку продавца')}</a>}
        {purchase.linkedDealId && <p className="text-xs"><Link to={'/deal/' + purchase.linkedDealId} className="underline">{t('Связано со сделкой')}</Link></p>}
        <div className="flex flex-wrap gap-2 text-sm">
          {!list?.readOnly && <button disabled={busy || !!draft} onClick={() => { setError(null); focusAfterChange('editor'); setDraft(draftOf(purchase)) }}
            aria-label={`${t(purchase.rental ? 'Изменить аренду' : 'Изменить покупку')} · ${purchase.title}`}
            className={`press rounded-lg bg-[var(--bg)] px-3 py-2 ${focus}`}>{t(purchase.rental ? 'Изменить аренду' : 'Изменить покупку')}</button>}
          <button aria-expanded={history === purchase.id} onClick={() => setHistory(history === purchase.id ? null : purchase.id)}
            className={`press rounded-lg bg-[var(--bg)] px-3 py-2 ${focus}`}>{t(purchase.rental ? 'История аренды' : 'История покупки')}</button>
        </div>
        {weddingId && history === purchase.id && <PurchaseHistory weddingId={weddingId} purchaseId={purchase.id} />}
      </article>)}
    </div>
  </div>
}

function PurchaseEditor({ formRef, draft, list, setDraft, busy, saveBlocked, save }: {
  formRef: React.Ref<HTMLFormElement>
  draft: Draft; list: PurchaseList; setDraft: (value: Draft | null) => void; busy: boolean; saveBlocked: boolean; save: (event: FormEvent) => void
}) {
  const change = (field: keyof Draft, value: string) => setDraft({ ...draft, [field]: value })
  const selects = [
    { field: 'categoryId', label: key('Категория бюджета'), options: list.categories, required: true },
    { field: 'assigneeId', label: key('Ответственный'), options: list.members, required: false },
    { field: 'eventId', label: key('Мероприятие'), options: list.events, required: false },
    { field: 'linkedDealId', label: key('Если расход уже входит в сделку'), options: list.deals, required: false },
  ] as const
  const fields = [
    { field: 'title', label: draft.rental ? key('Название аренды') : key('Название покупки'), max: 160, required: true, decimal: false },
    { field: 'quantity', label: key('Количество'), max: 13, required: true, decimal: true },
    { field: 'unit', label: key('Единица измерения'), max: 32, required: true, decimal: false },
    { field: 'estimated', label: draft.rental ? key('Оценка аренды, ₽') : key('Оценка покупки, ₽'), max: 25, required: false, decimal: true },
    { field: 'agreed', label: key('Согласованная стоимость, ₽'), max: 25, required: false, decimal: true },
    { field: 'seller', label: key('Продавец'), max: 160, required: false, decimal: false },
    { field: 'sellerUrl', label: key('Ссылка продавца'), max: 1024, required: false, decimal: false },
  ] as const
  return <form ref={formRef} onSubmit={save} className="card p-4">
    <fieldset disabled={busy} className="grid sm:grid-cols-2 gap-3">
      {fields.map(({ field, label, max, required, decimal }) => <label key={field} className="text-sm">
        {t(label)}<input className={inputClass} value={draft[field]} required={required} maxLength={max}
          inputMode={decimal ? 'decimal' : undefined} pattern={field === 'quantity' ? '[0-9]{1,9}([.,][0-9]{1,3})?' : undefined}
          onChange={event => change(field, event.target.value)} />
      </label>)}
      <label className="text-sm">{t('Срок')}<input type="date" className={inputClass} value={draft.dueOn} onChange={event => change('dueOn', event.target.value)} /></label>
      {selects.map(({ field, label, options, required }) => <label key={field} className="text-sm">
        {t(label)}<select className={inputClass} value={draft[field]} required={required} onChange={event => change(field, event.target.value)}>
          {!required && <option value="">{t('Не указано')}</option>}
          {draft[field] && !options.some(option => option.id === draft[field]) && <option value={draft[field]}>{t('Недоступно')}</option>}
          {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </label>)}
      {draft.rental && <RentalEditor rental={draft.rental} onChange={rental => setDraft({ ...draft, rental })} />}
      <label className="text-sm">{t('Статус')}<select className={inputClass} value={draft.status} onChange={event => change('status', event.target.value)}>
        {draft.statusOptions.map(status => <option key={status} value={status}>{statusLabel(status, !!draft.rental)}</option>)}
      </select></label>
    </fieldset>
    <div className="mt-3 flex gap-2 items-end">
      <button type="submit" aria-disabled={busy || saveBlocked} className={`press grad rounded-xl px-4 py-2 font-semibold text-[var(--on-grad)] aria-disabled:opacity-50 ${focus}`}>{t(draft.rental ? 'Сохранить аренду' : 'Сохранить покупку')}</button>
      <button type="button" disabled={busy} className={`press rounded-xl px-3 py-2 ${focus}`} onClick={() => setDraft(null)}>{t('Отмена')}</button>
    </div>
  </form>
}

function RentalEditor({ rental, onChange }: { rental: RentalDraft; onChange: (value: RentalDraft) => void }) {
  const fields = [
    ['pickupOn', key('Дата получения'), 'date'], ['returnOn', key('Дата возврата'), 'date'],
    ['depositAmount', key('Согласованный залог, ₽'), 'text'], ['paidAmount', key('Внесено залога, ₽'), 'text'],
    ['refundedAmount', key('Возвращено залога, ₽'), 'text'], ['disputedAmount', key('Спорная часть залога, ₽'), 'text'],
  ] as const
  return <fieldset className="sm:col-span-2 grid sm:grid-cols-2 gap-3 border-t border-[var(--track)] pt-2">
    <legend className="font-semibold">{t('Сроки аренды и залог')}</legend>
    {fields.map(([field, label, type]) => <label key={field} className="text-sm">
      {t(label)}<input className={inputClass} type={type} inputMode={type === 'text' ? 'decimal' : undefined} required
        value={rental[field]} onChange={event => onChange({ ...rental, [field]: event.target.value })} />
    </label>)}
  </fieldset>
}

function PurchaseCosts({ estimated, agreed, rental }: {
  estimated: number | null | undefined; agreed: number | null | undefined; rental: boolean
}) {
  return <dl className="grid grid-cols-2 gap-2 text-sm">
    <div><dt>{t(rental ? 'Оценка аренды' : 'Оценка покупки')}</dt><dd>{estimated == null ? t('Не уточнено') : fmt(estimated)}</dd></div>
    <div><dt>{t('Согласованная стоимость')}</dt><dd>{agreed == null ? t('Не уточнено') : fmt(agreed)}</dd></div>
  </dl>
}

function RentalDepositDetails({ rental }: { rental: RentalDetails }) {
  return <div className="text-xs text-[var(--soft)] space-y-1">
    <p>{t('Получение аренды')} {rental.pickupOn} · {t('Возврат аренды')} {rental.returnOn}</p>
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      <div><dt>{t('Согласованный залог')}</dt><dd>{fmt(rental.depositAmount)}</dd></div>
      <div><dt>{t('Внесено залога')}</dt><dd>{fmt(rental.paidAmount)}</dd></div>
      <div><dt>{t('Возвращено залога')}</dt><dd>{fmt(rental.refundedAmount)}</dd></div>
      <div><dt>{t('Остаётся у арендодателя')}</dt><dd>{fmt(rental.paidAmount - rental.refundedAmount)}</dd></div>
      {rental.disputedAmount > 0 && <div><dt>{t('Спорная часть залога')}</dt><dd>{fmt(rental.disputedAmount)}</dd></div>}
    </dl>
  </div>
}

function PurchaseHistory({ weddingId, purchaseId }: { weddingId: string; purchaseId: string }) {
  const q = useApi(() => getPurchaseHistory(weddingId, purchaseId), [weddingId, purchaseId])
  const date = new Intl.DateTimeFormat(getI18nLang() === 'en' ? 'en-GB' : 'ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
  return <div className="pt-2 border-t border-[var(--track)]">
    <AsyncState q={q} />
    {ready(q) && <ol className="space-y-2 text-sm">{q.data?.items.map(entry => <li key={entry.version} className="rounded-lg bg-[var(--bg)] p-2 space-y-1">
      <p>{t('Версия {version}').replace('{version}', String(entry.version))} · {statusLabel(entry.status, !!entry.rental)} · {entry.actorName ?? t('Участник недоступен')} · <time dateTime={entry.recordedAt}>{date.format(new Date(entry.recordedAt))}</time></p>
      {(entry.estimatedAmount !== undefined || entry.agreedAmount !== undefined) &&
        <PurchaseCosts estimated={entry.estimatedAmount} agreed={entry.agreedAmount} rental={!!entry.rental} />}
      {entry.rental && <RentalDepositDetails rental={entry.rental} />}
    </li>)}</ol>}
  </div>
}
