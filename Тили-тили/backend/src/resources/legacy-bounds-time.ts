import { validationFailed } from '../errors.js'

export interface LegacyBoundsSpan {
  spanMode: 'explicit' | 'whole_local_day'
  localStartsAt: string
  localEndsAt: string
  startsAt: string
  endsAt: string
  suppliedStartsAt: string
  suppliedEndsAt: string
  timeZone: string
  coverage: { preparation: true; travel: true; handover: true; returns: true; remainingWork: true }
}

const spanKeys = ['spanMode', 'localStartsAt', 'localEndsAt', 'startsAt', 'endsAt', 'timeZone', 'coverage']
const coverageKeys = ['preparation', 'travel', 'handover', 'returns', 'remainingWork']

function invalid(): never {
  throw validationFailed({ bounds: 'Нужен корректный конечный интервал с часовым поясом и полным покрытием' })
}

/** Read data descriptors only: rejected accessors never execute their getters. */
function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object') invalid()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) invalid()
  const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalid()
    data[key] = descriptor.value
  }
  return data
}

/** epoch is a UTC calendar container here, not an inferred engagement instant. */
function wallTime(value: unknown): { canonical: string; epoch: number } {
  if (typeof value !== 'string') invalid()
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value)
  if (!m || m[0] !== value) invalid()
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3])
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6])
  const fraction = (m[7] ?? '').padEnd(3, '0')
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59) invalid()
  const canonical = value.slice(0, 19) + '.' + fraction
  const date = new Date(0)
  // Date.UTC(year, ...) maps 00..99 to 1900..1999; setUTCFullYear does not.
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, Number(fraction))
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, -1) !== canonical) invalid()
  return { canonical, epoch: date.getTime() }
}

function instant(value: unknown): { supplied: string; epoch: number } {
  if (typeof value !== 'string') invalid()
  const m = /^(.*)(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!m || m[0] !== value) invalid()
  const wall = wallTime(m[1])
  const offset = m[2]!
  let minutes = 0
  if (offset !== 'Z') {
    const hours = Number(offset.slice(1, 3)), remainder = Number(offset.slice(4, 6))
    if (hours > 23 || remainder > 59 || offset === '-00:00') invalid()
    minutes = (hours * 60 + remainder) * (offset[0] === '-' ? -1 : 1)
  }
  const epoch = wall.epoch - minutes * 60_000
  const date = new Date(epoch), year = date.getUTCFullYear()
  if (!Number.isFinite(epoch) || year < 1 || year > 9999) invalid()
  return { supplied: value, epoch }
}

function localAt(formatter: Intl.DateTimeFormat, epoch: number): string {
  const parts = new Map(formatter.formatToParts(epoch).map(part => [part.type, part.value] as const))
  // Without era, a BCE local year could appear to match an AD input near year 0001.
  if (parts.get('era') !== 'AD') invalid()
  const get = (part: Intl.DateTimeFormatPartTypes, width = 2): string => {
    const value = parts.get(part)
    if (value === undefined) invalid()
    return value.padStart(width, '0')
  }
  return `${get('year', 4)}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${get('fractionalSecond', 3)}`
}

/** Pure, single-span validation only; no availability or consent authority. */
export function parseLegacyBoundsSpan(input: unknown): LegacyBoundsSpan {
  try {
    const o = dataObject(input, spanKeys), coverage = dataObject(o.coverage, coverageKeys)
    if (coverageKeys.some(key => coverage[key] !== true)) invalid()
    const spanMode = o.spanMode, timeZone = o.timeZone
    if (spanMode !== 'explicit' && spanMode !== 'whole_local_day') invalid()
    if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 100 || /\s|^[+-]/.test(timeZone)) invalid()
    const startLocal = wallTime(o.localStartsAt), endLocal = wallTime(o.localEndsAt)
    const start = instant(o.startsAt), end = instant(o.endsAt)
    if (start.epoch >= end.epoch) invalid()
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
      era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
    })
    if (localAt(formatter, start.epoch) !== startLocal.canonical || localAt(formatter, end.epoch) !== endLocal.canonical) invalid()
    if (spanMode === 'whole_local_day') {
      if (startLocal.canonical.slice(11) !== '00:00:00.000' || endLocal.canonical.slice(11) !== '00:00:00.000') invalid()
      // Advance the local calendar DATE, never the occupied UTC instant by 24h.
      const nextDate = new Date(startLocal.epoch)
      nextDate.setUTCDate(nextDate.getUTCDate() + 1)
      if (nextDate.toISOString().slice(0, 10) !== endLocal.canonical.slice(0, 10)) invalid()
    }
    return {
      spanMode, timeZone, localStartsAt: startLocal.canonical, localEndsAt: endLocal.canonical,
      startsAt: new Date(start.epoch).toISOString(), endsAt: new Date(end.epoch).toISOString(),
      suppliedStartsAt: start.supplied, suppliedEndsAt: end.supplied,
      coverage: { preparation: true, travel: true, handover: true, returns: true, remainingWork: true },
    }
  } catch {
    // Unsupported zones and hostile reflection failures use the same 422 contract.
    return invalid()
  }
}
