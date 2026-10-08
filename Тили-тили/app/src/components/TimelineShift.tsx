import { useState } from 'react'
import { ArrowRight, ClockArrowUp, RefreshCw, X } from 'lucide-react'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { getWeddingEvents } from '@/lib/api/weddingData'
import { previewTimelineShift, shiftTimeline, type TimelineShiftPreview, type TimelineShiftScope } from '@/lib/api/weddingWrite'
import { explainError, useApi } from '@/lib/api/useApi'
import { getI18nLang, t } from '@/lib/i18n'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

interface Props {
  weddingId: string; date: string | null; timeZone: string | null
  blocks: readonly { id?: string; name?: string }[]; disabled: boolean; onAccepted: () => void
}
const reasons = { undated: 'Начало не задано', other_day: 'Другой день', other_event: 'Другое мероприятие', fixed: 'Фиксированное начало', past: 'Блок уже начался' } as const
const conflicts = { shifted_into_past: 'Сдвиг в прошлое', crosses_day: 'Переход на другой день', unknown_duration: 'Длительность неизвестна', invalid_interval: 'Недопустимый интервал', missing_dependency: 'Зависимость недоступна', unknown_dependency_time: 'Время зависимости неизвестно', dependency_timing: 'Не хватает времени после предыдущего блока', unknown_participant_time: 'Время участника неизвестно', participant_overlap: 'Участник занят одновременно', travel_buffer_overlap: 'Не хватает времени на переезд и запас' } as const
const referenceKinds = { member: 'Команда', guest: 'Гость', deal: 'Подрядчик' } as const
const participationStatuses = { attending: 'Участие подтверждено', declined: 'Участие отклонено', unknown: 'Участие неизвестно' } as const
const participationSources = { legacy_main_rsvp: 'Ответ на основное мероприятие', guest_response: 'Ответ гостя', team_observation: 'Наблюдение команды', organizer_correction: 'Исправление организатора' } as const
const invitationSources = { explicit: 'Персональное приглашение', main_legacy: 'Основной список гостей' } as const

function completeGuestConsequences(data: { guestConsequences?: TimelineShiftPreview['guestConsequences']; unknownGuestCount?: number; guestConsequencesIncomplete?: boolean; guestsAffected?: number }): boolean {
  if (!Array.isArray(data.guestConsequences) || !Number.isInteger(data.unknownGuestCount) || !Number.isInteger(data.guestsAffected)) return false
  const rows = data.guestConsequences
  if (rows.some(g => !g || typeof g.guestId !== 'string' || typeof g.eventId !== 'string' || typeof g.eventName !== 'string'
    || !Object.hasOwn(participationStatuses, g.status) || (g.source !== null && !Object.hasOwn(participationSources, g.source))
    || (g.invitation !== null && !Object.hasOwn(invitationSources, g.invitation)) || typeof g.assignment !== 'boolean'
    || typeof g.version !== 'string' || !/^[0-9]+$/.test(g.version) || (g.name !== null && typeof g.name !== 'string'))) return false
  return data.unknownGuestCount === new Set(rows.filter(g => g.status === 'unknown').map(g => g.guestId)).size
    && data.guestsAffected === new Set(rows.filter(g => g.status === 'attending').map(g => g.guestId)).size
    && data.guestConsequencesIncomplete === (data.unknownGuestCount > 0)
    && new Set(rows.map(g => `${g.eventId}:${g.guestId}`)).size === rows.length
}

function completeAttendingProjection(data: TimelineShiftPreview): boolean {
  if (!Array.isArray(data.affectedGuestIds) || !Array.isArray(data.affectedGuests)) return false
  const attending = new Map<string, string | null>()
  for (const person of data.guestConsequences) {
    if (person.status !== 'attending') continue
    if (attending.has(person.guestId) && attending.get(person.guestId) !== person.name) return false
    attending.set(person.guestId, person.name)
  }
  return data.affectedGuestIds.length === attending.size && new Set(data.affectedGuestIds).size === attending.size
    && data.affectedGuestIds.every(id => attending.has(id))
    && data.affectedGuests.length === attending.size && new Set(data.affectedGuests.map(g => g?.id)).size === attending.size
    && data.affectedGuests.every(g => g && attending.has(g.id) && attending.get(g.id) === g.name)
}

function displayMoment(iso: string | null, zone: string | null): string {
  if (!iso) return t('Время не задано')
  try {
    if (!zone) throw new RangeError('Unknown zone')
    const value = new Date(iso), locale = getI18nLang() === 'en' ? 'en-GB' : 'ru-RU'
    const date = value.toLocaleDateString(locale, { timeZone: zone })
    const time = new Intl.DateTimeFormat(locale, { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit',
      ...(value.getMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}) }).format(value)
    return `${date} · ${time}`
  } catch { return `${t('Часовой пояс неизвестен')} · ${iso}` }
}

