import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { disposablePgPort } from './disposablePgPort.js'

// A physical safety mutex is not evidence that a DATE constructor ran.
// These controls exercise native transaction/subtransaction visibility. Actual
// DATE classification and head completeness remain covered by the DAY suites.
describe.sequential('371 native DATE constructor intent', () => {
  let client: Client
  beforeAll(async () => {
    const connection = process.env.TEST_DATABASE_URL
    assert(connection, 'Native TEST_DATABASE_URL is required; no skip/fallback')
    assert.equal(process.env.DATABASE_URL, connection)
    const url = new URL(connection)
    assert(['postgres:', 'postgresql:'].includes(url.protocol))
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    assert.equal(url.port, '15432'); assert.equal(disposablePgPort(), '15432')
    assert.equal(url.username, 'codex_test'); assert.equal(url.password, '')
    assert.equal(url.pathname, '/tili_ecosystem_full_20260930_test')
    assert.equal(url.search, ''); assert.equal(url.hash, '')
    client = new Client({ connectionString: connection, application_name: 'calendar371_day_mutex_controls',
      connectionTimeoutMillis: 5000, statement_timeout: 12000, idle_in_transaction_session_timeout: 15000 })
    await client.connect()
    const identity = (await client.query<{ name: string; principal: string; port: number; oid: string; pid: number }>(
      `select current_database() name,current_user principal,inet_server_port() port,
       (select oid::text from pg_database where datname=current_database()) oid,pg_backend_pid() pid`)).rows[0]!
    expect(identity.name).toBe(url.pathname.slice(1)); expect(identity.principal).toBe('codex_test')
    expect(identity.port).toBe(15432); expect(Number(identity.oid)).toBeGreaterThan(0)
    const journal = (await client.query<{ name: string }>('select name from pgmigrations order by name')).rows
    expect(journal).toHaveLength(94)
    expect(journal.at(-1)?.name).toBe('1763920000000_legacy_calendar_bounds')
    process.stdout.write(`CALENDAR371_DAY_MUTEX_OPEN ${JSON.stringify({ ...identity, nodePID: process.pid,
      owner: 'root/calendar371-day-mutex-tests', at: new Date().toISOString(), cwd: process.cwd() })}\n`)
  })
  afterAll(async () => {
    if (client) {
      try { await client.query('rollback') } finally { await client.end() }
      process.stdout.write('CALENDAR371_DAY_MUTEX_CLOSED rollback=true endResolved=true\n')
    }
  })
  async function tx(body: () => Promise<void>) {
    await client.query('begin')
    try { await body() } finally { await client.query('rollback') }
  }
  async function note(ids: string[], explicit = false) {
    await client.query('select legacy_calendar_bounds_note_day_mutex($1::uuid[],$2)', [ids, explicit])
  }
  async function explicit(ids: string[]) {
    await client.query('select legacy_day_lock_vendors($1::uuid[])', [ids])
  }
  async function locked(id: string) {
    return (await client.query<{ value: boolean }>('select legacy_calendar_bounds_discovery_locked($1) value', [id])).rows[0]!.value
  }
  async function x(id: string) {
    await client.query('select pg_advisory_xact_lock(176387,hashtext($1::uuid::text))', [id])
  }
  async function safety(ids: string[], nonwaiting = false) {
    const scope = Object.fromEntries(['weddings', 'requests', 'deals', 'slots', 'orders', 'accounts',
      'staff', 'resources', 'windows', 'allocations', 'sources', 'days', 'persons', 'sessions', 'keys'].map(k => [k, []]))
    // Internal native lock primitive only: nonexistent IDs create no business
    // fixtures or consent. The actual row/ACL prefixes are tested separately.
    await client.query('select legacy_calendar_bounds_pin_scope($1::jsonb,false,$2)', [JSON.stringify({ ...scope, vendors: ids }), nonwaiting])
  }
  async function refused(sql: string, values: unknown[], constraint: string) {
    await client.query('savepoint expected_refusal')
    try { await expect(client.query(sql, values)).rejects.toMatchObject({ code: '23514', constraint }) }
    finally { await client.query('rollback to savepoint expected_refusal') }
  }

  it.each([false, true])('a repeated safety prefix retains unknown intent (NOWAIT=%s)', async nonwaiting => tx(async () => {
    const id = randomUUID()
    await safety([id], nonwaiting); expect(await locked(id)).toBe(false)
    await safety([id], nonwaiting); await note([id]); expect(await locked(id)).toBe(false)
    const row = (await client.query<{ explicit_intent: boolean; own: boolean }>(
      `select explicit_intent,backend_pid=pg_backend_pid() and transaction_id=txid_current() own
       from pg_temp.legacy_calendar_bounds_day_mutex`)).rows
    expect(row).toEqual([{ explicit_intent: false, own: true }])
  }))
  it('VOLATILE discovery sees the earlier false note within the same native statement', async () => tx(async () => {
    const id = randomUUID()
    assert.match(id, /^[0-9a-f-]{36}$/)
    await client.query(`do $probe$ begin
      perform legacy_calendar_bounds_note_day_mutex(array['${id}'::uuid],false);
      perform pg_advisory_xact_lock(176387,hashtext('${id}'::uuid::text));
      if legacy_calendar_bounds_discovery_locked('${id}'::uuid) then
        raise exception 'Safety mutex fabricated constructor intent';
      end if;
    end $probe$`)
    expect(await locked(id)).toBe(false)
  }))
  it('the real explicit constructor marks both its acquire and already-held exits', async () => tx(async () => {
    const id = randomUUID()
    await explicit([id]); expect(await locked(id)).toBe(true)
    await note([id]); await explicit([id]); expect(await locked(id)).toBe(true)
  }))
  it('an explicit call after safety promotes false on the already-held exit', async () => tx(async () => {
    const id = randomUUID()
    await safety([id]); expect(await locked(id)).toBe(false)
    await explicit([id]); expect(await locked(id)).toBe(true)
  }))
  it('a preheld old X without a marker retains the old discovery contract', async () => tx(async () => {
    const id = randomUUID()
    await x(id); expect(await locked(id)).toBe(true)
    await note([id]); expect(await locked(id)).toBe(true)
  }))
  it('a complete multi-vendor union keeps every safety key false', async () => tx(async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    await safety(ids)
    for (const id of ids) expect(await locked(id)).toBe(false)
    await safety([...ids].reverse())
    for (const id of ids) expect(await locked(id)).toBe(false)
    await explicit(ids)
    for (const id of ids) expect(await locked(id)).toBe(true)
  }))
  it('real signed hash collisions share safety and explicit intent', async () => tx(async () => {
    // Native PG16 search: md5('calendar371-collision-'||n)::uuid,
    // n=1..200000, grouped by hashtext(id::text). Never assume collision.
    const ids = ['5b69ced5-e513-ed71-2af2-d89e56fa244f', 'a6274faa-06e2-a894-bf41-2d01982b0731']
    const hashes = (await client.query<{ key: number }>('select hashtext(id::text) key from unnest($1::uuid[]) id', [ids])).rows
    expect(hashes).toEqual([{ key: -882479918 }, { key: -882479918 }])
    await safety([ids[0]!]); await safety([ids[1]!])
    expect(await locked(ids[0]!)).toBe(false); expect(await locked(ids[1]!)).toBe(false)
    expect((await client.query('select * from pg_temp.legacy_calendar_bounds_day_mutex')).rowCount).toBe(1)
    await explicit([ids[1]!]); expect(await locked(ids[0]!)).toBe(true)
  }))
  it('rollback to SAVEPOINT restores a parent false marker after explicit promotion', async () => tx(async () => {
    const id = randomUUID(); await safety([id]); await client.query('savepoint child')
    await explicit([id]); expect(await locked(id)).toBe(true)
    await client.query('rollback to savepoint child'); expect(await locked(id)).toBe(false)
    await explicit([id]); expect(await locked(id)).toBe(true)
  }))
  it('a registry and locks born in an aborted child leave no intent behind', async () => tx(async () => {
    const id = randomUUID(); await client.query('savepoint child'); await safety([id])
    await client.query('rollback to savepoint child')
    expect((await client.query<{ name: string | null }>("select to_regclass('pg_temp.legacy_calendar_bounds_day_mutex')::text name")).rows[0]!.name).toBe(null)
    expect(await locked(id)).toBe(false)
    await safety([id]); expect(await locked(id)).toBe(false)
  }))
  it('exception rollback preserves a parent explicit marker and allows a real retry', async () => tx(async () => {
    const id = randomUUID(); await explicit([id])
    await refused('select legacy_calendar_bounds_note_day_mutex(null::uuid[],false)', [], 'legacy_day_lock_order')
    expect(await locked(id)).toBe(true); await note([id]); expect(await locked(id)).toBe(true)
  }))
  it('late lower-key extension still refuses with the original lock-order constraint', async () => tx(async () => {
    const ids = Array.from({ length: 8 }, () => randomUUID())
    const ordered = (await client.query<{ id: string; key: number }>(
      'select distinct on(hashtext(id::text)) id,hashtext(id::text) key from unnest($1::uuid[]) id order by hashtext(id::text),id', [ids])).rows
    assert(ordered.length >= 2, 'Native signed keys must actually differ')
    const lower = ordered[0]!.id, higher = ordered.at(-1)!.id
    expect(ordered[0]!.key).toBeLessThan(ordered.at(-1)!.key)
    await safety([higher])
    await refused('select legacy_day_lock_vendors($1::uuid[])', [[lower]], 'legacy_day_lock_order')
    expect(await locked(higher)).toBe(false); expect(await locked(lower)).toBe(false)
  }))
  it('an incompatible temporary registry is refused before intent can be read or written', async () => tx(async () => {
    const id = randomUUID(); await x(id)
    await client.query('create temporary table legacy_calendar_bounds_day_mutex(mutex_key integer) on commit drop')
    await refused('select legacy_calendar_bounds_note_day_mutex($1::uuid[],false)', [[id]], 'legacy_calendar_bounds_old_date_functions')
    await refused('select legacy_calendar_bounds_discovery_locked($1::uuid)', [id], 'legacy_calendar_bounds_old_date_functions')
  }))
  it.each(['backend_pid', 'transaction_id'] as const)('a marker with another %s is refused', async field => tx(async () => {
    const id = randomUUID(); await safety([id])
    await client.query(`update pg_temp.legacy_calendar_bounds_day_mutex set ${field}=${field}-1`)
    await refused('select legacy_calendar_bounds_note_day_mutex($1::uuid[],false)', [[id]], 'legacy_calendar_bounds_old_date_functions')
    await refused('select legacy_calendar_bounds_discovery_locked($1::uuid)', [id], 'legacy_calendar_bounds_old_date_functions')
  }))
  it('COMMIT drops intent; the same backend starts the next transaction unknown', async () => {
    const id = randomUUID()
    await client.query('begin')
    try { await explicit([id]); expect(await locked(id)).toBe(true); await client.query('commit') }
    catch (error) { await client.query('rollback'); throw error }
    expect((await client.query<{ name: string | null }>("select to_regclass('pg_temp.legacy_calendar_bounds_day_mutex')::text name")).rows[0]!.name).toBe(null)
    await tx(async () => { await safety([id]); expect(await locked(id)).toBe(false) })
  })
})
