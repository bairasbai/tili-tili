import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import pg from 'pg'

// This is a local schema/fixture drill. Historical receipt fixtures are
// synthetic database history, never proof of real human consent or delivery.
// No fake migration mode, schema drops, database deletion or Redis access.
const DATABASES = [
  'tili_ecosystem_migration_drill10_20260930_test',
  'tili_ecosystem_migration_drill11_20260930_test',
  'tili_ecosystem_migration_drill12_20260930_test',
  'tili_ecosystem_migration_drill13_20260930_test',
  'tili_ecosystem_migration_drill14_20260930_test',
  'tili_ecosystem_migration_drill15_20260930_test',
  'tili_ecosystem_migration_drill16_20260930_test',
  'tili_ecosystem_migration_drill17_20260930_test',
  'tili_ecosystem_migration_drill18_20260930_test',
  'tili_ecosystem_migration_drill19_20260930_test',
  'tili_ecosystem_migration_drill20_20260930_test',
  'tili_ecosystem_migration_drill21_20261003_test',
]
const selectedPort = process.env.TILI_DISPOSABLE_PG_PORT ?? '55432'
assert(['55432', '15432'].includes(selectedPort), 'Only the explicitly approved disposable cluster ports are allowed')
const FIRST = 1763000000000, PRE_IDENTITY = 1763510000000, PREPLAN = 1763550000000, PRECOMMITMENT = 1763610000000, PRE_INVENTORY = 1763700000000, PRE_RECOVERY = 1763800000000, RECOVERY = 1763810000000, LATEST = 1763820000000
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Local disposable runs: the original isolated clone and, after the 030 merge, the main checkout.
const localCheckout = ['C:/Тили-тили/ecosystem-local-20260930/Тили-тили/backend', 'C:/Тили-тили/Тили-тили_код_и_документация/Тили-тили/backend', 'C:/Тили-тили/tili-orchestrate-publish-20261003/Тили-тили/backend']
  .includes(backend.replaceAll('\\', '/'))
const repositoryCi = process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REPOSITORY === 'bairasbai/tili-tili'
  && process.env.GITHUB_WORKSPACE && backend === resolve(process.env.GITHUB_WORKSPACE, 'Тили-тили/backend')
