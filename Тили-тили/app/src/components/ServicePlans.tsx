import { useState } from 'react'
import { AsyncState } from '@/components/AsyncState'
import { api } from '@/lib/api/client'
import { useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { fmt } from '@/lib/money'

export function ServicePlans({ vendor, assertOrigin }: { vendor: boolean; assertOrigin: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="card px-4 py-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer font-semibold">{t('Тарифы сервиса')}</summary>
      {open && <ServicePlanList vendor={vendor} assertOrigin={assertOrigin} />}
    </details>
  )
}

function ServicePlanList({ vendor, assertOrigin }: { vendor: boolean; assertOrigin: () => void }) {
  const q = useApi(() => api.get('/users/me/service-plans', { assertCurrent: assertOrigin }), [assertOrigin])
  const plans = q.data?.plans.filter(plan => plan.audience === (vendor ? 'vendor' : 'couple'))
  return (
    <div className="mt-3 space-y-3">
      <AsyncState q={q} />
      {!q.error && plans && (plans.length === 0 ? (
        <p>{t('Тарифы пока недоступны.')}</p>
      ) : (
        <>
          <p>{t('Оплата тарифов пока недоступна.')}</p>
          {plans.map(plan => (
            <article className="rounded-xl border border-[var(--line)] p-3" key={plan.id}>
              <h3 className="font-semibold">{plan.title}</h3>
              <p>{fmt(plan.price.amount)} · {plan.periodDays} {t('дн.')}</p>
              <ul aria-label={t('Лимиты тарифа')} className="list-disc pl-5 my-2">
                {plan.limits.map((limit, index) => <li key={index}>{limit}</li>)}
              </ul>
              <dl className="space-y-1">
                <dt className="font-semibold">{t('По окончании тарифа')}</dt>
                <dd>{plan.expiryTerms}</dd>
                <dt className="font-semibold">{t('Условия возврата')}</dt>
                <dd>{plan.refundTerms}</dd>
              </dl>
            </article>
          ))}
        </>
      ))}
    </div>
  )
}
