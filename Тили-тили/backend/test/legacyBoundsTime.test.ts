import { describe, expect, it } from 'vitest'
import { AppError } from '../src/errors.js'
import { parseLegacyBoundsSpan } from '../src/resources/legacy-bounds-time.js'

// Frozen oracle: tasks/фичи/030-экосистема-local/c371-time-contract.md:9–17.
// All UTC/local expectations below are literal fixtures, never produced by the parser.
// This pure suite does not claim database/native/API/availability acceptance.
const coverage = () => ({ preparation: true, travel: true, handover: true, returns: true, remainingWork: true })
function span(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { spanMode: 'explicit', localStartsAt: '2027-07-01T10:00:00', localEndsAt: '2027-07-01T11:00:00',
    startsAt: '2027-07-01T10:00:00Z', endsAt: '2027-07-01T11:00:00Z', timeZone: 'UTC', coverage: coverage(), ...overrides }
}
function canonical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { spanMode: 'explicit', localStartsAt: '2027-07-01T10:00:00.000', localEndsAt: '2027-07-01T11:00:00.000',
    startsAt: '2027-07-01T10:00:00.000Z', endsAt: '2027-07-01T11:00:00.000Z',
    suppliedStartsAt: '2027-07-01T10:00:00Z', suppliedEndsAt: '2027-07-01T11:00:00Z', timeZone: 'UTC', coverage: coverage(), ...overrides }
}
function without(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value }; delete copy[key]; return copy
}
function rejectsBounds(input: unknown): void {
  let failure: unknown
  try { parseLegacyBoundsSpan(input) } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AppError)
  expect(failure).toMatchObject({ statusCode: 422, code: 'validation_failed' })
}

