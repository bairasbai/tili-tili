import assert from 'node:assert/strict'

export const AUDIT_MIGRATION = '1764820000000_calendar_adoption_audit_fixes'
const LATEST = 1764820000000
const TARGET = 'legacy_calendar_bounds_assert_adopted'
const OLD_PREDICATE = "and (o.released_at is null or o.release_event_id is distinct from e.id or o.release_reason<>'adopted')"
const NEW_PREDICATE = 'and o.released_at is null'

async function state(c) {
  const snapshot = await c.snapshot()
  const functions = (await c.db.query(`select p.oid::text oid,pg_get_functiondef(p.oid) definition,
    to_jsonb(p)-'prosrc' metadata from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=$1`, [TARGET])).rows
  assert.equal(functions.length, 1)
  return { snapshot, function: functions[0] }
}
function assertUpgrade(before, after) {
  assert.equal(before.function.definition.split(OLD_PREDICATE).length, 2)
  assert.equal(after.function.definition, before.function.definition.replace(OLD_PREDICATE, NEW_PREDICATE),
    'Only the reviewed historical-occupancy predicate may change')
  assert.equal(after.function.oid, before.function.oid, 'Preserve the actual native function OID')
  assert.deepEqual(after.function.metadata, before.function.metadata, 'Preserve all function metadata, arguments, owner and ACL')
  assert.deepEqual(Object.keys(after.snapshot.data), Object.keys(before.snapshot.data))
  for (const [table, rows] of Object.entries(before.snapshot.data)) {
    const actual = table === 'pgmigrations' ? after.snapshot.data[table].filter(r => r.name !== AUDIT_MIGRATION) : after.snapshot.data[table]
    assert.deepEqual(actual, rows, 'Every old row and column remains exact: ' + table)
  }
  const additions = after.snapshot.data.pgmigrations.filter(r => r.name === AUDIT_MIGRATION)
  assert.equal(additions.length, 1)
  const schema = { ...after.snapshot.schema, functions: after.snapshot.schema.functions.map(row => {
    if (row.proname !== TARGET) return row
    const original = before.snapshot.schema.functions.find(old => old.proname === TARGET && old.arguments === row.arguments)
    assert(original)
    assert.deepEqual({ ...row, definition: original.definition }, original)
    return original
  }) }
  assert.deepEqual(schema, before.snapshot.schema, 'All catalogue facts except that one function body remain exact')
}

/** Root owns a guarded disposable DB, snapshot implementation and native CLI.
 * Preserve every populated row, not only the feature's tables. No inferred
 * agreement, dropping schemas or access to any production service. */
export async function runCalendarAdoptionAuditCycle(c, phase) {
  assert(['empty', 'populated', 'calendar-history'].includes(phase))
  const before = await state(c)
  assert.equal(before.snapshot.data.pgmigrations.length, 97)
  assert(before.snapshot.data.pgmigrations.some(r => r.name === '1764810000000_tilly_task_actions'))
  if (phase === 'populated') {
    assert(before.snapshot.data.payments.length > 0 && before.snapshot.data.deals.length > 0)
    assert(before.snapshot.data.resource_allocations.length > 0 && before.snapshot.data.resource_occupancy.some(r => r.origin_kind === 'commitment'),
      'Populated proof requires actual inherited financial/allocation/mirror rows')
  }
  if (phase === 'calendar-history') {
    assert(before.snapshot.data.legacy_calendar_bounds_versions.length >= 2 && before.snapshot.data.legacy_calendar_bounds_receipts.length > 0,
      'Calendar-history proof requires actual inherited versions and receipts')
    const superseded = before.snapshot.data.resource_occupancy.filter(r => r.release_reason === 'superseded' && r.released_at !== null)
    assert(superseded.length > 0, 'Calendar-history proof requires genuinely superseded occupancy')
    for (const row of superseded) {
      const certificate = before.snapshot.data.resource_occupancy_origin_certificates.find(r => r.id === row.certificate_id)
      const event = before.snapshot.data.legacy_calendar_resolution_events.find(r => r.id === row.release_event_id)
      assert(certificate && event && event.action === 'activate' && event.source_id === certificate.source_identity)
      assert.notEqual(event.bounds_version_id, certificate.bounds_version_identity)
    }
    assert(before.snapshot.data.resource_occupancy.some(r => r.certificate_id !== null && r.released_at === null),
      'Calendar-history proof also retains live current certificate rows')
  }
  await c.migrate('up', LATEST)
  const after = await state(c)
  assertUpgrade(before, after)
  await c.migrate('up', LATEST)
  assert.deepEqual(await state(c), after, 'Repeated UP must preserve all rows, catalogue and function identity')
  await c.migrate('down', AUDIT_MIGRATION, undefined, true)
  assert.deepEqual(await state(c), before, 'DOWN must restore literal schema97 including the original function definition')
  await c.migrate('up', LATEST)
  assertUpgrade(before, await state(c))
  process.stdout.write('CALENDAR_ADOPTION_AUDIT98_' + phase.toUpperCase().replaceAll('-', '_') + '_NATIVE_PASSED ' + JSON.stringify({
    baselineMigrations: before.snapshot.data.pgmigrations.length,
    currentMigrations: after.snapshot.data.pgmigrations.length,
    oldTables: Object.keys(before.snapshot.data).length,
    inheritedBoundsVersions: before.snapshot.data.legacy_calendar_bounds_versions.length,
    functionOID: before.function.oid,
    allOldRowsAndColumnsExact: true, exactFunctionDown: true,
    actualUps: 2, actualDowns: 1, actualRepeats: 1, realHumanAgreement: false,
  }) + '\n')
}
