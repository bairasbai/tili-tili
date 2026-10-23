// Native migration preservation only. Synthetic SQL history is not public
// booking acceptance, a read-proof signature or evidence of human agreement.
import assert from 'node:assert/strict'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const OFFER = '1763880000000_offer_event_context'
const MOVE = '1763890000000_event_move_agreements'
const FIX = '1763900000000_event_move_snapshot_operators'
const OFFER_SHA = '24b8b831f370e74567b409ab6943236776807ab40d37b46a21faa2abc72af036'
// Literal final91 admitted by Root after fresh independent review. Never adopt
// a mutable DDL hash, file count or an unreviewed migration body.
const MOVE_SHA = 'c3a1019f88a798b4df8802d9c5212eef01f6f54194a98ba615dce0c9ac613afa'
const FIX_SHA = 'ec1635c3e1638b18b9330b889c2e456c4009c6e4928e7d9307f95c7c746476cb'
const TABLES = ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects']
const COR = ['audit_legacy_day_resolution', 'legacy_day_resolution_valid', 'legacy_day_resolve']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sorted = values => [...values].sort()
const clone = value => structuredClone(value)
const quote = name => '"' + name.replaceAll('"', '""') + '"'
const downMessage = 'Event move evidence exists; use a preserving forward migration'
const versionColumns = ['id', 'wedding_id', 'deal_id', 'slot_id', 'revision', 'origin_knowledge', 'operation',
  'context_kind', 'event_id', 'performer_kind', 'vendor_id', 'binding_state', 'service_date', 'time_zone', 'day_id']

// Only the last actual Error object qualifies. Echoed SQL contains these same
// code/message literals and must never serve as a native failure witness.
function nativeError(output) {
  const headers = [...output.matchAll(/^error: ([^\r\n]+)\r?$/gm)]
  assert(headers.length > 0, 'Native Error header required')
  const last = headers.at(-1), block = output.slice(last.index)
  const properties = / \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(block)
  assert(properties && /\r?\n {4}at /.test(block.slice(0, properties.index)))
  const field = (name, pattern) => {
    const values = [...properties[1].matchAll(new RegExp(`^  ${name}: (${pattern}),?\\r?$`, 'gm'))]
    assert.equal(values.length, 1, `One actual Error.${name} required`)
    return values[0][1]
  }
  const constraint = field('constraint', "undefined|null|'[^'\\r\\n]*'")
  return { message: last[1], code: field('code', "'[A-Z0-9]{5}'").slice(1, -1),
    severity: field('severity', "'[A-Z]+'").slice(1, -1),
    constraint: ['undefined', 'null'].includes(constraint) ? null : constraint.slice(1, -1) }
}
async function bounded(promise, milliseconds) {
  let timer
  try { return await Promise.race([promise.then(value => ({ value })), new Promise(resolveTimeout => {
    timer = setTimeout(() => resolveTimeout({ timedOut: true }), milliseconds)
  })]) } finally { clearTimeout(timer) }
}

