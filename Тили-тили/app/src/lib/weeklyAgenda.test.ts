import { describe, expect, it } from 'vitest'
import { pendingGuestPeople, weddingWeek, weeklyPayments, weeklyTasks } from './weeklyAgenda'
import type { components } from './api/schema'
import type { PaymentScheduleData } from './api/paymentSchedule'
const range = { from: '2026-10-05', to: '2026-10-11', today: '2026-10-07', timeZone: 'Europe/Moscow' }
const task = (id: string, due: string | null, done = false) => ({ id, due, done, title: id })
const payment = (id: string, due: string, status = 'pending') => ({ id, title: id, due, status, cancelledAt: null,
  remaining: { amount: 105099, currency: 'RUB' }, unknownAmountPayments: 0 })
const schedule = (items: unknown[]) => ({ range: { ...range, includeOverdue: true, includeCancelled: false }, items }) as PaymentScheduleData

describe('wedding calendar week, with an injected clock', () => {
  it.each([
    ['2026-10-04T23:30:00Z', 'Europe/Moscow', '2026-10-05', '2026-10-11', '2026-10-05'],
    ['2026-10-04T23:30:00Z', 'America/New_York', '2026-09-28', '2026-10-04', '2026-10-04'],
    ['2026-10-05T10:30:00Z', 'Pacific/Kiritimati', '2026-10-05', '2026-10-11', '2026-10-06'],
    ['2026-10-05T10:30:00Z', 'Pacific/Pago_Pago', '2026-09-28', '2026-10-04', '2026-10-04'],
    ['2027-01-01T12:00:00Z', 'UTC', '2026-12-28', '2027-01-03', '2027-01-01'],
    ['2026-03-08T07:30:00Z', 'America/New_York', '2026-03-02', '2026-03-08', '2026-03-08'],
    ['2026-11-01T06:30:00Z', 'America/New_York', '2026-10-26', '2026-11-01', '2026-11-01'],
    ['2028-02-29T12:00:00Z', 'UTC', '2028-02-28', '2028-03-05', '2028-02-29'],
  ])('%s in %s uses the wedding calendar', (now, zone, from, to, today) => {
    expect(weddingWeek(new Date(now), zone)).toEqual({ from, to, today, timeZone: zone })
  })
  it.each([undefined, null, '', 'Not/AZone', 42])('does not invent a zone for %s', zone => {
    expect(weddingWeek(new Date('2026-10-07T12:00Z'), zone)).toBeNull()
  })
  it('rejects an invalid clock', () => expect(weddingWeek(new Date(NaN), 'UTC')).toBeNull())
})
describe('dated tasks and undated decisions', () => {
  it('includes all overdue, filters done/future and keeps same-date server order without mutation', () => {
    const input = [task('undated', null), task('sun', range.to), task('old', '2026-01-01'),
      task('done', range.today, true), task('a', range.today), task('b', range.today), task('next', '2026-10-12'), task('bad', '2026-02-30')]
    const copy = structuredClone(input), result = weeklyTasks(input, range)
    expect(result.dated.map(r => r.task.id)).toEqual(['old', 'a', 'b', 'sun'])
    expect(result.undated.map(r => [r.task.id, r.due.state])).toEqual([['undated', 'missing'], ['bad', 'invalid']])
    expect(input).toEqual(copy)
  })
  it('does not manufacture a completion state or silently remove duplicate IDs', () => {
    expect(() => weeklyTasks([{ id: 'x' }], range)).toThrow()
    expect(() => weeklyTasks([task('x', null), task('x', null)], range)).toThrow()
  })
})
describe('server payment balances', () => {
  it('preserves exact minor amounts and unknown-payment warning; no amount arithmetic', () => {
    const partial = { ...payment('partial', range.today, 'partial'), unknownAmountPayments: 1 }
    const cancelled = { ...payment('cancelled', range.today), cancelledAt: '2026-10-01T00:00Z' }
    const input = schedule([payment('sun', range.to), partial, payment('old', '2026-01-01'), payment('paid', range.today, 'paid'),
      payment('covered', range.today, 'covered'), payment('next', '2026-10-12'), cancelled])
    const result = weeklyPayments(input, range)
    expect(result.map(p => p.id)).toEqual(['old', 'partial', 'sun'])
    expect(result[1]).toBe(input.items[1]); expect(result[1]?.remaining.amount).toBe(105099)
    expect(result[1]?.unknownAmountPayments).toBe(1)
  })
  it.each(['from', 'to', 'today', 'timeZone', 'includeOverdue', 'includeCancelled'])('rejects a mismatched %s, rather than a false empty result', key => {
    const input = schedule([]); Object.assign(input.range, { [key]: 'wrong' })
    expect(() => weeklyPayments(input, range)).toThrow()
  })
  it.each([-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects malformed money %s', amount => {
    expect(() => weeklyPayments(schedule([{ ...payment('p', range.today), remaining: { amount, currency: 'RUB' } }]), range)).toThrow()
  })
  it('rejects unknown statuses, foreign currencies and invalid dates', () => {
    expect(() => weeklyPayments(schedule([payment('p', range.today, 'unknown')]), range)).toThrow()
    expect(() => weeklyPayments(schedule([{ ...payment('p', range.today), remaining: { amount: 1, currency: 'USD' } }]), range)).toThrow()
    expect(() => weeklyPayments(schedule([payment('p', '2026-02-30')]), range)).toThrow()
  })
})
describe('per-person replies', () => {
  it('never inflates a family from plusOne or partySize', () => {
    const guests: components['schemas']['Guest'][] = [
      { id: 'a', partyId: 'family', partySize: 3, isPrimary: true, plusOne: true, status: 'yes' },
      { id: 'b', partyId: 'family', status: 'pending' }, { id: 'c', partyId: 'family', status: 'pending' },
      { id: 'd', status: 'no' },
    ]
    expect(pendingGuestPeople(guests).map(g => g.id)).toEqual(['b', 'c'])
  })
  it('does not equate absent/invalid status with a pending reply', () => {
    expect(() => pendingGuestPeople([{ id: 'x' }])).toThrow()
    expect(() => pendingGuestPeople([{ id: 'x', status: 'yes' }, { id: 'x', status: 'pending' }])).toThrow()
  })
  it('distinguishes empty success from a missing array', () => {
    expect(pendingGuestPeople([])).toEqual([])
    expect(() => pendingGuestPeople(null as never)).toThrow()
    expect(() => weeklyTasks(null as never, range)).toThrow()
    expect(() => weeklyPayments(schedule(null as never), range)).toThrow()
  })
})

it('rejects malformed labels and absent cancellation state instead of crashing rendering or hiding a payment', () => {
  expect(() => weeklyTasks([{ ...task('t', null), title: 42 } as never], range)).toThrow()
  expect(() => pendingGuestPeople([{ id: 'g', status: 'pending', name: 42 } as never])).toThrow()
  expect(() => weeklyPayments(schedule([{ ...payment('p', range.today), cancelledAt: undefined }]), range)).toThrow()
})
