/** Timeline 021 migration drill: existing event identities survive up/down/up.
 * This script refuses remote, populated or non-test databases. It deliberately
 * clears new graph metadata before rollback; it does not claim to preserve that
 * metadata after dropping the feature's tables.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const url = process.env.TEST_DATABASE_URL
assert(url && process.env.ALLOW_TIMELINE_MIGRATION_DRILL === 'yes', 'Explicit test-database opt-in is required')
const target = new URL(url)
assert(['127.0.0.1', 'localhost'].includes(target.hostname) && /^\/[a-z0-9_]+_test$/.test(target.pathname),
  'Only a named disposable local *_test database is allowed')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREVIOUS = '1761700000000_payment_methods_privacy'
const IDENTITY = '1761700000000_timeline_identity_and_version'
const GRAPH = '1761800000000_timeline_graph'
const client = new pg.Client({ connectionString: url })
function migrate(...args) {
  const command = spawnSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', '-m', 'migrations', ...args],
    { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  assert.equal(command.status, 0, `Migration ${args.join(' ')} failed; database credentials are not logged`)
}
await client.connect()
try {
  const existing = await client.query("select to_regclass('public.users') as users")
  if (existing.rows[0].users) {
    assert.equal((await client.query('select count(*)::int as n from users')).rows[0].n, 0,
      'Refusing to rehearse on a populated database')
  }
  // Pin the last shipped payment migration, not whichever migration is newest.
  migrate('up', PREVIOUS)
  const owner = randomUUID(), outsider = randomUUID(), wedding = randomUUID(), other = randomUUID()
  const parent = randomUUID(), child = randomUUID(), foreignEvent = randomUUID()
  await client.query("insert into users(id,phone) values($1,'+79000000212'),($2,'+79000000213')", [owner, outsider])
  await client.query("insert into weddings(id,owner_id,title,invite_code,tz,date) values($1,$2,'Timeline drill',$3,'Asia/Yekaterinburg','2027-06-14'),($4,$5,'Other wedding',$6,'UTC','2027-06-14')",
    [wedding, owner, randomUUID(), other, outsider, randomUUID()])
  await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($3,$4,'couple')",
    [wedding, owner, other, outsider])
  await client.query(`insert into timeline_events(id,wedding_id,name,starts_at,ends_at,sort,for_guests,outdoor)
    values($1,$2,'Legacy private','2027-06-14 08:00:00+00','2027-06-14 09:00:00+00',0,false,true),
          ($3,$2,'Legacy visible','2027-06-14 10:00:00+00','2027-06-14 11:00:00+00',1,true,false),
          ($4,$5,'Foreign',null,null,0,true,false)`, [parent, wedding, child, foreignEvent, other])
  const legacy = async () => (await client.query(`select id::text,name,starts_at::text,ends_at::text,sort,for_guests,outdoor
    from timeline_events where wedding_id=$1 order by sort`, [wedding])).rows
  const before = await legacy()
  migrate('up', GRAPH)
  assert.deepEqual(await legacy(), before)
  assert.equal((await client.query('select timeline_version from weddings where id=$1', [wedding])).rows[0].timeline_version, 1)
  const modes = await client.query('select distinct timing_mode from timeline_events where wedding_id=$1', [wedding])
  assert.deepEqual(modes.rows, [{ timing_mode: 'flexible' }])
  await client.query("update timeline_events set timing_mode='fixed' where id=$1", [child])
  await client.query('insert into timeline_event_dependencies(wedding_id,event_id,depends_on_event_id,travel_minutes,buffer_minutes) values($1,$2,$3,15,30)',
    [wedding, child, parent])
  await client.query('insert into timeline_event_members(wedding_id,event_id,user_id) values($1,$2,$3)', [wedding, child, owner])
  await assert.rejects(client.query('insert into timeline_event_dependencies(wedding_id,event_id,depends_on_event_id) values($1,$2,$3)',
    [wedding, child, foreignEvent]), error => error.code === '23503')
  await assert.rejects(client.query('insert into timeline_event_members(wedding_id,event_id,user_id) values($1,$2,$3)',
    [wedding, child, outsider]), error => error.code === '23503')
  const slot = randomUUID(), deal = randomUUID()
  await client.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Foreign photo')", [slot, other])
  await client.query("insert into deals(id,wedding_id,slot_id,external_name,state) values($1,$2,$3,'Foreign performer','booked')", [deal, other, slot])
  await assert.rejects(client.query('insert into timeline_event_deals(wedding_id,event_id,deal_id) values($1,$2,$3)',
    [wedding, child, deal]), error => error.code === '23503')
  const latest = async () => (await client.query('select name from pgmigrations order by id desc limit 1')).rows[0].name
  assert.equal(await latest(), GRAPH)
  // New graph metadata is explicitly discarded only in this disposable drill.
  await client.query('delete from timeline_event_dependencies where wedding_id=$1', [wedding])
  await client.query('delete from timeline_event_members where wedding_id=$1', [wedding])
  await client.query("update timeline_events set timing_mode='flexible' where wedding_id=$1", [wedding])
  migrate('down', '1')
  assert.equal(await latest(), IDENTITY)
  migrate('down', '1')
  assert.equal(await latest(), PREVIOUS)
  assert.deepEqual(await legacy(), before)
  assert.equal((await client.query("select count(*)::int as n from information_schema.columns where table_name='payments' and column_name='visibility'")).rows[0].n, 1)
  migrate('up', GRAPH)
  assert.deepEqual(await legacy(), before)
  assert.equal((await client.query('select count(*)::int as n from timeline_event_dependencies')).rows[0].n, 0)
  process.stdout.write(JSON.stringify({ status: 'passed', previous: PREVIOUS, migrations: [IDENTITY, GRAPH],
    legacyEventIdsPreserved: true, legacyTimesAndVisibilityPreserved: true, initialVersion: 1,
    crossWeddingEventMemberDealForeignKeysEnforced: true, paymentPrivacyNotRolledBack: true,
    cycle: ['up', 'down graph', 'down identity', 'up'],
    limitation: 'New graph metadata was explicitly cleared before the disposable rollback; only legacy event data preservation is asserted.' }, null, 2) + '\n')
} finally {
  await client.end()
}
