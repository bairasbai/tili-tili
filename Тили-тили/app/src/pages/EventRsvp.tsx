import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { CalendarDays, MapPin, Pencil, RefreshCw, Save, Users } from 'lucide-react'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError } from '@/lib/api/client'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { listMyWeddings } from '@/lib/api/wedding'
import { getWeddingEventsSnapshot } from '@/lib/api/weddingData'
import { patchWeddingEvent } from '@/lib/api/weddingEvents'
import {
  correctEventRsvp, decideEventRsvpRequest, getEventRsvpRoster,
  type EventRsvpCouplePerson, type EventRsvpDeadline, type EventRsvpRequest,
} from '@/lib/api/eventRsvp'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { useStore } from '@/lib/store'
import { formatWeddingDate } from '@/lib/weddingDate'
import { cn } from '@/lib/utils'
import { t } from '@/lib/i18n'

/*
 * Экран ответов мероприятия (T012).
 *
 * Срок ответа, список приглашённых с их ответом и источником («кто ответил»),
 * правка ответа и решения по просьбам гостей — всё для ОДНОГО дополнительного
 * мероприятия. Читает любая роль команды свадьбы (как доступ к гостям), пишет
 * только пара — как у `EventInvitations.tsx`, но без общего списка приглашённых.
 */

const iconButton = 'press inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--card)] disabled:opacity-50'
const dateField = 'block mt-1 h-10 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[13px]'

type OpenedDeadline = { date: string; version: string; serial: number }
type OpenedPerson = { guestId: string; status: 'unknown' | 'attending' | 'declined'; version: string; serial: number }

function deadlineText(deadline: EventRsvpDeadline): string {
  if (deadline.state === 'closed') return t('Срок ответа прошёл')
  if (deadline.state === 'none' || !deadline.date || !deadline.timeZone) return t('Срок ответа не задан')
  return `${t('Ответить до')} ${formatWeddingDate(deadline.date)} ${t('включительно')} (${deadline.timeZone})`
}

export default function EventRsvp() {
  const { weddingId } = useStore(), { eventId } = useParams()
  return <EventRsvpScreen key={`${weddingId}/${eventId}`} weddingId={weddingId} eventId={eventId ?? null} />
}

