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
const BOUNDED_FREQUENCIES = new Set(['DAILY', 'WEEKLY'])
const SIMPLE_RULE_KEYS = new Set(['freq', 'interval', 'count', 'wkst'])

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

type Moment = { kind: ImportedCalendarPeriod['kind']; value: string }
type CalendarZones = { embedded: Set<string>; formatters: Map<string, Intl.DateTimeFormat> }

function readMoment(property: ICAL.Property, value: unknown, zones: CalendarZones): Moment {
  const timeZone = property.getParameter('tzid')
  if (typeof timeZone === 'string' && zones.embedded.has(timeZone)) {
    invalid('Для события с собственным правилом часового пояса укажите время UTC')
  }
  if (typeof value !== 'string') invalid('Некорректная граница события')
  if (property.type === 'date' && !timeZone && isRealDate(value)) return { kind: 'day', value }
  const match = DATE_TIME.exec(value)
  if (property.type === 'date-time' && match && isRealDate(match[1]!)) {
    if (match[2] && !timeZone) return { kind: 'utc', value }
    if (!match[2] && typeof timeZone === 'string' && timeZone) {
      return { kind: 'utc', value: localToUtc(value, timeZone, zones.formatters) }
    }
  }
  return invalid('Граница события должна быть датой или временем с часовым поясом')
}

function readBoundary(event: ICAL.Component, name: string, zones: CalendarZones): Moment | null {
  const properties = event.getAllProperties(name)
  if (properties.length === 0) return null
  if (properties.length !== 1 || properties[0]!.jCal.length !== 4) invalid('Повторяющаяся граница события')
  const property = properties[0]!
  return readMoment(property, property.jCal[3], zones)
}

function recurrenceDates(event: ICAL.Component, name: 'exdate' | 'rdate', kind: Moment['kind'], zones: CalendarZones): string[] {
  const dates: string[] = []
  for (const property of event.getAllProperties(name)) {
    for (const value of property.jCal.slice(3) as unknown[]) {
      const moment = readMoment(property, value, zones)
      if (moment.kind !== kind) invalid('Исключение должно иметь тот же тип даты, что и серия')
      dates.push(moment.value)
      if (dates.length > MAX_EVENTS) invalid('Календарь содержит больше 500 дат повторений')
    }
  }
  return dates
}

function busy(event: ICAL.Component): boolean {
  return String(event.getFirstPropertyValue('status')).toUpperCase() !== 'CANCELLED'
    && String(event.getFirstPropertyValue('transp')).toUpperCase() !== 'TRANSPARENT'
}

function readPeriod(event: ICAL.Component, zones: CalendarZones): ImportedCalendarPeriod {
  if (event.hasProperty('duration')) invalid('Укажите конечное время события')
  const start = readBoundary(event, 'dtstart', zones)
  if (!start) invalid('У события отсутствует начало')
  const end = readBoundary(event, 'dtend', zones)
  if (end && end.kind !== start.kind) invalid('Начало и конец события имеют разные форматы')
  if (start.kind === 'utc' && !end) invalid('Для события с временем укажите конец')
  const endValue = end?.value ?? new Date(Date.parse(start.value) + ONE_DAY).toISOString().slice(0, 10)
  if (endValue <= start.value || (start.kind === 'day' && !isRealDate(endValue))) invalid('Конец должен быть позже начала события')
  const limit = start.kind === 'day' ? EXTERNAL_CALENDAR_MAX_DAYS : EXTERNAL_CALENDAR_MAX_DAYS - 2
  if (Date.parse(endValue) - Date.parse(start.value) > limit * ONE_DAY) invalid('Событие слишком длинное')
  return { kind: start.kind, start: start.value, end: endValue }
}

