import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Queryable } from '../src/plugins/db.js'
import { cleanup, eraseUser } from '../src/jobs/index.js'
import { prepareLegacyCalendarScope } from '../src/resources/legacy-calendar-scope.js'
import { Calendar371Fixture, ok } from './calendarBounds371.fixtures.js'

type Frame = Record<string, string[]>
const tombstone = (id: string) => {
  // Independent Node SHA implementation of the frozen domain-separated UUID contract.
  const hex = createHash('sha256').update(`legacy-calendar-erased-person/1:${id}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Real eraseUser consumes the global transport TTL: Root registers this file
 * in the serial lane. No teardown deletes retained keys, links or failed data. */
describe.sequential('C6 native orphan erasure, immutable references and whole rollback', { timeout: 240_000 }, () => {
  const h = new Calendar371Fixture(), tombs = new Set<string>()
  beforeAll(async () => {
    await h.open()
    expect((await h.db.query<{ ready: boolean }>(`select
      to_regprocedure('public.legacy_calendar_bounds_scrub_erased_person(uuid)') is not null
      and to_regprocedure('public.legacy_calendar_bounds_person_orphan(uuid)') is not null ready`)).rows[0]!.ready,
    'SETUP_C6: functions must be installed; missing DDL is not a domain RED').toBe(true)
  }, 30_000)
  afterAll(async () => {
    process.stdout.write(`C6_ERASURE_OWN_TOMBS ${JSON.stringify({ retainedForRoot: true, ids: [...tombs] })}\n`)
    await h.close()
  }, 30_000)

  async function frame(client: Queryable = h.db): Promise<Frame> {
    const names = (await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename)
    expect(names.length, 'SETUP_C6: whole current schema94 tables, including journal/audit').toBe(124)
    const result: Frame = {}
    for (const name of names) result[name] = await h.raw(name, 'true', [], client)
    return result
  }
  function sameFrame(actual: Frame, expected: Frame): void {
    expect(Object.keys(actual)).toEqual(Object.keys(expected))
    // Never put raw cache bodies/read tokens into a failing assertion dump.
    for (const name of Object.keys(expected)) expect(JSON.stringify(actual[name]) === JSON.stringify(expected[name]), `literal table ${name}`).toBe(true)
  }
  async function repeatWithoutWrites(id: string): Promise<void> {
    const before = await frame()
    await h.db.tx(client => eraseUser(client, id))
    sameFrame(await frame(), before)
  }

  it('C6-E01 actual orphan owner erasure keeps one pseudonymous key and literal owner-link fields, then fresh repeat writes nothing', async () => {
    const c = await h.company(), tomb = tombstone(c.owner.id); tombs.add(tomb)
    const links = await h.raw('legacy_calendar_person_links', 'person_identity=$1', [c.owner.id])
    expect(links).toHaveLength(1)
    const keyCount = (await h.db.query<{ n: number }>('select count(*)::int n from resource_conflict_keys')).rows[0]!.n
    expect((await h.db.query('select identity from resource_conflict_keys where identity=$1', [tomb])).rows).toEqual([])
    const softDelete = await h.call(c.owner, 'DELETE', '/users/me')
    expect(softDelete.statusCode, 'actual public account deletion request').toBe(204)
    // SYNTHETIC_OLD_JOBS_SETUP: advance only this already-soft-deleted owner
    // beyond the real hard-erasure TTL, then execute the genuine global job.
    await h.db.query("update users set deleted_at=now()-interval '31 days' where id=$1 and deleted_at is not null", [c.owner.id])
    await cleanup(h.app)
    expect((await h.db.query('select id from users where id=$1', [c.owner.id])).rows).toEqual([])
    expect((await h.db.query('select id from vendors where id=$1', [c.id])).rows).toEqual([])
    expect((await h.db.query("select identity from resource_conflict_keys where kind='person' and identity=$1", [c.owner.id])).rows).toEqual([])
    expect((await h.db.query("select identity from resource_conflict_keys where kind='person' and identity=$1", [tomb])).rows).toEqual([{ identity: tomb }])
    expect((await h.db.query<{ n: number }>('select count(*)::int n from resource_conflict_keys')).rows[0]!.n).toBe(keyCount)
    const expected = links.map(raw => ({ ...JSON.parse(raw) as Record<string, unknown>, person_identity: tomb }))
    const after = (await h.raw('legacy_calendar_person_links', 'vendor_identity=$1', [c.id])).map(raw => JSON.parse(raw) as Record<string, unknown>)
    expect(after).toEqual(expected)
    // Global TTL cleanup may legitimately change other expired fixtures. Only
    // the following fresh erasure retry is required to leave all tables literal.
    await repeatWithoutWrites(c.owner.id)
  })

  it.each(['arbitrary-person', 'deterministic-tomb'] as const)('C6-E02 raw %s rewrite of a live owner link is refused with literal whole rollback', async change => {
    const c = await h.company(), foreign = await h.actor()
    const target = change === 'arbitrary-person' ? foreign.id : tombstone(c.owner.id)
    const before = await frame()
    await expect(h.db.tx(client => client.query(
      'update legacy_calendar_person_links set person_identity=$2 where vendor_identity=$1 and person_identity=$3',
      [c.id, target, c.owner.id]))).rejects.toMatchObject({ code: '23514', constraint: 'legacy_calendar_bounds_immutable' })
    sameFrame(await frame(), before)
  })

  it('C6-E03 deterministic tomb collision refuses the actual erase transaction without merging or losing any row', async () => {
    const c = await h.company(), tomb = tombstone(c.owner.id); tombs.add(tomb)
    expect((await h.db.query('select identity from resource_conflict_keys where identity=$1', [tomb])).rows).toEqual([])
    // A valid owned technical key is the collision fixture, not a fake consent or resource.
    await h.db.query("insert into resource_conflict_keys(kind,identity) values('person',$1)", [tomb])
    const before = await frame(); let callbackComplete = false
    await expect(h.db.tx(async client => {
      await eraseUser(client, c.owner.id)
      callbackComplete = true
    })).rejects.toMatchObject({ code: '23514', constraint: 'legacy_calendar_bounds_immutable', message: 'Erased person pseudonym collision' })
    expect(callbackComplete).toBe(false)
    sameFrame(await frame(), before)
  })

  it('C6-E04 released foreign person allocation is still required history after actual owner erasure and a fresh repeat', async () => {
    const c = await h.company(), foreign = await h.company()
    const ready = await h.ready(foreign, 'person', '2027-08-10T10:00:00Z', '2027-08-10T11:00:00Z', c.owner)
    ok(await h.commit(ready), 'genuine schema2 foreign-person resource commitment')
    // Valid nonzero economic witnesses use the existing cohort fixture schema;
    // these are owned money rows, never fabricated calendar/terms agreements.
    await h.db.query("insert into payments(id,deal_id,kind,amount,status,payment_method,visibility) values($1,$2,'deposit',777,'recorded','cash','private')", [randomUUID(), ready.deal])
    await h.db.query("insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,'C6 retained foreign dated obligation',10000,'2027-09-13')", [randomUUID(), ready.deal])
    ok(await h.call(ready.pair, 'PATCH', `/deals/${ready.deal}`, { state: 'cancelled' }), 'genuine cancellation releases recorded allocation')
    const allocated = (await h.db.query<{ id: string; released_at: Date | null }>(
      'select id,released_at from resource_allocations where deal_id=$1', [ready.deal])).rows
    expect(allocated).toHaveLength(1); expect(allocated[0]!.released_at).not.toBeNull()
    const before = {
      allocations: await h.raw('resource_allocations', 'deal_id=$1', [ready.deal]),
      occupancy: await h.raw('resource_occupancy', 'allocation_id=$1', [allocated[0]!.id]),
      links: await h.raw('legacy_calendar_person_links', 'person_identity=$1', [c.owner.id]),
      key: await h.raw('resource_conflict_keys', "kind='person' and identity=$1", [c.owner.id]),
      resource: await h.raw('vendor_resources', 'id=$1', [ready.resource]), money: await h.finance(),
      counters: await h.counters(foreign), days: await h.raw('vendor_busy_dates', 'vendor_id=$1', [foreign.id]),
    }
    expect(before.key).toHaveLength(1); expect(before.occupancy).toHaveLength(1); expect(before.links.length).toBeGreaterThan(1)
    expect(before.money.payments!.some(raw => { const row = JSON.parse(raw) as Record<string, unknown>; return row.deal_id === ready.deal && String(row.amount) === '777' })).toBe(true)
    expect(before.money.payment_installments!.some(raw => { const row = JSON.parse(raw) as Record<string, unknown>; return row.deal_id === ready.deal && String(row.amount) === '10000' && row.due === '2027-09-13' })).toBe(true)
    await h.db.tx(client => eraseUser(client, c.owner.id))
    expect((await h.db.query('select id from users where id=$1', [c.owner.id])).rows).toEqual([])
    expect((await h.db.query('select id from vendors where id=$1', [c.id])).rows).toEqual([])
    expect(await h.raw('resource_allocations', 'deal_id=$1', [ready.deal])).toEqual(before.allocations)
    expect(await h.raw('resource_occupancy', 'allocation_id=$1', [allocated[0]!.id])).toEqual(before.occupancy)
    expect(await h.raw('legacy_calendar_person_links', 'person_identity=$1', [c.owner.id])).toEqual(before.links)
    expect(await h.raw('resource_conflict_keys', "kind='person' and identity=$1", [c.owner.id])).toEqual(before.key)
    const expectedResource = before.resource.map(raw => ({ ...JSON.parse(raw) as Record<string, unknown>, person_user_id: null }))
    expect((await h.raw('vendor_resources', 'id=$1', [ready.resource])).map(raw => JSON.parse(raw) as Record<string, unknown>)).toEqual(expectedResource)
    expect(await h.finance()).toEqual(before.money); expect(await h.counters(foreign)).toEqual(before.counters)
    expect(await h.raw('vendor_busy_dates', 'vendor_id=$1', [foreign.id])).toEqual(before.days)
    // The account is now absent: rejection must also preserve the real retained
    // person graph, rather than rely only on the live-user negative control.
    const retained = await frame()
    await expect(h.db.tx(client => client.query(
      'update legacy_calendar_person_links set person_identity=$2 where vendor_identity=$1 and person_identity=$3',
      [foreign.id, tombstone(c.owner.id), c.owner.id]))).rejects.toMatchObject({ code: '23514', constraint: 'legacy_calendar_bounds_immutable' })
    sameFrame(await frame(), retained)
    await repeatWithoutWrites(c.owner.id)
  })

  it('C6-E05 a real outer COMMIT failure rolls back a completed orphan scrub with all public tables and audit literal', async () => {
    const c = await h.cohort(1), orphan = await h.company(), tomb = tombstone(orphan.owner.id); tombs.add(tomb)
    const source = (await h.liveSources(c.company)).find(row => row.kind === 'app_root')
    assert(source, 'SETUP_C6: actual public-book source required')
    const proposed = await h.propose(c.company, source.id)
    assert(proposed.proposal, 'SETUP_C6: actual public proposal required')
    const proposedId = proposed.proposal.id
    const next = randomUUID(), before = await frame(); let callbackComplete = false
    await expect(h.db.tx(async client => {
      await prepareLegacyCalendarScope(client, { sourceIds: [source.id], weddingIds: [c.wedding],
        vendorIds: [c.company.id, orphan.id], personIds: [orphan.owner.id], extraAccountIds: [orphan.owner.id],
        actor: h.actorInput(c.company.owner), mode: 'erase' })
      // Existing native deferred-completeness boundary (CB371-T02): valid FK
      // parents, but no finished next-version holder/head graph at outer COMMIT.
      await client.query(`insert into legacy_calendar_bounds_versions(id,source_id,inventory_version_id,version,previous_version_id,wedding_id,company_id,
        source_revision,inventory_revision,inventory_digest,source_fingerprint,declaration,canonical,digest,staffing_completeness,association_fingerprint,
        created_by,created_session_id,policy_version)
        select $1,source_id,inventory_version_id,version+1,id,wedding_id,company_id,source_revision,inventory_revision,inventory_digest,
        source_fingerprint,declaration,canonical,digest,staffing_completeness,association_fingerprint,created_by,created_session_id,policy_version
        from legacy_calendar_bounds_versions where id=$2`, [next, proposedId])
      await eraseUser(client, orphan.owner.id)
      expect((await client.query('select id from users where id=$1', [orphan.owner.id])).rows).toEqual([])
      expect((await client.query("select identity from resource_conflict_keys where kind='person' and identity=$1", [orphan.owner.id])).rows).toEqual([])
      expect((await client.query("select identity from resource_conflict_keys where kind='person' and identity=$1", [tomb])).rows).toEqual([{ identity: tomb }])
      callbackComplete = true
    })).rejects.toMatchObject({ code: '23514', constraint: 'legacy_calendar_bounds_complete' })
    expect(callbackComplete).toBe(true)
    sameFrame(await frame(), before)
  })
})