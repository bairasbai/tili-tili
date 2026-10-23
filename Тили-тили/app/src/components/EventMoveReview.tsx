import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from './AsyncState'
import { OfferComparisonTerms } from './OfferComparisonTerms'
import { acceptRootEventMove, getDealEventMoves, getRootEventMove, type EventMoveRootView, type EventMoveTarget } from '@/lib/api/eventMoves'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { fmt } from '@/lib/money'
import { t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'
import { eventMoveStatus } from '@/lib/eventMoveStatus'
export function EventMoveContext({ value }: { value: EventMoveTarget }) {
  return <p className="text-sm break-words">{formatWeddingDate(value.date)} · {value.timeZone} · {value.location ?? t('Место не задано')}</p>
}
/** Mount only inside the current private order's money surface. */
export function DealEventMoveLinks({ dealId }: { dealId: string }) {
  const key = useLegacySessionKey(dealId)
  return <DealEventMoveDisclosure key={key} dealId={dealId} />
}
function DealEventMoveDisclosure({ dealId }: { dealId: string }) {
  const [open, setOpen] = useState(false)
  return open ? <DealEventMoveLinksReader dealId={dealId} /> : <button type="button" onClick={() => setOpen(true)}
    className="press mt-4 rounded-lg bg-[var(--card)] p-3 text-sm">{t('Показать предложения переноса')}</button>
}
function DealEventMoveLinksReader({ dealId }: { dealId: string }) {
  const capture = useLegacyActionScope(dealId)
  const q = useApi(() => getDealEventMoves(dealId, { assertCurrent: capture().assertCurrent }), [dealId, capture])
  return <section className="mt-4 space-y-2">
    <h3 className="text-sm font-semibold">{t('Перенос мероприятия')}</h3>
    <AsyncState q={q} />
    {ready(q) && !q.data?.length && <p className="text-xs text-[var(--soft)]">{t('Предложений переноса пока нет')}</p>}
    {ready(q) && q.data?.map(row => <Link key={row.id} to={`/deal/${dealId}/event-moves/${row.id}`}
      className="block rounded-xl border border-[var(--line)] p-3 text-sm underline">{eventMoveStatus(row.status)}</Link>)}
  </section>
}
export function EventMoveReview({ dealId, proposalId }: { dealId: string; proposalId: string }) {
  const key = useLegacySessionKey(JSON.stringify([dealId, proposalId]))
  return <RootMoveReader key={key} dealId={dealId} proposalId={proposalId} />
}
function RootMoveReader({ dealId, proposalId }: { dealId: string; proposalId: string }) {
  const capture = useLegacyActionScope(JSON.stringify([dealId, proposalId]))
  const q = useApi(() => getRootEventMove(dealId, proposalId, { assertCurrent: capture().assertCurrent }), [dealId, proposalId, capture])
  return <section className="space-y-4">
    <AsyncState q={q} />
    <button type="button" disabled={q.loading || q.refreshing} onClick={q.reload} className="press rounded-lg bg-[var(--card)] p-3 text-sm">{t('Обновить предложение переноса')}</button>
    {ready(q) && q.data && <RootMoveForm key={JSON.stringify(q.data)} dealId={dealId} proposalId={proposalId}
      view={q.data} enabled={!q.refreshing} onChanged={q.reload} />}
  </section>
}
function RootMoveForm({ dealId, proposalId, view, enabled, onChanged }: {
  dealId: string; proposalId: string; view: EventMoveRootView; enabled: boolean; onChanged: () => void
}) {
  const [read, setRead] = useState(false), [busy, setBusy] = useState(false), [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false), attempt = useRef<string | null>(null)
  const capture = useLegacyActionScope(JSON.stringify([dealId, proposalId, view, enabled]))
  const material = view.material
  const accept = async () => {
    if (!enabled || !read || !view.readToken || view.status !== 'pending' || accepted || submitting.current) return
    const action = capture()
    action.assertCurrent()
    submitting.current = true; setBusy(true); setError(null)
    attempt.current ??= newIdempotencyKey()
    try {
      await acceptRootEventMove(dealId, proposalId, view.digest, view.readToken, attempt.current, { assertCurrent: action.assertCurrent })
      action.assertCurrent(); setAccepted(true); onChanged()
    } catch (e) {
      if (!action.isCurrent()) return
      if (e instanceof ApiError && !e.isDown && e.code !== 'idempotency_in_progress') attempt.current = null
      setError(explainError(e))
    } finally {
      // Only release this form's local request lock; stale outcomes stay fenced.
      submitting.current = false; setBusy(false)
    }
  }
  return <div className="space-y-4 rounded-xl border border-[var(--line)] p-4">
    <h2 className="text-lg font-semibold break-words">{material.event.name}</h2>
    <p className="text-sm">{eventMoveStatus(view.status)}</p>
    <div><h3 className="text-sm font-semibold">{t('Исходные условия')}</h3><EventMoveContext value={material.event.from} /></div>
    <div><h3 className="text-sm font-semibold">{t('Предлагаемые условия')}</h3><EventMoveContext value={material.event.to} /></div>
    <div className="space-y-2">
      <p className="text-sm font-semibold">{t('Цена сохраняется')}: {fmt(material.economics.amount)} {material.economics.currency}</p>
      <p className="text-sm">{material.economics.packageTitle ?? t('Без пакета')}</p>
      <ul className="list-disc pl-5 text-sm">{material.economics.packageIncludes?.map((line, index) => <li key={index}>{line}</li>)}</ul>
      <OfferComparisonTerms terms={material.economics.comparisonTerms} />
    </div>
    <div><h3 className="text-sm font-semibold">{t('Позиции этого заказа')}</h3>
      {material.assignments.length ? <ul className="list-disc pl-5 text-sm">{material.assignments.map(row => <li key={row.id}>{row.label}</li>)}</ul>
        : <p className="text-sm">{t('Основная позиция заказа')}</p>}
    </div>
    <p className="text-sm">{t('Цена, оплаты, сроки платежей и остальные мероприятия сохраняются. Часы программы не сдвигаются.')}</p>
    <ul className="space-y-1 text-xs">{view.receipts.map(row => <li key={row.id}>{t(row.party === 'customer' ? 'Согласие пары' : 'Согласие исполнителя')}: <time dateTime={row.acceptedAt}>{row.acceptedAt}</time></li>)}</ul>
    {view.status === 'pending' && view.readToken && !accepted && <>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={read} disabled={busy || !enabled} onChange={e => setRead(e.target.checked)} />{t('Я прочитал все условия переноса этого заказа и согласен с ними')}</label>
      <button type="button" disabled={!read || busy || !enabled} onClick={() => void accept()} className="press rounded-xl grad p-3 text-sm text-[var(--on-grad)] disabled:opacity-50">{t('Подтвердить перенос своего заказа')}</button>
    </>}
    {accepted && <p role="status" className="text-sm">{t('Согласие записано. Действующая бронь изменится только после применения переноса парой.')}</p>}
    {error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
  </div>
}
