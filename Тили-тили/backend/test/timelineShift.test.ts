import { describe, expect, it } from 'vitest'
import { previewTimelineShift, type ShiftBlock, type ShiftScope } from '../src/timeline/shift.js'

const now = new Date('2027-06-14T09:00:00.000Z')
const day: ShiftScope = { kind: 'day', date: '2027-06-14', timeZone: 'Europe/Moscow' }
const person = { kind: 'member' as const, id: 'member-a' }
function block(id: string, start: string | null, options: Partial<ShiftBlock> = {}): ShiftBlock {
  return { id, name: id, startsAt: start, endsAt: start ? new Date(Date.parse(start) + 30 * 60_000).toISOString() : null,
    programEventId: null, location: null, durationMinutes: 30, fixed: false, travelMinutes: 0,
    bufferMinutes: 0, responsible: null, participants: [], dependsOn: [], ...options }
}

describe('WP03 / scoped shift calculation (not HTTP acceptance)', () => {
  it('previews only the selected local day, excluding past, ongoing, fixed and undated blocks', () => {
    const rows = [block('future', '2027-06-14T10:00:00Z'), block('past', '2027-06-14T08:00:00Z'),
      block('ongoing', now.toISOString()), block('fixed', '2027-06-14T11:00:00Z', { fixed: true }),
      block('day2', '2027-06-15T10:00:00Z'), block('undated', null)]
    const original = structuredClone(rows)
    const result = previewTimelineShift(rows, day, 15, now)
    expect(result.canConfirm).toBe(true)
    expect(result.blocks.map(b => b.id)).toEqual(['future'])
    expect(result.blocks[0]).toMatchObject({ before: { startsAt: '2027-06-14T10:00:00.000Z' }, after: { startsAt: '2027-06-14T10:15:00.000Z' } })
    expect(result.excluded).toEqual([
      { id: 'past', reason: 'past' }, { id: 'ongoing', reason: 'past' }, { id: 'fixed', reason: 'fixed' },
      { id: 'day2', reason: 'other_day' }, { id: 'undated', reason: 'undated' },
    ])
    expect(rows).toEqual(original)
  })

  it('selects an event by permanent identity and still excludes its second day', () => {
    const scope: ShiftScope = { kind: 'event', eventId: 'ceremony', date: day.date, timeZone: day.timeZone }
    const result = previewTimelineShift([
      block('ceremony-block', '2027-06-14T10:00:00Z', { programEventId: 'ceremony' }),
      block('banquet-block', '2027-06-14T11:00:00Z', { programEventId: 'banquet' }),
      block('legacy-block', '2027-06-14T12:00:00Z'),
      block('event-next-day', '2027-06-15T10:00:00Z', { programEventId: 'ceremony' }),
    ], scope, 15, now)
    expect(result.blocks.map(b => b.id)).toEqual(['ceremony-block'])
    expect(result.excluded).toEqual([{ id: 'banquet-block', reason: 'other_event' },
      { id: 'legacy-block', reason: 'other_event' }, { id: 'event-next-day', reason: 'other_day' }])
  })

  it('uses the scope timezone rather than UTC or the machine timezone', () => {
    const scope: ShiftScope = { kind: 'day', date: '2027-06-15', timeZone: 'Asia/Yekaterinburg' }
    const result = previewTimelineShift([block('local-midnight', '2027-06-14T19:05:00Z'), block('prior-local-day', '2027-06-14T18:00:00Z')], scope, 15, now)
    expect(result.blocks.map(b => b.id)).toEqual(['local-midnight'])
    expect(result.excluded).toEqual([{ id: 'prior-local-day', reason: 'other_day' }])
  })

  it('preserves seconds/milliseconds and fractional travel/buffer values', () => {
    const result = previewTimelineShift([block('precise', '2027-06-14T10:00:33.456Z', { travelMinutes: 1.25, bufferMinutes: 0.5 })], day, -15, now)
    expect(result.blocks[0]!.after).toEqual({ startsAt: '2027-06-14T09:45:33.456Z', endsAt: '2027-06-14T10:15:33.456Z' })
    expect(result.movements).toEqual([{ blockId: 'precise', location: null, travelMinutes: 1.25, bufferMinutes: 0.5,
      beforeArrival: '2027-06-14T10:00:33.456Z', afterArrival: '2027-06-14T09:45:33.456Z' }])
  })

  it('blocks a negative shift into the past without pretending the exclusion solved it', () => {
    const result = previewTimelineShift([block('soon', '2027-06-14T09:10:00Z')], day, -15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'shifted_into_past', blockIds: ['soon'] })
  })

  it('blocks crossing the selected local day boundary in either direction', () => {
    for (const [start, minutes] of [['2027-06-13T21:05:00Z', -15], ['2027-06-14T20:55:00Z', 15]] as const) {
      const result = previewTimelineShift([block('boundary', start)], day, minutes, new Date('2027-06-13T20:00:00Z'))
      expect(result.canConfirm).toBe(false)
      expect(result.conflicts).toContainEqual({ kind: 'crosses_day', blockIds: ['boundary'] })
    }
  })

  it('checks dependency order against a fixed downstream block', () => {
    const result = previewTimelineShift([block('first', '2027-06-14T10:00:00Z'),
      block('fixed-next', '2027-06-14T10:30:00Z', { fixed: true, dependsOn: ['first'] })], day, 15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'dependency_timing', blockIds: ['first', 'fixed-next'] })
    expect(result.affectedBlockIds).toEqual(['first', 'fixed-next'])
  })

  it('checks dependencies crossing the selected event scope and previous day', () => {
    const scope: ShiftScope = { kind: 'event', eventId: 'banquet', date: day.date, timeZone: day.timeZone }
    const result = previewTimelineShift([block('other-event', '2027-06-14T10:00:00Z', { programEventId: 'ceremony' }),
      block('banquet', '2027-06-14T10:30:00Z', { programEventId: 'banquet', dependsOn: ['other-event'] })], scope, -15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'dependency_timing', blockIds: ['other-event', 'banquet'] })
  })

  it('allows shifting a dependent chain together when its explicitly required gap remains sufficient', () => {
    const result = previewTimelineShift([block('first', '2027-06-14T10:00:00Z'),
      block('next', '2027-06-14T11:00:00Z', { dependsOn: ['first'], travelMinutes: 20, bufferMinutes: 10 })], day, 15, now)
    expect(result.canConfirm).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  it('requires resolution of insufficient explicit dependency travel/buffer, not an invented route ETA', () => {
    const result = previewTimelineShift([block('first', '2027-06-14T10:00:00Z', { fixed: true, location: 'Venue A' }),
      block('next', '2027-06-14T11:00:00Z', { location: 'Venue B', dependsOn: ['first'], travelMinutes: 20, bufferMinutes: 10 })], day, -15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'dependency_timing', blockIds: ['first', 'next'] })
    expect(result.movements[0]).toMatchObject({ location: 'Venue B', travelMinutes: 20, bufferMinutes: 10 })
  })

  it('detects overlapping responsible/participant assignments even when they occupy different roles', () => {
    const result = previewTimelineShift([block('first', '2027-06-14T10:00:00Z', { responsible: person }),
      block('fixed', '2027-06-14T10:30:00Z', { fixed: true, participants: [person] })], day, 15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'participant_overlap', blockIds: ['first', 'fixed'] })
    expect(result.affectedReferences).toEqual([person])
  })

  it('distinguishes a travel/buffer overlap from overlapping base blocks', () => {
    const result = previewTimelineShift([block('first', '2027-06-14T10:00:00Z', { responsible: person }),
      block('fixed', '2027-06-14T11:00:00Z', { fixed: true, participants: [person], travelMinutes: 20, bufferMinutes: 10 })], day, 15, now)
    expect(result.conflicts).toContainEqual({ kind: 'travel_buffer_overlap', blockIds: ['first', 'fixed'] })
    expect(result.conflicts.some(c => c.kind === 'participant_overlap')).toBe(false)
  })

  it('does not forbid unrelated parallel activities or count touching half-open intervals as overlap', () => {
    const unrelated = previewTimelineShift([block('first', '2027-06-14T10:00:00Z'),
      block('fixed', '2027-06-14T10:30:00Z', { fixed: true })], day, 15, now)
    expect(unrelated.canConfirm).toBe(true)
    const touching = previewTimelineShift([block('first', '2027-06-14T10:00:00Z', { responsible: person }),
      block('fixed', '2027-06-14T10:45:00Z', { fixed: true, responsible: person })], day, 15, now)
    expect(touching.canConfirm).toBe(true)
  })

  it('uses server-resolved resource identity to catch two deals of the same contractor', () => {
    const result = previewTimelineShift([block('photo', '2027-06-14T10:00:00Z', { resourceKeys: ['vendor:one'], responsible: { kind: 'deal', id: 'photo-deal' } }),
      block('video', '2027-06-14T10:30:00Z', { resourceKeys: ['vendor:one'], responsible: { kind: 'deal', id: 'video-deal' }, fixed: true })], day, 15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'participant_overlap', blockIds: ['photo', 'video'] })
    expect(result.affectedReferences).toEqual([{ kind: 'deal', id: 'photo-deal' }, { kind: 'deal', id: 'video-deal' }])
  })

  it('keeps an unknown end unknown and does not present it as conflict-free', () => {
    const result = previewTimelineShift([block('unknown', '2027-06-14T10:00:00Z', { durationMinutes: null, endsAt: null })], day, 15, now)
    expect(result.blocks[0]!.after.endsAt).toBeNull()
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'unknown_duration', blockIds: ['unknown'] })
  })

  it('does not silently accept dependency timing with an undated predecessor or a missing block', () => {
    for (const deps of [['undated'], ['missing']]) {
      const result = previewTimelineShift([block('undated', null), block('future', '2027-06-14T10:00:00Z', { dependsOn: deps })], day, 15, now)
      expect(result.canConfirm).toBe(false)
      expect(result.conflicts).toContainEqual({ kind: deps[0] === 'missing' ? 'missing_dependency' : 'unknown_dependency_time', blockIds: [deps[0], 'future'] })
    }
  })

  it('reports invalid historical intervals instead of correcting them', () => {
    const rows = [block('bad-history', '2027-06-14T10:00:00Z', { endsAt: '2027-06-14T09:00:00Z', durationMinutes: null })]
    const result = previewTimelineShift(rows, day, 15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.conflicts).toContainEqual({ kind: 'invalid_interval', blockIds: ['bad-history'] })
    expect(rows[0]!.endsAt).toBe('2027-06-14T09:00:00Z')
  })

  it('does not block an otherwise valid shift for pre-existing conflicts wholly outside the affected scope', () => {
    const result = previewTimelineShift([block('next-day-a', '2027-06-15T10:00:00Z', { responsible: person }),
      block('next-day-b', '2027-06-15T10:10:00Z', { responsible: person }), block('today', '2027-06-14T10:00:00Z')], day, 15, now)
    expect(result.canConfirm).toBe(true)
    expect(result.conflicts).toEqual([])
  })

  it('returns an explicit non-confirmable empty shift when all selected blocks are excluded', () => {
    const result = previewTimelineShift([block('fixed', '2027-06-14T10:00:00Z', { fixed: true })], day, 15, now)
    expect(result.canConfirm).toBe(false)
    expect(result.blocks).toEqual([])
    expect(result.affectedReferences).toEqual([])
  })

  it('re-evaluates eligibility as time advances between preview and confirmation', () => {
    const rows = [block('soon', '2027-06-14T09:10:00Z')]
    expect(previewTimelineShift(rows, day, 15, now).canConfirm).toBe(true)
    const later = previewTimelineShift(rows, day, 15, new Date('2027-06-14T09:11:00Z'))
    expect(later.canConfirm).toBe(false)
    expect(later.excluded).toEqual([{ id: 'soon', reason: 'past' }])
  })

  it('rejects invalid dates/timezones/minutes and duplicate block IDs', () => {
    for (const scope of [{ ...day, date: '2027-02-30' }, { ...day, date: '0000-06-14' }, { ...day, timeZone: 'Unknown/Zone' }]) {
      expect(() => previewTimelineShift([], scope, 15, now)).toThrow()
    }
    for (const minutes of [0, 241, -241, 0.5, NaN, Infinity]) expect(() => previewTimelineShift([], day, minutes, now)).toThrow()
    const row = block('same', '2027-06-14T10:00:00Z')
    expect(() => previewTimelineShift([row, row], day, 15, now)).toThrow()
  })
})