assert(localCheckout || repositoryCi, 'Only the isolated checkout or this repository CI checkout is allowed')
assert.equal(resolve(process.cwd()), backend, 'Run from the isolated backend')
const migrationsDir = resolve(backend, 'migrations')
const cli = resolve(backend, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js')
const expectedOwn = [
  '1763000000000_notification_deliveries', '1763100000000_wedding_attention',
  '1763200000000_notification_push_disposition', '1763250000000_notification_timezone',
  '1763260000000_attention_selection_invalidation', '1763300000000_order_structure',
  '1763310000000_order_erase_deferred',
  '1763320000000_notification_comment_rollback',
  '1763400000000_order_terms', '1763410000000_terms_receipt_digest',
  '1763450000000_vendor_staff', '1763500000000_vendor_resources',
  '1763510000000_staff_duty_event_scope',
  '1763550000000_staff_invitation_identity',
  '1763600000000_order_resource_plan', '1763610000000_resource_plan_head_integrity',
  '1763650000000_resource_commitments', '1763660000000_commitment_proof_guard',
  '1763670000000_commitment_trigger_records', '1763680000000_commitment_history_cascade',
  '1763690000000_allocation_release_proof',
  '1763700000000_event_rsvp_deadlines',
  '1763800000000_legacy_calendar_sources',
  '1763810000000_legacy_calendar_day_recovery',
  '1763820000000_planb_system_template_keys',
]
function validateUrl(raw) {
  assert(raw, 'Both explicit database URLs are required')
  const url = new URL(raw)
  assert(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL URL required')
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback is allowed')
  assert.equal(url.port, selectedPort, 'URL must target the explicitly selected local test cluster port')
  assert.equal(url.username, 'codex_test', 'Only the local test principal is allowed')
  assert.equal(url.password, '', 'No password-bearing connection is permitted')
  assert(DATABASES.includes(decodeURIComponent(url.pathname.slice(1))), 'An explicitly approved exact disposable database name is required')
  assert.equal(url.search, '', 'Connection overrides are forbidden')
  assert.equal(url.hash, '', 'URL fragments are forbidden')
  return url.href
}
const databaseUrl = validateUrl(process.env.DATABASE_URL)
assert.equal(validateUrl(process.env.TEST_DATABASE_URL), databaseUrl, 'Do not mix application and test databases')
const DATABASE = decodeURIComponent(new URL(databaseUrl).pathname.slice(1))
function migrationManifest() {
  const files = readdirSync(migrationsDir).filter(name => /^\d{13}_.+\.cjs$/.test(name)).sort()
  assert(files.length > 0)
  assert(files.every(name => Number(name.slice(0, 13)) <= LATEST), 'Later migrations require a new reviewed drill')
  const own = files.filter(name => Number(name.slice(0, 13)) >= FIRST).map(name => name.slice(0, -4))
  assert.deepEqual(own, expectedOwn, 'Unknown or missing migration in the approved range')
  return files.map(name => ({ name: name.slice(0, -4), digest: createHash('sha256').update(readFileSync(resolve(migrationsDir, name))).digest('hex') }))
}
const manifest = migrationManifest()
const db = new pg.Client({ connectionString: databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 5000 })
await db.connect()
async function safety() {
  assert.equal(process.env.TILI_DISPOSABLE_PG_PORT ?? '55432', selectedPort, 'Selected disposable port changed during the drill')
  assert.equal(validateUrl(process.env.DATABASE_URL), databaseUrl)
  assert.equal(validateUrl(process.env.TEST_DATABASE_URL), databaseUrl)
  const identity = (await db.query('select current_database() as name, current_user as principal, host(inet_server_addr()) as address, inet_server_port() as port')).rows[0]
  assert.equal(identity.name, DATABASE)
  assert.equal(identity.principal, 'codex_test')
  assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(identity.address), 'Live server must also be loopback')
  assert.equal(identity.port, Number(selectedPort))
  assert.deepEqual(migrationManifest(), manifest, 'Migration source changed during the drill')
}
async function write(sql, values = []) {
  await safety()
  return db.query(sql, values)
}
async function migrate(direction, target, failureMessage, exactFile = false) {
  await safety()
  // --timestamp down includes the target: >=176300 rolls back all approved own files.
  // -t would select a migration-table NAME, not a timestamp or target.
  // The installed CLI also accepts an exact migration NAME as its positional
  // argument (runner options.file). This tests each populated down independently
  // without a newer guard masking it, changing the journal, or bypassing order checks.
  if (exactFile) assert(direction === 'down' && expectedOwn.includes(target), 'Exact-file down must name an approved migration')
  const result = spawnSync(process.execPath, [cli, direction, String(target), ...(exactFile ? [] : ['--timestamp']), '-m', migrationsDir,
    '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false'],
  { cwd: backend, env: { ...process.env, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  if (exactFile) {
    assert.deepEqual([...output.matchAll(/^> - (.+)$/gm)].map(match => match[1].trim()), [target],
      'Actual native runner must announce only the exact requested down file; a later guard cannot mask this witness')
  }
  if (failureMessage) {
    assert.notEqual(result.status, 0, 'A destructive rollback unexpectedly succeeded')
    assert(!result.error, 'A subprocess error is not evidence of a migration guard')
    assert(output.includes(failureMessage), `Rollback failed for another reason:\n${output}`)
    console.log(`Expected guarded rollback${exactFile ? ` of exact file ${target}` : ''}: ${failureMessage}`)
  } else {
    assert.equal(result.status, 0, `Actual migration command failed:\n${output}`)
    console.log(`Actual migration ${direction} ${target} complete`)
  }
}
const quote = value => `"${value.replaceAll('"', '""')}"`
async function columns(table) {
  return (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by ordinal_position`, [table])).rows.map(row => row.column_name)
}
async function rows(table, columnNames) {
  const select = columnNames ? columnNames.map(quote).join(',') : '*'
  return (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as value from (select ${select} from public.${quote(table)}) t`)).rows[0].value
}
async function journalNames() { return (await db.query('select name from pgmigrations order by id')).rows.map(row => row.name) }
async function assertJournal(names) { assert.deepEqual(await journalNames(), names) }
async function snapshot() {
  await safety()
  const tables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename)
  const data = {}
  for (const table of tables) data[table] = await rows(table)
  const schema = {
    extensions: (await db.query(`select e.extname,e.extversion,pg_get_userbyid(e.extowner) as owner,n.nspname as schema,
      e.extrelocatable,e.extconfig,e.extcondition,obj_description(e.oid,'pg_extension') as comment
      from pg_extension e join pg_namespace n on n.oid=e.extnamespace order by e.extname`)).rows,
    extensionMembers: (await db.query(`select e.extname,x.type,x.schema,x.name,x.identity from pg_depend d
      join pg_extension e on e.oid=d.refobjid cross join lateral pg_identify_object(d.classid,d.objid,d.objsubid) x
      where d.refclassid='pg_extension'::regclass and d.deptype='e' order by e.extname,x.type,x.schema,x.name,x.identity`)).rows,
    operatorClasses: (await db.query(`select c.opcname,a.amname,c.opcintype::regtype::text as input_type,c.opckeytype::regtype::text as key_type,
      c.opcdefault,f.opfname as family,pg_get_userbyid(c.opcowner) as owner,obj_description(c.oid,'pg_opclass') as comment
      from pg_opclass c join pg_namespace n on n.oid=c.opcnamespace join pg_am a on a.oid=c.opcmethod
      join pg_opfamily f on f.oid=c.opcfamily where n.nspname='public' order by c.opcname,a.amname`)).rows,
    operatorFamilies: (await db.query(`select f.opfname,a.amname,pg_get_userbyid(f.opfowner) as owner,obj_description(f.oid,'pg_opfamily') as comment,
      array(select concat_ws('|',o.amoplefttype::regtype::text,o.amoprighttype::regtype::text,o.amopstrategy,o.amoppurpose,o.amopopr::regoperator::text)
        from pg_amop o where o.amopfamily=f.oid order by o.amoplefttype::regtype::text,o.amoprighttype::regtype::text,o.amopstrategy,o.amoppurpose) as operators,
      array(select concat_ws('|',p.amproclefttype::regtype::text,p.amprocrighttype::regtype::text,p.amprocnum,p.amproc::regprocedure::text)
        from pg_amproc p where p.amprocfamily=f.oid order by p.amproclefttype::regtype::text,p.amprocrighttype::regtype::text,p.amprocnum) as procedures
      from pg_opfamily f join pg_namespace n on n.oid=f.opfnamespace join pg_am a on a.oid=f.opfmethod where n.nspname='public' order by f.opfname,a.amname`)).rows,
    operators: (await db.query(`select o.oprname,o.oprleft::regtype::text as left_type,o.oprright::regtype::text as right_type,
      o.oprresult::regtype::text as result_type,o.oprcode::regprocedure::text as procedure,pg_get_userbyid(o.oprowner) as owner,
      obj_description(o.oid,'pg_operator') as comment from pg_operator o join pg_namespace n on n.oid=o.oprnamespace
      where n.nspname='public' order by o.oprname,o.oprleft::regtype::text,o.oprright::regtype::text`)).rows,
    namespaces: (await db.query("select nspname,pg_get_userbyid(nspowner) as owner,nspacl,obj_description(oid,'pg_namespace') as comment from pg_namespace where nspname='public'")).rows,
    relations: (await db.query(`select c.relname,c.relkind,c.relpersistence,pg_get_userbyid(c.relowner) as owner,c.relacl,c.reloptions,c.relrowsecurity,c.relforcerowsecurity,c.relispartition,
      obj_description(c.oid,'pg_class') as comment,case when c.relkind in ('v','m') then pg_get_viewdef(c.oid,true) else null end as view_definition,
      pg_get_expr(c.relpartbound,c.oid,true) as partition_bound from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname`)).rows,
    columns: (await db.query("select * from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows,
    columnMetadata: (await db.query(`select c.relname,a.attname,a.attacl,col_description(c.oid,a.attnum) as comment from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows,
    constraints: (await db.query(`select c.relname as table_name,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid,true) as definition
      from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,k.conname`)).rows,
    indexes: (await db.query("select tablename,indexname,indexdef from pg_indexes where schemaname='public' order by tablename,indexname")).rows,
    triggers: (await db.query(`select c.relname as table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`)).rows,
    functions: (await db.query(`select p.proname,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition,pg_get_userbyid(p.proowner) as owner,p.proacl,obj_description(p.oid,'pg_proc') as comment from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p') order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows,
    types: (await db.query(`select t.typname,t.typtype,t.typcategory,t.typnotnull,t.typdefault,t.typdelim,t.typacl,pg_get_userbyid(t.typowner) as owner,
      format_type(t.typbasetype,t.typtypmod) as base_type,obj_description(t.oid,'pg_type') as comment,
      array(select e.enumlabel from pg_enum e where e.enumtypid=t.oid order by e.enumsortorder) as enum_labels
      from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname`)).rows,
    sequenceDefinitions: (await db.query(`select c.relname,format_type(s.seqtypid,null) as data_type,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle,
      target.relname as owned_table,a.attname as owned_column,d.deptype from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_depend d on d.objid=c.oid and d.classid='pg_class'::regclass and d.refclassid='pg_class'::regclass and d.deptype in ('a','i')
      left join pg_class target on target.oid=d.refobjid left join pg_attribute a on a.attrelid=d.refobjid and a.attnum=d.refobjsubid
      where n.nspname='public' order by c.relname`)).rows,
  }
  // Runtime sequence last_value is deliberately excluded: PostgreSQL nextval
  // consumption is not rolled back. Definition, ownership, ACL and comments
  // are checked; this drill does not promise transactional counter restoration.
  return { data, schema }
}
const legacyTables = ['users', 'sessions', 'weddings', 'wedding_members', 'vendors', 'slots', 'deals', 'payments', 'budget_items', 'vendor_busy_dates',
  'wedding_events', 'timeline_events', 'timeline_assignments', 'guest_parties', 'guests', 'vendor_program_acknowledgments', 'external_invites',
  'external_program_acknowledgments', 'notifications', 'notification_prefs', 'push_subscriptions']
async function legacySnapshot(layout) {
  const result = {}
  for (const table of legacyTables) result[table] = await rows(table, layout[table])
  return result
}
async function assertNoBusinessData() {
  for (const table of legacyTables) assert.equal((await db.query(`select count(*)::int as count from public.${quote(table)}`)).rows[0].count, 0, `Empty rollback requires no ${table} rows`)
  for (const table of ['notification_push_deliveries', 'deal_orders', 'order_assignments', 'order_parts', 'event_guest_participation', 'deal_terms_versions', 'deal_terms_receipts',
    'vendor_staff_members', 'vendor_staff_duties', 'vendor_resources', 'vendor_availability_policy', 'resource_capacity_windows', 'deal_resource_plan_versions',
    'resource_conflict_keys', 'deal_resource_commitments', 'deal_resource_commitment_versions', 'resource_allocations', 'deal_resource_commitment_members',
    'event_rsvp_requests', 'legacy_calendar_sources', 'legacy_calendar_versions', 'legacy_calendar_version_holders', 'legacy_calendar_heads']) {
    assert.equal((await db.query(`select count(*)::int as count from public.${quote(table)}`)).rows[0].count, 0)
  }
}

async function fixture(withHistory, phonePrefix = '+1555000000') {
  const f = Object.fromEntries(['owner', 'vendorOwner', 'coordinator', 'session', 'wedding', 'vendor', 'slot', 'externalSlot', 'deal', 'externalDeal', 'secondEvent', 'timeline', 'guestYes', 'guestNo', 'guestUnknown',
    'deposit', 'balance', 'refund', 'budget', 'pushedNotification', 'plannedNotification', 'subscription', 'inviteIdentity'].map(key => [key, randomUUID()]))
  await write('begin')
  try {
    for (const [index, id] of [f.owner, f.vendorOwner, f.coordinator].entries()) {
      await write("insert into users(id,phone,name,tz) values($1,$2,$3,'Europe/Moscow')", [id, `${phonePrefix}${index}`, `Synthetic migration participant ${index}`])
    }
    await write('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [f.session, f.vendorOwner, createHash('sha256').update(randomUUID()).digest('hex')])
    await write("insert into weddings(id,owner_id,title,date,tz,invite_code,budget_total) values($1,$2,'Synthetic migration wedding','2027-06-14','Europe/Moscow',$3,99000000)", [f.wedding, f.owner, randomUUID()])
    await write("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'coordinator')", [f.wedding, f.owner, f.coordinator])
    await write("insert into notification_prefs(user_id) values($1)", [f.owner])
    await write("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic migration studio',now())", [f.vendor, f.vendorOwner])
    await write("insert into slots(id,wedding_id,category_id,label) values($1,$3,'photo','Historical photographer'),($2,$3,'host','Historical external host')", [f.slot, f.externalSlot, f.wedding])
    await write(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,package_title_snapshot,package_includes_snapshot)
      values($1,$2,$3,$4,'paid_deposit',123456789,'Historical package','["Full day","Gallery"]'::jsonb)`, [f.deal, f.wedding, f.slot, f.vendor])
    await write(`insert into deals(id,wedding_id,slot_id,external_name,state,price) values($1,$2,$3,'Synthetic external host','booked',3300000)`, [f.externalDeal, f.wedding, f.externalSlot])
    await write('update slots set deal_id=$2 where id=$1', [f.slot, f.deal])
    await write('update slots set deal_id=$2 where id=$1', [f.externalSlot, f.externalDeal])
    await write("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2)", [f.vendor, f.deal])
    await write("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Day two','second_day','2027-06-15','Europe/Moscow',false)", [f.secondEvent, f.wedding])
    f.mainEvent = (await db.query('select id from wedding_events where wedding_id=$1 and is_main', [f.wedding])).rows[0].id
    if (withHistory) {
      await write(`insert into payments(id,deal_id,kind,amount,status,payment_method,visibility,paid_on) values
        ($1,$4,'deposit',20000000,'recorded','bank_transfer','private','2026-09-28'),
        ($2,$4,'balance',7000000,'recorded','cash','vendor','2026-09-29'),
        ($3,$4,'refund',3000000,'recorded','bank_transfer','private','2026-09-30')`, [f.deposit, f.balance, f.refund, f.deal])
      await write("insert into budget_items(id,wedding_id,title,category_id,amount) values($1,$2,'Synthetic manual cost','decor',7654321)", [f.budget, f.wedding])
      await write(`insert into timeline_events(id,wedding_id,name,starts_at,ends_at,duration_minutes,program_event_id,fixed,travel_minutes,buffer_minutes)
        values($1,$2,'Synthetic ceremony','2027-06-14T12:00:00.123Z','2027-06-14T12:30:00.123Z',30,$3,true,10.5,5.25)`, [f.timeline, f.wedding, f.mainEvent])
      await write(`insert into timeline_assignments(wedding_id,event_id,role,kind,reference_id) values($1,$2,'responsible','deal',$3),($1,$2,'participant','deal',$4)`, [f.wedding, f.timeline, f.deal, f.externalDeal])
      for (const [guest, rsvp] of [[f.guestYes, 'yes'], [f.guestNo, 'no'], [f.guestUnknown, 'pending']]) {
        await write('insert into guests(id,wedding_id,name,rsvp,rsvp_token) values($1,$2,$3,$4,$5)', [guest, f.wedding, `Synthetic ${rsvp} guest`, rsvp, randomUUID()])
      }
      const version = (await db.query('select timeline_version::text,timeline_updated_at from weddings where id=$1', [f.wedding])).rows[0]
      const makeProgram = role => ({ weddingId: f.wedding, wedding: 'Synthetic migration wedding', sourceVersion: version.timeline_version, updatedAt: version.timeline_updated_at.toISOString(), blocks: [{
        id: f.timeline, name: 'Synthetic ceremony', location: null, startsAt: '2027-06-14T12:00:00.123Z', endsAt: '2027-06-14T12:30:00.123Z', durationMinutes: 30,
        fixed: true, travelMinutes: 10.5, bufferMinutes: 5.25, outdoor: false, roles: [role], dependsOn: [], event: { id: f.mainEvent, name: 'Основная программа', date: '2027-06-14', timeZone: 'Europe/Moscow', location: null },
      }] })
      const program = makeProgram('responsible'), externalProgram = makeProgram('participant')
      const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
      await write(`insert into vendor_program_acknowledgments(wedding_id,vendor_id,user_id,session_id,version,digest,program_snapshot,acknowledged_at)
        values($1,$2,$3,$4,$5,$6,$7::jsonb,'2026-09-30T12:00:00Z')`, [f.wedding, f.vendor, f.vendorOwner, f.session, version.timeline_version, digest(program), JSON.stringify(program)])
      await write(`insert into external_invites(token,wedding_id,slot_id,expires_at,program_identity,program_deal_id)
        values($1,$2,$3,'2026-10-30T12:00:00Z',$4,$5)`, [randomUUID(), f.wedding, f.externalSlot, f.inviteIdentity, f.externalDeal])
      await write('update deals set current_program_invite_id=$2 where id=$1', [f.externalDeal, f.inviteIdentity])
      await write(`insert into external_program_acknowledgments(wedding_id,invite_id,deal_id,version,digest,program_snapshot,acknowledged_at)
        values($1,$2,$3,$4,$5,$6::jsonb,'2026-09-30T12:01:00Z')`, [f.wedding, f.inviteIdentity, f.externalDeal, version.timeline_version, digest(externalProgram), JSON.stringify(externalProgram)])
      await write(`insert into notifications(id,user_id,kind,title,body,pushed_at,read_at) values
        ($1,$3,'deal','Synthetic legacy push','Legacy processing, no delivery claim','2026-09-30T11:00:00Z',null),
        ($2,$3,'system','Synthetic queued update','Not sent',null,null)`, [f.pushedNotification, f.plannedNotification, f.owner])
      const endpoint = phonePrefix === '+1555000000' ? 'https://push.invalid/synthetic-migration' : `https://push.invalid/synthetic-migration/${f.subscription}`
      await write("insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,'{}')", [f.subscription, f.owner, endpoint])
    }
    await write('commit')
    return f
  } catch (error) { await db.query('rollback'); throw error }
}
async function expectAtomicRefusal(message, target = FIRST, exactFile = false) {
  const before = await snapshot()
  await migrate('down', target, message, exactFile)
  assert.deepEqual(await snapshot(), before, 'Rollback refusal must preserve every table row, migration journal and schema definition')
  atomicDownCount++
}

let termsNegativeCount = 0, atomicDownCount = 0
let staffNegativeCount = 0, resourceNegativeCount = 0, invitationNegativeCount = 0, planNegativeCount = 0, commitmentNegativeCount = 0, t012NegativeCount = 0, inventoryNegativeCount = 0
async function expectTermsSqlRefusal(label, sql, values, code, message) {
  await expectSqlRefusal('terms', label, sql, values, code, message)
  termsNegativeCount++
}
async function expectSqlRefusal(scope, label, sql, values, code, message, atCommit = false) {
  const before = await snapshot()
  // Ordinary probes force deferred checks before rollback. The named event
  // mismatch additionally witnesses an actual COMMIT refusal, not a mock.
  await write('begin')
  try {
    await assert.rejects(async () => { if (typeof sql === 'function') await sql(); else await write(sql, values); await write(atCommit ? 'commit' : 'set constraints all immediate') }, error => {
    assert.equal(error.code, code, `${label}: require the actual PostgreSQL constraint/trigger failure`)
    if (message) assert(error.message.includes(message), `${label}: unexpected database error ${error.message}`)
    return true
    }, `${label}: invalid history unexpectedly persisted`)
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), before, `${label}: refusal must leave all rows, journal and schema metadata unchanged`)
  if (scope === 'staff') staffNegativeCount++
  if (scope === 'resource') resourceNegativeCount++
  if (scope === 'invitation') invitationNegativeCount++
  if (scope === 'plan') planNegativeCount++
  if (scope === 'commitment') commitmentNegativeCount++
  if (scope === 't012') t012NegativeCount++
  if (scope === 'inventory') inventoryNegativeCount++
  console.log(`Expected ${scope} SQL refusal: ${label} (${code}${atCommit ? ', actual deferred commit' : ''})`)
}

async function staffAndResourceFixture(f, assignment) {
  // All membership/duty/resource facts here are synthetic SQL fixtures. They
  // do not prove staff consent, a booking, employment, or live availability.
  const member = f.legacyMember, invited = f.legacyInvitation, duty = randomUUID(), otherVendor = randomUUID(), otherMember = randomUUID(), otherWedding = randomUUID()
  const staffSql = `insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at)
    values($1,$2,$3,$4,'worker',$5,$6,$7,$8)`
  const staffValues = (memberId, vendorId, userId, state = 'active') => [memberId, vendorId, userId, state, createHash('sha256').update(randomUUID()).digest('hex'), '2026-10-30T12:00:00Z', f.vendorOwner, state === 'active' ? '2026-10-01T01:00:00Z' : null]
  await expectSqlRefusal('staff', 'active member requires recorded acceptance time', staffSql, [...staffValues(member, f.vendor, f.coordinator).slice(0, 7), null], '23514')
  await expectSqlRefusal('staff', 'invited member cannot contain acceptance', staffSql, [...staffValues(member, f.vendor, f.coordinator, 'invited').slice(0, 7), '2026-10-01T01:00:00Z'], '23514')
  const invalidExpiry = staffValues(member, f.vendor, f.coordinator); invalidExpiry[5] = 'infinity'
  await expectSqlRefusal('staff', 'staff invitation expiration is finite', staffSql, invalidExpiry, '23514')
  assert.deepEqual((await db.query('select id,invite_target_user_id,invite_binding_known from vendor_staff_members where id=any($1::uuid[]) order by id', [[member, invited]])).rows,
    [member, invited].sort().map(id => ({ id, invite_target_user_id: null, invite_binding_known: false })), 'Pre-355 staff history must retain unknown addressing, not inferred open/targeted scope')
  await expectSqlRefusal('staff', 'one current member per vendor/account', staffSql, staffValues(randomUUID(), f.vendor, f.coordinator), '23505')
  // No duties yet: 351 and 350 down run inside the CLI transaction, then 345
  // must refuse and restore tables, extension flag, operators and journal.
  await expectAtomicRefusal('vendor staff history exists; use a preserving forward migration', 1763450000000)
  await write("insert into vendors(id,user_id,category_id,name) values($1,$2,'photo','Synthetic second company')", [otherVendor, f.owner])
  await write(staffSql, staffValues(otherMember, otherVendor, f.owner))
  await write("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Synthetic foreign event scope',$3)", [otherWedding, f.coordinator, randomUUID()])
  const foreignEvent = (await db.query('select id from wedding_events where wedding_id=$1 and is_main', [otherWedding])).rows[0].id
  const foreignAssignment = randomUUID()
  await write("insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label) values($1,$2,$3,$4,$5,'structured','Synthetic other-deal assignment')", [foreignAssignment, f.wedding, f.externalDeal, f.externalSlot, f.mainEvent])
  const dutySql = `insert into vendor_staff_duties(id,vendor_id,member_id,wedding_id,deal_id,program_event_id,assignment_id,role,label,created_by)
    values($1,$2,$3,$4,$5,$6,$7,'performer','Synthetic scoped duty',$8)`
  const dutyValues = (patch = {}) => [patch.id ?? randomUUID(), patch.vendor ?? f.vendor, patch.member ?? member, patch.wedding ?? f.wedding,
    patch.deal ?? f.deal, patch.event ?? f.mainEvent, patch.assignment === undefined ? assignment : patch.assignment, f.vendorOwner]
  await expectSqlRefusal('staff', 'duty cannot use another company member', dutySql, dutyValues({ member: otherMember }), '23503')
  await expectSqlRefusal('staff', 'duty cannot use another company deal', dutySql, dutyValues({ vendor: otherVendor, member: otherMember }), '23503')
  await expectSqlRefusal('staff', 'duty event must belong to its wedding', dutySql, dutyValues({ event: foreignEvent, assignment: null }), '23503')
  await expectSqlRefusal('staff', 'duty assignment must belong to its deal', dutySql, dutyValues({ assignment: foreignAssignment }), '23503')
  const eventScope = (await db.query("select condeferrable,condeferred from pg_constraint where conname='staff_duty_assignment_event_scope'")).rows[0]
  assert.deepEqual(eventScope, { condeferrable: true, condeferred: true }, 'Forward fix must retain wedding cascade and reject mismatch at commit')
  await expectSqlRefusal('staff', 'same wedding/deal duty cannot use another event assignment', dutySql, dutyValues({ event: f.secondEvent }), '23503', 'staff_duty_assignment_event_scope', true)
  const ownerResource = randomUUID(), workerResource = randomUUID(), equipment = randomUUID(), capacity = randomUUID(), window = randomUUID(), adjacent = randomUUID()
  const resourceSql = `insert into vendor_resources(id,vendor_id,kind,label,person_user_id,staff_member_id,conflict_identity,capacity_unit,created_by)
    values($1,$2,$3,'Synthetic explicit resource',$4,$5,$6,$7,$8)`
  const resourceValues = (id, kind, person = null, staff = null, unit = null, vendor = f.vendor, conflict = kind === 'person' ? person : id) => [id, vendor, kind, person, staff, conflict, unit, f.vendorOwner]
  await expectSqlRefusal('resource', 'capacity requires explicit unit', resourceSql, resourceValues(capacity, 'capacity'), '23514')
  await expectSqlRefusal('resource', 'equipment cannot invent capacity unit', resourceSql, resourceValues(equipment, 'equipment', null, null, 'sets'), '23514')
  await expectSqlRefusal('resource', 'person requires actual account identity', resourceSql, resourceValues(workerResource, 'person', null, null, null, f.vendor, randomUUID()), '23514', 'person resource requires actual identity')
  await expectSqlRefusal('resource', 'person conflict key is actual account UUID', resourceSql, resourceValues(workerResource, 'person', f.coordinator, member, null, f.vendor, randomUUID()), '23514')
  await expectSqlRefusal('resource', 'person is neither owner nor scoped member', resourceSql, resourceValues(workerResource, 'person', f.coordinator), '23514')
  await expectSqlRefusal('resource', 'person member must be accepted in same company', resourceSql, resourceValues(workerResource, 'person', f.owner, otherMember), '23514')
  await expectSqlRefusal('resource', 'invitation alone cannot create person resource', resourceSql, resourceValues(workerResource, 'person', f.owner, invited), '23514')
  await write(resourceSql, resourceValues(ownerResource, 'person', f.vendorOwner))
  await write(resourceSql, resourceValues(workerResource, 'person', f.coordinator, member))
  await write(resourceSql, resourceValues(equipment, 'equipment'))
  await write(resourceSql, resourceValues(capacity, 'capacity', null, null, 'bouquets'))
  await write('insert into vendor_availability_policy(vendor_id,mode,changed_by) values($1,\'resources\',$2)', [f.vendor, f.vendorOwner])
  assert.equal((await db.query('select conflict_identity from vendor_resources where id=$1', [workerResource])).rows[0].conflict_identity, f.coordinator, 'A person key is actual account UUID, never a profile/resource/guessed capacity')
  for (const [label, column, value] of [['person conflict key', 'conflict_identity', randomUUID()], ['person account', 'person_user_id', null], ['resource vendor', 'vendor_id', null], ['staff identity', 'staff_member_id', null], ['resource kind', 'kind', 'equipment']]) {
    await expectSqlRefusal('resource', `immutable ${label}`, `update vendor_resources set ${quote(column)}=$2 where id=$1`, [workerResource, value], '23514', 'resource identity is immutable')
  }
  await expectSqlRefusal('resource', 'declared capacity unit is immutable', 'update vendor_resources set capacity_unit=$2 where id=$1', [capacity, 'people'], '23514', 'resource identity is immutable')
  const windowSql = 'insert into resource_capacity_windows(id,resource_id,starts_at,ends_at,capacity,used,created_by) values($1,$2,$3,$4,$5,$6,$7)'
  const windowValues = (patch = {}) => [patch.id ?? randomUUID(), patch.resource ?? capacity, patch.start ?? '2027-06-14T08:00:00Z', patch.end ?? '2027-06-14T12:00:00Z', patch.capacity ?? 100, patch.used ?? 0, f.vendorOwner]
  await expectSqlRefusal('resource', 'window requires capacity kind', windowSql, windowValues({ resource: equipment }), '23514', 'capacity window requires a capacity resource')
  for (const [label, patch] of [['finite start', { start: '-infinity' }], ['finite end', { end: 'infinity' }], ['nonempty interval', { end: '2027-06-14T08:00:00Z' }], ['ordered interval', { end: '2027-06-14T07:00:00Z' }], ['positive capacity', { capacity: 0 }], ['nonnegative used count', { used: -1 }], ['used does not exceed capacity', { capacity: 5, used: 6 }]]) {
    await expectSqlRefusal('resource', label, windowSql, windowValues(patch), '23514')
  }
  await write(windowSql, windowValues({ id: window }))
  await expectSqlRefusal('resource', 'same resource windows cannot overlap', windowSql, windowValues({ start: '2027-06-14T11:00:00Z', end: '2027-06-14T13:00:00Z' }), '23P01')
  await write(windowSql, windowValues({ id: adjacent, start: '2027-06-14T12:00:00Z', end: '2027-06-14T16:00:00Z' }))
  assert.equal((await db.query('select count(*)::int as count from resource_capacity_windows where resource_id=$1', [capacity])).rows[0].count, 2, 'Adjacent [start,end) windows are allowed without overlap')
  await expectSqlRefusal('resource', 'window update cannot change to equipment kind', 'update resource_capacity_windows set resource_id=$2 where id=$1', [window, equipment], '23514')
  await expectAtomicRefusal('resource history or explicit policy exists; use a preserving forward migration', 1763500000000)

  // Create the correct event-scoped positive only after the 350 refusal so
  // that the later 351 guard cannot mask the resource-specific guard.
  await write(dutySql, dutyValues({ id: duty }))
  assert.deepEqual((await db.query('select vendor_id,member_id,wedding_id,deal_id,program_event_id,assignment_id from vendor_staff_duties where id=$1', [duty])).rows[0],
    { vendor_id: f.vendor, member_id: member, wedding_id: f.wedding, deal_id: f.deal, program_event_id: f.mainEvent, assignment_id: assignment })
  await expectAtomicRefusal('scoped staff duties exist; do not weaken event binding', 1763510000000)

  // An extra disposable identity permits real FK-clearing probes without
  // deleting any inherited participant/account/program/financial history.
  const deletedAccount = randomUUID(), erasedMember = randomUUID(), historyResource = randomUUID()
  await write("insert into users(id,phone,name) values($1,'+16660000001','Synthetic identity clearing')", [deletedAccount])
  await write(staffSql, staffValues(erasedMember, otherVendor, deletedAccount))
  await write(resourceSql, resourceValues(historyResource, 'person', deletedAccount, erasedMember, null, otherVendor))
  const retainedBefore = (await db.query('select conflict_identity,kind,version::text,label,created_at from vendor_resources where id=$1', [historyResource])).rows[0]
  await write('delete from users where id=$1', [deletedAccount])
  assert.equal((await db.query('select person_user_id from vendor_resources where id=$1', [historyResource])).rows[0].person_user_id, null)
  assert.deepEqual((await db.query('select conflict_identity,kind,version::text,label,created_at from vendor_resources where id=$1', [historyResource])).rows[0], retainedBefore)
  await write('delete from vendors where id=$1', [otherVendor])
  assert.deepEqual((await db.query('select vendor_id,person_user_id,staff_member_id from vendor_resources where id=$1', [historyResource])).rows[0], { vendor_id: null, person_user_id: null, staff_member_id: null })
  assert.deepEqual((await db.query('select conflict_identity,kind,version::text,label,created_at from vendor_resources where id=$1', [historyResource])).rows[0], retainedBefore)
  await write('delete from weddings where id=$1', [otherWedding])
  console.log('Synthetic identity erasure preserved resource conflict UUID/history; no inherited accounts or companies were erased')

  const beforeErase = await snapshot()
  await write('begin')
  try {
    await write('delete from weddings where id=$1', [f.wedding])
    await write('set constraints all immediate')
    assert.equal((await db.query('select count(*)::int as count from weddings where id=$1', [f.wedding])).rows[0].count, 0)
    for (const table of ['order_assignments', 'deal_terms_versions', 'deal_terms_receipts', 'vendor_staff_duties']) {
      assert.equal((await db.query(`select count(*)::int as count from ${quote(table)} where wedding_id=$1`, [f.wedding])).rows[0].count, 0, `${table}: whole wedding erasure must cascade without manual dependency cleanup`)
    }
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), beforeErase, 'Rollback-contained wedding erasure probe must preserve the retained financial/program/terms evidence')
  console.log('Actual whole-wedding DELETE and immediate deferred checks passed without manual dependency cleanup; probe rolled back to retain inherited evidence')
}

async function seedStaffHistoryBeforeIdentity(f) {
  // Synthetic inherited SQL history only, created under the actual old schema.
  // Keeping an existing accepted timestamp is not a new human acceptance.
  f.legacyMember = randomUUID(); f.legacyInvitation = randomUUID()
  for (const [id, userId, state, accepted] of [[f.legacyMember, f.coordinator, 'active', '2026-09-29T01:00:00Z'], [f.legacyInvitation, f.owner, 'invited', null]]) {
    await write(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,invited_by,accepted_at)
      values($1,$2,$3,$4,'worker',$5,'2026-10-30T12:00:00Z',$6,$7)`,
    [id, f.vendor, userId, state, createHash('sha256').update(randomUUID()).digest('hex'), f.vendorOwner, accepted])
  }
}
async function invitationIdentityFixture(f) {
  // These new open/targeted rows are pending invitations, never new accepted
  // memberships. Domain redemption/ACL is covered separately by staff tests.
  const open = randomUUID(), targeted = randomUUID(), targetUser = randomUUID()
  await write("insert into users(id,phone,name) values($1,'+16660000002','Synthetic invitation recipient')", [targetUser])
  const sql = `insert into vendor_staff_members(id,vendor_id,user_id,role,invite_token_hash,invite_expires_at,invited_by,invite_target_user_id,invite_binding_known)
    values($1,$2,$3,'worker',$4,'2026-10-30T12:00:00Z',$5,$6,$7)`
  const values = (id, userId, target, known) => [id, f.vendor, userId, createHash('sha256').update(randomUUID()).digest('hex'), f.vendorOwner, target, known]
  await expectSqlRefusal('invitation', 'unknown original addressing cannot claim a target', sql, values(randomUUID(), targetUser, targetUser, false), '23514', 'staff_invitation_binding_known')
  await write(sql, values(open, null, null, true))
  await write(sql, values(targeted, targetUser, targetUser, true))
  assert.deepEqual((await db.query('select id,user_id,invite_target_user_id,invite_binding_known,state,accepted_at,accepted_session_id,version::text from vendor_staff_members where id=any($1::uuid[]) order by id', [[open, targeted]])).rows,
    [{ id: open, user_id: null, invite_target_user_id: null, invite_binding_known: true, state: 'invited', accepted_at: null, accepted_session_id: null, version: '1' },
      { id: targeted, user_id: targetUser, invite_target_user_id: targetUser, invite_binding_known: true, state: 'invited', accepted_at: null, accepted_session_id: null, version: '1' }].sort((a, b) => a.id.localeCompare(b.id)))
  for (const [label, id, column, value] of [
    ['target recipient rewrite', targeted, 'invite_target_user_id', f.coordinator],
    ['target recipient cannot become open', targeted, 'invite_target_user_id', null],
    ['target binding cannot become unknown', targeted, 'invite_binding_known', false],
    ['open original recipient cannot be replaced', open, 'invite_target_user_id', f.coordinator],
    ['open binding cannot become unknown', open, 'invite_binding_known', false],
    ['unknown inherited binding cannot be invented', f.legacyInvitation, 'invite_binding_known', true],
  ]) {
    await expectSqlRefusal('invitation', label, `update vendor_staff_members set ${quote(column)}=$2 where id=$1`, [id, value], '23514', 'staff invitation addressing is immutable')
  }
  const beforeErase = (await db.query('select * from vendor_staff_members where id=$1', [targeted])).rows[0]
  // The absence of this FK is intentional, not an omitted relational guard.
  const targetFk = await db.query(`select 1 from pg_constraint k join pg_attribute a on a.attrelid=k.conrelid and a.attnum=any(k.conkey)
    where k.conrelid='vendor_staff_members'::regclass and k.contype='f' and a.attname='invite_target_user_id'`)
  assert.equal(targetFk.rowCount, 0, 'Original invitation recipient UUID must survive account deletion')
  await write('delete from users where id=$1', [targetUser])
  assert.deepEqual((await db.query('select * from vendor_staff_members where id=$1', [targeted])).rows[0], { ...beforeErase, user_id: null })
  assert.deepEqual((await db.query('select id,invite_target_user_id,invite_binding_known from vendor_staff_members where id=any($1::uuid[]) order by id', [[f.legacyMember, f.legacyInvitation]])).rows,
    [f.legacyMember, f.legacyInvitation].sort().map(id => ({ id, invite_target_user_id: null, invite_binding_known: false })))
  await expectAtomicRefusal('staff invitation identity history exists; do not discard addressing', 1763550000000)
  console.log('Actual pending target account DELETE preserved immutable recipient UUID/token/version and null acceptance; open invitation stayed explicitly known, inherited addressing stayed unknown')
}

// Trusted synthetic fixture values only. This serializer has no application
// acceptance role; it produces deterministic bytes whose digest the DB checks.
function canonicalFixture(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(',')}]`
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFixture(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function termsFixture(f, assignment) {
  const order = (await db.query('select version::text,source,brief from deal_orders where deal_id=$1', [f.deal])).rows[0]
  const event = (await db.query('select id,name,kind,date::text,time_zone,location from wedding_events where id=$1 and wedding_id=$2 and is_main', [f.mainEvent, f.wedding])).rows[0]
  const scope = (await db.query('select id,slot_id,version::text,source,label,program_event_id from order_assignments where id=$1 and wedding_id=$2 and deal_id=$3', [assignment, f.wedding, f.deal])).rows[0]
  const economic = (await db.query('select price::text,currency,package_id,package_title_snapshot,package_includes_snapshot,external_name,external_phone from deals where id=$1 and wedding_id=$2', [f.deal, f.wedding])).rows[0]
  const vendor = (await db.query('select id,user_id,name,category_id from vendors where id=$1', [f.vendor])).rows[0]
  assert(event && scope && economic && vendor, 'Synthetic terms must reference actual fixture rows')
  assert.equal(scope.program_event_id, event.id)
  const eventDto = { id: event.id, name: event.name, date: event.date, timeZone: event.time_zone, location: event.location }
  const terms = randomUUID()
  const value = {
    schemaVersion: 1, weddingId: f.wedding, dealId: f.deal,
    source: order.source, categoryId: 'photo', sourceOrderVersion: order.version,
    legacyContext: { mainEvent: eventDto },
    brief: order.brief,
    assignments: [{ id: scope.id, slotId: scope.slot_id, version: scope.version, source: scope.source, label: scope.label, event: { ...eventDto, kind: event.kind } }],
    parts: [],
    economics: { amount: economic.price, amountKnown: economic.price !== null, currency: economic.currency, performer: { vendor: { id: vendor.id, userId: vendor.user_id, name: vendor.name, categoryId: vendor.category_id }, externalName: economic.external_name, externalPhone: economic.external_phone }, package: { id: economic.package_id, titleSnapshot: economic.package_title_snapshot, includesSnapshot: economic.package_includes_snapshot } },
  }
  const canonical = canonicalFixture(value)
  const digest = createHash('sha256').update(canonical).digest('hex')
  const insertSql = `insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,canonical_payload,snapshot,digest,published_by,published_side,published_at)
    values($1,$2,$3,1,$4,$5,$6,$7::jsonb,$8,$9,'customer','2026-09-30T13:00:00Z')`
  const values = [terms, f.wedding, f.deal, order.version, digest, canonical, JSON.stringify(value), digest, f.owner]
  await expectTermsSqlRefusal('published digest differs from canonical bytes', insertSql, [...values.slice(0, 7), '0'.repeat(64), f.owner], '23514')
  await expectTermsSqlRefusal('snapshot differs from canonical payload', insertSql, [...values.slice(0, 6), JSON.stringify({ syntheticMismatch: true }), digest, f.owner], '23514')
  await write(insertSql, values)
  await write('update deal_orders set terms_revision=1,proposed_terms_id=$2 where deal_id=$1', [f.deal, terms])
  const stored = (await db.query('select canonical_payload,snapshot,digest,source_fingerprint,source_order_version::text from deal_terms_versions where id=$1', [terms])).rows[0]
  assert.deepEqual(stored, { canonical_payload: canonical, snapshot: value, digest, source_fingerprint: digest, source_order_version: order.version })
  await expectTermsSqlRefusal('published terms update', 'update deal_terms_versions set canonical_payload=$2 where id=$1', [terms, '{}'], '23514', 'Published order terms are immutable')
  await expectTermsSqlRefusal('published terms deletion', 'delete from deal_terms_versions where id=$1', [terms], '23514', 'Order terms history can only be erased with its wedding')
  for (const pointer of ['proposed_terms_id', 'agreed_terms_id']) {
    await expectTermsSqlRefusal(`cross-deal ${pointer}`, `update deal_orders set ${pointer}=$2 where deal_id=$1`, [f.externalDeal, terms], '23503', `${pointer === 'proposed_terms_id' ? 'proposed' : 'agreed'}_order_terms_scope`)
  }
  // No receipts yet: 341 down is temporarily applied inside the CLI transaction,
  // then the 340 guard must roll it all back, including constraint definitions.
  await expectAtomicRefusal('Cannot discard published order terms or acceptance history', 1763400000000)
  const receiptSql = 'insert into deal_terms_receipts(id,wedding_id,deal_id,terms_id,party,user_id,session_id,digest,accepted_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)'
  const customer = [randomUUID(), f.wedding, f.deal, terms, 'customer', f.owner, null, digest, '2026-09-30T13:01:00Z']
  await expectTermsSqlRefusal('receipt digest differs from published version', receiptSql, [...customer.slice(0, 7), '0'.repeat(64), customer[8]], '23503', 'receipt_published_digest_scope')
  await expectTermsSqlRefusal('receipt belongs to another deal', receiptSql, [customer[0], f.wedding, f.externalDeal, ...customer.slice(3)], '23503')
  await expectTermsSqlRefusal('receipt belongs to another wedding', receiptSql, [customer[0], randomUUID(), ...customer.slice(2)], '23503')
  // Explicitly synthetic DB history: these rows do not prove a human clicked
  // acceptance, legal signature, payment, or a program acknowledgment.
  await write(receiptSql, customer)
  const performer = [randomUUID(), f.wedding, f.deal, terms, 'performer', f.vendorOwner, f.session, digest, '2026-09-30T13:02:00Z']
  await write(receiptSql, performer)
  await write('update deal_orders set terms_revision=2,agreed_terms_id=$2 where deal_id=$1', [f.deal, terms])
  assert.deepEqual((await db.query('select terms_revision::text,proposed_terms_id,agreed_terms_id from deal_orders where deal_id=$1', [f.deal])).rows[0], { terms_revision: '2', proposed_terms_id: terms, agreed_terms_id: terms })
  assert.deepEqual((await db.query('select party,user_id,session_id,digest from deal_terms_receipts where terms_id=$1 order by party', [terms])).rows, [
    { party: 'customer', user_id: f.owner, session_id: null, digest }, { party: 'performer', user_id: f.vendorOwner, session_id: f.session, digest },
  ])
  await expectTermsSqlRefusal('recorded receipt update', 'update deal_terms_receipts set digest=$2 where id=$1', [customer[0], '0'.repeat(64)], '23514', 'Order terms receipts are immutable')
  await expectTermsSqlRefusal('recorded receipt deletion', 'delete from deal_terms_receipts where id=$1', [performer[0]], '23514', 'Order terms history can only be erased with its wedding')
  await expectTermsSqlRefusal('duplicate party receipt', receiptSql, [randomUUID(), ...customer.slice(1)], '23505')
  await expectAtomicRefusal('Cannot remove recorded terms receipt digest protection', 1763410000000)
  return { terms, digest }
}

// These fixtures exercise relational preservation, not domain acceptance or
// capacity reservation. Every selected resource/part has a real scoped row.
async function planFixture(f, assignment, probes, options = {}) {
  const part = randomUUID(), plan = randomUUID()
  await write(`insert into order_parts(id,wedding_id,deal_id,assignment_id,kind,source,title,details,created_by)
    values($1,$2,$3,$4,'timed_service','structured','Synthetic planned work',
      '{"startsAt":null,"endsAt":null,"location":null,"setupMinutes":null,"teardownMinutes":null,"travelMinutes":null}',$5)`, [part, f.wedding, f.deal, assignment, f.owner])
  const selected = (await db.query(`select r.id,r.kind,r.label,r.capacity_unit,r.conflict_identity,w.id as window_id,w.starts_at,w.ends_at
    from vendor_resources r left join resource_capacity_windows w on w.resource_id=r.id
    where r.vendor_id=$1 and (($3::uuid[] is not null and r.id=any($3::uuid[])) or
      ($3::uuid[] is null and ((r.kind='person' and r.person_user_id=$2 and not $4::boolean) or
      (r.kind='capacity' and w.starts_at='2027-06-14T08:00:00Z') or (r.kind='equipment' and $5::boolean))))
    order by r.id`, [f.vendor, f.vendorOwner, options.resourceIds ?? null, options.capacityOnly ?? false, options.equipment ?? false])).rows
  assert.equal(selected.length, options.resourceIds?.length ?? (options.capacityOnly ? 1 : options.equipment ? 3 : 2), 'Every explicit fixture resource requires its actual scoped row and covering window')
  const h = (await db.query('select version::text,resource_plan_revision::text from deal_orders where deal_id=$1', [f.deal])).rows[0]
  const revision = (BigInt(h.resource_plan_revision) + 1n).toString(), nextVersion = (BigInt(h.version) + 1n).toString()
  const scope = (await db.query('select version::text,program_event_id from order_assignments where id=$1', [assignment])).rows[0]
  const lines = selected.map(r => ({ partId: part, assignmentId: assignment, programEventId: scope.program_event_id,
    resourceId: r.id, conflictIdentity: r.conflict_identity, capacityWindowId: r.window_id ?? null,
    label: r.label, kind: r.kind, quantity: r.kind === 'capacity' ? options.quantity ?? 3 : 1, unit: r.capacity_unit,
    startsAt: options.startsAt ?? '2027-06-14T10:00:00.000Z', endsAt: options.endsAt ?? '2027-06-14T11:00:00.000Z', timeZone: 'Europe/Moscow',
    setupMinutes: options.zeroBuffers ? 0 : 10, teardownMinutes: options.zeroBuffers ? 0 : 15,
    travelBeforeMinutes: options.zeroBuffers ? 0 : 15, travelAfterMinutes: options.zeroBuffers ? 0 : 20,
    occupiedStartsAt: options.zeroBuffers ? options.startsAt ?? '2027-06-14T10:00:00.000Z' : '2027-06-14T09:35:00.000Z',
    occupiedEndsAt: options.zeroBuffers ? options.endsAt ?? '2027-06-14T11:00:00.000Z' : '2027-06-14T11:35:00.000Z',
    window: r.window_id ? { startsAt: r.starts_at.toISOString(), endsAt: r.ends_at.toISOString() } : null,
    partVersion: '1', assignmentVersion: scope.version }))
  const privateSnapshot = { schemaVersion: 1, lines }, payload = canonicalFixture(privateSnapshot)
  const digest = createHash('sha256').update(payload).digest('hex')
  const publicLines = (await db.query('select resource_plan_public_lines($1::jsonb) as lines', [JSON.stringify(lines)])).rows[0].lines
  const publicSnapshot = { planRevisionId: plan, revision, lines: publicLines }
  for (const line of publicLines) assert.deepEqual(Object.keys(line).sort(), ['partId', 'assignmentId', 'programEventId', 'label', 'kind', 'quantity', 'unit',
    'startsAt', 'endsAt', 'timeZone', 'setupMinutes', 'teardownMinutes', 'travelBeforeMinutes', 'travelAfterMinutes', 'occupiedStartsAt', 'occupiedEndsAt', 'window'].sort(), 'SQL projection must contain only the exact safe public fields')
  const insert = `insert into deal_resource_plan_versions(id,wedding_id,deal_id,vendor_id,version,source_order_version,
    private_payload,private_snapshot,private_digest,public_snapshot,created_by)
    values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11)`
  const values = [plan, f.wedding, f.deal, f.vendor, revision, nextVersion, payload, JSON.stringify(privateSnapshot), digest, JSON.stringify(publicSnapshot), f.vendorOwner]
  if (probes) {
    await expectSqlRefusal('plan', 'private digest must match exact bytes', insert, values.with(8, '0'.repeat(64)), '23514')
    await expectSqlRefusal('plan', 'private JSON must match exact bytes', insert, values.with(7, JSON.stringify({ schemaVersion: 1, lines: [] })), '23514')
    await expectSqlRefusal('plan', 'public projection cannot expose resource identities', insert,
      values.with(9, JSON.stringify({ ...publicSnapshot, resourceId: selected[0].id })), '23514')
    await expectSqlRefusal('plan', 'public line projection cannot differ', insert,
      values.with(9, JSON.stringify({ ...publicSnapshot, lines: publicLines.map(l => ({ ...l, quantity: l.quantity + 1 })) })), '23514')
    await expectSqlRefusal('plan', 'plan uses actual scoped company', insert, values.with(3, randomUUID()), '23514', 'current scoped order')
    await expectSqlRefusal('plan', 'plan uses next order version', insert, values.with(5, h.version), '23514', 'current scoped order')
  }
  await write('begin')
  try {
    await write(insert, values)
    await write(`update deal_orders set version=$2,resource_plan_revision=$3,resource_plan_id=$4 where deal_id=$1`, [f.deal, nextVersion, revision, plan])
    await write('commit')
  } catch (error) { await db.query('rollback'); throw error }
  assert.deepEqual((await db.query(`select private_payload,private_snapshot,private_digest,public_snapshot,source_order_version::text from deal_resource_plan_versions where id=$1`, [plan])).rows[0],
    { private_payload: payload, private_snapshot: privateSnapshot, private_digest: digest, public_snapshot: publicSnapshot, source_order_version: nextVersion })
  if (probes) {
    await expectSqlRefusal('plan', 'private plan history is immutable', 'update deal_resource_plan_versions set private_payload=$2 where id=$1', [plan, '{}'], '23514', 'revision is immutable')
    await expectSqlRefusal('plan', 'public plan history is immutable', 'update deal_resource_plan_versions set public_snapshot=$2::jsonb where id=$1', [plan, '{}'], '23514', 'revision is immutable')
    await expectSqlRefusal('plan', 'history cannot be individually erased', 'delete from deal_resource_plan_versions where id=$1', [plan], '23514', 'only be erased with its wedding')
    await expectSqlRefusal('plan', 'creator cannot be detached while account exists', 'update deal_resource_plan_versions set created_by=null where id=$1', [plan], '23514', 'revision is immutable')
    await expectSqlRefusal('plan', 'foreign financial head cannot bind this plan',
      'update deal_orders set version=version+1,resource_plan_revision=1,resource_plan_id=$2 where deal_id=$1', [f.externalDeal, plan], '23514', 'head must advance')
    await expectSqlRefusal('plan', 'head cannot rewind', 'update deal_orders set version=version+1,resource_plan_revision=0,resource_plan_id=null where deal_id=$1', [f.deal], '23514', 'head must advance')
  }
  return { plan, publicSnapshot, part, revision, nextVersion, insert, values }
}

async function planIntegrityProbes(plan) {
  // Next candidate is scoped to the actual now-advanced order. It would pass
  // 360's INSERT guard but must fail 361's real schema/COMMIT protection.
  const id = randomUUID(), revision = (BigInt(plan.revision) + 1n).toString()
  const next = plan.values.with(0, id).with(4, revision).with(5, (BigInt(plan.nextVersion) + 1n).toString())
    .with(9, JSON.stringify({ ...plan.publicSnapshot, planRevisionId: id, revision }))
  const malformed = { lines: JSON.parse(next[7]).lines }, payload = canonicalFixture(malformed)
  await expectSqlRefusal('plan', 'missing schema version cannot exploit nullable CHECK', plan.insert,
    next.with(6, payload).with(7, JSON.stringify(malformed)).with(8, createHash('sha256').update(payload).digest('hex')),
    '23514', 'resource_plan_schema_exact')
  await expectSqlRefusal('plan', 'orphan revision refuses actual COMMIT', plan.insert, next, '23514', 'commit with its advanced order head', true)
}

async function planTermsFixture(f, plan, probes, customerSession = null) {
  const head = (await db.query('select version::text,terms_revision::text,source,brief,brief_category_id,brief_subtype_id from deal_orders where deal_id=$1', [f.deal])).rows[0]
  const events = (await db.query('select id,name,kind,date::text,time_zone,location,is_main from wedding_events where wedding_id=$1 order by id', [f.wedding])).rows
  const main = events.find(e => e.is_main)
  const assignments = (await db.query('select id,slot_id,version::text,source,label,program_event_id from order_assignments where deal_id=$1 and cancelled_at is null order by id', [f.deal])).rows.map(a => {
    const e = events.find(e => e.id === a.program_event_id); assert(e)
    return { id: a.id, slotId: a.slot_id, version: a.version, source: a.source, label: a.label,
      event: { id: e.id, name: e.name, kind: e.kind, date: e.date, timeZone: e.time_zone, location: e.location } }
  })
  const parts = (await db.query('select id,kind,version::text,source,title,assignment_id,details from order_parts where deal_id=$1 and cancelled_at is null order by id', [f.deal])).rows.map(p =>
    ({ id: p.id, kind: p.kind, version: p.version, source: p.source, title: p.title, assignmentId: p.assignment_id, details: p.details }))
  const economic = (await db.query('select price::text,currency,package_id,package_title_snapshot,package_includes_snapshot,external_name,external_phone from deals where id=$1', [f.deal])).rows[0]
  const vendor = (await db.query('select id,user_id,name,category_id from vendors where id=$1', [f.vendor])).rows[0]
  const id = randomUUID(), version = (BigInt(head.terms_revision) + 1n).toString()
  const value = { schemaVersion: 2, weddingId: f.wedding, dealId: f.deal, source: head.source,
    categoryId: vendor.category_id, sourceOrderVersion: head.version,
    legacyContext: { mainEvent: main ? { id: main.id, name: main.name, date: main.date, timeZone: main.time_zone, location: main.location } : null },
    brief: head.brief === null ? null : { categoryId: head.brief_category_id, ...(head.brief_subtype_id ? { subtypeId: head.brief_subtype_id } : {}), values: head.brief },
    assignments, parts, resourcePlan: plan.publicSnapshot,
    economics: { amount: economic.price, amountKnown: economic.price !== null, currency: economic.currency,
      performer: { vendor: { id: vendor.id, userId: vendor.user_id, name: vendor.name, categoryId: vendor.category_id }, externalName: economic.external_name, externalPhone: economic.external_phone },
      package: { id: economic.package_id, titleSnapshot: economic.package_title_snapshot, includesSnapshot: economic.package_includes_snapshot } } }
  const payload = canonicalFixture(value), digest = createHash('sha256').update(payload).digest('hex')
  const sql = `insert into deal_terms_versions(id,wedding_id,deal_id,version,source_order_version,source_fingerprint,
    canonical_payload,snapshot,digest,published_by,published_side,resource_plan_id)
    values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,'performer',$11)`
  const values = [id, f.wedding, f.deal, version, head.version, digest, payload, JSON.stringify(value), digest, f.vendorOwner, plan.plan]
  if (probes) {
    await expectSqlRefusal('plan', 'terms cannot bind nonexistent or foreign plan', sql, values.with(10, randomUUID()), '23514', 'exact immutable resource plan')
    const changed = { ...value, resourcePlan: { ...plan.publicSnapshot, lines: [] } }, changedPayload = canonicalFixture(changed)
    await expectSqlRefusal('plan', 'terms must contain exact safe plan snapshot', sql,
      values.with(6, changedPayload).with(7, JSON.stringify(changed)).with(8, createHash('sha256').update(changedPayload).digest('hex')),
      '23514', 'exact immutable resource plan')
    await expectSqlRefusal('plan', 'schema2 terms require resource plan pointer', sql, values.with(10, null), '23514', 'resource_plan_terms_format')
  }
  await write(sql, values)
  await write('update deal_orders set terms_revision=$2,proposed_terms_id=$3 where deal_id=$1', [f.deal, version, id])
  // Synthetic receipt history only, not proof of any human acceptance.
  for (const [party, user, session] of [['customer', f.owner, customerSession], ['performer', f.vendorOwner, f.session]]) {
    await write(`insert into deal_terms_receipts(id,wedding_id,deal_id,terms_id,party,user_id,session_id,digest)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), f.wedding, f.deal, id, party, user, session, digest])
  }
  assert.deepEqual((await db.query('select resource_plan_id,snapshot,canonical_payload,digest from deal_terms_versions where id=$1', [id])).rows[0],
    { resource_plan_id: plan.plan, snapshot: value, canonical_payload: payload, digest })
  return id
}

async function planWeddingCascade(f) {
  const before = await snapshot()
  await write('begin')
  try {
    await write('delete from weddings where id=$1', [f.wedding])
    await write('set constraints all immediate')
    for (const table of ['deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_resource_plan_versions', 'deal_terms_versions', 'deal_terms_receipts']) {
      assert.equal((await db.query(`select count(*)::int as count from ${quote(table)} where wedding_id=$1`, [f.wedding])).rows[0].count, 0, `${table}: actual wedding cascade must remove plan/terms dependencies`)
    }
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), before, 'Whole-wedding erasure probe must retain every original row and metadata after rollback')
  console.log('Actual whole-wedding plan/schema2-terms cascade passed and was rolled back; original money/program/history retained')
}

async function commitmentSource(company, phonePrefix, options = {}) {
  // These are explicitly synthetic SQL history fixtures. Distinct actual row
  // identities exercise schema proof guards; no human accepted anything here.
  const f = await fixture(false, phonePrefix), customerSession = randomUUID(), assignment = randomUUID()
  if (company) {
    f.vendor = company.vendor; f.vendorOwner = company.vendorOwner; f.session = company.session
  }
  await write("update deals set vendor_id=$2,state='candidate' where id=$1", [f.deal, f.vendor])
  await write('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [customerSession, f.owner, createHash('sha256').update(randomUUID()).digest('hex')])
  assert.notEqual(customerSession, f.session)
  assert.notEqual(f.owner, f.vendorOwner)
  if (options.globalPerson) {
    const member = randomUUID(), person = randomUUID()
    await write(`insert into vendor_staff_members(id,vendor_id,user_id,state,role,invite_token_hash,invite_expires_at,
      invited_by,accepted_at,accepted_session_id,invite_target_user_id,invite_binding_known)
      values($1,$2,$3,'active','worker',$4,'2026-10-30T12:00:00Z',$5,'2026-10-01T01:00:00Z',$6,$3,true)`,
    [member, f.vendor, options.globalPerson.vendorOwner, createHash('sha256').update(randomUUID()).digest('hex'), f.vendorOwner, options.globalPerson.session])
    await write(`insert into vendor_resources(id,vendor_id,kind,label,person_user_id,staff_member_id,conflict_identity,created_by)
      values($1,$2,'person','Synthetic person in another company',$3,$4,$3,$5)`, [person, f.vendor, options.globalPerson.vendorOwner, member, f.vendorOwner])
    options = { ...options, resourceIds: [person] }
    await write("insert into vendor_availability_policy(vendor_id,mode,changed_by) values($1,'resources',$2)", [f.vendor, f.vendorOwner])
  }
  await write("update deal_orders set source='structured',brief_category_id='photo',brief='{}' where deal_id=$1", [f.deal])
  await write(`insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label,created_by)
    values($1,$2,$3,$4,$5,'structured','Synthetic commitment work',$6)`, [assignment, f.wedding, f.deal, f.slot, f.mainEvent, f.owner])
  const plan = await planFixture(f, assignment, false, options)
  const terms = await planTermsFixture(f, plan, false, options.missingCustomerSession ? null : customerSession)
  await write('update deal_orders set agreed_terms_id=$2 where deal_id=$1', [f.deal, terms])
  if (!options.missingCustomerSession) {
    assert.deepEqual((await db.query(`select r.party,r.user_id,r.session_id,s.user_id as session_user from deal_terms_receipts r
      join sessions s on s.id=r.session_id where r.terms_id=$1 order by r.party`, [terms])).rows,
    [{ party: 'customer', user_id: f.owner, session_id: customerSession, session_user: f.owner },
      { party: 'performer', user_id: f.vendorOwner, session_id: f.session, session_user: f.vendorOwner }], 'Synthetic receipt history has two distinct actual actor/session rows; it is not human consent')
  }
  const policy = (await db.query('select revision::text,mode from vendor_availability_policy where vendor_id=$1', [f.vendor])).rows[0]
  assert.equal(policy.mode, 'resources')
  return { f, plan, terms, policy: policy.revision, lines: JSON.parse(plan.values[7]).lines,
    version: randomUUID(), revision: '1', allocations: [] }
}

const commitmentVersionSql = `insert into deal_resource_commitment_versions(id,wedding_id,deal_id,vendor_id,
  revision,previous_version_id,terms_id,plan_revision_id,policy_revision,action,state,reason,created_by)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`
function commitmentVersionValues(b, overrides = {}) {
  return [overrides.id ?? b.version, b.f.wedding, b.f.deal, b.f.vendor, overrides.revision ?? b.revision,
    overrides.previous ?? null, overrides.terms ?? b.terms, overrides.plan ?? b.plan.plan, overrides.policy ?? b.policy,
    overrides.action ?? 'commit', overrides.state ?? 'reserved', overrides.reason ?? null, b.f.vendorOwner]
}
const allocationSql = `insert into resource_allocations(id,wedding_id,deal_id,vendor_id,origin_version_id,origin_line_index,
  line_snapshot,resource_id,capacity_window_id,kind,conflict_identity,quantity,occupied_starts_at,occupied_ends_at)
  values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14)`
function allocationValues(b, line, index, id = randomUUID()) {
  return [id, b.f.wedding, b.f.deal, b.f.vendor, b.version, index, JSON.stringify(line), line.resourceId,
    line.capacityWindowId, line.kind, line.conflictIdentity, line.quantity, line.occupiedStartsAt, line.occupiedEndsAt]
}
async function insertSyntheticCommitment(b) {
  await write('insert into deal_resource_commitments(wedding_id,deal_id) values($1,$2)', [b.f.wedding, b.f.deal])
  await write(commitmentVersionSql, commitmentVersionValues(b))
  for (const [index, line] of b.lines.entries()) {
    await write('insert into resource_conflict_keys(kind,identity) values($1,$2) on conflict do nothing', [line.kind, line.conflictIdentity])
    const values = allocationValues(b, line, index)
    await write(allocationSql, values)
    await write(`insert into deal_resource_commitment_members(wedding_id,deal_id,version_id,line_index,allocation_id)
      values($1,$2,$3,$4,$5)`, [b.f.wedding, b.f.deal, b.version, index, values[0]])
  }
  await write("update deal_resource_commitments set revision=1,state='reserved',current_version_id=$2 where deal_id=$1", [b.f.deal, b.version])
  await write("update deals set state='booked' where id=$1", [b.f.deal])
}
async function persistSyntheticCommitment(b) {
  await write('begin')
  try { await insertSyntheticCommitment(b); await write('commit') }
  catch (error) { await db.query('rollback'); throw error }
  b.allocations = (await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [b.f.deal])).rows
  assert.equal(b.allocations.length, b.lines.length)
  for (const [index, row] of b.allocations.entries()) {
    assert.deepEqual(row.line_snapshot, b.lines[index])
    assert.equal(row.origin_version_id, b.version)
    assert.equal(row.released_at, null)
    assert.equal(row.occupied_starts_at.toISOString(), b.lines[index].occupiedStartsAt)
    assert.equal(row.occupied_ends_at.toISOString(), b.lines[index].occupiedEndsAt)
  }
}
async function windowCounter(id, used, baseline) {
  assert.deepEqual((await db.query('select used,legacy_used from resource_capacity_windows where id=$1', [id])).rows,
    [{ used, legacy_used: baseline }], 'Counter is preserved legacy inventory plus every live whole-window quantity')
}
async function commitmentHistoryFixture(company) {
  const first = await commitmentSource(company, '+1888000000', { equipment: true })
  const second = await commitmentSource(company, '+1888000001', { capacityOnly: true, quantity: 4, zeroBuffers: true,
    startsAt: '2027-06-14T11:45:00.000Z', endsAt: '2027-06-14T11:55:00.000Z' })
  const capacity = first.lines.find(l => l.kind === 'capacity'), baseline = 3
  assert(capacity)
  assert.equal(capacity.capacityWindowId, second.lines[0].capacityWindowId)
  assert(new Date(first.lines.find(l => l.kind === 'person').occupiedEndsAt) < new Date(second.lines[0].occupiedStartsAt), 'Disjoint periods still consume their whole shared capacity window')
  const inheritedBefore = await snapshot()
  await persistSyntheticCommitment(first)
  await windowCounter(capacity.capacityWindowId, baseline + 3, baseline)
  await persistSyntheticCommitment(second)
  await windowCounter(capacity.capacityWindowId, baseline + 3 + 4, baseline)
  const afterInitial = await snapshot()
  for (const table of ['payments', 'budget_items', 'vendor_busy_dates', 'vendor_program_acknowledgments', 'external_program_acknowledgments', 'notifications']) {
    assert.deepEqual(afterInitial.data[table], inheritedBefore.data[table], `SQL historical commitments cannot change ${table}`)
  }
  // A valid replacement can retain the same allocation and its origin proof.
  const originVersion = first.version, replacement = randomUUID(), originals = first.allocations
  await write('begin')
  try {
    await write(commitmentVersionSql, commitmentVersionValues(first, { id: replacement, revision: '2', previous: originVersion, action: 'replace' }))
    for (const [index, row] of originals.entries()) await write(`insert into deal_resource_commitment_members(wedding_id,deal_id,version_id,line_index,allocation_id)
      values($1,$2,$3,$4,$5)`, [first.f.wedding, first.f.deal, replacement, index, row.id])
    await write('update deal_resource_commitments set revision=2,current_version_id=$2 where deal_id=$1', [first.f.deal, replacement])
    await write('commit')
  } catch (error) { await db.query('rollback'); throw error }
  first.version = replacement; first.revision = '2'
  assert.deepEqual((await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [first.f.deal])).rows, originals, 'Replacement membership reuses immutable allocation IDs, original plan bytes and origin proof')
  assert.deepEqual((await db.query('select id,revision::text,previous_version_id,action from deal_resource_commitment_versions where deal_id=$1 order by revision', [first.f.deal])).rows,
    [{ id: originVersion, revision: '1', previous_version_id: null, action: 'commit' }, { id: replacement, revision: '2', previous_version_id: originVersion, action: 'replace' }])
  assert.deepEqual((await db.query('select version_id,count(*)::int as count from deal_resource_commitment_members where deal_id=$1 group by version_id order by version_id', [first.f.deal])).rows,
    [originVersion, replacement].sort().map(version_id => ({ version_id, count: originals.length })))
  await windowCounter(capacity.capacityWindowId, baseline + 3 + 4, baseline)

  const otherCompany = await commitmentSource(null, '+1888000002', { globalPerson: company, zeroBuffers: true })
  assert.notEqual(otherCompany.f.vendor, first.f.vendor)
  assert.notEqual(otherCompany.f.wedding, first.f.wedding)
  assert.equal(otherCompany.lines[0].conflictIdentity, first.lines.find(l => l.kind === 'person').conflictIdentity)
  await expectSqlRefusal('commitment', 'same actual person overlaps across companies and weddings', () => insertSyntheticCommitment(otherCompany), [], '23P01')
  const adjacent = await commitmentSource(otherCompany.f, '+1888000004', { resourceIds: [otherCompany.lines[0].resourceId], zeroBuffers: true,
    startsAt: '2027-06-14T11:35:00.000Z', endsAt: '2027-06-14T12:05:00.000Z' })
  assert.equal(adjacent.lines[0].occupiedStartsAt, first.lines.find(l => l.kind === 'person').occupiedEndsAt)
  await persistSyntheticCommitment(adjacent)
  assert.equal(adjacent.allocations[0].conflict_identity, first.lines.find(l => l.kind === 'person').conflictIdentity, 'Adjacent [start,end) commitments of one actual person across companies may coexist')
  const missingProof = await commitmentSource(company, '+1888000003', { capacityOnly: true, missingCustomerSession: true })
  await expectSqlRefusal('commitment', 'synthetic receipt without actual distinct session cannot authorize allocation',
    () => insertSyntheticCommitment(missingProof), [], '23514', 'distinct accepted proof')
  await windowCounter(capacity.capacityWindowId, baseline + 3 + 4, baseline)
  const person = first.allocations.find(l => l.kind === 'person'), cap = first.allocations.find(l => l.kind === 'capacity')
  const probes = [
    ['allocation period cannot change', "update resource_allocations set occupied_ends_at=occupied_ends_at+interval '1 second' where id=$1", [person.id], '23514', 'allocation facts are immutable'],
    ['allocation quantity cannot change', 'update resource_allocations set quantity=quantity+1 where id=$1', [cap.id], '23514', 'allocation facts are immutable'],
    ['allocation identity cannot change', 'update resource_allocations set conflict_identity=$2 where id=$1', [person.id, randomUUID()], '23514', 'allocation facts are immutable'],
    ['allocation resource cannot change', 'update resource_allocations set resource_id=$2 where id=$1', [person.id, cap.resource_id], '23514', 'allocation facts are immutable'],
    ['individual allocation history cannot be erased', 'delete from resource_allocations where id=$1', [person.id], '23514', 'only be erased with wedding'],
    ['individual version history cannot be erased', 'delete from deal_resource_commitment_versions where id=$1', [first.version], '23514', 'only be erased with wedding'],
    ['live version author cannot be detached', 'update deal_resource_commitment_versions set created_by=null where id=$1', [first.version], '23514', 'commitment evidence is immutable'],
    ['version proof is immutable', 'update deal_resource_commitment_versions set terms_id=$2 where id=$1', [first.version, second.terms], '23514', 'commitment evidence is immutable'],
    ['version plan is immutable', 'update deal_resource_commitment_versions set plan_revision_id=$2 where id=$1', [first.version, second.plan.plan], '23514', 'commitment evidence is immutable'],
    ['head cannot skip a revision', 'update deal_resource_commitments set revision=revision+1 where deal_id=$1', [first.f.deal], '23514', 'head must advance'],
    ['head cannot point to foreign history', 'update deal_resource_commitments set current_version_id=$2 where deal_id=$1', [first.f.deal, second.version], '23514', 'head must advance'],
    ['membership cannot be erased', 'delete from deal_resource_commitment_members where version_id=$1', [first.version], '23514', 'membership evidence is immutable'],
    ['membership cannot replace allocation', 'update deal_resource_commitment_members set allocation_id=$2 where version_id=$1', [first.version, second.allocations[0].id], '23514', 'membership evidence is immutable'],
    ['historical inventory baseline cannot change', 'update resource_capacity_windows set legacy_used=legacy_used+1,used=used+1 where id=$1', [capacity.capacityWindowId], '23514', 'historical baseline cannot change'],
    ['history restricts selected window deletion', 'delete from resource_capacity_windows where id=$1', [capacity.capacityWindowId], '23503'],
    ['history restricts selected resource deletion', 'delete from vendor_resources where id=$1', [person.resource_id], '23503'],
    ['release without matching next proof is refused', "update resource_allocations set released_at=clock_timestamp(),release_reason='replaced' where id=$1", [person.id], '23514', 'matching next scoped commitment proof'],
  ]
  for (const [label, sql, values, code, message] of probes) await expectSqlRefusal('commitment', label, sql, values, code, message)
  await expectSqlRefusal('commitment', 'used must equal preserved baseline plus actual live ledger',
    'update resource_capacity_windows set used=used+1 where id=$1', [capacity.capacityWindowId], '23514', 'allocation ledger and used counter differ', true)
  const next = () => commitmentVersionValues(first, { id: randomUUID(), revision: '3', previous: first.version, action: 'replace' })
  await expectSqlRefusal('commitment', 'wrong policy revision cannot reuse accepted proof', commitmentVersionSql, next().with(8, '999'), '23514', 'exact company policy and distinct accepted proof')
  await expectSqlRefusal('commitment', 'foreign terms cannot authorize own history', commitmentVersionSql, next().with(6, second.terms), '23514', 'exact scoped accepted resource plan')
  await expectSqlRefusal('commitment', 'orphan version refuses actual COMMIT after INSERT succeeds', async () => {
    const values = next(); await write(commitmentVersionSql, values)
    assert.equal((await db.query('select 1 from deal_resource_commitment_versions where id=$1', [values[0]])).rowCount, 1)
  }, [], '23514', 'orphan commitment version', true)
  await expectSqlRefusal('commitment', 'incomplete current membership refuses actual COMMIT', async () => {
    const values = next(); await write(commitmentVersionSql, values)
    await write('update deal_resource_commitments set revision=3,current_version_id=$2 where deal_id=$1', [first.f.deal, values[0]])
  }, [], '23514', 'current commitment membership incomplete', true)
  await expectSqlRefusal('commitment', 'replacement proof cannot be relabelled as vendor erasure', async () => {
    await write(commitmentVersionSql, next())
    await write("update resource_allocations set released_at=clock_timestamp(),release_reason='vendor_erased' where id=$1", [person.id])
  }, [], '23514', 'matching next scoped commitment proof')
  await expectSqlRefusal('commitment', 'active financial deal cannot supply cancellation proof', commitmentVersionSql,
    commitmentVersionValues(first, { id: randomUUID(), revision: '3', previous: first.version, action: 'release', state: 'released', reason: 'deal_cancelled' }),
    '23514', 'actual financial cancellation')

  const cascadeBefore = await snapshot(), foreignBefore = second.allocations
  await write('begin')
  try {
    await write('delete from weddings where id=$1', [first.f.wedding])
    await write('set constraints all immediate')
    for (const table of ['deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions',
      'deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations']) {
      assert.equal((await db.query(`select 1 from ${quote(table)} where wedding_id=$1`, [first.f.wedding])).rowCount, 0, `${table}: actual complete wedding cascade must erase its scoped history`)
    }
    await windowCounter(capacity.capacityWindowId, baseline + 4, baseline)
    assert.deepEqual((await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [second.f.deal])).rows, foreignBefore)
    assert.deepEqual((await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [adjacent.f.deal])).rows, adjacent.allocations)
    const after = await snapshot()
    for (const table of ['deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions']) {
      assert.deepEqual(after.data[table].filter(r => r.wedding_id !== first.f.wedding), cascadeBefore.data[table].filter(r => r.wedding_id !== first.f.wedding), `${table}: every foreign wedding/company proof stays intact`)
    }
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), cascadeBefore, 'Actual cascade probe rollback restores all business, private/public/history, metadata and journal')

  const release = randomUUID(), beforeRelease = await snapshot()
  await write('begin')
  try {
    await write("update deals set state='cancelled' where id=$1", [first.f.deal])
    await write(commitmentVersionSql, commitmentVersionValues(first, { id: release, revision: '3', previous: first.version, action: 'release', state: 'released', reason: 'deal_cancelled' }))
    await write("update resource_allocations set released_at=clock_timestamp(),release_reason='deal_cancelled' where deal_id=$1 and released_at is null", [first.f.deal])
    await write("update deal_resource_commitments set revision=3,state='released',current_version_id=$2 where deal_id=$1", [first.f.deal, release])
    await write('commit')
  } catch (error) { await db.query('rollback'); throw error }
  await windowCounter(capacity.capacityWindowId, baseline + 4, baseline)
  const released = (await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [first.f.deal])).rows
  assert.deepEqual(released.map(r => ({ ...r, released_at: null, release_reason: null })), originals, 'Explicit release retains every immutable allocation and original version/line bytes')
  assert(released.every(r => r.released_at instanceof Date && r.release_reason === 'deal_cancelled'))
  assert.deepEqual((await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [second.f.deal])).rows, foreignBefore)
  assert.deepEqual((await db.query('select * from resource_allocations where deal_id=$1 order by origin_line_index', [adjacent.f.deal])).rows, adjacent.allocations)
  const afterRelease = await snapshot()
  for (const table of ['payments', 'budget_items', 'vendor_busy_dates', 'vendor_program_acknowledgments', 'external_program_acknowledgments', 'notifications', 'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions']) {
    assert.deepEqual(afterRelease.data[table], beforeRelease.data[table], `${table}: synthetic release retains financial/program/plan/terms history`)
  }
  await expectSqlRefusal('commitment', 'released allocation cannot be reopened', 'update resource_allocations set released_at=null,release_reason=null where id=$1', [person.id], '23514', 'release is one way')
  await expectSqlRefusal('commitment', 'released allocation time cannot be edited', "update resource_allocations set released_at=released_at+interval '1 second' where id=$1", [person.id], '23514', 'release is one way')
  await expectSqlRefusal('commitment', 'released reason cannot be relabelled', "update resource_allocations set release_reason='vendor_erased' where id=$1", [person.id], '23514', 'release is one way')
  await expectSqlRefusal('commitment', 'released allocation history cannot be erased', 'delete from resource_allocations where id=$1', [person.id], '23514', 'only be erased with wedding')
  assert.equal(commitmentNegativeCount, probes.length + 13, 'Every enumerated commitment invariant, real COMMIT, missing proof and global conflict probe must execute')
  console.log('Synthetic commitment history preserved exact initial/retained origin versions and members, explicit buffers/UTC bytes, whole-window legacy+3+4 counters, foreign wedding/company conflict and release/cascade isolation; this is not real human consent or public booking acceptance')
}

async function eraseCurrentVendorFixture() {
  const original = await snapshot(), f = await fixture(true, '+1777000000'), assignment = randomUUID()
  await write("update deal_orders set source='structured',brief_category_id='photo',brief='{}' where deal_id=$1", [f.deal])
  await write(`insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label,created_by)
    values($1,$2,$3,$4,$5,'structured','Synthetic erase fixture work',$6)`, [assignment, f.wedding, f.deal, f.slot, f.mainEvent, f.owner])
  const person = randomUUID(), capacity = randomUUID()
  await write(`insert into vendor_resources(id,vendor_id,kind,label,person_user_id,conflict_identity,created_by)
    values($1,$2,'person','Synthetic owner person',$3,$3,$3)`, [person, f.vendor, f.vendorOwner])
  await write(`insert into vendor_resources(id,vendor_id,kind,label,capacity_unit,conflict_identity,created_by)
    values($1,$2,'capacity','Synthetic erase capacity','bouquets',$1,$3)`, [capacity, f.vendor, f.vendorOwner])
  await write(`insert into resource_capacity_windows(id,resource_id,starts_at,ends_at,capacity,used,created_by)
    values($1,$2,'2027-06-14T08:00:00Z','2027-06-14T12:00:00Z',100,0,$3)`, [randomUUID(), capacity, f.vendorOwner])
  const plan = await planFixture(f, assignment, false), terms = await planTermsFixture(f, plan, false)
  const before = await erasePreservedFacts(f)
  await safety()
  // The child imports actual isolated application code; it neither starts a
  // worker/server nor constructs Redis/queue/provider clients. Its only write
  // is actual eraseUser in this brand-new fenced drill database. That function's
  // global stale-idempotency prune is permitted only in this isolated namespace.
  const child = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { eraseUser } from './src/jobs/index.ts';
    import { readResourcePlanSource } from './src/orders/resource-plan.ts';
    const allowed=${JSON.stringify(DATABASES)}, expected=${JSON.stringify(DATABASE)}, port=${JSON.stringify(selectedPort)}, f=${JSON.stringify(f)};
    assert(['55432','15432'].includes(port)); assert.equal(process.env.TILI_DISPOSABLE_PG_PORT,port);
    assert.equal(process.cwd().replaceAll('\\\\','/'),${JSON.stringify(backend.replaceAll('\\', '/'))});
    const u=new URL(process.env.DATABASE_URL);
    assert(['postgres:','postgresql:'].includes(u.protocol)); assert(['127.0.0.1','localhost','[::1]'].includes(u.hostname));
    assert.equal(u.port,port); assert.equal(u.username,'codex_test'); assert.equal(u.password,''); assert.equal(u.search,''); assert.equal(u.hash,'');
    assert(allowed.includes(decodeURIComponent(u.pathname.slice(1)))); assert.equal(decodeURIComponent(u.pathname.slice(1)),expected);
    assert.equal(new URL(process.env.TEST_DATABASE_URL).href,u.href);
    const c=new pg.Client({connectionString:u.href,statement_timeout:20000,connectionTimeoutMillis:5000}); await c.connect();
    try {
      const i=(await c.query('select current_database() as name,current_user as principal,host(inet_server_addr()) as address,inet_server_port() as port')).rows[0];
      assert.equal(i.name,expected); assert.equal(i.principal,'codex_test'); assert.equal(i.port,Number(port)); assert(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(i.address));
      await c.query('begin');
      const before=await readResourcePlanSource(c,{weddingId:f.wedding,dealId:f.deal,vendorId:f.vendor}); assert.equal(before.source,'current'); assert(before.plan);
      await eraseUser(c,f.vendorOwner); await c.query('set constraints all immediate'); await c.query('commit');
      await c.query('begin');
      const after=await readResourcePlanSource(c,{weddingId:f.wedding,dealId:f.deal,vendorId:null});
      assert.equal(after.source,'unavailable'); assert.deepEqual(after.plan,before.plan); await c.query('rollback');
      console.log('ACTUAL_ERASE_USER_CURRENT_VENDOR_PRESERVED_PLAN_UNAVAILABLE');
    } catch(e) { await c.query('rollback'); throw e; } finally { await c.end(); }
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', child],
    { cwd: backend, env: { ...process.env, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  assert(!result.error, 'Child process failure is not erasure evidence')
  assert.equal(result.status, 0, `Actual eraseUser child failed:\n${result.stdout || ''}${result.stderr || ''}`)
  assert(result.stdout.includes('ACTUAL_ERASE_USER_CURRENT_VENDOR_PRESERVED_PLAN_UNAVAILABLE'))
  console.log(result.stdout.trim())
  assert.deepEqual(await erasePreservedFacts(f), before, 'Additional fixture money/order/program/private-plan/terms bytes and counters must survive actual current-vendor erasure')
  assert.equal((await db.query('select 1 from users where id=$1', [f.vendorOwner])).rowCount, 0)
  assert.equal((await db.query('select 1 from vendors where id=$1', [f.vendor])).rowCount, 0)
  assert.deepEqual((await db.query('select vendor_id,external_name from deals where id=$1', [f.deal])).rows[0], { vendor_id: null, external_name: 'Удалённый подрядчик' })
  assert.equal((await db.query('select created_by from deal_resource_plan_versions where id=$1', [plan.plan])).rows[0].created_by, null)
  assert.equal((await db.query('select published_by from deal_terms_versions where id=$1', [terms])).rows[0].published_by, null)
  assert.deepEqual((await db.query('select party,user_id,session_id from deal_terms_receipts where terms_id=$1 order by party', [terms])).rows,
    [{ party: 'customer', user_id: f.owner, session_id: null }, { party: 'performer', user_id: null, session_id: null }], 'Only erased principal/session references are detached; receipt history remains')
  assert.equal((await db.query('select 1 from vendor_resources where vendor_id=$1', [f.vendor])).rowCount, 0)
  assert.deepEqual((await db.query('select vendor_id,person_user_id,created_by from vendor_resources where id=$1', [person])).rows[0], { vendor_id: null, person_user_id: null, created_by: null })
  // Inherited 176220 deliberately cascades this erased performer's program
  // acknowledgment; timeline and external acknowledgment remain intact.
  assert.equal((await db.query('select 1 from vendor_program_acknowledgments where wedding_id=$1', [f.wedding])).rowCount, 0)
  const after = await snapshot()
  assert.deepEqual(after.schema, original.schema)
  for (const [table, retained] of Object.entries(original.data)) {
    const remaining = after.data[table].map(canonicalFixture)
    for (const row of retained) { const index = remaining.indexOf(canonicalFixture(row)); assert(index >= 0, `Actual erase must not alter retained original ${table} history`); remaining.splice(index, 1) }
  }
  console.log('Actual current-vendor account erasure preserved additional financial/program/plan/schema2-terms history, detached company/creator, kept source explicitly unavailable; original inherited fixture unchanged')
}

async function erasePreservedFacts(f) {
  const facts = {}
  for (const table of ['payments', 'timeline_events', 'timeline_assignments', 'budget_items', 'external_program_acknowledgments', 'order_assignments', 'order_parts', 'deal_orders']) {
    const predicate = table === 'payments' ? 'deal_id=$1' : 'wedding_id=$1'
    facts[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') as value from (select * from ${quote(table)} where ${predicate}) t`, [table === 'payments' ? f.deal : f.wedding])).rows[0].value
  }
  for (const [table, removed] of [['deal_resource_plan_versions', 'created_by'], ['deal_terms_versions', 'published_by']]) {
    facts[table] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(t)-$2::text order by to_jsonb(t)::text),'[]') as value from ${quote(table)} t where wedding_id=$1`, [f.wedding, removed])).rows[0].value
  }
  facts.receipts = (await db.query(`select id,wedding_id,deal_id,terms_id,party,digest,accepted_at from deal_terms_receipts where wedding_id=$1 order by id`, [f.wedding])).rows
  facts.deal = (await db.query(`select id,wedding_id,slot_id,state,price::text,currency,package_title_snapshot,package_includes_snapshot from deals where id=$1`, [f.deal])).rows[0]
  facts.capacity = (await db.query(`select w.id,w.resource_id,w.starts_at,w.ends_at,w.capacity,w.used,w.version::text from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id where r.id in
    (select (line->>'resourceId')::uuid from deal_resource_plan_versions p cross join lateral jsonb_array_elements(p.private_snapshot->'lines') line where p.deal_id=$1) order by w.id`, [f.deal])).rows
  return facts
}

/**
 * T012 (1763700000000_event_rsvp_deadlines): deadline CHECK on wedding_events,
 * extended event_guest_participation.source enum, and the new event_rsvp_requests
 * table (pending-partial-unique index, state/decided_at CHECK, immutability
 * trigger). Synthetic SQL fixture only; it proves schema invariants, not a
 * real guest answer or couple decision.
 */
async function eventRsvpDeadlineFixture(f) {
  await expectSqlRefusal('t012', 'rsvp deadline requires a non-main event', 'update wedding_events set rsvp_deadline=$2 where id=$1', [f.mainEvent, '2027-06-10'], '23514')
  await expectSqlRefusal('t012', 'rsvp deadline requires a known time zone', 'update wedding_events set time_zone=null,rsvp_deadline=$2 where id=$1', [f.secondEvent, '2027-06-10'], '23514')
  // P2-4: deadline cannot be later than the event's own date (secondEvent's date is 2027-06-15).
  await expectSqlRefusal('t012', 'rsvp deadline cannot be later than the event date', 'update wedding_events set rsvp_deadline=$2 where id=$1', [f.secondEvent, '2027-06-20'], '23514')
  await write('update wedding_events set rsvp_deadline=$2 where id=$1', [f.secondEvent, '2027-06-10'])
  await expectSqlRefusal('t012', 'clearing the zone while a deadline stands is refused', 'update wedding_events set time_zone=null where id=$1', [f.secondEvent], '23514')

  const guest = f.guestYes
  const party = (await db.query('select party_id from guests where id=$1', [guest])).rows[0].party_id
  const foreignParty = (await db.query('select party_id from guests where id=$1', [f.guestNo])).rows[0].party_id
  await expectSqlRefusal('t012', 'participation source is still a closed enum', "update event_guest_participation set source='invented' where program_event_id=$1 and guest_id=$2", [f.mainEvent, guest], '23514')
  await write(`insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source,actor_user_id)
    values($1,$2,$3,'attending','organizer_correction',$4)
    on conflict(program_event_id,guest_id) do update set status=excluded.status,source=excluded.source,actor_user_id=excluded.actor_user_id,version=event_guest_participation.version+1`,
  [f.wedding, f.secondEvent, guest, f.owner])
  assert.equal((await db.query('select source from event_guest_participation where program_event_id=$1 and guest_id=$2', [f.secondEvent, guest])).rows[0].source, 'organizer_correction')

  const request = randomUUID()
  await expectSqlRefusal('t012', 'a pending request requires a null decision time',
    'insert into event_rsvp_requests(id,wedding_id,program_event_id,guest_id,party_id,requested_status,state,decided_at,idempotency_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [randomUUID(), f.wedding, f.secondEvent, guest, party, 'attending', 'pending', '2026-09-30T12:00:00Z', randomUUID()], '23514')
  // P3-9: party_id must be the GUEST's own party — guest is in `party`, not `foreignParty`
  // (guestNo's own, separate, single-person party). Two independent FKs would both be
  // individually satisfiable here; only the composite FK on (guest_id,party_id) catches it.
  await expectSqlRefusal('t012', 'event_rsvp_requests.party_id must match the guest\'s actual party',
    'insert into event_rsvp_requests(id,wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key) values($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), f.wedding, f.secondEvent, guest, foreignParty, 'attending', randomUUID()], '23503')
  await write('insert into event_rsvp_requests(id,wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key) values($1,$2,$3,$4,$5,$6,$7)',
    [request, f.wedding, f.secondEvent, guest, party, 'declined', randomUUID()])
  await expectSqlRefusal('t012', 'only one pending request per person/event',
    'insert into event_rsvp_requests(id,wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key) values($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), f.wedding, f.secondEvent, guest, party, 'attending', randomUUID()], '23505')
  await expectSqlRefusal('t012', 'request identity is immutable', 'update event_rsvp_requests set requested_status=$2 where id=$1', [request, 'attending'], '23514', 'event rsvp request identity is immutable')
  await write("update event_rsvp_requests set state='accepted',decided_at=clock_timestamp(),decided_by=$2,version=version+1 where id=$1", [request, f.owner])
  await expectSqlRefusal('t012', 'a decided request cannot go back to pending without a decision time', "update event_rsvp_requests set state='pending' where id=$1", [request], '23514')
  // P3-9: resetting decided_at ALONGSIDE state keeps the pre-existing (state,decided_at)
  // CHECK satisfied — only the dedicated state-immutability clause in the trigger catches this.
  await expectSqlRefusal('t012', 'a decided request cannot go back to pending even with decided_at reset together',
    "update event_rsvp_requests set state='pending',decided_at=null where id=$1", [request], '23514', 'event rsvp request identity is immutable')
  await expectSqlRefusal('t012', 'a decided request cannot flip to the other decision either',
    "update event_rsvp_requests set state='rejected' where id=$1", [request], '23514', 'event rsvp request identity is immutable')
  // P1-1: DELETE is deliberately unguarded now (only UPDATE immutability remains) — the old
  // BEFORE DELETE guard also fired for ordinary ON DELETE CASCADE from guest/party/event/wedding
  // deletion and broke those (500). Prove a (disposable, separate) row can actually be removed
  // directly; `request` itself is left alone so it still exists for the down-guard check below.
  const disposable = randomUUID()
  await write('insert into event_rsvp_requests(id,wedding_id,program_event_id,guest_id,party_id,requested_status,idempotency_key) values($1,$2,$3,$4,$5,$6,$7)',
    [disposable, f.wedding, f.secondEvent, guest, party, 'attending', randomUUID()])
  await write('delete from event_rsvp_requests where id=$1', [disposable])
  assert.equal((await db.query('select count(*)::int as n from event_rsvp_requests where id=$1', [disposable])).rows[0].n, 0,
    'event_rsvp_requests rows must be deletable now that only UPDATE is guarded (P1-1)')

  await expectAtomicRefusal('Refusing rollback with event RSVP deadlines, requests or organizer corrections', 1763700000000)
  console.log(`T012 checks passed: ${t012NegativeCount} actual SQL refusals plus one guarded CLI down; schema-level deadline/source/request invariants hold — synthetic fixture only, not a real guest answer or couple decision`)
}

/** Actual populated 370 -> 380 upgrade; independent SQL fixtures and refusals.
 * All captured facts are synthetic history, never consent or finite occupancy. */
async function inventoryForwardFixture(f) {
  assert.equal((await db.query("select to_regclass('legacy_calendar_sources') t")).rows[0].t, null)
  const foreign = await fixture(false, '+1555000930')
  const extra = {}
  for (const [label, state] of [['shared', 'booked'], ['doneOther', 'done'], ['doneLedgerless', 'done'], ['negotiation', 'negotiating'], ['cancelled', 'cancelled']]) {
    const slot = randomUUID(), deal = randomUUID(); extra[label] = deal
    await write("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo',$3)", [slot, f.wedding, `Synthetic inventory ${label}`])
    await write(`insert into deals(id,wedding_id,slot_id,vendor_id,state,price,negotiating_until)
      values($1,$2,$3,$4,$5,987654321,case when $5='negotiating' then clock_timestamp()+interval '10 days' else null end)`, [deal, f.wedding, slot, f.vendor, state])
    await write('update slots set deal_id=$2 where id=$1', [slot, deal])
  }
  await write(`insert into vendor_busy_dates(vendor_id,date,source,deal_id,created_at) values
    ($1,'2031-02-02','deal',$2,'2026-10-01T01:02:03.123456Z'),
    ($1,'2031-02-03','manual',null,'2026-10-01T01:02:03.234567Z'),
    ($1,'2031-02-04','deal',null,'2026-10-01T01:02:03.345678Z'),
    ($1,'2031-02-05','deal',$3,'2026-10-01T01:02:03.456789Z'),
    ($1,'2031-02-06','deal',$4,'2026-10-01T01:02:03.567890Z')`, [f.vendor, extra.doneOther, foreign.deal, extra.cancelled])
  const before = await snapshot(), layout = {}
  for (const table of Object.keys(before.data)) layout[table] = await columns(table)
  const expectedDays = (await db.query(`select vendor_id,date::text,case when source='manual' then 'manual_day'
    when deal_id is null then 'orphan_day' else 'app_day' end kind from vendor_busy_dates order by vendor_id,date`)).rows
  const expectedRoots = (await db.query(`select d.id,case when d.state='negotiating' then 'live_negotiation' else 'app_root' end kind
    from deals d where d.vendor_id is not null and (d.state='negotiating' or (d.state in ('booked','paid_deposit','done')
      and not exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0))) order by d.id`)).rows
  await migrate('up', PRE_RECOVERY)
  for (const [table, data] of Object.entries(before.data)) {
    if (table !== 'pgmigrations') assert.deepEqual(await rows(table, layout[table]), data, `380 must preserve every inherited ${table} value`)
  }
  assert.deepEqual((await db.query(`select b.vendor_id,b.date::text,s.kind from vendor_busy_dates b
    join legacy_calendar_sources s on s.day_id=b.id order by b.vendor_id,b.date`)).rows, expectedDays, 'Backfill must discover every day exactly once with its actual class')
  assert.deepEqual((await db.query('select root_deal_id as id,kind from legacy_calendar_sources where root_deal_id is not null order by root_deal_id')).rows,
    expectedRoots, 'Backfill must include all ledgerless committed roots and negotiations without inventing a reservation')
  const evidence = (await db.query(`select s.id,s.kind,s.origin,v.id as version,v.canonical,v.digest,h.revision::text,
    v.capture_kind,v.captured_by,legacy_calendar_inventory_material(s)::text current_material,
    (select count(*)::int from legacy_calendar_version_holders vh where vh.version_id=v.id) holder_count
    from legacy_calendar_sources s join legacy_calendar_heads h on h.source_id=s.id
    join legacy_calendar_versions v on v.id=h.current_version_id order by s.id`)).rows
  assert.equal(evidence.length, expectedDays.length + expectedRoots.length)
  for (const row of evidence) {
    assert.equal(row.revision, '1'); assert.equal(row.capture_kind, 'migration_backfill'); assert.equal(row.captured_by, null)
    assert.equal(row.canonical, row.current_material)
    assert.equal(row.digest, createHash('sha256').update(row.canonical, 'utf8').digest('hex'))
    assert.equal(row.holder_count, JSON.parse(row.canonical).holders.length)
  }
  const shared = (await db.query(`select s.id,v.id as version,v.canonical,v.digest,b.id as day_id,b.source_revision::text
    from legacy_calendar_sources s join vendor_busy_dates b on b.id=s.day_id
    join legacy_calendar_heads h on h.source_id=s.id join legacy_calendar_versions v on v.id=h.current_version_id
    where b.vendor_id=$1 and b.date='2027-06-14' and s.kind='app_day'`, [f.vendor])).rows[0]
  assert(shared)
  const group = JSON.parse(shared.canonical).holders.map(h => h.dealId)
  assert(group.includes(f.deal)); assert(group.includes(extra.shared)); assert(group.includes(extra.doneLedgerless))
  assert(!group.includes(extra.doneOther), 'Done root holding its own other day is excluded from the shared day')
  assert(group.every(id => ![extra.negotiation, extra.cancelled, foreign.deal].includes(id)))
  const classes = (await db.query(`select s.kind,b.date::text,legacy_calendar_inventory_material(s) mat
    from legacy_calendar_sources s join vendor_busy_dates b on b.id=s.day_id
    where b.vendor_id=$1 and b.date between '2031-02-03' and '2031-02-06' order by b.date`, [f.vendor])).rows
  assert.deepEqual(classes.map(r => [r.kind, r.mat.completeness, r.mat.reason, r.mat.holders.length]),
    [['manual_day', 'complete', null, 0], ['orphan_day', 'unknown', 'orphan', 0], ['app_day', 'unknown', 'mixed_scope', 0], ['app_day', 'unknown', 'mixed_scope', 0]])
  const bytes = await rows('legacy_calendar_versions')
  await write('begin')
  try {
    await write("set local timezone='Pacific/Auckland'"); await write("set local datestyle='SQL, DMY'")
    for (const row of evidence) assert.equal((await db.query('select legacy_calendar_inventory_material(s)::text canonical from legacy_calendar_sources s where id=$1', [row.id])).rows[0].canonical, row.canonical)
  } finally { await db.query('rollback') }
  assert.deepEqual(await rows('legacy_calendar_versions'), bytes, 'Session formatting cannot alter canonical bytes')
  const repeated = await snapshot(); await migrate('up', PRE_RECOVERY)
  assert.deepEqual(await snapshot(), repeated, 'Populated repeat must be an exact no-op')
  const unchanged = await snapshot()
  assert.deepEqual((await write("select * from legacy_calendar_append_version($1,$2,'owner_capture')", [shared.id, f.vendorOwner])).rows[0],
    { version_id: shared.version, revision: '1', created: false })
  assert.deepEqual(await snapshot(), unchanged, 'Identical capture neither adds evidence nor changes a head')

  const nextVersion = `insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
    select $1,s.id,h.revision+1,h.current_version_id,m.canonical,encode(sha256(convert_to(m.canonical,'UTF8')),'hex'),'owner_capture',$3
    from legacy_calendar_sources s join legacy_calendar_heads h on h.source_id=s.id
    cross join lateral (select legacy_calendar_inventory_material(s)::text canonical) m where s.id=$2`
  const refuse = (label, sql, values, message, atCommit = false) => expectSqlRefusal('inventory', label, sql, values, '23514', message, atCommit)
  await refuse('immutable source', 'update legacy_calendar_sources set discovered_by=discovered_by where id=$1', [shared.id], 'source is immutable')
  await refuse('history cannot be deleted while parent lives', 'delete from legacy_calendar_sources where id=$1', [shared.id], 'can only be erased')
  await refuse('source must match actual origin', `insert into legacy_calendar_sources(kind,vendor_id,wedding_id,day_id,origin,discovered_by)
    values('app_day',$1,$2,$3,'{}','writer')`, [f.vendor, f.wedding, shared.day_id], 'actual operational origin')
  for (const [kind, state] of [['app_root', 'booked'], ['live_negotiation', 'negotiating']]) {
    await refuse(`${kind} cannot attach an external root to a company`, async () => {
      const slot = randomUUID(), deal = randomUUID(), source = randomUUID()
      await write("insert into slots(id,wedding_id,category_id,label) values($1,$2,'host','Synthetic external inventory refusal')", [slot, f.wedding])
      await write("insert into deals(id,wedding_id,slot_id,external_name,state,price) values($1,$2,$3,'Synthetic external contractor',$4,12345)", [deal, f.wedding, slot, state])
      await write(`insert into legacy_calendar_sources(id,kind,vendor_id,wedding_id,root_deal_id,origin,discovered_by)
        values($1,$2,$3,$4,$5,legacy_calendar_origin($2,null,$5),'writer')`, [source, kind, f.vendor, f.wedding, deal])
      await write('insert into legacy_calendar_heads(source_id) values($1)', [source])
    }, [], 'actual operational origin')
  }
  await refuse('exact next version', `insert into legacy_calendar_versions(source_id,revision,canonical,digest,capture_kind)
    values($1,9,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'),'owner_capture')`, [shared.id], 'next exact head revision')
  await refuse('canonical must equal current material', `insert into legacy_calendar_versions(source_id,revision,canonical,digest,capture_kind)
    values($1,2,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'),'owner_capture')`, [shared.id], 'equal current material')
  await refuse('capture author is current owner', nextVersion, [randomUUID(), shared.id, f.owner], 'current company owner')
  await refuse('immutable captured evidence', 'update legacy_calendar_versions set canonical=canonical where id=$1', [shared.version], 'evidence is immutable')
  await refuse('holder equals captured material', `insert into legacy_calendar_version_holders(source_id,version_id,wedding_id,deal_id,snapshot,fingerprint)
    values($1,$2,$3,$4,'{}',encode(sha256(convert_to('{}','UTF8')),'hex'))`, [shared.id, shared.version, f.wedding, randomUUID()], 'match captured material')
  await refuse('immutable holder', 'update legacy_calendar_version_holders set snapshot=snapshot where version_id=$1', [shared.version], 'evidence is immutable')
  await refuse('head cannot skip revisions', 'update legacy_calendar_heads set revision=99 where source_id=$1', [shared.id], 'advance by one exact revision')
  await refuse('orphan subsequent version fails COMMIT', nextVersion, [randomUUID(), shared.id, f.vendorOwner], 'orphan inventory version', true)
  await refuse('day identity is immutable', "update vendor_busy_dates set date=date+1 where id=$1", [shared.day_id], 'day identity is immutable')
  await refuse('revision is maintained by database', 'update vendor_busy_dates set source_revision=99 where id=$1', [shared.day_id], 'revision is maintained')
  await refuse('old operational identity cannot be reused', "insert into vendor_busy_dates(id,vendor_id,date,source) values($1,$2,'2031-02-07','manual')", [shared.day_id, f.vendor], 'identity cannot be reused')
  await refuse('first orphan version at zero head fails COMMIT', async () => {
    const day = (await write("insert into vendor_busy_dates(vendor_id,date,source) values($1,'2031-02-07','manual') returning id", [f.vendor])).rows[0].id
    const source = (await db.query('select id from legacy_calendar_sources where day_id=$1', [day])).rows[0].id
    await write(nextVersion, [randomUUID(), source, f.vendorOwner])
  }, [], 'orphan inventory version', true)
  await refuse('incomplete intermediate version fails COMMIT', async () => {
    const next = randomUUID()
    await write(nextVersion, [next, shared.id, f.vendorOwner])
    await write('update legacy_calendar_heads set revision=2,current_version_id=$2 where source_id=$1', [shared.id, next])
    await write('update deals set price=price+1 where id=$1', [f.deal])
    await write("select * from legacy_calendar_append_version($1,$2,'owner_capture')", [shared.id, f.vendorOwner])
  }, [], 'version holders incomplete', true)
  assert.equal(inventoryNegativeCount, 18, 'All independent inventory SQL refusals must execute')
  await expectAtomicRefusal('legacy calendar inventory evidence exists; use a preserving forward migration', '1763800000000_legacy_calendar_sources', true)

  // Runtime identity/revision and lifecycle probes stay rollback-contained.
  const lifecycleBefore = await snapshot()
  await write('begin')
  try {
    const dayBefore = (await db.query('select * from vendor_busy_dates where id=$1', [shared.day_id])).rows[0]
    await write('update vendor_busy_dates set deal_id=deal_id where id=$1', [shared.day_id])
    assert.deepEqual((await db.query('select * from vendor_busy_dates where id=$1', [shared.day_id])).rows[0], dayBefore)
    await write('update vendor_busy_dates set deal_id=$2 where id=$1', [shared.day_id, extra.shared])
    assert.equal((await db.query('select source_revision::text r from vendor_busy_dates where id=$1', [shared.day_id])).rows[0].r, '2')
    await write('delete from vendor_busy_dates where id=$1', [shared.day_id])
    const replacement = (await write("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,'2027-06-14','deal',$2) returning id", [f.vendor, f.deal])).rows[0].id
    assert.notEqual(replacement, shared.day_id)
    assert.equal((await db.query('select canonical from legacy_calendar_versions where id=$1', [shared.version])).rows[0].canonical, shared.canonical)
    assert.equal((await db.query('select legacy_calendar_present(s) present from legacy_calendar_sources s where id=$1', [shared.id])).rows[0].present, false)
    assert.equal((await db.query('select h.revision::text r from legacy_calendar_heads h join legacy_calendar_sources s on s.id=h.source_id where s.day_id=$1', [replacement])).rows[0].r, '0')
    // Whole-wedding cascade may erase its app history, retaining the company's
    // manual/orphan histories and all other weddings' immutable snapshots.
    const retainedSources = (await db.query('select id from legacy_calendar_sources where wedding_id is distinct from $1', [f.wedding])).rows.map(r => r.id)
    await write('delete from weddings where id=$1', [f.wedding])
    assert.equal((await db.query('select 1 from legacy_calendar_sources where wedding_id=$1', [f.wedding])).rowCount, 0)
    assert.equal((await db.query('select 1 from legacy_calendar_sources where id=any($1::uuid[])', [retainedSources])).rowCount, retainedSources.length)
    assert.equal((await db.query('select 1 from legacy_calendar_sources where company_id=$1 and kind in (\'manual_day\',\'orphan_day\')', [f.vendor])).rowCount > 0, true)
    await write('set constraints all immediate')
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), lifecycleBefore, 'Rollback-contained lifecycle must preserve every original fact')
  console.log(`Inventory checks passed: ${inventoryNegativeCount} actual SQL refusals plus one exact guarded CLI down; complete backfill/shared holders/unknown sources/canonical bytes/runtime identity/cascades preserved`)
  await recoveryForwardFixture(f, foreign)
}

