import { useRef, useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { api, url } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { servicePlanName } from '@/lib/servicePlanNames'

type Review = components['schemas']['ServicePlanManualReview']
const orderIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const inputClass = 'block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2'
const buttonClass = 'press rounded-full grad text-[var(--on-grad)] px-4 py-2 disabled:opacity-50'

export function ManualServiceReview({ assertOrigin }: { assertOrigin: () => void }) {
  const [params, setParams] = useSearchParams()
  const fromLink = params.get('manualOrder')
  const focused = fromLink && orderIdPattern.test(fromLink) ? fromLink : ''
  const [lookup, setLookup] = useState('')
  const queue = '/admin/service-plans/manual-orders'
  const path = (focused ? queue + '?orderId=' + encodeURIComponent(focused) : queue) as typeof queue
  const q = useApi(() => api.get(path, { assertCurrent: assertOrigin }), [assertOrigin, path])
  function showOrder(id: string) {
    setParams(previous => {
      const next = new URLSearchParams(previous)
      if (id) next.set('manualOrder', id)
      else next.delete('manualOrder')
      return next
    })
  }
  return (
    <section className="card p-4 space-y-3">
      <h2 className="font-semibold">{t('Оплаты к проверке')}</h2>
      <form className="flex items-end gap-2" onSubmit={event => {
        event.preventDefault()
        const id = lookup.trim()
        if (orderIdPattern.test(id)) showOrder(id)
      }}>
        <label className="min-w-0 flex-1 space-y-1">
          <span>{t('Номер заказа')}</span>
          <input value={lookup} maxLength={36} className={inputClass}
            onChange={event => setLookup(event.target.value)} />
        </label>
        <button className="press px-3 py-2 font-semibold" disabled={!orderIdPattern.test(lookup.trim())}>
          {t('Найти заказ')}
        </button>
      </form>
      <div className="flex flex-wrap gap-3">
        {focused && <button type="button" onClick={() => showOrder('')} className="press py-2 font-semibold">
          {t('К очереди оплат')}
        </button>}
        <button type="button" onClick={q.reload} disabled={q.refreshing} className="press py-2 font-semibold">
          {t('Обновить статус')}
        </button>
      </div>
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && q.data?.reviews.length === 0 &&
        <p>{t(focused ? 'Заказ на перевод не найден' : 'Открытых заказов на перевод нет')}</p>}
      {ready(q) && q.data?.reviews.map(review => (
        <ReviewCard key={review.order.id + review.order.state} review={review} focused={Boolean(focused)}
          assertOrigin={assertOrigin} onConfirmed={() => {
            if (!focused) showOrder(review.order.id)
            else q.reload()
          }} />
      ))}
    </section>
  )
}

function ReviewCard({ review, focused, assertOrigin, onConfirmed }: {
  review: Review; focused: boolean; assertOrigin: () => void; onConfirmed: () => void
}) {
  const { order } = review
  const [bankOperation, setBankOperation] = useState('')
  const [received, setReceived] = useState('')
  const [paid, setPaid] = useState('')
  const [receipt, setReceipt] = useState('')
  const [delivered, setDelivered] = useState(false)
  const [noTransfer, setNoTransfer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const requested = order.manual?.saveReceiptCopy === true
  const amount = /^\d{1,8}([.,]\d{1,2})?$/.test(received) ? Math.round(Number(received.replace(',', '.')) * 100) : null

  async function run(action: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      assertOrigin()
      onConfirmed()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!delivered || amount !== order.amount || (requested && !receipt.trim())) return
    void run(() => api.post(url('/admin/service-plans/manual-orders/{orderId}/confirm', { orderId: order.id }), {
      amount, bankOperation: bankOperation.trim(), paidAt: new Date(paid).toISOString(),
      receiptDelivered: true, ...(requested ? { receiptUrl: receipt.trim() } : {}),
    }, { assertCurrent: assertOrigin }))
  }

  return <details open={focused || undefined} className="rounded-xl border border-[var(--line)] p-3 text-sm">
    <summary className="cursor-pointer font-semibold">
      {t(servicePlanName[order.code])} · {fmt(order.amount)} · {t(order.state === 'paid'
        ? 'Оплата подтверждена' : order.state === 'refunded' ? 'Возврат подтверждён'
          : order.state === 'canceled' ? 'Оплата отменена'
            : order.manual?.submittedAt ? 'Покупатель сообщил о переводе' : 'Ожидаем сообщения покупателя')}
    </summary>
    <div className="mt-3 space-y-2">
      <p className="break-all">{t('Номер заказа')} · {order.id}</p>
      {order.manual?.submittedAt && <p>{t('Дата заявки')} · {new Date(order.manual.submittedAt).toLocaleString(getI18nLang())}</p>}
      {review.receiptEmail && <p className="break-all">{t('Электронная почта для чека')} · {review.receiptEmail}</p>}
      {review.receiptInn && <p>{t('ИНН покупателя')} · {review.receiptInn}</p>}
      <p>{t(requested ? 'Покупатель запросил копию чека в приложении' : 'Копия чека в приложении не запрошена')}</p>
      {order.state === 'pending' && <form onSubmit={confirm} className="space-y-2">
        <label className="block space-y-1">
          <span>{t('Полученная сумма в рублях')}</span>
          <input required className={inputClass} inputMode="decimal" maxLength={11} value={received}
            onChange={event => setReceived(event.target.value)} />
        </label>
        {amount !== null && amount !== order.amount && <p role="alert">{t('Сумма перевода отличается от суммы заказа')}</p>}
        <label className="block space-y-1">
          <span>{t('Номер операции в Сбере')}</span>
          <input required className={inputClass} minLength={3} maxLength={80} value={bankOperation}
            onChange={event => setBankOperation(event.target.value)} />
        </label>
        <label className="block space-y-1">
          <span>{t('Дата и время поступления по времени устройства')}</span>
          <input required className={inputClass} type="datetime-local" value={paid}
            onChange={event => setPaid(event.target.value)} />
        </label>
        {requested && <label className="block space-y-1">
          <span>{t('Ссылка на выданный чек из «Моего налога»')}</span>
          <input required className={inputClass} type="url" maxLength={512} value={receipt}
            onChange={event => setReceipt(event.target.value)} />
        </label>}
        <label className="flex items-center gap-2">
          <input type="checkbox" required checked={delivered} onChange={event => setDelivered(event.target.checked)} />
          {t('Чек выдан клиенту')}
        </label>
        <button type="submit" className={buttonClass} disabled={busy || !delivered || amount !== order.amount}>
          {t('Подтвердить оплату и открыть доступ')}
        </button>
      </form>}
      {order.state === 'pending' && <details className="space-y-2">
        <summary className="cursor-pointer font-semibold">{t('Закрыть неоплаченный заказ')}</summary>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={noTransfer} onChange={event => setNoTransfer(event.target.checked)} />
          {t('Я проверил выписку. Перевода нет.')}
        </label>
        <button type="button" disabled={busy || !noTransfer} className="press px-3 py-2 font-semibold"
          onClick={() => void run(() => api.post(url('/admin/service-plans/manual-orders/{orderId}/close', {
            orderId: order.id,
          }), { noTransferReceived: true }, { assertCurrent: assertOrigin }))}>{t('Закрыть заказ')}</button>
      </details>}
      {error && <p role="alert">{error}</p>}
      {order.manual?.receiptUrl && <a href={order.manual.receiptUrl} target="_blank" rel="noopener noreferrer"
        className="font-semibold underline">{t('Открыть чек')}</a>}
    </div>
  </details>
}