function EventRsvpScreen({ weddingId, eventId }: { weddingId: string | null; eventId: string | null }) {
  const events = useApi(() => weddingId ? getWeddingEventsSnapshot(weddingId) : noWedding(), [weddingId])
  const roster = useApi(() => weddingId && eventId ? getEventRsvpRoster(weddingId, eventId) : noWedding(), [weddingId, eventId])
  const mine = useApi(() => weddingId ? listMyWeddings() : Promise.resolve([]), [weddingId])
  const reloadEvents = events.reload, reloadRoster = roster.reload, reloadMine = mine.reload
  const refresh = useCallback(() => { reloadEvents(); reloadRoster(); reloadMine() }, [reloadEvents, reloadRoster, reloadMine])
  const online = useProgramOnline(refresh)
  const busyBackground = events.refreshing || roster.refreshing || mine.refreshing

  const isMember = ready(mine) && !!mine.data?.some(w => w.id === weddingId)
  const couple = ready(mine) && mine.data?.find(w => w.id === weddingId)?.role === 'couple'
  const event = ready(events) ? events.data?.data.find(e => e.id === eventId) : undefined
  const rosterData = ready(roster) ? roster.data : undefined
  const readable = isMember && ready(events) && ready(roster) && !!event && !!rosterData
  const editableCouple = readable && couple && online && !busyBackground && !!events.data?.etag

  const canEditDeadline = editableCouple && !!event && !event.isMain && !!event.timeZone
  const canCorrect = editableCouple && !!event && !event.isMain

  const [openedDeadline, setOpenedDeadline] = useState<OpenedDeadline | null>(null)
  const [openedPerson, setOpenedPerson] = useState<OpenedPerson | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const serial = useRef(0)

  return (
    <div className="pb-28">
      <TopBar back title={event?.name ?? t('Ответы на мероприятие')} right={
        <button type="button" title={t('Обновить мероприятия')} aria-label={t('Обновить мероприятия')}
          disabled={!!openedDeadline || !!openedPerson || events.loading || busyBackground || !online}
          onClick={refresh} className={iconButton}><RefreshCw size={18} /></button>
      } />
      <div className="px-5 space-y-4">
        <Link to="/wedding/events" className="inline-flex items-center gap-2 text-[13px] font-semibold"><CalendarDays size={17} />{t('Мероприятия')}</Link>
        <AsyncState q={events} forbiddenText={events.forbiddenText} />
        {ready(events) && <AsyncState q={roster} forbiddenText={roster.forbiddenText} />}
        {ready(events) && ready(roster) && <AsyncState q={mine} forbiddenText={mine.forbiddenText} />}
        {ready(events) && ready(roster) && ready(mine) && !event && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Мероприятие не найдено')}</p>}
        {ready(roster) && !!event && !rosterData && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Снимок ответов не подтверждён сервером')}</p>}

        {readable && event && rosterData && weddingId && eventId && <>
          <header className="border-b border-[var(--line)] pb-3 space-y-1">
            <h2 className="text-[16px] font-semibold break-words [overflow-wrap:anywhere]">{event.name}</h2>
            <p className="text-[12px] text-[var(--soft)]">{event.date ? formatWeddingDate(event.date) : t('Дата не задана')}</p>
            <p className="text-[12px] text-[var(--soft)]">{event.timeZone ?? t('Часовой пояс не задан')}</p>
            <p className="text-[12px] text-[var(--soft)] flex items-center gap-1"><MapPin size={13} />{event.location ?? t('Место не задано')}</p>
          </header>

          {isMember && !couple && <p className="text-[12px] text-[var(--soft)]">{t('Правки доступны только паре')}</p>}
          {receipt && <p role="status" className="text-[13px]">{receipt}</p>}

          {/* Срок ответа */}
          <section className="space-y-2 border-b border-[var(--line)] pb-4">
            <h3 className="text-[13px] font-semibold">{t('Срок ответа')}</h3>
            {event.isMain ? (
              <p className="text-[12px] text-[var(--soft)] leading-relaxed">{t('У основного мероприятия нет срока ответа — за него отвечает основная анкета гостя')}</p>
            ) : !event.timeZone ? (
              <div className="space-y-1">
                <p className="text-[12px] text-[var(--soft)] leading-relaxed">{t('Чтобы задать срок ответа, сначала укажите часовой пояс мероприятия')}</p>
                <Link to="/wedding/events" className="text-[12px] font-semibold inline-flex items-center gap-1">{t('Изменить мероприятие')}</Link>
              </div>
            ) : openedDeadline ? (
              <DeadlineEditor key={openedDeadline.serial} weddingId={weddingId} eventId={eventId} opened={openedDeadline}
                enabled={canEditDeadline} stale={events.data?.etag !== openedDeadline.version} refreshing={busyBackground} eventDate={event.date}
                onReopen={() => {
                  if (!events.data?.etag) return
                  setOpenedDeadline({ date: rosterData.deadline.date ?? '', version: events.data.etag, serial: ++serial.current })
                }}
                onRefresh={refresh} onCancel={() => setOpenedDeadline(null)}
                onAccepted={() => { setOpenedDeadline(null); setReceipt(t('Мероприятие сохранено')); refresh() }} />
            ) : (
              <div className="flex items-center gap-2">
                <p className="text-[13px] flex-1">{deadlineText(rosterData.deadline)}</p>
                {canEditDeadline && !openedPerson && (
                  <button type="button" title={t('Изменить срок ответа')} aria-label={t('Изменить срок ответа')} onClick={() => {
                    if (!events.data?.etag) return
                    setReceipt(null)
                    setOpenedDeadline({ date: rosterData.deadline.date ?? '', version: events.data.etag, serial: ++serial.current })
                  }} className={iconButton}><Pencil size={17} /></button>
                )}
              </div>
            )}
          </section>

          {/* Приглашённые и ответы */}
          <section className="space-y-1">
            <h3 className="text-[13px] font-semibold flex items-center gap-2"><Users size={15} />{t('Приглашённые')}</h3>
            {rosterData.people.length === 0 && <p className="text-[13px] text-[var(--soft)]">{t('Гостей пока нет')}</p>}
            <ul className="divide-y divide-[var(--line)]">
              {rosterData.people.map(person => (
                openedPerson?.guestId === person.guestId ? (
                  <PersonCorrectionForm key={`${person.guestId}-${openedPerson.serial}`} weddingId={weddingId} eventId={eventId} opened={openedPerson}
                    enabled={canCorrect} refreshing={busyBackground}
                    stale={rosterData.people.find(p => p.guestId === openedPerson.guestId)?.version !== openedPerson.version}
                    onReopen={() => {
                      const fresh = rosterData.people.find(p => p.guestId === openedPerson.guestId)
                      if (fresh) setOpenedPerson({ guestId: fresh.guestId, status: fresh.status, version: fresh.version, serial: ++serial.current })
                    }}
                    onRefresh={refresh} onCancel={() => setOpenedPerson(null)}
                    onAccepted={() => { setOpenedPerson(null); refresh() }} />
                ) : (
                  <PersonRow key={person.guestId} person={person} canCorrect={canCorrect && !openedPerson && !openedDeadline}
                    onEdit={() => { setReceipt(null); setOpenedPerson({ guestId: person.guestId, status: person.status, version: person.version, serial: ++serial.current }) }} />
                )
              ))}
            </ul>
          </section>

          {/* Просьбы гостей */}
          <section className="space-y-1">
            <h3 className="text-[13px] font-semibold">{t('Просьбы гостей изменить ответ')}</h3>
            {rosterData.requests.length === 0 && <p className="text-[13px] text-[var(--soft)]">{t('Просьб пока нет')}</p>}
            <ul className="divide-y divide-[var(--line)]">
              {rosterData.requests.map(request => (
                <RequestRow key={request.id} request={request} person={rosterData.people.find(p => p.guestId === request.guestId)}
                  canDecide={canCorrect} weddingId={weddingId} eventId={eventId} onRefresh={refresh} onDecided={refresh} />
              ))}
            </ul>
          </section>
        </>}
      </div>
    </div>
  )
}

function PersonRow({ person, canCorrect, onEdit }: { person: EventRsvpCouplePerson; canCorrect: boolean; onEdit: () => void }) {
  const statusLabel = person.status === 'attending' ? t('Придёт') : person.status === 'declined' ? t('Не придёт') : t('Ждём')
  const statusClass = person.status === 'attending' ? 'bg-[var(--sage-soft)] text-[var(--sage-ink)]'
    : person.status === 'declined' ? 'bg-[var(--rose-soft)] text-[var(--rose-ink)]' : 'bg-[var(--honey)] text-[var(--honey-ink)]'
  const sourceLabel = person.source === 'guest_response' ? t('Ответил гость')
    : person.source === 'organizer_correction' ? t('Внесено организатором')
    : person.source === 'legacy_main_rsvp' ? t('По основному ответу')
    : person.source === 'team_observation' ? t('Наблюдение команды')
    : t('Нет ответа')
  return (
    <li className="py-3 flex items-start gap-3 text-[13px] min-w-0">
      <div className="flex-1 min-w-0 space-y-0.5">
        <p className="break-words [overflow-wrap:anywhere] font-medium">{person.name}{person.partyLabel ? ` · ${person.partyLabel}` : ''}</p>
        <p className="text-[11.5px] text-[var(--soft)]">{sourceLabel}</p>
      </div>
      <span className={cn('shrink-0 px-2.5 py-1 rounded-full text-[11px] font-semibold', statusClass)}>{statusLabel}</span>
      {canCorrect && (
        <button type="button" title={t('Исправить ответ')} aria-label={`${t('Исправить ответ')}: ${person.name}`} onClick={onEdit}
          className="press shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--card)]"><Pencil size={15} /></button>
      )}
    </li>
  )
}

function PersonCorrectionForm({ weddingId, eventId, opened, enabled, stale, refreshing, onReopen, onRefresh, onCancel, onAccepted }: {
  weddingId: string; eventId: string; opened: OpenedPerson; enabled: boolean; stale: boolean; refreshing: boolean
  onReopen: () => void; onRefresh: () => void; onCancel: () => void; onAccepted: () => void
}) {
  const [status, setStatus] = useState(opened.status)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const changed = status !== opened.status
  const submit = async () => {
    if (!enabled || stale || blocked || submitting.current || !changed) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      await correctEventRsvp(weddingId, eventId, opened.guestId, status, opened.version)
      if (alive.current) onAccepted()
    } catch (e) {
      if (!alive.current) return
      setError(e instanceof ApiError && e.code === 'version_conflict' ? t('Ответ уже изменили — обновите') : explainError(e))
      if (!(e instanceof ApiError && e.status === 422)) { setBlocked(true); onRefresh() }
    } finally { if (alive.current) { submitting.current = false; setBusy(false) } }
  }
  const options: Array<['attending' | 'declined' | 'unknown', string]> = [['attending', t('Придёт')], ['declined', t('Не придёт')], ['unknown', t('Ждём')]]
  return (
    <li className="py-3 space-y-2 text-[13px]">
      <fieldset disabled={!enabled || busy || blocked || stale} className="flex flex-wrap gap-2">
        {options.map(([value, label]) => (
          <button key={value} type="button" aria-pressed={status === value} onClick={() => { setStatus(value); setError(null) }}
            className="press h-9 px-3 rounded-full text-[12px] font-semibold disabled:opacity-50"
            style={status === value ? { background: 'var(--rose-soft)', color: 'var(--rose-ink)' } : { background: 'var(--card)' }}>{label}</button>
        ))}
      </fieldset>
      {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)] break-words">{error}</p>}
      {(blocked || stale) && (
        <button type="button" disabled={busy || refreshing} onClick={onReopen} className="press inline-flex items-center gap-2 text-[12px] font-semibold disabled:opacity-50">
          <RefreshCw size={16} />{t('Открыть свежую версию')}
        </button>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="press h-9 px-3 rounded-lg text-[12px] disabled:opacity-50">{t('Отмена')}</button>
        <button type="button" disabled={!enabled || !changed || busy || blocked || stale} onClick={() => void submit()}
          className="press h-9 px-3 rounded-lg bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          <Save size={14} />{busy ? t('Сохраняем…') : t('Сохранить')}
        </button>
      </div>
    </li>
  )
}

function DeadlineEditor({ weddingId, eventId, opened, enabled, stale, refreshing, eventDate, onReopen, onRefresh, onCancel, onAccepted }: {
  weddingId: string; eventId: string; opened: OpenedDeadline; enabled: boolean; stale: boolean; refreshing: boolean; eventDate: string | null
  onReopen: () => void; onRefresh: () => void; onCancel: () => void; onAccepted: () => void
}) {
  const [date, setDate] = useState(opened.date)
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submitting = useRef(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const changed = date !== opened.date
  const submit = async () => {
    if (!enabled || stale || blocked || submitting.current || !changed) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      await patchWeddingEvent(weddingId, eventId, { rsvpDeadline: date || null }, opened.version)
      if (alive.current) onAccepted()
    } catch (e) {
      if (!alive.current) return
      setError(explainError(e))
      if (!(e instanceof ApiError && e.status === 422)) { setBlocked(true); onRefresh() }
    } finally { if (alive.current) { submitting.current = false; setBusy(false) } }
  }
  return (
    <div className="space-y-2">
      <fieldset disabled={!enabled || busy || blocked || stale} className="min-w-0">
        <label className="text-[12px] block">{t('Срок ответа')}
          <input type="date" min="2000-01-01" max={eventDate ?? '2100-12-31'} value={date}
            onChange={e => { setDate(e.target.value); setError(null) }} className={dateField} />
        </label>
      </fieldset>
      {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)] break-words">{error}</p>}
      {(blocked || stale) && (
        <button type="button" disabled={busy || refreshing} onClick={onReopen} className="press inline-flex items-center gap-2 text-[12px] font-semibold disabled:opacity-50">
          <RefreshCw size={16} />{t('Открыть свежую версию')}
        </button>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="press h-9 px-3 rounded-lg text-[12px] disabled:opacity-50">{t('Отмена')}</button>
        <button type="button" disabled={!enabled || !changed || busy || blocked || stale} onClick={() => void submit()}
          className="press h-9 px-3 rounded-lg bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
          <Save size={14} />{busy ? t('Сохраняем…') : t('Сохранить')}
        </button>
      </div>
    </div>
  )
}

function RequestRow({ request, person, canDecide, weddingId, eventId, onRefresh, onDecided }: {
  request: EventRsvpRequest; person: EventRsvpCouplePerson | undefined; canDecide: boolean
  weddingId: string; eventId: string; onRefresh: () => void; onDecided: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<EventRsvpRequest | null>(null)
  const submitting = useRef(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const effective = local ?? request

  const decide = (decision: 'accept' | 'reject') => void (async () => {
    if (submitting.current || blocked) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      const result = await decideEventRsvpRequest(weddingId, eventId, request.id, decision, effective.version, note.trim() || undefined)
      if (alive.current) { setLocal(result.request); onDecided() }
    } catch (e) {
      if (!alive.current) return
      setError(e instanceof ApiError && e.code === 'version_conflict' ? t('Ответ уже изменили — обновите') : explainError(e))
      if (!(e instanceof ApiError && e.status === 422)) { setBlocked(true); onRefresh() }
    } finally { if (alive.current) { submitting.current = false; setBusy(false) } }
  })()

  const statusLabel = effective.requestedStatus === 'attending' ? t('Придёт') : t('Не придёт')
  return (
    <li className="py-3 space-y-2 text-[13px]">
      <p className="font-medium break-words [overflow-wrap:anywhere]">{person?.name ?? effective.guestId} → {statusLabel}</p>
      {effective.comment && <p className="text-[12px] text-[var(--soft)] break-words">{t('Комментарий')}: {effective.comment}</p>}
      {effective.state !== 'pending' ? (
        <p className="text-[12px]">{(effective.state === 'accepted' ? t('Просьба принята') : t('Просьба отклонена')) + (effective.decisionNote ? ` — ${effective.decisionNote}` : '')}</p>
      ) : canDecide ? (
        <div className="space-y-2">
          <textarea value={note} disabled={busy || blocked} maxLength={500} rows={2} onChange={e => setNote(e.target.value)}
            placeholder={t('Пояснение (необязательно)')} aria-label={t('Пояснение (необязательно)')}
            className="w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] p-2 text-[12px]" />
          {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)] break-words">{error}</p>}
          <div className="flex gap-2">
            <button type="button" disabled={busy || blocked} onClick={() => decide('reject')} className="press h-9 px-3 rounded-lg text-[12px] font-semibold disabled:opacity-50">{t('Отклонить')}</button>
            <button type="button" disabled={busy || blocked} onClick={() => decide('accept')} className="press h-9 px-3 rounded-lg bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[12px] font-semibold disabled:opacity-50">
              {busy ? t('Сохраняем…') : t('Принять')}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-[12px] text-[var(--soft)]">{t('Просьба ждёт решения')}</p>
      )}
    </li>
  )
}