type Positive = { name: string; input: unknown; expected: Record<string, unknown>; hours?: number }
const positive: Positive[] = [
  { name: 'TIME-P01 valid UTC control returns the exact canonical span', input: span(), expected: canonical() },
  { name: 'TIME-P02 explicit quarter-hour offset maps to Kathmandu wall time',
    input: span({ timeZone: 'Asia/Kathmandu', startsAt: '2027-07-01T10:00:00+05:45', endsAt: '2027-07-01T11:00:00+05:45' }),
    expected: canonical({ timeZone: 'Asia/Kathmandu', startsAt: '2027-07-01T04:15:00.000Z', endsAt: '2027-07-01T05:15:00.000Z',
      suppliedStartsAt: '2027-07-01T10:00:00+05:45', suppliedEndsAt: '2027-07-01T11:00:00+05:45' }) },
  { name: 'TIME-P03 one fractional digit and IANA alias are preserved canonically',
    input: span({ timeZone: 'Etc/UTC', localStartsAt: '2027-07-01T10:00:00.1', localEndsAt: '2027-07-01T11:00:00.1',
      startsAt: '2027-07-01T10:00:00.1Z', endsAt: '2027-07-01T11:00:00.1Z' }),
    expected: canonical({ timeZone: 'Etc/UTC', localStartsAt: '2027-07-01T10:00:00.100', localEndsAt: '2027-07-01T11:00:00.100',
      startsAt: '2027-07-01T10:00:00.100Z', endsAt: '2027-07-01T11:00:00.100Z',
      suppliedStartsAt: '2027-07-01T10:00:00.1Z', suppliedEndsAt: '2027-07-01T11:00:00.1Z' }) },
  { name: 'TIME-P04 two fractional digits retain hundredths',
    input: span({ localStartsAt: '2027-07-01T10:00:00.12', localEndsAt: '2027-07-01T11:00:00.12',
      startsAt: '2027-07-01T10:00:00.12Z', endsAt: '2027-07-01T11:00:00.12Z' }),
    expected: canonical({ localStartsAt: '2027-07-01T10:00:00.120', localEndsAt: '2027-07-01T11:00:00.120',
      startsAt: '2027-07-01T10:00:00.120Z', endsAt: '2027-07-01T11:00:00.120Z',
      suppliedStartsAt: '2027-07-01T10:00:00.12Z', suppliedEndsAt: '2027-07-01T11:00:00.12Z' }) },
  { name: 'TIME-P05 three fractional digits remain exact',
    input: span({ localStartsAt: '2027-07-01T10:00:00.123', localEndsAt: '2027-07-01T11:00:00.987',
      startsAt: '2027-07-01T10:00:00.123Z', endsAt: '2027-07-01T11:00:00.987Z' }),
    expected: canonical({ localStartsAt: '2027-07-01T10:00:00.123', localEndsAt: '2027-07-01T11:00:00.987',
      startsAt: '2027-07-01T10:00:00.123Z', endsAt: '2027-07-01T11:00:00.987Z',
      suppliedStartsAt: '2027-07-01T10:00:00.123Z', suppliedEndsAt: '2027-07-01T11:00:00.987Z' }) },
  { name: 'TIME-P06 Gregorian year 0001 is accepted without year-1900 coercion',
    input: span({ localStartsAt: '0001-01-01T00:00:00', localEndsAt: '0001-01-01T01:00:00',
      startsAt: '0001-01-01T00:00:00Z', endsAt: '0001-01-01T01:00:00Z' }),
    expected: canonical({ localStartsAt: '0001-01-01T00:00:00.000', localEndsAt: '0001-01-01T01:00:00.000',
      startsAt: '0001-01-01T00:00:00.000Z', endsAt: '0001-01-01T01:00:00.000Z',
      suppliedStartsAt: '0001-01-01T00:00:00Z', suppliedEndsAt: '0001-01-01T01:00:00Z' }) },
  { name: 'TIME-P07 latest supported Gregorian year remains finite',
    input: span({ localStartsAt: '9999-12-31T22:00:00', localEndsAt: '9999-12-31T23:00:00',
      startsAt: '9999-12-31T22:00:00Z', endsAt: '9999-12-31T23:00:00Z' }),
    expected: canonical({ localStartsAt: '9999-12-31T22:00:00.000', localEndsAt: '9999-12-31T23:00:00.000',
      startsAt: '9999-12-31T22:00:00.000Z', endsAt: '9999-12-31T23:00:00.000Z',
      suppliedStartsAt: '9999-12-31T22:00:00Z', suppliedEndsAt: '9999-12-31T23:00:00Z' }) },
  { name: 'TIME-P08 real leap day is accepted',
    input: span({ localStartsAt: '2028-02-29T10:00:00', localEndsAt: '2028-02-29T11:00:00',
      startsAt: '2028-02-29T10:00:00Z', endsAt: '2028-02-29T11:00:00Z' }),
    expected: canonical({ localStartsAt: '2028-02-29T10:00:00.000', localEndsAt: '2028-02-29T11:00:00.000',
      startsAt: '2028-02-29T10:00:00.000Z', endsAt: '2028-02-29T11:00:00.000Z',
      suppliedStartsAt: '2028-02-29T10:00:00Z', suppliedEndsAt: '2028-02-29T11:00:00Z' }) },
  { name: 'TIME-P09 explicit span may cross local midnight',
    input: span({ localStartsAt: '2027-07-01T23:30:00', localEndsAt: '2027-07-02T00:30:00',
      startsAt: '2027-07-01T23:30:00Z', endsAt: '2027-07-02T00:30:00Z' }),
    expected: canonical({ localStartsAt: '2027-07-01T23:30:00.000', localEndsAt: '2027-07-02T00:30:00.000',
      startsAt: '2027-07-01T23:30:00.000Z', endsAt: '2027-07-02T00:30:00.000Z',
      suppliedStartsAt: '2027-07-01T23:30:00Z', suppliedEndsAt: '2027-07-02T00:30:00Z' }) },
  { name: 'TIME-P10 explicit span may cover multiple dates',
    input: span({ localEndsAt: '2027-07-03T11:00:00', endsAt: '2027-07-03T11:00:00Z' }),
    expected: canonical({ localEndsAt: '2027-07-03T11:00:00.000', endsAt: '2027-07-03T11:00:00.000Z', suppliedEndsAt: '2027-07-03T11:00:00Z' }) },
  { name: 'TIME-P11 Berlin fold accepts the explicitly selected first offset',
    input: span({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:15:00', localEndsAt: '2027-10-31T02:45:00',
      startsAt: '2027-10-31T02:15:00+02:00', endsAt: '2027-10-31T02:45:00+02:00' }),
    expected: canonical({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:15:00.000', localEndsAt: '2027-10-31T02:45:00.000',
      startsAt: '2027-10-31T00:15:00.000Z', endsAt: '2027-10-31T00:45:00.000Z',
      suppliedStartsAt: '2027-10-31T02:15:00+02:00', suppliedEndsAt: '2027-10-31T02:45:00+02:00' }) },
  { name: 'TIME-P12 Berlin fold accepts the explicitly selected second offset',
    input: span({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:15:00', localEndsAt: '2027-10-31T02:45:00',
      startsAt: '2027-10-31T02:15:00+01:00', endsAt: '2027-10-31T02:45:00+01:00' }),
    expected: canonical({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:15:00.000', localEndsAt: '2027-10-31T02:45:00.000',
      startsAt: '2027-10-31T01:15:00.000Z', endsAt: '2027-10-31T01:45:00.000Z',
      suppliedStartsAt: '2027-10-31T02:15:00+01:00', suppliedEndsAt: '2027-10-31T02:45:00+01:00' }) },
  { name: 'TIME-P13 equal fold wall clocks can still delimit increasing instants', hours: 1,
    input: span({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:30:00', localEndsAt: '2027-10-31T02:30:00',
      startsAt: '2027-10-31T00:30:00Z', endsAt: '2027-10-31T01:30:00Z' }),
    expected: canonical({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:30:00.000', localEndsAt: '2027-10-31T02:30:00.000',
      startsAt: '2027-10-31T00:30:00.000Z', endsAt: '2027-10-31T01:30:00.000Z',
      suppliedStartsAt: '2027-10-31T00:30:00Z', suppliedEndsAt: '2027-10-31T01:30:00Z' }) },
  { name: 'TIME-P14 Berlin whole local spring day has 23 real hours', hours: 23,
    input: span({ spanMode: 'whole_local_day', timeZone: 'Europe/Berlin', localStartsAt: '2027-03-28T00:00:00', localEndsAt: '2027-03-29T00:00:00',
      startsAt: '2027-03-27T23:00:00Z', endsAt: '2027-03-28T22:00:00Z' }),
    expected: canonical({ spanMode: 'whole_local_day', timeZone: 'Europe/Berlin', localStartsAt: '2027-03-28T00:00:00.000', localEndsAt: '2027-03-29T00:00:00.000',
      startsAt: '2027-03-27T23:00:00.000Z', endsAt: '2027-03-28T22:00:00.000Z',
      suppliedStartsAt: '2027-03-27T23:00:00Z', suppliedEndsAt: '2027-03-28T22:00:00Z' }) },
  { name: 'TIME-P15 Berlin whole local autumn day has 25 real hours', hours: 25,
    input: span({ spanMode: 'whole_local_day', timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T00:00:00', localEndsAt: '2027-11-01T00:00:00',
      startsAt: '2027-10-30T22:00:00Z', endsAt: '2027-10-31T23:00:00Z' }),
    expected: canonical({ spanMode: 'whole_local_day', timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T00:00:00.000', localEndsAt: '2027-11-01T00:00:00.000',
      startsAt: '2027-10-30T22:00:00.000Z', endsAt: '2027-10-31T23:00:00.000Z',
      suppliedStartsAt: '2027-10-30T22:00:00Z', suppliedEndsAt: '2027-10-31T23:00:00Z' }) },
  { name: 'TIME-P16 Lord Howe whole local spring day has 23.5 real hours', hours: 23.5,
    input: span({ spanMode: 'whole_local_day', timeZone: 'Australia/Lord_Howe', localStartsAt: '2027-10-03T00:00:00', localEndsAt: '2027-10-04T00:00:00',
      startsAt: '2027-10-02T13:30:00Z', endsAt: '2027-10-03T13:00:00Z' }),
    expected: canonical({ spanMode: 'whole_local_day', timeZone: 'Australia/Lord_Howe', localStartsAt: '2027-10-03T00:00:00.000', localEndsAt: '2027-10-04T00:00:00.000',
      startsAt: '2027-10-02T13:30:00.000Z', endsAt: '2027-10-03T13:00:00.000Z',
      suppliedStartsAt: '2027-10-02T13:30:00Z', suppliedEndsAt: '2027-10-03T13:00:00Z' }) },
  { name: 'TIME-P17 Lord Howe whole local autumn day has 24.5 real hours', hours: 24.5,
    input: span({ spanMode: 'whole_local_day', timeZone: 'Australia/Lord_Howe', localStartsAt: '2027-04-04T00:00:00', localEndsAt: '2027-04-05T00:00:00',
      startsAt: '2027-04-03T13:00:00Z', endsAt: '2027-04-04T13:30:00Z' }),
    expected: canonical({ spanMode: 'whole_local_day', timeZone: 'Australia/Lord_Howe', localStartsAt: '2027-04-04T00:00:00.000', localEndsAt: '2027-04-05T00:00:00.000',
      startsAt: '2027-04-03T13:00:00.000Z', endsAt: '2027-04-04T13:30:00.000Z',
      suppliedStartsAt: '2027-04-03T13:00:00Z', suppliedEndsAt: '2027-04-04T13:30:00Z' }) },
  { name: 'TIME-P18 UTC whole local day uses adjacent calendar midnights', hours: 24,
    input: span({ spanMode: 'whole_local_day', localStartsAt: '2027-07-01T00:00:00', localEndsAt: '2027-07-02T00:00:00',
      startsAt: '2027-07-01T00:00:00Z', endsAt: '2027-07-02T00:00:00Z' }),
    expected: canonical({ spanMode: 'whole_local_day', localStartsAt: '2027-07-01T00:00:00.000', localEndsAt: '2027-07-02T00:00:00.000',
      startsAt: '2027-07-01T00:00:00.000Z', endsAt: '2027-07-02T00:00:00.000Z',
      suppliedStartsAt: '2027-07-01T00:00:00Z', suppliedEndsAt: '2027-07-02T00:00:00Z' }) },
  { name: 'TIME-P19 syntactic maximum positive offset remains an explicit instant',
    input: span({ startsAt: '2027-07-02T09:59:00+23:59', endsAt: '2027-07-02T10:59:00+23:59' }),
    expected: canonical({ suppliedStartsAt: '2027-07-02T09:59:00+23:59', suppliedEndsAt: '2027-07-02T10:59:00+23:59' }) },
  { name: 'TIME-P20 explicit negative half-hour offset maps to Newfoundland wall time',
    input: span({ timeZone: 'America/St_Johns', startsAt: '2027-07-01T10:00:00-02:30', endsAt: '2027-07-01T11:00:00-02:30' }),
    expected: canonical({ timeZone: 'America/St_Johns', startsAt: '2027-07-01T12:30:00.000Z', endsAt: '2027-07-01T13:30:00.000Z',
      suppliedStartsAt: '2027-07-01T10:00:00-02:30', suppliedEndsAt: '2027-07-01T11:00:00-02:30' }) },
]

