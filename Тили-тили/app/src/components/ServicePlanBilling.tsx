import { useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { AsyncState, ready } from '@/components/AsyncState'
import { api, url } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { servicePlanName } from '@/lib/servicePlanNames'
import { ManualServiceCheckout } from './ManualServiceCheckout'

type Offer = components['schemas']['ServicePlanOfferCatalog']['plans'][number]
type Order = components['schemas']['ServicePlanOrder']

export function ServicePlanOrderNotice({ assertOrigin }: { assertOrigin: () => void }) {
  const [parameters] = useSearchParams()
  const orderId = parameters.get('serviceOrder')
  if (!orderId || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(orderId)) return null
  return <OrderStatus key={orderId} orderId={orderId} assertOrigin={assertOrigin} />
}

export function ServicePlanBilling({ vendor, targetId, assertOrigin, renderCatalog }: {
  vendor: boolean
  targetId: string | null
  assertOrigin: () => void
  renderCatalog: (showAvailability: boolean) => ReactNode
}) {
  const code = vendor ? 'vendor_month' : 'wedding'
  const offersPath = '/users/me/service-plan-offers'
  const q = useApi(() => targetId
    ? api.get(`${offersPath}?view=${code}` as typeof offersPath, { assertCurrent: assertOrigin })
    : Promise.resolve(null), [assertOrigin, code, targetId])
  const pricedPlan = targetId && ready(q) && !q.refreshing ? q.data?.plans.find(item => item.code === code) : undefined
  const plan = pricedPlan?.checkoutAvailable ? pricedPlan : undefined
  const manualAvailable = Boolean(plan && q.data?.manualCheckoutAvailable)
  const manualCheckout = targetId && pricedPlan && <ManualServiceCheckout key={targetId} plan={pricedPlan} targetId={targetId}
    available={manualAvailable} assertOrigin={assertOrigin} />
  return (
    <>
      {targetId && plan ? (
        <article className="mt-3 rounded-xl border border-[var(--line)] p-3">
          <h3 className="font-semibold">{t(servicePlanName[plan.code])}</h3>
          <p>{fmt(plan.price.amount, getI18nLang())}</p>
          {!manualAvailable && plan.checkoutTerms &&
            <PlanCheckout key={targetId} plan={plan} targetId={targetId} assertOrigin={assertOrigin} />}
          {manualCheckout}
        </article>
      ) : manualCheckout}
      {renderCatalog(!plan)}
    </>
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
  if (previous?.manual) return null
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
        <p role="status">{t(q.data.state === 'pending' && q.data.manual?.submittedAt
          ? 'Проверяем перевод' : orderState[q.data.state])} · {fmt(q.data.amount)}</p>
        {q.data.manual?.receiptUrl && <a href={q.data.manual.receiptUrl} target="_blank"
          rel="noopener noreferrer" className="font-semibold underline">{t('Открыть чек')}</a>}
        {q.data.refundedAmount > 0 && <p>{t('Возвращено')} · {fmt(q.data.refundedAmount)}</p>}
        {q.data.state === 'pending' && <button type="button" onClick={q.reload} disabled={q.refreshing}
          className="press py-2 font-semibold">{t('Проверить оплату')}</button>}
      </>}
    </section>
  )
}
