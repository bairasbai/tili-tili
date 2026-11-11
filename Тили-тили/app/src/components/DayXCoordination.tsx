import { useId, useRef, useState, type FormEvent } from 'react'
import { AsyncState, ready } from '@/components/AsyncState'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api/client'
import { explainError, useApi } from '@/lib/api/useApi'
import { getDayXCoordination, updateDayXPerformer, type DayXPerformer, type DayXPerformerUpdate } from '@/lib/api/weddingWrite'
import { getI18nLang, t } from '@/lib/i18n'
import { formatOrderLocal, parseOrderLocal } from '@/lib/orderTime'
import { programTime } from '@/lib/timelineClock'
import { useLegacyActionScope } from '@/lib/useLegacyActionScope'

type Patch = Omit<DayXPerformerUpdate, 'scopeKey' | 'expectedRevision'>
const actionsClass = 'flex flex-wrap items-center gap-2'
const safePhone = (value: string | null) => {
  const phone = value?.replace(/[\s()-]/g, '')
  return phone && /^\+?\d{5,20}$/.test(phone) ? phone : null
}

export function DayXCoordination({ weddingId }: { weddingId: string }) {
  const capture = useLegacyActionScope('dayx-coordination', weddingId)
  const q = useApi(() => getDayXCoordination(weddingId, capture().assertCurrent), [weddingId, capture])
  const [error, setError] = useState<string | null>(null)
  const performers = q.data?.performers ?? [], openTasks = q.data?.openTasks ?? []
  const submit = async (performer: DayXPerformer, changes: Patch) => {
    if (!performer.scopeKey || !navigator.onLine) return
    const origin = capture()
    setError(null)
    try {
      await updateDayXPerformer(weddingId, performer.dealId, {
        scopeKey: performer.scopeKey, expectedRevision: performer.revision, ...changes,
      }, origin.assertCurrent)
      origin.assertCurrent()
      q.reload()
    } catch (failure) {
      if (!origin.isCurrent()) return
      setError(explainError(failure))
      if (failure instanceof ApiError && [401, 403, 404, 409].includes(failure.status)) q.reload()
    }
  }

  return (
    <section className="mt-4 space-y-3 rounded-[26px] bg-[var(--card)] p-4" aria-label={t('Сводка координатора')}>
      <h2 className="text-sm font-semibold">{t('Сводка координатора')}</h2>
      <AsyncState q={q} />
      {error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
      {ready(q) && q.data && (
        <>
          {performers.map(performer => <Performer key={`${performer.dealId}:${performer.scopeKey}:${performer.revision}`}
            performer={performer} disabled={q.refreshing} submit={changes => submit(performer, changes)} />)}
          <details className="space-y-2">
            <summary className="cursor-pointer py-2 text-sm font-semibold">{t('Незакрытые задачи')} · {openTasks.length}</summary>
            {openTasks.length === 0 ? <p className="text-xs">{t('Незакрытых задач нет')}</p> : (
              <ul className="space-y-1 text-xs">{openTasks.map(task => (
                <li key={task.id} className="break-words">
                  {task.title}{task.due && ` · ${task.due}`}{task.assignee && ` · ${task.assignee}`}
                </li>
              ))}</ul>
            )}
          </details>
        </>
      )}
    </section>
  )
}

function Performer({ performer, disabled, submit }: { performer: DayXPerformer; disabled: boolean; submit: (patch: Patch) => Promise<void> }) {
  const zone = performer.event?.timeZone ?? null
  const localId = useId(), active = useRef(false)
  const [draft, setDraft] = useState(() => performer.plannedArrivalAt ? formatOrderLocal(performer.plannedArrivalAt, zone) ?? '' : '')
  const [offset, setOffset] = useState('')
  const [busy, setBusy] = useState(false)
  const [timeError, setTimeError] = useState(false)
  const time = draft ? parseOrderLocal(draft, zone) : null
  const chosen = time?.status === 'valid' ? time.candidate : time?.status === 'ambiguous'
    ? time.candidates.find(candidate => String(candidate.offsetMinutes) === offset)
    : undefined
  const canEdit = !!performer.scopeKey && !busy && !disabled
  const phone = safePhone(performer.phone)
  const write = async (changes: Patch) => {
    if (!canEdit || active.current) return
    active.current = true
    setBusy(true)
    try { await submit(changes) } finally { active.current = false; setBusy(false) }
  }
  const saveTime = (event: FormEvent) => {
    event.preventDefault()
    if (draft && !chosen) { setTimeError(true); return }
    setTimeError(false)
    void write({ plannedArrivalAt: chosen?.instant ?? null })
  }

  return (
    <article className="min-w-0 space-y-2 rounded-xl border border-[var(--line)] p-3 text-xs">
      <h3 className="break-words font-semibold">{performer.name || t(performer.label)}</h3>
      {performer.event && <p className="break-words">{performer.event.name}{performer.event.date && ` · ${performer.event.date}`}</p>}
      {phone && <a href={`tel:${phone}`} className="inline-flex min-h-8 items-center underline">{t('Позвонить')} · {performer.phone}</a>}
      <p>{t('Плановый приезд')} · {programTime(performer.plannedArrivalAt, zone, getI18nLang()) ?? t('Не указано')}</p>
      <Observation title={t('Прибытие')} value={performer.arrival} zone={zone} />
      <Observation title={t('Готовность')} value={performer.readiness} zone={zone} />
      {!performer.scopeKey ? <p>{t('Для отметок нужна дата и часовой пояс мероприятия.')}</p> : (
        <>
          <form onSubmit={saveTime} className="space-y-2">
            <label className="block" htmlFor={localId}>{t('Время приезда по месту мероприятия')} · {zone}</label>
            <div className={actionsClass}>
              <Input id={localId} type="datetime-local" className="w-auto min-w-0 max-w-full" value={draft} disabled={!canEdit}
                onChange={event => { setDraft(event.target.value); setOffset(''); setTimeError(false) }} />
              <Button size="sm" type="submit" disabled={!canEdit}>{t('Сохранить время')}</Button>
            </div>
            {time?.status === 'ambiguous' && <label className="block">
              {t('Уточните смещение времени')}
              <select value={offset} disabled={!canEdit} onChange={event => { setOffset(event.target.value); setTimeError(false) }} className="ml-2 border border-input">
                <option value="">{t('Выбрать')}</option>
                {time.candidates.map(candidate => <option key={candidate.instant} value={candidate.offsetMinutes}>{candidate.instant}</option>)}
              </select>
            </label>}
            {timeError && <p role="alert">{t('Выберите существующее местное время.')}</p>}
          </form>
          <div className={actionsClass}>
            <Button size="sm" type="button" variant="outline" disabled={!canEdit} onClick={() => void write({ arrived: !performer.arrival })}>
              {t(performer.arrival ? 'Снять отметку прибытия' : 'Отметить прибытие')}
            </Button>
            <Button size="sm" type="button" variant="outline" disabled={!canEdit} onClick={() => void write({ ready: !performer.readiness })}>
              {t(performer.readiness ? 'Снять отметку готовности' : 'Отметить готовность')}
            </Button>
          </div>
        </>
      )}
    </article>
  )
}

function Observation({ title, value, zone }: { title: string; value: DayXPerformer['arrival']; zone: string | null }) {
  return <p>{title} · {value
    ? `${programTime(value.at, zone, getI18nLang()) ?? value.at} · ${value.by ?? t('Автор недоступен')}`
    : t('Не отмечено')}</p>
}
