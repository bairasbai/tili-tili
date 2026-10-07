import { useEffect, useRef, useState, type FormEvent } from 'react'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { formatWeddingDate } from '@/lib/weddingDate'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { correctPaymentRecord, getInstallmentEditHistory, getPaymentCorrectionHistory, type PaymentCorrectionWrite, type PaymentRecord, type PaymentCorrection, type PaymentInstallmentEdit } from '@/lib/api/paymentSchedule'
import { parsePaymentRubles, paymentRubles } from '@/lib/paymentAmount'

const field = 'mt-1 w-full min-w-0 rounded-xl bg-[var(--bg)] px-3 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--rose)]'
const button = 'press min-h-11 rounded-xl px-3 py-2.5 text-sm font-semibold disabled:opacity-50'
const methods = { cash: 'Наличные', bank_transfer: 'Банковский перевод', card: 'Карта', other: 'Другое' } as const
export type PaymentCorrectionAttempt = { body: PaymentCorrectionWrite; key: string }
export type PaymentCorrectionDraft = { version:number; amountKnown:boolean; amount:string; paidOn:string;
  method:PaymentRecord['paymentMethod']; reason:string; stale:boolean }
type Props = { weddingId: string; payment: PaymentRecord; disabled: boolean; reload: () => void; denied: () => void;
  attempt: PaymentCorrectionAttempt | null; onAttempt: (attempt: PaymentCorrectionAttempt | null) => void;
  savedDraft:PaymentCorrectionDraft|null; onDraft:(draft:PaymentCorrectionDraft|null)=>void }

