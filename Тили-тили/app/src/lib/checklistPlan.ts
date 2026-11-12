import { differenceInCalendarDays, subMonths } from 'date-fns'
import type { components } from './api/schema'
import { t } from './i18n'
import { dateToIso, isRealIso, isoToDate, todayIn } from './weddingDate'

const PERIODS = {
  '12': 'За 12 мес',
  '9': 'За 9 мес',
  '6': 'За 6 мес',
  '3': 'За 3 мес',
  '1': 'За 1 мес',
  last_week: 'Последняя неделя',
  wedding_day: 'День свадьбы',
  after_wedding: 'После свадьбы',
} as const
export type ChecklistPeriod = keyof typeof PERIODS
export const CHECKLIST_PERIODS: readonly ChecklistPeriod[] = ['12', '9', '6', '3', '1', 'last_week', 'wedding_day', 'after_wedding']

export function taskPeriodLabel(period: string) {
  if (Object.hasOwn(PERIODS, period)) return t(PERIODS[period as ChecklistPeriod])
  return /^\d+$/.test(period) ? `${period} ${t('мес')}` : period
}

export function checklistStage(date: string | null, timeZone: string | null, now: number): { days: number | null; period: ChecklistPeriod } {
  if (!date || !isRealIso(date)) return { days: null, period: '12' }
  const today = todayIn(timeZone, now)
  const wedding = isoToDate(date)
  const days = differenceInCalendarDays(wedding, isoToDate(today))
  if (days < 0) return { days, period: 'after_wedding' }
  if (days === 0) return { days, period: 'wedding_day' }
  if (days <= 7) return { days, period: 'last_week' }
  const stage = (['1', '3', '6', '9'] as const).find(period => today >= dateToIso(subMonths(wedding, Number(period))))
  return { days, period: stage ?? '12' }
}

type PriorityTask = Pick<components['schemas']['Task'], 'planPriority' | 'period' | 'due' | 'done'>

export function shortPreparationPriorities<T extends PriorityTask>(tasks: readonly T[], stage: ChecklistPeriod): T[] {
  const stageIndex = CHECKLIST_PERIODS.indexOf(stage)
  if (stageIndex < CHECKLIST_PERIODS.indexOf('3') || stage === 'after_wedding') return []
  const rank = (task: T) => {
    if (task.period === stage && (stage === 'last_week' || stage === 'wedding_day')) return 0
    return task.planPriority === 'foundation' ? 1 : 2
  }
  return tasks.filter(task => {
    if (task.done || !task.planPriority || task.planPriority === 'date') return false
    if (stage === 'wedding_day') return task.period === 'wedding_day'
    const index = CHECKLIST_PERIODS.indexOf(task.period as ChecklistPeriod)
    return index >= 0 && index <= stageIndex
  }).sort((a, b) => rank(a) - rank(b)
    || (a.due ?? '9999-12-31').localeCompare(b.due ?? '9999-12-31')).slice(0, 3)
}
