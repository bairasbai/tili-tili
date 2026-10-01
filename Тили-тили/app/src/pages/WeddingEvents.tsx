import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { CalendarDays, MapPin, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import { TopBar } from '@/components/chrome'
import { AsyncState, ready } from '@/components/AsyncState'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ApiError } from '@/lib/api/client'
import { explainError, noWedding, useApi } from '@/lib/api/useApi'
import { listMyWeddings } from '@/lib/api/wedding'
import { getWeddingEventsSnapshot } from '@/lib/api/weddingData'
import { createWeddingEvent, deleteWeddingEvent, patchWeddingEvent, type CreateWeddingEvent, type PatchWeddingEvent, type WeddingEvent } from '@/lib/api/weddingEvents'
import { key, t } from '@/lib/i18n'
import { useProgramOnline } from '@/lib/offlineProgramHooks'
import { useStore } from '@/lib/store'
import { formatWeddingDate } from '@/lib/weddingDate'

const kinds: Record<WeddingEvent['kind'], string> = {
  registration: key('Регистрация брака'), nikah: key('Никах'), ceremony: key('Церемония'),
  banquet: key('Банкет'), second_day: key('Второй день'), other: key('Другое'),
}
const iconButton = 'press inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--card)] disabled:opacity-50'
const fieldClass = 'block mt-1 h-10 w-full min-w-0 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-2 text-[13px]'
type Opened = { event: WeddingEvent | null; version: string; mode: 'edit' | 'delete'; serial: number }
type Fields = { name: string; kind: WeddingEvent['kind']; date: string; timeZone: string; location: string }

export default function WeddingEvents() {
  const { weddingId } = useStore()
  return <EventList key={weddingId ?? 'none'} weddingId={weddingId} />
}

