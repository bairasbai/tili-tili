import { useRef, useState } from 'react'
import { DatePicker } from './DatePicker'
import { PickerDialog } from './PickerDialog'
import { ApiError, newIdempotencyKey } from '@/lib/api/client'
import { explainError } from '@/lib/api/useApi'
import { previewWeddingReschedule, type WeddingDateConfirmation, type WeddingReschedulePreview } from '@/lib/api/wedding'
import { getI18nLang, t } from '@/lib/i18n'
import { programTime } from '@/lib/timelineClock'
import { formatWeddingDate, shortWeddingDate } from '@/lib/weddingDate'
import { useLegacyActionScope } from '@/lib/useLegacyActionScope'

const button = 'press min-h-11 rounded-xl bg-[var(--sage-soft)] px-4 py-2 text-sm font-semibold disabled:opacity-50'
const item = 'border-b border-[var(--line)] py-2 last:border-none'
const refreshCodes = new Set(['reschedule_preview_changed', 'reschedule_preview_blocked', 'team_busy', 'date_taken',
  'resource_booking_required', 'resource_reschedule_requires_agreement'])
const availability = {
  busy: 'В календаре есть конфликт',
  calendar_clear: 'В календаре нет известного конфликта',
  unknown: 'Доступность неизвестна, уточните у исполнителя',
  agreement_required: 'Требуется отдельное согласование ресурсов',
} as const
const dateLabel = (date: string | null) => shortWeddingDate(date) || t('Дата не указана')

function Impact({ preview }: { preview: WeddingReschedulePreview }) {
  const time = (value: string | null) => programTime(value, preview.timeZone, getI18nLang()) || t('Время не указано')
  return <div className="space-y-4">
    <p className="text-sm">
      {preview.currentDate ? `${formatWeddingDate(preview.currentDate)} → ` : ''}{formatWeddingDate(preview.newDate)}
    </p>
    {preview.currentDate === preview.newDate && <p className="text-sm">{t('Дата не изменилась')}</p>}
    <section aria-label={t('Мероприятия')}>
      <h3 className="font-semibold">{t('Мероприятия')}</h3>
      <ul className="text-sm">{preview.events.map(event => <li key={event.id} className={item}>
        <div className="break-words">{event.name}</div>
        <span>{event.main && event.before !== event.after
          ? `${dateLabel(event.before)} → ${dateLabel(event.after)}`
          : `${dateLabel(event.after)} · ${t('Дата сохраняется')}`}</span>
      </li>)}</ul>
    </section>
    {preview.tasks.length > 0 && <section aria-label={t('Сроки задач')}>
      <h3 className="font-semibold">{t('Сроки задач')}</h3>
      <ul className="text-sm">{preview.tasks.map(task => <li key={task.id} className={item}>
        <div className="break-words">{task.title}</div>
        <span>{dateLabel(task.before)} → {dateLabel(task.after)}</span>
      </li>)}</ul>
    </section>}
    {preview.timeline.length > 0 && <section aria-label={t('Блоки основной программы')}>
      <h3 className="font-semibold">{t('Блоки основной программы')}</h3>
      <ul className="text-sm">{preview.timeline.map(block => <li key={block.id} className={item}>
        <div className="break-words">{block.name}</div>
        {block.beforeStart !== block.afterStart && <div>{t('Начало')} · {time(block.beforeStart)} → {time(block.afterStart)}</div>}
        {block.beforeEnd !== block.afterEnd && <div>{t('Окончание')} · {time(block.beforeEnd)} → {time(block.afterEnd)}</div>}
      </li>)}</ul>
    </section>}
    {preview.bookings.length > 0 && <section aria-label={t('Действующие брони')}>
      <h3 className="font-semibold">{t('Действующие брони')}</h3>
      <ul className="text-sm">{preview.bookings.map(booking => <li key={booking.id} className={item}>
        <div className="break-words">{booking.name}</div>
        <span>{t(availability[booking.availability])}</span>
        {!booking.moves && <div>{t('Дата брони сохраняется')}</div>}
      </li>)}</ul>
    </section>}
    {preview.closingRequests > 0 && <p className="text-sm">
      {t('Заявок на предложения будет закрыто: {count}').replace('{count}', String(preview.closingRequests))}
    </p>}
  </div>
}

export function WeddingDateChange({ weddingId, currentDate, now, onApply, onClose }: {
  weddingId: string
  currentDate: string | null
  now: Date
  onApply: (date: string, confirmation: WeddingDateConfirmation) => Promise<void>
  onClose: () => void
}) {
  const capture = useLegacyActionScope(weddingId, weddingId)
  const [attempt, setAttempt] = useState<{ preview: WeddingReschedulePreview; idempotencyKey: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'loading' | 'saving' | null>(null)
  const pending = useRef<typeof busy>(null)

  async function load(date: string) {
    const origin = capture()
    const preview = await previewWeddingReschedule(weddingId, date, origin)
    origin.assertCurrent()
    setAttempt({ preview, idempotencyKey: newIdempotencyKey() })
  }

  async function select(date: string) {
    if (pending.current) return
    const origin = capture()
    pending.current = 'loading'
    setBusy('loading')
    setError(null)
    try { await load(date) } catch (cause) { if (origin.isCurrent()) setError(explainError(cause)) } finally {
      pending.current = null
      if (origin.isCurrent()) setBusy(null)
    }
  }

  async function confirm() {
    if (pending.current || !attempt?.preview.canConfirm) return
    const origin = capture()
    const { preview, idempotencyKey } = attempt
    pending.current = 'saving'
    setBusy('saving')
    setError(null)
    try {
      await onApply(preview.newDate, { previewToken: preview.previewToken, idempotencyKey, assertCurrent: origin.assertCurrent })
      if (origin.isCurrent()) onClose()
    } catch (cause) {
      if (!origin.isCurrent()) return
      if (cause instanceof ApiError && refreshCodes.has(cause.code)) {
        setAttempt(null)
        setError(t('Условия изменились. Проверьте новый предпросмотр.'))
        try { await load(preview.newDate) } catch (refreshError) {
          if (origin.isCurrent()) setError(explainError(refreshError))
        }
      } else {
        setError(explainError(cause))
      }
    } finally {
      pending.current = null
      if (origin.isCurrent()) setBusy(null)
    }
  }

  if (!attempt) return <DatePicker value={currentDate} now={now} onClose={onClose} error={error}
    onPick={date => void select(date)} busy={Boolean(busy)} hint={t('Выберите дату, чтобы увидеть последствия переноса.')} />

  return <PickerDialog label={t('Предпросмотр переноса')} onClose={() => { if (!pending.current) onClose() }}>
    <div className="space-y-4 px-5 py-6">
      <h2 className="font-serif-d text-xl">{t('Предпросмотр переноса')}</h2>
      {error && <p role="alert" className="text-sm text-[var(--rose-ink)]">{error}</p>}
      <Impact preview={attempt.preview} />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} onClick={() => { setAttempt(null); setError(null) }} disabled={Boolean(busy)}>
          {t('Выбрать другую дату')}
        </button>
        <button type="button" className={button} onClick={() => void confirm()} disabled={Boolean(busy) || !attempt.preview.canConfirm}>
          {busy === 'saving' ? t('Секунду…') : t('Подтвердить перенос')}
        </button>
        <button type="button" className="press min-h-11 px-4 text-sm" disabled={Boolean(busy)} onClick={onClose}>{t('Отмена')}</button>
      </div>
    </div>
  </PickerDialog>
}