export async function runAdditionalEventCycle(c) {
  const { db, write, migrate, fr018State, assertJournal, manifest, migrationsDir, backend, cli,
    databaseUrl, selectedPort, pg, ownedPids, registerOwnedConnection } = c
  assert.equal(manifest.length, 92)
  assert.deepEqual(manifest.slice(89).map(row => row.name), [OFFER, MOVE, FIX])
  assert(/^[a-f0-9]{64}$/.test(MOVE_SHA), '91 is not admitted before the explicit reviewed Root repin')
  const helperPath = fileURLToPath(import.meta.url), helperSHA = sha(readFileSync(helperPath))
  const seal = () => {
    assert.equal(sha(readFileSync(helperPath)), helperSHA, 'Drill helper changed during execution')
    return [OFFER, MOVE, FIX].map((name, i) => {
      const path = resolve(migrationsDir, name + '.cjs'), pin = [OFFER_SHA, MOVE_SHA, FIX_SHA][i]
      assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink())
      assert.equal(manifest[89 + i].digest, pin)
      const bytes = readFileSync(path); assert.equal(sha(bytes), pin)
      return bytes.toString('utf8')
    })
  }
  const [offerDDL, moveDDL, fixDDL] = seal()
  const halves = moveDDL.split('exports.down = pgm => {'); assert.equal(halves.length, 2)
  const definitions = text => [...text.matchAll(/create (or replace )?function (\w+)\([^]*?\bas \$\$([^]*?)\$\$;/g)]
    .map(row => ({ replace: Boolean(row[1]), name: row[2], body: row[3] }))
  const ups = definitions(halves[0]), downs = definitions(halves[1])
  const replacements = new Map(ups.filter(row => row.replace).map(row => [row.name, row.body]))
  const oldBodies = new Map(downs.map(row => [row.name, row.body]))
  const additions = new Map(ups.filter(row => !row.replace).map(row => [row.name, row.body]))
  const fixHalves = fixDDL.split('exports.down = pgm =>'); assert.equal(fixHalves.length, 2)
  const fixUp = definitions(fixHalves[0]), fixDown = definitions(fixHalves[1])
  assert.equal(fixUp.length, 1); assert.equal(fixDown.length, 1)
  assert.equal(fixUp[0].name, 'event_move_snapshot_valid'); assert(fixUp[0].replace)
  assert.equal(fixDown[0].name, fixUp[0].name); assert(fixDown[0].replace)
  assert.equal(fixDown[0].body, additions.get('event_move_snapshot_valid'), '92 down is literal applied91 body')
  assert.deepEqual(sorted(replacements.keys()), COR); assert.deepEqual(sorted(oldBodies.keys()), COR)
  assert.equal(additions.size, 28); assert.equal(ups.length, 31)
  assert.deepEqual([...halves[0].matchAll(/create table (\w+)\(/g)].map(row => row[1]), TABLES)
  const loops = [...moveDDL.matchAll(/for \(const table of \[([^]*?)\]\) \{/g)]
  assert.equal(loops.length, 2); assert.equal(loops[0][1], loops[1][1])
  const watchers = [...loops[0][1].matchAll(/'([^']+)'/g)].map(row => row[1])
  assert.equal(watchers.length, 46); assert.equal(new Set(watchers).size, 46)
  assert(watchers.includes('offer_requests') && watchers.includes('offers'))
  const ordinaryTriggers = new Set([...halves[0].matchAll(/create trigger (\w+)/g)].map(row => row[1]))
  assert.equal(ordinaryTriggers.size, 10)
  const introduced = new Set()
  const functionMetadata = async () => (await db.query(`select p.oid::text,p.proname,
    pg_get_function_identity_arguments(p.oid) arguments,p.prosrc,p.provolatile,p.prosecdef,p.proleakproof,
    p.proisstrict,p.proretset,p.proparallel,p.proconfig,p.prokind,p.procost,p.prorows,
    p.prosupport::regproc::text support,p.prorettype::regtype::text result,l.lanname,
    pg_get_userbyid(p.proowner) owner,p.proacl,obj_description(p.oid,'pg_proc') comment
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
    where n.nspname='public' order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
  async function rawTables(layout) {
    const names = layout ? Object.keys(layout) : (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename)
    const result = []
    for (const table of sorted(names)) {
      const fields = layout ? layout[table].map(quote).join(',') : '*'
      const rows = (await db.query(`select row_to_json(t)::text raw from (select ${fields} from public.${quote(table)}) t order by row_to_json(t)::text`)).rows.map(row => row.raw)
      result.push({ table, rows })
    }
    return result
  }
  async function proof() { seal(); return { state: await fr018State(), functions: await functionMetadata(), raw: await rawTables() } }
  const emit = (name, value) => process.stdout.write(`${name} ${JSON.stringify(value)}\n`)
  async function tx(action) {
    await write('begin')
    try { const result = await action(); await write('commit'); return result }
    catch (error) { await db.query('rollback'); throw error }
  }
  async function repeat(stamp, label) {
    const before = await proof(); await migrate('up', stamp); assert.deepEqual(await proof(), before)
    emit('ADDITIONAL_REPEAT', { label, stamp, unchanged: true })
  }
  function withoutJournal(state, name) {
    state.snapshot.data.pgmigrations = state.snapshot.data.pgmigrations.filter(row => row.name !== name)
    return state
  }
  function prior90(state) {
    const value = clone(state), schema = value.snapshot.schema
    value.snapshot.data.offer_requests = value.snapshot.data.offer_requests.map(row => {
      const copy = { ...row }; delete copy.program_event_context; return copy
    })
    withoutJournal(value, OFFER)
    schema.columns = schema.columns.filter(row => !(row.table_name === 'offer_requests' && row.column_name === 'program_event_context'))
    schema.columnMetadata = schema.columnMetadata.filter(row => !(row.relname === 'offer_requests' && row.attname === 'program_event_context'))
    schema.triggers = schema.triggers.filter(row => !(row.table_name === 'offer_requests' && row.tgname === 'offer_request_event_context_guard'))
    schema.functions = schema.functions.filter(row => row.proname !== 'offer_request_event_context_guard')
    value.objects = value.objects.filter(row => !(row.kind === 'function' && row.name === 'offer_request_event_context_guard()')
      && !(row.kind === 'trigger' && row.name === 'offer_requests.offer_request_event_context_guard'))
    value.attributes = value.attributes.filter(row => !introduced.has(`${row.table_name}:${row.attnum}`))
    return value
  }
  async function installed90(before) {
    const after = await fr018State()
    const fields = after.snapshot.schema.columns.filter(row => row.table_name === 'offer_requests' && row.column_name === 'program_event_context')
    assert.equal(fields.length, 1); assert.equal(fields[0].data_type, 'jsonb'); assert.equal(fields[0].is_nullable, 'YES'); assert.equal(fields[0].column_default, null)
    const attr = after.attributes.filter(row => row.table_name === 'offer_requests' && row.attname === 'program_event_context' && !row.attisdropped)
    assert.equal(attr.length, 1)
    assert.equal(attr[0].attnum, Math.max(...before.attributes.filter(row => row.table_name === 'offer_requests').map(row => row.attnum)) + 1)
    introduced.add(`offer_requests:${attr[0].attnum}`)
    assert(after.snapshot.data.offer_requests.every(row => row.program_event_context === null), 'No inferred historical snapshot')
    const triggers = after.snapshot.schema.triggers.filter(row => row.tgname === 'offer_request_event_context_guard')
    assert.equal(triggers.length, 1); assert.equal(triggers[0].table_name, 'offer_requests')
    const declarations = definitions(offerDDL)
    assert.equal(declarations.length, 1); assert.equal(declarations[0].name, 'offer_request_event_context_guard')
    const functions = (await functionMetadata()).filter(row => row.proname === declarations[0].name)
    assert.equal(functions.length, 1); assert.equal(functions[0].prosrc, declarations[0].body)
    assert.equal(functions[0].proconfig, null); assert.equal(functions[0].prosecdef, false)
    assert.deepEqual(prior90(after), prior90(before), '90 may add only its nullable column, observed attribute slot, guard/function and journal')
    return after
  }
  function assertRawPrior(before, after, journalName) {
    assert.deepEqual(after.map(row => ({ ...row, rows: row.table === 'pgmigrations'
      ? row.rows.filter(raw => JSON.parse(raw).name !== journalName) : row.rows })), before,
    'Every old row_to_json::text byte string and old journal id/run_on must remain literal')
  }

  await assertJournal(manifest.slice(0, 89).map(row => row.name))
  const before89 = await fr018State(), before89Functions = await functionMetadata()
  const layout89 = Object.fromEntries(Object.keys(before89.snapshot.data).map(table => [table,
    before89.snapshot.schema.columns.filter(row => row.table_name === table).map(row => row.column_name)]))
  const raw89 = await rawTables(layout89)
  assert.equal(raw89.length, 108); emit('ADDITIONAL_RAW89_BEFORE', raw89)
  await migrate('up', 1763880000000); const first90 = await installed90(before89)
  assertRawPrior(raw89, await rawTables(layout89), OFFER)
  assert.deepEqual((await functionMetadata()).filter(row => row.proname !== 'offer_request_event_context_guard'), before89Functions)
  await repeat(1763880000000, 'first90')
  await migrate('down', OFFER, undefined, true)
  assert.deepEqual(prior90(await fr018State()), prior90(before89)); assert.deepEqual(await functionMetadata(), before89Functions)
  assert.deepEqual(await rawTables(), raw89)
  const beforeRe90 = await fr018State()
  await migrate('up', 1763880000000); await installed90(beforeRe90)
  assertRawPrior(raw89, await rawTables(layout89), OFFER)
  assert.deepEqual(first90.snapshot.schema.functions, (await fr018State()).snapshot.schema.functions)

  // A separate retained90 request is intentionally left through91. Its exact
  // down is selected directly; a populated91 down cannot mask the90 guard.
  async function ownFixture(label, tracked) {
    const own = Object.fromEntries(['owner', 'company', 'customerSession', 'performerSession', 'wedding', 'vendor', 'event', 'slot', 'deal', 'version'].map(key => [key, randomUUID()]))
    own.date = '2029-08-23'; own.timeZone = 'Europe/Moscow'; own.policy = 'synthetic-migration-91'
    await tx(async () => {
      for (const [person, session] of [[own.owner, own.customerSession], [own.company, own.performerSession]]) {
        await write("insert into users(id,phone,name) values($1,$2,'Synthetic additional migration actor')", [person, `+79${String(randomInt(0, 1_000_000_000)).padStart(9, '0')}`])
        await write('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [session, person, sha(randomUUID())])
        await write('insert into consents(id,user_id,policy_version) values($1,$2,$3)', [randomUUID(), person, own.policy])
      }
      await write("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Synthetic additional migration studio',now())", [own.vendor, own.company])
      await write("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,$3,'2029-08-22',$4,$5)", [own.wedding, own.owner, label, own.timeZone, randomUUID()])
      await write("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [own.wedding, own.owner])
      await write("insert into wedding_events(id,wedding_id,name,kind,date,time_zone,is_main) values($1,$2,'Synthetic additional day','second_day',$3,$4,false)", [own.event, own.wedding, own.date, own.timeZone])
      await write("insert into slots(id,wedding_id,program_event_id,category_id,label) values($1,$2,$3,'photo','Synthetic additional position')", [own.slot, own.wedding, own.event])
      if (tracked) {
        // Honest pretracking history first, before its first K/head exists.
        // No ledger/history deletion and no public booking claim.
        await write("insert into deals(id,wedding_id,slot_id,vendor_id,state,price) values($1,$2,$3,$4,'booked',17000)", [own.deal, own.wedding, own.slot, own.vendor])
        await write('update slots set deal_id=$2 where id=$1', [own.slot, own.deal])
        own.day = (await write("insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$3) returning id", [own.vendor, own.date, own.deal])).rows[0].id
      }
    })
    if (tracked) await tx(async () => {
      await write('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
      const fields = [own.version, own.wedding, own.deal, own.slot, 1, 'legacy_unknown', 'observe', 'explicit_event', own.event,
        'catalog', own.vendor, 'active', own.date, own.timeZone, own.day]
      await write(`insert into deal_day_scope_versions(${versionColumns.join(',')}) values(${fields.map((_, i) => '$' + (i + 1)).join(',')})`, fields)
      await write('insert into deal_day_scope_heads(deal_id,wedding_id,revision,current_version_id) values($1,$2,1,$3)', [own.deal, own.wedding, own.version])
    })
    return own
  }
  const quoteOwn = await ownFixture('Synthetic retained90 request', false), request = randomUUID()
  await write(`insert into offer_requests(id,slot_id,vendor_id,status,close_reason,closed_at,wedding_date,created_by,program_event_context)
    select $1,s.id,$2,'closed','removed',clock_timestamp(),e.date,$3,
      jsonb_build_object('id',e.id,'isMain',false,'date',e.date,'timeZone',e.time_zone,'name',e.name,'kind',e.kind,'location',e.location)
    from slots s join wedding_events e on e.id=s.program_event_id where s.id=$4`, [request, quoteOwn.vendor, quoteOwn.owner, quoteOwn.slot])
  const immutable90 = (await db.query('select row_to_json(r)::text raw from offer_requests r where id=$1', [request])).rows
  assert.equal(immutable90.length, 1)
  async function guarded90(label) {
    const before = await proof(), outcome = await migrate('down', OFFER, 'retain event-aware offer requests before downgrade', true)
    assert.deepEqual(nativeError(outcome.output), { message: 'retain event-aware offer requests before downgrade', code: '23514', severity: 'ERROR', constraint: null })
    assert.deepEqual(await proof(), before); emit('ADDITIONAL90_RETAINED_DOWN', { label, outcome, unchanged: true })
  }
  await guarded90('schema90-nonnull')
  const before90 = await proof()
  for (const [name, body] of oldBodies) {
    const old = before90.functions.filter(row => row.proname === name)
    assert.equal(old.length, 1); assert.equal(old[0].prosrc, body, `${name}: down restores literal applied89`)
  }

  async function installed91() {
    const after = await proof(), state = clone(after.state), schema = state.snapshot.schema
    assert.deepEqual(sorted(Object.keys(state.snapshot.data)), sorted([...Object.keys(before90.state.snapshot.data), ...TABLES]))
    for (const table of TABLES) { assert.deepEqual(state.snapshot.data[table], []); delete state.snapshot.data[table] }
    assertRawPrior(before90.raw, after.raw.filter(row => !TABLES.includes(row.table)), MOVE)
    withoutJournal(state, MOVE)
    const current = clone(before90.functions)
    for (const row of current) if (replacements.has(row.proname)) row.prosrc = replacements.get(row.proname)
    assert.deepEqual(after.functions.filter(row => !additions.has(row.proname)), current,
      'All prior function OID/signature/owner/ACL/config/volatility/security/flags remain; only three exact COR bodies change')
    assert.deepEqual(sorted(after.functions.filter(row => additions.has(row.proname)).map(row => row.proname)), sorted(additions.keys()))
    for (const row of after.functions.filter(row => additions.has(row.proname))) {
      assert.equal(row.prosrc, additions.get(row.proname)); assert.equal(row.proconfig, null)
      assert.equal(row.prosecdef, false); assert.equal(row.proleakproof, false)
    }
    for (const row of schema.functions) if (replacements.has(row.proname)) {
      const body = replacements.get(row.proname); assert.equal(row.definition.split(body).length, 2)
      row.definition = row.definition.replace(body, oldBodies.get(row.proname))
    }
    schema.functions = schema.functions.filter(row => !additions.has(row.proname))
    const complete = schema.triggers.filter(row => row.tgname === 'event_move_complete')
    assert.deepEqual(sorted(complete.map(row => row.table_name)), sorted(watchers))
    for (const row of complete) {
      assert(row.definition.includes('DEFERRABLE INITIALLY DEFERRED'))
      const events = /AFTER (.+?) ON /.exec(row.definition)
      assert(events); assert.deepEqual(events[1].split(' OR ').sort(), ['DELETE', 'INSERT', 'UPDATE'])
    }
    const triggerConstraints = schema.constraints.filter(row => row.conname === 'event_move_complete')
    assert.deepEqual(sorted(triggerConstraints.map(row => row.table_name)), sorted(watchers))
    assert(triggerConstraints.every(row => row.contype === 't' && row.condeferrable && row.condeferred))
    const ordinary = schema.triggers.filter(row => ordinaryTriggers.has(row.tgname))
    assert.equal(ordinary.length, 10); assert.deepEqual(sorted(ordinary.map(row => row.tgname)), sorted(ordinaryTriggers))
    const indexes = schema.indexes.filter(row => TABLES.includes(row.tablename))
    assert.equal(indexes.length, 9)
    const relations = new Set([...TABLES, ...indexes.map(row => row.indexname)])
    const types = new Set([...TABLES, ...TABLES.map(name => '_' + name)])
    const foreignTriggers = new Set((await db.query(`select t.oid::text from pg_trigger t join pg_constraint k on k.oid=t.tgconstraint
      where k.contype='f' and k.conrelid=any($1::regclass[])`, [TABLES])).rows.map(row => row.oid))
    assert.equal(foreignTriggers.size, 40)
    const predicates = { relations: row => relations.has(row.relname), columns: row => TABLES.includes(row.table_name),
      columnMetadata: row => relations.has(row.relname), constraints: row => TABLES.includes(row.table_name) || row.conname === 'event_move_complete',
      indexes: row => TABLES.includes(row.tablename), triggers: row => TABLES.includes(row.table_name) || ordinaryTriggers.has(row.tgname) || row.tgname === 'event_move_complete',
      types: row => types.has(row.typname) }
    for (const [key, predicate] of Object.entries(predicates)) schema[key] = schema[key].filter(row => !predicate(row))
    const oldOIDs = new Set(before90.state.objects.map(row => row.kind + ':' + row.oid))
    for (const row of state.objects.filter(row => !oldOIDs.has(row.kind + ':' + row.oid))) {
      const valid = row.kind === 'relation' ? relations.has(row.name) : row.kind === 'type' ? types.has(row.name)
        : row.kind === 'function' ? additions.has(row.name.split('(')[0].replace(/^public\./, ''))
          : row.kind === 'constraint' ? TABLES.includes(row.table_name) || (row.name === 'event_move_complete' && watchers.includes(row.table_name))
            : row.kind === 'trigger' && (TABLES.includes(row.table_name) || ordinaryTriggers.has(row.name.split('.').at(-1))
              || (row.name.endsWith('.event_move_complete') && watchers.includes(row.table_name)) || foreignTriggers.has(row.oid))
      assert(valid, 'Unexpected91 native catalog object ' + JSON.stringify(row))
    }
    state.objects = state.objects.filter(row => oldOIDs.has(row.kind + ':' + row.oid))
    state.attributes = state.attributes.filter(row => !relations.has(row.table_name))
    assert.deepEqual(state, before90.state, 'Only the closed91 objects/body changes and one journal row may differ; all prior rows/OIDs/catalog remain')
    emit('ADDITIONAL91_PRESERVING_UP', { functions: after.functions, raw: after.raw, replacements: COR, watchers, noBackfill: true })
    return after
  }
  await migrate('up', 1763890000000); await installed91(); await repeat(1763890000000, 'first91')
  await guarded90('schema91-nonnull-exact90')
  await migrate('down', MOVE, undefined, true)
  assert.deepEqual(await proof(), before90, 'Empty91 down restores every90 row, all three COR bodies, their OIDs and every old catalog field')
  await migrate('up', 1763890000000); await installed91(); await repeat(1763890000000, 'reup91')

  // Complete the literal91 empty down/re-up above before the forward92 COR.
  // The92 cycle adds no table/trigger/attribute; only one exact body and its
  // journal row may differ, including full native function OID/metadata.
  const before91Fix = await proof()
  async function installed92() {
    const after = await proof(), expected = clone(before91Fix)
    assertRawPrior(before91Fix.raw, after.raw, FIX)
    const journal = after.state.snapshot.data.pgmigrations.filter(row => row.name === FIX)
    assert.equal(journal.length, 1)
    expected.state.snapshot.data.pgmigrations = after.state.snapshot.data.pgmigrations
    expected.raw.find(row => row.table === 'pgmigrations').rows = after.raw.find(row => row.table === 'pgmigrations').rows
    const functions = expected.functions.filter(row => row.proname === fixUp[0].name)
    assert.equal(functions.length, 1); assert.equal(functions[0].prosrc, fixDown[0].body)
    functions[0].prosrc = fixUp[0].body
    const definitions = expected.state.snapshot.schema.functions.filter(row => row.proname === fixUp[0].name)
    assert.equal(definitions.length, 1); assert.equal(definitions[0].definition.split(fixDown[0].body).length, 2)
    definitions[0].definition = definitions[0].definition.replace(fixDown[0].body, () => fixUp[0].body)
    assert.deepEqual(after, expected, '92 changes only the one admitted function body and journal; all old raw/OID/catalog/flags remain exact')
    emit('ADDITIONAL92_PRESERVING_COR', { functions: after.functions, raw: after.raw, changedFunction: fixUp[0].name,
      sourceSHA256: FIX_SHA, noDataChange: true, noNewObjects: true })
    return after
  }
  await migrate('up', 1763900000000); await installed92(); await repeat(1763900000000, 'first92')
  await migrate('down', FIX, undefined, true)
  assert.deepEqual(await proof(), before91Fix, 'Empty92 down restores literal applied91 body plus all OIDs/data/metadata')
  await migrate('up', 1763900000000); await installed92(); await repeat(1763900000000, 'reup92')

  const flags = async () => (await db.query(`select
    exists(select 1 from event_move_proposals) proposals,exists(select 1 from event_move_roots) roots,
    exists(select 1 from event_move_receipts) receipts,exists(select 1 from event_move_effects) effects,
    exists(select 1 from audit_log where left(action,11)='event_move.') move_audit,
    exists(select 1 from audit_log where action='legacy_day.resolved' and diff->>'reason'='event_move') resolution_audit`)).rows[0]
  const vector = value => Object.values(value)
  assert.deepEqual(vector(await flags()), [false, false, false, false, false, false])
  // Explicit Root-authorized native audit-predicate control. The sentinel is
  // uncommitted synthetic history, not a business apply/resolution audit. Import
  // only the closed pinned module; collect its real down statements unchanged.
  // A savepoint recovers from its actual native guard, then outer ROLLBACK
  // removes only our uncommitted INSERT, without DELETE or old-audit mutation.
  seal()
  const nativeDownCases = []
  for (const item of [{ name: MOVE, digest: MOVE_SHA, statements: 48, constraint: 'event_move_preserving_down' },
    { name: FIX, digest: FIX_SHA, statements: 1, constraint: 'event_move_snapshot_fix_preserving_down' }]) {
    const migrationModule = await import(pathToFileURL(resolve(migrationsDir, item.name + '.cjs')).href)
    seal()
    const down = migrationModule.default?.down ?? migrationModule.down
    assert.equal(typeof down, 'function')
    const statements = []
    down({ sql: sql => { assert.equal(typeof sql, 'string'); statements.push(sql) } })
    assert.equal(statements.length, item.statements, 'Exact admitted module emits its unchanged full down sequence')
    nativeDownCases.push({ ...item, sql: statements })
  }
  const predicateBefore = await proof(), sentinel = randomUUID()
  let sentinelRaw
  await write('begin')
  try {
    await write(`insert into audit_log(action,entity,entity_id,diff) values('legacy_day.resolved','deal',$1,
      '{"reason":"event_move","syntheticNativeAuditPredicateControl":true}'::jsonb)`, [sentinel])
    assert.deepEqual(vector(await flags()), [false, false, false, false, false, true])
    sentinelRaw = (await db.query('select row_to_json(a)::text raw from audit_log a where entity_id=$1', [sentinel])).rows
    assert.equal(sentinelRaw.length, 1)
    for (const item of nativeDownCases) {
      await write('savepoint additional91_native_guard')
      let predicateError
      try { for (const sql of item.sql) await write(sql) } catch (error) { predicateError = error }
      assert(predicateError, 'The exact admitted down must refuse its otherwise-isolated native audit clause')
      assert.equal(predicateError.code, '23514'); assert.equal(predicateError.constraint, item.constraint)
      assert.equal(predicateError.message, downMessage)
      await db.query('rollback to savepoint additional91_native_guard')
      await write('release savepoint additional91_native_guard')
      assert.deepEqual((await db.query('select row_to_json(a)::text raw from audit_log a where entity_id=$1', [sentinel])).rows, sentinelRaw)
      assert.deepEqual(vector(await flags()), [false, false, false, false, false, true])
      const during = await proof(), expected = clone(predicateBefore)
      expected.raw.find(row => row.table === 'audit_log').rows.push(sentinelRaw[0].raw)
      expected.raw.find(row => row.table === 'audit_log').rows.sort()
      expected.state.snapshot.data.audit_log = during.state.snapshot.data.audit_log
      assert.deepEqual(during, expected, 'Savepoint recovery restores all DDL/metadata and leaves only the exact own uncommitted audit INSERT')
      emit('ADDITIONAL_SYNTHETIC_NATIVE_AUDIT_PREDICATE', { name: item.name, sourceSHA256: item.digest,
        statementCount: item.sql.length, statementsSHA256: sha(JSON.stringify(item.sql)), sentinelRaw,
        error: { code: predicateError.code, constraint: predicateError.constraint, message: predicateError.message },
        exactDownBody: true, savepointRollbackObserved: true, committedSentinel: false, businessResolutionAudit: false })
    }
  } finally { await db.query('rollback') }
  assert.deepEqual(await proof(), predicateBefore, 'Outer rollback preserves all prior audit/catalog/data byte strings')
  emit('ADDITIONAL_SYNTHETIC_NATIVE_AUDIT_OUTER_ROLLBACK', { names: nativeDownCases.map(row => row.name),
    outerRollbackObserved: true, oldRawExact: true, committedSentinel: false, businessResolutionAudit: false })
  async function guarded91(label, expected) {
    const before = await proof(); assert.deepEqual(vector(await flags()), expected)
    const outcome = await migrate('down', MOVE, downMessage, true)
    assert.deepEqual(nativeError(outcome.output), { message: downMessage, code: '23514', severity: 'ERROR', constraint: 'event_move_preserving_down' })
    assert.deepEqual(await proof(), before); assert.deepEqual(vector(await flags()), expected)
    emit('ADDITIONAL91_RETAINED_DOWN', { label, expected, outcome, raw: before.raw, unchanged: true })
  }
  async function guarded92(label, expected) {
    const before = await proof(); assert.deepEqual(vector(await flags()), expected)
    const outcome = await migrate('down', FIX, downMessage, true)
    assert.deepEqual(nativeError(outcome.output), { message: downMessage, code: '23514', severity: 'ERROR', constraint: 'event_move_snapshot_fix_preserving_down' })
    assert.deepEqual(await proof(), before); assert.deepEqual(vector(await flags()), expected)
    emit('ADDITIONAL92_RETAINED_DOWN', { label, expected, outcome, raw: before.raw, unchanged: true })
  }
  async function proposal(own, client, mode) {
    const id = randomUUID(), target = { date: '2029-08-24', timeZone: own.timeZone, location: 'Synthetic proposed location' }
    const baseline = (await client.query('select event_move_source_snapshot($1,$2) material', [own.wedding, own.event])).rows[0].material
    assert.equal((await client.query('select event_move_scope_supported($1::jsonb) ok', [JSON.stringify(baseline)])).rows[0].ok, true)
    const row = (await client.query(`insert into event_move_proposals(id,wedding_id,event_id,baseline,target,canonical_payload,digest,created_by,session_id,policy_version)
      select $1,$2,$3,$4::jsonb,$5::jsonb,payload,encode(sha256(convert_to(payload,'UTF8')),'hex'),$6,$7,$8
      from (select jsonb_build_object('baseline',$4::jsonb,'target',$5::jsonb)::text payload) exact returning id,digest`,
    [id, own.wedding, own.event, JSON.stringify(baseline), JSON.stringify(target), own.owner, own.customerSession, own.policy])).rows[0]
    if (mode > 0) await client.query(`insert into event_move_roots(wedding_id,proposal_id,deal_id,vendor_id,material,canonical_payload,digest)
      select $1,$2,$3,$4,m,m::text,encode(sha256(convert_to(m::text,'UTF8')),'hex')
      from (select event_move_root_material($5::jsonb,$6::jsonb,$2,$3) m) exact`,
    [own.wedding, id, own.deal, own.vendor, JSON.stringify(baseline), JSON.stringify(target)])
    if (mode > 1) for (const [party, person, session] of [['customer', own.owner, own.customerSession], ['performer', own.company, own.performerSession]]) {
      await client.query(`insert into event_move_receipts(id,wedding_id,proposal_id,deal_id,party,user_id,session_id,policy_version,digest,read_proof_hash)
        select $1,$2,$3,$4,$5,$6,$7,$8,r.digest,$9 from event_move_roots r where r.proposal_id=$3 and r.deal_id=$4`,
      [randomUUID(), own.wedding, id, own.deal, party, person, session, own.policy, sha('synthetic-native-storage-proof')])
    }
    if (mode > 2) await client.query(`insert into event_move_effects(id,wedding_id,event_id,proposal_id,action,digest,actor_id,session_id,policy_version,planned_versions)
      values($1,$2,$3,$4,'cancel',$5,$6,$7,$8,'[]')`, [randomUUID(), own.wedding, own.event, id, row.digest, own.owner, own.customerSession, own.policy])
    if (mode > 0) assert.equal((await client.query('select event_move_root_set_complete($1) complete', [id])).rows[0].complete, true,
      'A proposal intended for COMMIT must contain its full actual root set')
    return row
  }
  async function eraseOwnParents(own, before, retainedAudit = []) {
    await tx(async () => {
      await write('select legacy_day_lock_vendors($1::uuid[])', [[own.vendor]])
      assert.equal((await write('delete from weddings where id=$1 returning id', [own.wedding])).rowCount, 1)
      assert.equal((await write('delete from vendors where id=$1 returning id', [own.vendor])).rowCount, 1)
      assert.equal((await write('delete from users where id=any($1::uuid[]) returning id', [[own.owner, own.company]])).rowCount, 2)
    })
    const after = await proof(), expected = clone(before)
    expected.raw.find(row => row.table === 'audit_log').rows.push(...retainedAudit)
    expected.raw.find(row => row.table === 'audit_log').rows.sort()
    if (retainedAudit.length) expected.state.snapshot.data.audit_log = after.state.snapshot.data.audit_log
    assert.deepEqual(after, expected, 'Own parent erasure preserves every prior raw row/catalog; only explicitly retained audit may remain')
    emit('ADDITIONAL91_OWN_PARENT_ERASURE', { own, retainedAudit, raw: after.raw })
  }
  // Three complete committed stages cover all four tables. Root/receipt/effect
  // require their proposal parent; these are not independent one-hot clauses.
  for (let mode = 1; mode < 4; mode++) {
    const before = await proof(), own = await ownFixture(`Synthetic move storage stage ${mode}`, true)
    await tx(() => proposal(own, db, mode))
    await guarded91(['proposal-plus-root', 'proposal-root-receipts', 'proposal-root-receipts-cancel-effect'][mode - 1],
      [true, true, mode > 1, mode > 2, false, false])
    await guarded92(['proposal-plus-root', 'proposal-root-receipts', 'proposal-root-receipts-cancel-effect'][mode - 1],
      [true, true, mode > 1, mode > 2, false, false])
    await eraseOwnParents(own, before)
    assert.deepEqual(vector(await flags()), [false, false, false, false, false, false])
  }

  // A genuine pending INSERT owns RowExclusiveLock on the first92 evidence
  // table. The native CLI must wait at AX before reading ANY history, reach
  // its actual 5s lock_timeout, close naturally, then allow writer COMMIT.
  const concurrentBase = await proof(), concurrentOwn = await ownFixture('Synthetic92 concurrent writer', true)
  const beforeConcurrent = await proof(), writer = new pg.Client({ connectionString: databaseUrl, statement_timeout: 20_000, connectionTimeoutMillis: 5000 })
  let writerPID, writerProposal, writerRootRaw, child, childClosed, closed = false, exit, witness, primaryError, hasPrimaryError = false
  const streams = { stdout: { chunks: [], eof: false }, stderr: { chunks: [], eof: false } }, errors = [], cleanup = []
  let bytes = 0, overflow = false
  const tag = `additional92-down-${randomUUID()}`
  const receipt = { owner: 'additional92-preserving-drill', parentPID: process.pid, pid: null, exe: process.execPath,
    cwd: backend, startedAt: null, ports: [], windowsHidden: true, forced: false }
  try {
    writer.on('error', error => errors.push({ source: 'writer', message: error.message }))
    await writer.connect(); writerPID = await registerOwnedConnection(writer); await writer.query('begin')
    writerProposal = await proposal(concurrentOwn, writer, 0)
    const args = [cli, 'down', FIX, '-m', migrationsDir, '--schema', 'public', '--migrations-table', 'pgmigrations', '--single-transaction', '--verbose', 'false']
    child = spawn(process.execPath, args, { cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PGAPPNAME: tag, TILI_DISPOSABLE_PG_PORT: selectedPort, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl } })
    receipt.pid = child.pid ?? null; receipt.startedAt = new Date().toISOString(); receipt.args = args
    emit('ADDITIONAL92_NATIVE_STARTED', receipt)
    childClosed = new Promise(resolveClose => {
      child.on('error', error => errors.push({ source: 'process', message: error.message }))
      child.on('exit', (code, signal) => { exit = { code, signal } })
      for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
        stream.on('data', chunk => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) overflow = true; else streams[name].chunks.push(chunk) })
        stream.on('end', () => { streams[name].eof = true }); stream.on('error', error => errors.push({ source: name, message: error.message }))
      }
      child.on('close', () => { closed = true; resolveClose() })
    })
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline && !closed && !witness) {
      const waiters = (await db.query(`select a.pid,a.application_name,a.usename,a.datname,a.state,a.query,a.wait_event_type,a.wait_event,
        pg_blocking_pids(a.pid) blockers,l.mode,l.granted,l.relation::regclass::text relation
        from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.datname=current_database() and a.application_name=$1
          and l.relation='public.event_move_proposals'::regclass and l.mode='AccessExclusiveLock' and not l.granted`, [tag])).rows
      if (waiters.length) { assert.equal(waiters.length, 1); witness = waiters[0] }
      else await new Promise(resolveTick => setTimeout(resolveTick, 25))
    }
    assert(witness && witness.blockers.includes(writerPID) && witness.wait_event_type === 'Lock')
    assert(/lock table event_move_proposals,event_move_roots,event_move_receipts,event_move_effects/.test(witness.query))
    const outcome = await bounded(childClosed, Math.max(1, deadline - performance.now()))
    assert(!outcome.timedOut && closed); assert(exit && exit.code !== 0 && exit.signal === null)
    assert(!overflow && streams.stdout.eof && streams.stderr.eof); assert.deepEqual(errors, [])
    const stdout = Buffer.concat(streams.stdout.chunks).toString('utf8'), stderr = Buffer.concat(streams.stderr.chunks).toString('utf8')
    assert.deepEqual([...stdout.matchAll(/^> - (.+)$/gm)].map(row => row[1].trim()), [FIX])
    assert.deepEqual(nativeError(stderr), { message: 'canceling statement due to lock timeout', code: '55P03', severity: 'ERROR', constraint: null })
    emit('ADDITIONAL92_NATIVE_AX_WAIT', { receipt, writerPID, witness, stdout, stderr, exit, forced: false })
    // The proposal-only prefix above is deliberately uncommitted while it
    // holds RowExclusive. Complete that same proposal from its stored source
    // before COMMIT; deferred completeness is never disabled or bypassed.
    const roots = (await writer.query(`insert into event_move_roots(wedding_id,proposal_id,deal_id,vendor_id,material,canonical_payload,digest)
      select p.wedding_id,p.id,$2,$3,m.material,m.material::text,encode(sha256(convert_to(m.material::text,'UTF8')),'hex')
      from event_move_proposals p cross join lateral (
        select event_move_root_material(p.baseline,p.target,p.id,$2::uuid) material) m
      where p.id=$1 and p.wedding_id=$4 and p.event_id=$5
      returning wedding_id,proposal_id,deal_id,vendor_id`,
    [writerProposal.id, concurrentOwn.deal, concurrentOwn.vendor, concurrentOwn.wedding, concurrentOwn.event])).rows
    assert.deepEqual(roots, [{ wedding_id: concurrentOwn.wedding, proposal_id: writerProposal.id,
      deal_id: concurrentOwn.deal, vendor_id: concurrentOwn.vendor }])
    const storedRoot = (await writer.query('select row_to_json(r)::text raw from event_move_roots r where proposal_id=$1 and deal_id=$2',
      [writerProposal.id, concurrentOwn.deal])).rows
    assert.equal(storedRoot.length, 1); writerRootRaw = storedRoot[0].raw
    assert.equal((await writer.query('select event_move_root_set_complete($1) complete', [writerProposal.id])).rows[0].complete, true)
    emit('ADDITIONAL92_NATIVE_WRITER_COMPLETE', { writerPID, proposalId: writerProposal.id, root: roots[0],
      rootRaw: writerRootRaw, rootSetComplete: true, sameTransaction: true })
    await writer.query('commit')
  } catch (error) { primaryError = error; hasPrimaryError = true }
  finally {
    try { if (writerPID) await writer.query('rollback') } catch (error) { cleanup.push(error) }
    try { const ended = await bounded(writer.end(), 5000); assert(!ended.timedOut, 'Writer close deadline; Root owns the recorded PID')
      if (writerPID) ownedPids.delete(writerPID) } catch (error) { cleanup.push(error) }
    if (child && !closed) { const ended = await bounded(childClosed, 7000); if (ended.timedOut) cleanup.push(new Error(`Native child remains; Root owns exact PID ${receipt.pid}`)) }
    const rawStreams = Object.fromEntries(Object.entries(streams).map(([name, value]) => { const raw = Buffer.concat(value.chunks)
      return [name, { bytes: raw.length, sha256: sha(raw), eof: value.eof, raw: raw.toString('utf8') }] }))
    emit('ADDITIONAL92_NATIVE_CLOSED', { receipt, endedAt: new Date().toISOString(), closed, exit, streams: rawStreams, overflow, errors,
      primaryError: primaryError?.message ?? null, cleanupErrors: cleanup.map(error => error.message), mayRemain: !closed })
  }
  if (cleanup.length) throw new AggregateError([...(primaryError ? [primaryError] : []), ...cleanup], 'Additional91 owned cleanup failed; no process was killed')
  if (hasPrimaryError) throw primaryError
  const afterConcurrent = await proof(), expectedConcurrent = clone(beforeConcurrent)
  const proposalRows = afterConcurrent.raw.find(row => row.table === TABLES[0]).rows
  assert.equal(proposalRows.length, 1); assert.equal(JSON.parse(proposalRows[0]).id, writerProposal.id)
  const rootRows = afterConcurrent.raw.find(row => row.table === TABLES[1]).rows
  assert.deepEqual(rootRows, [writerRootRaw], 'The exact same-transaction root row survives writer COMMIT')
  expectedConcurrent.raw.find(row => row.table === TABLES[0]).rows = proposalRows
  expectedConcurrent.raw.find(row => row.table === TABLES[1]).rows = rootRows
  expectedConcurrent.state.snapshot.data[TABLES[0]] = afterConcurrent.state.snapshot.data[TABLES[0]]
  expectedConcurrent.state.snapshot.data[TABLES[1]] = afterConcurrent.state.snapshot.data[TABLES[1]]
  assert.deepEqual(afterConcurrent, expectedConcurrent, 'Native down timeout changes nothing; writer commits only its complete proposal and exact own root')
  await guarded91('concurrent-writer-committed-proposal-root', [true, true, false, false, false, false])
  await guarded92('concurrent-writer-committed-proposal-root', [true, true, false, false, false, false])
  await eraseOwnParents(concurrentOwn, concurrentBase)

  // Final audit-only control uses the actual application cancellation model,
  // not a fabricated event_move success audit. No HTTP/human consent claim.
  const auditBase = await proof(), auditOwn = await ownFixture('Synthetic91 actual cancellation audit', true)
  const auditProposal = await tx(() => proposal(auditOwn, db, 1))
  const nativeTarget = (await db.query(`select current_database() name,d.oid::text oid,pg_get_userbyid(d.datdba) owner
    from pg_database d where d.datname=current_database()`)).rows[0]
  await write('select 1')
  const childSource = `
    import assert from 'node:assert/strict'; import pg from 'pg';
    import {lockMoveCustomer,cancelEventMove} from './src/orders/event-moves.ts';
    const expected=${JSON.stringify({ database: decodeURIComponent(new URL(databaseUrl).pathname.slice(1)), port: selectedPort, oid: nativeTarget.oid,
      weddingId: auditOwn.wedding, eventId: auditOwn.event, proposal: auditProposal, actor: { userId: auditOwn.owner, sessionId: auditOwn.customerSession, policyVersion: auditOwn.policy } })};
    const url=new URL(process.env.DATABASE_URL); assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname));
    assert.equal(url.port,expected.port); assert.equal(url.username,'codex_test'); assert.equal(url.password,''); assert.equal(url.search,''); assert.equal(url.hash,'');
    assert.equal(decodeURIComponent(url.pathname.slice(1)),expected.database); assert.equal(new URL(process.env.TEST_DATABASE_URL).href,url.href);
    assert(!process.env.NODE_OPTIONS&&!process.env.PGOPTIONS); const client=new pg.Client({connectionString:url.href,statement_timeout:20000,connectionTimeoutMillis:5000});
    await client.connect(); try { const i=(await client.query("select current_database() name,current_user principal,inet_server_port() port,host(inet_server_addr()) address,d.oid::text oid,pg_get_userbyid(d.datdba) owner from pg_database d where d.datname=current_database()")).rows[0];
      assert.equal(i.name,expected.database); assert.equal(i.oid,expected.oid); assert.equal(i.principal,'codex_test'); assert.equal(i.owner,'codex_test');
      assert.equal(i.port,Number(expected.port)); assert(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(i.address));
      await client.query('begin'); await lockMoveCustomer(client,expected); const result=await cancelEventMove(client,expected,expected.proposal.id,expected.proposal.digest);
      assert.equal(result.status,'cancelled'); await client.query('commit');
      console.log('ADDITIONAL91_ACTUAL_CANCEL '+JSON.stringify({proposalId:expected.proposal.id,committed:true,applicationModel:true}));
    } catch(error) { await client.query('rollback'); throw error; } finally { await client.end(); }
  `
  const childArgs = ['--import', 'tsx', '--input-type=module', '-e', childSource]
  const cancelChild = spawn(process.execPath, childArgs, { cwd: backend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl, TILI_DISPOSABLE_PG_PORT: selectedPort } })
  const cancelReceipt = { owner: 'additional91-actual-cancel', parentPID: process.pid, pid: cancelChild.pid ?? null,
    exe: process.execPath, cwd: backend, args: childArgs, startedAt: new Date().toISOString(), ports: [], windowsHidden: true, forced: false }
  emit('ADDITIONAL91_CANCEL_STARTED', cancelReceipt)
  const cancelStreams = { stdout: [], stderr: [] }, cancelErrors = []
  const cancelEOF = { stdout: false, stderr: false }; let cancelBytes = 0, cancelOverflow = false, cancelExit, cancelClosed = false
  const cancelDone = new Promise(resolveClose => {
    cancelChild.on('error', error => cancelErrors.push(error.message)); cancelChild.on('exit', (code, signal) => { cancelExit = { code, signal } })
    for (const [name, stream] of [['stdout', cancelChild.stdout], ['stderr', cancelChild.stderr]]) {
      stream.on('data', chunk => { cancelBytes += chunk.length; if (cancelBytes > 4 * 1024 * 1024) cancelOverflow = true; else cancelStreams[name].push(chunk) })
      stream.on('end', () => { cancelEOF[name] = true }); stream.on('error', error => cancelErrors.push(error.message))
    }
    cancelChild.on('close', () => { cancelClosed = true; resolveClose() })
  })
  const cancelled = await bounded(cancelDone, 30_000)
  const cancelRaw = Object.fromEntries(Object.entries(cancelStreams).map(([name, chunks]) => { const raw = Buffer.concat(chunks)
    return [name, { raw: raw.toString('utf8'), bytes: raw.length, sha256: sha(raw), eof: cancelEOF[name] }] }))
  emit('ADDITIONAL91_CANCEL_CLOSED', { cancelReceipt, cancelExit, cancelClosed, cancelOverflow, cancelErrors, streams: cancelRaw, mayRemain: !cancelClosed })
  assert(!cancelled.timedOut && cancelClosed && !cancelOverflow && cancelEOF.stdout && cancelEOF.stderr,
    'Cancellation child must close naturally; Root owns any exact PID reported as mayRemain')
  assert.deepEqual(cancelExit, { code: 0, signal: null }); assert.deepEqual(cancelErrors, [])
  const lines = cancelRaw.stdout.raw.split(/\r?\n/).filter(line => line.startsWith('ADDITIONAL91_ACTUAL_CANCEL '))
  assert.equal(lines.length, 1); assert.deepEqual(JSON.parse(lines[0].slice('ADDITIONAL91_ACTUAL_CANCEL '.length)),
    { proposalId: auditProposal.id, committed: true, applicationModel: true })
  const ownAudit = (await db.query("select row_to_json(a)::text raw from audit_log a where action='event_move.cancelled' and entity_id=$1", [auditProposal.id])).rows.map(row => row.raw)
  assert.equal(ownAudit.length, 1)
  const auditValue = JSON.parse(ownAudit[0]); assert.equal(auditValue.actor_id, auditOwn.owner); assert.equal(auditValue.entity, 'event_move')
  assert.deepEqual(auditValue.diff, { weddingId: auditOwn.wedding, eventId: auditOwn.event })
  await eraseOwnParents(auditOwn, auditBase, ownAudit)
  await guarded91('actual-cancel-retained-audit-only-after-parent-erasure', [false, false, false, false, true, false])
  await guarded92('actual-cancel-retained-audit-only-after-parent-erasure', [false, false, false, false, true, false])
  await guarded90('final92-after-audit-only')
  assert.deepEqual((await db.query('select row_to_json(r)::text raw from offer_requests r where id=$1', [request])).rows, immutable90)
  await repeat(1763900000000, 'retained90-and-audit92'); await assertJournal(manifest.map(row => row.name)); seal()
  emit('ADDITIONAL_EVENT_MIGRATION_DRILL_PASSED', { schema: 92, oldRawTables: 108, addedTables: 4, watchers: 46,
    empty90Down: 1, empty91Down: 1, retained90Refusals: 3, native92LockTimeout: 1, native91HistoryRefusals: 5,
    committedTableStages: 3, tableStagesParentMasked: true, auditOnlyFromActualCancellation: true, retainedRequest: request, retainedAudit: ownAudit,
    empty92Down: 1, native92HistoryRefusals: 5, syntheticNativeAuditPredicateGuards: 2,
    helperSHA256: helperSHA, migration90SHA256: OFFER_SHA, migration91SHA256: MOVE_SHA, migration92SHA256: FIX_SHA,
    financialPolicyChanged: false, publicWriterAcceptance: false, realHumanAgreement: false,
    syntheticResolutionAuditPredicate: true, businessResolutionAuditObserved: false, runtimeSequenceValuesNotCompared: true })
}
