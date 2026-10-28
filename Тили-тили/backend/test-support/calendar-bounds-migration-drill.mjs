// Migration preservation, never positive calendar consent/public acceptance.
// Root owns execution; no child processes, new connections, fixtures or cleanup.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = '1763920000000_legacy_calendar_bounds', STAMP = 1763920000000, PRIOR = 1763910000000
const PIN = '023ffcd77a29a94aef26974b5686adbdf53bb63b515684b6e2dc21391349b697'
const OLD_DATE_NAME = '1763870000000_deal_day_scope_atomic'
const OLD_DATE_PIN = 'fc8e1ae6e6d62debffe622d36e17defbb4c50120db44c161ab6228264c6644df'
// Canonical native frame/default metadata from Root readback60C391FD; OIDs/owner stay instance-specific.
const DATE_COR_SPEC = [
  { name: 'legacy_day_lock_vendors', signature: 'legacy_day_lock_vendors(uuid[])', arguments: 'vendors uuid[]', result: 'void',
    oldSHA: '139a702febcdae5f36c312256a143072b71898132a54da49d19cf9b321601953',
    newSHA: '3c189462dc82229d96b0f0dcbc2854926c646850111ce79bd424b8f9bdfe6efb' },
  { name: 'legacy_day_discover_new', signature: 'legacy_day_discover_new()', arguments: '', result: 'trigger',
    oldSHA: '9a1533f741ad2a222de7e8897ad7f46733427f484a19503ea0cbe3589ad9e80f',
    newSHA: '2f05747d8be766fb7f4f2069f54f67108f5035210dd557fd7d4589c6ff119d7f' },
]
const DATE_COR_METADATA = { provolatile: 'v', prosecdef: false, proleakproof: false, proisstrict: false,
  proretset: false, proparallel: 'u', proconfig: null, prokind: 'f', procost: 100, prorows: 0,
  support: '-', lanname: 'plpgsql', proacl: null, comment: null }