function EventList({ weddingId }: { weddingId: string | null }) {
  const q = useApi(() => weddingId ? getWeddingEventsSnapshot(weddingId) : noWedding(), [weddingId])
  const mine = useApi(() => weddingId ? listMyWeddings() : Promise.resolve([]), [weddingId])
  const reloadEvents = q.reload, reloadMembership = mine.reload
  const refresh = useCallback(() => { reloadEvents(); reloadMembership() }, [reloadEvents, reloadMembership])
  const online = useProgramOnline(refresh)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const serial = useRef(0)
  const readable = ready(q) && !!q.data && ready(mine) && !!mine.data?.some(w => w.id === weddingId)
  const couple = readable && mine.data?.find(w => w.id === weddingId)?.role === 'couple'
  const editable = !!couple && online && !q.refreshing && !mine.refreshing && !!q.data?.etag
  const open = (event: WeddingEvent | null, mode: Opened['mode'] = 'edit') => {
    if (!editable || opened || !q.data?.etag || (mode === 'delete' && event?.isMain)) return
    setReceipt(null)
    setOpened({ event, mode, version: q.data.etag, serial: ++serial.current })
  }
  const reopen = () => {
    if (!editable || !opened || !q.data?.etag) return
    const fresh = opened.event ? q.data.data.find(e => e.id === opened.event?.id) : null
    if (opened.event && !fresh) return
    setOpened({ ...opened, event: fresh ?? null, version: q.data.etag, serial: ++serial.current })
  }
  return <div className="pb-28">
    <TopBar back title={t('Мероприятия')} right={<button type="button" title={t('Обновить мероприятия')} aria-label={t('Обновить мероприятия')} disabled={!!opened || q.loading || q.refreshing || mine.refreshing || !online} onClick={refresh} className={iconButton}><RefreshCw size={18} /></button>} />
    <div className="px-5 space-y-3">
      <AsyncState q={q} forbiddenText={q.forbiddenText} />
      {ready(q) && <AsyncState q={mine} forbiddenText={mine.forbiddenText} />}
      {ready(q) && ready(mine) && !mine.data?.some(w => w.id === weddingId) && weddingId && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Свадьба больше недоступна')}</p>}
      {readable && <>
        <div className="flex items-center justify-between gap-3 border-b border-[var(--line)] py-2">
          <Link to="/wedding/timeline" className="inline-flex items-center gap-2 text-[13px] font-semibold"><CalendarDays size={17} />{t('Тайминг')}</Link>
          {couple && <button type="button" title={t('Добавить мероприятие')} aria-label={t('Добавить мероприятие')} disabled={!editable || !!opened} onClick={() => open(null)} className={`${iconButton} text-[var(--rose-ink)]`}><Plus size={20} /></button>}
        </div>
        {couple && !q.data?.etag && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Обновите мероприятия перед сохранением')}</p>}
        {receipt && <p role="status" className="text-[13px] break-words">{receipt}</p>}
        {q.data!.data.length === 0 && <p className="text-[13px] text-[var(--soft)]">{t('Мероприятий пока нет')}</p>}
        <ul className="divide-y divide-[var(--line)]">
          {q.data!.data.map(event => <li key={event.id} data-testid={`wedding-event-${event.id}`} className="py-4">
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0 space-y-1">
                <h2 className="text-[16px] font-semibold break-words [overflow-wrap:anywhere]">{event.name}</h2>
                <p className="text-[12px] text-[var(--soft)] break-words">{t(kinds[event.kind])}{event.isMain ? ` · ${t('Основное мероприятие')}` : ''}</p>
              </div>
              {couple && <div className="flex shrink-0 gap-1">
                <button type="button" title={t('Изменить мероприятие')} aria-label={`${t('Изменить мероприятие')}: ${event.name}`} disabled={!editable || !!opened} onClick={() => open(event)} className={iconButton}><Pencil size={16} /></button>
                {!event.isMain && <button type="button" title={t('Удалить мероприятие')} aria-label={`${t('Удалить мероприятие')}: ${event.name}`} disabled={!editable || !!opened} onClick={() => open(event, 'delete')} className={`${iconButton} text-[var(--rose-ink)]`}><Trash2 size={16} /></button>}
              </div>}
            </div>
            <dl className="mt-3 grid gap-1 text-[12px] break-words [overflow-wrap:anywhere]">
              <div><dt className="inline text-[var(--soft)]">{t('Дата')}: </dt><dd className="inline">{event.date ? formatWeddingDate(event.date) : t('Дата не задана')}</dd></div>
              <div><dt className="inline text-[var(--soft)]">{t('Часовой пояс')}: </dt><dd className="inline">{event.timeZone ?? t('Часовой пояс не задан')}</dd></div>
              <div className="flex gap-1"><MapPin size={14} className="shrink-0 mt-0.5" /><dt className="sr-only">{t('Место мероприятия')}</dt><dd>{event.location ?? t('Место не задано')}</dd></div>
            </dl>
          </li>)}
        </ul>
      </>}
    </div>
    {opened && readable && weddingId && <EventDialog key={opened.serial} weddingId={weddingId} opened={opened} enabled={editable} stale={q.data?.etag !== opened.version}
      canReopen={editable && (!opened.event || !!q.data?.data.some(e => e.id === opened.event?.id))}
      onReopen={reopen} onClose={() => setOpened(null)} onRefresh={refresh} onAccepted={() => {
        setReceipt(t(opened.mode === 'delete' ? 'Мероприятие удалено' : 'Мероприятие сохранено'))
        setOpened(null); refresh()
      }} />}
  </div>
}

function EventDialog({ weddingId, opened, enabled, stale, canReopen, onReopen, onClose, onRefresh, onAccepted }: {
  weddingId: string; opened: Opened; enabled: boolean; stale: boolean; canReopen: boolean
  onReopen: () => void; onClose: () => void; onRefresh: () => void; onAccepted: () => void
}) {
  const original = opened.event
  const [fields, setFields] = useState<Fields>(() => ({ name: original?.name ?? '', kind: original?.kind ?? 'other', date: original?.date ?? '', timeZone: original?.timeZone ?? '', location: original?.location ?? '' }))
  const [busy, setBusy] = useState(false)
  const [blocked, setBlocked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(false)
  const submitting = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const zones = [...new Set(['UTC', ...(fields.timeZone ? [fields.timeZone] : []), ...Intl.supportedValuesOf('timeZone')])].sort()
  const payload: CreateWeddingEvent = { name: fields.name.trim(), kind: fields.kind, date: fields.date || null, timeZone: fields.timeZone || null, location: fields.location.trim() || null }
  const patch: PatchWeddingEvent = original ? {
    ...(fields.name !== original.name ? { name: payload.name } : {}),
    ...(payload.kind !== original.kind ? { kind: payload.kind } : {}),
    ...(!original.isMain && payload.date !== original.date ? { date: payload.date } : {}),
    ...(payload.timeZone !== original.timeZone ? { timeZone: payload.timeZone } : {}),
    ...(fields.location !== (original.location ?? '') ? { location: payload.location } : {}),
  } : {}
  const valid = opened.mode === 'delete' ? !!original && !original.isMain : !!payload.name && (!original || Object.keys(patch).length > 0)
  const submit = async () => {
    if (!enabled || stale || blocked || submitting.current || !valid || !opened.version) return
    submitting.current = true; setBusy(true); setError(null)
    try {
      if (opened.mode === 'delete' && original) await deleteWeddingEvent(weddingId, original.id, opened.version)
      else {
        const accepted = original ? await patchWeddingEvent(weddingId, original.id, patch, opened.version) : await createWeddingEvent(weddingId, payload, opened.version)
        if (!accepted?.id) throw new ApiError('http', 200, 'invalid_response', t('Сервер не подтвердил сохранение мероприятия'))
      }
      if (alive.current) onAccepted()
    } catch (e) {
      if (!alive.current) return
      setError(explainError(e))
      if (!(e instanceof ApiError && e.status === 422)) { setBlocked(true); onRefresh() }
    } finally { if (alive.current) { submitting.current = false; setBusy(false) } }
  }
  const update = <K extends keyof Fields>(field: K, value: Fields[K]) => { setFields(old => ({ ...old, [field]: value })); setError(null) }
  const title = opened.mode === 'delete' ? t('Удалить мероприятие') : original ? t('Изменить мероприятие') : t('Добавить мероприятие')
  return <Dialog open onOpenChange={next => { if (!next && !submitting.current) onClose() }}>
    <DialogContent data-theme="dark" aria-describedby={undefined} showCloseButton={false} onEscapeKeyDown={e => { if (submitting.current) e.preventDefault() }} onInteractOutside={e => { if (submitting.current) e.preventDefault() }} className="bg-[var(--card)] text-[var(--ink)] max-h-[85dvh] overflow-y-auto p-4">
      <header className="flex items-start justify-between gap-2"><DialogTitle className="text-[16px] font-semibold leading-6 break-words">{title}</DialogTitle><button type="button" title={t('Закрыть')} aria-label={t('Закрыть')} disabled={busy} onClick={onClose} className={iconButton}><X size={18} /></button></header>
      <form onSubmit={e => { e.preventDefault(); void submit() }} className="space-y-3">
        {opened.mode === 'delete' ? <p className="text-[14px] break-words [overflow-wrap:anywhere]">{original?.name}</p> : <fieldset disabled={busy || !enabled || blocked || stale} className="min-w-0 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-[12px] sm:col-span-2">{t('Название мероприятия')}<input autoFocus required maxLength={200} value={fields.name} onChange={e => update('name', e.target.value)} className={fieldClass} /></label>
          <label className="text-[12px] min-w-0">{t('Тип мероприятия')}<select aria-label={t('Тип мероприятия')} value={fields.kind} onChange={e => update('kind', e.target.value as WeddingEvent['kind'])} className={fieldClass}>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}</select></label>
          {original?.isMain ? <div className="text-[12px] min-w-0"><p>{t('Дата')}: {original.date ? formatWeddingDate(original.date) : t('Дата не задана')}</p><Link to="/us" className="inline-flex items-center gap-1 mt-2 font-semibold text-[var(--rose-ink)]"><CalendarDays size={16} />{t('Дата свадьбы')}</Link></div>
            : <label className="text-[12px] min-w-0">{t('Дата')}<input type="date" min="2000-01-01" max="2100-12-31" value={fields.date} onChange={e => update('date', e.target.value)} className={fieldClass} /></label>}
          <label className="text-[12px] min-w-0 sm:col-span-2">{t('Часовой пояс')}<select aria-label={t('Часовой пояс')} value={fields.timeZone} onChange={e => update('timeZone', e.target.value)} className={fieldClass}><option value="">{t('Часовой пояс не задан')}</option>{zones.map(zone => <option key={zone} value={zone}>{zone}</option>)}</select></label>
          <label className="text-[12px] sm:col-span-2">{t('Место мероприятия')}<input maxLength={300} value={fields.location} onChange={e => update('location', e.target.value)} className={fieldClass} /></label>
        </fieldset>}
        {error && <p role="alert" className="text-[12px] text-[var(--rose-ink)] break-words">{error}</p>}
        {(blocked || stale) && <div className="space-y-2"><p role="alert" className="text-[12px] text-[var(--rose-ink)]">{t('Перед повторным изменением откройте свежую версию')}</p><button type="button" disabled={!canReopen || busy} onClick={onReopen} className="inline-flex items-center gap-2 text-[12px] font-semibold disabled:opacity-50"><RefreshCw size={16} />{t('Открыть свежую версию')}</button></div>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--line)] pt-3">
          <button type="button" disabled={busy} onClick={onClose} className="h-10 px-3 rounded-lg text-[13px] disabled:opacity-50">{t('Отмена')}</button>
          <button type="submit" disabled={!enabled || !valid || busy || blocked || stale} className="h-10 px-3 rounded-lg bg-[var(--rose-soft)] text-[var(--rose-ink)] text-[13px] font-semibold inline-flex items-center gap-2 disabled:opacity-50">{opened.mode === 'delete' ? <Trash2 size={16} /> : <Save size={16} />}{busy ? t('Сохраняем…') : opened.mode === 'delete' ? t('Удалить') : t('Сохранить')}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}
