import { useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { TopBar } from '@/components/chrome'
import { servicePlanName } from '@/lib/servicePlanNames'
import { api, beginLocalSessionAction, onSessionChanged, onSessionExpired, SESSION_EXPIRED, url } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt, rub } from '@/lib/money'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { ManualServiceReview } from '@/components/ManualServiceReview'

type AdminPlan = components['schemas']['AdminServicePlanCatalog']['plans'][number]
export function AdminServicePlans() {
  const origin = useRef<ReturnType<typeof beginLocalSessionAction> | null>(null)
  const [retired, setRetired] = useState(false)
  const online = useProgramOnline()
  const assertOrigin = useCallback(() => {
    if (!origin.current) throw new Error(t(SESSION_EXPIRED))
    origin.current.assertCurrent()
  }, [])
  useLayoutEffect(() => {
    const current = beginLocalSessionAction()
    origin.current = current
    const retire = () => { current.close(); setRetired(true) }
    const unsubscribeChange = onSessionChanged(retire)
    const unsubscribeExpiry = onSessionExpired(retire)
    return () => { origin.current = null; current.close(); unsubscribeChange(); unsubscribeExpiry() }
  }, [])
  return (
    <div className="pb-28">
      <TopBar back fallback="/admin" title={t('Тарифы сервиса')} />
      <div className="px-5 mt-4">
        {retired ? <p role="alert">{t('Доступ и данные требуют нового чтения')}</p> : (
          online ? <div className="space-y-4">
            <ManualServiceReview assertOrigin={assertOrigin} />
            <PriceCatalog assertOrigin={assertOrigin} />
          </div> : <p role="status">{t('Нет связи с сервером')}</p>
        )}
      </div>
    </div>
  )
}

function PriceCatalog({ assertOrigin }: { assertOrigin: () => void }) {
  const q = useApi(() => api.get('/admin/service-plans', { assertCurrent: assertOrigin }), [assertOrigin])
  return (
    <div className="space-y-4">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && q.data?.plans.map(plan => (
        <PriceForm key={plan.code + (plan.latestVersionId ?? '')} plan={plan} assertOrigin={assertOrigin}
          reload={q.reload} refreshing={q.refreshing} />
      ))}
    </div>
  )
}

function dateTime(value: string): string {
  return new Intl.DateTimeFormat(getI18nLang(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

function PriceForm({ plan, assertOrigin, reload, refreshing }: {
  plan: AdminPlan
  assertOrigin: () => void
  reload: () => void
  refreshing: boolean
}) {
  const formId = useId()
  const [rubles, setRubles] = useState('')
  const [start, setStart] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const active = plan.history.find(item => item.id === plan.activeVersionId)
  const scheduled = plan.history.find(item => item.id === plan.scheduledVersionId)
  const amount = /^[0-9]+$/.test(rubles) ? rub(Number(rubles)) : null
  const validAmount = amount !== null && amount >= 100 && amount <= 2147483600
  const requestedStart = start ? new Date(start) : null

  async function publish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current || refreshing || !validAmount) return
    if (requestedStart && !(requestedStart.getTime() > Date.now())) {
      setError(t('Укажите будущую дату или опубликуйте сейчас'))
      return
    }
    pending.current = true
    setBusy(true)
    setError('')
    try {
      await api.post(url('/admin/service-plans/{code}/prices', { code: plan.code }), {
        amount, effectiveAt: requestedStart?.toISOString() ?? null, expectedVersionId: plan.latestVersionId,
        expectedActiveVersionId: plan.activeVersionId,
      }, { assertCurrent: assertOrigin })
      assertOrigin()
      reload()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }

  return (
    <section className="card p-4 space-y-3" aria-labelledby={formId}>
      <h2 className="font-semibold" id={formId}>{t(servicePlanName[plan.code])}</h2>
      <dl className="text-sm space-y-1">
        <dt>{t('Действующая цена')}</dt>
        <dd>{active ? fmt(active.amount) : t('Цена ещё не опубликована')}</dd>
        {scheduled && <>
          <dt>{t('Запланированная цена')}</dt>
          <dd>{fmt(scheduled.amount)} · {dateTime(scheduled.effectiveAt)}</dd>
        </>}
      </dl>
      <form onSubmit={publish} className="space-y-3">
        <label className="block space-y-1">
          <span>{t('Новая цена в рублях')}</span>
          <input className="block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2"
            inputMode="numeric" value={rubles} onChange={event => setRubles(event.target.value)} maxLength={8} required />
        </label>
        <label className="block space-y-1">
          <span>{t('Дата начала по времени устройства')}</span>
          <input className="block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2"
            type="datetime-local" value={start} onChange={event => setStart(event.target.value)} />
        </label>
        <p className="text-sm text-[var(--soft)]">{t('Пустая дата означает публикацию сейчас.')}</p>
        {scheduled && <p className="text-sm">{t('Публикация заменит запланированную цену.')}</p>}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy || refreshing || !validAmount}
          className="press rounded-full grad text-[var(--on-grad)] px-4 py-2 font-bold disabled:opacity-50">
          {busy ? t('Сохраняем…') : t('Применить цену')}
        </button>
        {error && <button type="button" onClick={reload} className="press px-3 py-2">{t('Обновить тарифы')}</button>}
      </form>
      {plan.history.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-semibold">{t('Последние публикации')}</summary>
          <ul className="mt-2 space-y-2">
            {plan.history.map(item => (
              <li key={item.id}>
                <p>{fmt(item.amount)} · {dateTime(item.effectiveAt)}</p>
                <p className="break-all text-[var(--soft)]">
                  {dateTime(item.publishedAt)} · {item.publishedBy ?? t('Профиль автора недоступен')}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
