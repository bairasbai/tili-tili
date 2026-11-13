import ICAL from 'ical.js'
import { isRealDate } from '../wedding/dates.js'

export const EXTERNAL_CALENDAR_FILE_LIMIT = 256 * 1024
export const EXTERNAL_CALENDAR_MAX_DAYS = 370
export type ImportedCalendarPeriod =
  | { kind: 'day'; start: string; end: string }
  | { kind: 'utc'; start: string; end: string }

const MAX_EVENTS = 500
const MAX_COMPONENT_DEPTH = 8
const ONE_DAY = 86_400_000
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(Z)?$/

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

function localToUtc(value: string, timeZone: string, formatters: Map<string, Intl.DateTimeFormat>): string {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    try {
      if (!/^[A-Za-z_][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) invalid('Неизвестный часовой пояс события')
      formatter = new Intl.DateTimeFormat('sv-SE', {
        timeZone, calendar: 'iso8601', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      })
      formatters.set(timeZone, formatter)
    } catch { return invalid('Неизвестный часовой пояс события') }
  }
  const local = (date: number) => formatter.format(date).replace(' ', 'T')
  const wall = Date.parse(value + 'Z')
  const offsets = new Set([-ONE_DAY, 0, ONE_DAY].map(delta => Date.parse(local(wall + delta) + 'Z') - wall - delta))
  const matches = [...offsets].map(offset => wall - offset).filter(instant => local(instant) === value)
  if (matches.length !== 1) invalid('Местное время события неоднозначно. Укажите его в UTC')
  const result = new Date(matches[0]!).toISOString().replace('.000Z', 'Z')
  if (!DATE_TIME.test(result) || !isRealDate(result.slice(0, 10))) invalid('Граница события вне диапазона календаря')
  return result
}

function readBoundary(event: ICAL.Component, name: 'dtstart' | 'dtend', formatters: Map<string, Intl.DateTimeFormat>) {
  const properties = event.getAllProperties(name)
  if (properties.length === 0) return null
  if (properties.length !== 1) invalid('Повторяющаяся граница события')
  const property = properties[0]!
  const timeZone = property.getParameter('tzid')
  const value: unknown = property.jCal[3]
  if (typeof value !== 'string') invalid('Некорректная граница события')
  if (property.type === 'date' && !timeZone && isRealDate(value)) return { kind: 'day' as const, value }
  const match = DATE_TIME.exec(value)
  if (property.type === 'date-time' && match && isRealDate(match[1]!)) {
    if (match[2] && !timeZone) return { kind: 'utc' as const, value }
    if (!match[2] && typeof timeZone === 'string' && timeZone) {
      return { kind: 'utc' as const, value: localToUtc(value, timeZone, formatters) }
    }
  }
  return invalid('Граница события должна быть датой или временем с часовым поясом')
}

/** Extract busy intervals only. All-day end dates are exclusive in iCalendar. */
export function readCalendarImport(input: string): ImportedCalendarPeriod[] {
  if (Buffer.byteLength(input, 'utf8') > EXTERNAL_CALENDAR_FILE_LIMIT) invalid('Файл календаря больше 256 КБ')
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
  const embeddedZones = new Set<string>()
  for (const zone of calendar.getAllSubcomponents('vtimezone')) {
    const name = zone.getFirstPropertyValue('tzid')
    if (typeof name !== 'string' || !name || embeddedZones.has(name)) invalid('Проверьте определения часовых поясов в файле')
    embeddedZones.add(name)
  }
  const events = calendar.getAllSubcomponents('vevent')
  if (events.length > MAX_EVENTS) invalid('Файл содержит больше 500 событий')

  const periods = new Map<string, ImportedCalendarPeriod>()
  const formatters = new Map<string, Intl.DateTimeFormat>()
  for (const event of events) {
    if (['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'duration'].some(property => event.hasProperty(property))) {
      invalid('Разверните повторяющиеся события и укажите конечное время')
    }
    const status = event.getFirstPropertyValue('status')
    const transparency = event.getFirstPropertyValue('transp')
    if (String(status).toUpperCase() === 'CANCELLED' || String(transparency).toUpperCase() === 'TRANSPARENT') continue
    for (const boundary of ['dtstart', 'dtend']) {
      const id = event.getFirstProperty(boundary)?.getParameter('tzid')
      if (typeof id === 'string' && embeddedZones.has(id)) {
        invalid('Для события с собственным правилом часового пояса укажите время UTC')
      }
    }
    const start = readBoundary(event, 'dtstart', formatters)
    if (!start) invalid('У события отсутствует начало')
    const end = readBoundary(event, 'dtend', formatters)
    if (end && end.kind !== start.kind) invalid('Начало и конец события имеют разные форматы')
    if (start.kind === 'utc' && !end) invalid('Для события с временем укажите конец')
    const endValue = end?.value ?? new Date(Date.parse(start.value) + ONE_DAY).toISOString().slice(0, 10)
    if (endValue <= start.value || (start.kind === 'day' && !isRealDate(endValue))) invalid('Конец должен быть позже начала события')
    const limit = start.kind === 'day' ? EXTERNAL_CALENDAR_MAX_DAYS : EXTERNAL_CALENDAR_MAX_DAYS - 2
    if (Date.parse(endValue) - Date.parse(start.value) > limit * ONE_DAY) invalid('Событие слишком длинное')
    const period = { kind: start.kind, start: start.value, end: endValue }
    periods.set(`${period.kind}/${period.start}/${period.end}`, period)
  }
  return [...periods.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
}
