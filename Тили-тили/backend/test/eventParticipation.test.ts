import { randomInt, randomUUID } from 'node:crypto'
import type { QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { loadEventParticipation, updateEventParticipation, syncMainParticipationFromLegacy, type ParticipationInput, type UpdateParticipationInput, type SyncMainParticipationInput } from '../src/wedding/participation.js'
import { lockOrderWedding } from '../src/orders/context.js'
import type { OrderActor } from '../src/orders/context.js'

const DB = process.env.TEST_DATABASE_URL
describe.skipIf(!DB)('event participation is person/event scoped', () => {
  let db: Db
  const weddings: string[] = [], users: string[] = []
  beforeAll(() => { db = createDb(DB!) })
  afterAll(async () => { for (const id of weddings) await db.query('delete from weddings where id=$1', [id]); for (const id of users) await db.query('delete from users where id=$1', [id]); await db.close() })
  async function fixture() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), eventId = randomUUID(), partyId = randomUUID(), token = randomUUID(), guestId = randomUUID(), secondGuestId = randomUUID()
    users.push(userId); weddings.push(weddingId)
    await db.query("insert into users(id,phone,name) values($1,$2,'Participation test')", [userId, '+79' + randomInt(100_000_000, 999_999_999)])
    await db.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId, userId, randomUUID()])
    await db.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(), userId])
    await db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Participation','2026-10-01','Europe/Moscow',$3)", [weddingId, userId, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, userId])
    await db.query("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Second','other','2026-10-02','Europe/Moscow',false)", [eventId, weddingId])
    await db.query('insert into guest_parties(id,wedding_id,invite_token) values($1,$2,$3)', [partyId, weddingId, token])
    await db.query("insert into guests(id,wedding_id,name,rsvp,rsvp_token,party_id,party_position) values($1,$3,'First','yes',$4,$5,1),($2,$3,'Second','pending',$6,$5,2)", [guestId, secondGuestId, weddingId, randomUUID(), partyId, randomUUID()])
    const main = (await db.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [weddingId])).rows[0]!.id
    const actor: OrderActor = { userId, sessionId, policyVersion: '2026-09-02' }
    return { weddingId, eventId, main, partyId, token, guestId, secondGuestId, actor }
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const input = (w: Fixture, eventId: string = w.eventId): ParticipationInput => ({ weddingId: w.weddingId, eventId, principal: { kind: 'team', actor: w.actor } })
  const read = (w: Fixture, eventId: string = w.eventId) => db.tx(c => loadEventParticipation(c, input(w, eventId)))
  const write = (w: Fixture, patch: Partial<UpdateParticipationInput> = {}) => db.tx(c => updateEventParticipation(c, { ...input(w), guestId: w.guestId, expectedVersion: '0', status: 'declined', ...patch }))
  const sync = (w: Fixture, patch: Partial<SyncMainParticipationInput> = {}) => db.tx(async c => {
    await lockOrderWedding(c, w.weddingId)
    return syncMainParticipationFromLegacy(c, { weddingId: w.weddingId, guestIds: [w.guestId], source: 'guest_response', actorUserId: null, ...patch })
  })
  it('main-only legacy fallback preserves real RSVP; second day starts unknown', async () => {
    const w = await fixture()
    expect((await read(w, w.main)).find(p => p.guestId === w.guestId)).toMatchObject({ status: 'attending', source: 'legacy_main_rsvp', version: '0', actorUserId: null, recordedAt: null })
    expect((await read(w)).find(p => p.guestId === w.guestId)).toMatchObject({ status: 'unknown', source: null, version: '0' })
    const changed = await write(w)
    expect(changed).toMatchObject({ version: '1', status: 'declined', source: 'team_observation', actorUserId: w.actor.userId })
    expect((await read(w, w.main)).find(p => p.guestId === w.guestId)?.status).toBe('attending')
    expect((await db.query('select rsvp from guests where id=$1', [w.guestId])).rows[0]?.rsvp).toBe('yes')
    expect((await read(w)).find(p => p.guestId === w.secondGuestId)?.status).toBe('unknown')
  })
  it.each(['couple', 'helper', 'coordinator'])('current %s can record its actual observation without pretending to be the guest', async role => {
    const w = await fixture(); await db.query('update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.weddingId, w.actor.userId, role])
    expect(await write(w)).toMatchObject({ source: 'team_observation', actorUserId: w.actor.userId })
  })
  it('vendor membership and missing membership are denied', async () => {
    const w = await fixture(); await db.query("update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2", [w.weddingId, w.actor.userId])
    await expect(write(w)).rejects.toMatchObject({ statusCode: 403 })
    await db.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.actor.userId])
    await expect(read(w)).rejects.toMatchObject({ statusCode: 404 })
  })
  it('guest token can change the selected person in its own party, with no fabricated user actor', async () => {
    const w = await fixture(), changed = await write(w, { principal: { kind: 'guest', token: w.token }, guestId: w.secondGuestId, status: 'attending' })
    expect(changed).toMatchObject({ guestId: w.secondGuestId, source: 'guest_response', actorUserId: null, version: '1' })
    const audit = (await db.query("select actor_id,diff from audit_log where entity_id=$1 and action='wedding.participation_changed'", [w.secondGuestId])).rows[0]!
    expect(audit.actor_id).toBeNull(); expect(audit.diff.source).toBe('guest_response')
    expect((await read(w)).find(p => p.guestId === w.guestId)?.status).toBe('unknown')
  })
  it('guest cannot read or write another party or wedding; team cannot select foreign event/person', async () => {
    const w = await fixture(), other = await fixture()
    await expect(write(w, { principal: { kind: 'guest', token: other.token } })).rejects.toMatchObject({ statusCode: 401 })
    await expect(write(w, { guestId: other.guestId })).rejects.toMatchObject({ statusCode: 404 })
    await expect(write(w, { eventId: other.eventId })).rejects.toMatchObject({ statusCode: 404 })
    const party = randomUUID(), person = randomUUID()
    await db.query('insert into guest_parties(id,wedding_id,invite_token) values($1,$2,$3)', [party, w.weddingId, randomUUID()])
    await db.query("insert into guests(id,wedding_id,name,rsvp_token,party_id) values($1,$2,'Other party',$3,$4)", [person, w.weddingId, randomUUID(), party])
    await expect(write(w, { principal: { kind: 'guest', token: w.token }, guestId: person })).rejects.toMatchObject({ statusCode: 404 })
    const visible = await db.tx(c => loadEventParticipation(c, { ...input(w), principal: { kind: 'guest', token: w.token } }))
    expect(visible).toHaveLength(2); expect(visible.some(p => p.guestId === person)).toBe(false)
  })
  it('version 0 inserts once; stale writes conflict; identical observation makes no fake history', async () => {
    const w = await fixture(), changed = await write(w)
    await expect(write(w)).rejects.toMatchObject({ statusCode: 409 })
    expect(await write(w, { expectedVersion: '1' })).toEqual(changed)
    expect((await db.query("select count(*)::text n from audit_log where entity_id=$1 and action='wedding.participation_changed'", [w.guestId])).rows[0]?.n).toBe('1')
    const guest = await write(w, { expectedVersion: '1', principal: { kind: 'guest', token: w.token } })
    expect(guest).toMatchObject({ version: '2', status: 'declined', source: 'guest_response', actorUserId: null })
  })
  it.each(['', '-1', '00', '1.0', '"0"'])('rejects malformed version %s without a row', async expectedVersion => {
    const w = await fixture(); await expect(write(w, { expectedVersion })).rejects.toMatchObject({ statusCode: 422 })
    expect((await read(w)).find(p => p.guestId === w.guestId)?.version).toBe('0')
  })
  it('concurrent missing-row updates produce one insert and one conflict', async () => {
    const w = await fixture(), results = await Promise.allSettled([write(w), write(w, { status: 'attending' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await db.query('select count(*)::text n from event_guest_participation where guest_id=$1', [w.guestId])).rows[0]?.n).toBe('1')
  })
  it('database rejects a foreign wedding guest/event combination', async () => {
    const w = await fixture(), other = await fixture()
    await expect(db.query("insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source) values($1,$2,$3,'attending','team_observation')", [w.weddingId, w.eventId, other.guestId])).rejects.toMatchObject({ code: '23503' })
  })
  it('audit failure rolls back participation and malformed identifiers/status fail clearly', async () => {
    const w = await fixture()
    await expect(db.tx(c => {
      const failAudit: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (/insert into audit_log/.test(sql)) return Promise.reject(new Error('Controlled audit failure'))
        return c.query<T>(sql, values)
      } }
      return updateEventParticipation(failAudit, { ...input(w), guestId: w.guestId, expectedVersion: '0', status: 'declined' })
    })).rejects.toThrow('Controlled audit failure')
    expect((await read(w)).find(p => p.guestId === w.guestId)?.version).toBe('0')
    await expect(write(w, { guestId: 'malformed' })).rejects.toMatchObject({ statusCode: 422 })
    await expect(write(w, { status: 'yes' as UpdateParticipationInput['status'] })).rejects.toMatchObject({ statusCode: 422 })
  })
  it('legacy main RSVP sync records actual guest source, no-op versions, and leaves day two and unaffected pending person alone', async () => {
    const w = await fixture(); await write(w, { status: 'attending' })
    // Existing migrated main row differs from the subsequent legacy RSVP command.
    await db.query("insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source) values($1,$2,$3,'attending','legacy_main_rsvp')", [w.weddingId, w.main, w.guestId])
    const changed = await db.tx(async c => {
      await lockOrderWedding(c, w.weddingId)
      await c.query("update guests set rsvp='no' where id=$1", [w.guestId])
      return syncMainParticipationFromLegacy(c, { weddingId: w.weddingId, guestIds: [w.guestId], source: 'guest_response', actorUserId: null })
    })
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ programEventId: w.main, status: 'declined', version: '2', source: 'guest_response', actorUserId: null })
    expect(await sync(w)).toEqual(changed)
    expect((await read(w)).find(p => p.guestId === w.guestId)).toMatchObject({ status: 'attending', version: '1', source: 'team_observation' })
    expect((await db.query('select count(*)::text n from event_guest_participation where guest_id=$1', [w.secondGuestId])).rows[0]?.n).toBe('0')
    const audit = await db.query("select actor_id,diff from audit_log where entity_id=$1 and diff->>'legacyCommand'='true'", [w.guestId])
    expect(audit.rows).toHaveLength(1); expect(audit.rows[0]?.actor_id).toBeNull()
    expect(audit.rows[0]?.diff).toMatchObject({ source: 'guest_response', beforeVersion: '1', status: 'declined' })
  })
  it('main sync creates a real affected person row and revises changed actual source/author without inventing other days', async () => {
    const w = await fixture()
    const first = await sync(w, { source: 'team_observation', actorUserId: w.actor.userId })
    expect(first[0]).toMatchObject({ status: 'attending', version: '1', source: 'team_observation', actorUserId: w.actor.userId })
    expect(await sync(w, { source: 'team_observation', actorUserId: w.actor.userId })).toEqual(first)
    expect((await sync(w))[0]).toMatchObject({ version: '2', source: 'guest_response', actorUserId: null })
    await db.query("update guests set rsvp='pending' where id=$1", [w.guestId])
    expect((await sync(w))[0]).toMatchObject({ version: '3', status: 'unknown' })
    expect((await read(w)).find(p => p.guestId === w.guestId)).toMatchObject({ source: null, version: '0', status: 'unknown' })
  })
  it('main sync rejects invalid source/author, foreign guest/wedding, malformed IDs and absence of canonical main before any write', async () => {
    const w = await fixture(), other = await fixture()
    for (const patch of [
      { source: 'legacy_main_rsvp' as SyncMainParticipationInput['source'] },
      { actorUserId: w.actor.userId },
      { source: 'team_observation' as const, actorUserId: null },
      { source: 'team_observation' as const, actorUserId: 'bad' },
      { guestIds: ['bad'] },
    ]) await expect(sync(w, patch)).rejects.toMatchObject({ statusCode: 422 })
    await expect(sync(w, { guestIds: [w.guestId, other.guestId] })).rejects.toMatchObject({ statusCode: 404 })
    await expect(sync(w, { weddingId: other.weddingId })).rejects.toMatchObject({ statusCode: 404 })
    await expect(sync(w, { weddingId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 })
    expect(await sync(w, { guestIds: [] })).toEqual([])
    expect((await db.query('select count(*)::text n from event_guest_participation where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe('0')
  })
  it('legacy RSVP and main sync roll back together if the audit fails', async () => {
    const w = await fixture()
    await expect(db.tx(async c => {
      await lockOrderWedding(c, w.weddingId)
      await c.query("update guests set rsvp='no' where id=$1", [w.guestId])
      const failAudit: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        if (/insert into audit_log/.test(sql)) return Promise.reject(new Error('Controlled audit failure'))
        return c.query<T>(sql, values)
      } }
      return syncMainParticipationFromLegacy(failAudit, { weddingId: w.weddingId, guestIds: [w.guestId], source: 'guest_response', actorUserId: null })
    })).rejects.toThrow('Controlled audit failure')
    expect((await db.query('select rsvp from guests where id=$1', [w.guestId])).rows[0]?.rsvp).toBe('yes')
    expect((await db.query('select count(*)::text n from event_guest_participation where guest_id=$1', [w.guestId])).rows[0]?.n).toBe('0')
  })
  it('main sync canonicalizes UUID case and duplicate people without fabricating new revisions', async () => {
    const w = await fixture(), first = await sync(w, { source: 'team_observation', actorUserId: w.actor.userId })
    expect(await sync(w, { guestIds: [w.guestId, w.guestId.toUpperCase()], source: 'team_observation', actorUserId: w.actor.userId.toUpperCase() })).toEqual(first)
  })
  it('guest scope accepts UUID case without changing the person/event identity', async () => {
    const w = await fixture()
    expect(await write(w, { weddingId: w.weddingId.toUpperCase(), eventId: w.eventId.toUpperCase(), guestId: w.guestId.toUpperCase(), principal: { kind: 'guest', token: w.token } }))
      .toMatchObject({ guestId: w.guestId, programEventId: w.eventId, source: 'guest_response', actorUserId: null })
  })
  it('wedding erase removes participation on both days without manual dependency cleanup', async () => {
    const w = await fixture(); await sync(w); await write(w)
    await db.tx(c => c.query('delete from weddings where id=$1', [w.weddingId]))
    expect((await db.query('select count(*)::text n from event_guest_participation where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe('0')
    expect((await db.query('select count(*)::text n from guests where wedding_id=$1', [w.weddingId])).rows[0]?.n).toBe('0')
  })
  it.each(['session_revoked', 'member_removed', 'wedding_cancelled', 'token_rotated', 'person_moved'] as const)('rechecks %s after waiting for the wedding lock', async action => {
    const w = await fixture(); let locked!: () => void, attempted!: () => void
    const hasLock = new Promise<void>(r => { locked = r }), hasAttempt = new Promise<void>(r => { attempted = r })
    const holder = db.tx(async c => {
      await c.query('select id from weddings where id=$1 for update', [w.weddingId]); locked(); await hasAttempt
      if (action === 'session_revoked') await c.query('update sessions set revoked_at=now() where id=$1', [w.actor.sessionId])
      if (action === 'member_removed') await c.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.weddingId, w.actor.userId])
      if (action === 'wedding_cancelled') await c.query('update weddings set cancelled_at=now() where id=$1', [w.weddingId])
      if (action === 'token_rotated') await c.query('update guest_parties set invite_token=$2 where id=$1', [w.partyId, randomUUID()])
      if (action === 'person_moved') {
        const party = randomUUID(); await c.query('insert into guest_parties(id,wedding_id,invite_token) values($1,$2,$3)', [party, w.weddingId, randomUUID()])
        await c.query('update guests set party_id=$2 where id=$1', [w.guestId, party])
      }
    })
    await hasLock
    const waiting = db.tx(c => {
      const observed: Queryable = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
        const result = c.query<T>(sql, values); if (/from weddings/.test(sql)) attempted(); return result
      } }
      return updateEventParticipation(observed, { ...input(w), guestId: w.guestId, expectedVersion: '0', status: 'declined',
        ...(action === 'token_rotated' || action === 'person_moved' ? { principal: { kind: 'guest' as const, token: w.token } } : {}) })
    })
    const outcome = expect(waiting).rejects.toMatchObject({ statusCode: action === 'session_revoked' || action === 'token_rotated' ? 401 : 404 })
    await holder; await outcome
    expect((await db.query('select count(*)::text n from event_guest_participation where guest_id=$1', [w.guestId])).rows[0]?.n).toBe('0')
  })
})