export function TimelineShiftControl({ weddingId, date, timeZone, disabled, onAccepted }: Props) {
  const [open, setOpen] = useState(false)
  const [opened, setOpened] = useState(false)
  const [mode, setMode] = useState<'day' | 'event'>('day')
  const [day, setDay] = useState(date ?? '')
  const [eventId, setEventId] = useState('')
  const [minutes, setMinutes] = useState('15')
  const [busy, setBusy] = useState<'preview' | 'confirm' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [preview, setPreview] = useState<{ data: TimelineShiftPreview; version: string | null; key: string } | null>(null)
  const [receipt, setReceipt] = useState<string | null>(null)
  const events = useApi(async () => open ? await getWeddingEvents(weddingId) : [], [weddingId, open])
  const eventsError = events.error ?? events.forbiddenText
  const clear = () => { setPreview(null); setError(null); setBlocked(false); setReceipt(null) }
  const chosen = events.data?.find(e => e.id === eventId)
  const valid = Number.isInteger(Number(minutes)) && Number(minutes) !== 0 && Math.abs(Number(minutes)) <= 240
    && (mode === 'day' ? !!day && !!timeZone : !!chosen?.date && !!chosen.timeZone)
  const previewShift = async () => {
    if (!valid || busy) return
    setBusy('preview'); setError(null); setReceipt(null)
    try {
      const scope: TimelineShiftScope = mode === 'day' ? { kind: 'day', date: day } : { kind: 'event', eventId }
      const response = await previewTimelineShift(weddingId, scope, Number(minutes))
      setPreview({ data: response.data, version: response.etag, key: newIdempotencyKey() })
      setBlocked(false)
    } catch (e) { setError(explainError(e)); setBlocked(true) } finally { setBusy(null) }
  }
  const guestMetadataComplete = !!preview && completeGuestConsequences(preview.data)
  const detailsComplete = !!preview && guestMetadataComplete && Array.isArray(preview.data.blockDetails) && Array.isArray(preview.data.referenceDetails) && Array.isArray(preview.data.affectedGuests)
    && preview.data.blocks.every(b => preview.data.blockDetails.some(d => d.id === b.id))
    && preview.data.affectedReferences.every(r => preview.data.referenceDetails.some(d => d.kind === r.kind && d.id === r.id))
    && completeAttendingProjection(preview.data)
  const confirm = async () => {
    if (!detailsComplete || !preview?.data.canConfirm || !preview.version || !preview.data.previewToken || blocked || busy || disabled) return
    setBusy('confirm'); setError(null)
    try {
      const response = await shiftTimeline(weddingId, preview.data.previewToken, preview.version, preview.key)
      const { shiftedBlocks, guestsAffected, unknownGuestCount } = response.data
      const participation = completeGuestConsequences(response.data)
        ? `${t('Неизвестное участие:')} ${unknownGuestCount}` : t('Сведения об участии гостей в принятом ответе недоступны')
      setReceipt(typeof shiftedBlocks === 'number' && typeof guestsAffected === 'number'
        ? `${t('Сдвиг принят')} · ${t('Блоков:')} ${shiftedBlocks} · ${t('касается гостей:')} ${guestsAffected} · ${participation} · ${t('сообщите им сами, приложение гостям не пишет')}` : null)
      setBlocked(true)
      onAccepted()
    } catch (e) {
      setError(explainError(e))
      if (e instanceof ApiError && e.kind === 'http' && e.status < 500) setBlocked(true)
    } finally { setBusy(null) }
  }
  const detail = (id: string) => preview?.data.blockDetails?.find(b => b.id === id)
  const name = (id: string) => detail(id)?.name ?? `${t('Название блока неизвестно')} · ${id}`
  const interval = (moment: { startsAt: string | null; endsAt: string | null }, id: string) =>
    `${displayMoment(moment.startsAt, detail(id)?.timeZone ?? null)} — ${moment.endsAt ? displayMoment(moment.endsAt, detail(id)?.timeZone ?? null) : t('Окончание неизвестно')}`
  return <Dialog open={open} onOpenChange={next => {
    if (busy) return
    if (next && !opened) { setDay(date ?? ''); setOpened(true) }
    setOpen(next)
  }}>
    <DialogTrigger asChild><button type="button" disabled={disabled} className="press flex-1 h-[44px] rounded-lg text-[12px] font-bold disabled:opacity-50 bg-[var(--dark-gold)] text-[var(--on-grad)] flex items-center justify-center gap-2"><ClockArrowUp size={16} />{t('Сдвиг тайминга')}</button></DialogTrigger>
      <DialogContent data-theme="dark" aria-describedby={undefined} showCloseButton={false} onEscapeKeyDown={e => { if (busy) e.preventDefault() }} onInteractOutside={e => { if (busy) e.preventDefault() }} className="bg-[var(--card)] text-[var(--ink)] max-h-[85dvh] overflow-y-auto sm:max-w-xl p-4">
        <header className="flex items-center justify-between gap-3"><DialogTitle className="font-semibold text-[16px]">{t('Сдвиг тайминга')}</DialogTitle><button type="button" disabled={!!busy} title={t('Закрыть')} aria-label={t('Закрыть')} onClick={() => setOpen(false)} className="h-9 w-9 shrink-0 inline-flex items-center justify-center disabled:opacity-50"><X size={18} /></button></header>
        <form onSubmit={e => { e.preventDefault(); void previewShift() }} className="grid grid-cols-2 gap-3">
          <label className="text-[12px] col-span-2">{t('Область сдвига')}<select aria-label={t('Область сдвига')} value={mode} disabled={!!busy} onChange={e => { clear(); setMode(e.target.value as 'day' | 'event') }} className="block mt-1 w-full h-10 bg-[var(--bg)] px-2"><option value="day">{t('День')}</option><option value="event">{t('Мероприятие')}</option></select></label>
          {mode === 'day' ? <label className="min-w-0 text-[12px]">{t('Дата')}<input type="date" value={day} disabled={!!busy} onChange={e => { clear(); setDay(e.target.value) }} className="block mt-1 w-full min-w-0 h-10 bg-[var(--bg)] px-2" /></label>
            : <label className="min-w-0 text-[12px]">{t('Мероприятие')}<select aria-label={t('Мероприятие')} value={eventId} disabled={!!busy || events.loading || !!eventsError || events.forbidden} onChange={e => { clear(); setEventId(e.target.value) }} className="block mt-1 w-full min-w-0 h-10 bg-[var(--bg)] px-2"><option value="">{t('Выберите мероприятие')}</option>{events.data?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>}
          <label className="min-w-0 text-[12px]">{t('Сдвиг, мин')}<input type="number" step={1} min={-240} max={240} value={minutes} disabled={!!busy} onChange={e => { clear(); setMinutes(e.target.value) }} className="block mt-1 w-full min-w-0 h-10 bg-[var(--bg)] px-2" /></label>
          <p className="text-[11px] col-span-2 break-words">{mode === 'day' ? timeZone ?? t('Часовой пояс не задан') : chosen ? `${chosen.date ?? t('Дата не задана')} · ${chosen.timeZone ?? t('Часовой пояс не задан')}` : ''}</p>
          {eventsError && <div role="alert" className="text-[12px] col-span-2 break-words">{eventsError}{!events.forbidden && <button type="button" title={t('Повторить')} aria-label={t('Повторить')} onClick={() => events.reload()} className="ml-2 h-8 w-8 inline-flex items-center justify-center"><RefreshCw size={15} /></button>}</div>}
          <button type="submit" disabled={!valid || !!busy || disabled} className="col-span-2 h-10 bg-[var(--bg)] text-[12px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"><ClockArrowUp size={16} />{busy === 'preview' ? t('Загружаем…') : t('Предпросмотр сдвига')}</button>
        </form>
        {preview && <div className="border-t border-[var(--line)] pt-3 space-y-3 text-[12px]">
          <p className="break-words">{t('Версия программы')}: {preview.data.sourceVersion} · {preview.data.scope.date} · {preview.data.scope.timeZone}</p>
          {preview.data.blocks.map(b => <div key={b.id} data-testid={`shift-block-${b.id}`} className="border-b border-[var(--line)] py-2 space-y-1 break-words">
            <b>{name(b.id)}</b>
            <p className="text-[11px] text-[var(--soft)]">{detail(b.id)?.eventName ?? t('Мероприятие неизвестно')} · {detail(b.id)?.timeZone ?? t('Часовой пояс неизвестен')}</p>
            <p className="tabular">{t('До сдвига')}: {interval(b.before, b.id)}</p>
            <p className="tabular flex items-start gap-1"><ArrowRight size={13} className="shrink-0 mt-0.5" /><span>{t('После сдвига')}: {interval(b.after, b.id)}</span></p>
          </div>)}
          {preview.data.excluded.map(b => <div key={b.id} className="break-words text-[var(--soft)]"><p>{name(b.id)} · {t(reasons[b.reason])}</p>
            {detail(b.id) && <p className="text-[11px]">{interval(detail(b.id)!, b.id)} · {detail(b.id)?.timeZone ?? t('Часовой пояс неизвестен')}</p>}
          </div>)}
          {preview.data.conflicts.map((c, i) => <div role="alert" key={i} className="break-words text-[var(--rose-ink)]"><p>{t(conflicts[c.kind])}</p>
            {c.blockIds.map(id => {
              const changed = preview.data.blocks.find(b => b.id === id)
              return <p key={id} className="text-[11px]">{name(id)}{detail(id) ? ` · ${t(changed ? 'После сдвига' : 'Без сдвига')} · ${interval(changed?.after ?? detail(id)!, id)} · ${detail(id)?.timeZone ?? t('Часовой пояс неизвестен')}` : ''}</p>
            })}
          </div>)}
          {!!preview.data.referenceDetails?.length && <section aria-label={t('Участники программы')}>
            <h3 className="font-semibold">{t('Участники программы')}</h3>
            <ul className="space-y-2 mt-2">{preview.data.referenceDetails.map(r => <li key={`${r.kind}:${r.id}`} className="break-words">
              <p>{t(referenceKinds[r.kind])} · {r.name ?? `${t('Имя не задано')} · ${r.id}`}</p>
              {r.assignments.map(a => <p key={`${a.blockId}:${a.role}`} className="text-[11px] text-[var(--soft)]">{t(a.role === 'responsible' ? 'Ответственный' : 'Участник')} · {name(a.blockId)}</p>)}
            </li>)}</ul>
          </section>}
          {preview.data.movements.map(m => <div key={m.blockId} data-testid={`shift-movement-${m.blockId}`} className="break-words space-y-1">
            <p>{name(m.blockId)} · {m.location ?? t('Место не задано')} · {t('Переезд, мин')}: {m.travelMinutes} · {t('Запас, мин')}: {m.bufferMinutes}</p>
            <p>{t('Плановое начало до сдвига')}: {displayMoment(m.beforeArrival, detail(m.blockId)?.timeZone ?? null)}</p>
            <p>{t('Плановое начало после сдвига')}: {displayMoment(m.afterArrival, detail(m.blockId)?.timeZone ?? null)}</p>
          </div>)}
          <p>{t('касается гостей:')} {preview.data.guestsAffected} · {t('сообщите им сами, приложение гостям не пишет')}</p>
          {!guestMetadataComplete && !!preview.data.affectedGuests?.length && <details><summary className="cursor-pointer font-semibold">{t('Затронутые гости')}</summary>
            <ul className="mt-2 space-y-1">{preview.data.affectedGuests.map(g => <li key={g.id} className="break-words">{g.name ?? `${t('Имя не задано')} · ${g.id}`}</li>)}</ul>
          </details>}
          {guestMetadataComplete && <section aria-label={t('Участие затронутых гостей')} className="space-y-2">
            <h3 className="font-semibold">{t('Участие затронутых гостей')}</h3>
            <p>{t('Неизвестное участие:')} {preview.data.unknownGuestCount}</p>
            <ul className="space-y-2">{preview.data.guestConsequences.map(g => <li key={`${g.eventId}:${g.guestId}`} className="break-words border-b border-[var(--line)] pb-2">
              <p><span>{g.name ?? `${t('Имя не задано')} · ${g.guestId}`}</span> · <span>{g.eventName}</span></p>
              <p className="text-[11px] text-[var(--soft)]">{t(participationStatuses[g.status])} · {g.source ? t(participationSources[g.source]) : t('Источник ответа неизвестен')} · {t('Версия ответа')}: {g.version}</p>
              <p className="text-[11px] text-[var(--soft)]"><span>{g.invitation ? t(invitationSources[g.invitation]) : t('Приглашение на мероприятие отсутствует')}</span>{g.assignment ? ` · ${t('Назначен в программе')}` : ''}</p>
            </li>)}</ul>
          </section>}
          {!detailsComplete && <p role="alert">{t('Контекст предпросмотра недоступен — повторите просмотр')}</p>}
          {!preview.version && <p role="alert">{t('Версия программы недоступна — сохранение закрыто')}</p>}
          {!preview.data.blocks.length && <p role="status">{t('Нет блоков для сдвига')}</p>}
          <button type="button" disabled={!detailsComplete || !preview.data.canConfirm || !preview.data.previewToken || !preview.version || blocked || !!busy || disabled} onClick={() => void confirm()} className="h-10 w-full rounded-lg bg-[var(--dark-gold)] text-[var(--on-grad)] font-semibold disabled:opacity-50">{busy === 'confirm' ? t('Двигаем…') : t('Подтвердить сдвиг')}</button>
        </div>}
        {error && <p role="alert" className="text-[12px] break-words text-[var(--rose-ink)]">{error}</p>}
        {receipt && <p role="status" className="text-[12px] break-words">{receipt}</p>}
      </DialogContent>
  </Dialog>
}
