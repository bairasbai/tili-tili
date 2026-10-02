import { describe, expect, it } from 'vitest'
import { formatOrderLocal, parseOrderLocal } from './orderTime'

describe('explicit order location clock', () => {
  it('uses Moscow and Ufa clocks without depending on the viewer zone', () => {
    expect(parseOrderLocal('2027-06-14T13:00', 'Europe/Moscow')).toEqual({ status: 'valid', candidate: { instant: '2027-06-14T10:00:00.000Z', offsetMinutes: 180 } })
    expect(parseOrderLocal('2027-06-14T13:00', 'Asia/Yekaterinburg')).toEqual({ status: 'valid', candidate: { instant: '2027-06-14T08:00:00.000Z', offsetMinutes: 300 } })
    expect(formatOrderLocal('2027-06-14T08:00:00Z', 'Asia/Yekaterinburg')).toBe('2027-06-14T13:00')
  })
  it('refuses absent/invalid zones and unreal calendar times', () => {
    expect(parseOrderLocal('2027-06-14T13:00', null)).toEqual({ status: 'missing_zone' })
    expect(parseOrderLocal('2027-06-14T13:00', 'not/a-zone')).toEqual({ status: 'invalid' })
    for (const value of ['2027-02-29T13:00', '2027-06-31T13:00', '2027-06-14T24:00', '2027-06-14T13:60', '0000-01-01T00:00']) expect(parseOrderLocal(value, 'UTC')).toEqual({ status: 'invalid' })
    expect(formatOrderLocal('invalid', 'Europe/Moscow')).toBeNull()
    expect(formatOrderLocal('2027-06-14T08:00:00Z', null)).toBeNull()
  })
  it('rejects a spring clock gap instead of shifting the promised time', () => {
    expect(parseOrderLocal('2027-03-28T02:30', 'Europe/Berlin')).toEqual({ status: 'gap' })
    expect(parseOrderLocal('2027-03-28T03:30', 'Europe/Berlin')).toMatchObject({ status: 'valid', candidate: { instant: '2027-03-28T01:30:00.000Z' } })
  })
  it('requires choosing which autumn occurrence was agreed', () => {
    expect(parseOrderLocal('2027-10-31T02:30', 'Europe/Berlin')).toEqual({ status: 'ambiguous', candidates: [
      { instant: '2027-10-31T00:30:00.000Z', offsetMinutes: 120 }, { instant: '2027-10-31T01:30:00.000Z', offsetMinutes: 60 },
    ] })
    expect(parseOrderLocal('2027-10-31T02:30', 'Europe/Berlin', 60)).toEqual({ status: 'valid', candidate: { instant: '2027-10-31T01:30:00.000Z', offsetMinutes: 60 } })
    expect(parseOrderLocal('2027-10-31T02:30', 'Europe/Berlin', 180)).toEqual({ status: 'invalid' })
  })
  it('handles half-hour daylight transitions and calendar year boundaries', () => {
    expect(parseOrderLocal('2027-10-03T02:15', 'Australia/Lord_Howe')).toEqual({ status: 'gap' })
    expect(parseOrderLocal('2027-01-01T00:15', 'Pacific/Kiritimati')).toEqual({ status: 'valid', candidate: { instant: '2026-12-31T10:15:00.000Z', offsetMinutes: 840 } })
    expect(parseOrderLocal('2028-02-29T13:00', 'UTC')).toMatchObject({ status: 'valid' })
  })
})