function once(text, oldText, newText) {
  assert.equal(text.split(oldText).length, 2, 'Exact unique admitted DATE body transform')
  return text.replace(oldText, newText)
}
function dateCorrections(source, up, oldSource) {
  const expected = DATE_COR_SPEC.map(spec => {
    const start = '    create function ' + spec.name + '(' + spec.arguments + ') returns ' + spec.result + ' language plpgsql as $$'
    const chunks = oldSource.split(start); assert.equal(chunks.length, 2)
    const end = chunks[1].indexOf('$$;'); assert(end >= 0)
    const oldProsrc = chunks[1].slice(0, end); assert.equal(sha(oldProsrc), spec.oldSHA)
    let newProsrc
    if (spec.name === 'legacy_day_lock_vendors') {
      newProsrc = once(oldProsrc, '      if new_keys is null then return; end if;',
        '      if new_keys is null then\n        perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);\n        return;\n      end if;')
      const loop = '      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;'
      newProsrc = once(newProsrc, loop, loop + '\n      perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);')
    } else newProsrc = once(oldProsrc, 'not legacy_day_vendor_locked(NEW.vendor_id)',
      'not public.legacy_calendar_bounds_discovery_locked(NEW.vendor_id)')
    assert.equal(sha(newProsrc), spec.newSHA)
    const definition = body => 'CREATE OR REPLACE FUNCTION public.' + spec.name + '(' + spec.arguments + ')\n RETURNS '
      + spec.result + '\n LANGUAGE plpgsql\nAS $function$' + body + '$function$\n'
    return { signature: spec.signature, oldDefinition: definition(oldProsrc), oldProsrc,
      newDefinition: definition(newProsrc), newProsrc, metadata: { ...DATE_COR_METADATA, result: spec.result } }
  })
  const blocks = [...source.matchAll(/^const LEGACY_DAY_CORRECTIONS = ([^\r\n]+)\r?$/gm)]; assert.equal(blocks.length, 1)
  assert.deepEqual(JSON.parse(blocks[0][1]), expected, 'Only exact old87/native-frame/closed-transform COR2 admitted')
  assert(!/create or replace function/i.test(up.replace(blocks[0][0], '')), 'No other old-function COR is permitted')
  const calls = [...source.matchAll(/pgm\.sql\(legacyDayCorrectionSQL\((true|false), (true|false)\)\)/g)]
  assert.deepEqual(calls.map(x => [x[1], x[2]]), [['true','false'],['true','true'],['false','true']])
  assert(calls[0].index < up.indexOf('create table '))
  assert(up.indexOf('create function legacy_calendar_bounds_discovery_locked') < calls[1].index)
  const down = source.indexOf('exports.down = pgm =>')
  assert(down < calls[2].index && source.indexOf("constraint='legacy_calendar_bounds_preserving_down'", down) < calls[2].index)
  assert(calls[2].index < source.indexOf('drop function', down), 'Literal old2 restore precedes own59 drop')
  return expected
}
function expectedOldDateFunctions(before, corrections) {
  const functions = structuredClone(before.functions), schemaFunctions = structuredClone(before.state.snapshot.schema.functions)
  for (const [index, correction] of corrections.entries()) {
    const spec = DATE_COR_SPEC[index]
    const old = functions.filter(x => x.signature === correction.signature); assert.equal(old.length, 1)
    assert.equal(old[0].proname, spec.name); assert.equal(old[0].arguments, spec.arguments)
    assert.equal(old[0].prosrc, correction.oldProsrc)
    assert.deepEqual(Object.fromEntries(Object.keys(correction.metadata).map(key => [key, old[0][key]])), correction.metadata)
    const schema = schemaFunctions.filter(x => x.proname === spec.name && x.arguments === spec.arguments); assert.equal(schema.length, 1)
    assert.equal(schema[0].definition, correction.oldDefinition, 'Literal native old2 definition required before UP94')
    old[0].prosrc = correction.newProsrc
    schema[0].definition = correction.newDefinition
  }
  return { functions, schemaFunctions }
}
const MESSAGE = 'Bounds evidence exists; use preserving forward migration'
const OWN = ['legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans',
  'legacy_calendar_bounds_person_scope','legacy_calendar_bounds_receipts','legacy_calendar_resolution_events',
  'legacy_calendar_resolution_holders','legacy_calendar_bounds_heads','legacy_calendar_person_links',
  'resource_occupancy_origin_certificates','resource_occupancy','legacy_calendar_initial_commit_witnesses']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const HELPER = fileURLToPath(import.meta.url), HELPER_SHA = sha(readFileSync(HELPER))