const negative: { name: string; input: unknown }[] = [
  { name: 'TIME-N01 mismatching local wall time and UTC zone is rejected', input: span({ localStartsAt: '2027-07-01T09:00:00' }) },
  { name: 'TIME-N02 null is not a span', input: null },
  { name: 'TIME-N03 array is not a plain span object', input: [] },
  { name: 'TIME-N04 unsupported span mode is rejected', input: span({ spanMode: 'day' }) },
  { name: 'TIME-N05 missing local endpoint is rejected', input: without(span(), 'localEndsAt') },
  { name: 'TIME-N06 extra root key cannot become hidden material', input: span({ sourceId: 'extra' }) },
  { name: 'TIME-N07 preparation coverage must be literal true', input: span({ coverage: { ...coverage(), preparation: false } }) },
  { name: 'TIME-N08 travel coverage must be literal true', input: span({ coverage: { ...coverage(), travel: 1 } }) },
  { name: 'TIME-N09 handover coverage must be literal true', input: span({ coverage: { ...coverage(), handover: 'true' } }) },
  { name: 'TIME-N10 returns coverage must be literal true', input: span({ coverage: { ...coverage(), returns: null } }) },
  { name: 'TIME-N11 remaining work coverage must be literal true', input: span({ coverage: { ...coverage(), remainingWork: undefined } }) },
  { name: 'TIME-N12 missing coverage key cannot claim completeness', input: span({ coverage: without(coverage(), 'travel') }) },
  { name: 'TIME-N13 extra coverage key is rejected', input: span({ coverage: { ...coverage(), staffing: true } }) },
  { name: 'TIME-N14 coverage array is rejected', input: span({ coverage: [true, true, true, true, true] }) },
  { name: 'TIME-N15 February 30 cannot normalize into March',
    input: span({ localStartsAt: '2027-02-30T10:00:00', localEndsAt: '2027-03-02T11:00:00',
      startsAt: '2027-03-02T10:00:00Z', endsAt: '2027-03-02T11:00:00Z' }) },
  { name: 'TIME-N16 non-leap February 29 is rejected',
    input: span({ localStartsAt: '2027-02-29T10:00:00', localEndsAt: '2027-03-01T11:00:00',
      startsAt: '2027-03-01T10:00:00Z', endsAt: '2027-03-01T11:00:00Z' }) },
  { name: 'TIME-N17 hour 24 is not a local endpoint',
    input: span({ localStartsAt: '2027-07-01T24:00:00', localEndsAt: '2027-07-02T01:00:00',
      startsAt: '2027-07-02T00:00:00Z', endsAt: '2027-07-02T01:00:00Z' }) },
  { name: 'TIME-N18 leap second is rejected', input: span({ localStartsAt: '2027-07-01T10:00:60' }) },
  { name: 'TIME-N19 local precision beyond milliseconds is rejected', input: span({ localStartsAt: '2027-07-01T10:00:00.0000' }) },
  { name: 'TIME-N20 local endpoint cannot contain an offset', input: span({ localStartsAt: '2027-07-01T10:00:00Z' }) },
  { name: 'TIME-N21 instant requires its own explicit offset', input: span({ startsAt: '2027-07-01T10:00:00' }) },
  { name: 'TIME-N22 offset 24 hours exceeds the syntax limit', input: span({ startsAt: '2027-07-01T10:00:00+24:00' }) },
  { name: 'TIME-N23 negative zero offset is unknown rather than UTC', input: span({ startsAt: '2027-07-01T10:00:00-00:00' }) },
  { name: 'TIME-N24 instant precision beyond milliseconds is rejected', input: span({ startsAt: '2027-07-01T10:00:00.0000Z' }) },
  { name: 'TIME-N25 invalid Gregorian instant cannot normalize',
    input: span({ localStartsAt: '2027-03-02T10:00:00', localEndsAt: '2027-03-02T11:00:00',
      startsAt: '2027-02-30T10:00:00Z', endsAt: '2027-03-02T11:00:00Z' }) },
  { name: 'TIME-N26 year zero is outside the Gregorian contract',
    input: span({ localStartsAt: '0000-01-01T00:00:00', localEndsAt: '0000-01-01T01:00:00',
      startsAt: '0000-01-01T00:00:00Z', endsAt: '0000-01-01T01:00:00Z' }) },
  { name: 'TIME-N27 offset cannot move the canonical UTC result below year 0001',
    input: span({ timeZone: 'Etc/GMT-1', localStartsAt: '0001-01-01T00:00:00', localEndsAt: '0001-01-01T01:00:00',
      startsAt: '0001-01-01T00:00:00+01:00', endsAt: '0001-01-01T01:00:00+01:00' }) },
  { name: 'TIME-N28 offset cannot move the canonical UTC result beyond year 9999',
    input: span({ timeZone: 'Etc/GMT+2', localStartsAt: '9999-12-31T22:00:00', localEndsAt: '9999-12-31T23:00:00',
      startsAt: '9999-12-31T22:00:00-02:00', endsAt: '9999-12-31T23:00:00-02:00' }) },
  { name: 'TIME-N29 unknown IANA zone is rejected', input: span({ timeZone: 'Unknown/Unrecorded' }) },
  { name: 'TIME-N30 empty zone never defaults to Moscow or host zone', input: span({ timeZone: '' }) },
  { name: 'TIME-N31 zone whitespace is not trimmed', input: span({ timeZone: ' UTC ' }) },
  { name: 'TIME-N32 numeric offset is not an IANA zone', input: span({ timeZone: '+03:00' }) },
  { name: 'TIME-N33 Berlin nonexistent spring wall time cannot acquire a guessed instant',
    input: span({ timeZone: 'Europe/Berlin', localStartsAt: '2027-03-28T02:30:00', localEndsAt: '2027-03-28T04:30:00',
      startsAt: '2027-03-28T02:30:00+01:00', endsAt: '2027-03-28T04:30:00+02:00' }) },
  { name: 'TIME-N34 Berlin fold rejects an instant with neither valid chosen offset',
    input: span({ timeZone: 'Europe/Berlin', localStartsAt: '2027-10-31T02:15:00', localEndsAt: '2027-10-31T02:45:00',
      startsAt: '2027-10-31T02:15:00+03:00', endsAt: '2027-10-31T02:45:00+03:00' }) },
  { name: 'TIME-N35 equal instants are not a finite positive span', input: span({ localEndsAt: '2027-07-01T10:00:00', endsAt: '2027-07-01T10:00:00Z' }) },
  { name: 'TIME-N36 end before start is rejected', input: span({ localEndsAt: '2027-07-01T09:00:00', endsAt: '2027-07-01T09:00:00Z' }) },
  { name: 'TIME-N37 whole local day cannot start and end at noon',
    input: span({ spanMode: 'whole_local_day', localStartsAt: '2027-07-01T12:00:00', localEndsAt: '2027-07-02T12:00:00',
      startsAt: '2027-07-01T12:00:00Z', endsAt: '2027-07-02T12:00:00Z' }) },
  { name: 'TIME-N38 whole local day cannot skip a calendar date',
    input: span({ spanMode: 'whole_local_day', localStartsAt: '2027-07-01T00:00:00', localEndsAt: '2027-07-03T00:00:00',
      startsAt: '2027-07-01T00:00:00Z', endsAt: '2027-07-03T00:00:00Z' }) },
  { name: 'TIME-N39 Apia missing midnight is not repaired to the next local day',
    input: span({ spanMode: 'whole_local_day', timeZone: 'Pacific/Apia', localStartsAt: '2011-12-29T00:00:00', localEndsAt: '2011-12-30T00:00:00',
      startsAt: '2011-12-29T10:00:00Z', endsAt: '2011-12-30T10:00:00Z' }) },
  { name: 'TIME-N40 infinity is not an instant', input: span({ endsAt: 'infinity' }) },
]

