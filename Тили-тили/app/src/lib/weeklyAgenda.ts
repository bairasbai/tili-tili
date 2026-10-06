import { classifyTaskDue } from './homeTaskPriority'
import type { components } from './api/schema'
import type { PaymentScheduleData } from './api/paymentSchedule'

type Task = components['schemas']['Task']
type Guest = components['schemas']['Guest']
export type WeekRange = { from: string; to: string; today: string; timeZone: string }
const DAY = 86_400_000
const invalid = () => new Error('invalid-weekly-response')

/** Monday–Sunday in the wedding zone; the caller supplies the clock. */
export function weddingWeek(now: Date, timeZone: unknown): WeekRange | null {
  if (typeof timeZone !== 'string' || !timeZone.trim() || !Number.isFinite(now.getTime())) return null
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
    const part = (kind: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === kind)?.value
    const today = `${part('year')?.padStart(4, '0')}-${part('month')}-${part('day')}`
    if (classifyTaskDue(today).state !== 'known') return null
    // UTC is used only for calendar arithmetic, never to choose the wedding day.
    const date = new Date(`${today}T12:00:00Z`)
    const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY
    const from = new Date(monday).toISOString().slice(0, 10)
    const to = new Date(monday + 6 * DAY).toISOString().slice(0, 10)
    if ([from, to].some(d => classifyTaskDue(d).state !== 'known')) return null
    return { from, to, today, timeZone }
  } catch { return null }
}

function validRows(rows: unknown): void {
  if (!Array.isArray(rows) || rows.some(r => !r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id)) throw invalid()
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw invalid()
}

/** Keep overdue items even before this week. Unknown dates stay separate. */
export function weeklyTasks(tasks: readonly Task[], range: WeekRange) {
  validRows(tasks)
  if (tasks.some(task => typeof task.done !== 'boolean' || (task.title != null && typeof task.title !== 'string') ||
    (task.assignee?.name != null && typeof task.assignee.name !== 'string'))) throw invalid()
  const open = tasks.map((task, index) => ({ task, index, due: classifyTaskDue(task.due) })).filter(row => !row.task.done)
  const dated = open.filter(row => row.due.state === 'known' && row.due.date <= range.to)
    .sort((a, b) => a.due.date! < b.due.date! ? -1 : a.due.date! > b.due.date! ? 1 : a.index - b.index)
  return { dated, undated: open.filter(row => row.due.state !== 'known') }
}

/** The API already calculates remaining money; never recompute it from payments. */
export function weeklyPayments(data: PaymentScheduleData, range: WeekRange) {
  if (!data || data.range?.from !== range.from || data.range?.to !== range.to || data.range?.timeZone !== range.timeZone ||
    data.range?.today !== range.today || data.range?.includeOverdue !== true || data.range?.includeCancelled !== false) throw invalid()
  validRows(data.items)
  if (data.items.some(item => !['pending', 'partial', 'paid', 'covered', 'cancelled'].includes(item.status) ||
    typeof item.title !== 'string' || (item.cancelledAt !== null && typeof item.cancelledAt !== 'string') ||
    classifyTaskDue(item.due).state !== 'known' || !Number.isSafeInteger(item.remaining?.amount) || item.remaining.amount < 0 ||
    item.remaining.currency !== 'RUB' || !Number.isSafeInteger(item.unknownAmountPayments) || item.unknownAmountPayments < 0)) throw invalid()
  return data.items.map((item, index) => ({ item, index }))
    .filter(({ item }) => item.cancelledAt === null && ['pending', 'partial'].includes(item.status) && item.due <= range.to)
    .sort((a, b) => a.item.due < b.item.due ? -1 : a.item.due > b.item.due ? 1 : a.index - b.index).map(row => row.item)
}

/** One returned row is one person. Deprecated plusOne/partySize must not add people. */
export function pendingGuestPeople(guests: readonly Guest[]) {
  validRows(guests)
  if (guests.some(guest => !['yes', 'no', 'pending'].includes(guest.status ?? '') ||
    (guest.name != null && typeof guest.name !== 'string'))) throw invalid()
  return guests.filter(guest => guest.status === 'pending')
}
