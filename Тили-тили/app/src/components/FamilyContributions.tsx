import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, beginLocalSessionAction, newIdempotencyKey, onSessionChanged, onSessionExpired } from '@/lib/api/client'
import { getFamilyContributionHistory, listFamilyContributions, saveFamilyContribution,
  type FamilyContribution, type FamilyContributionWrite } from '@/lib/api/familyContributions'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { fmt, parsePaymentRubles, paymentRubles } from '@/lib/money'
import { AsyncState, ready } from './AsyncState'

type Draft = { id: string; version: number; label: string; promised: string; received: string }
const input = 'block min-h-11 w-full rounded-xl bg-[var(--bg)] px-3 text-sm'
const button = 'min-h-11 rounded-xl border border-[var(--line)] px-3 text-xs font-semibold disabled:opacity-50'
const edit = (record: FamilyContribution): Draft => ({
  id: record.id, version: record.version, label: record.label,
  promised: record.promised.amount ? paymentRubles(record.promised.amount) : '',
  received: record.received.amount ? paymentRubles(record.received.amount) : '',
})

export function FamilyContributions({ weddingId }: { weddingId: string }) {
  const [open, setOpen] = useState(false)
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const invalidate = () => setExpired(true)
    const changed = onSessionChanged(invalidate), ended = onSessionExpired(invalidate)
    return () => { changed(); ended() }
  }, [])
  return <details className="card mt-3.5 p-4" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">{t('Вклад семьи')}</summary>
    {open && (expired
      ? <p role="alert" className="mt-3 text-sm">{t('Сессия изменилась — откройте бюджет заново.')}</p>
      : <FamilyContributionList weddingId={weddingId} />)}
  </details>
}

