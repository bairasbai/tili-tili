import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { api, url } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { servicePlanName } from '@/lib/servicePlanNames'

type Offer = components['schemas']['ServicePlanCatalog']['plans'][number]
type Order = components['schemas']['ServicePlanOrder']

export function ServicePlans({ vendor, targetId, assertOrigin }: {
  vendor: boolean
  targetId: string | null
  assertOrigin: () => void
}) {
  const [open, setOpen] = useState(false)
  const [parameters] = useSearchParams()
  const orderId = parameters.get('serviceOrder')
  const returnedOrder = orderId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(orderId) ? orderId : null
  const online = useProgramOnline()
  return (
    <>
      {returnedOrder && online && <OrderStatus orderId={returnedOrder} assertOrigin={assertOrigin} />}
      <details className="card px-4 py-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer font-semibold">{t('Тарифы сервиса')}</summary>
        {open && (online ? <PlanOffer vendor={vendor} targetId={targetId} assertOrigin={assertOrigin} /> : (
          <p role="status" className="mt-3">{t('Нет связи с сервером')}</p>
        ))}
      </details>
    </>
  )
}

function PlanOffer({ vendor, targetId, assertOrigin }: {
  vendor: boolean
  targetId: string | null
  assertOrigin: () => void
}) {
  const q = useApi(() => api.get('/users/me/service-plans', { assertCurrent: assertOrigin }), [assertOrigin])
  const plan = q.data?.plans.find(item => item.code === (vendor ? 'vendor_month' : 'wedding'))
  return (
    <div className="mt-3 space-y-2">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && (plan ? (
        <article className="rounded-xl border border-[var(--line)] p-3">
          <h3 className="font-semibold">{t(servicePlanName[plan.code])}</h3>
          <p>{fmt(plan.price.amount)}</p>
          {plan.checkoutAvailable && plan.checkoutTerms && targetId ? (
            <PlanCheckout plan={plan} targetId={targetId} assertOrigin={assertOrigin} />
          ) : <p>{t('Оплата тарифов пока недоступна.')}</p>}
        </article>
      ) : <p>{t('Тарифы пока недоступны.')}</p>)}
    </div>
  )
}

function PlanCheckout({ plan, targetId, assertOrigin }: { plan: Offer; targetId: string; assertOrigin: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [submittedOrder, setSubmittedOrder] = useState<Order | null>(null)
  const pending = useRef(false)
  const existing = useApi(() => api.get(url('/users/me/service-plan-orders/pending/{code}/{targetId}', {
    code: plan.code, targetId,
  }), { assertCurrent: assertOrigin }), [plan.code, targetId, assertOrigin])
  const previous = submittedOrder ?? existing.data?.order
  const terms = previous ? { version: previous.termsVersion, text: previous.termsText, hash: previous.termsHash } : plan.checkoutTerms
  async function startPayment() {
    if (pending.current || !terms) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const { order, confirmationUrl } = await api.post('/users/me/service-plan-orders', {
        code: plan.code, targetId, priceId: previous?.priceId ?? plan.price.id, termsVersion: terms.version, termsHash: terms.hash,
        ...(previous ? { resumeOrderId: previous.id } : {}),
      }, { assertCurrent: assertOrigin })
      assertOrigin()
      setSubmittedOrder(order)
      if (confirmationUrl && new URL(confirmationUrl).protocol === 'https:') window.location.assign(confirmationUrl)
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  return (
    <div className="mt-2 space-y-2">
      <AsyncState q={existing} forbiddenText={existing.forbiddenText} />
      {previous && <p>{t('Открытый заказ')} · {fmt(previous.amount)}</p>}
      {terms && <p>{terms.text}</p>}
      {error && <p role="alert">{error}</p>}
      {(!submittedOrder || submittedOrder.state === 'pending') && (
        <button disabled={busy || !ready(existing)} onClick={startPayment} type="button"
          className="press rounded-full grad text-[var(--on-grad)] px-4 py-2 disabled:opacity-50">
          {busy ? t('Загружаем…') : t(previous ? 'Продолжить оплату' : 'Перейти к оплате')}
        </button>
      )}
      {previous && <OrderStatus orderId={previous.id} assertOrigin={assertOrigin} />}
    </div>
  )
}

const orderState = {
  pending: 'Ожидаем подтверждение оплаты',
  paid: 'Оплата подтверждена',
  canceled: 'Оплата отменена',
  refunded: 'Возврат подтверждён',
} as const

function OrderStatus({ orderId, assertOrigin }: { orderId: string; assertOrigin: () => void }) {
  const q = useApi(() => api.get(url('/users/me/service-plan-orders/{orderId}', { orderId }),
    { assertCurrent: assertOrigin }), [orderId, assertOrigin])
  return (
    <section className="card px-4 py-3 text-sm" aria-label={t('Статус оплаты тарифа')}>
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && q.data && <>
        <p role="status">{t(orderState[q.data.state])} · {fmt(q.data.amount)}</p>
        {q.data.refundedAmount > 0 && <p>{t('Возвращено')} · {fmt(q.data.refundedAmount)}</p>}
        {q.data.state === 'pending' && <button type="button" onClick={q.reload} disabled={q.refreshing}
          className="press py-2 font-semibold">{t('Проверить оплату')}</button>}
      </>}
    </section>
  )
}
