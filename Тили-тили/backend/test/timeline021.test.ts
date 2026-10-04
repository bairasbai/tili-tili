import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { signAccessToken, hashRefreshToken, verifyAccessToken } from '../src/auth/tokens.js'
import { signShiftPreview, verifyShiftPreview } from '../src/timeline/preview-token.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface Event {
  id: string
  name: string
  location: string | null
  startsAt: string | null
  endsAt: string | null
  who: string | null
  icon: string | null
  outdoor: boolean
  forGuests: boolean
  durationMinutes?: number | null
  fixed?: boolean
  travelMinutes?: number
  bufferMinutes?: number
  dependsOn?: string[]
  responsible?: { kind: 'member' | 'guest' | 'deal'; id: string } | null
  participants?: { kind: 'member' | 'guest' | 'deal'; id: string }[]
  eventId?: string
}

interface Wedding { token: string; weddingId: string }

describe.skipIf(!DB)('WP03 / FR-036: timeline identity and tenant-safe replacement', () => {
  let app: FastifyInstance
  let counter = 0
  let prefix = String(randomInt(100_000, 1_000_000))
  const auth = (w: Wedding) => ({ authorization: `Bearer ${w.token}` })
  const path = (w: Wedding) => `/weddings/${w.weddingId}/timeline`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test', databaseUrl: DB ?? null, redisUrl: null, corsOrigins: ['http://localhost:3000'],
      jwtAccessSecret: SECRET_A, jwtRefreshSecret: SECRET_R, policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000, otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
    for (let i = 0; i < 20; i++) {
      const result = await app.db!.query('select id from users where phone like $1 limit 1', [`+79${prefix}%`])
      if (result.rowCount === 0) break
      prefix = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => { await app?.close() })

  async function wedding(options: { date?: string | null; format?: 'two_day' | 'classic' } = {}): Promise<Wedding> {
    const phone = `+79${prefix}${String(++counter).padStart(3, '0')}`
    const otp = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: '198.18.31.21' })
    expect(otp.statusCode, otp.body).toBe(200)
    const stored = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone=$1 order by created_at desc limit 1', [phone],
    )
    let code: string | undefined
    for (let i = 0; i < 10_000; i++) {
      const candidate = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, candidate) === stored.rows[0]!.code_hash) { code = candidate; break }
    }
    expect(code).toBeDefined()
    const login = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    expect(login.statusCode, login.body).toBe(200)
    const token = login.json().accessToken as string
    const consent = await app.inject({
      method: 'POST', url: '/users/me/consent', headers: { authorization: `Bearer ${token}` },
      payload: { policyVersion: '2026-09-02' },
    })
    expect(consent.statusCode, consent.body).toBe(201)
    const created = await app.inject({
      method: 'POST', url: '/weddings', headers: { authorization: `Bearer ${token}` },
      payload: { partnerName: 'Partner', ...(options.date === null ? {} : { date: options.date ?? `${new Date().getUTCFullYear() + 1}-06-14` }),
        ...(options.format ? { format: options.format } : {}),
        city: { name: 'Уфа', region: 'Башкортостан' }, budgetTotal: { amount: 150_000_000, currency: 'RUB' } },
    })
    expect(created.statusCode, created.body).toBe(201)
    return { token, weddingId: created.json().id as string }
  }

  async function read(w: Wedding): Promise<Event[]> {
    const response = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(response.statusCode, response.body).toBe(200)
    return response.json() as Event[]
  }

  async function put(w: Wedding, events: unknown[], version?: string) {
    const snapshot = version === undefined ? await app.inject({ method: 'GET', url: path(w), headers: auth(w) }) : null
    const expected = version ?? snapshot?.headers.etag
    expect(expected).toMatch(/^"\d+"$/)
    return app.inject({ method: 'PUT', url: path(w), headers: { ...auth(w), 'if-match': expected }, payload: events })
  }

  const programDate = () => `${new Date().getUTCFullYear() + 1}-06-14`
  async function previewShift(w: Wedding, scope: { kind: 'day'; date: string } | { kind: 'event'; eventId: string }, minutes = 15) {
    return app.inject({ method: 'POST', url: path(w) + '/shift/preview', headers: auth(w), payload: { scope, minutes } })
  }
  async function confirmShift(w: Wedding, preview: Awaited<ReturnType<typeof previewShift>>, key = randomUUID()) {
    return app.inject({ method: 'POST', url: path(w) + '/shift',
      headers: { ...auth(w), 'if-match': preview.headers.etag!, 'idempotency-key': key }, payload: { previewToken: preview.json().previewToken } })
  }
  async function scopedProgram(w: Wedding) {
    const blocks = await read(w), date = programDate()
    const accepted = await put(w, [
      { ...blocks[0]!, startsAt: `${date}T09:00:12.125Z`, endsAt: `${date}T09:30:12.125Z`, durationMinutes: 30 },
      { ...blocks[1]!, startsAt: `${new Date().getUTCFullYear() + 1}-06-15T09:00:00Z`, endsAt: `${new Date().getUTCFullYear() + 1}-06-15T09:30:00Z`, durationMinutes: 30 },
      { ...blocks[2]!, startsAt: `${date}T10:00:00Z`, endsAt: `${date}T10:30:00Z`, durationMinutes: 30, fixed: true },
      { ...blocks[3]!, startsAt: '2020-06-14T09:00:00Z', endsAt: '2020-06-14T09:30:00Z', durationMinutes: 30 },
    ])
    expect(accepted.statusCode, accepted.body).toBe(200)
    return accepted.json() as Event[]
  }

  async function member(w: Wedding, role: 'helper' | 'coordinator' | 'couple' = 'helper') {
    const user = await wedding()
    const userId = (await app.inject({ method: 'GET', url: '/users/me', headers: auth(user) })).json().id as string
    await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values($1,$2,$3)', [w.weddingId, userId, role])
    return { ...user, weddingId: w.weddingId, userId }
  }
  async function bookedVendor(w: Wedding, slotIndex: number) {
    const user = await wedding()
    const userId = (await app.inject({ method: 'GET', url: '/users/me', headers: auth(user) })).json().id as string
    const profile = await app.inject({ method: 'PUT', url: '/vendor/profile', headers: auth(user), payload: {
      name: 'Canonical resource fixture', categoryId: 'photo', city: { name: 'Уфа', region: 'Башкортостан' }, priceFrom: { amount: 100_000, currency: 'RUB' },
    } })
    expect(profile.statusCode, profile.body).toBe(200)
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w) })).json() as { id: string }[]
    const vendorId = profile.json().id as string, dealId = randomUUID()
    // Persisted booking fixture; this is a reader/command test, not a booking workflow test.
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,booked_at) values($1,$2,$3,$4,'booked',clock_timestamp())", [dealId, w.weddingId, slots[slotIndex]!.id, vendorId])
    return { userId, vendorId, dealId, slots }
  }

  it('resolves distinct booked deals to the same actual vendor when checking overlaps', async () => {
    const w = await wedding(), before = await scopedProgram(w), vendor = await bookedVendor(w, 0), secondDeal = randomUUID()
    await app.db!.query("insert into deals(id,wedding_id,slot_id,vendor_id,state,booked_at) values($1,$2,$3,$4,'booked',clock_timestamp())", [secondDeal, w.weddingId, vendor.slots[1]!.id, vendor.vendorId])
    expect((await put(w, [
      { ...before[0]!, participants: [{ kind: 'deal', id: vendor.dealId }] },
      { ...before[2]!, startsAt: `${programDate()}T09:30:12.125Z`, endsAt: `${programDate()}T10:00:12.125Z`, participants: [{ kind: 'deal', id: secondDeal }] },
    ])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ canConfirm: false, previewToken: null })
    expect(preview.json().conflicts).toContainEqual({ kind: 'participant_overlap', blockIds: [before[0]!.id, before[2]!.id] })
  })

  it('captures minimal authoritative block, participant and guest names from only this wedding', async () => {
    const w = await wedding(), before = await scopedProgram(w), assigned = await member(w)
    const vendor = await bookedVendor(w, 0), foreign = await wedding()
    await app.db!.query("update users set name='Captured helper' where id=$1", [assigned.userId])
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'Captured guest', phone: '+79990000000' } })
    expect(guest.statusCode, guest.body).toBe(201)
    await app.db!.query("update guests set rsvp='yes',comment='PRIVATE COMMENT' where id=$1", [guest.json().id])
    const stranger = await app.inject({ method: 'POST', url: `/weddings/${foreign.weddingId}/guests`, headers: auth(foreign), payload: { name: 'FOREIGN SECRET' } })
    expect(stranger.statusCode, stranger.body).toBe(201)
    expect((await put(w, [{ ...before[0]!, name: 'Captured block', responsible: { kind: 'member', id: assigned.userId },
      participants: [{ kind: 'guest', id: guest.json().id }, { kind: 'deal', id: vendor.dealId }] }])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().blockDetails).toContainEqual({ id: before[0]!.id, name: 'Captured block', eventId: before[0]!.eventId,
      eventName: 'Основная программа', eventDate: programDate(), timeZone: 'Asia/Yekaterinburg', location: before[0]!.location,
      startsAt: before[0]!.startsAt, endsAt: before[0]!.endsAt })
    expect(preview.json().referenceDetails).toContainEqual({ kind: 'member', id: assigned.userId, name: 'Captured helper', assignments: [{ blockId: before[0]!.id, role: 'responsible' }] })
    expect(preview.json().referenceDetails).toContainEqual({ kind: 'deal', id: vendor.dealId, name: 'Canonical resource fixture', assignments: [{ blockId: before[0]!.id, role: 'participant' }] })
    expect(preview.json().affectedGuests).toEqual([{ id: guest.json().id, name: 'Captured guest' }])
    expect(preview.body).not.toContain('FOREIGN SECRET')
    expect(preview.body).not.toContain('PRIVATE COMMENT')
    expect(preview.body).not.toContain('+79990000000')
    for (const ref of preview.json().referenceDetails) expect(Object.keys(ref).sort()).toEqual(['assignments', 'id', 'kind', 'name'])
    for (const person of preview.json().affectedGuests) expect(Object.keys(person).sort()).toEqual(['id', 'name'])
    expect(preview.json()).not.toHaveProperty('vendorUserIds')
    const denied = await previewShift(assigned, { kind: 'day', date: programDate() })
    expect(denied.statusCode).toBe(403)
    expect(denied.body).not.toContain('Captured guest')
    expect(denied.json()).not.toHaveProperty('blockDetails')
    const grant = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/members/${assigned.userId}`, headers: auth(w), payload: { role: 'coordinator' } })
    expect(grant.statusCode, grant.body).toBe(200)
    const coordinator = await previewShift(assigned, { kind: 'day', date: programDate() })
    expect(coordinator.statusCode, coordinator.body).toBe(200)
    expect(coordinator.json().affectedGuests).toEqual([{ id: guest.json().id, name: 'Captured guest' }])
    expect(coordinator.body).not.toContain('PRIVATE COMMENT')
    expect(coordinator.body).not.toContain('+79990000000')
  })

  it('captures an external contractor without an account and does not disclose deal money or phone', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w) })).json() as { id: string }[]
    const saved = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slots[0]!.id}/external`, headers: auth(w), payload: { vendorName: 'Own contractor', phone: '+79990000001', price: { amount: 123456, currency: 'RUB' } } })
    expect(saved.statusCode, saved.body).toBe(200)
    const deal = (await app.db!.query<{ id: string }>('select id from deals where wedding_id=$1 and slot_id=$2', [w.weddingId, slots[0]!.id])).rows[0]!
    expect((await put(w, [{ ...before[0]!, participants: [{ kind: 'deal', id: deal.id }] }])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().referenceDetails).toEqual([{ kind: 'deal', id: deal.id, name: 'Own contractor', assignments: [{ blockId: before[0]!.id, role: 'participant' }] }])
    expect(preview.body).not.toContain('+79990000001')
    expect(preview.body).not.toContain('external_phone')
    expect(preview.body).not.toContain('price')
  })

  it('rejects a changed contractor label even without a program revision change', async () => {
    const w = await wedding(), before = await scopedProgram(w), vendor = await bookedVendor(w, 0)
    expect((await put(w, [{ ...before[0]!, participants: [{ kind: 'deal', id: vendor.dealId }] }])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'day', date: programDate() }), unchanged = await read(w)
    // A persisted label mutation isolates digest protection from timeline revision protection.
    await app.db!.query("update vendors set name='Renamed contractor' where id=$1", [vendor.vendorId])
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(snapshot.headers.etag).toBe(preview.headers.etag)
    const rejected = await confirmShift(w, preview)
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('shift_preview_changed')
    expect(await read(w)).toEqual(unchanged)
  })

  it('captures independent event context and retains an actually unknown member name', async () => {
    const w = await wedding(), before = await scopedProgram(w), assigned = await member(w)
    await app.db!.query('update users set name=null where id=$1', [assigned.userId])
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const event = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/events`, headers: { ...auth(w), 'if-match': snapshot.headers.etag },
      payload: { name: 'Independent ceremony', kind: 'other', date: `${new Date().getUTCFullYear() + 1}-06-15`, timeZone: 'Europe/Moscow' } })
    expect(event.statusCode, event.body).toBe(201)
    expect((await put(w, [{ ...before[1]!, name: 'Independent block', eventId: event.json().id, participants: [{ kind: 'member', id: assigned.userId }] }])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'event', eventId: event.json().id })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().blockDetails[0]).toMatchObject({ id: before[1]!.id, name: 'Independent block', eventId: event.json().id,
      eventName: 'Independent ceremony', eventDate: `${new Date().getUTCFullYear() + 1}-06-15`, timeZone: 'Europe/Moscow' })
    expect(preview.json().referenceDetails).toEqual([{ kind: 'member', id: assigned.userId, name: null, assignments: [{ blockId: before[1]!.id, role: 'participant' }] }])
  })

  it('only records notices for commanders and actually affected members/vendors, and counts assigned RSVP guests', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const affected = await member(w), unaffected = await member(w), commander = await member(w, 'coordinator')
    const vendor = await bookedVendor(w, 0), unrelatedVendor = await bookedVendor(w, 1)
    const guestIds: string[] = []
    for (const name of ['Affected guest', 'Unrelated guest']) {
      const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name } })
      expect(guest.statusCode, guest.body).toBe(201)
      guestIds.push(guest.json().id)
    }
    await app.db!.query("update guests set rsvp='yes' where id=any($1::uuid[])", [guestIds])
    expect((await put(w, [{ ...before[0]!, forGuests: false, participants: [{ kind: 'member', id: affected.userId }, { kind: 'deal', id: vendor.dealId }, { kind: 'guest', id: guestIds[0]! }] },
      { ...before[2]!, participants: [{ kind: 'member', id: unaffected.userId }, { kind: 'deal', id: unrelatedVendor.dealId }] }])).statusCode).toBe(200)
    const updates = () => app.db!.query<{ vendor_id: string; text: string }>("select * from vendor_updates where wedding_id=$1 and kind='timeline' order by vendor_id", [w.weddingId])
    const priorUpdates = (await updates()).rows
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ canConfirm: true, guestsAffected: 1, affectedGuestIds: [guestIds[0]], affectedVendorIds: [vendor.vendorId], affectedMemberIds: [affected.userId] })
    expect(preview.json()).not.toHaveProperty('vendorUserIds')
    const key = randomUUID(), accepted = await confirmShift(w, preview, key)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json().guestsAffected).toBe(1)
    const users = [affected.userId, unaffected.userId, commander.userId, vendor.userId, unrelatedVendor.userId]
    const notices = () => app.db!.query<{ user_id: string }>("select user_id from notifications where user_id=any($1::uuid[]) and title='Тайминг сдвинут' order by user_id", [users])
    expect((await notices()).rows.map(r => r.user_id)).toEqual([affected.userId, commander.userId, vendor.userId].sort())
    const acceptedUpdates = (await updates()).rows
    expect(acceptedUpdates.find(r => r.vendor_id === unrelatedVendor.vendorId)).toEqual(priorUpdates.find(r => r.vendor_id === unrelatedVendor.vendorId))
    expect(acceptedUpdates.find(r => r.vendor_id === vendor.vendorId)?.text).toBe('Тайминг сдвинут на +15 мин')
    expect((await confirmShift(w, preview, key)).statusCode).toBe(200)
    expect((await notices()).rowCount).toBe(3)
  })

  it('rejects changed guest consequences even when the timeline revision is unchanged', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'RSVP changes' } })
    expect(guest.statusCode, guest.body).toBe(201)
    await app.db!.query("update guests set rsvp='yes' where id=$1", [guest.json().id])
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().guestsAffected).toBe(1)
    await app.db!.query("update guests set rsvp='no' where id=$1", [guest.json().id])
    expect((await eventList(w)).headers.etag).toBe(preview.headers.etag)
    const rejected = await confirmShift(w, preview)
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('shift_preview_changed')
    expect(await read(w)).toEqual(before)
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('expires a correctly signed preview against the actual database clock without any command writes', async () => {
    const w = await wedding(), before = await scopedProgram(w), preview = await previewShift(w, { kind: 'day', date: programDate() })
    const now = (await app.db!.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
    const claims = await verifyShiftPreview(SECRET_A, preview.json().previewToken, now)
    const token = await signShiftPreview(SECRET_A, claims, new Date(now.getTime() - 601_000))
    const rejected = await app.inject({ method: 'POST', url: path(w) + '/shift', headers: { ...auth(w), 'if-match': preview.headers.etag!, 'idempotency-key': randomUUID() }, payload: { previewToken: token } })
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('shift_preview_expired')
    expect(await read(w)).toEqual(before)
    expect((await app.db!.query("select key from idempotency_keys where user_id=$1 and route='timeline-shift-v2'", [claims.userId])).rowCount).toBe(0)
  })

  it('binds both a new command and an accepted replay to the original live user session', async () => {
    const w = await wedding()
    await scopedProgram(w)
    const other = await member(w, 'couple'), preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect((await confirmShift(other, preview)).statusCode).toBe(422)
    const caller = await verifyAccessToken(SECRET_A, w.token), sessionId = randomUUID()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash,device) values($1,$2,$3,$4)', [sessionId, caller.sub, hashRefreshToken(randomUUID()), 'second-session-fixture'])
    const second = { ...w, token: await signAccessToken(SECRET_A, { sub: caller.sub, sid: sessionId }) }
    expect((await confirmShift(second, preview)).statusCode).toBe(422)
    const key = randomUUID()
    expect((await confirmShift(w, preview, key)).statusCode).toBe(200)
    expect((await confirmShift(second, preview, key)).statusCode).toBe(422)
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it('uses current eligibility: a block that starts after preview is never shifted', async () => {
    const w = await wedding(), before = await read(w)
    expect((await put(w, [{ ...before[0]!, startsAt: null, endsAt: null, durationMinutes: 30 }])).statusCode).toBe(200)
    await app.db!.query("with moment as materialized (select clock_timestamp()+interval '2 seconds' as at) update timeline_events set starts_at=moment.at,ends_at=moment.at+interval '30 minutes' from moment where id=$1", [before[0]!.id])
    const day = (await app.db!.query<{ day: string }>("select (starts_at at time zone 'Asia/Yekaterinburg')::date::text as day from timeline_events where id=$1", [before[0]!.id])).rows[0]!.day
    const preview = await previewShift(w, { kind: 'day', date: day })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().canConfirm).toBe(true)
    const recorded = await read(w)
    await app.db!.query('select pg_sleep(greatest(0,extract(epoch from (starts_at-clock_timestamp())))::double precision+0.05) from timeline_events where id=$1', [before[0]!.id])
    const rejected = await confirmShift(w, preview)
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('shift_conflict')
    expect(await read(w)).toEqual(recorded)
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  }, 10_000)

  it('rolls back moved blocks, revision, ledger, broadcast, vendor update, notification and key together', async () => {
    const w = await wedding(), before = await scopedProgram(w), commander = await member(w, 'coordinator'), vendor = await bookedVendor(w, 0)
    expect((await put(w, [{ ...before[0]!, participants: [{ kind: 'deal', id: vendor.dealId }] }, ...before.slice(1)])).statusCode).toBe(200)
    const recorded = await read(w), preview = await previewShift(w, { kind: 'day', date: programDate() }), key = randomUUID()
    const tables = ['timeline_shifts', 'broadcasts', 'vendor_updates']
    const beforeRows = new Map<string, unknown[]>()
    for (const table of tables) beforeRows.set(table, (await app.db!.query(`select * from ${table} where wedding_id=$1 order by id`, [w.weddingId])).rows)
    const original = app.db!.tx
    let inserted = false
    app.db!.tx = action => original(client => action({ query: (sql, values) => client.query(sql, values).then(result => {
      if (/insert into notifications/.test(sql)) { inserted = true; throw new Error('Fault after actual notification insert') }
      return result
    }) }))
    try {
      const refused = await confirmShift(w, preview, key)
      expect(refused.statusCode, refused.body).toBe(500)
      expect(inserted).toBe(true)
    } finally { app.db!.tx = original }
    expect(await read(w)).toEqual(recorded)
    expect((await eventList(w)).headers.etag).toBe(preview.headers.etag)
    for (const table of tables) expect((await app.db!.query(`select * from ${table} where wedding_id=$1 order by id`, [w.weddingId])).rows).toEqual(beforeRows.get(table))
    expect((await app.db!.query("select 1 from notifications where user_id=any($1::uuid[]) and title='Тайминг сдвинут'", [[commander.userId, vendor.userId]])).rowCount).toBe(0)
    expect((await app.db!.query('select 1 from idempotency_keys where key like $1', [`%:timeline-shift-v2:${key}`])).rowCount).toBe(0)
    expect((await confirmShift(w, preview, key)).statusCode).toBe(200)
  })

  async function observeNativeWeddingWait(holder: number) {
    let rows: { pid: number; query: string; blockers: number[]; wait_event: string | null }[] = []
    for (let attempt = 0; attempt < 120; attempt++) {
      rows = (await app.db!.query<{ pid: number; query: string; blockers: number[]; wait_event: string | null }>(
        `select pid,query,pg_blocking_pids(pid) blockers,wait_event from pg_stat_activity
          where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'
          and $1=any(pg_blocking_pids(pid))`, [holder])).rows
      if (rows.length === 1) break
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    expect(rows, 'one actual wedding-lock waiter behind the owned holder').toHaveLength(1)
    const row = rows[0]!
    expect(row.blockers).toContain(holder)
    expect(row.query.replace(/\s+/g, ' ')).toMatch(/from weddings(?: w)? where (?:w\.)?id\s*=\s*\$1.*for (?:update|share)/)
    process.stdout.write(`BACKEND_FIXTURE_NATIVE_WEDDING_WAIT ${JSON.stringify({holder,...row})}\n`)
  }

  it.each(['preview', 'confirm', 'replay'] as const)('%s rechecks access after waiting for the actual wedding lock', async mode => {
    const w = await wedding()
    await scopedProgram(w)
    const commander = await member(w, 'coordinator'), preview = await previewShift(commander, { kind: 'day', date: programDate() }), key = randomUUID()
    expect(preview.statusCode, preview.body).toBe(200)
    if (mode === 'replay') expect((await confirmShift(commander, preview, key)).statusCode).toBe(200)
    const before = await read(w), shiftsBefore = (await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount
    let held!: () => void, entered!: () => void, release!: () => void, holderPid = 0
    const locked = new Promise<void>(resolve => { held = resolve }), waiting = new Promise<void>(resolve => { entered = resolve }), released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      holderPid = (await client.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('select id from weddings where id=$1 for update', [w.weddingId]); held()
      await released
      await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, commander.userId])
    })
    await locked
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (values?.[0] === w.weddingId && ((sql.includes('timeline_version::text') && /for (update|share)/.test(sql)) || sql.trim() === 'select id from weddings where id=$1 for update')) entered()
      return client.query(sql, values)
    } }))
    let response: Promise<Awaited<ReturnType<typeof confirmShift>>> | undefined
    try {
      response = Promise.resolve(mode === 'preview' ? previewShift(commander, { kind: 'day', date: programDate() }) : confirmShift(commander, preview, key))
      await waiting
      await observeNativeWeddingWait(holderPid)
      release()
      await blocker
      expect((await response).statusCode).toBe(404)
      expect(await read(w)).toEqual(before)
      expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(shiftsBefore)
    } finally { release(); await blocker; if (response) await response; app.db!.tx = original }
  })

  it('the old one-click shift cannot bypass an exact-version preview', async () => {
    const w = await wedding(), before = await read(w)
    const legacy = await app.inject({ method: 'POST', url: path(w) + '/shift', headers: { ...auth(w), 'idempotency-key': randomUUID() }, payload: { minutes: 15 } })
    expect(legacy.statusCode, legacy.body).toBe(428)
    expect(await read(w)).toEqual(before)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    for (const payload of [{ minutes: 15 }, { previewToken: preview.json().previewToken, minutes: 15 }, { previewToken: preview.json().previewToken, force: true }]) {
      const rejected = await app.inject({ method: 'POST', url: path(w) + '/shift', headers: { ...auth(w), 'if-match': preview.headers.etag!, 'idempotency-key': randomUUID() }, payload })
      expect(rejected.statusCode, rejected.body).toBe(422)
      expect(await read(w)).toEqual(before)
    }
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('previews one real local day without moving another day, fixed, past blocks or recording side effects', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const version = (await eventList(w)).headers.etag
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers.etag).toBe(version)
    expect(preview.json()).toMatchObject({ canConfirm: true, scope: { kind: 'day', date: programDate(), timeZone: 'Asia/Yekaterinburg' },
      blocks: [{ id: before[0]!.id, before: { startsAt: before[0]!.startsAt }, after: { startsAt: `${programDate()}T09:15:12.125Z` } }] })
    expect(preview.json().excluded).toContainEqual({ id: before[1]!.id, reason: 'other_day' })
    expect(preview.json().excluded).toContainEqual({ id: before[2]!.id, reason: 'fixed' })
    expect(await read(w)).toEqual(before)
    expect((await eventList(w)).headers.etag).toBe(version)
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
    expect((await app.db!.query('select id from broadcasts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('confirms only the previewed block and retries return exactly the same accepted version and answer', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const key = randomUUID(), accepted = await confirmShift(w, preview, key)
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.json()).toMatchObject({ minutes: 15, shiftedBlocks: 1, guestsAffected: 0 })
    const after = await read(w)
    expect(after[0]!.startsAt).toBe(`${programDate()}T09:15:12.125Z`)
    expect(after.slice(1)).toEqual(before.slice(1))
    expect(accepted.headers.etag).not.toBe(preview.headers.etag)
    const replay = await confirmShift(w, preview, key)
    expect(replay.statusCode, replay.body).toBe(200)
    expect(replay.json()).toEqual(accepted.json())
    expect(replay.headers.etag).toBe(accepted.headers.etag)
    expect(replay.headers['idempotent-replay']).toBe('true')
    expect(await read(w)).toEqual(after)
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
    expect((await app.db!.query('select id from broadcasts where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it('uses the actual selected event timezone/date and refuses foreign, unknown or undated event scopes', async () => {
    const w = await wedding(), other = await wedding(), created = await createEvent(w), foreign = await createEvent(other)
    expect(created.statusCode, created.body).toBe(201)
    const before = await read(w), date = `${new Date().getUTCFullYear() + 1}-06-15`
    expect((await put(w, [
      { ...before[0]!, eventId: created.json().id, startsAt: `${date}T09:00:00Z`, endsAt: `${date}T09:30:00Z`, durationMinutes: 30 },
      { ...before[1]!, startsAt: `${date}T09:00:00Z`, endsAt: `${date}T09:30:00Z`, durationMinutes: 30 },
    ])).statusCode).toBe(200)
    const preview = await previewShift(w, { kind: 'event', eventId: created.json().id })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json()).toMatchObject({ scope: { kind: 'event', eventId: created.json().id, date, timeZone: 'Europe/Moscow' }, blocks: [{ id: before[0]!.id }] })
    expect(preview.json().excluded).toContainEqual({ id: before[1]!.id, reason: 'other_event' })
    for (const eventId of [foreign.json().id, randomUUID()]) expect((await previewShift(w, { kind: 'event', eventId })).statusCode).toBe(404)
    const snapshot = await eventList(w)
    const undated = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/events`, headers: { ...auth(w), 'if-match': snapshot.headers.etag! }, payload: { name: 'Date not selected', kind: 'other' } })
    expect(undated.statusCode).toBe(201)
    expect((await previewShift(w, { kind: 'event', eventId: undated.json().id })).statusCode).toBe(422)
  })

  it('stale confirmation refuses without moving blocks or writing a journal', async () => {
    const w = await wedding(), before = await scopedProgram(w), preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const changed = await put(w, before.map((e, i) => i === 1 ? { ...e, name: 'Other day changed' } : e))
    expect(changed.statusCode).toBe(200)
    const rejected = await confirmShift(w, preview)
    expect(rejected.statusCode, rejected.body).toBe(409)
    expect(rejected.json().error.code).toBe('timeline_conflict')
    expect(await read(w)).toEqual(changed.json())
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('cannot confirm a forged preview or reuse a key for a different preview', async () => {
    const w = await wedding()
    await scopedProgram(w)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const bad = await app.inject({ method: 'POST', url: path(w) + '/shift', headers: { ...auth(w), 'if-match': preview.headers.etag!, 'idempotency-key': randomUUID() }, payload: { previewToken: w.token } })
    expect(bad.statusCode, bad.body).toBe(422)
    const key = randomUUID()
    expect((await confirmShift(w, preview, key)).statusCode).toBe(200)
    const fresh = await previewShift(w, { kind: 'day', date: programDate() }, 20)
    const reused = await confirmShift(w, fresh, key)
    expect(reused.statusCode, reused.body).toBe(409)
    expect(reused.json().error.code).toBe('idempotency_key_reused')
  })

  it.each([false, true])('concurrent confirmations sameKey=%s commit exactly one shift', async sameKey => {
    const w = await wedding()
    await scopedProgram(w)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const first = randomUUID(), second = sameKey ? first : randomUUID()
    const results = await Promise.all([confirmShift(w, preview, first), confirmShift(w, preview, second)])
    expect(results.map(r => r.statusCode).sort()).toEqual(sameKey ? [200, 200] : [200, 409])
    expect((await app.db!.query('select id from timeline_shifts where wedding_id=$1', [w.weddingId])).rowCount).toBe(1)
  })

  it('an unknown duration and a shared participant conflict never produce a confirmable token', async () => {
    const w = await wedding(), before = await scopedProgram(w)
    const me = (await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })).json()
    const participant = { kind: 'member', id: me.id }
    const date = programDate()
    expect((await put(w, [
      { ...before[0]!, startsAt: `${date}T09:00:00Z`, endsAt: `${date}T09:30:00Z`, participants: [participant] },
      { ...before[2]!, startsAt: `${date}T09:30:00Z`, endsAt: `${date}T10:00:00Z`, participants: [participant] },
    ])).statusCode).toBe(200)
    const conflict = await previewShift(w, { kind: 'day', date })
    expect(conflict.statusCode, conflict.body).toBe(200)
    expect(conflict.json()).toMatchObject({ canConfirm: false, conflicts: [{ kind: 'participant_overlap' }], previewToken: null })
    expect((await put(w, [{ ...before[0]!, endsAt: null, durationMinutes: null }])).statusCode).toBe(200)
    const unknown = await previewShift(w, { kind: 'day', date })
    expect(unknown.json()).toMatchObject({ canConfirm: false, conflicts: [{ kind: 'unknown_duration' }], previewToken: null })
  })

  it('preserves block identity across editing and reordering', async () => {
    const w = await wedding()
    const before = await read(w)
    const next = [{ ...before[1]!, name: 'Edited block', forGuests: false }, before[0]!]
    const saved = await put(w, next)
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().map((e: Event) => e.id)).toEqual(next.map(e => e.id))
    expect(await read(w)).toEqual(saved.json())
    expect(saved.json()[0]).toMatchObject({ name: 'Edited block', forGuests: false })
  })

  it('generates an ID only for the new block', async () => {
    const w = await wedding()
    const before = await read(w)
    const saved = await put(w, [...before, { name: 'New block' }])
    expect(saved.statusCode, saved.body).toBe(200)
    const after = saved.json() as Event[]
    expect(after.slice(0, before.length).map(e => e.id)).toEqual(before.map(e => e.id))
    expect(after.at(-1)!.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(before.some(e => e.id === after.at(-1)!.id)).toBe(false)
  })

  it('removes only omitted blocks and keeps survivor IDs on repeated saves', async () => {
    const w = await wedding()
    const before = await read(w)
    const next = before.slice(1)
    const once = await put(w, next)
    expect(once.statusCode, once.body).toBe(200)
    const twice = await put(w, next)
    expect(twice.statusCode, twice.body).toBe(200)
    expect(await read(w)).toEqual(next)
  })

  it('rejects duplicate IDs including UUID case aliases without any mutation', async () => {
    const w = await wedding()
    const before = await read(w)
    const saved = await put(w, [before[0]!, { ...before[0]!, id: before[0]!.id.toUpperCase() }])
    expect(saved.statusCode, saved.body).toBe(422)
    expect(await read(w)).toEqual(before)
  })

  it('rejects a foreign block ID atomically and leaves both weddings unchanged', async () => {
    const own = await wedding()
    const other = await wedding()
    const before = await read(own)
    const foreign = await read(other)
    const saved = await put(own, [before[0]!, { ...foreign[0]!, name: 'Foreign overwrite attempt' }])
    expect(saved.statusCode, saved.body).toBe(422)
    expect(await read(own)).toEqual(before)
    expect(await read(other)).toEqual(foreign)
  })

  it('rejects an unknown ID instead of silently creating another block', async () => {
    const w = await wedding()
    const before = await read(w)
    const saved = await put(w, [before[0]!, { name: 'Unknown', id: randomUUID() }])
    expect(saved.statusCode, saved.body).toBe(422)
    expect(await read(w)).toEqual(before)
  })

  it('rejects malformed IDs before touching the stored schedule', async () => {
    const w = await wedding()
    const before = await read(w)
    const saved = await put(w, [{ ...before[0]!, id: 'not-an-id' }])
    expect(saved.statusCode, saved.body).toBe(422)
    expect(await read(w)).toEqual(before)
  })

  it('exposes the revision of the exact schedule returned by GET', async () => {
    const w = await wedding()
    const response = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(response.statusCode).toBe(200)
    expect(response.headers.etag).toMatch(/^"\d+"$/)
  })

  it('refuses an unversioned legacy save rather than bypassing concurrency control', async () => {
    const w = await wedding()
    const before = await read(w)
    const response = await app.inject({ method: 'PUT', url: path(w), headers: auth(w), payload: [{ ...before[0]!, name: 'Unsafe save' }] })
    expect(response.statusCode, response.body).toBe(428)
    expect(await read(w)).toEqual(before)
  })

  it('rejects a stale snapshot without overwriting the first session edit', async () => {
    const w = await wedding()
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const before = snapshot.json() as Event[]
    const version = snapshot.headers.etag ?? '"0"'
    const first = await put(w, before.map((e, i) => i === 0 ? { ...e, name: 'First session' } : e), version)
    expect(first.statusCode, first.body).toBe(200)
    const stale = await put(w, before.map((e, i) => i === 0 ? { ...e, name: 'Stale session' } : e), version)
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('timeline_conflict')
    expect((await read(w))[0]!.name).toBe('First session')
  })

  it('allows exactly one of two concurrent edits from the same revision', async () => {
    const w = await wedding()
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const before = snapshot.json() as Event[]
    const version = snapshot.headers.etag ?? '"0"'
    const results = await Promise.all(['Session A', 'Session B'].map(name => put(w, before.map((e, i) => i === 0 ? { ...e, name } : e), version)))
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409])
    const winner = results.find(r => r.statusCode === 200)!.json() as Event[]
    expect(await read(w)).toEqual(winner)
  })

  it('invalidates the editor snapshot when day X shifts the program', async () => {
    const w = await wedding()
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const before = snapshot.json() as Event[]
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const shifted = await confirmShift(w, preview)
    expect(shifted.statusCode, shifted.body).toBe(200)
    expect(shifted.json().shiftedBlocks).toBeGreaterThan(0)
    const shiftedState = await read(w)
    const stale = await put(w, before, snapshot.headers.etag ?? '"0"')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(await read(w)).toEqual(shiftedState)
  })

  it('invalidates the editor snapshot when the wedding date changes', async () => {
    const w = await wedding()
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const before = snapshot.json() as Event[]
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w),
      payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(changed.statusCode, changed.body).toBe(200)
    const rescheduled = await read(w)
    expect(rescheduled[0]!.startsAt).not.toBe(before[0]!.startsAt)
    const stale = await put(w, before, snapshot.headers.etag ?? '"0"')
    expect(stale.statusCode, stale.body).toBe(409)
    expect(await read(w)).toEqual(rescheduled)
  })

  it('records the authenticated author and actual mutation time', async () => {
    const w = await wedding()
    const before = await read(w)
    const saved = await put(w, before.map((e, i) => i === 0 ? { ...e, name: 'Author check' } : e))
    expect(saved.statusCode, saved.body).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    expect(me.statusCode).toBe(200)
    const metadata = await app.db!.query<{ actor: string; changed: Date; version: string }>(
      'select timeline_updated_by as actor, timeline_updated_at as changed, timeline_version::text as version from weddings where id=$1',
      [w.weddingId],
    )
    expect(metadata.rows[0]!.actor).toBe(me.json().id)
    expect(metadata.rows[0]!.changed).toBeInstanceOf(Date)
    const snapshot = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(snapshot.headers.etag).toBe(`"${metadata.rows[0]!.version}"`)
    expect(snapshot.headers['x-timeline-updated-by']).toBe(metadata.rows[0]!.actor)
    expect(snapshot.headers['x-timeline-updated-at']).toBe(metadata.rows[0]!.changed.toISOString())
    expect(saved.headers['x-timeline-updated-by']).toBe(snapshot.headers['x-timeline-updated-by'])
    expect(saved.headers['x-timeline-updated-at']).toBe(snapshot.headers['x-timeline-updated-at'])
  })

  it('returns the resulting revision from PUT and the source revision from autogen', async () => {
    const w = await wedding()
    const first = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const saved = await put(w, first.json() as Event[], first.headers.etag!)
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.headers.etag).toMatch(/^"\d+"$/)
    expect(saved.headers.etag).not.toBe(first.headers.etag)
    const preview = await app.inject({ method: 'POST', url: path(w) + '/autogen', headers: auth(w) })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.headers.etag).toBe(saved.headers.etag)
    expect(preview.headers['x-timeline-updated-by']).toBe(saved.headers['x-timeline-updated-by'])
    expect(preview.headers['x-timeline-updated-at']).toBe(saved.headers['x-timeline-updated-at'])
    const fresh = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(fresh.headers.etag).toBe(preview.headers.etag)
    expect(fresh.json()).toEqual(saved.json())
  })

  it('rejects wildcard, weak, unquoted, multi-value and noncanonical versions atomically', async () => {
    const w = await wedding()
    const before = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    for (const version of ['*', 'W/' + before.headers.etag, '1', '"1", "2"', '"-1"', '"x"']) {
      const rejected = await app.inject({ method: 'PUT', url: path(w), headers: { ...auth(w), 'if-match': version }, payload: [{ name: 'Unsafe' }] })
      expect(rejected.statusCode, rejected.body).toBe(422)
    }
    const fresh = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(fresh.headers.etag).toBe(before.headers.etag)
    expect(fresh.json()).toEqual(before.json())
  })

  it('a rollback restores blocks, revision, timestamp and author together', async () => {
    const w = await wedding()
    const before = await app.db!.query('select timeline_version, timeline_updated_at, timeline_updated_by from weddings where id=$1', [w.weddingId])
    const blocks = await read(w)
    await expect(app.db!.tx(async client => {
      await client.query('update timeline_events set name=$2 where id=$1', [blocks[0]!.id, 'Must roll back'])
      throw new Error('intentional rollback witness')
    })).rejects.toThrow('intentional rollback witness')
    const after = await app.db!.query('select timeline_version, timeline_updated_at, timeline_updated_by from weddings where id=$1', [w.weddingId])
    expect(after.rows).toEqual(before.rows)
    expect(await read(w)).toEqual(blocks)
  })

  it('database mutations invalidate old snapshots without fabricating an authenticated author', async () => {
    const w = await wedding()
    const before = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const blocks = before.json() as Event[]
    await app.db!.query('update timeline_events set name=$2 where id=$1', [blocks[0]!.id, 'Database maintenance'])
    const metadata = await app.db!.query('select timeline_updated_by from weddings where id=$1', [w.weddingId])
    expect(metadata.rows[0]!.timeline_updated_by).toBeNull()
    const stale = await put(w, blocks, before.headers.etag!)
    expect(stale.statusCode, stale.body).toBe(409)
    expect((await read(w))[0]!.name).toBe('Database maintenance')
  })

  it('rejects moving a block to another wedding at the database boundary', async () => {
    const own = await wedding()
    const other = await wedding()
    const before = await read(own)
    const foreign = await read(other)
    await expect(app.db!.query('update timeline_events set wedding_id=$2 where id=$1', [before[0]!.id, other.weddingId])).rejects.toMatchObject({ code: '23514' })
    expect(await read(own)).toEqual(before)
    expect(await read(other)).toEqual(foreign)
  })

  it('increments the version when the entire timeline is cleared', async () => {
    const w = await wedding()
    const before = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const cleared = await put(w, [], before.headers.etag!)
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json()).toEqual([])
    expect(cleared.headers.etag).not.toBe(before.headers.etag)
    const stale = await put(w, [{ name: 'Revive stale program' }], before.headers.etag!)
    expect(stale.statusCode).toBe(409)
    expect(await read(w)).toEqual([])
  })

  it('exposes ETag to an allowed cross-origin browser without allowing another origin', async () => {
    const w = await wedding()
    const allowed = await app.inject({ method: 'GET', url: path(w), headers: { ...auth(w), origin: 'http://localhost:3000' } })
    expect(allowed.statusCode).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(allowed.headers['access-control-expose-headers']).toContain('ETag')
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Timeline-Updated-At')
    expect(allowed.headers['access-control-expose-headers']).toContain('X-Timeline-Updated-By')
    const denied = await app.inject({ method: 'GET', url: path(w), headers: { ...auth(w), origin: 'https://untrusted.invalid' } })
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('persists duration, fixed, manual travel/buffer and structured references through GET and autogen', async () => {
    const w = await wedding()
    const events = await read(w)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    const reference = { kind: 'member', id: me.json().id }
    const first = { ...events[0]!, endsAt: null, durationMinutes: 45, fixed: true, travelMinutes: 20, bufferMinutes: 10, responsible: reference, participants: [reference], dependsOn: [] }
    const second = { ...events[1]!, dependsOn: [first.id] }
    const saved = await put(w, [first, second])
    expect(saved.statusCode, saved.body).toBe(200)
    const after = await read(w)
    expect(after[0]).toMatchObject({ durationMinutes: 45, fixed: true, travelMinutes: 20, bufferMinutes: 10, responsible: reference, participants: [reference] })
    expect(Date.parse(after[0]!.endsAt!) - Date.parse(after[0]!.startsAt!)).toBe(45 * 60_000)
    expect(after[1]!.dependsOn).toEqual([first.id])
    const preview = await app.inject({ method: 'POST', url: path(w) + '/autogen', headers: auth(w) })
    expect(preview.statusCode, preview.body).toBe(200)
    expect(preview.json().events[0]).toMatchObject({ durationMinutes: 45, responsible: reference, participants: [reference] })
  })

  it('can plan duration before assigning a start but refuses inconsistent or negative intervals', async () => {
    const w = await wedding()
    const events = await read(w)
    const accepted = await put(w, [{ ...events[0]!, startsAt: null, endsAt: null, durationMinutes: 90 }])
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect((await read(w))[0]).toMatchObject({ startsAt: null, endsAt: null, durationMinutes: 90 })
    const before = await read(w)
    for (const patch of [{ durationMinutes: -1 }, { travelMinutes: -1 }, { bufferMinutes: 10081 }, { fixed: true },
      { startsAt: '2027-06-14T10:00:00Z', endsAt: '2027-06-14T09:00:00Z' },
      { startsAt: '2027-06-14T10:00:00Z', endsAt: '2027-06-14T11:00:00Z', durationMinutes: 30 }]) {
      const rejected = await put(w, [{ ...before[0]!, ...patch }])
      expect(rejected.statusCode, rejected.body).toBe(422)
      expect(await read(w)).toEqual(before)
    }
  })

  it('refuses cycles, duplicate and omitted/foreign dependency IDs atomically', async () => {
    const w = await wedding(), other = await wedding()
    const events = await read(w), foreign = await read(other)
    const valid = await put(w, [{ ...events[0]!, dependsOn: [] }, { ...events[1]!, dependsOn: [events[0]!.id] }])
    expect(valid.statusCode, valid.body).toBe(200)
    const before = await read(w)
    for (const payload of [
      [{ ...before[0]!, dependsOn: [before[1]!.id] }, before[1]!],
      [{ ...before[0]!, dependsOn: [before[0]!.id] }, before[1]!],
      [{ ...before[0]!, dependsOn: [foreign[0]!.id] }, before[1]!],
      [before[1]!],
      [{ ...before[0]!, dependsOn: [before[1]!.id, before[1]!.id.toUpperCase()] }, { ...before[1]!, dependsOn: [] }],
    ]) {
      const rejected = await put(w, payload)
      expect(rejected.statusCode, rejected.body).toBe(422)
      expect(await read(w)).toEqual(before)
    }
  })

  it('supports guest people and external booked contractors without exposing financial fields in references', async () => {
    const w = await wedding()
    const events = await read(w)
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'Timeline guest' } })
    expect(guest.statusCode, guest.body).toBe(201)
    const slots = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w) })
    const slot = slots.json()[0]
    const booked = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/external`, headers: { ...auth(w), 'idempotency-key': randomUUID() }, payload: { vendorName: 'External timeline contractor', price: { amount: 100000, currency: 'RUB' } } })
    expect(booked.statusCode, booked.body).toBe(200)
    const responsible = { kind: 'deal', id: booked.json().deal.id }
    const participant = { kind: 'guest', id: guest.json().id }
    const saved = await put(w, [{ ...events[0]!, responsible, participants: [participant, responsible] }])
    expect(saved.statusCode, saved.body).toBe(200)
    expect((await read(w))[0]).toMatchObject({ responsible, participants: expect.arrayContaining([participant, responsible]) })
    const refs = saved.json()[0].participants
    expect(refs.every((r: Record<string, unknown>) => Object.keys(r).sort().join() === 'id,kind')).toBe(true)
    const foreign = await wedding()
    const foreignMe = await app.inject({ method: 'GET', url: '/users/me', headers: auth(foreign) })
    const before = await read(w)
    const rejected = await put(w, [{ ...before[0]!, responsible: { kind: 'member', id: foreignMe.json().id } }])
    expect(rejected.statusCode, rejected.body).toBe(422)
    expect(await read(w)).toEqual(before)
  })

  it('removing a person clears assignments and invalidates the old editor snapshot', async () => {
    const w = await wedding()
    const events = await read(w)
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'Removed participant' } })
    expect(guest.statusCode).toBe(201)
    const participant = { kind: 'guest', id: guest.json().id }
    const saved = await put(w, [{ ...events[0]!, responsible: participant, participants: [participant] }])
    expect(saved.statusCode, saved.body).toBe(200)
    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/guests/${participant.id}`, headers: auth(w) })
    expect(removed.statusCode, removed.body).toBe(204)
    const fresh = await read(w)
    expect(fresh[0]!.responsible).toBeNull()
    expect(fresh[0]!.participants).toEqual([])
    const stale = await put(w, saved.json() as Event[], saved.headers.etag!)
    expect(stale.statusCode, stale.body).toBe(409)
  })

  it('database boundary rejects foreign dependencies and cycles even without an API handler', async () => {
    const w = await wedding(), other = await wedding()
    const events = await read(w), foreign = await read(other)
    const valid = await put(w, [{ ...events[0]!, dependsOn: [] }, { ...events[1]!, dependsOn: [events[0]!.id] }])
    expect(valid.statusCode, valid.body).toBe(200)
    await expect(app.db!.query('insert into timeline_dependencies(wedding_id,event_id,depends_on) values ($1,$2,$3)', [w.weddingId, events[0]!.id, foreign[0]!.id])).rejects.toMatchObject({ code: '23503' })
    await expect(app.db!.tx(async client => {
      await client.query('insert into timeline_dependencies(wedding_id,event_id,depends_on) values ($1,$2,$3)', [w.weddingId, events[0]!.id, events[1]!.id])
    })).rejects.toMatchObject({ code: '23514' })
    expect((await read(w))[0]!.dependsOn).toEqual([])
  })

  it('the existing day command never moves a fixed-time block', async () => {
    const w = await wedding()
    const events = await read(w)
    const saved = await put(w, [{ ...events[0]!, fixed: true }, { ...events[1]!, fixed: false }])
    expect(saved.statusCode, saved.body).toBe(200)
    const before = await read(w)
    const preview = await previewShift(w, { kind: 'day', date: programDate() })
    expect(preview.statusCode, preview.body).toBe(200)
    const shifted = await confirmShift(w, preview)
    expect(shifted.statusCode, shifted.body).toBe(200)
    expect(shifted.json().shiftedBlocks).toBe(1)
    const after = await read(w)
    expect(after[0]).toEqual(before[0])
    expect(Date.parse(after[1]!.startsAt!) - Date.parse(before[1]!.startsAt!)).toBe(15 * 60_000)
  })

  it('rejects duplicate participants, foreign guests/deals and non-booked contractors without changing data', async () => {
    const own = await wedding(), other = await wedding()
    const guest = await app.inject({ method: 'POST', url: `/weddings/${other.weddingId}/guests`, headers: auth(other), payload: { name: 'Foreign' } })
    expect(guest.statusCode).toBe(201)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(own) })
    const reference = { kind: 'member', id: me.json().id }
    const before = await read(own)
    for (const patch of [
      { participants: [reference, { ...reference, id: reference.id.toUpperCase() }] },
      { responsible: { kind: 'guest', id: guest.json().id } },
      { responsible: { kind: 'deal', id: randomUUID() } },
    ]) {
      const rejected = await put(own, [{ ...before[0]!, ...patch }])
      expect(rejected.statusCode, rejected.body).toBe(422)
      expect(await read(own)).toEqual(before)
    }
  })

  it('keeps planning when a compatible client omits new fields, but allows explicit clearing', async () => {
    const w = await wedding()
    const events = await read(w)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    const reference = { kind: 'member', id: me.json().id }
    const saved = await put(w, [{ ...events[0]!, fixed: true, travelMinutes: 10, responsible: reference, participants: [reference] }])
    expect(saved.statusCode, saved.body).toBe(200)
    const before = (await read(w))[0]!
    const compatible = await put(w, [{ id: before.id, name: 'Compatible name edit', startsAt: before.startsAt, endsAt: before.endsAt }])
    expect(compatible.statusCode, compatible.body).toBe(200)
    expect(compatible.json()[0]).toMatchObject({ fixed: true, travelMinutes: 10, responsible: reference, participants: [reference] })
    const cleared = await put(w, [{ ...compatible.json()[0], fixed: false, travelMinutes: 0, responsible: null, participants: [] }])
    expect(cleared.statusCode, cleared.body).toBe(200)
    expect(cleared.json()[0]).toMatchObject({ fixed: false, travelMinutes: 0, responsible: null, participants: [] })
  })

  it('removing membership and withdrawing consent clean assignments without inventing a replacement person', async () => {
    const w = await wedding(), helper = await wedding()
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(helper) })
    const id = me.json().id
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values ($1,$2,'helper')", [w.weddingId, id])
    const event = (await read(w))[0]!
    const reference = { kind: 'member', id }
    let saved = await put(w, [{ ...event, responsible: reference, participants: [reference] }])
    expect(saved.statusCode, saved.body).toBe(200)
    const removed = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/members/${id}`, headers: auth(w) })
    expect(removed.statusCode, removed.body).toBe(204)
    expect((await read(w))[0]).toMatchObject({ responsible: null, participants: [] })
    expect((await put(w, saved.json(), saved.headers.etag!)).statusCode).toBe(409)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values ($1,$2,'helper')", [w.weddingId, id])
    saved = await put(w, [{ ...(await read(w))[0]!, responsible: reference, participants: [reference] }])
    expect(saved.statusCode).toBe(200)
    const withdrawn = await app.inject({ method: 'DELETE', url: '/users/me/consent', headers: auth(helper) })
    expect(withdrawn.statusCode, withdrawn.body).toBe(204)
    expect((await read(w))[0]).toMatchObject({ responsible: null, participants: [] })
    expect((await put(w, saved.json(), saved.headers.etag!)).statusCode).toBe(409)
    await expect(app.db!.query("insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id) values ($1,$2,'responsible','member',$3)", [w.weddingId, event.id, id])).rejects.toMatchObject({ code: '23514' })
  })

  it('cancelling an assigned external contractor clears references and records the actual actor', async () => {
    const w = await wedding()
    const slots = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w) })
    const slot = slots.json()[0]
    const booked = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/external`, headers: { ...auth(w), 'idempotency-key': randomUUID() }, payload: { vendorName: 'Cancelled timeline contractor', price: { amount: 100000, currency: 'RUB' } } })
    expect(booked.statusCode).toBe(200)
    const reference = { kind: 'deal', id: booked.json().deal.id }
    const saved = await put(w, [{ ...(await read(w))[0]!, responsible: reference, participants: [reference] }])
    expect(saved.statusCode, saved.body).toBe(200)
    const cancelled = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/slots/${slot.id}/cancel`, headers: { ...auth(w), 'idempotency-key': randomUUID() } })
    expect(cancelled.statusCode, cancelled.body).toBe(200)
    const fresh = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(fresh.json()[0]).toMatchObject({ responsible: null, participants: [] })
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    expect(fresh.headers['x-timeline-updated-by']).toBe(me.json().id)
    expect((await put(w, saved.json(), saved.headers.etag!)).statusCode).toBe(409)
    await expect(app.db!.query("insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id) values ($1,$2,'participant','deal',$3)", [w.weddingId, fresh.json()[0].id, reference.id])).rejects.toMatchObject({ code: '23514' })
  })

  it('does not expose planning references through the guest day projection', async () => {
    const w = await wedding()
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'Private planning person' } })
    expect(guest.statusCode).toBe(201)
    const reference = { kind: 'guest', id: guest.json().id }
    const saved = await put(w, [{ ...(await read(w))[0]!, forGuests: true, responsible: reference, participants: [reference] }])
    expect(saved.statusCode).toBe(200)
    const token = await app.db!.query<{ invite_token: string }>('select p.invite_token from guest_parties p join guests g on g.party_id=p.id where g.id=$1', [reference.id])
    const day = await app.inject({ method: 'GET', url: `/join/${token.rows[0]!.invite_token}/day` })
    expect(day.statusCode, day.body).toBe(200)
    expect(day.json().timeline).toHaveLength(1)
    for (const field of ['responsible', 'participants', 'dependsOn', 'durationMinutes', 'fixed', 'travelMinutes', 'bufferMinutes']) {
      expect(day.json().timeline[0]).not.toHaveProperty(field)
    }
  })

  it('serializes simultaneous opposite dependency edges so neither transaction can commit a cycle', async () => {
    const w = await wedding(), events = await read(w)
    let inserted!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { inserted = resolve })
    const hold = new Promise<void>(resolve => { release = resolve })
    const first = app.db!.tx(async client => {
      await client.query('insert into timeline_dependencies(wedding_id,event_id,depends_on) values ($1,$2,$3)', [w.weddingId, events[0]!.id, events[1]!.id])
      inserted()
      await hold
    })
    await ready
    const second = app.db!.tx(async client => {
      await client.query('insert into timeline_dependencies(wedding_id,event_id,depends_on) values ($1,$2,$3)', [w.weddingId, events[1]!.id, events[0]!.id])
    })
    const rejection = expect(second).rejects.toMatchObject({ code: '23514' })
    release()
    await first
    await rejection
    expect((await read(w))[0]!.dependsOn).toEqual([events[1]!.id])
    expect((await read(w))[1]!.dependsOn).toEqual([])
  })

  it('database constraints reject negative travel, inconsistent duration and fixed blocks without starts', async () => {
    const w = await wedding(), events = await read(w)
    for (const sql of [
      'update timeline_events set travel_minutes=-1 where id=$1',
      'update timeline_events set buffer_minutes=10081 where id=$1',
      'update timeline_events set duration_minutes=1 where id=$1',
      'update timeline_events set fixed=true,starts_at=null,ends_at=null where id=$1',
    ]) await expect(app.db!.query(sql, [events[0]!.id])).rejects.toMatchObject({ code: '23514' })
    expect(await read(w)).toEqual(events)
  })

  it('changing the wedding date preserves fixed blocks and assigning the first date preserves planned duration', async () => {
    const w = await wedding(), events = await read(w)
    let saved = await put(w, [{ ...events[0]!, fixed: true }, { ...events[1]!, fixed: false }])
    expect(saved.statusCode, saved.body).toBe(200)
    let before = await read(w)
    const moved = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(moved.statusCode, moved.body).toBe(200)
    let after = await read(w)
    expect(after[0]).toEqual(before[0])
    expect(after[1]!.startsAt).not.toBe(before[1]!.startsAt)
    const undated = await wedding()
    await app.db!.query('update weddings set date=null where id=$1', [undated.weddingId])
    before = await read(undated)
    saved = await put(undated, [{ ...before[0]!, startsAt: null, endsAt: null, durationMinutes: 90 }])
    expect(saved.statusCode, saved.body).toBe(200)
    const dated = await app.inject({ method: 'PATCH', url: `/weddings/${undated.weddingId}`, headers: auth(undated), payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(dated.statusCode, dated.body).toBe(200)
    after = await read(undated)
    expect(after[0]!.durationMinutes).toBe(90)
    expect(Date.parse(after[0]!.endsAt!) - Date.parse(after[0]!.startsAt!)).toBe(90 * 60_000)
  })

  it('date/timezone context invalidates the editor even when every block is fixed or the program is empty', async () => {
    const w = await wedding(), events = await read(w)
    const saved = await put(w, events.map(e => ({ ...e, fixed: true })))
    expect(saved.statusCode).toBe(200)
    const before = await read(w)
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(await read(w)).toEqual(before)
    expect((await put(w, before, saved.headers.etag!)).statusCode).toBe(409)
    const cleared = await put(w, [])
    expect(cleared.statusCode).toBe(200)
    const tzChanged = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { tz: 'Europe/Moscow' } })
    expect(tzChanged.statusCode, tzChanged.body).toBe(200)
    const fresh = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    expect(fresh.headers.etag).not.toBe(cleared.headers.etag)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    expect(fresh.headers['x-timeline-updated-by']).toBe(me.json().id)
    expect((await put(w, [{ name: 'Old context' }], cleared.headers.etag!)).statusCode).toBe(409)
  })

  it('assigns the first date from block origin, not the edited sort, name or wedding format', async () => {
    const w = await wedding({ date: null, format: 'two_day' })
    const before = await read(w)
    const brunch = before.find(e => e.name === 'День 2: бранч')!
    const groom = before.find(e => e.name === 'Сборы жениха')!
    const saved = await put(w, [
      { ...brunch, name: 'Renamed brunch', durationMinutes: 90 },
      { name: 'Custom undated block', durationMinutes: 30 },
      { ...groom, name: 'Renamed preparations' },
    ])
    expect(saved.statusCode, saved.body).toBe(200)
    const date = `${new Date().getUTCFullYear() + 1}-07-01`
    await app.db!.query("update weddings set format='classic' where id=$1", [w.weddingId])
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { date } })
    expect(changed.statusCode, changed.body).toBe(200)
    const after = await read(w)
    expect(after.map(e => e.id)).toEqual(saved.json().map((e: Event) => e.id))
    expect(after[0]!.startsAt).toBe(`${date.slice(0, 8)}02T07:00:00.000Z`)
    expect(after[0]!.endsAt).toBe(`${date.slice(0, 8)}02T08:30:00.000Z`)
    expect(after[1]).toMatchObject({ startsAt: null, endsAt: null, durationMinutes: 30 })
    expect(after[2]!.startsAt).toBe(`${date}T04:00:00.000Z`)
    expect(after[2]!.endsAt).toBe(`${date}T07:00:00.000Z`)
  })

  it('does not invent a first-date template time for historical or custom blocks without origin', async () => {
    const w = await wedding({ date: null })
    // A real SQL row without provenance models pre-migration/custom history.
    await app.db!.query('delete from timeline_events where wedding_id=$1', [w.weddingId])
    const id = randomUUID()
    await app.db!.query('insert into timeline_events(id,wedding_id,name,sort,duration_minutes) values($1,$2,$3,0,30)', [id, w.weddingId, 'Сборы невесты'])
    const before = await read(w)
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(await read(w)).toEqual(before)
  })

  it('first-date origin does not overwrite manually scheduled or fixed blocks, or a deliberately unknown duration', async () => {
    const w = await wedding({ date: null })
    const before = await read(w)
    const manual = `${new Date().getUTCFullYear() + 1}-08-20T10:22:33.456Z`
    const saved = await put(w, [
      { ...before[2]!, startsAt: null, endsAt: null, durationMinutes: null },
      { ...before[0]!, startsAt: manual, endsAt: null, durationMinutes: 60, fixed: true },
      { ...before[1]!, startsAt: manual, endsAt: null, durationMinutes: 60 },
    ])
    expect(saved.statusCode, saved.body).toBe(200)
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w), payload: { date: `${new Date().getUTCFullYear() + 1}-07-01` } })
    expect(changed.statusCode, changed.body).toBe(200)
    const after = await read(w)
    expect(after[0]).toMatchObject({ durationMinutes: null, endsAt: null })
    expect(after[0]!.startsAt).toBe(`${new Date().getUTCFullYear() + 1}-07-01T07:00:00.000Z`)
    expect(after.slice(1)).toEqual(saved.json().slice(1))
  })

  async function eventList(w: Wedding) {
    return app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(w) })
  }

  async function createEvent(w: Wedding, name = 'Independent ceremony') {
    const snapshot = await eventList(w)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    return app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/events`,
      headers: { ...auth(w), 'if-match': snapshot.headers.etag! },
      payload: { name, kind: 'ceremony', date: `${new Date().getUTCFullYear() + 1}-06-15`, timeZone: 'Europe/Moscow', location: 'Actual ceremony venue' } })
  }

  it('creates one real main event and associates every original block without guessing named ceremonies', async () => {
    const w = await wedding({ date: null, format: 'two_day' })
    const response = await eventList(w)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json()).toHaveLength(1)
    const main = response.json()[0]
    expect(main).toMatchObject({ name: 'Основная программа', kind: 'other', isMain: true, date: null, timeZone: 'Asia/Yekaterinburg', location: null })
    expect((await read(w)).every(b => b.eventId === main.id)).toBe(true)
    expect(response.headers.etag).toMatch(/^"\d+"$/)
  })

  it('creates an independent dated event, assigns blocks by stable identity and preserves the link through omitted fields/autogen', async () => {
    const w = await wedding(), before = await read(w)
    const created = await createEvent(w)
    expect(created.statusCode, created.body).toBe(201)
    const selected = created.json()
    const saved = await put(w, [{ ...before[1]!, name: 'Assigned ceremony block', eventId: selected.id }, before[0]!])
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()[0].eventId).toBe(selected.id)
    const compatible = saved.json() as Event[]
    const { eventId: omitted, ...first } = compatible[0]!
    expect(omitted).toBe(selected.id)
    const repeated = await put(w, [first, compatible[1]!])
    expect(repeated.statusCode, repeated.body).toBe(200)
    expect(repeated.json()[0].eventId).toBe(selected.id)
    const preview = await app.inject({ method: 'POST', url: path(w) + '/autogen', headers: auth(w) })
    expect(preview.json().events[0]).toMatchObject({ id: before[1]!.id, eventId: selected.id })
  })

  it('rejects foreign/unknown event IDs atomically without leaking existence and normalizes UUID case', async () => {
    const w = await wedding(), foreign = await wedding()
    const other = await createEvent(foreign)
    expect(other.statusCode, other.body).toBe(201)
    const before = await read(w)
    for (const eventId of [other.json().id, randomUUID()]) {
      const rejected = await put(w, [{ ...before[0]!, eventId }])
      expect(rejected.statusCode, rejected.body).toBe(422)
      expect(await read(w)).toEqual(before)
    }
    const own = await createEvent(w)
    expect(own.statusCode, own.body).toBe(201)
    const saved = await put(w, [{ ...before[0]!, eventId: own.json().id.toUpperCase() }])
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json()[0].eventId).toBe(own.json().id)
    await expect(app.db!.query('update timeline_events set program_event_id=$2 where id=$1', [before[0]!.id, other.json().id])).rejects.toMatchObject({ code: '23503' })
  })

  it('event context changes invalidate an old editor and are reflected in the same snapshot version', async () => {
    const w = await wedding(), created = await createEvent(w)
    expect(created.statusCode, created.body).toBe(201)
    const before = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/events/${created.json().id}`,
      headers: { ...auth(w), 'if-match': before.headers.etag! }, payload: { timeZone: 'Asia/Vladivostok', location: 'Changed actual venue' } })
    expect(changed.statusCode, changed.body).toBe(200)
    expect(changed.headers.etag).not.toBe(before.headers.etag)
    expect((await put(w, before.json(), before.headers.etag!)).statusCode).toBe(409)
    const fresh = await eventList(w)
    expect(fresh.headers.etag).toBe(changed.headers.etag)
    expect(fresh.json().find((e: { id: string }) => e.id === created.json().id)).toMatchObject({ timeZone: 'Asia/Vladivostok', location: 'Changed actual venue' })
  })

  it('event writes reject missing/stale versions, unknown timezones and impossible dates without changes', async () => {
    const w = await wedding(), before = await eventList(w)
    expect(before.statusCode, before.body).toBe(200)
    const eventId = before.json()[0].id
    const eventUrl = `/weddings/${w.weddingId}/events/${eventId}`
    const missing = await app.inject({ method: 'PATCH', url: eventUrl, headers: auth(w), payload: { name: 'Unsafe main rename' } })
    expect(missing.statusCode).toBe(428)
    for (const patch of [{ timeZone: 'Unknown/Zone' }, { date: '2027-02-30' }, { name: '   ' }]) {
      const response = await app.inject({ method: 'PATCH', url: eventUrl, headers: { ...auth(w), 'if-match': before.headers.etag! }, payload: patch })
      expect(response.statusCode, response.body).toBe(422)
      expect((await eventList(w)).json()).toEqual(before.json())
    }
    const changed = await app.inject({ method: 'PATCH', url: eventUrl, headers: { ...auth(w), 'if-match': before.headers.etag! }, payload: { name: 'Main actual name' } })
    expect(changed.statusCode, changed.body).toBe(200)
    const stale = await app.inject({ method: 'PATCH', url: eventUrl, headers: { ...auth(w), 'if-match': before.headers.etag! }, payload: { name: 'Old rename' } })
    expect(stale.statusCode).toBe(409)
    expect((await eventList(w)).json()[0].name).toBe('Main actual name')
  })

  it('main date/venue/timezone follow the wedding context without moving independently dated event blocks', async () => {
    const w = await wedding(), blocks = await read(w), created = await createEvent(w)
    expect(created.statusCode, created.body).toBe(201)
    const saved = await put(w, [blocks[0]!, { ...blocks[1]!, eventId: created.json().id }])
    expect(saved.statusCode, saved.body).toBe(200)
    const changed = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}`, headers: auth(w),
      payload: { date: `${new Date().getUTCFullYear() + 1}-07-01`, tz: 'Europe/Moscow', venue: 'Main actual venue' } })
    expect(changed.statusCode, changed.body).toBe(200)
    const contexts = (await eventList(w)).json()
    expect(contexts.find((e: { isMain: boolean }) => e.isMain)).toMatchObject({ date: `${new Date().getUTCFullYear() + 1}-07-01`, timeZone: 'Europe/Moscow', location: 'Main actual venue' })
    expect(contexts.find((e: { id: string }) => e.id === created.json().id)).toEqual(created.json())
    const after = await read(w)
    expect(after[0]!.startsAt).not.toBe(blocks[0]!.startsAt)
    expect(after[1]).toEqual(saved.json()[1])
  })

  it('does not disclose independent event blocks through legacy guest day access', async () => {
    const w = await wedding(), created = await createEvent(w)
    expect(created.statusCode, created.body).toBe(201)
    const before = await read(w)
    const saved = await put(w, [{ ...before[0]!, forGuests: true }, { ...before[1]!, name: 'Private independent ceremony', forGuests: true, eventId: created.json().id }])
    expect(saved.statusCode).toBe(200)
    const guest = await app.inject({ method: 'POST', url: `/weddings/${w.weddingId}/guests`, headers: auth(w), payload: { name: 'Legacy main invitee' } })
    expect(guest.statusCode).toBe(201)
    const token = await app.db!.query<{ invite_token: string }>('select p.invite_token from guest_parties p join guests g on g.party_id=p.id where g.id=$1', [guest.json().id])
    const day = await app.inject({ method: 'GET', url: `/join/${token.rows[0]!.invite_token}/day` })
    expect(day.statusCode, day.body).toBe(200)
    expect(day.json().timeline.map((e: { id: string }) => e.id)).toEqual([before[0]!.id])
    expect(day.json().timeline[0]).not.toHaveProperty('eventId')
  })

  it('refuses deleting main/populated events and preserves timeline identities instead of cascading them', async () => {
    const w = await wedding(), created = await createEvent(w)
    expect(created.statusCode, created.body).toBe(201)
    const before = await read(w), main = (await eventList(w)).json()[0]
    const saved = await put(w, [{ ...before[0]!, eventId: created.json().id }])
    expect(saved.statusCode).toBe(200)
    for (const id of [main.id, created.json().id]) {
      const snapshot = await eventList(w)
      const deleted = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/events/${id}`, headers: { ...auth(w), 'if-match': snapshot.headers.etag! } })
      expect(deleted.statusCode, deleted.body).toBe(409)
      expect(await read(w)).toEqual(saved.json())
    }
    const cleared = await put(w, [{ ...saved.json()[0], eventId: main.id }])
    expect(cleared.statusCode).toBe(200)
    const deleted = await app.inject({ method: 'DELETE', url: `/weddings/${w.weddingId}/events/${created.json().id}`, headers: { ...auth(w), 'if-match': cleared.headers.etag! } })
    expect(deleted.statusCode, deleted.body).toBe(204)
    expect((await eventList(w)).json()).toHaveLength(1)
    const final = await read(w)
    await app.db!.query('delete from weddings where id=$1', [w.weddingId])
    expect(final[0]!.id).toBe(before[0]!.id)
    expect((await app.db!.query('select id from wedding_events where wedding_id=$1', [w.weddingId])).rowCount).toBe(0)
  })

  it('keeps event reads/writes private to the wedding and denies helper commands without affecting their timeline editing', async () => {
    const w = await wedding(), other = await wedding()
    const denied = await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/events`, headers: auth(other) })
    expect(denied.statusCode, denied.body).toBe(404)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(other) })
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values ($1,$2,'helper')", [w.weddingId, me.json().id])
    const helper = { ...other, weddingId: w.weddingId }
    const snapshot = await eventList(helper)
    expect(snapshot.statusCode, snapshot.body).toBe(200)
    const command = await app.inject({ method: 'PATCH', url: `/weddings/${w.weddingId}/events/${snapshot.json()[0].id}`,
      headers: { ...auth(helper), 'if-match': snapshot.headers.etag! }, payload: { name: 'Helper command' } })
    expect(command.statusCode, command.body).toBe(403)
    const saved = await put(helper, (await read(w)).map(b => ({ ...b, name: b.name + ' helper edit' })))
    expect(saved.statusCode, saved.body).toBe(200)
  })

  it('accepts exactly one concurrent event creation from the same program revision', async () => {
    const w = await wedding(), before = await eventList(w)
    const requests = ['First ceremony', 'Second ceremony'].map(name => app.inject({ method: 'POST',
      url: `/weddings/${w.weddingId}/events`, headers: { ...auth(w), 'if-match': before.headers.etag! }, payload: { name, kind: 'ceremony' } }))
    const results = await Promise.all(requests)
    expect(results.map(r => r.statusCode).sort()).toEqual([201, 409])
    const accepted = results.find(r => r.statusCode === 201)!
    const after = await eventList(w)
    expect(after.json()).toHaveLength(2)
    expect(after.json().find((e: { isMain: boolean }) => !e.isMain)).toEqual(accepted.json())
    expect(after.headers.etag).toBe(accepted.headers.etag)
    expect(after.headers['x-timeline-updated-by']).toBe((await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })).json().id)
  })

  it.each(['PUT', 'POST', 'PATCH', 'DELETE', 'GET'] as const)('%s rechecks membership after waiting for the wedding lock', async method => {
    const w = await wedding()
    const selected = method === 'DELETE' ? await createEvent(w) : null
    const before = await app.inject({ method: 'GET', url: path(w), headers: auth(w) })
    const contexts = await eventList(w)
    const me = await app.inject({ method: 'GET', url: '/users/me', headers: auth(w) })
    let held!: () => void, holderPid = 0
    const locked = new Promise<void>(resolve => { held = resolve })
    let entered!: () => void
    const waiting = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const original = app.db!.tx
    const blocker = original(async client => {
      holderPid = (await client.query<{pid:number}>('select pg_backend_pid() pid')).rows[0]!.pid
      await client.query('select id from weddings where id=$1 for update', [w.weddingId])
      held()
      await released
      await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, me.json().id])
    })
    await locked
    // Observe the real lock query; no SQL result or access check is mocked.
    app.db!.tx = action => original(client => action({ query: (sql, values) => {
      if (values?.[0] === w.weddingId && ((sql.includes('timeline_version::text') && /for (update|share)/.test(sql)) || sql.trim() === 'select id from weddings where id=$1 for update')) entered()
      return client.query(sql, values)
    } }))
    let save: ReturnType<typeof app.inject> | undefined
    try {
      const collection = `/weddings/${w.weddingId}/events`
      const target = method === 'PUT' ? path(w) : method === 'PATCH' ? `${collection}/${contexts.json()[0].id}`
        : method === 'DELETE' ? `${collection}/${selected!.json().id}` : collection
      const payload = method === 'PUT' ? [{ name: 'Revoked writer' }] : method === 'POST' ? { name: 'Revoked ceremony', kind: 'ceremony' }
        : method === 'PATCH' ? { name: 'Revoked main rename' } : undefined
      save = app.inject({ method, url: target, headers: { ...auth(w), 'if-match': before.headers.etag! }, ...(payload ? { payload } : {}) })
      // app.inject is lazy: start it before waiting for the observed query.
      const response = Promise.resolve(save)
      await waiting
      await observeNativeWeddingWait(holderPid)
      release()
      await blocker
      expect((await response).statusCode).toBe(404)
      const rows = await app.db!.query('select name from timeline_events where wedding_id=$1 order by sort', [w.weddingId])
      expect(rows.rows.map(e => e.name)).toEqual((before.json() as Event[]).map(e => e.name))
      const after = await app.db!.query('select id,name from wedding_events where wedding_id=$1 order by id', [w.weddingId])
      expect(after.rows).toEqual(contexts.json().map((e: { id: string; name: string }) => ({ id: e.id, name: e.name })).sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)))
    } finally {
      release()
      await blocker
      if (save) await save
      app.db!.tx = original
    }
  })
})
