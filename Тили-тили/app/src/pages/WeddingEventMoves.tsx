import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { EventMoveContext } from '@/components/EventMoveReview'
import { eventMoveStatus } from '@/lib/eventMoveStatus'
import { applyEventMove, cancelEventMove, getEventMoveProposals, proposeEventMove, type EventMoveProposal, type EventMoveTarget } from '@/lib/api/eventMoves'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { listMyWeddings } from '@/lib/api/wedding'
import { getWeddingEventsSnapshot } from '@/lib/api/weddingData'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { useStore } from '@/lib/store'
import { useLegacyActionScope, useLegacySessionKey } from '@/lib/useLegacyActionScope'
import { t } from '@/lib/i18n'

export default function WeddingEventMoves() {
  const { eventId } = useParams(), { weddingId } = useStore()
  const key = useLegacySessionKey(JSON.stringify([weddingId, eventId]))
  return <div className="pb-28"><TopBar back title={t('Перенос мероприятия')} /><div className="px-5">
    {weddingId && eventId ? <MoveManager key={key} weddingId={weddingId} eventId={eventId} /> : <p>{t('Выберите мероприятие своей свадьбы')}</p>}
  </div></div>
}
function MoveManager({ weddingId, eventId }: { weddingId: string; eventId: string }) {
  const capture = useLegacyActionScope(JSON.stringify([weddingId, eventId]), weddingId)
  const q = useApi(async () => {
    const action = capture(), options = { assertCurrent: action.assertCurrent }
    const weddings = await listMyWeddings(options)
    action.assertCurrent()
    if (weddings.find(w => w.id === weddingId)?.role !== 'couple') throw new ApiError('http', 403, 'forbidden', t('Перенос согласует пара'))
    const [events, proposals] = await Promise.all([getWeddingEventsSnapshot(weddingId, options), getEventMoveProposals(weddingId, eventId, options)])
    action.assertCurrent()
    const event = events.data.find(row => row.id === eventId)
    if (!event || event.isMain || !events.etag) return noWedding<never>()
    return { event, proposals, version: events.etag }
  }, [weddingId, eventId, capture])
  return <div className="space-y-4">
    <Link to="/wedding/events" className="text-sm underline">{t('Мероприятия')}</Link>
    <AsyncState q={q} />
    <button type="button" disabled={q.loading || q.refreshing} onClick={q.reload} className="press rounded-lg bg-[var(--card)] p-3 text-sm">{t('Обновить предложения переноса')}</button>
    {ready(q) && q.data && <>
      <h2 className="text-lg font-semibold">{q.data.event.name}</h2>
      <div><h3 className="text-sm font-semibold">{t('Действующие условия')}</h3>
        {q.data.event.date && q.data.event.timeZone ? <EventMoveContext value={{ date: q.data.event.date, timeZone: q.data.event.timeZone, location: q.data.event.location }} />
          : <p className="text-sm">{q.data.event.date ?? t('Дата не задана')} · {q.data.event.timeZone ?? t('Часовой пояс не задан')} · {q.data.event.location ?? t('Место не задано')}</p>}
      </div>
      <p className="text-sm">{t('Предложение не меняет действующую дату или бронь. Для каждого заказа нужны отдельные согласия пары и исполнителя.')}</p>
      <MoveProposalForm key={JSON.stringify([q.data.event, q.data.version])} weddingId={weddingId} eventId={eventId}
        initial={{ date: q.data.event.date ?? '', timeZone: q.data.event.timeZone ?? '', location: q.data.event.location }}
        version={q.data.version} enabled={!q.refreshing} onChanged={q.reload} />
      {q.data.proposals.map(proposal => <ProposalActions key={JSON.stringify(proposal)} weddingId={weddingId} eventId={eventId}
        proposal={proposal} enabled={!q.refreshing} onChanged={q.reload} />)}
    </>}
  </div>
}
function MoveProposalForm({ weddingId, eventId, initial, version, enabled, onChanged }: {
  weddingId: string; eventId: string; initial: EventMoveTarget; version: string; enabled: boolean; onChanged: () => void
}) {
  const [target, setTarget] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null), submitting = useRef(false)
  const scope = JSON.stringify([weddingId, eventId, initial, target, version, enabled])
  const capture = useLegacyActionScope(scope, weddingId)
  const submit = async () => {
    if (!enabled || submitting.current || !target.date || !target.timeZone || JSON.stringify(target) === JSON.stringify(initial)) return
    const action = capture(); action.assertCurrent()
    submitting.current = true; setBusy(true); setError(null)
    const fingerprint = JSON.stringify([target, version])
    if (!attempt.current || attempt.current.fingerprint !== fingerprint) attempt.current = { fingerprint, key: newIdempotencyKey() }
    try {
      await proposeEventMove(weddingId, eventId, target, version, attempt.current.key, { assertCurrent: action.assertCurrent })
      action.assertCurrent(); attempt.current = null; onChanged()
    } catch (e) {
      if (!action.isCurrent()) return
      if (e instanceof ApiError && !e.isDown && e.code !== 'idempotency_in_progress') attempt.current = null
      setError(explainError(e))
    } finally {
      // Refresh retires response authority, but this settled request still owns
      // its form's local lock. Keep the uncertain intent key for an explicit retry.
      submitting.current = false; setBusy(false)
    }
  }
  const field = 'mt-1 block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2'
  const update = (value: EventMoveTarget) => { attempt.current = null; setTarget(value) }
  return <form className="space-y-3 rounded-xl border border-[var(--line)] p-4" onSubmit={e => { e.preventDefault(); void submit() }}>
    <fieldset disabled={busy || !enabled} className="space-y-3 text-sm">
      <label className="block">{t('Новая дата')}<input required type="date" min="2000-01-01" max="2100-12-31" value={target.date} onChange={e => update({ ...target, date: e.target.value })} className={field} /></label>
      <label className="block">{t('Часовой пояс')}<select required value={target.timeZone} onChange={e => update({ ...target, timeZone: e.target.value })} className={field}>
        <option value="">{t('Часовой пояс не задан')}</option>{[...new Set(['UTC', ...(target.timeZone ? [target.timeZone] : []), ...Intl.supportedValuesOf('timeZone')])].sort().map(zone => <option key={zone}>{zone}</option>)}
      </select></label>
      <label className="block">{t('Место мероприятия')}<input maxLength={300} value={target.location ?? ''} onChange={e => update({ ...target, location: e.target.value || null })} className={field} /></label>
      <button type="submit" disabled={!target.date || !target.timeZone || JSON.stringify(target) === JSON.stringify(initial)} className="press rounded-xl grad p-3 text-[var(--on-grad)] disabled:opacity-50">{t('Предложить перенос')}</button>
    </fieldset>
    {error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
  </form>
}
function ProposalActions({ weddingId, eventId, proposal, enabled, onChanged }: {
  weddingId: string; eventId: string; proposal: EventMoveProposal; enabled: boolean; onChanged: () => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const attempts = useRef<Partial<Record<'apply' | 'cancel', string>>>({}), submitting = useRef(false)
  const capture = useLegacyActionScope(JSON.stringify([weddingId, eventId, proposal, enabled]), weddingId)
  const allAgreed = proposal.roots.length > 0 && proposal.roots.every(root => root.receipts.some(r => r.party === 'customer') && root.receipts.some(r => r.party === 'performer'))
  const act = async (kind: 'apply' | 'cancel') => {
    if (!enabled || submitting.current || (kind === 'apply' && (proposal.status !== 'pending' || !allAgreed))
      || (kind === 'cancel' && proposal.status !== 'pending' && proposal.status !== 'stale')) return
    const action = capture(); action.assertCurrent()
    submitting.current = true; setBusy(true); setError(null)
    const key = attempts.current[kind] ??= newIdempotencyKey()
    try {
      await (kind === 'apply' ? applyEventMove : cancelEventMove)(weddingId, eventId, proposal.id, proposal.digest, key, { assertCurrent: action.assertCurrent })
      action.assertCurrent(); delete attempts.current[kind]; onChanged()
    } catch (e) {
      if (!action.isCurrent()) return
      if (e instanceof ApiError && !e.isDown && e.code !== 'idempotency_in_progress') delete attempts.current[kind]
      setError(explainError(e))
    } finally {
      submitting.current = false; setBusy(false)
    }
  }
  return <article className="space-y-3 rounded-xl border border-[var(--line)] p-4">
    <h3 className="font-semibold">{eventMoveStatus(proposal.status)}</h3>
    <div><p className="text-sm font-semibold">{t('Исходные условия')}</p><EventMoveContext value={proposal.from} /></div>
    <div><p className="text-sm font-semibold">{t('Предлагаемые условия')}</p><EventMoveContext value={proposal.to} /></div>
    <ul className="space-y-2">{proposal.roots.map((root, index) => <li key={root.dealId}>
      <Link to={`/deal/${root.dealId}/event-moves/${proposal.id}`} className="text-sm underline">{t('Прочитать и согласовать заказ')} {index + 1}</Link>
      <p className="text-xs text-[var(--soft)]">{t('Согласие пары')}: {t(root.receipts.some(r => r.party === 'customer') ? 'Получено' : 'Ожидается')} · {t('Согласие исполнителя')}: {t(root.receipts.some(r => r.party === 'performer') ? 'Получено' : 'Ожидается')}</p>
    </li>)}</ul>
    {proposal.status === 'pending' && <button type="button" disabled={!enabled || busy || !allAgreed} onClick={() => void act('apply')} className="press rounded-xl grad p-3 text-sm text-[var(--on-grad)] disabled:opacity-50">{t('Применить согласованный перенос')}</button>}
    {(proposal.status === 'pending' || proposal.status === 'stale') && <button type="button" disabled={!enabled || busy} onClick={() => void act('cancel')} className="press rounded-lg bg-[var(--card)] p-3 text-sm">{t('Отменить предложение переноса')}</button>}
    {error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
  </article>
}
