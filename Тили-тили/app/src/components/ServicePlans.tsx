import { useState } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { api } from '@/lib/api/client'
import { useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt } from '@/lib/money'
import { useProgramOnline } from '@/lib/offlineProgramHooks'

export function ServicePlans({ vendor, assertOrigin }: { vendor: boolean; assertOrigin: () => void }) {
  const [open, setOpen] = useState(false)
  const online = useProgramOnline()
  return (
    <details className="card px-4 py-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="min-h-11 cursor-pointer py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--rose)]">{t('Тарифы сервиса')}</summary>
      {open && (online ? <ServicePlanList vendor={vendor} assertOrigin={assertOrigin} /> : (
        <p role="status" className="mt-3">{t('Нет связи с сервером')}</p>
      ))}
    </details>
  )
}

function ServicePlanList({ vendor, assertOrigin }: { vendor: boolean; assertOrigin: () => void }) {
  const q = useApi(() => api.get('/users/me/service-plans', { assertCurrent: assertOrigin }), [assertOrigin])
  const plans = q.data?.plans.filter(plan => plan.audience === (vendor ? 'vendor' : 'couple'))
  const lang = getI18nLang()
  return (
    <div className="mt-3 space-y-3">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && plans && (plans.length === 0 ? (
        <p>{t('Тарифы пока недоступны.')}</p>
      ) : (
        <>
          <p>{t('Оплата тарифов пока недоступна.')}</p>
          {plans.map(plan => (
            <article className="min-w-0 rounded-xl border border-[var(--line)] p-3 [overflow-wrap:anywhere]" key={plan.id}>
              <h3 className="font-semibold">{plan.title}</h3>
              <p>{fmt(plan.price.amount, lang)} · {new Intl.NumberFormat(lang).format(plan.periodDays)} {t('дн.')}</p>
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
