import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { QueryResultRow } from 'pg'
import { createDb, type Db, type Queryable } from '../src/plugins/db.js'
import { loadAttention, updateAttention, type AttentionState, type UpdateAttentionInput } from '../src/wedding/attention.js'
import { decidePush, type PushPolicyInput } from '../src/notify/policy.js'

const attention: AttentionState = { version: '1', mode: 'essential', effectiveMode: 'essential', coordinatorUserId: null, coordinatorState: 'not_selected', coordinator: null }
const policy = (patch: Partial<PushPolicyInput> = {}) => decidePush({ purpose: 'operational', recipientRole: 'couple', attention,
  pushEnabled: true, urgentIncidents: false, incidentVerified: false, ...patch })

describe('attention push policy does not infer urgency or authority', () => {
  it('information stays silent even with opt-in and verification', () => {
    expect(policy({ purpose: 'information', urgentIncidents: true, incidentVerified: true })).toEqual({ push: 'none', requiresIncidentContext: false })
  })
  it.each(['essential', 'coordinator'] as const)('generic couple progress is silent in %s but its own duty is actionable', mode => {
    const state = { ...attention, mode, effectiveMode: mode }
    expect(policy({ attention: state }).push).toBe('none')
    expect(policy({ attention: state, assignedToRecipient: true }).push).toBe('normal')
  })
  it('detailed couple gets overview without changing vendor duties', () => {
    const state = { ...attention, mode: 'detailed' as const, effectiveMode: 'detailed' as const }
    expect(policy({ attention: state }).push).toBe('normal')
    expect(policy({ attention: state, recipientRole: 'vendor' }).push).toBe('none')
  })
  it.each(['helper', 'coordinator', 'vendor', 'guest'] as const)('unassigned %s is silent; its own scope is actionable', recipientRole => {
    expect(policy({ recipientRole }).push).toBe('none')
    expect(policy({ recipientRole, assignedToRecipient: true }).push).toBe('normal')
  })
  it('only the selected active coordinator gets the coordinator overview', () => {
    const state: AttentionState = { ...attention, mode: 'coordinator', effectiveMode: 'coordinator', coordinatorState: 'active',
      coordinatorUserId: 'selected', coordinator: { id: 'selected', name: 'Name' } }
    expect(policy({ attention: state, recipientRole: 'coordinator', isSelectedCoordinator: true }).push).toBe('normal')
    expect(policy({ attention: state, recipientRole: 'coordinator' }).push).toBe('none')
    expect(policy({ attention: { ...state, coordinatorState: 'unavailable', effectiveMode: 'essential' }, recipientRole: 'coordinator', isSelectedCoordinator: true }).push).toBe('none')
    expect(policy({ attention: state, recipientRole: 'helper', isSelectedCoordinator: true }).push).toBe('none')
  })
  it.each(['helper', 'coordinator', 'guest'] as const)('decision never grants %s financial authority', recipientRole => {
    expect(policy({ purpose: 'decision', recipientRole, assignedToRecipient: true }).push).toBe('none')
  })
  it.each(['couple', 'vendor'] as const)('authorized %s decision gets normal quiet-aware push', recipientRole => {
    expect(policy({ purpose: 'decision', recipientRole, urgentIncidents: true, incidentVerified: true }).push).toBe('normal')
  })
  it.each([[false, false], [false, true], [true, false], [true, true]])('incident verified=%s opt-in=%s requires context and both for bypass', (incidentVerified, urgentIncidents) => {
    expect(policy({ purpose: 'incident', incidentVerified, urgentIncidents })).toEqual({ push: incidentVerified && urgentIncidents ? 'urgent' : 'normal', requiresIncidentContext: true })
  })
  it('disabled push is never revived by mode, assignment or verified urgent incident', () => {
    expect(policy({ purpose: 'incident', pushEnabled: false, incidentVerified: true, urgentIncidents: true })).toEqual({ push: 'none', requiresIncidentContext: true })
    expect(policy({ assignedToRecipient: true, pushEnabled: false }).push).toBe('none')
  })
})

