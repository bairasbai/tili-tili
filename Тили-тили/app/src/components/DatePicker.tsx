import { useState } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getI18nLang, t } from '@/lib/i18n'
import { useEscape } from '@/lib/useEscape'
import { dateRange, dateToIso, isoToDate } from '@/lib/weddingDate'

/* Названия месяцев и дней недели даёт Intl, а не словарь: склонения
 * («14 июня», а не «14 июнь») и вторая раскладка недели идут оттуда
 * бесплатно, а в словарь пришлось бы вносить 12 + 7 строк на язык. */
const locale = () => (getI18nLang() === 'en' ? 'en-GB' : 'ru-RU')

const monthTitle = (d: Date) => new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(d)

/** Понедельник первым: 2024-01-01 — понедельник, от него и отсчитываем. */
const weekdays = () => {
  const fmt = new Intl.DateTimeFormat(locale(), { weekday: 'short' })
  return Array.from({ length: 7 }, (_, k) => fmt.format(new Date(2024, 0, 1 + k)))
}

/** Понедельник первым: в России неделя начинается с него, а getDay() — с воскресенья. */
const leadingBlanks = (first: Date) => (first.getDay() + 6) % 7

/**
 * Выбор даты свадьбы: полноэкранный оверлей, как у выбора города.
 *
 * Свой календарь, а не вендоренный `ui/calendar.tsx`: тот собран на токенах
 * shadcn (`bg-background`, `text-foreground`), которых в этом проекте нет —
 * он отрисовался бы бесцветным. Здесь те же переменные, что на остальных
 * экранах (правило R-01).
 */
export function DatePicker({
  value,
  now,
  onPick,
  onClose,
  error,
}: {
  value: string | null
  /** «Сегодня» приходит снаружи: время в теле компонента запрещено (R-04). */
  now: Date
  onPick: (iso: string) => void
  onClose: () => void
  /** Отказ сервера в переносе: дата бывает занята у забронированной команды. */
  error?: string | null
}) {
  useEscape(onClose)
  const { min, max } = dateRange(now)
  const start = value ? isoToDate(value) : now
  const [cursor, setCursor] = useState(() => new Date(start.getFullYear(), start.getMonth(), 1, 12))

  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()
  const blanks = leadingBlanks(new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12))
  const todayIso = dateToIso(now)

  const shift = (months: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + months, 1, 12))
  // Листать за границы диапазона незачем: там всё равно ничего не выбрать.
  const canBack = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12) > new Date(min.getFullYear(), min.getMonth(), 1, 12)
  const canForward = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12) < new Date(max.getFullYear(), max.getMonth(), 1, 12)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('Выбор даты свадьбы')}
      className="fixed inset-0 z-50 bg-[var(--bg)] flex flex-col app-shell !relative"
      style={{ margin: '0 auto' }}
    >
      <div className="px-5 pt-6 pb-3 flex items-center gap-3">
        <b className="flex-1 font-serif-d text-[20px]">{t('Дата свадьбы')}</b>
        <button onClick={onClose} className="press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center" aria-label={t('Закрыть')}>
          <X size={17} />
        </button>
      </div>

      <div className="px-5 flex items-center gap-2">
        <button
          onClick={() => shift(-1)}
          disabled={!canBack}
          className={cn('press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center', !canBack && 'opacity-30')}
          aria-label={t('Предыдущий месяц')}
        >
          <ChevronLeft size={17} />
        </button>
        <b className="flex-1 text-center text-[14px] capitalize">{monthTitle(cursor)}</b>
        <button
          onClick={() => shift(1)}
          disabled={!canForward}
          className={cn('press w-10 h-10 rounded-full bg-[var(--card)] flex items-center justify-center', !canForward && 'opacity-30')}
          aria-label={t('Следующий месяц')}
        >
          <ChevronRight size={17} />
        </button>
      </div>

      <div className="px-5 mt-4 grid grid-cols-7 gap-1 text-center">
        {weekdays().map(w => (
          <span key={w} className="text-[10px] text-[var(--soft2)] font-semibold py-1 capitalize">{w}</span>
        ))}
        {Array.from({ length: blanks }, (_, k) => <span key={`b${k}`} />)}
        {Array.from({ length: daysInMonth }, (_, k) => {
          const day = new Date(cursor.getFullYear(), cursor.getMonth(), k + 1, 12)
          const iso = dateToIso(day)
          const disabled = iso < dateToIso(min) || iso > dateToIso(max)
          const chosen = iso === value
          return (
            <button
              key={iso}
              onClick={() => onPick(iso)}
              disabled={disabled}
              aria-current={iso === todayIso ? 'date' : undefined}
              className={cn(
                'press h-11 rounded-2xl text-[13px] font-medium tabular',
                chosen && 'grad text-[var(--on-grad)] font-bold',
                !chosen && !disabled && 'bg-[var(--card)]',
                !chosen && iso === todayIso && 'ring-1 ring-[#C98A8A]',
                disabled && 'text-[var(--soft2)] opacity-40',
              )}
            >
              {k + 1}
            </button>
          )
        })}
      </div>

      {error && <p className="px-6 mt-4 text-[12px] text-[var(--rose-ink)]">{error}</p>}
      <p className="px-6 mt-5 text-[10.5px] text-[var(--soft2)] leading-relaxed">
        {t('Дату можно менять и позже — команда и чек-лист переедут вместе с ней.')}
      </p>
    </div>
  )
}
