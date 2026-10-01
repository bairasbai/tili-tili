import { useId, useRef, useState } from 'react'
import { Save, X } from 'lucide-react'
import { t } from '@/lib/i18n'
import { isoAtWeddingTime } from '@/lib/weddingDate'
import type { TimelineDraft, TimelineReference } from '@/lib/api/weddingWrite'

export interface TimelineChoice { reference: TimelineReference; name: string }
interface Props {
  event: TimelineDraft
  events: TimelineDraft[]
  choices: TimelineChoice[]
  referencesReady: boolean
  referencesError?: string | null
  serverError?: string | null
  timeZone: string
  disabled: boolean
  onSave: (event: TimelineDraft) => Promise<boolean>
  onCancel: () => void
}
const referenceKey = (r: TimelineReference) => `${r.kind}:${r.id}`
const durationText = (event: TimelineDraft) => event.durationMinutes != null ? String(event.durationMinutes)
  : event.startsAt && event.endsAt ? String((Date.parse(event.endsAt) - Date.parse(event.startsAt)) / 60_000) : ''
function localStart(iso: string, tz: string): string {
  if (!iso) return ''
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' }).formatToParts(new Date(iso))
  const part = (name: string) => parts.find(p => p.type === name)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}.${part('fractionalSecond')}`
}

export function TimelinePlanningEditor({ event, events, choices, referencesReady, referencesError, serverError, timeZone, disabled, onSave, onCancel }: Props) {
  const id = useId()
  const [name, setName] = useState(event.name)
  const [location, setLocation] = useState(event.location ?? '')
  const [who, setWho] = useState(event.who ?? '')
  const [start, setStart] = useState(() => localStart(event.startsAt, timeZone))
  const [duration, setDuration] = useState(() => durationText(event))
  const [travel, setTravel] = useState(String(event.travelMinutes ?? 0))
  const [buffer, setBuffer] = useState(String(event.bufferMinutes ?? 0))
  const [fixed, setFixed] = useState(event.fixed ?? false)
  const [outdoor, setOutdoor] = useState(event.outdoor ?? false)
  const [forGuests, setForGuests] = useState(event.forGuests)
  const [responsible, setResponsible] = useState(event.responsible ?? null)
  const [participants, setParticipants] = useState(event.participants ?? [])
  const [dependencies, setDependencies] = useState(event.dependsOn ?? [])
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const selectedReferences = [...participants, ...(responsible ? [responsible] : [])]
  const allChoices = [...choices]
  for (const reference of selectedReferences) if (!allChoices.some(c => referenceKey(c.reference) === referenceKey(reference))) {
    allChoices.push({ reference, name: `${t('Участник недоступен')}: ${reference.id}` })
  }
  const validNumber = (text: string) => text !== '' && Number.isFinite(Number(text)) && Number(text) >= 0 && Number(text) <= 10080
  const numericValid = (duration === '' || validNumber(duration)) && validNumber(travel) && validNumber(buffer)
  const invalid = !name.trim() || !numericValid || (fixed && !start)
  const save = async () => {
    if (saving.current || disabled || invalid) return
    setError(null)
    const originalStart = localStart(event.startsAt, timeZone)
    const minuteStart = start ? isoAtWeddingTime(start.slice(0, 10), start.slice(11, 16), timeZone) : null
    const seconds = start.slice(16).match(/^:(\d{2})(?:\.(\d{1,3}))?$/)
    const secondsMs = seconds ? Number(seconds[1]) * 1000 + Number((seconds[2] ?? '').padEnd(3, '0')) : 0
    const startsAt = !start ? '' : start === originalStart ? event.startsAt
      : minuteStart && secondsMs < 60_000 ? new Date(Date.parse(minuteStart) + secondsMs).toISOString() : null
    if (start && !startsAt) { setError(t('Начало блока недействительно')); return }
    if (startsAt && localStart(startsAt, timeZone).slice(0, 16) !== start.slice(0, 16)) {
      setError(t('Начало блока недействительно')); return
    }
    saving.current = true
    setPending(true)
    try {
      const timeChanged = start !== originalStart || duration !== durationText(event)
      if (await onSave({ ...event, name: name.trim(), location: location.trim(), who: who.trim(),
        startsAt: startsAt || '', endsAt: timeChanged ? undefined : event.endsAt,
        durationMinutes: duration === '' ? null : Number(duration), fixed, outdoor, forGuests,
        travelMinutes: Number(travel), bufferMinutes: Number(buffer), dependsOn: dependencies,
        responsible, participants,
      })) onCancel()
    } finally { saving.current = false; setPending(false) }
  }
  const field = 'w-full min-w-0 max-w-full rounded-lg bg-[var(--bg)] px-3 py-2 text-[12px] outline-none disabled:opacity-50'
  return <form aria-label={t('Планирование блока')} className="mt-3 min-w-0 grid gap-3 border-t border-[var(--track)] pt-3"
    onSubmit={e => { e.preventDefault(); void save() }}>
    <fieldset disabled={disabled} className="min-w-0 grid gap-3">
      <label className="grid gap-1 text-[11px]">{t('Название блока')}<input className={field} value={name} maxLength={200} required onChange={e => setName(e.target.value)} /></label>
      <label className="grid gap-1 text-[11px]">{t('Место блока')}<input className={field} value={location} maxLength={300} onChange={e => setLocation(e.target.value)} /></label>
      <label className="grid gap-1 text-[11px]">{t('Начало блока')}<input type="datetime-local" step="0.001" className={field} value={start} onChange={e => setStart(e.target.value)} /></label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-[11px]">{t('Длительность, мин')}<input type="number" step="any" min={0} max={10080} className={field} value={duration} onChange={e => setDuration(e.target.value)} /></label>
        <label className="grid gap-1 text-[11px]">{t('Переезд, мин')}<input type="number" step="any" min={0} max={10080} required className={field} value={travel} onChange={e => setTravel(e.target.value)} /></label>
        <label className="grid gap-1 text-[11px]">{t('Запас, мин')}<input type="number" step="any" min={0} max={10080} required className={field} value={buffer} onChange={e => setBuffer(e.target.value)} /></label>
      </div>
      <label className="flex gap-2 items-center text-[12px]"><input type="checkbox" checked={fixed} onChange={e => setFixed(e.target.checked)} />{t('Фиксированное начало')}</label>
      <label className="flex gap-2 items-center text-[12px]"><input type="checkbox" checked={outdoor} onChange={e => setOutdoor(e.target.checked)} />{t('Под открытым небом')}</label>
      <label className="flex gap-2 items-center text-[12px]"><input type="checkbox" checked={forGuests} onChange={e => setForGuests(e.target.checked)} />{t('Показывать гостям')}</label>
      <label className="grid gap-1 text-[11px]">{t('Кто отвечает (текст)')}<input className={field} value={who} maxLength={300} onChange={e => setWho(e.target.value)} /></label>
      <label className="grid gap-1 text-[11px]"><span id={`${id}-responsible`}>{t('Ответственный')}</span>
        <select className={field} aria-labelledby={`${id}-responsible`} disabled={!referencesReady} value={responsible ? referenceKey(responsible) : ''}
          onChange={e => setResponsible(allChoices.find(c => referenceKey(c.reference) === e.target.value)?.reference ?? null)}>
          <option value="">{t('Без ответственного')}</option>
          {allChoices.map(c => <option key={referenceKey(c.reference)} value={referenceKey(c.reference)}>{c.name}</option>)}
        </select>
      </label>
      <fieldset disabled={!referencesReady} className="min-w-0 grid gap-2">
        <legend className="text-[11px] mb-1">{t('Участники блока')}</legend>
        {allChoices.map(c => <label key={referenceKey(c.reference)} className="flex gap-2 items-start text-[12px] break-words">
          <input type="checkbox" className="mt-0.5 shrink-0" checked={participants.some(r => referenceKey(r) === referenceKey(c.reference))}
            onChange={e => setParticipants(e.target.checked ? [...participants, c.reference] : participants.filter(r => referenceKey(r) !== referenceKey(c.reference)))} />
          <span className="min-w-0">{c.name}</span>
        </label>)}
        {referencesReady && !allChoices.length && <p className="text-[11px] text-[var(--soft)]">{t('Участников нет')}</p>}
      </fieldset>
      {!referencesReady && <p role={referencesError ? 'alert' : 'status'} className="text-[11px] text-[var(--soft)]">{referencesError || t('Загружаем участников…')}</p>}
      <fieldset className="min-w-0 grid gap-2">
        <legend className="text-[11px] mb-1">{t('Зависит от блоков')}</legend>
        {events.filter(e => e.id && e.id !== event.id).map(e => <label key={e.id} className="flex gap-2 items-start text-[12px] break-words">
          <input type="checkbox" className="mt-0.5 shrink-0" checked={dependencies.includes(e.id!)}
            onChange={change => setDependencies(change.target.checked ? [...dependencies, e.id!] : dependencies.filter(id => id !== e.id))} />
          <span className="min-w-0">{e.name}</span>
        </label>)}
        {events.filter(e => e.id && e.id !== event.id).length === 0 && <p className="text-[11px] text-[var(--soft)]">{t('Других блоков нет')}</p>}
      </fieldset>
    </fieldset>
    {(error || serverError) && <p role="alert" className="text-[12px] text-[var(--rose-ink)]">{error || serverError}</p>}
    <div className="flex flex-wrap gap-3">
      <button type="submit" disabled={disabled || invalid} className="press inline-flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] bg-[var(--sage-soft)] text-[var(--sage-ink)] disabled:opacity-50"><Save size={14} />{t('Сохранить блок')}</button>
      <button type="button" disabled={pending} onClick={onCancel} className="press inline-flex items-center gap-2 px-3 py-2 text-[12px] text-[var(--soft)]"><X size={14} />{t('Отмена')}</button>
    </div>
  </form>
}
