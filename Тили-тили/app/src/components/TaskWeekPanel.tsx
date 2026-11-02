import { useId, useState } from 'react'
import type { components } from '@/lib/api/schema'
import { t } from '@/lib/i18n'
import { groupTaskWeek, taskCalendarZone } from '@/lib/taskWeek'
import { taskDue } from '@/lib/taskPriorities'
import { useOfferDay } from '@/lib/useOfferDay'
import { shortWeddingDate } from '@/lib/weddingDate'

type Task = components['schemas']['Task']
interface Props {
  tasks: readonly Task[]
  current: boolean
  calendarReady: boolean
  weddingTz?: string | null
  onOpenChecklist: () => void
}

/** Read-only projection of the existing task response, never a second task store. */
export function TaskWeekPanel({ tasks, current, calendarReady, weddingTz, onOpenChecklist }: Props) {
  const [expanded, setExpanded] = useState(false)
  const id = useId()
  const zone = calendarReady ? taskCalendarZone(weddingTz) : null
  // Do not render cached titles/counts or controls while access is being rechecked.
  if (!current) return null
  return <div className="border-t border-[var(--track)] py-3">
    <button type="button" aria-expanded={expanded} aria-controls={id}
      onClick={() => setExpanded(value => !value)}
      className="press w-full min-h-[44px] rounded-xl px-3 py-2 text-[12px] font-semibold text-[var(--rose-ink)] bg-[var(--rose-soft)]">
      {expanded ? t('Скрыть недельный обзор') : t('Показать недельный обзор')}
    </button>
    <div id={id} hidden={!expanded}>
      {expanded && (zone
        ? <TaskWeekContents tasks={tasks} zone={zone} onOpenChecklist={onOpenChecklist} />
        : <p role="status" className="py-3 text-[12px] text-[var(--soft)]">{t('Календарь свадьбы пока недоступен')}</p>)}
    </div>
  </div>
}

/** Mounted only while expanded, so the calendar clock is not polled when hidden. */
function TaskWeekContents({ tasks, zone, onOpenChecklist }: Pick<Props, 'tasks' | 'onOpenChecklist'> & { zone: string }) {
  const today = useOfferDay(zone)
  const week = groupTaskWeek(tasks, today)
  if (!week) return <p role="status" className="py-3 text-[12px] text-[var(--soft)]">{t('Календарь свадьбы пока недоступен')}</p>
  const groups = [
    { id: 'overdue', label: t('Просроченные задачи'), items: week.overdue, empty: t('Нет просроченных задач') },
    { id: 'upcoming', label: t('До конца этой недели'), items: week.upcoming, empty: t('На остаток недели нет задач со сроком') },
    { id: 'undated', label: t('Задачи без срока'), items: week.undated, empty: t('Нет задач без срока') },
  ]
  return <section aria-label={t('Задачи этой недели')} className="pt-3">
    <h3 className="text-[13px] font-semibold">{t('Задачи этой недели')}</h3>
    <p className="mt-1 text-[11px] text-[var(--soft)]">{t('Неделя: понедельник — воскресенье')}: {shortWeddingDate(week.start)} — {shortWeddingDate(week.end)}</p>
    <p className="mt-1 text-[11px] text-[var(--soft)] break-words">{t('Часовой пояс календаря')}: {zone}</p>
    <p className="mt-2 text-[11px] text-[var(--soft)]">{t('Просрочки показаны отдельно; завершённые задачи не входят в обзор.')}</p>
    {groups.map(group => <section key={group.id} aria-label={group.label} className="mt-4">
      <h4 className="text-[12px] font-semibold">{group.label}: {group.items.length}</h4>
      {group.items.length === 0
        ? <p className="py-2 text-[11px] text-[var(--soft)]">{group.empty}</p>
        : <ul className="divide-y divide-[var(--track)]">{group.items.map((task, index) => {
          const due = taskDue(task)
          return <li key={task.id ?? `${group.id}-${index}`}>
            <button type="button" onClick={onOpenChecklist}
              className="press w-full min-h-[44px] py-3 text-left">
              <span className="block text-[12.5px] font-medium break-words [overflow-wrap:anywhere]">{task.title}</span>
              <span className="block mt-1 text-[11px] text-[var(--soft)]">{due
                ? shortWeddingDate(due)
                : task.due ? t('Срок задачи некорректен — проверьте в чек-листе') : t('Срок задачи не задан')}</span>
            </button>
          </li>
        })}</ul>}
    </section>)}
    <p className="mt-4 text-[11px] text-[var(--soft)]">{t('Следующая неделя и позже')}: {week.later.length}</p>
    <button type="button" onClick={onOpenChecklist}
      className="press mt-2 w-full min-h-[44px] rounded-xl px-3 py-2 text-[12px] font-semibold text-[var(--rose-ink)] bg-[var(--rose-soft)]">
      {t('Открыть весь чек-лист')}
    </button>
  </section>
}
