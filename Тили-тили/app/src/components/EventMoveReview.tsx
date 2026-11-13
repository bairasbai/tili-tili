import { useEffect, useRef, useState, type RefObject } from 'react'
import { Link } from 'react-router'
import { AsyncState, ready } from './AsyncState'
import { OfferComparisonTerms } from './OfferComparisonTerms'
import { acceptRootEventMove, getDealEventMoves, getRootEventMove, type EventMoveRootView } from '@/lib/api/eventMoves'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { fmt } from '@/lib/money'
import { t } from '@/lib/i18n'
import { formatWeddingDate } from '@/lib/weddingDate'
import { eventMoveStatus } from '@/lib/eventMoveStatus'
import { useLiveAccess } from '@/lib/offlineProgramHooks'
export function EventMoveContext({ value }: { value: { date: string | null; timeZone: string; location: string | null } }) {
  return <p className="text-sm break-words">{value.date === null ? t('Дата не задана') : formatWeddingDate(value.date)} · {value.timeZone} · {value.location ?? t('Место не задано')}</p>
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
  const online = useLiveAccess(q.reload)
  const moves = online && ready(q) && !q.refreshing ? q.data : null
  return <section className="mt-4 space-y-2">
    <h3 className="text-sm font-semibold">{t('Перенос мероприятия')}</h3>
    {online ? <AsyncState q={q} forbiddenText={q.forbiddenText} />
      : <p role="status" className="text-xs text-[var(--soft)]">{t('Нет связи с сервером')}</p>}
    {online && q.refreshing && <p role="status" className="text-xs text-[var(--soft)]">{t('Обновляем…')}</p>}
    {moves?.length === 0 && <p className="text-xs text-[var(--soft)]">{t('Предложений переноса пока нет')}</p>}
    {moves?.map(row => <Link key={row.id} to={`/deal/${dealId}/event-moves/${row.id}`}
      className="block rounded-xl border border-[var(--line)] p-3 text-sm underline">{eventMoveStatus(row.status)}</Link>)}
  </section>
}
export function EventMoveReview({ dealId, proposalId }: { dealId: string; proposalId: string }) {
  const key = useLegacySessionKey(JSON.stringify([dealId, proposalId]))
  return <RootMoveReader key={key} dealId={dealId} proposalId={proposalId} />
}
type MoveAttempt = { materialKey: string; key: string; digest: string; readToken: string }

function RootMoveReader({ dealId, proposalId }: { dealId: string; proposalId: string }) {
  const capture = useLegacyActionScope(JSON.stringify([dealId, proposalId]))
  const q = useApi(() => getRootEventMove(dealId, proposalId, { assertCurrent: capture().assertCurrent }), [dealId, proposalId, capture])
  const online = useLiveAccess(q.reload)
  const view = ready(q) ? q.data : null
  const materialKey = view && JSON.stringify([view.digest, view.status, view.material, view.receipts])
  const attempt = useRef<MoveAttempt | null>(null)
  const submitting = useRef(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (q.forbidden || q.failure?.status === 404 || q.failure?.status === 410 ||
      (materialKey !== null && attempt.current?.materialKey !== materialKey)) attempt.current = null
  }, [materialKey, q.failure, q.forbidden])
  return <section className="space-y-4">
    {online ? <AsyncState q={q} forbiddenText={q.forbiddenText} />
      : <p role="status" className="text-sm">{t('Нет связи с сервером')}</p>}
    {online && q.refreshing && <p role="status" className="text-sm">{t('Обновляем…')}</p>}
    <button type="button" disabled={!online || q.loading || q.refreshing} onClick={q.reload} className="press rounded-lg bg-[var(--card)] p-3 text-sm">{t('Обновить предложение переноса')}</button>
    {view && materialKey !== null && <RootMoveForm key={materialKey} dealId={dealId} proposalId={proposalId}
      view={view} materialKey={materialKey} attempt={attempt} submitting={submitting} busy={busy} setBusy={setBusy}
      enabled={online && !q.refreshing} onChanged={q.reload} />}
  </section>
}
function RootMoveForm({ dealId, proposalId, view, materialKey, attempt, submitting, busy, setBusy, enabled, onChanged }: {
  dealId: string; proposalId: string; view: EventMoveRootView; materialKey: string
  attempt: RefObject<MoveAttempt | null>; submitting: RefObject<boolean>; busy: boolean; setBusy: (value: boolean) => void
  enabled: boolean; onChanged: () => void
}) {
  const [read, setRead] = useState(false), [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capture = useLegacyActionScope(JSON.stringify([dealId, proposalId, view.digest, enabled]))
  const material = view.material
  const accept = async () => {
    if (!enabled || !navigator.onLine || !read || !view.readToken || view.status !== 'pending' || accepted || submitting.current) return
    const action = capture()
    action.assertCurrent()
    submitting.current = true; setBusy(true); setError(null)
    // The idempotency key must be retried with the original proof, even after a new read.
    const request = attempt.current?.materialKey === materialKey ? attempt.current
      : { materialKey, key: newIdempotencyKey(), digest: view.digest, readToken: view.readToken }
    attempt.current = request
    try {
      await acceptRootEventMove(dealId, proposalId, request.digest, request.readToken, request.key, { assertCurrent: action.assertCurrent })
      action.assertCurrent(); attempt.current = null; setAccepted(true); onChanged()
    } catch (e) {
      if (!action.isCurrent()) return
      if (e instanceof ApiError && !e.isDown && e.code !== 'idempotency_in_progress') attempt.current = null
      setError(explainError(e))
      if (e instanceof ApiError && e.code === 'event_move_read_expired') { setRead(false); onChanged() }
      if (e instanceof ApiError && [403, 404, 410].includes(e.status)) onChanged()
    } finally {
      // Release the request lock even when a refresh has retired this form.
      submitting.current = false; setBusy(false)
    }
  }
  if (!enabled) return null
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