function startsFor(event: ICAL.Component, start: ImportedCalendarPeriod['start'], kind: ImportedCalendarPeriod['kind']): string[] {
  const rules = event.getAllProperties('rrule')
  if (!rules.length) return [start]
  if (rules.length !== 1 || event.getFirstProperty('dtstart')?.getParameter('tzid') || event.getFirstProperty('dtend')?.getParameter('tzid')) {
    invalid('Для повторяющихся событий используйте целые дни или UTC')
  }
  const rule = rules[0]!.getFirstValue()
  const raw: unknown = rules[0]!.jCal[3]
  if (!(rule instanceof ICAL.Recur) || !BOUNDED_FREQUENCIES.has(rule.freq) || rule.until
    || !Number.isSafeInteger(rule.count) || rule.count! < 1 || rule.count! > MAX_EVENTS
    || !Number.isSafeInteger(rule.interval) || rule.interval < 1 || rule.interval > 52 || Object.keys(rule.parts).length
    || !raw || typeof raw !== 'object' || Object.keys(raw).some(key => !SIMPLE_RULE_KEYS.has(key.toLowerCase()))) {
    invalid('Поддерживаются ежедневные и еженедельные повторения с ограниченным числом событий')
  }
  const iterator = rule.iterator(kind === 'day' ? ICAL.Time.fromDateString(start) : ICAL.Time.fromDateTimeString(start))
  const result: string[] = []
  for (let index = 0; index < rule.count!; index++) {
    const occurrence = iterator.next()
    if (!occurrence) invalid('Не удалось раскрыть повторения события')
    result.push(occurrence.toString())
  }
  return result
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
  const zones: CalendarZones = { embedded: embeddedZones, formatters: new Map() }
  const overrides = new Map<string, Map<string, { kind: Moment['kind']; event: ICAL.Component }>>()
  const masters: ICAL.Component[] = []
  const masterIds = new Set<string>()
  for (const event of events) {
    if (event.getAllProperties('uid').length > 1) invalid('У события указано несколько UID')
    const uid = event.getFirstPropertyValue('uid')
    const recurrenceId = readBoundary(event, 'recurrence-id', zones)
    if (!recurrenceId) {
      if (typeof uid === 'string' && uid) {
        if (masterIds.has(uid)) invalid('В файле повторяется основное событие серии')
        masterIds.add(uid)
      }
      masters.push(event)
      continue
    }
    if (typeof uid !== 'string' || !uid || event.getFirstProperty('recurrence-id')?.getParameter('range')
      || ['rrule', 'rdate', 'exdate', 'exrule'].some(property => event.hasProperty(property))) {
      invalid('Требуется поправка одного экземпляра с UID и исходной датой')
    }
    const series = overrides.get(uid) ?? new Map()
    if (series.has(recurrenceId.value)) invalid('Для даты серии есть несколько поправок')
    series.set(recurrenceId.value, { kind: recurrenceId.kind, event })
    overrides.set(uid, series)
  }
  let total = 0
  const add = (period: ImportedCalendarPeriod) => periods.set(`${period.kind}/${period.start}/${period.end}`, period)
  for (const event of masters) {
    const uid = event.getFirstPropertyValue('uid')
    const series = typeof uid === 'string' ? overrides.get(uid) : undefined
    const masterBusy = busy(event)
    if (!masterBusy && !series) continue
    if (event.hasProperty('exrule') || (series && !event.hasProperty('rrule') && !event.hasProperty('rdate'))) {
      invalid('Проверьте правило повторения и связь поправки с серией')
    }
    const base = readPeriod(event, zones)
    const starts = startsFor(event, base.start, base.kind)
    const extra = recurrenceDates(event, 'rdate', base.kind, zones)
    const excluded = new Set(recurrenceDates(event, 'exdate', base.kind, zones))
    total += starts.length + extra.length
    if (total > MAX_EVENTS) invalid('После раскрытия повторений календарь содержит больше 500 событий')
    const duration = Date.parse(base.end) - Date.parse(base.start)
    for (const first of new Set([...starts, ...extra])) {
      if (!isRealDate(first.slice(0, 10))) invalid('Граница события вне диапазона календаря')
      const replacement = series?.get(first)
      if (replacement) {
        if (replacement.kind !== base.kind) invalid('Поправка должна иметь тот же тип даты, что и серия')
        series!.delete(first)
        if (busy(replacement.event)) add(readPeriod(replacement.event, zones))
        continue
      }
      if (!masterBusy || excluded.has(first)) continue
      const lastIso = new Date(Date.parse(first) + duration).toISOString()
      const last = base.kind === 'day' ? lastIso.slice(0, 10) : lastIso.replace('.000Z', 'Z')
      if (!isRealDate(last.slice(0, 10))) invalid('Граница события вне диапазона календаря')
      add({ kind: base.kind, start: first, end: last })
    }
    if (typeof uid === 'string' && series?.size === 0) overrides.delete(uid)
  }
  if (overrides.size) invalid('Не удалось сопоставить поправку с датой серии')
  return [...periods.values()].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
}
