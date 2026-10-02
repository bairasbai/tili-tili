import { randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import type { Queryable } from '../src/plugins/db.js'
import { rsvpWindow } from '../src/wedding/rsvp-events.js'

const DB = process.env.TEST_DATABASE_URL, SECRET = 'a'.repeat(48), POLICY = '2026-09-02'
const APPLICATION = 'event_rsvp_012_' + randomUUID()

/* ───────────────────────── rsvpWindow: чистая функция, без базы ───────────────────────── */

describe('T012 rsvpWindow: срок без обращения к базе', () => {
  it('нет срока -> none, независимо от момента', () => {
    expect(rsvpWindow(null, null, new Date())).toEqual({ state: 'none', date: null, timeZone: null, closesAt: null })
    expect(rsvpWindow(null, 'Europe/Moscow', new Date('2099-01-01T00:00:00Z'))).toEqual({ state: 'none', date: null, timeZone: null, closesAt: null })
  })
  it('Москва (UTC+3, без перехода): граница — до/ровно/после полуночи следующих суток', () => {
    const w = rsvpWindow('2027-06-20', 'Europe/Moscow', new Date('2027-06-20T20:59:59.999Z'))
    expect(w).toMatchObject({ state: 'open', date: '2027-06-20', timeZone: 'Europe/Moscow', closesAt: '2027-06-20T21:00:00.000Z' })
    expect(rsvpWindow('2027-06-20', 'Europe/Moscow', new Date('2027-06-20T21:00:00.000Z')).state).toBe('closed')
    expect(rsvpWindow('2027-06-20', 'Europe/Moscow', new Date('2027-06-20T21:00:00.001Z')).state).toBe('closed')
  })
  it('смещённая зона Asia/Kathmandu (+05:45, без перехода на лето)', () => {
    const w = rsvpWindow('2027-06-20', 'Asia/Kathmandu', new Date('2027-06-20T18:14:59.999Z'))
    expect(w).toMatchObject({ state: 'open', closesAt: '2027-06-20T18:15:00.000Z' })
    expect(rsvpWindow('2027-06-20', 'Asia/Kathmandu', new Date('2027-06-20T18:15:00.000Z')).state).toBe('closed')
  })
  it('Europe/London вокруг перехода на зимнее время: закрытие — ровно местная полночь следующих суток', () => {
    // Последнее воскресенье октября 2027 — переход BST->GMT; сами сутки D длиннее на час,
    // но закрытие (местная полночь D+1) должно остаться местной полночью, а не съехать
    // на час из-за наивной арифметики +24ч.
    const lastSunday = new Date(Date.UTC(2027, 10, 0))
    lastSunday.setUTCDate(lastSunday.getUTCDate() - lastSunday.getUTCDay())
    const deadline = lastSunday.toISOString().slice(0, 10)
    const w = rsvpWindow(deadline, 'Europe/London', new Date(`${deadline}T12:00:00.000Z`))
    expect(w.state).toBe('open')
    const closesAt = new Date(w.closesAt!)
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(closesAt)
    const get = (t: string) => parts.find(p => p.type === t)!.value
    expect(`${get('hour')}:${get('minute')}`).toMatch(/^(00:00|24:00)$/)
    expect(Number(get('day'))).toBe(lastSunday.getUTCDate() + 1 === 32 ? 1 : lastSunday.getUTCDate() + 1)
    expect(rsvpWindow(deadline, 'Europe/London', new Date(closesAt.getTime() - 1)).state).toBe('open')
    expect(rsvpWindow(deadline, 'Europe/London', closesAt).state).toBe('closed')
  })
  it('America/Santiago: переход на зимнее время РОВНО в местную полночь (P3-7, однопроходная поправка съезжала на час)', () => {
    // Чили переводит часы назад РОВНО в местную полночь 2027-04-04: 00:00 (-03)
    // становится 23:00 (-04) того же календарного дня по UTC-времени.
    // `fromLocal` ищет именно местную полночь 2027-04-04 (закрытие срока с
    // датой 2027-04-03) — сам запрашиваемый момент совпадает с переходом.
    // Однопроходная поправка брала смещение ДО перехода (-03) и приземлялась
    // на 2027-04-04T03:00:00Z — на час раньше правильного 04:00:00Z (-04,
    // уже после перехода). Числа независимо проверены скриптом поверх
    // исправленной fromLocal/offsetMinutes этой же сессии.
    const w = rsvpWindow('2027-04-03', 'America/Santiago', new Date('2027-04-04T04:00:00.000Z'))
    expect(w).toMatchObject({ state: 'closed', closesAt: '2027-04-04T04:00:00.000Z' })
    expect(rsvpWindow('2027-04-03', 'America/Santiago', new Date('2027-04-04T03:59:59.999Z')).state).toBe('open')
    expect(rsvpWindow('2027-04-03', 'America/Santiago', new Date('2027-04-04T04:00:00.000Z')).state).toBe('closed')
  })
})

/* ───────────────────────── HTTP/DB: реальный PostgreSQL ───────────────────────── */

describe.skipIf(!DB)('T012 дополнительные мероприятия: срок, ответы, просьбы, правки — на реальном PostgreSQL', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    const target = new URL(DB!); target.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: target.href, redisUrl: null,
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => app?.close())

  async function setup(suffix = '') {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',
      [userId, '+79' + randomInt(100000000, 999999999), 'T012 couple' + suffix])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId, userId, POLICY])
    await app.db!.query(`insert into weddings(id,owner_id,title,date,tz,budget_total,invite_code)
      values($1,$2,'T012 wedding','2027-06-20','Europe/Moscow',100000000,$3)`, [weddingId, userId, randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    const headers = { authorization: 'Bearer ' + await signAccessToken(SECRET, { sub: userId, sid: sessionId }) }
    const base = `/weddings/${weddingId}`

    const famA = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Family A' + suffix, plusOne: true } })
    expect(famA.statusCode, famA.body).toBe(201)
    const aIds = (await app.db!.query<{ id: string }>('select id from guests where party_id=$1 order by party_position', [famA.json().partyId])).rows.map((g) => g.id)
    const famB = await app.inject({ method: 'POST', url: base + '/guests', headers, payload: { name: 'Family B' + suffix } })
    expect(famB.statusCode, famB.body).toBe(201)
    const bId = famB.json().id as string
    const tokenA = (await app.db!.query<{ invite_token: string }>('select invite_token from guest_parties where id=$1', [famA.json().partyId])).rows[0]!.invite_token
    const tokenB = (await app.db!.query<{ invite_token: string }>('select invite_token from guest_parties where id=$1', [famB.json().partyId])).rows[0]!.invite_token
    const main = (await app.inject({ method: 'GET', url: base + '/events', headers })).json()[0].id as string

    async function addEvent(name: string, zone: string, date: string) {
      const current = await app.inject({ method: 'GET', url: base + '/events', headers })
      const created = await app.inject({ method: 'POST', url: base + '/events',
        headers: { ...headers, 'if-match': String(current.headers.etag) },
        payload: { name, kind: 'other', date, timeZone: zone, location: 'Hall' } })
      expect(created.statusCode, created.body).toBe(201)
      return created.json().id as string
    }
    async function invite(eventId: string, guestIds: string[]) {
      const current = await app.inject({ method: 'GET', url: `${base}/events/${eventId}/invitations`, headers })
      const res = await app.inject({ method: 'PUT', url: `${base}/events/${eventId}/invitations`,
        headers: { ...headers, 'if-match': String(current.headers.etag) }, payload: { guestIds } })
      expect(res.statusCode, res.body).toBe(200)
    }
    const e1 = await addEvent('Mehndi' + suffix, 'Europe/Moscow', '2027-06-19')
    const e2 = await addEvent('Reception' + suffix, 'Europe/London', '2027-06-21')
    await invite(e1, [aIds[0]!, aIds[1]!, bId])
    await invite(e2, [aIds[0]!])

    return { userId, sessionId, weddingId, consentId, headers, base, main, e1, e2, aIds, bId, tokenA, tokenB }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>

  async function setDeadline(w: Fixture, eventId: string, rsvpDeadline: string | null, extra: Record<string, unknown> = {}) {
    const current = await app.inject({ method: 'GET', url: w.base + '/events', headers: w.headers })
    return app.inject({ method: 'PATCH', url: `${w.base}/events/${eventId}`,
      headers: { ...w.headers, 'if-match': String(current.headers.etag) }, payload: { rsvpDeadline, ...extra } })
  }
  const guestEvents = (token: string) => app.inject({ method: 'GET', url: `/rsvp/${encodeURIComponent(token)}/events` })
  const answers = (token: string, eventId: string, items: { guestId: string; status: string; expectedVersion: string }[]) =>
    app.inject({ method: 'PUT', url: `/rsvp/${encodeURIComponent(token)}/events/${eventId}/answers`, payload: { answers: items } })
  const lateRequest = (token: string, eventId: string, body: Record<string, unknown>, key = randomUUID()) =>
    app.inject({ method: 'POST', url: `/rsvp/${encodeURIComponent(token)}/events/${eventId}/requests`, headers: { 'idempotency-key': key }, payload: body })
  const roster = (w: Fixture, eventId: string) => app.inject({ method: 'GET', url: `${w.base}/events/${eventId}/rsvp`, headers: w.headers })
  const correct = (w: Fixture, eventId: string, guestId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: `${w.base}/events/${eventId}/rsvp/${guestId}`, headers: w.headers, payload: body })
  const decide = (w: Fixture, eventId: string, requestId: string, body: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `${w.base}/events/${eventId}/rsvp-requests/${requestId}/decision`, headers: w.headers, payload: body })
  async function setInvitations(w: Fixture, eventId: string, guestIds: string[]) {
    const current = await app.inject({ method: 'GET', url: `${w.base}/events/${eventId}/invitations`, headers: w.headers })
    return app.inject({ method: 'PUT', url: `${w.base}/events/${eventId}/invitations`,
      headers: { ...w.headers, 'if-match': String(current.headers.etag) }, payload: { guestIds } })
  }
  async function deleteEvent(w: Fixture, eventId: string) {
    const current = await app.inject({ method: 'GET', url: w.base + '/events', headers: w.headers })
    return app.inject({ method: 'DELETE', url: `${w.base}/events/${eventId}`, headers: { ...w.headers, 'if-match': String(current.headers.etag) } })
  }
  const deleteGuest = (w: Fixture, guestId: string) => app.inject({ method: 'DELETE', url: `${w.base}/guests/${guestId}`, headers: w.headers })
  const legacyRsvp = (token: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/rsvp/${encodeURIComponent(token)}`, payload: body })

  /* ── видимость: разные ростеры, чужие семьи, основное мероприятие не затронуто ── */

  it('2 доп. мероприятия с разными ростерами; гость видит только свои события и своих персон', async () => {
    const w = await setup('V')
    const evA = await guestEvents(w.tokenA)
    expect(evA.statusCode, evA.body).toBe(200)
    const idsA = evA.json().events.map((e: { event: { id: string } }) => e.event.id)
    expect(new Set(idsA)).toEqual(new Set([w.e1, w.e2]))
    expect(idsA).not.toContain(w.main)
    const e1ForA = evA.json().events.find((e: { event: { id: string } }) => e.event.id === w.e1)
    expect(e1ForA.people.map((p: { guestId: string }) => p.guestId).sort()).toEqual([...w.aIds].sort())
    expect(e1ForA.people.every((p: { status: string; source: string | null; version: string }) => p.status === 'unknown' && p.source === null && p.version === '0')).toBe(true)

    const evB = await guestEvents(w.tokenB)
    const idsB = evB.json().events.map((e: { event: { id: string } }) => e.event.id)
    expect(idsB).toEqual([w.e1]) // family B is not invited to e2
    expect(evB.body).not.toContain('Family A')

    const rosterE1 = await roster(w, w.e1)
    expect(rosterE1.statusCode, rosterE1.body).toBe(200)
    expect(rosterE1.json().people).toHaveLength(3)
    const rosterE2 = await roster(w, w.e2)
    expect(rosterE2.json().people).toHaveLength(1)
  })

  it('чужая свадьба/персона/событие — 404 (P2-3: никогда 401 на валидный токен; без утечки чужих данных)', async () => {
    const w = await setup('X'), other = await setup('Y')
    // guest token from a foreign family, event from that foreign wedding too -> 404 (not 401: the
    // token IS valid, just for a different wedding than the eventId belongs to)
    const foreignTokenForeignEvent = await answers(other.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '0' }])
    expect(foreignTokenForeignEvent.statusCode, foreignTokenForeignEvent.body).toBe(404)
    expect(foreignTokenForeignEvent.body).not.toContain('Family A') // no leak of the other wedding's guest name
    // P2-3: own token, own event, but a guestId belonging to an entirely different wedding in the
    // payload -> 404 (previously rejectForeignGuests answered 401 here, an existence oracle; OpenAPI says 404)
    const ownTokenForeignGuest = await answers(w.tokenA, w.e1, [{ guestId: other.aIds[0], status: 'attending', expectedVersion: '0' }])
    expect(ownTokenForeignGuest.statusCode, ownTokenForeignGuest.body).toBe(404)
    expect(ownTokenForeignGuest.body).not.toContain('Family A' + 'Y') // no leak of other's guest name
    // own token, event from another wedding -> 404
    expect((await answers(w.tokenA, other.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '0' }])).statusCode).toBe(404)
    // own token, a real person who is not invited to e2 (only aIds[0] is) -> 404
    expect((await answers(w.tokenA, w.e2, [{ guestId: w.aIds[1], status: 'attending', expectedVersion: '0' }])).statusCode).toBe(404)
    // couple of w probing another wedding's event/guest -> 404
    expect((await roster(w, other.e1)).statusCode).toBe(404)
    expect((await correct(w, w.e1, other.aIds[0], { status: 'attending', expectedVersion: '0' })).statusCode).toBe(404)
    expect((await decide(w, w.e1, randomUUID(), { decision: 'accept', expectedVersion: '1' })).statusCode).toBe(404)
    // main event is never addressable through T012 paths
    expect((await roster(w, w.main)).statusCode).toBe(404)
    expect((await correct(w, w.main, w.aIds[0], { status: 'attending', expectedVersion: '0' })).statusCode).toBe(404)
  })

  for (const role of ['helper', 'coordinator']) {
    it(`${role} reads the roster but cannot correct or decide (403)`, async () => {
      const w = await setup('R' + role)
      await app.db!.query("update wedding_members set role=$3 where wedding_id=$1 and user_id=$2", [w.weddingId, w.userId, role])
      expect((await roster(w, w.e1)).statusCode).toBe(200)
      expect((await correct(w, w.e1, w.aIds[0], { status: 'attending', expectedVersion: '0' })).statusCode).toBe(403)
      expect((await decide(w, w.e1, randomUUID(), { decision: 'accept', expectedVersion: '1' })).statusCode).toBe(403)
    })
  }

  /* ── PATCH событие: валидация rsvpDeadline ── */

  it('PATCH rsvpDeadline: 422 на основном мероприятии, без известного пояса, и позже даты мероприятия', async () => {
    const w = await setup('P')
    const onMain = await setDeadline(w, w.main, '2027-06-10')
    expect(onMain.statusCode, onMain.body).toBe(422)
    const noZone = await setDeadline(w, w.e1, '2027-06-10', { timeZone: null })
    expect(noZone.statusCode, noZone.body).toBe(422)
    const afterDate = await setDeadline(w, w.e1, '2027-06-20') // event date is 2027-06-19
    expect(afterDate.statusCode, afterDate.body).toBe(422)
    const ok = await setDeadline(w, w.e1, '2027-06-10')
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().rsvpDeadline).toBe('2027-06-10')
    const cleared = await setDeadline(w, w.e1, null)
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json().rsvpDeadline).toBeNull()
    // clearing the zone while a deadline would remain is refused at the DB CHECK, surfaced as 422
    await setDeadline(w, w.e1, '2027-06-10')
    const clearZone = await setDeadline(w, w.e1, undefined as unknown as string, { timeZone: null })
    expect(clearZone.statusCode, clearZone.body).toBe(422)
  })

  /* ── ответы гостя: пачка, no-op, версии, срок ── */

  it('batch answers: atomic rollback on one bad item, no-op keeps version, version conflict', async () => {
    const w = await setup('A')
    const bad = await answers(w.tokenA, w.e1, [
      { guestId: w.aIds[0], status: 'attending', expectedVersion: '0' },
      { guestId: w.bId, status: 'attending', expectedVersion: '0' }, // not from this family
    ])
    expect(bad.statusCode, bad.body).toBe(404)
    expect((await roster(w, w.e1)).json().people.every((p: { version: string }) => p.version === '0')).toBe(true)

    // P2-5a: the case above fails in the upfront validation loop, BEFORE any
    // write runs at all — it proves nothing about an actual transactional
    // rollback. Here item 1 is valid and genuinely gets written first; item 2
    // is invited (passes validation) but carries a stale version, so it fails
    // in the SECOND loop — the one that writes — after item 1 already wrote.
    // Only a real `ROLLBACK` can undo that.
    const partial = await answers(w.tokenA, w.e1, [
      { guestId: w.aIds[0], status: 'attending', expectedVersion: '0' },
      { guestId: w.aIds[1], status: 'declined', expectedVersion: '99' }, // invited, but wrong version
    ])
    expect(partial.statusCode, partial.body).toBe(409)
    expect(partial.json().error.code).toBe('version_conflict')
    expect((await roster(w, w.e1)).json().people.find((p: { guestId: string }) => p.guestId === w.aIds[0]).version).toBe('0')

    const ok = await answers(w.tokenA, w.e1, [
      { guestId: w.aIds[0], status: 'attending', expectedVersion: '0' },
      { guestId: w.aIds[1], status: 'declined', expectedVersion: '0' },
    ])
    expect(ok.statusCode, ok.body).toBe(200)
    const person0 = ok.json().people.find((p: { guestId: string }) => p.guestId === w.aIds[0])
    expect(person0).toMatchObject({ status: 'attending', source: 'guest_response', version: '1' })

    const noop = await answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '1' }])
    expect(noop.json().people.find((p: { guestId: string }) => p.guestId === w.aIds[0]).version).toBe('1')

    const stale = await answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'declined', expectedVersion: '0' }])
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('version_conflict')
  })

  it('answers refuse once the deadline has passed; late request is refused while it is still open', async () => {
    const w = await setup('D')
    await setDeadline(w, w.e1, '2020-01-01') // safely in the past under any real clock
    const res = await answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '0' }])
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('rsvp_deadline_passed')

    const open = await setup('O')
    await setDeadline(open, open.e1, '2099-01-01') // safely in the future
    const early = await lateRequest(open.tokenA, open.e1, { guestId: open.aIds[0], requestedStatus: 'attending' })
    expect(early.statusCode, early.body).toBe(409)
    expect(early.json().error.code).toBe('rsvp_deadline_open')
  })

  it('late request: created after the deadline, notifies the couple, duplicate pending is refused, idempotency replay returns the same 201', async () => {
    const w = await setup('L')
    await setDeadline(w, w.e1, '2020-01-01')
    const key = randomUUID()
    const first = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending', comment: 'please' }, key)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json()).toMatchObject({ guestId: w.aIds[0], requestedStatus: 'attending', state: 'pending', comment: 'please' })

    const notice = await app.db!.query<{ kind: string }>("select kind from notifications where user_id=$1 and kind='guest' order by id desc limit 1", [w.userId])
    expect(notice.rows[0]?.kind).toBe('guest')

    const dup = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'declined' })
    expect(dup.statusCode, dup.body).toBe(409)
    expect(dup.json().error.code).toBe('rsvp_request_pending')

    const replay = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending', comment: 'please' }, key)
    expect(replay.statusCode, replay.body).toBe(201)
    expect(replay.json().id).toBe(first.json().id)

    const reused = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'declined' }, key)
    expect(reused.statusCode, reused.body).toBe(409)
    expect(reused.json().error.code).toBe('idempotency_key_reused')
  })

  /* ── правка парой и решения по просьбе ── */

  it('organizer correction writes source=organizer_correction, is a no-op when identical, works even while the deadline is open, 409 on stale version', async () => {
    const w = await setup('C')
    const first = await correct(w, w.e1, w.aIds[0], { status: 'attending', expectedVersion: '0' })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ status: 'attending', source: 'organizer_correction', version: '1' })
    const noop = await correct(w, w.e1, w.aIds[0], { status: 'attending', expectedVersion: '1' })
    expect(noop.json().version).toBe('1')
    const stale = await correct(w, w.e1, w.aIds[0], { status: 'declined', expectedVersion: '0' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('version_conflict')
    const notInvited = await correct(w, w.e2, w.bId, { status: 'attending', expectedVersion: '0' })
    expect(notInvited.statusCode).toBe(404)
  })

  it('accept applies requestedStatus with source=organizer_correction in the same transaction; reject only changes request state', async () => {
    const w = await setup('AD')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    const accepted = await decide(w, w.e1, req.json().id, { decision: 'accept', expectedVersion: '1' })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().request).toMatchObject({ state: 'accepted' })
    expect(accepted.json().person).toMatchObject({ status: 'attending', source: 'organizer_correction' })

    const req2 = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[1], requestedStatus: 'declined' })
    const before = await roster(w, w.e1)
    const rejected = await decide(w, w.e1, req2.json().id, { decision: 'reject', note: 'not possible', expectedVersion: '1' })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json().request).toMatchObject({ state: 'rejected', decisionNote: 'not possible' })
    expect(rejected.json().person.status).toBe(before.json().people.find((p: { guestId: string }) => p.guestId === w.aIds[1]).status)

    const again = await decide(w, w.e1, req.json().id, { decision: 'reject', expectedVersion: '2' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('rsvp_request_decided')

    // Contract: decision endpoint also answers 409 version_conflict — a distinct
    // code from the shared `orders` domain's order_version_conflict.
    const req3 = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[1], requestedStatus: 'attending' })
    const staleDecision = await decide(w, w.e1, req3.json().id, { decision: 'accept', expectedVersion: '99' })
    expect(staleDecision.statusCode).toBe(409)
    expect(staleDecision.json().error.code).toBe('version_conflict')
  })

  it('isolation: main RSVP and bus/hotel/table/menu/main-event participation are unaffected by additional-event answers', async () => {
    const w = await setup('ISO')
    const legacy = await app.inject({ method: 'POST', url: `/rsvp/${w.tokenA}`, payload: { status: 'yes' } })
    expect(legacy.statusCode, legacy.body).toBe(200)

    // P2-5f: a field that is null/zero before AND after proves nothing —
    // give table/menu/hotel a real, non-trivial "before" state first.
    const table = randomUUID(), menuOption = randomUUID(), hotel = randomUUID()
    await app.db!.query('insert into tables(id,wedding_id,name) values($1,$2,$3)', [table, w.weddingId, 'Table 1'])
    await app.db!.query('insert into menu_options(id,wedding_id,name) values($1,$2,$3)', [menuOption, w.weddingId, 'Fish'])
    await app.db!.query('insert into hotel_blocks(id,wedding_id,name,rooms) values($1,$2,$3,5)', [hotel, w.weddingId, 'Hotel'])
    await app.db!.query('update guests set table_id=$2,menu_option_id=$3 where id=$1', [w.aIds[0], table, menuOption])
    await app.db!.query('insert into hotel_bookings(hotel_id,guest_id) values($1,$2)', [hotel, w.aIds[0]])

    const before = (await app.db!.query('select rsvp,plus_one,table_id,menu_option_id from guests where id=$1', [w.aIds[0]])).rows[0]
    const busBefore = (await app.db!.query('select count(*)::int n from bus_bookings where guest_id=$1', [w.aIds[0]])).rows[0]!.n
    const hotelBefore = (await app.db!.query('select count(*)::int n from hotel_bookings where guest_id=$1', [w.aIds[0]])).rows[0]!.n
    const mainBefore = (await app.db!.query('select status,source,version::text from event_guest_participation where program_event_id=$1 and guest_id=$2', [w.main, w.aIds[0]])).rows[0]
    // sanity: the legacy RSVP did write a real row — source is 'guest_response' (the
    // guest token actually answered); 'legacy_main_rsvp' is only the virtual default
    // `loadEventParticipation` reports when NO row exists yet at all.
    expect(mainBefore).toMatchObject({ status: 'attending', source: 'guest_response' })

    await answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'declined', expectedVersion: '0' }])
    await correct(w, w.e2, w.aIds[0], { status: 'attending', expectedVersion: '0' })

    const after = (await app.db!.query('select rsvp,plus_one,table_id,menu_option_id from guests where id=$1', [w.aIds[0]])).rows[0]
    expect(after).toEqual(before)
    const busAfter = (await app.db!.query('select count(*)::int n from bus_bookings where guest_id=$1', [w.aIds[0]])).rows[0]!.n
    expect(busAfter).toBe(busBefore)
    const hotelAfter = (await app.db!.query('select count(*)::int n from hotel_bookings where guest_id=$1', [w.aIds[0]])).rows[0]!.n
    expect(hotelAfter).toBe(hotelBefore)
    const mainAfter = (await app.db!.query('select status,source,version::text from event_guest_participation where program_event_id=$1 and guest_id=$2', [w.main, w.aIds[0]])).rows[0]
    expect(mainAfter).toEqual(mainBefore)
  })

  /* ── pg_blocking_pids: действительное ожидание замка, а не удачное чередование ── */

  async function waitBlockedBy(client: Queryable, blocker: number, done?: () => boolean): Promise<number> {
    const until = Date.now() + 12000
    while (Date.now() < until) {
      await client.query('select pg_stat_clear_snapshot()')
      const r = await client.query<{ pid: number }>(
        `select pid from pg_stat_activity where datname=current_database() and application_name=$2
           and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid)) limit 1`,
        [blocker, APPLICATION],
      )
      if (r.rows[0]) return r.rows[0].pid
      if (done?.()) throw new Error('HTTP settled before an actual SQL lock wait was observed')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('Actual SQL waiter not observed')
  }
  /** P2-5e: `waiter` is blocked EXACTLY by `expectedBlocker` — not also directly by the holder. */
  async function assertBlockedOnlyBy(client: Queryable, waiter: number, expectedBlocker: number): Promise<void> {
    const { rows } = await client.query<{ blockers: number[] }>('select pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1', [waiter])
    expect(rows[0]?.blockers).toEqual([expectedBlocker])
  }

  /* ── гонки: действительное ожидание DB-замка свадьбы, а не удачное чередование (P2-5b) ── */

  it('race: two concurrent batch answers on the same version — exactly one succeeds (real lock wait)', async () => {
    const w = await setup('RACE1')
    let aPending: ReturnType<typeof answers> | undefined, bPending: ReturnType<typeof answers> | undefined, aDone = false
    await app.db!.tx(async (client) => {
      const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('select id from weddings where id=$1 for update', [w.weddingId])
      aPending = answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '0' }])
      void aPending.then(() => { aDone = true })
      const waiter1Pid = await waitBlockedBy(client, holderPid, () => aDone)
      bPending = answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'declined', expectedVersion: '0' }])
      const waiter2Pid = await waitBlockedBy(client, waiter1Pid)
      await assertBlockedOnlyBy(client, waiter2Pid, waiter1Pid) // queued behind the FIRST waiter, not the holder
    })
    const [a, b] = await Promise.all([aPending!, bPending!])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect((await app.db!.query('select count(*)::text n from event_guest_participation where guest_id=$1 and program_event_id=$2', [w.aIds[0], w.e1])).rows[0]!.n).toBe('1')
  })

  it('race: two concurrent late requests for the same person/event — exactly one 201 (real lock wait)', async () => {
    const w = await setup('RACE2')
    await setDeadline(w, w.e1, '2020-01-01')
    let aPending: ReturnType<typeof lateRequest> | undefined, bPending: ReturnType<typeof lateRequest> | undefined, aDone = false
    await app.db!.tx(async (client) => {
      const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('select id from weddings where id=$1 for update', [w.weddingId])
      aPending = lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
      void aPending.then(() => { aDone = true })
      const waiter1Pid = await waitBlockedBy(client, holderPid, () => aDone)
      bPending = lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'declined' })
      const waiter2Pid = await waitBlockedBy(client, waiter1Pid)
      await assertBlockedOnlyBy(client, waiter2Pid, waiter1Pid)
    })
    const [a, b] = await Promise.all([aPending!, bPending!])
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409])
  })

  /**
   * P2-5c: `2020-01-01` is closed in EVERY zone — switching the zone there
   * proves nothing about the zone switch itself actually taking effect.
   * Two real, fixed-offset (no DST, so no transition-day flakiness) IANA
   * zones 26h apart: for the SAME deadline DATE, the far-east zone's local
   * midnight(D+1) lands 26h before the far-west zone's — so there is always
   * a `date` where, right now, one zone already closed the window and the
   * other has not. Computed from the actual clock at test time (via the
   * real `rsvpWindow`), not a hardcoded calendar date, so it never rots.
   */
  function pickZoneFlip(): { date: string; closedZone: string } {
    const east = 'Pacific/Kiritimati' // UTC+14
    const west = 'Etc/GMT+12' // UTC-12 (Etc/GMT sign is POSIX-inverted)
    const now = new Date()
    for (let offsetDays = -1; offsetDays <= 2; offsetDays++) {
      const date = new Date(now.getTime() + offsetDays * 86_400_000).toISOString().slice(0, 10)
      if (rsvpWindow(date, east, now).state === 'closed' && rsvpWindow(date, west, now).state === 'open') return { date, closedZone: east }
    }
    throw new Error('P2-5c: no date found where the zone switch flips open/closed right now')
  }

  const revocations = [
    {
      name: 'приглашение снято',
      code: 404,
      sql: (_w: Fixture) => 'delete from guest_event_invitations where wedding_id=$1 and event_id=$2 and guest_id=$3',
      args: (w: Fixture) => [w.weddingId, w.e1, w.aIds[0]],
    },
    {
      name: 'срок перенесён и зона сменилась в ту же операцию: именно смена пояса закрывает окно прямо сейчас',
      code: 409,
      sql: (_w: Fixture) => 'update wedding_events set time_zone=$2,rsvp_deadline=$3 where wedding_id=$1 and id=$4',
      args: (w: Fixture) => { const flip = pickZoneFlip(); return [w.weddingId, flip.closedZone, flip.date, w.e1] },
    },
    {
      name: 'токен семьи перевыпущен',
      code: 401,
      sql: (_w: Fixture) => 'update guest_parties set invite_token=$2 where wedding_id=$1 and invite_token=$3',
      args: (w: Fixture) => [w.weddingId, randomUUID(), w.tokenA],
    },
    {
      name: 'гость удалён',
      code: 404,
      sql: (_w: Fixture) => 'delete from guests where id=$1',
      args: (w: Fixture) => [w.aIds[0]],
    },
  ]
  for (const change of revocations) {
    it(`batch answer refuses "${change.name}" committed during a real wedding-lock wait, without a partial write`, async () => {
      const w = await setup('WAIT' + revocations.indexOf(change))
      let pending: ReturnType<typeof answers> | undefined, done = false
      try {
        await app.db!.tx(async (client) => {
          const pid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
          await client.query('select id from weddings where id=$1 for update', [w.weddingId])
          pending = answers(w.tokenA, w.e1, [{ guestId: w.aIds[0], status: 'attending', expectedVersion: '0' }])
          void pending.then(() => { done = true })
          await waitBlockedBy(client, pid, () => done)
          await client.query(change.sql(w), change.args(w))
        })
      } finally { if (pending) await pending }
      const res = await pending!
      expect(res.statusCode, res.body).toBe(change.code)
      expect((await app.db!.query('select count(*)::text n from event_guest_participation where program_event_id=$1', [w.e1])).rows[0]!.n).toBe('0')
    })
  }

  it('two decisions on the same pending request: the second waiter queues behind the first, not behind the holder', async () => {
    const w = await setup('WAIT2')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    let acceptPending: ReturnType<typeof decide> | undefined, rejectPending: ReturnType<typeof decide> | undefined
    let acceptDone = false
    await app.db!.tx(async (client) => {
      const holderPid = (await client.query<{ pid: number }>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('select id from event_rsvp_requests where id=$1 for update', [req.json().id])
      acceptPending = decide(w, w.e1, req.json().id, { decision: 'accept', expectedVersion: '1' })
      void acceptPending.then(() => { acceptDone = true })
      const waiter1Pid = await waitBlockedBy(client, holderPid, () => acceptDone)
      rejectPending = decide(w, w.e1, req.json().id, { decision: 'reject', expectedVersion: '1' })
      const waiter2Pid = await waitBlockedBy(client, waiter1Pid)
      // P2-5e: `waitBlockedBy(client, waiter1Pid)` only ever returns a pid whose
      // blockers already include waiter1Pid, so `!== holderPid` held by
      // construction of the query — it proved nothing. Check the waiter's FULL
      // blocker list instead: it must be EXACTLY [waiter1Pid], not also holderPid.
      await assertBlockedOnlyBy(client, waiter2Pid, waiter1Pid)
    })
    const [acceptRes, rejectRes] = await Promise.all([acceptPending!, rejectPending!])
    expect([acceptRes.statusCode, rejectRes.statusCode].sort()).toEqual([200, 409])
  })

  /* ── P1-1: каскадное удаление с просьбой больше не 500 ── */

  it('P1-1: deleting a guest with an event_rsvp_request cascades cleanly (previously 500)', async () => {
    const w = await setup('DELGUEST')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[1], requestedStatus: 'attending' })
    expect(req.statusCode, req.body).toBe(201)
    const res = await deleteGuest(w, w.aIds[1])
    expect(res.statusCode, res.body).toBe(204)
    expect((await app.db!.query('select 1 from event_rsvp_requests where id=$1', [req.json().id])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from guests where id=$1', [w.aIds[1]])).rowCount).toBe(0)
  })

  it('P1-1: deleting the last member of a family with an event_rsvp_request cascades cleanly (previously 500)', async () => {
    const w = await setup('DELLAST')
    const partyId = (await app.db!.query<{ party_id: string }>('select party_id from guests where id=$1', [w.bId])).rows[0]!.party_id
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenB, w.e1, { guestId: w.bId, requestedStatus: 'declined' })
    expect(req.statusCode, req.body).toBe(201)
    const res = await deleteGuest(w, w.bId)
    expect(res.statusCode, res.body).toBe(204)
    expect((await app.db!.query('select 1 from event_rsvp_requests where id=$1', [req.json().id])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from guest_parties where id=$1', [partyId])).rowCount).toBe(0)
  })

  it('P1-1: legacy POST /rsvp {plusOne:false} removing a +1 placeholder with a request cascades cleanly (previously 500)', async () => {
    const w = await setup('DELPLUSONE')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[1], requestedStatus: 'attending' }) // aIds[1] is the generated +1 placeholder
    expect(req.statusCode, req.body).toBe(201)
    const res = await legacyRsvp(w.tokenA, { status: 'yes', plusOne: false })
    expect(res.statusCode, res.body).toBe(200)
    expect((await app.db!.query('select 1 from event_rsvp_requests where id=$1', [req.json().id])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from guests where id=$1', [w.aIds[1]])).rowCount).toBe(0)
  })

  it('P1-1: deleting an additional event with a request (invitation already removed) is refused as event_in_use, not 500', async () => {
    const w = await setup('DELEVENT')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    expect(req.statusCode, req.body).toBe(201)
    // Drop every invitation for e1 first: otherwise this would already be
    // blocked by the pre-existing guest_event_invitations dependency, and the
    // test would not isolate what P1-1 actually adds (event_rsvp_requests).
    expect((await setInvitations(w, w.e1, [])).statusCode).toBe(200)
    const res = await deleteEvent(w, w.e1)
    expect(res.statusCode, res.body).toBe(409)
    expect(res.json().error.code).toBe('event_in_use')
    expect((await app.db!.query('select 1 from wedding_events where id=$1', [w.e1])).rowCount).toBe(1)
  })

  /* ── P1-2: решение по просьбе снятого с ростера больше не 404 ── */

  it('P1-2: a decision on a request from a person removed from the event roster succeeds (previously 404, request stuck pending forever and blocking re-invite)', async () => {
    const w = await setup('DEINVITE')
    await setDeadline(w, w.e1, '2020-01-01')
    const req1 = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    expect(req1.statusCode, req1.body).toBe(201)
    expect((await setInvitations(w, w.e1, [w.aIds[1]!])).statusCode).toBe(200) // aIds[0] dropped from the roster

    // reject: previously 404'd here (singleCouplePerson inner-joined the now-missing invitation)
    const rejected = await decide(w, w.e1, req1.json().id, { decision: 'reject', expectedVersion: '1' })
    expect(rejected.statusCode, rejected.body).toBe(200)
    expect(rejected.json().request.state).toBe('rejected')
    expect(rejected.json().person.guestId).toBe(w.aIds[0])

    // re-invite: a NEW request is now possible — the old one is no longer stuck
    // pending (the P1-2 bug blocked re-invite forever via the partial unique index)
    expect((await setInvitations(w, w.e1, [w.aIds[0]!, w.aIds[1]!])).statusCode).toBe(200)
    const req2 = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'declined' })
    expect(req2.statusCode, req2.body).toBe(201)
    const accepted = await decide(w, w.e1, req2.json().id, { decision: 'accept', expectedVersion: '1' })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().person).toMatchObject({ status: 'declined', source: 'organizer_correction' })
  })

  it('P1-2: accepting a request from a STILL de-invited person is allowed and does not fabricate a participation row for them', async () => {
    const w = await setup('DEINVITE2')
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    expect(req.statusCode, req.body).toBe(201)
    expect((await setInvitations(w, w.e1, [w.aIds[1]!])).statusCode).toBe(200) // aIds[0] stays out for the whole test
    const before = (await app.db!.query('select 1 from event_guest_participation where program_event_id=$1 and guest_id=$2', [w.e1, w.aIds[0]])).rowCount

    const accepted = await decide(w, w.e1, req.json().id, { decision: 'accept', expectedVersion: '1' })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().request.state).toBe('accepted')
    expect(accepted.json().person.status).toBe('unknown') // no roster slot to write the answer into — documented choice in rsvp-events.ts

    const after = (await app.db!.query('select 1 from event_guest_participation where program_event_id=$1 and guest_id=$2', [w.e1, w.aIds[0]])).rowCount
    expect(after).toBe(before)
  })

  /* ── P3-6: гостевой GET больше не берёт эксклюзивный замок свадьбы ── */

  it('P3-6: guest GET does not take an exclusive wedding lock — a concurrent FOR SHARE holder does not block it', async () => {
    const w = await setup('SHARE')
    let done = false
    await app.db!.tx(async (client) => {
      await client.query('select id from weddings where id=$1 for share', [w.weddingId])
      const res = guestEvents(w.tokenA)
      void res.then(() => { done = true })
      // A FOR UPDATE request (the P3-6 bug) conflicts with our open FOR SHARE
      // and could never finish while we keep holding it — give the GET ample
      // time to complete its whole round trip before we release.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(done).toBe(true)
      expect((await res).statusCode).toBe(200)
    })
  })

  /* ── миграция: отказ down при данных; инварианты DB ── */

  it('migration: down refuses while T012 data exists; CHECK/trigger invariants hold at the SQL level', async () => {
    const w = await setup('MIG')
    // A legacy main-event RSVP gives the 'invented' source check below a real
    // event_guest_participation row to hit (T012 itself never writes the main event).
    const legacy = await app.inject({ method: 'POST', url: `/rsvp/${w.tokenA}`, payload: { status: 'yes' } })
    expect(legacy.statusCode, legacy.body).toBe(200)
    await setDeadline(w, w.e1, '2020-01-01') // safely in the past, so the late request below is actually accepted
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    expect(req.statusCode, req.body).toBe(201)

    await expect(app.db!.query(
      "update event_guest_participation set source='invented' where program_event_id=$1 and guest_id=$2",
      [w.main, w.aIds[0]],
    )).rejects.toMatchObject({ code: '23514' })

    await expect(app.db!.query('update event_rsvp_requests set requested_status=$2 where id=$1', [req.json().id, 'declined']))
      .rejects.toMatchObject({ code: '23514' })

    const dupPending = await app.db!.query(
      `insert into event_rsvp_requests(wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key)
       select wedding_id,program_event_id,guest_id,party_id,'declined',$2 from event_rsvp_requests where id=$1`,
      [req.json().id, randomUUID()],
    ).catch((e: unknown) => e as { code?: string })
    expect((dupPending as { code?: string }).code).toBe('23505')

    const migration = createRequire(import.meta.url)('../migrations/1763700000000_event_rsvp_deadlines.cjs') as { down: (pgm: { sql: (sql: string) => void }) => void }
    let sql = ''
    migration.down({ sql: (value) => { sql = value } })
    // P3-8: this runs REAL down SQL on the shared dev DB. `app.db!.tx` only
    // rolls back when the callback THROWS — we expect the guard to throw, but
    // trusting that alone means a regression in the guard (or in statement
    // ordering) would silently COMMIT a destructive rollback before the
    // assertion below ever gets a chance to fail. A savepoint makes the undo
    // unconditional: rolled back whether the SQL throws or not, same pattern
    // as audit52.test.ts's intentional-rollback probes.
    const rollbackSentinel = new Error('P3-8: intentional rollback — migration down SQL must never commit on the shared DB')
    await expect((async () => {
      try {
        await app.db!.tx(async (client) => {
          await client.query('savepoint t012_down_attempt')
          try {
            await expect(client.query(sql)).rejects.toThrow('Refusing rollback with event RSVP deadlines, requests or organizer corrections')
          } finally {
            await client.query('rollback to savepoint t012_down_attempt')
            await client.query('release savepoint t012_down_attempt')
          }
          throw rollbackSentinel
        })
      } catch (error) {
        if (error !== rollbackSentinel) throw error
      }
    })()).resolves.toBeUndefined()
    expect((await app.db!.query('select rsvp_deadline from wedding_events where id=$1', [w.e1])).rows[0]?.rsvp_deadline).not.toBeNull()
  })

  /* ── P2-4/P3-9: инварианты БД — срок не позже даты, party_id согласован с
   * guests.party_id, решённая просьба не возвращается ни в pending, ни в
   * другое решение ── */

  it('DB invariants: rsvp_deadline cannot exceed the event date; event_rsvp_requests.party_id must be the guest\'s actual party; a decided request is immutable at the SQL level (P2-4/P3-9)', async () => {
    const w = await setup('INV')

    // P2-4: the handler already refuses this with 422 (see the PATCH test
    // above) — this proves the SAME rule also holds directly in SQL, in case
    // something ever writes to wedding_events without going through the route.
    await expect(app.db!.query('update wedding_events set rsvp_deadline=$2 where id=$1', [w.e1, '2027-06-20']))
      .rejects.toMatchObject({ code: '23514' }) // e1's date is 2027-06-19

    // P3-9: party_id must be exactly this guest's own party — a composite FK,
    // not two independently-valid FKs, so a request cannot be written (or
    // forged by hand) with a guest from one family and a party from another.
    await setDeadline(w, w.e1, '2020-01-01')
    const req = await lateRequest(w.tokenA, w.e1, { guestId: w.aIds[0], requestedStatus: 'attending' })
    expect(req.statusCode, req.body).toBe(201)
    const foreignParty = (await app.db!.query<{ party_id: string }>('select party_id from guests where id=$1', [w.bId])).rows[0]!.party_id
    await expect(app.db!.query(
      `insert into event_rsvp_requests(wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key)
       values($1,$2,$3,$4,'declined',$5)`,
      [w.weddingId, w.e1, w.aIds[1], foreignParty, randomUUID()],
    )).rejects.toMatchObject({ code: '23503' }) // aIds[1] belongs to family A's party, not bId's

    // P3-9: once decided, `state` never returns to pending (even with
    // decided_at nulled back out alongside it) and never flips to the OTHER
    // decided value — the pre-existing CHECK on (state,decided_at) alone does
    // not catch this if both columns are reset together.
    const decided = await decide(w, w.e1, req.json().id, { decision: 'accept', expectedVersion: '1' })
    expect(decided.statusCode, decided.body).toBe(200)
    await expect(app.db!.query("update event_rsvp_requests set state='pending',decided_at=null where id=$1", [req.json().id]))
      .rejects.toMatchObject({ code: '23514' })
    await expect(app.db!.query("update event_rsvp_requests set state='rejected' where id=$1", [req.json().id]))
      .rejects.toMatchObject({ code: '23514' })
  })
})
