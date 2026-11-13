import ICAL from 'ical.js'
import { isRealDate } from '../wedding/dates.js'

const MIN_YEAR = 1900
const MAX_YEAR = 2100
const LOCAL_TIME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/
const OFFSET = /^([+-])([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/
const YEAR_RULE_KEYS = new Set(['freq', 'interval', 'count', 'until', 'bymonth', 'byday', 'bymonthday', 'wkst'])

type Transition = { instant: number; from: number; to: number }

function assertLocalTime(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !LOCAL_TIME.test(value) || !isRealDate(value.slice(0, 10))) throw new Error('Invalid local time')
}

function localMillis(value: string): number {
  assertLocalTime(value)
  return Date.parse(value + 'Z')
}

function offsetMillis(value: unknown): number {
  const parts = typeof value === 'string' ? OFFSET.exec(value) : null
  if (!parts) throw new Error('Invalid offset')
  const [, sign, hours, minutes, seconds] = parts
  return (sign === '-' ? -1 : 1) * (Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds ?? 0)) * 1000
}

function one(component: ICAL.Component, name: string): ICAL.Property {
  const properties = component.getAllProperties(name)
  if (properties.length !== 1 || properties[0]!.jCal.length !== 4) throw new Error('Invalid observance')
  return properties[0]!
}

function observance(rule: ICAL.Component): Transition[] {
  const startProperty = one(rule, 'dtstart')
  const start: unknown = startProperty.jCal[3]
  if (startProperty.type !== 'date-time' || startProperty.getParameter('tzid') || rule.hasProperty('exdate') || rule.hasProperty('exrule')) throw new Error('Invalid observance')
  assertLocalTime(start)
  const first = localMillis(start)
  const from = offsetMillis(one(rule, 'tzoffsetfrom').jCal[3])
  const to = offsetMillis(one(rule, 'tzoffsetto').jCal[3])
  const dates = new Set([first])
  for (const property of rule.getAllProperties('rdate')) {
    if (property.getParameter('tzid') || property.type !== 'date-time') throw new Error('Invalid observance date')
    for (const value of property.jCal.slice(3) as unknown[]) {
      assertLocalTime(value)
      dates.add(localMillis(value))
      if (dates.size > 256) throw new Error('Too many observance dates')
    }
  }

  if (rule.hasProperty('rrule')) {
    const property = one(rule, 'rrule')
    const recur = property.getFirstValue()
    const raw: unknown = property.jCal[3]
    if (!(recur instanceof ICAL.Recur) || recur.freq !== 'YEARLY' || recur.interval !== 1
      || (recur.count !== null && (!Number.isInteger(recur.count) || recur.count < 1 || recur.count > 256))
      || (recur.count !== null && recur.until)
      || !raw || typeof raw !== 'object' || Object.keys(raw).some(key => !YEAR_RULE_KEYS.has(key.toLowerCase()))) {
      throw new Error('Unsupported observance recurrence')
    }
    const year = Number(start.slice(0, 4))
    const months = recur.getComponent('BYMONTH')
    const days = recur.getComponent('BYDAY')
    const monthDays = recur.getComponent('BYMONTHDAY')
    if (year < MIN_YEAR || months.length !== 1 || Number(months[0]) < 1 || Number(months[0]) > 12
      || days.length + monthDays.length !== 1
      || (days.length && !/^[+-]?[1-4](?:MO|TU|WE|TH|FR|SA|SU)$/.test(String(days[0])))
      || (monthDays.length && (!Number(monthDays[0]) || Math.abs(Number(monthDays[0])) > 28))) {
      throw new Error('Unsupported observance recurrence')
    }
    const until = recur.until?.toString()
    if (until && !until.endsWith('Z')) throw new Error('Expected UTC observance end')
    const limit = until ? localMillis(until.slice(0, -1)) : Infinity
    const iterable = recur.clone()
    iterable.until = null
    const iterator = iterable.iterator(ICAL.Time.fromDateTimeString(start))
    let ended = false
    for (let index = 0; index <= MAX_YEAR - MIN_YEAR + 2; index++) {
      const next = iterator.next()
      if (!next || next.year > MAX_YEAR + 1) { ended = true; break }
      const time = localMillis(next.toString())
      if (time - from > limit) { ended = true; break }
      if (time < first || (index === 0 && time !== first)) throw new Error('Observance does not match its rule')
      dates.add(time)
    }
    if (!ended) throw new Error('Too many observance transitions')
  }
  return [...dates].map(date => ({ instant: date - from, from, to }))
}

export function embeddedZoneConverter(zone: ICAL.Component): (value: string) => string {
  const rules = zone.getAllSubcomponents()
  if (!rules.length || rules.length > 8 || rules.some(rule => !['standard', 'daylight'].includes(rule.name))) {
    throw new Error('Invalid zone rules')
  }
  const transitions = rules.flatMap(observance).sort((a, b) => a.instant - b.instant)
    .filter((rule, index, sorted) => {
      const previous = sorted[index - 1]
      return !previous || previous.instant !== rule.instant || previous.from !== rule.from || previous.to !== rule.to
    })
  const initial = transitions[0]!.from
  for (let index = 1; index < transitions.length; index++) {
    const previous = transitions[index - 1]!, current = transitions[index]!
    if (previous.instant === current.instant || previous.to !== current.from) throw new Error('Inconsistent zone transitions')
  }
  const offsets = [...new Set([initial, ...transitions.map(t => t.to)])]
  return value => {
    const year = Number(value.slice(0, 4))
    if (year < MIN_YEAR || year > MAX_YEAR) throw new Error('Embedded zone year outside range')
    const wall = localMillis(value)
    const matches = offsets.map(offset => wall - offset).filter(instant => {
      const current = transitions.findLast(t => t.instant <= instant)
      return instant + (current?.to ?? initial) === wall
    })
    if (matches.length !== 1) throw new Error('Ambiguous local time')
    return new Date(matches[0]!).toISOString().replace('.000Z', 'Z')
  }
}