async function recoveryForwardFixture(f, foreign) {
  // Reproduce a real populated 380 gap before applying the preserving fix.
  // This is synthetic history, not permission to infer bounds or consent.
  const prior = await fixture(false, '+1555000931')
  const day = (await db.query('select * from vendor_busy_dates where vendor_id=$1', [prior.vendor])).rows[0]
  const original = (await db.query("select id from legacy_calendar_sources where day_id=$1 and kind='app_day'", [day.id])).rows[0]
  await write("select * from legacy_calendar_append_version($1,$2,'owner_capture')", [original.id, prior.vendorOwner])
  await write('update vendor_busy_dates set deal_id=$2 where id=$1', [day.id, foreign.deal])
  await write('delete from weddings where id=$1', [prior.wedding])
  assert.equal((await db.query('select 1 from legacy_calendar_sources where day_id=$1', [day.id])).rowCount, 0, '380 gap must exist before the real forward migration')
  const operational = await rows('vendor_busy_dates'), before = await snapshot()
  await migrate('up', RECOVERY)
  const after = await snapshot()
  for (const [table, data] of Object.entries(before.data)) {
    if (table === 'pgmigrations') continue
    if (['legacy_calendar_sources', 'legacy_calendar_heads'].includes(table)) {
      assert.equal(after.data[table].length, data.length + 1, 'Only the missing day source/head can be appended')
      for (const old of data) assert(after.data[table].some(current => JSON.stringify(current) === JSON.stringify(old)), `381 changed an existing ${table} row`)
    } else assert.deepEqual(after.data[table], data, `381 changed inherited ${table} facts`)
  }
  const recovered = (await db.query(`select s.*,h.revision::text,h.current_version_id,legacy_calendar_inventory_material(s) material
    from legacy_calendar_sources s join legacy_calendar_heads h on h.source_id=s.id where s.day_id=$1 and s.kind='app_day'`, [day.id])).rows[0]
  assert(recovered); assert.notEqual(recovered.id, original.id)
  assert.equal(recovered.wedding_id, foreign.wedding); assert.equal(recovered.vendor_id, prior.vendor)
  assert.equal(recovered.company_id, null); assert.equal(recovered.discovered_by, 'writer')
  assert.equal(recovered.revision, '0'); assert.equal(recovered.current_version_id, null)
  assert.equal(recovered.material.completeness, 'unknown'); assert.equal(recovered.material.reason, 'mixed_scope')
  assert.deepEqual(recovered.material.holders, [])
  assert.deepEqual(await rows('vendor_busy_dates'), operational, 'Recovery cannot change the operational day or pointer revision')
  const repeated = await snapshot(); await migrate('up', RECOVERY)
  assert.deepEqual(await snapshot(), repeated, 'Repeated recovery up must be an exact no-op')
  await expectAtomicRefusal('legacy calendar inventory evidence exists; use a preserving forward migration', '1763810000000_legacy_calendar_day_recovery', true)

  // Exercise the installed trigger in both cascade directions while retaining
  // every prior row, immutable byte and schema/journal after ROLLBACK.
  const lifecycle = await snapshot()
  await write('begin')
  try {
    const source = (await db.query("select s.id,b.id as day_id from legacy_calendar_sources s join vendor_busy_dates b on b.id=s.day_id where s.kind='app_day' and s.wedding_id=$1 and b.deal_id=$2", [f.wedding, f.deal])).rows[0]
    assert(source)
    await write('update vendor_busy_dates set deal_id=$2 where id=$1', [source.day_id, foreign.deal])
    const retainedDay = (await db.query('select * from vendor_busy_dates where id=$1', [source.day_id])).rows[0]
    await write('delete from weddings where id=$1', [f.wedding])
    assert.deepEqual((await db.query('select * from vendor_busy_dates where id=$1', [source.day_id])).rows[0], retainedDay)
    const next = (await db.query("select s.id,s.wedding_id,h.revision::text from legacy_calendar_sources s join legacy_calendar_heads h on h.source_id=s.id where s.day_id=$1 and s.kind='app_day'", [source.day_id])).rows[0]
    assert(next); assert.notEqual(next.id, source.id); assert.equal(next.wedding_id, foreign.wedding); assert.equal(next.revision, '0')
    assert.equal((await db.query('select 1 from legacy_calendar_sources where wedding_id=$1', [f.wedding])).rowCount, 0)
    await write('delete from weddings where id=$1', [foreign.wedding])
    assert.equal((await db.query('select deal_id from vendor_busy_dates where id=$1', [source.day_id])).rows[0].deal_id, null)
    assert.equal((await db.query("select 1 from legacy_calendar_sources where day_id=$1 and kind='orphan_day' and company_id=$2", [source.day_id, f.vendor])).rowCount, 1)
    await write('set constraints all immediate')
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), lifecycle, 'Recovery and subsequent foreign wedding cascade must be rollback-contained')
  await recoveryManualRace(foreign, 'manual-first', '+1555000932')
  await recoveryManualRace(foreign, 'cascade-first', '+1555000933')
  console.log('Recovery checks passed: actual populated 380 gap repaired with new rev0 identity; every inherited row/history preserved; repeat no-op; installed cascade lifecycle and exact guarded 381 down verified')
}

