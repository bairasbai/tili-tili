import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

export async function seedUpcomingShiftTimeline(app: FastifyInstance, weddingId: string, preserveFirst = false) {
  // A future local noon keeps positive shifts inside one day. When a case
  // includes a past block, keep both moments on the same day to exercise 'past'.
  if (preserveFirst) {
    await app.db!.query(`update weddings set tz=case when extract(hour from clock_timestamp() at time zone 'UTC') between 3 and 18
      then 'UTC' else 'Pacific/Honolulu' end where id=$1`, [weddingId])
  }
  const updated = await app.db!.query(`with moment as materialized (
    select case when $2::boolean then clock_timestamp()+interval '2 hours'
      else ((date_trunc('day', clock_timestamp() at time zone w.tz) + interval '1 day 12 hours') at time zone w.tz) end as at
    from weddings w where w.id=$1
  ) update timeline_events t set starts_at=moment.at,ends_at=moment.at+interval '1 hour',duration_minutes=60
    from moment where t.wedding_id=$1
      and (not $2::boolean or t.sort>(select min(sort) from timeline_events where wedding_id=$1))`, [weddingId, preserveFirst])
  assert(updated.rowCount !== null && updated.rowCount > 0, 'Owned future fixture must include timeline blocks')
}

export async function prepareShift(app: FastifyInstance, weddingId: string, headers: Record<string, string>, minutes: number) {
  const wedding = await app.inject({ method: 'GET', url: `/weddings/${weddingId}`, headers })
  assert.equal(wedding.statusCode, 200, wedding.body)
  const timeline = await app.inject({ method: 'GET', url: `/weddings/${weddingId}/timeline`, headers })
  assert.equal(timeline.statusCode, 200, timeline.body)
  const upcoming = (timeline.json() as { startsAt: string | null; fixed: boolean }[])
    .find(e => e.startsAt && Date.parse(e.startsAt) > Date.now() && !e.fixed)
  const context = wedding.json() as { tz: string; date: string }
  let date = context.date
  if (upcoming?.startsAt) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: context.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(upcoming.startsAt))
    const field = (type: string) => parts.find(p => p.type === type)!.value
    date = `${field('year')}-${field('month')}-${field('day')}`
  }
  const preview = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/timeline/shift/preview`, headers, payload: { scope: { kind: 'day', date }, minutes } })
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal(preview.json().canConfirm, true, preview.body)
  return { headers: { ...headers, 'if-match': preview.headers.etag!, 'idempotency-key': headers['idempotency-key'] ?? randomUUID() }, payload: { previewToken: preview.json().previewToken as string } }
}
