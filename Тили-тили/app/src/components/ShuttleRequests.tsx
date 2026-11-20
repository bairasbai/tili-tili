import { useState } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { getShuttleRequests, resolveShuttleRequest, type ShuttleChange, type ShuttleDecision } from '@/lib/api/shuttleChanges'
import { explainError, useApi } from '@/lib/api/useApi'
import { key, t } from '@/lib/i18n'

const statuses = {
  pending: key('Ожидает решения'),
  approved: key('Перенос подтверждён'),
  declined: key('Перенос отклонён'),
  withdrawn: key('Запрос закрыт'),
} satisfies Record<ShuttleChange['status'], string>

export function ShuttleRequestSummary({ request }: { request: ShuttleChange }) {
  return <p className="break-words">
    {request.fromLabel} → {request.toLabel} · {t(statuses[request.status])}
  </p>
}

export function ShuttleRequestList({ weddingId, onChanged }: { weddingId: string; onChanged: () => void }) {
  const q = useApi(() => getShuttleRequests(weddingId), [weddingId])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (requestId: string, decision: ShuttleDecision) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await resolveShuttleRequest(weddingId, requestId, decision)
      q.reload()
      onChanged()
    } catch (cause) {
      setError(explainError(cause))
    } finally {
      setBusy(false)
    }
  }

  return <div className="card p-4 space-y-3">
    <AsyncState q={q} />
    {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{error}</p>}
    {ready(q) && (q.data?.requests.length ? (
      <ul className="space-y-2">{q.data.requests.map(request => (
        <li key={request.id} className="rounded-xl bg-[var(--bg)] p-3 space-y-2 text-[12px]">
          <b>{request.passengerName}</b>
          <ShuttleRequestSummary request={request} />
          {request.status === 'pending' && <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void decide(request.id, 'approved')}
              className="press rounded-xl card-s px-3 py-2">{t('Подтвердить перенос')}</button>
            <button disabled={busy} onClick={() => void decide(request.id, 'declined')}
              className="press rounded-xl card-s px-3 py-2">{t('Отклонить перенос')}</button>
          </div>}
        </li>
      ))}</ul>
    ) : <p className="text-[12px] text-[var(--soft)]">{t('Запросов на перенос пока нет')}</p>)}
  </div>
}
