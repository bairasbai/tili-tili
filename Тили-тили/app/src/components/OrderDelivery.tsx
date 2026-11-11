import { useId, useRef, useState } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { appendOrderDelivery, getOrderDelivery, type OrderDeliveryWrite } from '@/lib/api/orders'
import { explainError, useApi } from '@/lib/api/useApi'
import { t } from '@/lib/i18n'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { formatWeddingDate } from '@/lib/weddingDate'

const labels = {
  submitted: 'Результат сдан',
  changes_requested: 'Запрошены правки',
  accepted: 'Результат принят',
} as const

export function OrderDelivery({ dealId }: { dealId: string }) {
  const key = useLegacySessionKey(dealId)
  return <OrderDeliveryDisclosure key={key} dealId={dealId} />
}

function OrderDeliveryDisclosure({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false)
  const sectionId = useId()
  return (
    <section className="card-s p-4 mt-3">
      <button type="button" className="press w-full text-left font-semibold text-sm" aria-expanded={open}
        aria-controls={sectionId} onClick={() => setOpen(value => !value)}>{t('Материалы по сделке')}</button>
      <div id={sectionId}>{open && <OrderDeliveryDetails dealId={dealId} />}</div>
    </section>
  )
}

function OrderDeliveryDetails({ dealId }: { dealId: string }) {
  const capture = useLegacyActionScope(`order-delivery:${dealId}`)
  const q = useApi(() => getOrderDelivery(dealId, { assertCurrent: capture().assertCurrent }), [dealId, capture])
  const [summary, setSummary] = useState('')
  const [link, setLink] = useState('')
  const [dueOn, setDueOn] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const intent = useRef<{ payload: string; key: string } | null>(null)
  const delivery = ready(q) ? q.data : null
  const head = delivery?.steps[0]
  const disabled = busy || q.refreshing

  async function send(body: OrderDeliveryWrite) {
    if (disabled || pending.current || !delivery?.available) return
    const action = capture()
    if (!action.isCurrent()) return
    const payload = JSON.stringify(body)
    if (intent.current?.payload !== payload) intent.current = { payload, key: newIdempotencyKey() }
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await appendOrderDelivery(dealId, body, intent.current.key, action)
      if (!action.isCurrent()) return
      intent.current = null
      if (body.kind === 'submitted') { setSummary(''); setLink(''); setDueOn('') }
      if (body.kind === 'changes_requested') setComment('')
      q.reload()
    } catch (reason) {
      if (!action.isCurrent()) return
      setError(explainError(reason))
      if (reason instanceof ApiError && [403, 404, 409].includes(reason.status)) q.reload()
    } finally {
      pending.current = false
      if (action.isCurrent()) setBusy(false)
    }
  }

  return (
    <div className="mt-3 space-y-3 text-sm">
      <AsyncState q={q} />
      {delivery && <>
        {delivery.steps.length === 0 && <p>{t('Результат ещё не сдан.')}</p>}
        {delivery.steps.length > 0 && <ol className="space-y-2">
          {delivery.steps.map(step => <li key={step.revision} className="rounded-xl border border-[var(--line)] p-3">
            <p className="font-semibold">{t(labels[step.kind])}</p>
            {step.summary && <p className="break-words whitespace-pre-wrap">{step.summary}</p>}
            {step.dueOn && <p>{t('Срок сдачи')} · {formatWeddingDate(step.dueOn)}</p>}
            {step.materialUrl && <a className="underline" href={step.materialUrl} target="_blank" rel="noreferrer noopener">
              {t('Открыть материалы')}</a>}
            {step.comment && <p className="break-words whitespace-pre-wrap">{step.comment}</p>}
            <time className="block text-xs text-[var(--soft)]" dateTime={step.createdAt}>{formatWeddingDate(step.createdAt.slice(0, 10))}</time>
          </li>)}
        </ol>}
        {delivery.available && delivery.actorRole === 'vendor' && (!head || head.kind === 'changes_requested') && (
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault()
            void send({ kind: 'submitted', expectedRevision: delivery.revision, summary, materialUrl: link, dueOn })
          }}>
            <fieldset disabled={disabled} className="space-y-2">
              <label className="block">{t('Описание результата')}
                <textarea className="block w-full rounded-xl border p-2" required maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} />
              </label>
              <label className="block">{t('Ссылка на материалы')}
                <input className="block w-full rounded-xl border p-2" type="url" required maxLength={2048} value={link} onChange={event => setLink(event.target.value)} />
              </label>
              <label className="block">{t('Срок сдачи')}
                <input className="block w-full rounded-xl border p-2" type="date" required value={dueOn} onChange={event => setDueOn(event.target.value)} />
              </label>
              <button className="press grad px-4 py-2 rounded-full text-[var(--on-grad)]" type="submit">{t('Сдать результат')}</button>
            </fieldset>
          </form>
        )}
        {delivery.available && delivery.actorRole === 'couple' && head?.kind === 'submitted' && (
          <div className="space-y-2">
            <p>{t('Открытие ссылки не означает приёмку.')}</p>
            <button className="press grad px-4 py-2 rounded-full text-[var(--on-grad)]" type="button" disabled={disabled}
              onClick={() => void send({ kind: 'accepted', expectedRevision: head.revision })}>{t('Принять результат')}</button>
            <form className="space-y-2" onSubmit={event => {
              event.preventDefault()
              void send({ kind: 'changes_requested', expectedRevision: head.revision, comment })
            }}>
              <label className="block">{t('Что нужно исправить')}
                <textarea className="block w-full rounded-xl border p-2" required maxLength={1000} value={comment} disabled={disabled}
                  onChange={event => setComment(event.target.value)} />
              </label>
              <button className="press card-s px-4 py-2" type="submit" disabled={disabled}>{t('Запросить правки')}</button>
            </form>
          </div>
        )}
      </>}
      {error && <p role="alert" className="text-[var(--rose-ink)]">{error}</p>}
    </div>
  )
}