const DB = process.env.TEST_DATABASE_URL
describe.skipIf(!DB)('attention persisted choices and post-lock access', () => {
  let db: Db
  const weddings: string[] = [], users: string[] = []
  beforeAll(() => { db = createDb(DB!) })
  afterAll(async () => {
    for (const id of weddings) await db.query('delete from weddings where id=$1', [id])
    for (const id of users) await db.query('delete from users where id=$1', [id])
    await db.close()
  })
  async function user() {
    const id = randomUUID(); users.push(id)
    await db.query('insert into users(id,phone,name) values($1,$2,$3)', [id, '+79' + randomInt(100_000_000, 999_999_999), 'Attention test'])
    return id
  }
  async function fixture() {
    const owner = await user(), coordinator = await user(), id = randomUUID(); weddings.push(id)
    await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Attention',$3)", [id, owner, randomUUID()])
    await db.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'coordinator')", [id, owner, coordinator])
    return { id, owner, coordinator }
  }
  const change = (w: Awaited<ReturnType<typeof fixture>>, patch: Partial<UpdateAttentionInput> = {}) =>
    db.tx(client => updateAttention(client, { weddingId: w.id, actorUserId: w.owner, expectedVersion: '1', ...patch }))
  it('legacy default is essential and personal urgency is off', async () => {
    const w = await fixture()
    expect(await loadAttention(db, w.id)).toEqual(attention)
    await db.query('insert into notification_prefs(user_id) values($1)', [w.owner])
    expect((await db.query('select urgent_incidents from notification_prefs where user_id=$1', [w.owner])).rows[0]!.urgent_incidents).toBe(false)
  })
  it('chosen accepted coordinator is active, versioned and audited under actual actor', async () => {
    const w = await fixture(), changed = await change(w, { mode: 'coordinator', coordinatorUserId: w.coordinator })
    expect(changed).toMatchObject({ version: '2', mode: 'coordinator', effectiveMode: 'coordinator', coordinatorState: 'active', coordinator: { id: w.coordinator } })
    const audit = await db.query("select actor_id,diff from audit_log where entity_id=$1 and action='wedding.attention_changed'", [w.id])
    expect(audit.rows).toHaveLength(1); expect(audit.rows[0]!.actor_id).toBe(w.owner)
    expect(audit.rows[0]!.diff).toMatchObject({ before: { version: '1' }, after: { version: '2' } })
    expect(await loadAttention(db, w.id)).toEqual(changed)
  })
  it('no selected coordinator means essential fallback, never automatically selects a live one', async () => {
    const w = await fixture()
    expect(await change(w, { mode: 'coordinator' })).toMatchObject({ mode: 'coordinator', effectiveMode: 'essential', coordinatorState: 'not_selected', coordinator: null })
  })
  it('stale version refuses without changing selection or appending audit', async () => {
    const w = await fixture(); await change(w, { mode: 'detailed' })
    await expect(change(w, { mode: 'coordinator' })).rejects.toMatchObject({ statusCode: 409, code: 'attention_version_conflict' })
    expect((await loadAttention(db, w.id)).mode).toBe('detailed')
    expect((await db.query("select 1 from audit_log where entity_id=$1 and action='wedding.attention_changed'", [w.id])).rows).toHaveLength(1)
  })
  it.each(['0', '-1', '1.0', '"1"', ''])('rejects malformed expected version %s without mutation', async expectedVersion => {
    const w = await fixture()
    await expect(change(w, { expectedVersion, mode: 'detailed' })).rejects.toMatchObject({ statusCode: 422 })
    expect(await loadAttention(db, w.id)).toEqual(attention)
  })
  it('audit failure rolls back the actual settings and revision update', async () => {
    const w = await fixture()
    const write = db.tx(client => {
      const failAudit: Queryable = { query: (sql, values) => {
        if (/insert into audit_log/.test(sql)) throw new Error('Controlled audit failure')
        return client.query(sql, values)
      } }
      return updateAttention(failAudit, { weddingId: w.id, actorUserId: w.owner, expectedVersion: '1', mode: 'detailed' })
    })
    await expect(write).rejects.toThrow('Controlled audit failure')
    expect(await loadAttention(db, w.id)).toEqual(attention)
    expect((await db.query("select 1 from audit_log where entity_id=$1 and action='wedding.attention_changed'", [w.id])).rows).toHaveLength(0)
  })
  it('omission preserves selection; explicit null clears it; unchanged write does not fabricate a new revision', async () => {
    const w = await fixture(); await change(w, { mode: 'coordinator', coordinatorUserId: w.coordinator })
    const kept = await change(w, { expectedVersion: '2', mode: 'detailed' })
    expect(kept.coordinatorUserId).toBe(w.coordinator)
    expect((await change(w, { expectedVersion: '3', mode: 'detailed' })).version).toBe('3')
    expect(await change(w, { expectedVersion: '3', coordinatorUserId: null })).toMatchObject({ version: '4', coordinatorUserId: null, coordinatorState: 'not_selected' })
  })
  it.each(['helper', 'coordinator', 'vendor'])('%s cannot write settings', async role => {
    const w = await fixture(); await db.query('update wedding_members set role=$3 where wedding_id=$1 and user_id=$2', [w.id, w.coordinator, role])
    await expect(change(w, { actorUserId: w.coordinator, mode: 'detailed' })).rejects.toMatchObject({ statusCode: 403 })
    expect((await loadAttention(db, w.id)).version).toBe('1')
  })
  it('foreign member and deleted actor cannot write', async () => {
    const w = await fixture(), other = await fixture()
    await expect(change(w, { actorUserId: other.owner, mode: 'detailed' })).rejects.toMatchObject({ statusCode: 404 })
    await db.query('update users set deleted_at=now() where id=$1', [w.owner])
    await expect(change(w, { mode: 'detailed' })).rejects.toMatchObject({ statusCode: 404 })
  })
  it('unaccepted invite and foreign coordinator are not eligible; failure rolls back', async () => {
    const w = await fixture(), pending = await user(), other = await fixture()
    await db.query("insert into invites(code,wedding_id,role,created_by,expires_at) values($1,$2,'coordinator',$3,now()+interval '1 day')", [randomUUID(), w.id, w.owner])
    for (const coordinatorUserId of [pending, other.coordinator]) {
      await expect(change(w, { mode: 'coordinator', coordinatorUserId })).rejects.toMatchObject({ statusCode: 422 })
    }
    expect(await loadAttention(db, w.id)).toEqual(attention)
  })
  it.each(['demote', 'remove', 'delete_user'])('coordinator %s becomes unavailable and exposes no stale name', async action => {
    const w = await fixture(); await change(w, { mode: 'coordinator', coordinatorUserId: w.coordinator })
    if (action === 'demote') await db.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2", [w.id, w.coordinator])
    if (action === 'remove') await db.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.id, w.coordinator])
    if (action === 'delete_user') await db.query('update users set deleted_at=now() where id=$1', [w.coordinator])
    expect(await loadAttention(db, w.id)).toMatchObject({ mode: 'coordinator', effectiveMode: 'essential', coordinatorState: 'unavailable', coordinator: null })
    expect(await change(w, { expectedVersion: '2', mode: 'detailed' })).toMatchObject({ coordinatorState: 'unavailable', coordinator: null })
  })
  it.each(['archived_at', 'cancelled_at'])('inactive %s wedding cannot be read or updated', async field => {
    const w = await fixture(); await db.query(`update weddings set ${field}=now() where id=$1`, [w.id])
    await expect(loadAttention(db, w.id)).rejects.toMatchObject({ statusCode: 404 })
    await expect(change(w, { mode: 'detailed' })).rejects.toMatchObject({ statusCode: 404 })
  })
  it.each(['actor_removed', 'actor_deleted', 'coordinator_removed', 'cancelled', 'version_changed'])('rechecks %s after waiting for the real wedding lock', async action => {
    const w = await fixture()
    let locked!: () => void, attempted!: () => void
    const hasLock = new Promise<void>(resolve => { locked = resolve }), isAttempted = new Promise<void>(resolve => { attempted = resolve })
    const holder = db.tx(async client => {
      await client.query('select id from weddings where id=$1 for update', [w.id]); locked()
      await isAttempted
      if (action === 'actor_removed') await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.id, w.owner])
      if (action === 'actor_deleted') await client.query('update users set deleted_at=now() where id=$1', [w.owner])
      if (action === 'coordinator_removed') await client.query('delete from wedding_members where wedding_id=$1 and user_id=$2', [w.id, w.coordinator])
      if (action === 'cancelled') await client.query('update weddings set cancelled_at=now() where id=$1', [w.id])
      if (action === 'version_changed') await client.query('update weddings set attention_version=2 where id=$1', [w.id])
    })
    await hasLock
    const waiting = db.tx(client => {
      const observed: Queryable = {
        query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]) {
          const query = client.query<T>(sql, values)
          if (/for update/.test(sql)) attempted()
          return query
        },
      }
      return updateAttention(observed, { weddingId: w.id, actorUserId: w.owner, expectedVersion: '1', mode: 'coordinator', coordinatorUserId: w.coordinator })
    })
    const expected = action === 'coordinator_removed' ? 422 : action === 'version_changed' ? 409 : 404
    const outcome = expect(waiting).rejects.toMatchObject({ statusCode: expected })
    await holder; await outcome
    expect((await db.query("select 1 from audit_log where entity_id=$1 and action='wedding.attention_changed'", [w.id])).rows).toHaveLength(0)
  })
  it('two writers from the same version produce one update and one conflict', async () => {
    const w = await fixture(), results = await Promise.allSettled([change(w, { mode: 'detailed' }), change(w, { mode: 'coordinator' })])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
    expect((await loadAttention(db, w.id)).version).toBe('2')
  })
})
