// Native preserving89 extension. SQL fixtures are synthetic storage history;
// public writer, financial policy and human agreement acceptance live elsewhere.
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const NAME = '1763870000000_deal_day_scope_atomic'
const GROUP = 'legacy_day_groups'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const clone = value => structuredClone(value)
const sorted = values => [...values].sort()
const versionColumns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'schema_version', 'revision', 'previous_version_id',
  'origin_knowledge', 'operation', 'context_kind', 'event_id', 'performer_kind', 'vendor_id', 'binding_state',
  'service_date', 'time_zone', 'day_id']

async function bounded(promise, milliseconds) {
  let timer
  try {
    return await Promise.race([promise.then(value => ({ value })), new Promise(resolveTimeout => {
      timer = setTimeout(() => resolveTimeout({ timedOut: true }), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

// The CLI prints the complete SQL first. Only its final native Error own
// properties, never an echoed RAISE literal, qualify a refusal.
function nativeError(stderr) {
  const headers = [...stderr.matchAll(/^error: ([^\r\n]+)\r?$/gm)]
  assert(headers.length > 0, 'Actual native Error header required')
  const last = headers.at(-1), block = stderr.slice(last.index)
  const properties = / \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(block)
  assert(properties && /\r?\n {4}at /.test(block.slice(0, properties.index)))
  const field = (name, pattern) => {
    const matches = [...properties[1].matchAll(new RegExp(`^  ${name}: (${pattern}),?\\r?$`, 'gm'))]
    assert.equal(matches.length, 1, `Exactly one native Error.${name} required`)
    return matches[0][1]
  }
  const constraint = field('constraint', "undefined|null|'[^'\\r\\n]*'")
  return { message: last[1], code: field('code', "'[A-Z0-9]{5}'").slice(1, -1),
    severity: field('severity', "'[A-Z]+'").slice(1, -1),
    constraint: ['undefined', 'null'].includes(constraint) ? null : constraint.slice(1, -1) }
}

export async function runAtomicDayScopeCycle(c) {
  const { db, write, migrate, fr018State, assertJournal, manifest, migrationsDir, backend, cli,
    databaseUrl, selectedPort, pg, ownedPids, registerOwnedConnection, eraseOwnVendorUser } = c
  assert.equal(manifest.length, 89); assert.equal(manifest.at(-1).name, NAME)
  const migrationPath = resolve(migrationsDir, NAME + '.cjs')
  const helperPath = fileURLToPath(import.meta.url), helperSHA = digest(readFileSync(helperPath))
  const seal = () => {
    assert(lstatSync(migrationPath).isFile() && !lstatSync(migrationPath).isSymbolicLink())
    const bytes = readFileSync(migrationPath)
    assert.equal(digest(bytes), manifest.at(-1).digest)
    assert.equal(digest(readFileSync(helperPath)), helperSHA)
    return bytes.toString('utf8')
  }
  const halves = seal().split('exports.down = pgm => {')
  assert.equal(halves.length, 2)
  const definitions = text => [...text.matchAll(/create (or replace )?function (\w+)\([^]*?\bas \$\$([^]*?)\$\$;/g)]
    .map(row => ({ replace: Boolean(row[1]), name: row[2], body: row[3] }))
  const up = definitions(halves[0]), down = definitions(halves[1])
  assert(up.length > 7); assert.equal(new Set(up.map(row => row.name)).size, up.length)
  const replacements = new Map(up.filter(row => row.replace).map(row => [row.name, row.body]))
  const additions = new Set(up.filter(row => !row.replace).map(row => row.name))
  const oldBodies = new Map(down.map(row => [row.name, row.body]))
  assert.deepEqual(sorted(oldBodies.keys()), sorted(replacements.keys()))
  assert(!replacements.has('legacy_calendar_inventory_material'), 'The /1 function body and OID are immutable')
  const newTriggers = new Set([...halves[0].matchAll(/create (?:constraint )?trigger (\w+)/g)].map(row => row[1]))
  const constraintTriggerDeclarations = [...halves[0].matchAll(/create constraint trigger (\w+) [^\r\n]+ on (\w+)\r?\n\s+deferrable initially deferred for each row execute function \w+\(\);/g)]
  assert.equal(constraintTriggerDeclarations.length, 10, 'Pinned up declares exactly ten deferred constraint triggers')
  const constraintTriggers = new Map(constraintTriggerDeclarations.map(row => [row[1], row[2]]))
  assert.equal(constraintTriggers.size, 10, 'Constraint trigger names must be unique')
  const isConstraintTrigger = row => row.contype === 't' && constraintTriggers.get(row.conname) === row.table_name
  await assertJournal(manifest.slice(0, 88).map(row => row.name))

  const functionMetadata = async () => (await db.query(`select p.oid::text,p.proname,
    pg_get_function_identity_arguments(p.oid) arguments,p.prosrc,p.provolatile,p.prosecdef,p.proleakproof,
    p.proisstrict,p.proretset,p.proparallel,p.proconfig,p.prokind,p.procost,p.prorows,
    p.prosupport::regproc::text support,p.prorettype::regtype::text result,l.lanname,
    pg_get_userbyid(p.proowner) owner,p.proacl,obj_description(p.oid,'pg_proc') comment
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
  const booleans = async () => (await db.query(`select id::text,deal_day_scope_shape_valid(v) shape,
    deal_day_scope_matches_current(v) current from deal_day_scope_versions v order by id`)).rows
  async function rawTables() {
    const names = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows
    const result = []
    for (const { tablename } of names) {
      const identifier = '"' + tablename.replaceAll('"', '""') + '"'
      const rows = (await db.query(`select row_to_json(t)::text raw from public.${identifier} t order by row_to_json(t)::text`)).rows.map(row => row.raw)
      result.push({ table: tablename, rows })
    }
    return result
  }
  const before = await fr018State(), beforeFunctions = await functionMetadata(), beforeBooleans = await booleans()
  const beforeRaw = await rawTables()
  assert.equal(beforeRaw.length, 107)
  process.stdout.write(`ATOMIC89_RAW88_BEFORE ${JSON.stringify(beforeRaw)}\n`)
  assert.equal(Object.keys(before.snapshot.data).length, 107)
  for (const [name, body] of oldBodies) {
    const old = beforeFunctions.filter(row => row.proname === name)
    assert.equal(old.length, 1, `Unambiguous replaced function ${name}`)
    assert.equal(old[0].prosrc, body, `${name}: literal down restores exact applied88 body`)
  }
  const one = beforeFunctions.filter(row => row.proname === 'legacy_calendar_inventory_material')
  assert.equal(one.length, 1)

  async function installed() {
    seal()
    const after = await fr018State(), functions = await functionMetadata()
    const afterRaw = await rawTables()
    const triggerConstraints = after.snapshot.schema.constraints.filter(row => constraintTriggers.has(row.conname))
    assert.equal(triggerConstraints.length, 10, 'All ten declared trigger constraints must exist exactly once')
    for (const row of triggerConstraints) {
      assert(isConstraintTrigger(row), 'Trigger constraint must match its exact declared name/table/type')
      assert.equal(row.condeferrable, true); assert.equal(row.condeferred, true)
    }
    assert.equal(afterRaw.length, 108)
    for (const prior of beforeRaw) {
      const current = afterRaw.find(row => row.table === prior.table)
      assert(current)
      const currentRows = prior.table === 'pgmigrations' ? current.rows.filter(row => JSON.parse(row).name !== NAME) : current.rows
      assert.deepEqual(currentRows, prior.rows, `${prior.table}: every old row_to_json::text string remains byte-exact`)
    }
    assert.deepEqual(afterRaw.find(row => row.table === GROUP).rows, [])
    process.stdout.write(`ATOMIC89_RAW89_AFTER ${JSON.stringify(afterRaw)}\n`)
    assert.deepEqual(sorted(Object.keys(after.snapshot.data)), sorted([...Object.keys(before.snapshot.data), GROUP]))
    assert.deepEqual(after.snapshot.data[GROUP], [], 'Up never classifies or backfills old memberships')
    const groupColumns = after.snapshot.schema.columns.filter(row => row.table_name === GROUP)
      .map(row => ({ name: row.column_name, type: row.udt_name, nullable: row.is_nullable }))
    assert.deepEqual(groupColumns, [
      { name: 'day_id', type: 'uuid', nullable: 'NO' }, { name: 'vendor_id', type: 'uuid', nullable: 'NO' },
      { name: 'service_date', type: 'date', nullable: 'NO' }, { name: 'wedding_id', type: 'uuid', nullable: 'YES' },
      { name: 'classification', type: 'text', nullable: 'NO' }, { name: 'legacy_candidates', type: '_uuid', nullable: 'NO' },
      { name: 'revision', type: 'int8', nullable: 'NO' }, { name: 'classified_at', type: 'timestamptz', nullable: 'NO' },
    ])
    const foreignKeys = after.snapshot.schema.constraints.filter(row => row.table_name === GROUP && row.contype === 'f')
    assert.equal(foreignKeys.length, 1, 'No root or wedding FK may erase a foreign unresolved remainder')
    assert.equal(foreignKeys[0].definition, 'FOREIGN KEY (day_id) REFERENCES vendor_busy_dates(id) ON DELETE CASCADE')
    assert.equal(foreignKeys[0].convalidated, true)
    const expected = clone(before), projected = clone(after)
    const journal = after.snapshot.data.pgmigrations, added = journal.filter(row => row.name === NAME)
    assert.equal(added.length, 1); assert.deepEqual(Object.keys(added[0]).sort(), ['id', 'name', 'run_on'])
    assert(Number.isSafeInteger(added[0].id) && added[0].id > 0 && Number.isFinite(Date.parse(added[0].run_on)))
    assert.deepEqual(journal.filter(row => row.name !== NAME), before.snapshot.data.pgmigrations)
    expected.snapshot.data.pgmigrations = journal
    delete projected.snapshot.data[GROUP]
    const expectedFunctions = clone(beforeFunctions)
    for (const row of expectedFunctions) if (replacements.has(row.proname)) row.prosrc = replacements.get(row.proname)
    assert.deepEqual(functions.filter(row => !additions.has(row.proname)), expectedFunctions,
      'Every old function OID/signature/owner/ACL/config/flags remains; only pinned literal COR bodies change')
    assert.deepEqual(functions.filter(row => row.proname === 'legacy_calendar_inventory_material'), one)
    assert.deepEqual(sorted(functions.filter(row => additions.has(row.proname)).map(row => row.proname)), sorted(additions))
    for (const row of functions.filter(row => additions.has(row.proname))) {
      assert.equal(row.prosecdef, false); assert.equal(row.proleakproof, false); assert.equal(row.proconfig, null)
      assert(['sql', 'plpgsql'].includes(row.lanname))
    }
    for (const row of projected.snapshot.schema.functions) if (replacements.has(row.proname)) {
      const currentBody = replacements.get(row.proname)
      assert.equal(row.definition.split(currentBody).length, 2)
      row.definition = row.definition.replace(currentBody, oldBodies.get(row.proname))
    }
    projected.snapshot.schema.functions = projected.snapshot.schema.functions.filter(row => !additions.has(row.proname))
    const groupIndexes = new Set(projected.snapshot.schema.indexes.filter(row => row.tablename === GROUP).map(row => row.indexname))
    assert.deepEqual(sorted(groupIndexes), [GROUP + '_pkey'], 'Pinned group table has only its primary-key index')
    const groupRelations = new Set([GROUP, ...groupIndexes])
    const predicates = {
      relations: row => groupRelations.has(row.relname), columns: row => row.table_name === GROUP,
      columnMetadata: row => groupRelations.has(row.relname), constraints: row => row.table_name === GROUP || isConstraintTrigger(row),
      indexes: row => row.tablename === GROUP, triggers: row => row.table_name === GROUP || newTriggers.has(row.tgname),
      types: row => [GROUP, '_' + GROUP].includes(row.typname),
    }
    for (const [key, predicate] of Object.entries(predicates)) projected.snapshot.schema[key] = projected.snapshot.schema[key].filter(row => !predicate(row))
    const originalOIDs = new Set(before.objects.map(row => row.oid))
    const addedObjects = after.objects.filter(row => !originalOIDs.has(row.oid))
    const foreignTriggers = new Set((await db.query(`select t.oid::text from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint
      where k.conrelid='legacy_day_groups'::regclass`)).rows.map(row => row.oid))
    for (const row of addedObjects) {
      const valid = row.kind === 'relation' ? groupRelations.has(row.name)
        : row.kind === 'type' ? [GROUP, '_' + GROUP].includes(row.name)
          : row.kind === 'constraint' ? row.table_name === GROUP || triggerConstraints.some(constraint =>
            constraint.conname === row.name && constraint.table_name === row.table_name && isConstraintTrigger(constraint))
            : row.kind === 'function' ? additions.has(row.name.split('(')[0].replace(/^public\./, ''))
              : row.kind === 'trigger' && (row.table_name === GROUP || newTriggers.has(row.name.split('.').at(-1)) || foreignTriggers.has(row.oid))
      assert(valid, 'Unexpected new catalog object: ' + JSON.stringify(row))
    }
    projected.objects = projected.objects.filter(row => originalOIDs.has(row.oid))
    projected.attributes = projected.attributes.filter(row => !groupRelations.has(row.table_name))
    assert.deepEqual(projected, expected, 'Only the named89 delta may differ across all107 old tables/OIDs/catalog/attributes')
    assert.deepEqual(await booleans(), beforeBooleans, 'Up does not reinterpret any old stored observation')
    await assertJournal(manifest.map(row => row.name))
    process.stdout.write(`ATOMIC89_PRESERVING_UP ${JSON.stringify({ oldTables: 107, tables: 108, oldFunctionOIDsRetained: true,
      unchangedV1: one, replacedFunctions: sorted(replacements.keys()), addedFunctions: sorted(additions),
      addedTriggers: sorted(newTriggers), addedConstraintTriggers: triggerConstraints, addedObjects, noBackfill: true })}\n`)
    return after
  }
  await migrate('up', 1763870000000); const first = await installed()
  await migrate('up', 1763870000000); assert.deepEqual(await fr018State(), first)
  await migrate('down', NAME, undefined, true)
  assert.deepEqual(await fr018State(), before); assert.deepEqual(await functionMetadata(), beforeFunctions)
  assert.deepEqual(await booleans(), beforeBooleans)
  assert.deepEqual(await rawTables(), beforeRaw, 'No-new-history down restores all107 literal raw tables')
  await migrate('up', 1763870000000); await installed()


  // Independent native down branches: each committed fixture has exactly one
  // new89 evidence kind. Every cleanup below is through its own parents only.
  const preservingMessage = 'Atomic day scope evidence exists; use a preserving forward migration'
  const flags = async () => (await db.query(`select
    exists(select 1 from legacy_day_groups) as groups,
    exists(select 1 from deal_day_scope_versions where operation='observe_done') as observe_done,
    exists(select 1 from legacy_calendar_versions where canonical::jsonb->>'encoding'='legacy-calendar-inventory/2') as inventory2,
    exists(select 1 from audit_log where action='legacy_day.resolved') as resolution_audit,
    exists(select 1 from deal_day_scope_versions where operation='retain_done' and binding_state='external') as external_retain`)).rows[0]
  const flagVector = row => [row.groups, row.observe_done, row.inventory2, row.resolution_audit, row.external_retain]
  async function fullProof() {
    return { state: await fr018State(), functions: await functionMetadata(), booleans: await booleans(), raw: await rawTables() }
  }
  const auditRows = proof => proof.raw.find(row => row.table === 'audit_log').rows
  function retainedBefore(prior, current, extraAudit = []) {
    assert.deepEqual(current.raw.map(row => row.table), prior.raw.map(row => row.table))
    for (const row of prior.raw) {
      const actual = current.raw.find(now => now.table === row.table).rows
      const expected = row.table === 'audit_log' ? sorted([...row.rows, ...extraAudit]) : row.rows
      assert.deepEqual(actual, expected, row.table + ': own parent cleanup cannot change any other literal row')
    }
    assert.deepEqual(current.functions, prior.functions)
    assert.deepEqual(current.booleans, prior.booleans)
    const expected = clone(prior.state)
    if (extraAudit.length) expected.snapshot.data.audit_log = current.state.snapshot.data.audit_log
    assert.deepEqual(current.state, expected, 'Only explicitly retained new audit rows may outlive own fixture parents')
  }
  async function guardedEvidence(label, expectedFlags) {
    seal(); await assertJournal(manifest.map(row => row.name))
    const actualFlags = await flags()
    assert.deepEqual(flagVector(actualFlags), expectedFlags, label + ': isolated evidence vector required')
    assert.equal(expectedFlags.filter(Boolean).length, 1)
    const prior = await fullProof()
    process.stdout.write(`ATOMIC89_ISOLATED_DOWN_BEFORE ${JSON.stringify({ label, flags: actualFlags, proof: prior })}\n`)
    const outcome = await migrate('down', NAME, preservingMessage, true)
    const error = nativeError(outcome.output)
    assert.deepEqual(error, { message: preservingMessage, code: '23514', severity: 'ERROR', constraint: 'deal_day_scope_atomic_preserving_down' })
    const after = await fullProof()
    process.stdout.write(`ATOMIC89_ISOLATED_DOWN_AFTER ${JSON.stringify({ label, flags: await flags(), error, outcome, proof: after })}\n`)
    assert.deepEqual(after, prior, label + ': actual native refusal preserves every literal row and full catalogue')
    assert.deepEqual(flagVector(await flags()), expectedFlags)
    await assertJournal(manifest.map(row => row.name)); seal()
  }
  async function fixtureTx(action) {
    await write('begin')
    try { const value = await action(); await write('commit'); return value }
    catch (error) { await db.query('rollback'); throw error }
  }
  async function ownFixture(kind) {
    const own = Object.fromEntries(['owner', 'company', 'wedding', 'vendor', 'slot', 'deal'].map(key => [key, randomUUID()]))
    own.date = `${new Date().getUTCFullYear() + 2}-07-21`; own.timeZone = 'Europe/Moscow'
    own.external = kind === 'external'
    await fixtureTx(async () => {
      for (const id of [own.owner, own.company]) await write("insert into users(id,phone,name) values($1,$2,'Synthetic isolated atomic89 actor')",
        [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
      await write("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic isolated atomic89 studio',now())", [own.vendor, own.company])
      await write("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic isolated atomic89',$3,$4,$5)", [own.wedding, own.owner, own.date, own.timeZone, randomUUID()])
      await write("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [own.wedding, own.owner])
      await write("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic isolated atomic89 position')", [own.slot, own.wedding])
      await write("insert into deals(id,wedding_id,slot_id,vendor_id,external_name,state,price) values($1,$2,$3,$4,$5,'booked',17000)",
        [own.deal, own.wedding, own.slot, own.external ? null : own.vendor, own.external ? 'Synthetic historical external' : null])
      await write('update slots set deal_id=$2 where id=$1', [own.slot, own.deal])
      own.event = (await write('select id from wedding_events where wedding_id=$1 and is_main', [own.wedding])).rows[0].id
      // No mutex on purpose: this is a pretracking synthetic DATE, not a new
      // public acquire and not a backfill/classification by a reader.
      if (!own.external) own.day = (await write("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3) returning id", [own.vendor, own.date, own.deal])).rows[0].id
    })
    return own
  }
  async function touchOwned(own) {
    return fixtureTx(async () => {
      await write('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
      const day = (await write('select source_revision::text from vendor_busy_dates where id=$1', [own.day])).rows
      assert.equal(day.length, 1)
      const group = (await write('select * from legacy_day_group_touch($1,$2,$3::bigint)', [own.day, own.wedding, day[0].source_revision])).rows[0]
      assert.equal(group.classification, 'legacy_unknown'); assert.deepEqual(group.legacy_candidates, [own.deal])
      return group
    })
  }
  async function ownVersion(own, operation, binding, previous = null) {
    const row = { id: randomUUID(), wedding_id: own.wedding, deal_id: own.deal, slot_id: own.slot, schema_version: 1,
      revision: previous ? String(BigInt(previous.revision) + 1n) : '1', previous_version_id: previous?.id ?? null,
      origin_knowledge: previous ? null : 'legacy_unknown', operation, context_kind: 'implicit_main', event_id: own.event,
      performer_kind: own.external ? 'external' : 'catalog', vendor_id: own.external ? null : own.vendor,
      binding_state: binding, service_date: own.date, time_zone: own.timeZone, day_id: null }
    await write(`insert into deal_day_scope_versions(${versionColumns.join(',')}) values(${versionColumns.map((_, i) => '$' + (i + 1)).join(',')})`, versionColumns.map(key => row[key]))
    if (previous) await write('update deal_day_scope_heads set revision=$2,current_version_id=$3 where deal_id=$1', [own.deal, row.revision, row.id])
    else await write('insert into deal_day_scope_heads(deal_id,wedding_id,revision,current_version_id) values($1,$2,1,$3)', [own.deal, own.wedding, row.id])
    return row
  }
  async function eraseOwnParents(own, label, prior, extraAudit = [], vendorAlreadyErased = false) {
    process.stdout.write(`ATOMIC89_OWN_PARENT_ERASURE_BEFORE ${JSON.stringify({ label, own, proof: await fullProof() })}\n`)
    await fixtureTx(async () => {
      await write('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
      assert.deepEqual((await write('delete from weddings where id=$1 returning id', [own.wedding])).rows, [{ id: own.wedding }])
      assert.deepEqual((await write('delete from vendors where id=$1 returning id', [own.vendor])).rows, vendorAlreadyErased ? [] : [{ id: own.vendor }])
      const remainingUsers = vendorAlreadyErased ? [own.owner] : [own.owner, own.company]
      if (vendorAlreadyErased) assert.equal((await write('select id from users where id=$1', [own.company])).rowCount, 0)
      assert.deepEqual(sorted((await write('delete from users where id=any($1::uuid[]) returning id', [remainingUsers])).rows.map(row => row.id)), sorted(remainingUsers))
    })
    const after = await fullProof()
    process.stdout.write(`ATOMIC89_OWN_PARENT_ERASURE_AFTER ${JSON.stringify({ label, proof: after })}\n`)
    retainedBefore(prior, after, extraAudit); seal()
  }

  assert.deepEqual(flagVector(await flags()), [false, false, false, false, false])
  const groupBaseline = await fullProof(), groupOwn = await ownFixture('catalog')
  await touchOwned(groupOwn)
  await guardedEvidence('group-only', [true, false, false, false, false])
  await eraseOwnParents(groupOwn, 'group-only', groupBaseline)
  assert.deepEqual(flagVector(await flags()), [false, false, false, false, false])

  const captureBaseline = await fullProof(), captureOwn = await ownFixture('catalog')
  await touchOwned(captureOwn)
  const source = (await db.query("select id from legacy_calendar_sources where kind='app_day' and vendor_id=$1 and wedding_id=$2 and day_id=$3", [captureOwn.vendor, captureOwn.wedding, captureOwn.day])).rows
  assert.equal(source.length, 1)
  await fixtureTx(async () => {
    const captured = (await write("select * from legacy_calendar_append_version($1,$2,'owner_capture')", [source[0].id, captureOwn.company])).rows
    assert.equal(captured.length, 1); assert.equal(captured[0].created, true)
  })
  const savedCapture = await fullProof()
  assert.equal(savedCapture.raw.find(row => row.table === 'legacy_calendar_versions').rows.filter(row => JSON.parse(row).source_id === source[0].id).length, 1)
  const savedVersionRows = savedCapture.raw.find(row => row.table === 'legacy_calendar_versions').rows.filter(row => JSON.parse(row).source_id === source[0].id)
  assert.equal(savedVersionRows.length, 1)
  const savedVersion = JSON.parse(savedVersionRows[0])
  assert.equal(savedVersion.captured_by, captureOwn.company)
  const expectedVersionRows = (await db.query(`select row_to_json(expected_row)::text raw from legacy_calendar_versions v
    cross join lateral jsonb_populate_record(null::legacy_calendar_versions,to_jsonb(v)||jsonb_build_object('captured_by',null::uuid)) as expected_row
    where v.id=$1 and v.source_id=$2 and v.captured_by=$3`, [savedVersion.id, source[0].id, captureOwn.company])).rows
  assert.equal(expectedVersionRows.length, 1)
  const expectedVersionRaw = expectedVersionRows[0].raw
  assert.deepEqual(JSON.parse(expectedVersionRaw), { ...savedVersion, captured_by: null })
  process.stdout.write(`ATOMIC89_CAPTURE_ERASURE_EXPECTED ${JSON.stringify({ own: captureOwn, versionBefore: savedVersionRows[0], versionExpected: expectedVersionRaw })}\n`)
  assert.equal(typeof eraseOwnVendorUser, 'function')
  await eraseOwnVendorUser(captureOwn.company)
  assert.equal((await db.query('select id from users where id=$1', [captureOwn.company])).rowCount, 0)
  assert.equal((await db.query('select id from vendors where id=$1', [captureOwn.vendor])).rowCount, 0)
  const afterVendorErase = await fullProof()
  process.stdout.write(`ATOMIC89_CAPTURE_ERASURE_AFTER ${JSON.stringify({ own: captureOwn, proof: afterVendorErase })}\n`)
  for (const table of ['legacy_calendar_sources', 'legacy_calendar_versions', 'legacy_calendar_heads', 'legacy_calendar_version_holders']) {
    const saved = savedCapture.raw.find(row => row.table === table).rows.filter(row => {
      const value = JSON.parse(row); return table === 'legacy_calendar_sources' ? value.id === source[0].id : value.source_id === source[0].id
    })
    const actual = afterVendorErase.raw.find(row => row.table === table).rows.filter(row => {
      const value = JSON.parse(row); return table === 'legacy_calendar_sources' ? value.id === source[0].id : value.source_id === source[0].id
    })
    const expected = table === 'legacy_calendar_versions'
      ? saved.map(row => JSON.parse(row).id === savedVersion.id ? expectedVersionRaw : row) : saved
    assert.deepEqual(actual, expected, table + ': only the erased own capture author may detach; all other raw history is exact')
    if (table === 'legacy_calendar_versions') {
      assert.equal(actual.length, 1); assert.equal(JSON.parse(actual[0]).captured_by, null)
      assert.deepEqual(JSON.parse(actual[0]), { ...savedVersion, captured_by: null })
    }
  }
  await guardedEvidence('inventory2-capture-only', [false, false, true, false, false])
  await eraseOwnParents(captureOwn, 'inventory2-capture-only', captureBaseline, [], true)
  assert.deepEqual(flagVector(await flags()), [false, false, false, false, false])

  const externalBaseline = await fullProof(), externalOwn = await ownFixture('external')
  const initialExternal = await fixtureTx(() => ownVersion(externalOwn, 'observe', 'external'))
  const retainedExternal = await fixtureTx(async () => {
    await write("update deals set state='done' where id=$1", [externalOwn.deal])
    return ownVersion(externalOwn, 'retain_done', 'external', initialExternal)
  })
  const releasedExternal = await fixtureTx(async () => {
    // Storage-only control: HTTP done->cancelled is not enabled by this drill.
    await write("update deals set state='cancelled' where id=$1", [externalOwn.deal])
    return ownVersion(externalOwn, 'release', 'released', retainedExternal)
  })
  const externalHead = (await db.query('select revision::text,current_version_id from deal_day_scope_heads where deal_id=$1', [externalOwn.deal])).rows
  assert.deepEqual(externalHead, [{ revision: '3', current_version_id: releasedExternal.id }])
  const retainedHistory = (await db.query("select id from deal_day_scope_versions where deal_id=$1 and operation='retain_done' and binding_state='external'", [externalOwn.deal])).rows
  assert.deepEqual(retainedHistory, [{ id: retainedExternal.id }]); assert.notEqual(externalHead[0].current_version_id, retainedExternal.id)
  await guardedEvidence('external-retain-history-only', [false, false, false, false, true])
  await eraseOwnParents(externalOwn, 'external-retain-history-only', externalBaseline)
  assert.deepEqual(flagVector(await flags()), [false, false, false, false, false])
  const terminalBaseline = await fullProof()

  // A valid first NULL-date terminal record is genuinely new89 evidence. Keep
  // it after the drill and prove the native down waits before reading history.
  const fixture = Object.fromEntries(['owner', 'company', 'wedding', 'vendor', 'slot', 'deal'].map(key => [key, randomUUID()]))
  await write('begin')
  try {
    for (const id of [fixture.owner, fixture.company]) await write("insert into users(id,phone,name) values($1,$2,'Synthetic atomic89 drill actor')",
      [id, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
    await write("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic atomic89 drill studio',now())", [fixture.vendor, fixture.company])
    await write("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic atomic89 drill',null,null,$3)", [fixture.wedding, fixture.owner, randomUUID()])
    await write("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [fixture.wedding, fixture.owner])
    await write("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic atomic89 drill position')", [fixture.slot, fixture.wedding])
    await write("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'done',17000)", [fixture.deal, fixture.wedding, fixture.slot, fixture.vendor])
    await write('update slots set deal_id=$2 where id=$1', [fixture.slot, fixture.deal])
    fixture.event = (await write('select id from wedding_events where wedding_id=$1 and is_main', [fixture.wedding])).rows[0].id
    await write('commit')
  } catch (error) { await db.query('rollback'); throw error }
  const pending = { id: randomUUID(), wedding_id: fixture.wedding, deal_id: fixture.deal, slot_id: fixture.slot,
    schema_version: 1, revision: '1', previous_version_id: null, origin_knowledge: 'legacy_unknown', operation: 'observe_done',
    context_kind: 'implicit_main', event_id: fixture.event, performer_kind: 'catalog', vendor_id: fixture.vendor,
    binding_state: 'done_undated', service_date: null, time_zone: null, day_id: null }
  const beforeConcurrent = await fr018State()
  const writer = new pg.Client({ connectionString: databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 5000 })
  const writerErrors = []; writer.on('error', error => writerErrors.push(error))
  let writerPID, child, childClosed, closed = false, forced = false, childError, waitWitness, primaryError
  const streams = { stdout: { chunks: [], ended: false }, stderr: { chunks: [], ended: false } }
  let overflow = false
  const emit = label => {
    const stdout = Buffer.concat(streams.stdout.chunks), stderr = Buffer.concat(streams.stderr.chunks)
    const value = { childPID: child?.pid, parentPID: process.pid, writerPID, waitWitness, forced,
      stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), stdoutBytes: stdout.length, stderrBytes: stderr.length,
      stdoutSHA256: digest(stdout), stderrSHA256: digest(stderr), stdoutEOF: streams.stdout.ended, stderrEOF: streams.stderr.ended }
    process.stdout.write(`${label} ${JSON.stringify(value)}\n`)
    return value
  }
  async function closeConcurrent(priorError) {
    const errors = priorError ? [priorError] : []
    try { if (writerPID) await writer.query('rollback') } catch (error) { errors.push(error) }
    try {
      const ended = await bounded(writer.end(), 5000)
      if (ended.timedOut) { writer.connection?.stream?.destroy(); throw new Error('Owned writer close deadline; forced socket close is not acceptance') }
      if (writerPID) ownedPids.delete(writerPID)
      assert.deepEqual(writerErrors, [])
    } catch (error) { errors.push(error) }
    try {
      if (child && !closed) {
        const ended = await bounded(childClosed, 7000)
        if (ended.timedOut) { forced = true; child.kill(); await bounded(childClosed, 5000) }
        assert(!forced && closed, 'Owned native down forced/unclosed; actual child PID ' + child.pid)
      }
    } catch (error) { errors.push(error) }
    if (errors.length > (priorError ? 1 : 0)) { emit('ATOMIC89_NATIVE_CLEANUP_FAILED'); throw new AggregateError(errors, 'Atomic89 drill or owned cleanup failed') }
  }
  try {
    await writer.connect(); writerPID = await registerOwnedConnection(writer); await writer.query('begin')
    await writer.query(`insert into deal_day_scope_versions(${versionColumns.join(',')}) values(${versionColumns.map((_, index) => `$${index + 1}`).join(',')})`, versionColumns.map(key => pending[key]))
    await writer.query('insert into deal_day_scope_heads(deal_id,wedding_id,revision,current_version_id) values($1,$2,1,$3)', [fixture.deal, fixture.wedding, pending.id])
    const tag = `atomic89-down-${randomUUID()}`
    const args = [cli, 'down', NAME, '-m', migrationsDir, '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false']
    child = spawn(process.execPath, args, { cwd: backend, windowsHide: true,
      env: { ...process.env, PGAPPNAME: tag, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'] })
    process.stdout.write(`ATOMIC89_NATIVE_CHILD_STARTED ${JSON.stringify({ owner: 'atomic89-preserving-drill', parentPID: process.pid,
      pid: child.pid, exe: process.execPath, cwd: backend, args, startedAt: new Date().toISOString(), ports: [] })}\n`)
    childClosed = new Promise(resolveClose => {
      child.on('error', error => { childError = error })
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        stream.on('data', chunk => {
          if (streams.stdout.chunks.reduce((sum, row) => sum + row.length, 0) + streams.stderr.chunks.reduce((sum, row) => sum + row.length, 0) + chunk.length > 16 * 1024 * 1024) overflow = true
          else streams[name].chunks.push(chunk)
        })
        stream.on('end', () => { streams[name].ended = true }); stream.on('error', error => { childError = error })
      }
      child.on('close', (code, signal) => { closed = true; resolveClose({ code, signal }) })
    })
    const deadline = performance.now() + 20_000
    while (performance.now() < deadline && !closed && !waitWitness) {
      const rows = (await db.query(`select a.pid,a.application_name,a.usename,a.datname,a.state,a.query,a.wait_event_type,a.wait_event,
        pg_blocking_pids(a.pid) blockers,l.mode,l.granted,l.relation::regclass::text relation
        from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.datname=current_database() and a.application_name=$1
          and l.relation='public.deal_day_scope_versions'::regclass and l.mode='AccessExclusiveLock' and not l.granted`, [tag])).rows
      if (rows.length) { assert.equal(rows.length, 1); waitWitness = rows[0] }
      else await new Promise(resolveTick => setTimeout(resolveTick, 25))
    }
    assert(waitWitness && waitWitness.blockers.includes(writerPID) && waitWitness.wait_event_type === 'Lock')
    const outcome = await bounded(childClosed, Math.max(1, deadline - performance.now()))
    assert(!outcome.timedOut); assert.notEqual(outcome.value.code, 0); assert.equal(outcome.value.signal, null)
    assert(!overflow && !childError && streams.stdout.ended && streams.stderr.ended)
    const actual = emit('ATOMIC89_NATIVE_LOCK_WAIT')
    assert.deepEqual([...actual.stdout.matchAll(/^> - (.+)$/gm)].map(row => row[1].trim()), [NAME])
    assert.deepEqual(nativeError(actual.stderr), { message: 'canceling statement due to lock timeout', code: '55P03', severity: 'ERROR', constraint: null })
    await writer.query('commit')
  } catch (error) { primaryError = error; throw error }
  finally { await closeConcurrent(primaryError) }
  const afterConcurrent = await fr018State(), expectedConcurrent = clone(beforeConcurrent)
  const actualVersion = afterConcurrent.snapshot.data.deal_day_scope_versions.find(row => row.id === pending.id)
  assert(actualVersion); const { recorded_at, ...fields } = actualVersion
  assert(Number.isFinite(Date.parse(recorded_at))); assert.deepEqual(fields, { ...pending, revision: 1 })
  assert.deepEqual(afterConcurrent.snapshot.data.deal_day_scope_versions.filter(row => row.id !== pending.id),
    beforeConcurrent.snapshot.data.deal_day_scope_versions, 'Every old ledger version remains literal')
  assert.deepEqual(afterConcurrent.snapshot.data.deal_day_scope_heads.filter(row => row.deal_id !== fixture.deal),
    beforeConcurrent.snapshot.data.deal_day_scope_heads, 'Every old head remains literal')
  assert.deepEqual(afterConcurrent.snapshot.data.deal_day_scope_heads.filter(row => row.deal_id === fixture.deal),
    [{ deal_id: fixture.deal, wedding_id: fixture.wedding, revision: 1, current_version_id: pending.id }])
  expectedConcurrent.snapshot.data.deal_day_scope_versions = afterConcurrent.snapshot.data.deal_day_scope_versions
  expectedConcurrent.snapshot.data.deal_day_scope_heads = afterConcurrent.snapshot.data.deal_day_scope_heads
  assert.equal(expectedConcurrent.snapshot.data.deal_day_scope_versions.length, beforeConcurrent.snapshot.data.deal_day_scope_versions.length + 1)
  assert.equal(expectedConcurrent.snapshot.data.deal_day_scope_heads.length, beforeConcurrent.snapshot.data.deal_day_scope_heads.length + 1)
  assert.deepEqual(afterConcurrent, expectedConcurrent, 'Concurrent writer changes only its one initial observation/head')
  const current = (await booleans()).find(row => row.id === pending.id)
  assert.deepEqual(current, { id: pending.id, shape: true, current: true })
  assert.deepEqual(flagVector(await flags()), [false, true, false, false, false])
  const nativeHistoryProof = await fullProof()
  const preserved = await fr018State()
  const guarded = await migrate('down', NAME, 'Atomic day scope evidence exists; use a preserving forward migration', true)
  process.stdout.write(`ATOMIC89_NATIVE_HISTORY_DOWN ${JSON.stringify(guarded)}\n`)
  assert.deepEqual(nativeError(guarded.output), { message: 'Atomic day scope evidence exists; use a preserving forward migration',
    code: '23514', severity: 'ERROR', constraint: 'deal_day_scope_atomic_preserving_down' })
  assert.deepEqual(await fr018State(), preserved)
  assert.deepEqual(await fullProof(), nativeHistoryProof, 'Original observe_done native refusal preserves full literal raw/catalogue proof')
  await migrate('up', 1763870000000); assert.deepEqual(await fr018State(), preserved)
  await assertJournal(manifest.map(row => row.name)); seal()
  process.stdout.write(`ATOMIC_DAY_SCOPE_DRILL_PASSED ${JSON.stringify({ schema: 89, tables: 108, populated88Ups: 2,
    preservingNoNewHistoryDown: 1, repeats: 2, nativeLockTimeout: 1, newHistoryDownRefusals: 1,
    helperSHA256: helperSHA, migrationSHA256: manifest.at(-1).digest, publicWriterAuthority: false })}\n`)

  // All original AX/observe_done assertions and its native refusal above have
  // completed. Preserve their full raw proof before erasing only these parents.
  assert.deepEqual(flagVector(await flags()), [false, true, false, false, false])
  await eraseOwnParents(fixture, 'original-observe_done-after-all-assertions', terminalBaseline)
  assert.deepEqual(flagVector(await flags()), [false, false, false, false, false])

  // Last phase: a real trigger-generated audit must survive its root/group.
  // No later branch can be honestly called isolated while this audit remains.
  const auditBaseline = await fullProof(), auditOwn = await ownFixture('catalog')
  const auditGroup = await touchOwned(auditOwn)
  const release = await fixtureTx(async () => {
    await write('select legacy_day_lock_vendors($1::uuid[])', [[auditOwn.vendor]])
    await write("update deals set state='cancelled' where id=$1", [auditOwn.deal])
    const version = await ownVersion(auditOwn, 'observe', 'released')
    const resolved = (await write("select * from legacy_day_resolve($1,$2,$3::bigint,$4,'cancel')", [auditOwn.day, auditOwn.deal, String(auditGroup.revision), version.id])).rows[0]
    assert.deepEqual(resolved.legacy_candidates, [])
    await write('select legacy_day_reconcile($1,$2::bigint)', [auditOwn.day, String(resolved.revision)])
    return version
  })
  const ownAudits = (await db.query("select row_to_json(t)::text raw from audit_log t where action='legacy_day.resolved' and entity_id=$1 order by row_to_json(t)::text", [auditOwn.deal])).rows.map(row => row.raw)
  assert.equal(ownAudits.length, 1)
  const auditValue = JSON.parse(ownAudits[0])
  assert.equal(auditValue.actor_id, null); assert.equal(auditValue.entity, 'deal')
  assert.deepEqual(auditValue.diff, { dayId: auditOwn.day, versionId: release.id, reason: 'cancel', beforeRevision: String(auditGroup.revision), afterRevision: String(BigInt(auditGroup.revision) + 1n) })
  assert.deepEqual(auditRows(await fullProof()).filter(row => !auditRows(auditBaseline).includes(row)), ownAudits)
  await eraseOwnParents(auditOwn, 'resolution-audit-only', auditBaseline, ownAudits)
  await guardedEvidence('resolution-audit-only', [false, false, false, true, false])
  const final = await fullProof(); retainedBefore(terminalBaseline, final, ownAudits)
  assert.deepEqual(flagVector(await flags()), [false, false, false, true, false])
  await assertJournal(manifest.map(row => row.name)); seal()
  process.stdout.write(`ATOMIC89_ISOLATED_DOWNS_PASSED ${JSON.stringify({ branches: ['group-only', 'inventory2-capture-only', 'external-retain-history-only', 'resolution-audit-only'],
    originalObserveDoneAndNativeAXRetained: true, nativeRefusals: 4, oldRowsAndCatalogueUnchanged: true,
    allAuditsLiteralRetained: true, retainedAuditRows: ownAudits, runtimeSequenceValuesNotCompared: true,
    helperSHA256: helperSHA, migrationSHA256: manifest.at(-1).digest, publicWriterAuthority: false })}\n`)

}
