import { describe, expect, it } from 'vitest'
import { CalendarImportError, readCalendarImport } from '../src/catalog/calendar-import.js'

const calendar = (...lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n')
const event = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT']

describe('извлечение занятости из ICS', () => {
  it('оставляет только интервалы, объединяет дубли и учитывает исключительную дату конца', () => {
    const result = readCalendarImport(calendar(
      ...event('DTSTART;VALUE=DATE:20271107', 'DTEND;VALUE=DATE:20271109', 'SUMMARY:Чужое мероприятие', 'DESCRIPTION:личные детали'),
      ...event('DTSTART;VALUE=DATE:20271107', 'DTEND;VALUE=DATE:20271109'),
      ...event('DTSTART:20271110T110000Z', 'DTEND:20271110T150000Z', 'ATTENDEE:mailto:guest@example.test'),
      ...event('DTSTART;VALUE=DATE:20271111', 'SUMMARY:Перенесённое событие'),
      ...event('DTSTART;VALUE=DATE:20271112', 'STATUS:CANCELLED'),
      ...event('DTSTART;VALUE=DATE:20271113', 'TRANSP:TRANSPARENT'),
    ))
    expect(result).toEqual([
      { kind: 'day', start: '2027-11-07', end: '2027-11-09' },
      { kind: 'utc', start: '2027-11-10T11:00:00Z', end: '2027-11-10T15:00:00Z' },
      { kind: 'day', start: '2027-11-11', end: '2027-11-12' },
    ])
  })

  it.each([
    ['DTSTART;VALUE=DATE:20270230'],
    ['DTSTART:20271110T110000'],
    ['DTSTART;TZID=Wrong/Zone:20271110T110000', 'DTEND;TZID=Wrong/Zone:20271110T120000'],
    ['DTSTART;TZID=America/New_York:20270314T023000', 'DTEND;TZID=America/New_York:20270314T040000'],
    ['DTSTART;TZID=America/New_York:20271107T013000', 'DTEND;TZID=America/New_York:20271107T030000'],
    ['DTSTART;VALUE=DATE:20271107', 'DTEND;VALUE=DATE:20271107'],
    ['DTSTART:20271110T110000Z', 'DTEND;VALUE=DATE:20271111'],
    ['DTSTART:20271110T110000Z'],
    ['DTSTART;VALUE=DATE:20271107', 'RRULE:FREQ=DAILY'],
    ['DTSTART;VALUE=DATE:20271107', 'RRULE:FREQ=DAILY;COUNT=2;BYDAY=MO'],
    ['DTSTART;VALUE=DATE:20271107', 'RRULE:FREQ=WEEKLY;COUNT=501'],
    ['DTSTART;VALUE=DATE:20271107', 'DTSTART;VALUE=DATE:20271108'],
  ])('отказывает для неоднозначного или неподдерживаемого события %s', (...lines) => {
    expect(() => readCalendarImport(calendar(...event(...lines)))).toThrow(CalendarImportError)
  })

  it('переводит IANA TZID в UTC с учётом сезонного сдвига и разных зон границ', () => {
    expect(readCalendarImport(calendar(
      ...event('DTSTART;TZID=Europe/Moscow:20271110T110000', 'DTEND;TZID=Europe/Berlin:20271110T100000'),
      ...event('DTSTART;TZID=Europe/Berlin:20270710T110000', 'DTEND:20270710T100000Z'),
    ))).toEqual([
      { kind: 'utc', start: '2027-07-10T09:00:00Z', end: '2027-07-10T10:00:00Z' },
      { kind: 'utc', start: '2027-11-10T08:00:00Z', end: '2027-11-10T09:00:00Z' },
    ])
  })

  it('явное определение зоны из файла нельзя подменить встроенным правилом сервера', () => {
    expect(() => readCalendarImport(calendar(
      'BEGIN:VTIMEZONE', 'TZID:Europe/Moscow', 'END:VTIMEZONE',
      ...event('DTSTART;TZID=Europe/Moscow:20271110T110000', 'DTEND;TZID=Europe/Moscow:20271110T120000'),
    ))).toThrow('собственным правилом часового пояса')
  })

  it('раскрывает ограниченные ежедневные и еженедельные повторения целых дней и UTC', () => {
    expect(readCalendarImport(calendar(
      ...event('DTSTART;VALUE=DATE:20271107', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=2'),
      ...event('DTSTART:20271110T110000Z', 'DTEND:20271110T150000Z', 'RRULE:FREQ=WEEKLY;COUNT=2'),
    ))).toEqual([
      { kind: 'day', start: '2027-11-07', end: '2027-11-08' },
      { kind: 'day', start: '2027-11-09', end: '2027-11-10' },
      { kind: 'utc', start: '2027-11-10T11:00:00Z', end: '2027-11-10T15:00:00Z' },
      { kind: 'utc', start: '2027-11-17T11:00:00Z', end: '2027-11-17T15:00:00Z' },
    ])
    const series = event('DTSTART;VALUE=DATE:20271107', 'RRULE:FREQ=DAILY;COUNT=251')
    expect(() => readCalendarImport(calendar(...series, ...series))).toThrow('больше 500 событий')
  })

  it('ограничивает объём файла и количество событий до обработки', () => {
    expect(() => readCalendarImport('я'.repeat(131_073))).toThrow(CalendarImportError)
    const events = Array.from({ length: 501 }, () => event('DTSTART;VALUE=DATE:20271107')).flat()
    expect(() => readCalendarImport(calendar(...events))).toThrow(CalendarImportError)
  })

  it('отказывает при нарушенной структуре, лишнем календаре и чрезмерной вложенности', () => {
    expect(() => readCalendarImport(calendar().replace('END:VCALENDAR', 'END:VEVENT'))).toThrow(CalendarImportError)
    expect(() => readCalendarImport(`${calendar()}\r\n${calendar()}`)).toThrow(CalendarImportError)
    expect(() => readCalendarImport(calendar(...Array(9).fill('BEGIN:VEVENT'), ...Array(9).fill('END:VEVENT')))).toThrow(CalendarImportError)
  })
})