const quote = value => '"' + value.replaceAll('"', '""') + '"'
const sorted = values => [...values].sort()
const emit = (name, value) => process.stdout.write(`${name} ${JSON.stringify(value)}\n`)
function nativeError(output) {
  const header = [...output.matchAll(/^error: ([^\r\n]+)\r?$/gm)].at(-1); assert(header, 'Actual final native Error required')
  const block = output.slice(header.index), properties = / \{\r?\n([\s\S]*)\r?\n\}\s*$/.exec(block)
  assert(properties && /\r?\n {4}at /.test(block.slice(0, properties.index)))
  const field = (name, pattern) => {
    const values = [...properties[1].matchAll(new RegExp(`^  ${name}: (${pattern}),?\\r?$`, 'gm'))]
    assert.equal(values.length, 1); return values[0][1]
  }
  return { message: header[1], code: field('code', "'[A-Z0-9]{5}'").slice(1, -1),
    severity: field('severity', "'[A-Z]+'").slice(1, -1), constraint: field('constraint', "'[^'\\r\\n]*'").slice(1, -1) }
}
function controls(c) {
  const { db, write, migrate, fr018State, assertJournal, manifest, migrationsDir } = c
  assert.equal(manifest.length, 94); assert.equal(manifest[93].name, NAME); assert.equal(manifest[93].digest, PIN)
  assert.equal(manifest[92].name, '1763910000000_additional_event_undated')
  assert.equal(manifest[92].digest, '4ff66e47b92954a8dca6d430925143727b99fc3fd54376feb24a4b96e6cc59d4')
  const helper = HELPER, helperSHA = HELPER_SHA, path = resolve(migrationsDir, NAME + '.cjs')
  const oldPath = resolve(migrationsDir, OLD_DATE_NAME + '.cjs'), oldEntry = manifest.filter(x => x.name === OLD_DATE_NAME)
  assert.equal(oldEntry.length, 1); assert.equal(oldEntry[0].digest, OLD_DATE_PIN)
  const seal = () => {
    assert.equal(sha(readFileSync(helper)), helperSHA, '94 helper source changed')
    assert(lstatSync(oldPath).isFile() && !lstatSync(oldPath).isSymbolicLink())
    assert.equal(sha(readFileSync(oldPath)), OLD_DATE_PIN, 'Applied old87 source cannot change')
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()); const bytes = readFileSync(path)
    assert.equal(sha(bytes), PIN); return bytes.toString('utf8').replaceAll('\r\n', '\n')
  }
  const source = seal(), up = source.split('exports.down = pgm =>')[0]
  assert.equal(source.split('exports.down = pgm =>').length, 2)
  assert.deepEqual([...up.matchAll(/create table (\w+)\(/g)].map(x => x[1]), OWN)
  const corrections = dateCorrections(source, up, readFileSync(oldPath, 'utf8').replaceAll('\r\n', '\n'))
  const functions = [...up.matchAll(/create function (\w+)\([^]*?\bas \$\$([^]*?)\$\$;/g)].map(x => ({ name: x[1], body: x[2] }))
  assert.equal(functions.length, 59); assert.equal(new Set(functions.map(x => x.name)).size, 59)
  const signatureBlock = /const OWN_FUNCTIONS = \[([^]*?)\n\]/.exec(source); assert(signatureBlock)
  const signatures = [...signatureBlock[1].matchAll(/'([^']+)'/g)].map(x => x[1]); assert.equal(signatures.length, 59)
  const watcherBlock = /for \(const table of \[([^\]]*)\]\) \{\s*pgm\.sql\(`create constraint trigger check_legacy_calendar_bounds_complete/.exec(up); assert(watcherBlock)
  const watchers = [...watcherBlock[1].matchAll(/'([^']+)'/g)].map(x => x[1]); assert.equal(watchers.length, 50); assert.equal(new Set(watchers).size, 50)
  const pairs = new Map(), add = (table, trigger, fn) => { const key = `${table}.${trigger}`; assert(!pairs.has(key)); pairs.set(key, fn) }
  for (const table of OWN.filter(x => !['legacy_calendar_person_links','resource_occupancy_origin_certificates','resource_occupancy'].includes(x)))
    add(table, 'protect_' + table, 'protect_legacy_calendar_bounds_history')
  for (const [table, trigger, fn] of [
    ['vendor_busy_dates','aaa_legacy_calendar_bounds_date','legacy_calendar_bounds_date_prefix'],
    ['deals','aaa_legacy_calendar_bounds_financial','legacy_calendar_bounds_financial_prefix'],
    ['legacy_calendar_person_links','protect_legacy_calendar_person_link','protect_legacy_calendar_person_link'],
    ['resource_occupancy_origin_certificates','protect_legacy_calendar_bounds_certificate','protect_legacy_calendar_bounds_certificate'],
    ['resource_occupancy','guard_resource_occupancy_origin','protect_resource_occupancy_origin'],
    ['resource_allocations','aaa_legacy_calendar_bounds_allocation','legacy_calendar_bounds_allocation_prefix'],
    ['resource_allocations','maintain_resource_occupancy_mirror','maintain_resource_occupancy_mirror'],
    ['deals','legacy_calendar_bounds_cancel_trace','legacy_calendar_bounds_cancel_trace']]) add(table, trigger, fn)
  for (const table of ['vendors','vendor_staff_members','vendor_resources','vendor_staff_duties']) add(table, 'aaa_legacy_calendar_bounds_association', 'legacy_calendar_bounds_association_prefix')
  for (const table of ['offer_requests','deals','slots','deal_orders','vendor_staff_members','vendor_resources','resource_capacity_windows','resource_allocations','legacy_calendar_sources','vendor_busy_dates'])
    add(table, 'aaa_legacy_calendar_bounds_birth', 'legacy_calendar_bounds_record_birth')
  for (const [table, timing] of [['users','after'],['users','before'],['vendors','after'],['vendors','before'],
    ['vendor_staff_members','after'],['vendor_staff_members','before'],['vendor_resources','after'],['vendor_resources','before'],
    ['vendor_staff_duties','after'],['vendor_staff_duties','before'],['resource_occupancy_origin_certificates','after'],['legacy_calendar_sources','after']])
    add(table, `legacy_calendar_bounds_observe_${timing}_${table}`.slice(0, 63), 'legacy_calendar_bounds_observe')
  for (const table of watchers) add(table, 'check_legacy_calendar_bounds_complete', 'check_legacy_calendar_bounds_complete')
  assert.equal(pairs.size, 93)
  async function proof() {
    seal(); await write('begin isolation level repeatable read read only')
    try {
      await db.query("set local time zone 'UTC'")
      assert.equal((await db.query("select current_setting('max_identifier_length') value")).rows[0].value, '63')
      const state = await fr018State(), raw = []
      for (const table of sorted(Object.keys(state.snapshot.data))) {
        const rows = (await db.query(`select row_to_json(t)::text raw from public.${quote(table)} t order by row_to_json(t)::text`)).rows.map(x => x.raw)
        const count = (await db.query(`select count(*)::text count from public.${quote(table)}`)).rows[0].count
        assert.equal(String(rows.length), count); raw.push({ table, rows, count, sha256: sha(rows.map(x => x + '\n').join('')) })
      }
      const metadata = (await db.query(`select p.oid::text,p.proname,p.oid::regprocedure::text signature,pg_get_function_identity_arguments(p.oid) arguments,
        p.prosrc,p.provolatile,p.prosecdef,p.proleakproof,p.proisstrict,p.proretset,p.proparallel,p.proconfig,p.prokind,p.procost,p.prorows,
        p.prosupport::regproc::text support,p.prorettype::regtype::text result,l.lanname,pg_get_userbyid(p.proowner) owner,p.proacl,obj_description(p.oid,'pg_proc') comment
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
        where n.nspname='public' and p.prokind<>'a' order by p.proname,pg_get_function_identity_arguments(p.oid)`)).rows
      const triggers = (await db.query(`select t.oid::text,c.relname parent,t.tgname name,t.tgtype,t.tgenabled,t.tgisinternal "internal",t.tgdeferrable,t.tginitdeferred,
        encode(t.tgargs,'hex') arguments,f.proname function_name,t.tgconstraint::text constraint_oid,k.conname constraint_name,pk.relname constraint_parent,
        rk.relname referenced_table,pg_get_triggerdef(t.oid,true) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid
        join pg_namespace n on n.oid=c.relnamespace join pg_proc f on f.oid=t.tgfoid left join pg_constraint k on k.oid=t.tgconstraint
        left join pg_class pk on pk.oid=k.conrelid left join pg_class rk on rk.oid=k.confrelid where n.nspname='public' order by c.relname,t.tgname`)).rows
      await write('commit'); seal(); return { state, raw, functions: metadata, triggers }
    } catch (error) { await db.query('rollback'); throw error }
  }
  const rawRows = (p, table) => { const row = p.raw.find(x => x.table === table); assert(row); return row.rows }
  const values = (p, table) => rawRows(p, table).map(x => JSON.parse(x))
  const journals = n => assertJournal(manifest.slice(0, n).map(x => x.name))
  async function preserving(before, after) {
    assert.deepEqual(after.raw.map(x => x.table), sorted([...before.raw.map(x => x.table), ...OWN]))
    for (const old of before.raw) {
      let expected = old.rows
      if (old.table === 'pgmigrations') assert.deepEqual(rawRows(after, old.table).filter(x => JSON.parse(x).name !== NAME), expected)
      else {
        if (old.table === 'resource_conflict_keys') expected = sorted(new Set([...expected,
          ...values(before, 'users').map(x => JSON.stringify({ kind: 'person', identity: x.id })),
          ...values(before, 'vendor_resources').map(x => JSON.stringify({ kind: x.kind, identity: x.conflict_identity })),
          ...values(before, 'resource_allocations').map(x => JSON.stringify({ kind: x.kind, identity: x.conflict_identity }))]))
        assert.deepEqual(rawRows(after, old.table), expected, `${old.table}: literal old data, only exact technical key union may change`)
      }
    }
    const oldFunctionIds = new Set(before.functions.map(x => x.oid)), additions = after.functions.filter(x => !oldFunctionIds.has(x.oid))
    const expectedOld = expectedOldDateFunctions(before, corrections)
    assert.deepEqual(after.functions.filter(x => oldFunctionIds.has(x.oid)), expectedOld.functions,
      'Every old OID/metadata/ACL remains exact; only two literal admitted DATE prosrc changes')
    // Resolve only the 59 literal admitted signatures through PostgreSQL. Its
    // regprocedure display expands type aliases such as timestamptz.
    const admitted = (await db.query(`select p.oid::text oid,p.oid::regprocedure::text signature,n.nspname schema
      from unnest($1::text[]) with ordinality i(signature,position)
      left join pg_proc p on p.oid=to_regprocedure(i.signature)
      left join pg_namespace n on n.oid=p.pronamespace order by i.position`, [signatures])).rows
    assert.equal(admitted.length, 59)
    for (const row of admitted) assert.equal(row.schema, 'public', 'Every literal admitted function must resolve in public')
    assert.deepEqual(sorted(additions.map(x => x.oid)), sorted(admitted.map(x => x.oid)), 'Exactly the 59 native admitted function identities')
    assert.deepEqual(sorted(additions.map(x => x.signature)), sorted(admitted.map(x => x.signature)))
    for (const fn of additions) assert.equal(fn.prosrc, functions.find(x => x.name === fn.proname)?.body, 'Literal admitted native94 body')
    const oldTriggerIds = new Set(before.triggers.map(x => x.oid)), introduced = after.triggers.filter(x => !oldTriggerIds.has(x.oid))
    assert.deepEqual(after.triggers.filter(x => oldTriggerIds.has(x.oid)), before.triggers, 'Old internal/ordinary triggers/OIDs exact')
    const ordinary = introduced.filter(x => !x.internal)
    assert.deepEqual(sorted(ordinary.map(x => `${x.parent}.${x.name}`)), sorted(pairs.keys()))
    for (const row of ordinary) assert.equal(row.function_name, pairs.get(`${row.parent}.${row.name}`))
    const isNewConstraint = x => OWN.includes(x.table_name) || (watchers.includes(x.table_name) && x.conname === 'check_legacy_calendar_bounds_complete')
    const constraints = after.state.objects.filter(x => x.kind === 'constraint' && isNewConstraint({ table_name: x.table_name, conname: x.name }))
    const constraintIds = new Set(constraints.map(x => x.oid))
    for (const row of ordinary) {
      if (row.name === 'check_legacy_calendar_bounds_complete') {
        assert(constraintIds.has(row.constraint_oid)); assert.equal(row.constraint_parent, row.parent); assert.equal(row.constraint_name, row.name)
      } else assert.equal(row.constraint_oid, '0')
    }
    for (const row of introduced.filter(x => x.internal)) {
      assert(constraintIds.has(row.constraint_oid), 'Only native RI of actual new94 constraints may be introduced')
      assert(OWN.includes(row.constraint_parent)); assert(/^RI_ConstraintTrigger_[ac]_[0-9]+$/.test(row.name))
      assert(after.state.snapshot.schema.constraints.some(x => x.table_name === row.constraint_parent && x.conname === row.constraint_name && x.contype === 'f'))
      assert(/^RI_FKey_/.test(row.function_name))
    }
    const relations = new Set([...OWN, ...after.state.snapshot.schema.indexes.filter(x => OWN.includes(x.tablename)).map(x => x.indexname)])
    const types = new Set(OWN.flatMap(x => [x, '_' + x])), newFunctions = new Set(additions.map(x => x.oid)), newTriggers = new Set(introduced.map(x => x.oid))
    const oldObjects = new Set(before.state.objects.map(x => `${x.kind}:${x.oid}`))
    const newObjects = after.state.objects.filter(x => !oldObjects.has(`${x.kind}:${x.oid}`))
    for (const row of newObjects) assert(
      row.kind === 'relation' ? relations.has(row.name) : row.kind === 'type' ? types.has(row.name) :
        row.kind === 'constraint' ? constraintIds.has(row.oid) : row.kind === 'function' ? newFunctions.has(row.oid) :
          row.kind === 'trigger' ? newTriggers.has(row.oid) : false, `Unexpected new94 catalogue object ${row.kind}/${row.name}`)
    const projected = structuredClone(after.state)
    for (const name of OWN) delete projected.snapshot.data[name]
    projected.snapshot.data.pgmigrations = projected.snapshot.data.pgmigrations.filter(x => x.name !== NAME)
    projected.snapshot.data.resource_conflict_keys = before.state.snapshot.data.resource_conflict_keys
    const filters = {
      relations: x => relations.has(x.relname), columns: x => OWN.includes(x.table_name), columnMetadata: x => relations.has(x.relname),
      constraints: isNewConstraint, indexes: x => OWN.includes(x.tablename),
      triggers: x => pairs.has(`${x.table_name}.${x.tgname}`), functions: x => functions.some(f => f.name === x.proname), types: x => types.has(x.typname)
    }
    for (const [key, isNew] of Object.entries(filters)) projected.snapshot.schema[key] = projected.snapshot.schema[key].filter(x => !isNew(x))
    projected.objects = projected.objects.filter(x => oldObjects.has(`${x.kind}:${x.oid}`))
    projected.attributes = projected.attributes.filter(x => !relations.has(x.table_name))
    const expectedState = structuredClone(before.state)
    expectedState.snapshot.schema.functions = expectedOld.schemaFunctions
    assert.deepEqual(projected, expectedState,
      'Only closed94 DDL/journal/keys and literal old2 definitions; all other old catalogue/attributes/OIDs exact')
    const allocations = values(before, 'resource_allocations'), mirrors = values(after, 'resource_occupancy'); assert.equal(mirrors.length, allocations.length)
    for (const a of allocations) {
      const m = mirrors.find(x => x.allocation_id === a.id); assert(m); const { id, ...actual } = m; assert(/^[a-f0-9-]{36}$/.test(id))
      assert.deepEqual(actual, { origin_kind: 'commitment',origin_id: a.id,origin_version_id: a.origin_version_id,origin_line_index: a.origin_line_index,
        certificate_id: null,allocation_id: a.id,vendor_identity: a.vendor_id,kind: a.kind,conflict_identity: a.conflict_identity,resource_id: a.resource_id,
        capacity_window_id: a.capacity_window_id,quantity: a.quantity,occupied_starts_at: a.occupied_starts_at,occupied_ends_at: a.occupied_ends_at,
        enforcement: 'exclusive',released_at: a.released_at,release_reason: a.release_reason,release_event_id: null })
    }
    return { additions, introduced, constraints, relations, types }
  }
  function logicalNew(after, introduced) {
    const { additions, introduced: triggers, relations, types } = introduced
    const schema = after.state.snapshot.schema, ordinary = triggers.filter(x => !x.internal).map(({ oid: _oid, constraint_oid: _constraintOid, ...x }) => x)
    const ri = triggers.filter(x => x.internal).map(({ oid: _oid, name, constraint_oid: _constraintOid, definition, ...x }) => {
      const stableName = `new94_ri_${x.constraint_parent}_${x.constraint_name}_${x.parent}_${x.function_name}_${x.tgtype}`
      assert.equal(definition.split(quote(name)).length, 2, 'Only exact new RI trigger name is normalized in definition')
      return { ...x, name: stableName, definition: definition.replace(quote(name), quote(stableName)) }
    }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return { functions: additions.map(({ oid: _oid, ...x }) => x), ordinary, ri,
      relations: schema.relations.filter(x => relations.has(x.relname)),columns: schema.columns.filter(x => OWN.includes(x.table_name)),
      attributes: after.state.attributes.filter(x => relations.has(x.table_name)).map(({ table_oid: _tableOid, ...x }) => x),
      columnMetadata: schema.columnMetadata.filter(x => relations.has(x.relname)),constraints: schema.constraints.filter(x => OWN.includes(x.table_name)
        || (watchers.includes(x.table_name) && x.conname === 'check_legacy_calendar_bounds_complete')),
      indexes: schema.indexes.filter(x => OWN.includes(x.tablename)),types: schema.types.filter(x => types.has(x.typname)) }
  }
  async function installed(before, label) {
    await migrate('up', STAMP); const after = await proof(), introduced = await preserving(before, after); await journals(94)
    emit('CALENDAR94_PRESERVING_UP', { label, helperSHA256: helperSHA, migrationSHA256: PIN, oldTableCount: before.raw.length,
      allocationCount: values(before, 'resource_allocations').length, proof: after, onlyTechnicalStableKeyDataAdditions: true,
      exactOldFunctionCORs: corrections.map((x, index) => ({ signature: x.signature, oldProsrcSHA256: DATE_COR_SPEC[index].oldSHA,
        newProsrcSHA256: DATE_COR_SPEC[index].newSHA })), oldFunctionMetadataAndOIDsPreserved: true })
    return { after, introduced }
  }
  async function repeat(label) {
    const before = await proof(); await migrate('up', STAMP); assert.deepEqual(await proof(), before)
    emit('CALENDAR94_REPEAT', { label, unchanged: true })
  }
  return { db, migrate, proof, rawRows, values, journals, installed, repeat, preserving, logicalNew, seal, helperSHA }
}

export async function runCalendarBoundsEmptyCycle(c) {
  const o = controls(c), prior = await o.proof(), priorNames = [...prior.state.snapshot.data.pgmigrations].sort((a, b) => a.id - b.id).map(x => x.name)
  assert.equal(priorNames.length, 84); await o.journals(84)
  await o.migrate('up', PRIOR); const before93 = await o.proof(); await o.journals(93)
  assert.equal(o.values(before93, 'users').length, 0); assert.equal(o.values(before93, 'resource_allocations').length, 0)
  const first = await o.installed(before93, 'first-empty')
  for (const table of OWN) assert.equal(o.rawRows(first.after, table).length, 0, 'All twelve94 tables must really be empty')
  await o.migrate('down', NAME, undefined, true); assert.deepEqual(await o.proof(), before93, 'Empty down restores every literal old93 fact/OID/catalogue')
  const reup = await o.installed(before93, 'reup-empty')
  for (const table of OWN) assert.equal(o.rawRows(reup.after, table).length, 0)
  assert.deepEqual(o.logicalNew(reup.after, reup.introduced), o.logicalNew(first.after, first.introduced), 'New94 logical catalogue stable; only new native RI generated names/OIDs are normalized')
  await o.repeat('empty'); await o.migrate('down', NAME, undefined, true); assert.deepEqual(await o.proof(), before93)
  await o.migrate('down', 1763835000000); await o.journals(84)
  const restored = await o.proof(), projected = structuredClone(restored)
  const oldMax = Math.max(...prior.state.attributes.filter(x => x.table_name === 'offer_requests').map(x => x.attnum))
  const extra = projected.state.attributes.filter(x => x.table_name === 'offer_requests' && x.attnum > oldMax)
  assert.equal(extra.length, 1); assert.equal(extra[0].attnum, oldMax + 1); assert.equal(extra[0].attisdropped, true)
  assert.equal(extra[0].atttypid, '0'); assert.equal(extra[0].atthasdef, false); assert.equal(extra[0].attacl, null)
  assert.equal(extra[0].attnotnull, false); assert.equal(extra[0].attidentity, ''); assert.equal(extra[0].attgenerated, '')
  assert(/^\.\.\.\.\.\.\.\.pg\.dropped\.[0-9]+\.\.\.\.\.\.\.\.$/.test(extra[0].attname))
  projected.state.attributes = projected.state.attributes.filter(x => !extra.includes(x))
  assert.deepEqual(projected, prior, 'Return exact prior84 except precisely one native90 dropped program_event_context attribute slot')
  emit('CALENDAR94_EMPTY_MIGRATION_DRILL_PASSED', { finalSchema: 84, actual94Ups: 2, actual94EmptyDowns: 2, repeat: 1,
    prior84Restored: true, old93LiteralPreserved: true, exactOld2RestoredAtEach94Down: true, forwardOldCORCount: 2,
    newRIOnlyNormalized: true, native90DroppedAttribute: extra,
    helperSHA256: o.helperSHA, migrationSHA256: PIN, publicAcceptance: false, realHumanAgreement: false })
}
export async function runCalendarBoundsPopulatedCycle(c) {
  const o = controls(c); await o.journals(93); const before = await o.proof(), allocations = o.values(before, 'resource_allocations')
  assert(allocations.length > 0 && allocations.some(x => x.released_at === null) && allocations.some(x => x.released_at !== null), 'Existing real native active/released allocations required')
  assert(o.values(before, 'resource_capacity_windows').some(x => x.legacy_used > 0 && x.used > x.legacy_used), 'Existing positive legacy baseline plus live allocation counter required')
  const installed = await o.installed(before, 'populated-old93')
  for (const allocation of allocations) await o.db.query('select legacy_calendar_bounds_assert_mirror($1)', [allocation.id])
  await o.repeat('populated'); const retained = await o.proof()
  const result = await o.migrate('down', NAME, MESSAGE, true)
  assert.deepEqual(nativeError(result.output), { message: MESSAGE, code: '23514', severity: 'ERROR', constraint: 'legacy_calendar_bounds_preserving_down' })
  assert.deepEqual(await o.proof(), retained); await o.journals(94); o.seal()
  emit('CALENDAR94_POPULATED_MIGRATION_DRILL_PASSED', { schema: 94, oldRawTables: before.raw.length, oldFunctionMetadataAndOIDsUnchanged: true,
    exactOldFunctionBodyCORs: DATE_COR_SPEC.map(x => x.signature), allOtherOldBodiesUnchanged: true,
    exactActiveAndReleasedMirrors: allocations.length, mirrorBackfill: true, positiveLegacyCounterPreserved: true, repeat: 1, nativeDownRefusals: 1,
    proof: installed.after, helperSHA256: o.helperSHA, migrationSHA256: PIN, populatedRollbackSucceeded: false,
    calendarReceiptOrActivationFixture: false, realHumanAgreement: false, guardOneHotBranchesProven: false })
}
