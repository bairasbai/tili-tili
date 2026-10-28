import { useId, useState } from 'react'
import { key, t } from '@/lib/i18n'
import type { CalendarBoundsView, CalendarOutcomeInput, CalendarProposalInput, CalendarSpanInput } from '@/lib/api/legacy-calendar'

export const boundsControl = 'w-full min-w-0 max-w-full min-h-11 rounded-lg border border-[var(--line)] bg-[var(--card)] px-3 py-2 text-sm'
export const boundsButton = 'min-h-11 max-w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm break-words disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2'
type SpanDraft = { mode: CalendarSpanInput['spanMode']; original: string; localStart: string; localEnd: string; start: string; end: string; zone: string; coverage: boolean[] }
type OutcomeDraft = { closed: boolean; spans: SpanDraft[] }
const emptySpan = (): SpanDraft => ({ mode: 'explicit', original: '', localStart: '', localEnd: '', start: '', end: '', zone: '', coverage: [false, false, false, false, false] })
const emptyOutcome = (): OutcomeDraft => ({ closed: false, spans: [emptySpan()] })
const coverageLabels = [key('Подготовка включена'), key('Дорога включена'), key('Передача включена'), key('Возврат включён'), key('Остальные работы включены')]
function local(value: string): string { return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value) ? `${value}:00` : value }
function outcome(value: OutcomeDraft, days: string[]): CalendarOutcomeInput {
  if (value.closed) return { outcome: 'calendar_closed', closureReason: 'no_remaining_calendar_engagement', spans: [] }
  if (!value.spans.length || value.spans.length > 64) throw new Error('ranges')
  return { outcome: 'finite', closureReason: null, spans: value.spans.map(span => {
    if (!span.coverage.every(Boolean) || !span.zone.trim() || !span.localStart || !span.localEnd || !span.start || !span.end) throw new Error('incomplete')
    if (span.mode === 'whole_local_day' && (!days.includes(span.original) || local(span.localStart) !== `${span.original}T00:00:00`)) throw new Error('original')
    // No Date construction or browser-zone inference: native validation owns roundtrip/DST.
    return { spanMode: span.mode, localStartsAt: local(span.localStart), localEndsAt: local(span.localEnd), startsAt: span.start.trim(), endsAt: span.end.trim(), timeZone: span.zone.trim(),
      coverage: { preparation: true, travel: true, handover: true, returns: true, remainingWork: true } }
  }) }
}
export function LegacyCalendarBoundsEditor({ view, disabled, onPropose }: { view: CalendarBoundsView; disabled: boolean; onPropose: (body: CalendarProposalInput) => void }) {
  const editor = view.editor
  const [drafts, setDrafts] = useState<Record<string, OutcomeDraft>>({}), [manual, setManual] = useState<OutcomeDraft>(emptyOutcome)
  const [complete, setComplete] = useState(false), [persons, setPersons] = useState<string[]>([]), [error, setError] = useState(false)
  const id = useId()
  if (!editor) return null
  const manualSource = view.source.kind === 'manual_day'
  return <form className="min-w-0 space-y-4" onSubmit={event => {
    event.preventDefault(); if (disabled) return
    try {
      const holders = editor.holders.map(holder => ({ weddingId: holder.weddingId, dealId: holder.dealId, expectedOrderVersion: holder.orderVersion,
        ...outcome(drafts[holder.dealId] ?? emptyOutcome(), holder.originalDayOptions) }))
      const body: CalendarProposalInput = { expectedSourceRevision: view.source.sourceRevision, expectedInventoryRevision: view.source.inventoryRevision,
        expectedHeadRevision: view.source.headRevision, expectedSourceFingerprint: editor.sourceFingerprint, holders,
        manualBounds: manualSource ? outcome(manual, editor.manualOriginalDayOptions) : null,
        staffing: { completeness: complete ? 'declared_complete' : 'unknown', personIds: complete ? persons : [] } }
      setError(false); onPropose(body)
    } catch { setError(true) }
  }}>
    <p className="text-sm">{t('Предложение охватывает все перечисленные обязательства источника. Оно не меняет цену и само не освобождает календарь.')}</p>
    {editor.holders.map((holder, index) => <fieldset key={holder.dealId} disabled={disabled} className="min-w-0 rounded-lg border border-[var(--line)] p-3 space-y-2">
      <legend className="max-w-full break-words text-sm font-semibold">{holder.label || t('Обязательство')} · {index + 1}</legend>
      <OutcomeEditor value={drafts[holder.dealId] ?? emptyOutcome()} days={holder.originalDayOptions} onChange={value => setDrafts(old => ({ ...old, [holder.dealId]: value }))} />
    </fieldset>)}
    {manualSource && <fieldset disabled={disabled} className="min-w-0 rounded-lg border border-[var(--line)] p-3 space-y-2"><legend>{t('Ручная занятость')}</legend>
      <OutcomeEditor value={manual} days={editor.manualOriginalDayOptions} onChange={setManual} />
    </fieldset>}
    <fieldset disabled={disabled} className="min-w-0 space-y-2"><legend className="text-sm font-semibold">{t('Известные связи с людьми')}</legend>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={complete} onChange={e => setComplete(e.target.checked)} />{t('Границы учитывают всех перечисленных людей, включая исторические связи')}</label>
      {!complete && <p className="text-xs">{t('Состав людей неизвестен. Это не подтверждение свободного времени.')}</p>}
      {complete && editor.knownPersons.map((person, index) => <label key={person.id} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={persons.includes(person.id)} onChange={e => setPersons(old => e.target.checked ? [...old, person.id] : old.filter(x => x !== person.id))} />
        <span className="break-words">{person.name ?? `${t('Участник')} ${index + 1}`}{!person.available && ` · ${t('Историческая связь')}`}</span></label>)}
      {editor.unknownPersonOrigins.length > 0 && <p className="text-xs">{t('Есть неподтверждённые связи с людьми. Сервер проверит полноту перед активацией.')}</p>}
    </fieldset>
    {error && <p id={`${id}-error`} role="alert" className="text-sm">{t('Заполните местное время, UTC, пояс и все пункты покрытия. Для целого дня выберите подтверждённую исходную дату.')}</p>}
    <button type="submit" disabled={disabled || (!manualSource && editor.holders.length === 0)} className={boundsButton} aria-describedby={error ? `${id}-error` : undefined}>{t('Предложить границы всей группы')}</button>
  </form>
}
function OutcomeEditor({ value, days, onChange }: { value: OutcomeDraft; days: string[]; onChange: (value: OutcomeDraft) => void }) {
  const id = useId()
  const update = (index: number, next: SpanDraft) => onChange({ ...value, spans: value.spans.map((span, i) => i === index ? next : span) })
  return <div className="min-w-0 space-y-3">
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={value.closed} onChange={e => onChange({ ...value, closed: e.target.checked })} />{t('Все календарные работы завершены, оставшихся выездов и возвратов нет')}</label>
    {!value.closed && value.spans.map((span, index) => <div key={index} className="min-w-0 space-y-2 border-t border-[var(--line)] pt-2">
      <label className="block text-sm" htmlFor={`${id}-${index}-mode`}>{t('Вид периода')}</label>
      <select id={`${id}-${index}-mode`} className={boundsControl} value={span.mode} onChange={e => update(index, { ...span, mode: e.target.value as SpanDraft['mode'], original: '' })}>
        <option value="explicit">{t('Точное время')}</option><option value="whole_local_day" disabled={days.length === 0}>{t('Целый исходный местный день')}</option>
      </select>
      {span.mode === 'whole_local_day' && <><label className="block text-sm" htmlFor={`${id}-${index}-day`}>{t('Подтверждённая исходная дата')}</label><select className={boundsControl} id={`${id}-${index}-day`} value={span.original} onChange={e => update(index, { ...span, original: e.target.value, localStart: e.target.value ? `${e.target.value}T00:00:00` : '', localEnd: '' })}>
        <option value="">{t('Выберите исходную дату')}</option>{days.map(day => <option key={day} value={day}>{day}</option>)}</select><p className="text-xs">{t('Окончание — следующая местная полночь; UTC укажите явно с учётом перехода часов.')}</p></>}
      {([['localStart', key('Местное начало'), 'datetime-local'], ['localEnd', key('Местное окончание'), 'datetime-local'], ['start', key('Начало UTC или с явным смещением'), 'text'], ['end', key('Окончание UTC или с явным смещением'), 'text'], ['zone', key('Часовой пояс IANA'), 'text']] as const).map(([field, label, type]) => <div key={field} className="min-w-0"><label htmlFor={`${id}-${index}-${field}`} className="block text-sm">{t(label)}</label><input id={`${id}-${index}-${field}`} type={type} step={type === 'datetime-local' ? '0.001' : undefined} className={boundsControl} value={span[field]} required onChange={e => update(index, { ...span, [field]: e.target.value })} placeholder={field === 'zone' ? 'Europe/Moscow' : undefined} /></div>)}
      <div className="space-y-2">{coverageLabels.map((label, i) => <label key={label} className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 size-5 shrink-0" checked={span.coverage[i]} onChange={e => update(index, { ...span, coverage: span.coverage.map((old, j) => i === j ? e.target.checked : old) })} />{t(label)}</label>)}</div>
      <button type="button" className={boundsButton} onClick={() => onChange({ ...value, spans: value.spans.filter((_, i) => i !== index) })}>{t('Убрать период')}</button>
    </div>)}
    {!value.closed && <button type="button" className={boundsButton} disabled={value.spans.length >= 64} onClick={() => onChange({ ...value, spans: [...value.spans, emptySpan()] })}>{t('Добавить период')}</button>}
  </div>
}
