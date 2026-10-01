import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Pencil, RefreshCw, Save, Users } from 'lucide-react'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { ApiError } from '@/lib/api/client'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { listMyWeddings } from '@/lib/api/wedding'
import { getEventInvitations, replaceEventInvitations, type EventInvitationRoster } from '@/lib/api/weddingEvents'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { useStore } from '@/lib/store'
import { t } from '@/lib/i18n'

const iconButton = 'press inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--card)] disabled:opacity-50'
type Opened = { roster: EventInvitationRoster; version: string; serial: number }
export default function EventInvitations() {
  const { weddingId } = useStore(), { eventId } = useParams()
  return <Roster key={`${weddingId}/${eventId}`} weddingId={weddingId} eventId={eventId ?? null} />
}
function Roster({ weddingId, eventId }: { weddingId: string | null; eventId: string | null }) {
  const q = useApi(() => weddingId && eventId ? getEventInvitations(weddingId, eventId) : noWedding(), [weddingId, eventId])
  const mine = useApi(() => weddingId ? listMyWeddings() : Promise.resolve([]), [weddingId])
  const reload = q.reload, reloadMine = mine.reload
  const refresh = useCallback(() => { reload(); reloadMine() }, [reload, reloadMine])
  const online = useProgramOnline(refresh)
  const [opened, setOpened] = useState<Opened | null>(null), [receipt, setReceipt] = useState(false)
  const serial = useRef(0)
  const couple = ready(mine) && mine.data?.find(w => w.id === weddingId)?.role === 'couple'
  const readable = !!couple && ready(q) && q.data?.data.event?.id === eventId && Array.isArray(q.data?.data.people)
  const editable = readable && online && !q.refreshing && !mine.refreshing && !!q.data?.etag && !q.data?.data.event.isMain
  const openFresh = () => {
    if (!editable || !q.data?.etag) return
    setReceipt(false); setOpened({ roster: q.data.data, version: q.data.etag, serial: ++serial.current })
  }
  return <div className="pb-28 [&_h1]:text-[22px]">
    <TopBar back title={t('Приглашённые')} right={<button type="button" title={t('Обновить приглашённых')} aria-label={t('Обновить приглашённых')} disabled={!online || q.loading || q.refreshing || mine.refreshing} onClick={refresh} className={iconButton}><RefreshCw size={18} /></button>} />
    <div className="px-5 space-y-3">
      <Link to="/wedding/events" className="inline-flex items-center gap-2 text-[13px] font-semibold"><Users size={17} />{t('Мероприятия')}</Link>
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && <AsyncState q={mine} forbiddenText={mine.forbiddenText} />}
      {ready(q) && ready(mine) && !couple && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Состав приглашённых ведёт пара')}</p>}
      {couple && ready(q) && !readable && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Состав приглашённых не подтверждён сервером')}</p>}
      {readable && <>
        <header className="flex gap-2 items-start border-b border-[var(--line)] py-3">
          <h2 className="text-[16px] leading-6 font-semibold min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{q.data!.data.event.name}</h2>
          {!opened && !q.data!.data.event.isMain && <button type="button" title={t('Изменить состав')} aria-label={t('Изменить состав')} disabled={!editable} onClick={openFresh} className={iconButton}><Pencil size={17} /></button>}
        </header>
        {receipt && <p role="status" className="text-[13px]">{t('Состав приглашённых сохранён')}</p>}
        {!q.data?.etag && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Обновите мероприятия перед сохранением')}</p>}
        {q.data!.data.event.isMain && <Link to="/wedding/guests" className="text-[13px] inline-flex items-center gap-2"><Users size={16} />{t('Гости')}</Link>}
        {opened && weddingId && eventId ? <RosterForm key={opened.serial} weddingId={weddingId} eventId={eventId} opened={opened} enabled={editable}
          stale={q.data?.etag !== opened.version} onFresh={openFresh} onRefresh={refresh} onCancel={() => setOpened(null)}
          onAccepted={() => { setOpened(null); setReceipt(true); refresh() }} />
          : <ul className="divide-y divide-[var(--line)]">{q.data!.data.people.map(person => <li key={person.guestId} className="py-3 flex gap-3 items-start text-[13px] min-w-0">
            <input type="checkbox" checked={person.invited} disabled aria-label={person.name} className="h-4 w-4 shrink-0 mt-0.5 accent-[var(--rose-ink)]" />
            <span className="break-words [overflow-wrap:anywhere] min-w-0">{person.name}</span>
          </li>)}</ul>}
        {q.data!.data.people.length === 0 && <p className="text-[13px] text-[var(--soft)]">{t('Гостей пока нет')}</p>}
      </>}
    </div>
  </div>
}
function RosterForm({ weddingId, eventId, opened, enabled, stale, onFresh, onRefresh, onCancel, onAccepted }: {
  weddingId: string; eventId: string; opened: Opened; enabled: boolean; stale: boolean
  onFresh: () => void; onRefresh: () => void; onCancel: () => void; onAccepted: () => void
}) {
  const [selected, setSelected] = useState(() => opened.roster.people.filter(p => p.invited).map(p => p.guestId))
  const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [error, setError] = useState<string | null>(null)
  const submitting = useRef(false), alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const original = opened.roster.people.filter(p => p.invited).map(p => p.guestId)
  const changed = selected.length !== original.length || selected.some(id => !original.includes(id))
  const submit = async () => {
    if (!enabled || stale || blocked || submitting.current || !changed) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      const accepted = await replaceEventInvitations(weddingId, eventId, selected, opened.version)
      const ids = accepted?.people?.filter(p => p.invited).map(p => p.guestId)
      if (accepted?.event?.id !== eventId || !Array.isArray(ids) || ids.length !== selected.length || ids.some(id => !selected.includes(id))) {
        throw new ApiError('http', 200, 'invalid_response', t('Состав приглашённых не подтверждён сервером'))
      }
      if (alive.current) onAccepted()
    } catch (e) {
      if (!alive.current) return
      setError(explainError(e))
      if (!(e instanceof ApiError && e.status === 422)) { setBlocked(true); onRefresh() }
    } finally { if (alive.current) { submitting.current = false; setBusy(false) } }
  }
  return <form onSubmit={e => { e.preventDefault(); void submit() }} className="space-y-3">
    <fieldset disabled={!enabled || busy || blocked || stale} className="min-w-0 divide-y divide-[var(--line)]">
      {opened.roster.people.map(person => <label key={person.guestId} className="py-3 flex gap-3 items-start text-[13px] min-w-0">
        <input type="checkbox" aria-label={person.name} checked={selected.includes(person.guestId)} className="h-4 w-4 shrink-0 mt-0.5 accent-[var(--rose-ink)]"
          onChange={e => { setSelected(old => e.target.checked ? [...old, person.guestId] : old.filter(id => id !== person.guestId)); setError(null) }} />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">{person.name}</span>
      </label>)}
    </fieldset>
    {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)] break-words">{error}</p>}
    {(blocked || stale) && <div className="space-y-2"><p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Перед повторным изменением откройте свежую версию')}</p><button type="button" disabled={!enabled || busy} onClick={onFresh} className="inline-flex gap-2 items-center text-[12px] font-semibold disabled:opacity-50"><RefreshCw size={16} />{t('Открыть свежую версию')}</button></div>}
    <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] pt-3">
      <button type="button" disabled={busy} onClick={onCancel} className="h-10 px-3 text-[13px] rounded-lg disabled:opacity-50">{t('Отмена')}</button>
      <button type="submit" disabled={!enabled || !changed || busy || blocked || stale} className="inline-flex h-10 items-center gap-2 px-3 rounded-lg bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[13px] font-semibold disabled:opacity-50"><Save size={16} />{busy ? t('Сохраняем…') : t('Сохранить')}</button>
    </div>
  </form>
}
