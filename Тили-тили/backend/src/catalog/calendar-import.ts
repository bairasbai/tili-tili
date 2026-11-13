import ICAL from 'ical.js'
import { isRealDate } from '../wedding/dates.js'

export type ImportedCalendarPeriod =
  | { kind: 'day'; start: string; end: string }
  | { kind: 'utc'; start: string; end: string }

const MAX_BYTES = 256 * 1024
const MAX_EVENTS = 500
const MAX_COMPONENT_DEPTH = 8
const ONE_DAY = 86_400_000
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\dZ$/

export class CalendarImportError extends Error {}

function invalid(message: string): never {
  throw new CalendarImportError(message)
}

function assertBalancedComponents(input: string): void {
  const components: string[] = []
  let rootSeen = false
  for (const line of input.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const boundary = /^(BEGIN|END):([A-Z0-9-]+)$/i.exec(line)
    if (!boundary) {
      if (!components.length || /^(BEGIN|END)[;:]/i.test(line)) invalid('Нарушена структура файла iCalendar')
      continue
    }
    const name = boundary[2]!.toUpperCase()
    if (boundary[1]!.toUpperCase() === 'BEGIN') {
      if (components.length === MAX_COMPONENT_DEPTH || (!components.length && (rootSeen || name !== 'VCALENDAR'))) {
        invalid('Нарушена структура файла iCalendar')
      }
      if (!components.length) rootSeen = true
      components.push(name)
    } else if (components.pop() !== name) {
      invalid('Нарушена структура файла iCalendar')
    }
  }
  if (!rootSeen || components.length) invalid('Нарушена структура файла iCalendar')
}

function readBoundary(event: ICAL.Component, name: 'dtstart' | 'dtend') {
  const properties = event.getAllProperties(name)
  if (properties.length === 0) return null
  if (properties.length !== 1) invalid('Повторяющаяся граница события')
  const property = properties[0]!
  if (property.getParameter('tzid')) invalid('Загрузите события в UTC или в формате целых дней')
  const value: unknown = property.jCal[3]
  if (typeof value !== 'string') invalid('Некорректная граница события')
  if (property.type === 'date' && isRealDate(value)) return { kind: 'day' as const, value }
  const match = DATE_TIME.exec(value)
  if (property.type === 'date-time' && match && isRealDate(match[1]!)) return { kind: 'utc' as const, value }
  return invalid('Граница события должна быть датой или временем UTC')
}

/** Extract busy intervals only. All-day end dates are exclusive in iCalendar. */
export function readCalendarImport(input: string): ImportedCalendarPeriod[] {
  if (Buffer.byteLength(input, 'utf8') > MAX_BYTES) invalid('Файл календаря больше 256 КБ')
  const source = input.replace(/^\uFEFF/, '')
  assertBalancedComponents(source)
  let calendar: ICAL.Component
  try {
    calendar = new ICAL.Component(ICAL.parse(source))
  } catch {
    return invalid('Не удалось прочитать файл iCalendar')
  }
  if (calendar.name !== 'vcalendar' || calendar.getFirstPropertyValue('version') !== '2.0') {
    invalid('Требуется календарь iCalendar версии 2.0')
  }
  if (calendar.hasProperty('method') || calendar.getAllSubcomponents().some(component => !['vevent', 'vtimezone'].includes(component.name))) {
    invalid('Файл должен содержать календарь с отдельными событиями')
  }
  const events = calendar.getAllSubcomponents('vevent')
  if (events.length > MAX_EVENTS) invalid('Файл содержит больше 500 событий')

  const periods = new Map<string, ImportedCalendarPeriod>()
  for (const event of events) {
    if (['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'duration'].some(property => event.hasProperty(property))) {
      invalid('Разверните повторяющиеся события и укажите конечное время')
    }
    const status = event.getFirstPropertyValue('status')
    const transparency = event.getFirstPropertyValue('transp')
    if (String(status).toUpperCase() === 'CANCELLED' || String(transparency).toUpperCase() === 'TRANSPARENT') continue
    const start = readBoundary(event, 'dtstart')
    if (!start) invalid('У события отсутствует начало')
    const end = readBoundary(event, 'dtend')
    if (end && end.kind !== start.kind) invalid('Начало и конец события имеют разные форматы')
    if (start.kind === 'utc' && !end) invalid('Для события с временем укажите конец')
    const endValue = end?.value ?? new Date(Date.parse(start.value) + ONE_DAY).toISOString().slice(0, 10)
    if (endValue <= start.value || (start.kind === 'day' && !isRealDate(endValue))) invalid('Конец должен быть позже начала события')
    const period = { kind: start.kind, start: start.value, end: endValue }
    periods.set(`${period.kind}/${period.start}/${period.end}`, period)
  }
  return [...periods.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
}