function FamilyContributionList({ weddingId }: { weddingId: string }) {
  const q = useApi(() => listFamilyContributions(weddingId), [weddingId])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [archive, setArchive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef<ReturnType<typeof beginLocalSessionAction> | null>(null)
  useEffect(() => () => { pending.current?.close(); pending.current = null }, [])

  function start(next: Draft | null) {
    setDraft(next)
    setArchive(null)
    setStale(false)
    setError(null)
  }

  async function write(id: string, body: FamilyContributionWrite) {
    if (pending.current || q.refreshing || stale) return
    const request = beginLocalSessionAction()
    pending.current = request
    setBusy(true)
    setError(null)
    try {
      await saveFamilyContribution(weddingId, id, body, request.assertCurrent)
      request.assertCurrent()
      if (pending.current !== request) return
      start(null)
      q.reload()
    } catch (cause) {
      if (pending.current !== request) return
      if (cause instanceof ApiError && cause.code === 'stale_family_contribution') {
        setStale(Boolean(draft || archive))
        q.reload()
      }
      setError(explainError(cause))
    } finally {
      if (pending.current === request) {
        request.close()
        pending.current = null
        setBusy(false)
      }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!draft) return
    const promised = draft.promised.trim() ? parsePaymentRubles(draft.promised, true) : 0
    const received = draft.received.trim() ? parsePaymentRubles(draft.received, true) : 0
    if (!draft.label.trim() || promised === null || received === null || (promised === 0 && received === 0)) {
      setError(t('Введите название и хотя бы одну сумму вклада.'))
      return
    }
    void write(draft.id, { version: draft.version, label: draft.label.trim(),
      promised: { amount: promised, currency: 'RUB' }, received: { amount: received, currency: 'RUB' }, archived: false })
  }

  function setArchived(record: FamilyContribution, archived: boolean) {
    void write(record.id, { version: record.version, label: record.label,
      promised: record.promised, received: record.received, archived })
  }

  const blocked = busy || q.refreshing
  if (!ready(q) || !q.data) return <AsyncState q={q} />
  return <div className="mt-3 space-y-3">
    <dl className="grid grid-cols-2 gap-2 text-xs">
      <div><dt>{t('Получено от семьи')}</dt><dd className="tabular font-semibold">{fmt(q.data.received.amount)}</dd></div>
      <div><dt>{t('Ещё обещано')}</dt><dd className="tabular font-semibold">{fmt(q.data.outstanding.amount)}</dd></div>
    </dl>
    {error && <p role="alert" className="text-xs text-[var(--rose-ink)]">{error}</p>}
    {draft ? <form onSubmit={submit} className="space-y-2">
      <fieldset disabled={blocked || stale} className="grid gap-2 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">{t('Название записи')}
          <input className={input} maxLength={120} value={draft.label}
            onChange={event => setDraft({ ...draft, label: event.target.value })} />
        </label>
        <label className="text-xs">{t('Обещанная сумма, ₽')}
          <input className={input} inputMode="decimal" value={draft.promised}
            onChange={event => setDraft({ ...draft, promised: event.target.value })} />
        </label>
        <label className="text-xs">{t('Полученная сумма, ₽')}
          <input className={input} inputMode="decimal" value={draft.received}
            onChange={event => setDraft({ ...draft, received: event.target.value })} />
        </label>
        <button type="submit" className={button}>{busy ? t('Сохраняем…') : t('Сохранить вклад')}</button>
      </fieldset>
      <button type="button" className={button} disabled={busy} onClick={() => start(null)}>{t('Отмена')}</button>
    </form> : <button type="button" className={button} disabled={blocked} onClick={() => start({
      id: newIdempotencyKey(), version: 0, label: '', promised: '', received: '',
    })}>{t('Добавить вклад')}</button>}
    {q.data.items.map(record => <div key={record.id} className="space-y-2 border-t border-[var(--line)] pt-2 text-xs">
      <p className="font-semibold">{record.label}</p>
      {record.archived && <p className="text-[var(--soft)]">{t('Запись в архиве')}</p>}
      <ContributionAmounts record={record} />
      <div className="flex flex-wrap gap-2">
        {record.archived
          ? <button type="button" className={button} disabled={blocked || stale} onClick={() => setArchived(record, false)}>{t('Восстановить вклад')}</button>
          : <button type="button" className={button} disabled={blocked} onClick={() => start(edit(record))}>{t('Исправить вклад')}</button>}
        {!record.archived && archive !== record.id && <button type="button" className={button} disabled={blocked}
          onClick={() => { start(null); setArchive(record.id) }}>{t('Убрать вклад в архив')}</button>}
      </div>
      {archive === record.id && <div className="space-y-1">
        <p>{t('Убрать этот вклад из сводки? Запись останется в истории.')}</p>
        <button type="button" className={button} disabled={blocked || stale} onClick={() => setArchived(record, true)}>{t('Убрать в архив')}</button>
        <button type="button" className={button} disabled={busy} onClick={() => start(null)}>{t('Отмена')}</button>
      </div>}
      {record.version > 1 && <ContributionHistory key={record.version} weddingId={weddingId} id={record.id} />}
    </div>)}
  </div>
}

function ContributionAmounts({ record }: { record: FamilyContribution }) {
  return <dl className="flex flex-wrap gap-x-3">
    <div><dt className="inline">{t('Обещанная сумма')}</dt>{' '}<dd className="inline tabular">{fmt(record.promised.amount)}</dd></div>
    <div><dt className="inline">{t('Полученная сумма')}</dt>{' '}<dd className="inline tabular">{fmt(record.received.amount)}</dd></div>
  </dl>
}

function ContributionHistory({ weddingId, id }: { weddingId: string; id: string }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-semibold">{t('История вклада')}</summary>
    {open && <ContributionVersions weddingId={weddingId} id={id} />}
  </details>
}

function ContributionVersions({ weddingId, id }: { weddingId: string; id: string }) {
  const q = useApi(() => getFamilyContributionHistory(weddingId, id), [weddingId, id])
  const time = new Intl.DateTimeFormat(getI18nLang(), { dateStyle: 'short', timeStyle: 'short' })
  if (!ready(q) || !q.data) return <AsyncState q={q} />
  return <ul className="mt-2 space-y-2">
    {q.data.items.map(record => <li key={record.version}>
      <p className="text-[var(--soft)]">{time.format(new Date(record.recordedAt))} · {record.label}</p>
      <ContributionAmounts record={record} />
      {record.archived && <p>{t('Запись в архиве')}</p>}
    </li>)}
  </ul>
}