/** The uncertain attempt survives collapse and current-data refresh. Editing requires its outcome first. */
export function PaymentCorrectionEditor({ weddingId, payment, disabled, reload, denied, attempt, onAttempt, savedDraft, onDraft }: Props) {
  const initial=attempt?.body??payment
  const [open, setOpen] = useState(false)
  const draft=savedDraft??{version:initial.version,amountKnown:initial.amountKnown,amount:initial.amount?paymentRubles(initial.amount.amount):'',paidOn:initial.paidOn,method:initial.paymentMethod,reason:attempt?.body.reason??'',stale:false}
  const {version,amountKnown,amount,paidOn,method,reason,stale}=draft
  const change=<K extends keyof PaymentCorrectionDraft>(key:K,value:PaymentCorrectionDraft[K])=>onDraft({...draft,[key]:value})
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
  const uncertain=attempt
  const setUncertain=onAttempt
  const writing = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const locked = busy || disabled || !!uncertain
  function edit() {
    if (!savedDraft && !uncertain) onDraft({...draft,version:payment.version})
    setError(null); setNotice(null)
    setOpen(true)
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (writing.current || disabled || stale || (!uncertain && payment.canCorrect !== true)) return
    let body: PaymentCorrectionWrite, key: string
    if (uncertain) ({ body, key } = uncertain)
    else {
      const parsed = amountKnown ? parsePaymentRubles(amount) : null
      if (amountKnown && parsed === null) { setError(t('Введите сумму больше нуля, не более двух знаков после запятой')); return }
      if (!reason.trim() || Array.from(reason.trim()).length > 500) { setError(t('Укажите причину исправления до 500 символов')); return }
      body = { version, amountKnown, amount: amountKnown ? { amount: parsed!, currency: 'RUB' } : null, paidOn, paymentMethod: method, reason: reason.trim() }
      key = newIdempotencyKey()
    }
    writing.current = true; setBusy(true); setError(null); setNotice(null)
    setUncertain({body,key})
    try {
      await correctPaymentRecord(weddingId, payment.id, body, key)
      setUncertain(null); onDraft(null); reload()
      if (!alive.current) return
      setOpen(false); setNotice(t('Исправление сохранено'))
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.status === 404)) { denied(); return }
      if(e instanceof ApiError&&e.code==='stale_payment_plan'){
        setUncertain(null); onDraft({...draft,stale:true}); reload()
        if(alive.current)setError(t('Отметка изменилась. Проверьте текущие сведения перед повторной записью.'))
        return
      }
      if (!alive.current) return
      if (!(e instanceof ApiError) || e.isDown || e.code === 'idempotency_in_progress') {
        setUncertain({ body, key }); setError(t('Ответ не получен. Повторите ту же попытку, чтобы узнать результат.'))
      } else { setUncertain(null); setError(explainError(e)) }
    } finally { writing.current = false; if (alive.current) setBusy(false) }
  }
  return <div className="min-w-0">
    {(payment.canCorrect === true || uncertain) && <button className={button} disabled={disabled || busy} onClick={edit}>{t(uncertain ? 'Вернуться к попытке исправления' : 'Исправить отметку')}</button>}
    {notice && <p role="status" className="text-xs py-2">{notice}</p>}
    {open && <form aria-label={t('Исправление отметки')} onSubmit={event => void submit(event)} className="min-w-0 rounded-xl border border-[var(--line)] p-3 space-y-3 my-2">
      <h3 className="font-semibold text-sm">{t('Исправление отметки')}</h3>
      <p className="text-xs leading-relaxed">{t('Исправляется ручная запись. Перевод денег и документы не изменяются.')}</p>
      <fieldset disabled={locked} className="space-y-2">
        <legend className="text-xs font-semibold">{t('Сохранять сумму?')}</legend>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={'correction-known-'+payment.id} checked={amountKnown} onChange={() => change('amountKnown',true)} />{t('Сумма известна')}</label>
        <label className="flex items-center gap-2 text-sm"><input type="radio" name={'correction-known-'+payment.id} checked={!amountKnown} onChange={() => onDraft({...draft,amountKnown:false,amount:''})} />{t('Сумма не сохранена')}</label>
      </fieldset>
      {amountKnown ? <label className="block text-xs">{t('Сумма, ₽')}<input className={field} inputMode="decimal" value={amount} maxLength={24} disabled={locked} onChange={e => change('amount',e.target.value)} required /></label>
        : <p className="text-xs">{t('Числовой остаток не учитывает неизвестную сумму.')}</p>}
      <label className="block text-xs">{t('Дата оплаты')}<input className={field} type="date" min="2000-01-01" max="2100-12-31" value={paidOn} disabled={locked} onChange={e => change('paidOn',e.target.value)} required /></label>
      <label className="block text-xs">{t('Способ оплаты')}<select className={field} value={method} disabled={locked} onChange={e => change('method',e.target.value as typeof method)}>{Object.entries(methods).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
      <label className="block text-xs">{t('Причина исправления')}<textarea className={field} value={reason} maxLength={500} disabled={locked} onChange={e => change('reason',e.target.value)} required /></label>
      {stale && <div className="rounded-xl bg-[var(--honey)] p-3 space-y-2 text-xs">
        <p>{t('Текущая отметка')}: {payment.amountKnown && payment.amount ? fmt(payment.amount.amount) : t('Сумма не сохранена')} · {formatWeddingDate(payment.paidOn)} · {t(methods[payment.paymentMethod])}</p>
        <button type="button" className={button} disabled={disabled || payment.canCorrect !== true} onClick={() => { onDraft({...draft,version:payment.version,stale:false}); setError(null) }}>{t('Принять текущую версию')}</button>
      </div>}
      {error && <p role="alert" className="text-xs break-words text-[var(--rose-deep)]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button className={button+' grad text-[var(--on-grad)]'} type="submit" disabled={busy || disabled || stale || (!uncertain && payment.canCorrect !== true)}>{t(uncertain ? 'Повторить ту же попытку' : 'Сохранить исправление')}</button>
        <button className={button} type="button" disabled={busy} onClick={() => setOpen(false)}>{t('Закрыть')}</button>
      </div>
    </form>}
  </div>
}

type HistoryEvent = PaymentCorrection | PaymentInstallmentEdit
export function PaymentAmendmentHistory({ weddingId, id, type, revision, denied }: { weddingId: string; id: string; type: 'payment' | 'installment'; revision: number; denied: () => void }) {
  const [open, setOpen] = useState(false)
  return <details className="min-w-0" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer py-3 text-xs font-semibold">{t(type === 'payment' ? 'История исправлений' : 'История правок этапа')}</summary>
    {open && <HistoryList key={`${weddingId}:${type}:${id}:${revision}`} weddingId={weddingId} id={id} type={type} denied={denied} />}
  </details>
}
function HistoryList({ weddingId, id, type, denied }: { weddingId: string; id: string; type: 'payment' | 'installment'; denied: () => void }) {
  const [items, setItems] = useState<HistoryEvent[]>([]), [cursor, setCursor] = useState<string | null>(null), [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(true), [error, setError] = useState<string | null>(null)
  const alive = useRef(true), writing = useRef(false)
  async function load(next?: string) {
    if (writing.current) return
    writing.current = true; setBusy(true); setError(null)
    try {
      const page = type === 'payment' ? await getPaymentCorrectionHistory(weddingId, id, next) : await getInstallmentEditHistory(weddingId, id, next)
      if (!alive.current) return
      setItems(old => next ? [...old, ...page.items.filter(item => !old.some(previous => previous.id === item.id))] : page.items)
      setCursor(page.nextCursor); setLoaded(true)
    } catch (e) {
      if (e instanceof ApiError && [401, 403, 404].includes(e.status)) { denied(); return }
      if (!alive.current) return
      setItems([]); setCursor(null)
      setError(explainError(e))
    } finally { writing.current = false; if (alive.current) setBusy(false) }
  }
  useEffect(() => {
    alive.current = true; void load()
    return () => { alive.current = false }
    // Mounted only on explicit expansion; parent scope changes unmount the whole reader.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weddingId, id, type])
  function values(item: HistoryEvent, side: 'before' | 'after') {
    if ('paymentId' in item) {
      const value = item[side]
      return <p>{value.amountKnown && value.amount ? fmt(value.amount.amount) : t('Сумма не сохранена')} · {formatWeddingDate(value.paidOn)} · {t(methods[value.paymentMethod])}</p>
    }
    const value = item[side]
    return <p>{value.title} · {fmt(value.amount.amount)} · {formatWeddingDate(value.due)}{value.cancelledAt ? ' · '+t('Отменён') : ''}{value.cancelReason ? ' · '+value.cancelReason : ''}</p>
  }
  return <div className="min-w-0 space-y-3 text-xs">
    <p className="text-[var(--soft)]">{t('Показаны сохранённые исправления. Более ранние редакции не восстанавливались.')}</p>
    {busy && <p role="status">{t('Загружаем…')}</p>}
    {error && <p role="alert">{error}<button className={button} onClick={() => void load()}>{t('Повторить')}</button></p>}
    {loaded && !busy && !error && !items.length && <p>{t('Сохранённых исправлений пока нет')}</p>}
    {items.map(item => <article key={item.id} className="min-w-0 break-words border-t border-[var(--line)] pt-3 space-y-2">
      <p><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString(getI18nLang()==='en'?'en-US':'ru-RU')}</time> · {item.actor ? item.actor.kind === 'self' ? t('Вы') : item.actor.name || t('Участник пары') : t('Автор недоступен')}</p>
      <dl className="space-y-2"><div><dt className="font-semibold">{t('Было')}</dt><dd>{values(item, 'before')}</dd></div><div><dt className="font-semibold">{t('Стало')}</dt><dd>{values(item, 'after')}</dd></div></dl>
      {'reason' in item && <p>{t('Причина исправления')}: {item.reason}</p>}
    </article>)}
    {cursor && !error && <button className={button} disabled={busy} onClick={() => void load(cursor)}>{t('Ещё исправления')}</button>}
  </div>
}
