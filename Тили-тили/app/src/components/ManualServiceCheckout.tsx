import { useRef, useState, type FormEvent } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { api, url } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'

type Catalog = components['schemas']['ServicePlanCatalog']

const inputClass = 'block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2'
const buttonClass = 'press rounded-full grad text-[var(--on-grad)] px-4 py-2 disabled:opacity-50'

export function ManualServiceCheckout({ plan, targetId, available, assertOrigin }: {
  plan: Catalog['plans'][number]
  targetId: string
  available: boolean
  assertOrigin: () => void
}) {
  const q = useApi(() => api.get(url('/users/me/service-plan-orders/manual/{code}/{targetId}', {
    code: plan.code, targetId,
  }), { assertCurrent: assertOrigin }), [plan.code, targetId, assertOrigin])
  const [saveReceiptCopy, setSaveReceiptCopy] = useState(false)
  const [email, setEmail] = useState('')
  const [business, setBusiness] = useState(false)
  const [inn, setInn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const orders = q.data?.orders ?? []
  const order = orders.find(item => item.state === 'pending')
  const transfer = order?.manual?.transfer
  const history = orders.filter(item => item.state !== 'pending')
  const alreadyPaid = plan.code === 'wedding' && history.some(item => item.state === 'paid')
  const terms = plan.checkoutTerms

  async function run(action: () => Promise<unknown>) {
    if (pending.current || q.refreshing) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      assertOrigin()
      q.reload()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!terms || !available) return
    void run(() => api.post('/users/me/service-plan-orders', {
      code: plan.code, targetId, priceId: plan.price.id, termsVersion: terms.version, termsHash: terms.hash,
      manual: { saveReceiptCopy, receiptEmail: email.trim(), ...(business ? { receiptInn: inn.trim() } : {}) },
    }, { assertCurrent: assertOrigin }))
  }

  if (!available && !q.data?.orders.length && !q.data?.active) return null

  return <section className="mt-3 space-y-3">
    <AsyncState q={q} forbiddenText={q.forbiddenText} />
    {q.data?.active && <p role="status">{t('Доступ по тарифу активен')}</p>}
    {error && <p role="alert">{error}</p>}
    {ready(q) && order && <div className="space-y-2">
      <h4 className="font-semibold">{t('Перевод по QR Сбера')}</h4>
      <p>{t('Сумма перевода')} · {fmt(order.amount)}</p>
      <p className="break-all">{t('Номер заказа')} · {order.id}</p>
      {order.manual?.submittedAt ? (
        <p role="status">{t('Проверяем перевод')}</p>
      ) : <>
        {transfer && <>
          <p>{t('Если в Сбере есть поле для комментария, укажите номер заказа.')}</p>
          <img className="h-auto max-w-full rounded-lg" width={192} height={192}
            src={`data:image/jpeg;base64,${transfer.qrJpegBase64}`} alt={t('QR для перевода в Сбере')} />
          <a className="inline-block font-semibold underline" href={transfer.url} target="_blank" rel="noopener noreferrer">
            {t('Открыть ссылку Сбера')}
          </a>
        </>}
        <button type="button" disabled={busy || q.refreshing} className={buttonClass}
          onClick={() => void run(() => api.post(url('/users/me/service-plan-orders/{orderId}/report-transfer', {
            orderId: order.id,
          }), undefined, { assertCurrent: assertOrigin }))}>
          {t('Я оплатил')}
        </button>
      </>}
      <button type="button" onClick={q.reload} disabled={busy || q.refreshing}
        className="press px-3 py-2 font-semibold">{t('Обновить статус')}</button>
    </div>}
    {ready(q) && !order && !alreadyPaid && !(plan.code === 'wedding' && q.data?.active) && available && terms && (
      <form className="space-y-3" onSubmit={start}>
        <h4 className="font-semibold">{t('Перевод по QR Сбера')}</h4>
        <p>{terms.text}</p>
        <label className="block space-y-1">
          <span>{t('Электронная почта для чека')}</span>
          <input required type="email" autoComplete="email" maxLength={254} value={email}
            className={inputClass} onChange={event => setEmail(event.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={business} onChange={event => setBusiness(event.target.checked)} />
          {t('Плачу от компании или ИП')}
        </label>
        {business && <label className="block space-y-1">
          <span>{t('ИНН покупателя')}</span>
          <input required inputMode="numeric" maxLength={12} pattern="[0-9]{10}([0-9]{2})?"
            className={inputClass} value={inn} onChange={event => setInn(event.target.value)} />
        </label>}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={saveReceiptCopy} onChange={event => setSaveReceiptCopy(event.target.checked)} />
          {t('Сохранить копию чека в «Тили-тили»')}
        </label>
        <button type="submit" className={buttonClass} disabled={busy || q.refreshing}>{t('Получить QR для оплаты')}</button>
      </form>
    )}
    {ready(q) && history.length > 0 && <details className="space-y-2">
      <summary className="cursor-pointer font-semibold">{t('История переводов')}</summary>
      <ul className="space-y-2">
        {history.map(item => <li key={item.id}>
          <p>{fmt(item.amount)} · {t(item.state === 'paid' ? 'Оплата подтверждена'
            : item.state === 'refunded' ? 'Возврат подтверждён' : 'Оплата отменена')}</p>
          {item.manual?.receiptUrl && (
            <a href={item.manual.receiptUrl} target="_blank" rel="noopener noreferrer"
              className="font-semibold underline">{t('Открыть чек')}</a>
          )}
        </li>)}
      </ul>
    </details>}
  </section>
}