async function recoveryManualRace(foreign, order, phone) {
  const own = await fixture(false, phone)
  const beforeSource = (await db.query("select id from legacy_calendar_sources where wedding_id=$1 and kind='app_day'", [own.wedding])).rows[0]
  await write('update vendor_busy_dates set deal_id=$2 where vendor_id=$1', [own.vendor, foreign.deal])
  const day = (await db.query('select * from vendor_busy_dates where vendor_id=$1', [own.vendor])).rows[0]
  const manual = new pg.Client({ connectionString: databaseUrl, statement_timeout: 9000, connectionTimeoutMillis: 5000 })
  const cascade = new pg.Client({ connectionString: databaseUrl, statement_timeout: 9000, connectionTimeoutMillis: 5000 })
  let completion, manualResult, cascadeResult
  try {
    await manual.connect(); await cascade.connect()
    const manualPid = (await manual.query('select pg_backend_pid() pid')).rows[0].pid
    const cascadePid = (await cascade.query('select pg_backend_pid() pid')).rows[0].pid
    await manual.query('begin'); await cascade.query('begin')
    await manual.query('select id from users where id=$1 for share', [own.vendorOwner])
    let held, waiting, pending
    if (order === 'manual-first') {
      await manual.query('select id from vendors where id=$1 for update', [own.vendor])
      pending = cascade.query('delete from weddings where id=$1', [own.wedding])
      held = manualPid; waiting = cascadePid
    } else {
      cascadeResult = await cascade.query('delete from weddings where id=$1', [own.wedding])
      pending = manual.query('select id from vendors where id=$1 for update', [own.vendor])
      held = cascadePid; waiting = manualPid
    }
    completion = Promise.allSettled([pending])
    const deadline = Date.now() + 5000
    let witness
    while (Date.now() < deadline) {
      const row = (await db.query('select pg_blocking_pids(pid) blockers,query from pg_stat_activity where pid=$1', [waiting])).rows[0]
      if (row?.blockers.includes(held)) { witness = row; break }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert(witness, `${order}: require an actual PostgreSQL wait, not a timing guess`)
    if (order === 'manual-first') {
      manualResult = await manual.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual') on conflict(vendor_id,date) do nothing", [own.vendor, day.date])
      await manual.query('commit')
      cascadeResult = await pending; await cascade.query('commit')
    } else {
      await cascade.query('commit'); await pending
      manualResult = await manual.query("insert into vendor_busy_dates(vendor_id,date,source) values($1,$2,'manual') on conflict(vendor_id,date) do nothing", [own.vendor, day.date])
      await manual.query('commit')
    }
    assert.equal(manualResult.rowCount, 0); assert.equal(cascadeResult.rowCount, 1)
    assert.deepEqual((await db.query('select * from vendor_busy_dates where id=$1', [day.id])).rows[0], day)
    const recovered = (await db.query(`select s.id,s.wedding_id,h.revision::text,legacy_calendar_inventory_material(s) material
      from legacy_calendar_sources s join legacy_calendar_heads h on h.source_id=s.id where s.day_id=$1 and s.kind='app_day'`, [day.id])).rows[0]
    assert(recovered); assert.notEqual(recovered.id, beforeSource.id); assert.equal(recovered.wedding_id, foreign.wedding)
    assert.equal(recovered.revision, '0'); assert.equal(recovered.material.reason, 'mixed_scope'); assert.deepEqual(recovered.material.holders, [])
    console.log(`RECOVERY_MANUAL_CASCADE_PG_WAIT order=${order} holder=${held} waiter=${waiting} bothCommitted=true`)
  } finally {
    await Promise.allSettled([manual.query('rollback'), cascade.query('rollback')])
    if (completion) await completion
    await manual.end(); await cascade.end()
  }
}

// T023's native SQL witnesses supplement the registered HTTP/lifecycle suite.
// Old rows are created under actual 381: titles never infer semantic keys.
const PLANB_MIGRATION = '1763820000000_planb_system_template_keys'
const PLANB_KEYS = ['planb.vendor_arrival', 'planb.rings_passports', 'planb.venue_materials',
  'planb.weather_venue_backup', 'planb.timeline_buffer', 'planb.emergency_kit']
let planbNegativeCount = 0
function priorPlanbSchema(schema) {
  return { ...schema,
    relations: schema.relations.filter(row => row.relname !== 'tasks_system_template_scope_key'),
    columns: schema.columns.filter(row => !(row.table_schema === 'public' && row.table_name === 'tasks' && row.column_name === 'system_template_key')),
    columnMetadata: schema.columnMetadata.filter(row => !(row.relname === 'tasks' && row.attname === 'system_template_key')
      && !(row.relname === 'tasks_system_template_scope_key' && ['wedding_id', 'kind', 'system_template_key'].includes(row.attname)
        && row.attacl === null && row.comment === null)),
    constraints: schema.constraints.filter(row => !(row.table_name === 'tasks' && row.conname === 'tasks_system_template_key_shape')),
    indexes: schema.indexes.filter(row => !(row.tablename === 'tasks' && row.indexname === 'tasks_system_template_scope_key')),
    triggers: schema.triggers.filter(row => !(row.table_name === 'tasks' && row.tgname === 'tasks_system_template_guard')),
    functions: schema.functions.filter(row => !(row.proname === 'protect_task_system_template_identity' && row.arguments === '')),
  }
}
function withoutPlanbKey(data) {
  return { ...data, tasks: data.tasks.map(row => {
    const copy = { ...row }; delete copy.system_template_key; return copy
  }).sort((a, b) => canonicalFixture(a).localeCompare(canonicalFixture(b))) }
}
function assertPlanbPreserved(before, after) {
  assert.deepEqual(Object.keys(after.data), Object.keys(before.data), '382 cannot add or remove a public table')
  const projected = withoutPlanbKey(after.data)
  for (const [table, data] of Object.entries(before.data)) {
    if (table !== 'pgmigrations') {
      const expected = table === 'tasks' ? [...data].sort((a, b) => canonicalFixture(a).localeCompare(canonicalFixture(b))) : data
      assert.deepEqual(projected[table], expected, `382 changed inherited ${table} data`)
    }
  }
  assert.equal(after.data.pgmigrations.length, before.data.pgmigrations.length + 1)
  for (const row of before.data.pgmigrations) assert(after.data.pgmigrations.some(current => canonicalFixture(current) === canonicalFixture(row)), '382 changed a prior journal row')
  assert.equal(after.data.pgmigrations.filter(row => row.name === PLANB_MIGRATION).length, 1)
  assert.deepEqual(priorPlanbSchema(after.schema), before.schema, '382 changed prior full catalog metadata')
  assert(after.data.tasks.every(row => row.system_template_key === null), '382 cannot infer keys for existing tasks')
}
function planbReaddedSchema(schema) {
  // Raw snapshots remain unmodified. Only this new column's physical position
  // differs after its native down/re-add; every other catalog value is exact.
  return { ...schema, columns: schema.columns.map(row => row.table_schema === 'public' && row.table_name === 'tasks'
    && row.column_name === 'system_template_key' ? { ...row, ordinal_position: '__NEW_COLUMN_POSITION__', dtd_identifier: '__NEW_COLUMN_POSITION__' } : row) }
}
async function planbCatalog() {
  assert.deepEqual((await db.query("select data_type,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name='tasks' and column_name='system_template_key'")).rows,
    [{ data_type: 'text', is_nullable: 'YES', column_default: null }])
  const indexes = (await db.query(`select i.indisunique,i.indisvalid,i.indisready,pg_get_expr(i.indpred,i.indrelid) as predicate,
    array(select a.attname::text from unnest(i.indkey) with ordinality as k(attnum,position)
      join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum order by k.position) as columns
    from pg_index i join pg_class x on x.oid=i.indexrelid join pg_namespace n on n.oid=x.relnamespace
    where n.nspname='public' and x.relname='tasks_system_template_scope_key' and i.indrelid='public.tasks'::regclass`)).rows
  assert.equal(indexes.length, 1)
  assert.deepEqual(indexes[0].columns, ['wedding_id', 'kind', 'system_template_key'])
  assert(indexes[0].indisunique && indexes[0].indisvalid && indexes[0].indisready)
  assert.equal(indexes[0].predicate.replace(/[()\s]/g, '').toLowerCase(), 'system_template_keyisnotnull')
  const shape = (await db.query("select convalidated from pg_constraint where conrelid='public.tasks'::regclass and conname='tasks_system_template_key_shape' and contype='c'")).rows
  assert.deepEqual(shape, [{ convalidated: true }])
  const trigger = (await db.query("select tgtype,tgenabled from pg_trigger where tgrelid='public.tasks'::regclass and tgname='tasks_system_template_guard' and not tgisinternal")).rows
  assert.deepEqual(trigger, [{ tgtype: 23, tgenabled: 'O' }])
}
async function planbEmptyCycle() {
  assert.equal((await db.query('select count(*)::int n from tasks')).rows[0].n, 0)
  const before = await snapshot()
  await migrate('down', PLANB_MIGRATION, undefined, true)
  const down = await snapshot()
  assert.deepEqual(down.schema, priorPlanbSchema(before.schema), 'Empty exact382 down must preserve every old catalog row')
  assert.deepEqual(down.data, { ...withoutPlanbKey(before.data), pgmigrations: before.data.pgmigrations.filter(row => row.name !== PLANB_MIGRATION) })
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= RECOVERY).map(item => item.name))
  await migrate('up', LATEST)
  const up = await snapshot()
  assertPlanbPreserved(down, up)
  assert.deepEqual(planbReaddedSchema(up.schema), planbReaddedSchema(before.schema))
  await planbCatalog()
  const repeated = await snapshot(); await migrate('up', LATEST)
  assert.deepEqual(await snapshot(), repeated, 'Empty 382 repeat must be an exact no-op')
  console.log('T023 empty exact382 down/re-up/repeat passed with all old metadata preserved')
}
async function expectPlanbSqlRefusal(label, sql, values, code, constraint) {
  const before = await snapshot()
  await write('begin')
  try {
    await assert.rejects(async () => { await write(sql, values); await write('set constraints all immediate') }, error => {
      assert.equal(error.code, code, `${label}: actual PostgreSQL SQLSTATE required`)
      assert.equal(error.constraint, constraint, `${label}: actual named T023 invariant required`)
      return true
    }, `${label}: invalid task identity unexpectedly persisted`)
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), before, `${label}: preserve every row, journal and catalog after refusal`)
  planbNegativeCount++
  console.log(`Expected T023 SQL refusal: ${label} (${code}, ${constraint})`)
}
async function planbNativeDownWait() {
  // Own one real row/relation lock and observe only the uniquely tagged native
  // CLI's ACCESS EXCLUSIVE waiter. A completed process or timeout is no witness.
  await safety()
  const before = await snapshot(), tag = `drill382_${randomUUID().replaceAll('-', '')}`
  const holder = new pg.Client({ connectionString: databaseUrl, statement_timeout: 9000, connectionTimeoutMillis: 5000 })
  let child, completion, settled = false, witness
  try {
    await holder.connect()
    const identity = (await holder.query('select current_database() name,current_user principal,host(inet_server_addr()) address,inet_server_port() port,pg_backend_pid() pid')).rows[0]
    assert.equal(identity.name, DATABASE); assert.equal(identity.principal, 'codex_test'); assert.equal(identity.port, Number(selectedPort))
    assert(['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(identity.address))
    await holder.query('begin')
    assert((await holder.query('select id from tasks where system_template_key is not null limit 1 for share')).rowCount === 1)
    child = spawn(process.execPath, [cli, 'down', PLANB_MIGRATION, '-m', migrationsDir,
      '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false'],
    { cwd: backend, env: { ...process.env, PGAPPNAME: tag, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl }, stdio: ['ignore', 'pipe', 'pipe'] })
    completion = new Promise((resolve, reject) => {
      let output = '', processError, overflow = false
      const timer = setTimeout(() => { child.kill(); reject(new Error('T023 native down subprocess timed out')) }, 30_000)
      const capture = chunk => {
        output += chunk.toString('utf8')
        if (Buffer.byteLength(output) > 16 * 1024 * 1024) { overflow = true; child.kill() }
      }
      child.stdout.on('data', capture); child.stderr.on('data', capture)
      child.on('error', error => { processError = error })
      child.once('close', (status, signal) => { clearTimeout(timer); settled = true; resolve({ status, signal, output, processError, overflow }) })
    })
    // Attach rejection handling immediately; no lost/unhandled child error.
    completion.catch(() => {})
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const waiters = (await db.query(`select pid,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) blockers
        from pg_stat_activity where datname=current_database() and usename=current_user and application_name=$1
        and state='active' and wait_event_type='Lock'`, [tag])).rows
      assert(waiters.length <= 1, 'Tagged native command must have at most one observed backend')
      if (waiters.length && waiters[0].blockers.includes(identity.pid)
        && /lock\s+table\s+tasks\s+in\s+access\s+exclusive\s+mode/i.test(waiters[0].query)) {
        witness = waiters[0]; break
      }
      assert(!settled, 'Native 382 down finished before an actual tasks-lock waiter was observed')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert(witness, 'Require an actual bounded native382 tasks-lock wait')
    await holder.query('rollback')
    const result = await completion
    assert(!result.processError && !result.overflow && !result.signal, 'Subprocess failure is not a migration refusal')
    assert.notEqual(result.status, 0)
    assert.deepEqual([...result.output.matchAll(/^> - (.+)$/gm)].map(match => match[1].trim()), [PLANB_MIGRATION])
    assert(result.output.includes('system task template key evidence exists; use a preserving forward migration'))
    assert(/code:\s*['"]23514['"]/.test(result.output), 'Native down must report actual guard SQLSTATE')
    assert.deepEqual(await snapshot(), before, 'Waiting native382 refusal must preserve whole data/journal/catalog')
    atomicDownCount++
    console.log(`T023_NATIVE_DOWN_PG_WAIT holder=${identity.pid} waiter=${witness.pid} guard=23514 allPreserved=true`)
  } finally {
    await holder.query('rollback').catch(() => {})
    if (child && !settled) child.kill()
    if (completion) await completion.catch(() => {})
    await holder.end()
  }
}
async function planbForwardFixture(f) {
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= RECOVERY).map(item => item.name))
  assert(!(await columns('tasks')).includes('system_template_key'), 'Historical fixtures require the actual381 schema')
  const oldIds = [], oldInsert = `insert into tasks(id,wedding_id,title,source,kind,sort,done_at,period,due)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`
  for (const [i, [source, kind]] of [['system', 'planb'], ['system', 'planb'], ['user', 'planb'], ['ai', 'planb'], ['system', 'checklist'], ['user', 'checklist']].entries()) {
    const id = randomUUID(); oldIds.push(id)
    await write(oldInsert, [id, f.wedding, 'Synthetic duplicated historical Plan B title', source, kind, 70 + i,
      i === 1 ? '2026-09-30T12:34:56.123456Z' : null, 'before', '2027-06-13'])
  }
  const before = await snapshot()
  await migrate('up', LATEST)
  const after = await snapshot(); assertPlanbPreserved(before, after); await planbCatalog()
  await assertJournal(manifest.map(item => item.name))
  const repeated = await snapshot(); await migrate('up', LATEST)
  assert.deepEqual(await snapshot(), repeated, 'Populated382 repeat must preserve every row and catalog')
  for (const [column, value, constraint] of [
    ['id', randomUUID(), 'tasks_system_planb_identity_immutable'], ['wedding_id', null, 'tasks_system_planb_identity_immutable'],
    ['source', 'user', 'tasks_system_planb_identity_immutable'], ['kind', 'checklist', 'tasks_system_planb_identity_immutable'],
    ['system_template_key', PLANB_KEYS[0], 'tasks_system_template_key_immutable'],
  ]) await expectPlanbSqlRefusal(`historical NULL ${column} cannot change`, `update tasks set ${quote(column)}=$2 where id=$1`, [oldIds[0], value], '23514', constraint)
  await expectPlanbSqlRefusal('unkeyed user row cannot promote around INSERT guard', "update tasks set source='system',kind='planb' where id=$1", [oldIds[5]], '23514', 'tasks_system_planb_insert_identity')
  // All historical values/IDs/duplicates survive actual exact NULL-history down.
  await migrate('down', PLANB_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before, 'NULL-history down must restore full381 data/journal/catalog exactly')
  await migrate('up', LATEST)
  const reup = await snapshot(); assertPlanbPreserved(before, reup); await planbCatalog()
  assert.deepEqual(planbReaddedSchema(reup.schema), planbReaddedSchema(after.schema))
  const insert = 'insert into tasks(id,wedding_id,title,source,kind,system_template_key) values($1,$2,$3,$4,$5,$6)'
  const values = (source, kind, key, wedding = f.wedding) => [randomUUID(), wedding, 'Synthetic same-title authored keyed item', source, kind, key]
  for (const key of PLANB_KEYS) await write(insert, values('system', 'planb', key))
  assert.deepEqual((await db.query("select system_template_key from tasks where wedding_id=$1 and system_template_key is not null order by system_template_key", [f.wedding])).rows.map(row => row.system_template_key), [...PLANB_KEYS].sort())
  const keyed = (await db.query('select id from tasks where wedding_id=$1 and system_template_key=$2', [f.wedding, PLANB_KEYS[0]])).rows[0].id
  await expectPlanbSqlRefusal('new system Plan B requires key', insert, values('system', 'planb', null), '23514', 'tasks_system_template_key_required')
  await expectPlanbSqlRefusal('new system Plan B requires known key', insert, values('system', 'planb', 'planb.unknown'), '23514', 'tasks_system_template_key_required')
  await expectPlanbSqlRefusal('known key cannot belong to a user row', insert, values('user', 'planb', PLANB_KEYS[0]), '23514', 'tasks_system_template_key_shape')
  await expectPlanbSqlRefusal('known key cannot belong to checklist kind', insert, values('system', 'checklist', PLANB_KEYS[0]), '23514', 'tasks_system_template_key_shape')
  await expectPlanbSqlRefusal('unknown key cannot use a non-system row', insert, values('ai', 'planb', 'planb.unknown'), '23514', 'tasks_system_template_key_shape')
  await expectPlanbSqlRefusal('same wedding semantic key is unique', insert, values('system', 'planb', PLANB_KEYS[0]), '23505', 'tasks_system_template_scope_key')
  for (const [column, value, constraint] of [
    ['system_template_key', null, 'tasks_system_template_key_immutable'], ['system_template_key', PLANB_KEYS[1], 'tasks_system_template_key_immutable'],
    ['id', randomUUID(), 'tasks_system_planb_identity_immutable'], ['wedding_id', null, 'tasks_system_planb_identity_immutable'],
    ['source', 'user', 'tasks_system_planb_identity_immutable'], ['kind', 'checklist', 'tasks_system_planb_identity_immutable'],
  ]) await expectPlanbSqlRefusal(`keyed ${column} cannot change`, `update tasks set ${quote(column)}=$2 where id=$1`, [keyed, value], '23514', constraint)
  const positive = await snapshot(), foreign = (await db.query('select id from weddings where id<>$1 order by id limit 1', [f.wedding])).rows[0]
  assert(foreign, 'Cross-wedding key witness requires another actual fixture wedding')
  await write('begin')
  try {
    await write(insert, values('system', 'planb', PLANB_KEYS[0], foreign.id))
    for (let i = 0; i < 2; i++) await write(insert, values('user', 'planb', null))
    await write(insert, values('system', 'checklist', null))
    for (const id of [oldIds[0], keyed]) {
      const old = (await db.query('select id,wedding_id,kind,source,system_template_key from tasks where id=$1', [id])).rows[0]
      await write("update tasks set title='Synthetic permitted rename',done_at='2026-10-01T02:03:04Z' where id=$1", [id])
      assert.deepEqual((await db.query('select id,wedding_id,kind,source,system_template_key from tasks where id=$1', [id])).rows[0], old)
    }
    await write('set constraints all immediate')
  } finally { await db.query('rollback') }
  assert.deepEqual(await snapshot(), positive, 'Permitted same-title/foreign-key/edit probes must be rollback-contained')
  assert.equal(planbNegativeCount, 18, 'All independent T023 key/scope/NULL SQL refusals must execute')
  await expectAtomicRefusal('system task template key evidence exists; use a preserving forward migration', PLANB_MIGRATION, true)
  await planbNativeDownWait()
  assert.equal(atomicDownCount, 21, 'All19 old guards plus exact382 and waiting exact382 guards must execute')
  console.log(`T023 checks passed: ${planbNegativeCount} actual named SQL refusals; native populated381 NULL preservation/down/re-up/no-op; scoped six keyed positives; exact keyed downs including actual tasks-lock wait; no HTTP or delivery claim`)
}


try {
  await safety()
  assert.equal((await db.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")).rows[0].count, 0, 'Initial public schema must be empty, including pgmigrations')
  assert.equal((await db.query("select count(*)::int as count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'")).rows[0].count, 0, 'Initial public functions must also be empty')
  assert.equal((await db.query("select count(*)::int as count from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public'")).rows[0].count, 0, 'Initial public types must also be empty')
  console.log(`Verified exact isolated database ${DATABASE} on explicit disposable port ${selectedPort}; approved range ${FIRST}..${LATEST}`)
  const inheritedNames = manifest.filter(item => Number(item.name.slice(0, 13)) < FIRST).map(item => item.name)
  await migrate('up', Number(inheritedNames.at(-1).slice(0, 13)))
  const inheritedSchema = (await snapshot()).schema
  await migrate('up', LATEST)
  assert.deepEqual((await db.query('select singleton,installed_btree_gist from ecosystem_resource_schema')).rows, [{ singleton: true, installed_btree_gist: true }], 'This fresh database has no preexisting btree_gist')
  assert.equal((await db.query("select extversion from pg_extension where extname='btree_gist'")).rows[0].extversion, '1.7', 'Measure the exact local extension version; this is not a production claim')
  await assertJournal(manifest.map(item => item.name))
  await planbEmptyCycle()
  const clean = await fixture(false)
  assert.deepEqual((await db.query('select attention_mode,attention_version::text,attention_coordinator_user_id from weddings where id=$1', [clean.wedding])).rows[0], { attention_mode: 'essential', attention_version: '1', attention_coordinator_user_id: null })
  assert.equal((await db.query('select urgent_incidents from notification_prefs where user_id=$1', [clean.owner])).rows[0].urgent_incidents, false)
  assert.deepEqual((await db.query('select source,version::text,brief from deal_orders order by deal_id')).rows.map(row => ({ ...row })), [{ source: 'legacy', version: '1', brief: null }, { source: 'legacy', version: '1', brief: null }])
  assert.equal((await db.query('select count(*)::int as count from order_parts')).rows[0].count, 0)
  assert.equal((await db.query('select count(*)::int as count from order_assignments')).rows[0].count, 0)
  assert.deepEqual((await db.query('select resource_plan_revision::text,resource_plan_id from deal_orders order by deal_id')).rows,
    [{ resource_plan_revision: '0', resource_plan_id: null }, { resource_plan_revision: '0', resource_plan_id: null }], 'Clean legacy orders must not infer a plan')
  for (const table of ['deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations', 'resource_conflict_keys']) {
    assert.equal((await db.query(`select 1 from ${quote(table)}`)).rowCount, 0, 'Clean legacy deals must not infer resource commitments, membership or allocation')
  }
  await write('delete from weddings where id=$1', [clean.wedding])
  await write('delete from users where id=any($1::uuid[])', [[clean.owner, clean.vendorOwner, clean.coordinator]])
  await assertNoBusinessData()
  const cleanSnapshot = await snapshot()
  await migrate('up', LATEST)
  assert.deepEqual(await snapshot(), cleanSnapshot, 'Repeated clean up must be a real no-op')
  await migrate('down', FIRST)
  await assertJournal(inheritedNames)
  assert.deepEqual((await snapshot()).schema, inheritedSchema, 'Empty rollback must restore inherited definitions, comments and ownership')
  assert.equal((await db.query("select to_regclass('public.deal_orders') as orders,to_regclass('public.notification_push_deliveries') as deliveries")).rows[0].orders, null)
  assert.equal((await columns('weddings')).includes('attention_mode'), false)
  assert.equal((await db.query("select 1 from pg_extension where extname='btree_gist'")).rowCount, 0, 'Only the migration-owned extension must be removed on empty down')
  console.log('Empty own-data rollback passed without touching inherited migration history')

  // A second actual empty cycle checks an extension installed before the
  // migration. It must preserve its definition, identity, ownership and members.
  await write('create extension btree_gist')
  const preexistingSchema = (await snapshot()).schema
  await migrate('up', LATEST)
  assert.deepEqual((await db.query('select singleton,installed_btree_gist from ecosystem_resource_schema')).rows, [{ singleton: true, installed_btree_gist: false }])
  await assertNoBusinessData()
  await migrate('down', FIRST)
  await assertJournal(inheritedNames)
  assert.deepEqual((await snapshot()).schema, preexistingSchema, 'Preexisting btree_gist and every inherited metadata record must survive empty rollback')
  console.log('Both extension ownership cycles passed: migration-owned btree_gist 1.7 removed, preexisting btree_gist 1.7 preserved with full metadata')

  const f = await fixture(true)
  const layout = {}
  for (const table of legacyTables) layout[table] = await columns(table)
  const inherited = await legacySnapshot(layout)
  const totalSql = "select coalesce(sum(case when kind='refund' then -amount else amount end),0)::text as paid from payments where status<>'cancelled'"
  assert.equal((await db.query(totalSql)).rows[0].paid, '24000000') // 20,000,000 + 7,000,000 - 3,000,000 kopecks.
  await migrate('up', PREPLAN)
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= PREPLAN).map(item => item.name))
  assert.deepEqual(await legacySnapshot(layout), inherited, 'Inherited identities, money, occupancy, programs and receipts must remain byte-for-byte equivalent')
  assert.equal((await db.query(totalSql)).rows[0].paid, '24000000')
  assert.deepEqual((await db.query('select id,push_disposition,delivery_time_zone from notifications order by id')).rows,
    [{ id: f.pushedNotification, push_disposition: 'processed', delivery_time_zone: null }, { id: f.plannedNotification, push_disposition: 'planned', delivery_time_zone: null }].sort((a, b) => a.id.localeCompare(b.id)))
  assert.equal((await db.query('select count(*)::int as count from order_assignments')).rows[0].count, 0)
  assert.equal((await db.query('select count(*)::int as count from order_parts')).rows[0].count, 0)
  assert.deepEqual((await db.query('select guest_id,status,source,version::text from event_guest_participation where program_event_id=$1 order by guest_id', [f.mainEvent])).rows,
    [{ guest_id: f.guestYes, status: 'attending', source: 'legacy_main_rsvp', version: '1' }, { guest_id: f.guestNo, status: 'declined', source: 'legacy_main_rsvp', version: '1' }, { guest_id: f.guestUnknown, status: 'unknown', source: 'legacy_main_rsvp', version: '1' }].sort((a, b) => a.guest_id.localeCompare(b.guest_id)))
  assert.equal((await db.query('select count(*)::int as count from event_guest_participation where program_event_id=$1', [f.secondEvent])).rows[0].count, 0, 'No main RSVP may be fabricated for day two; participation remains unknown')
  assert.equal((await db.query('select count(*)::int as count from vendor_program_acknowledgments')).rows[0].count, 1)
  assert.equal((await db.query('select count(*)::int as count from external_program_acknowledgments')).rows[0].count, 1)
  const upgraded = await snapshot()
  await migrate('up', PREPLAN)
  assert.deepEqual(await snapshot(), upgraded, 'Repeated populated up must not duplicate records or alter history')
  console.log('Populated inherited upgrade and repeat passed; net paid 24000000 kopecks, main-only RSVP and both receipt types preserved')

  await write('insert into notification_push_deliveries(notification_id,subscription_id) values($1,$2)', [f.plannedNotification, f.subscription])
  await expectAtomicRefusal('Cannot discard notification delivery history')
  await write('delete from notification_push_deliveries where notification_id=$1 and subscription_id=$2', [f.plannedNotification, f.subscription])
  await write("update deal_orders set source='structured',brief_category_id='photo',brief='{}'::jsonb where deal_id=$1", [f.deal])
  await expectAtomicRefusal('Cannot remove structured order or participation history')
  const assignment = randomUUID()
  await write("insert into order_assignments(id,wedding_id,deal_id,slot_id,program_event_id,source,label,created_by) values($1,$2,$3,$4,$5,'structured','Synthetic ceremony work',$6)", [assignment, f.wedding, f.deal, f.slot, f.mainEvent, f.owner])
  await expectAtomicRefusal('Cannot restore immediate checks with structured order dependencies')
  await termsFixture(f, assignment)
  // Run earlier guard probes before staff seeding so a later staff guard
  // cannot mask them. Empty 355 down then gives a real old schema for legacy
  // fixture creation; no invitation identity history exists at this point.
  assert.equal((await db.query('select count(*)::int as count from vendor_staff_members')).rows[0].count, 0)
  await migrate('down', 1763550000000)
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= PRE_IDENTITY).map(item => item.name))
  assert.equal((await columns('vendor_staff_members')).includes('invite_binding_known'), false)
  await seedStaffHistoryBeforeIdentity(f)
  const oldStaffColumns = await columns('vendor_staff_members'), oldStaff = await rows('vendor_staff_members', oldStaffColumns)
  const beforeIdentity = await snapshot()
  await migrate('up', PREPLAN)
  const afterIdentity = await snapshot()
  for (const [table, data] of Object.entries(beforeIdentity.data)) {
    if (table !== 'pgmigrations' && table !== 'vendor_staff_members') assert.deepEqual(afterIdentity.data[table], data, `355 upgrade must not change any existing ${table} rows`)
  }
  assert.deepEqual(await rows('vendor_staff_members', oldStaffColumns), oldStaff, 'Existing acceptance/author/session/token/version facts must remain unchanged; migration creates no acceptance or audit')
  assert.deepEqual((await db.query('select id,invite_target_user_id,invite_binding_known from vendor_staff_members order by id')).rows,
    [f.legacyMember, f.legacyInvitation].sort().map(id => ({ id, invite_target_user_id: null, invite_binding_known: false })), 'Never infer original open or targeted addressing from inherited user_id')
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= PREPLAN).map(item => item.name))
  console.log('Real populated 351 -> 355 upgrade preserved every existing row/acceptance/audit; historical active and pending invitation addressing explicitly unknown')
  await staffAndResourceFixture(f, assignment)
  await invitationIdentityFixture(f)
  const withTerms = await snapshot()
  await migrate('up', PREPLAN)
  assert.deepEqual(await snapshot(), withTerms, 'Repeated up must preserve immutable terms, synthetic receipts, pointers and every prior history row')
  assert.deepEqual(await legacySnapshot(layout), inherited, 'Terms fixtures and refusal/repeat probes must preserve the inherited financial and program history')
  assert.equal((await db.query(totalSql)).rows[0].paid, '24000000')
  assert.equal(termsNegativeCount + staffNegativeCount + resourceNegativeCount + invitationNegativeCount, 51, 'Preserve all original SQL negative controls')
  assert.equal(atomicDownCount, 9, 'Preserve all original exact CLI guarded-down controls')

  // Upgrade real populated 355 history, including immutable schema1 terms,
  // receipts, known/unknown staff bindings and explicit resource windows.
  const prePlanLayout = {}
  for (const table of Object.keys(withTerms.data)) prePlanLayout[table] = await columns(table)
  await migrate('up', 1763600000000)
  for (const [table, data] of Object.entries(withTerms.data)) {
    if (table !== 'pgmigrations') assert.deepEqual(await rows(table, prePlanLayout[table]), data, `355 -> 360 must preserve all existing ${table} facts`)
  }
  assert.equal((await db.query('select 1 from deal_resource_plan_versions')).rowCount, 0, 'No plan may be inferred from legacy booking or resource policy')
  assert.equal((await db.query('select 1 from deal_orders where resource_plan_id is not null or resource_plan_revision<>0')).rowCount, 0)
  assert.equal((await db.query('select 1 from deal_terms_versions where resource_plan_id is not null')).rowCount, 0, 'Schema1 terms retain unknown resource selection')
  assert.deepEqual(await legacySnapshot(layout), inherited)
  const noPlanUpgrade = await snapshot()
  await migrate('up', 1763600000000)
  assert.deepEqual(await snapshot(), noPlanUpgrade, 'Actual populated no-plan repeat is unchanged')
  await assertJournal(manifest.filter(item => Number(item.name.slice(0, 13)) <= 1763600000000).map(item => item.name))
  console.log('Actual populated 355 -> 360 upgrade retained all staff/resources/schema1-terms/receipts with plan head zero and no inferred selection or reservation')
  const plan = await planFixture(f, assignment, true)
  await planTermsFixture(f, plan, true)
  await expectAtomicRefusal('resource plan or acceptance history exists; use a preserving forward migration', 1763600000000)
  const beforeIntegrity = await snapshot(), integrityLayout = {}
  for (const table of Object.keys(beforeIntegrity.data)) integrityLayout[table] = await columns(table)
  await migrate('up', PRECOMMITMENT)
  for (const [table, data] of Object.entries(beforeIntegrity.data)) {
    if (table !== 'pgmigrations') assert.deepEqual(await rows(table, integrityLayout[table]), data, `360 -> 361 must preserve explicit ${table} history`)
  }
  assert.deepEqual((await db.query('select resource_plan_revision::text,resource_plan_id,version::text from deal_orders where deal_id=$1', [f.deal])).rows[0],
    { resource_plan_revision: '1', resource_plan_id: plan.plan, version: plan.nextVersion }, '361 preserves the explicitly created head; it does not fabricate a plan')
  await planIntegrityProbes(plan)
  await expectAtomicRefusal('resource plan integrity protects history; use a preserving forward migration', 1763610000000)
  assert.equal(planNegativeCount, 17, 'All new SQL negative controls must execute')
  assert.equal(atomicDownCount, 11, 'Original nine plus actual independent 360 and 361 guarded downs must execute')
  await planWeddingCascade(f)
  const withPlan = await snapshot()
  await migrate('up', PRECOMMITMENT)
  assert.deepEqual(await snapshot(), withPlan, 'Repeated latest up preserves private plan bytes, safe public projection, scoped schema2 terms and synthetic receipt history')
  assert.deepEqual(await legacySnapshot(layout), inherited)
  assert.equal((await db.query(totalSql)).rows[0].paid, '24000000')

  // Seed an explicit pre-ledger inventory fact under the real 361 schema.
  // This must be copied to legacy_used, never reset to zero or reconstructed
  // from old day bookings, plans, synthetic receipts or guessed concurrency.
  const inheritedWindow = (await db.query(`select w.id,w.used from resource_capacity_windows w join vendor_resources r on r.id=w.resource_id
    where r.vendor_id=$1 and w.starts_at='2027-06-14T08:00:00Z'`, [f.vendor])).rows
  assert.equal(inheritedWindow.length, 1)
  assert.equal(inheritedWindow[0].used, 0)
  await write('update resource_capacity_windows set used=3 where id=$1', [inheritedWindow[0].id])
  const beforeCommitments = await snapshot(), commitmentLayout = {}
  for (const table of Object.keys(beforeCommitments.data)) commitmentLayout[table] = await columns(table)
  await migrate('up', PRE_INVENTORY)
  for (const [table, data] of Object.entries(beforeCommitments.data)) {
    if (table !== 'pgmigrations') assert.deepEqual(await rows(table, commitmentLayout[table]), data, `361 -> 369 must retain every prior ${table} value`)
  }
  const baselineRows = (await db.query('select id,used,legacy_used from resource_capacity_windows order by id')).rows
  assert.deepEqual(baselineRows, beforeCommitments.data.resource_capacity_windows.map(w => ({ id: w.id, used: w.used, legacy_used: w.used })).sort((a, b) => a.id.localeCompare(b.id)),
    '365 copies exact inherited used into baseline, including the positive inventory fact')
  await windowCounter(inheritedWindow[0].id, 3, 3)
  for (const table of ['deal_resource_commitments', 'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations', 'resource_conflict_keys']) {
    assert.equal((await db.query(`select 1 from ${quote(table)}`)).rowCount, 0, 'Existing paid deals/plan/schema2 receipts do not manufacture a resource reservation')
  }
  const scopedHistoryReferences = (await db.query(`select condeferrable,condeferred from pg_constraint where contype='f' and
    ((conrelid='deal_resource_commitment_versions'::regclass and confrelid in
      ('deal_terms_versions'::regclass,'deal_resource_plan_versions'::regclass,'deal_resource_commitment_versions'::regclass)) or
     (conrelid='resource_allocations'::regclass and confrelid='deal_resource_commitment_versions'::regclass))`)).rows
  assert.equal(scopedHistoryReferences.length, 4)
  assert(scopedHistoryReferences.every(c => c.condeferrable && c.condeferred), '368 retains all scoped history references while deferring actual whole-wedding cascade checks')
  console.log('Actual populated 361 -> 369 preserved all prior columns/rows and copied positive inherited used=3 to legacy_used=3 without inferred commitments')
  await commitmentHistoryFixture(f)
  // Exact native CLI file selection tests every down body, including older
  // guards whose timestamp-chain invocation would otherwise be masked by 369.
  for (const [name, message] of [
    ['1763690000000_allocation_release_proof', 'booking evidence exists; use preserving forward migration'],
    ['1763680000000_commitment_history_cascade', 'booking evidence exists; use preserving forward migration'],
    ['1763670000000_commitment_trigger_records', 'booking evidence exists; use preserving forward migration'],
    ['1763660000000_commitment_proof_guard', 'accepted booking proof exists; use preserving forward migration'],
    ['1763650000000_resource_commitments', 'resource booking evidence exists; use a preserving forward migration'],
  ]) await expectAtomicRefusal(message, name, true)
  assert.equal(atomicDownCount, 16, 'All eleven retained and five independently selected actual CLI guards must execute')
  const withCommitments = await snapshot()
  await migrate('up', PRE_INVENTORY)
  assert.deepEqual(await snapshot(), withCommitments, 'Repeated populated latest up preserves private/terms/ledger/version/member/counter/history and full schema/journal')
  const preservedOriginal = await legacySnapshot(layout)
  for (const [table, originalRows] of Object.entries(inherited)) {
    const actual = preservedOriginal[table].map(canonicalFixture)
    for (const row of originalRows) assert(actual.includes(canonicalFixture(row)), `${table}: each original inherited financial/program/notification/identity row must remain after the additional synthetic histories`)
  }
  assert.equal((await db.query(`${totalSql} and deal_id=$1`, [f.deal])).rows[0].paid, '24000000')
  await eventRsvpDeadlineFixture(f)
  await inventoryForwardFixture(f)
  await planbForwardFixture(f)
  await eraseCurrentVendorFixture()
  assert.equal((await db.query(`${totalSql} and deal_id=$1`, [f.deal])).rows[0].paid, '24000000', 'Original 20m + 7m - 3m remains intact after the additional erasure fixture')
  await assertJournal(manifest.map(item => item.name))
  assert.equal(termsNegativeCount + staffNegativeCount + resourceNegativeCount + invitationNegativeCount + planNegativeCount + commitmentNegativeCount,
    98, 'Retain all 68 prior SQL refusals and execute all 30 additional ledger invariants before any success marker')
  console.log(`Terms history checks passed: ${termsNegativeCount} actual SQL refusals, one synthetic published version, two synthetic party receipts; no human acceptance or program acknowledgment claim`)
  console.log(`Staff/resource checks passed: ${staffNegativeCount} staff SQL refusals and ${resourceNegativeCount} resource/window/identity SQL refusals; explicit synthetic company membership and capacity facts, not human acceptance or reserved availability`)
  console.log(`Invitation identity checks passed: ${invitationNegativeCount} actual SQL refusals, known open/targeted pending positives, deleted target history preserved, inherited unknown addressing unchanged; no new human membership acceptance`)
  console.log(`Resource-plan checks passed: ${planNegativeCount} actual SQL refusals including deferred orphan COMMIT; immutable bytes, safe projection, scoped heads/schema2 terms, no inferred/reserved capacity and rollback-contained whole-wedding cascade`)
  console.log(`Resource-commitment checks passed: ${commitmentNegativeCount} actual SQL refusals; distinct synthetic historical proof, immutable origin/replacement/member/allocation facts, inherited baseline/shared whole-window counters, one-way matching release, foreign conflict and rollback-contained complete wedding cascade; no real human or public booking acceptance claim`)
  console.log(`Guarded-down checks passed: ${atomicDownCount} actual CLI failures with exact guard messages and complete row/journal/schema preservation`)
  console.log(`Verified ${expectedOwn.length} own migrations through ${LATEST}; all actual clean/upgrade/repeat/empty-down/guarded-down checks passed`)
  console.log(`Evidence source SHA-256: ${createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')}; migration manifest SHA-256: ${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`)
  console.log('Snapshot covers public rows/journal and relation/column/type/constraint/index/trigger/function/sequence-definition metadata, extension ownership/members/operator classes/families/operators, ACLs and comments; runtime sequence counters are nontransactional and excluded')
  console.log('ECOSYSTEM_MIGRATION_DRILL_PASSED')
} finally { await db.end() }