describe('371-TIME strict finite local and UTC span contract; pure only', () => {
  it.each(positive)('$name', ({ input, expected, hours }) => {
    const actual = parseLegacyBoundsSpan(input)
    expect(actual).toStrictEqual(expected)
    if (hours !== undefined) expect(Date.parse(actual.endsAt) - Date.parse(actual.startsAt)).toBe(hours * 3_600_000)
  })
  it.each(negative)('$name', ({ input }) => rejectsBounds(input))

  it('TIME-H01 foreign span prototype is rejected', () => {
    rejectsBounds(Object.setPrototypeOf(span(), { inherited: true }))
  })
  it('TIME-H02 symbol root key is rejected', () => {
    const input = span(); Object.defineProperty(input, Symbol('hidden'), { value: true })
    rejectsBounds(input)
  })
  it('TIME-H03 root accessor is rejected without executing its getter', () => {
    const input = span(); let reads = 0
    Object.defineProperty(input, 'startsAt', { enumerable: true, get() { reads++; throw new Error('root getter executed') } })
    rejectsBounds(input); expect(reads).toBe(0)
  })
  it('TIME-H04 coverage accessor is rejected without executing its getter', () => {
    const input = span(), c = coverage(); let reads = 0
    Object.defineProperty(c, 'travel', { enumerable: true, get() { reads++; throw new Error('coverage getter executed') } })
    input.coverage = c; rejectsBounds(input); expect(reads).toBe(0)
  })
  it('TIME-H05 symbol coverage key is rejected', () => {
    const c = coverage(); Object.defineProperty(c, Symbol('hidden'), { value: true })
    rejectsBounds(span({ coverage: c }))
  })
  it('TIME-H06 null-prototype span and coverage are accepted as plain data', () => {
    const input = Object.assign(Object.create(null) as Record<string, unknown>, span())
    input.coverage = Object.assign(Object.create(null) as Record<string, unknown>, coverage())
    expect(parseLegacyBoundsSpan(input)).toStrictEqual(canonical())
  })
  it('TIME-H07 nonenumerable extra root key is still rejected', () => {
    const input = span(); Object.defineProperty(input, 'hidden', { value: true })
    rejectsBounds(input)
  })
  it('TIME-H08 foreign coverage prototype is rejected', () => {
    rejectsBounds(span({ coverage: Object.setPrototypeOf(coverage(), { inherited: true }) }))
  })
  it('TIME-I01 frozen input is unchanged and returned coverage is detached', () => {
    const input = span(), c = input.coverage as Record<string, unknown>
    Object.freeze(c); Object.freeze(input)
    const actual = parseLegacyBoundsSpan(input)
    expect(actual).toStrictEqual(canonical()); expect(input).toStrictEqual(span())
    expect(actual).not.toBe(input); expect(actual.coverage).not.toBe(c)
  })
  it('TIME-I02 rejected material is unchanged after validation', () => {
    const input = span({ localStartsAt: '2027-07-01T09:00:00' }), before = structuredClone(input)
    rejectsBounds(input); expect(input).toStrictEqual(before)
  })
})
