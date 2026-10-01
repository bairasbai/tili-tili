import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'

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
