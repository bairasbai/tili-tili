import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const NAME = '1763830000000_task_dependencies', STAMP = 1763830000000
const relations = new Set(['task_dependencies', 'task_dependencies_pkey', 'task_dependencies_reverse', 'tasks_wedding_identity'])
const functions = new Set(['guard_task_dependency', 'task_dependency_version_changed', 'guard_task_dependency_subject', 'guard_task_dependency_completion'])
const triggers = new Set(['task_dependency_guard', 'task_dependency_version', 'task_dependency_subject', 'task_dependency_completion'])
const constraints = new Set(['task_dependencies_pkey', 'task_dependencies_no_self', 'task_dependencies_task_fk', 'task_dependencies_prerequisite_fk', 'task_dependencies_wedding_id_fkey', 'tasks_wedding_identity'])
const normalize = value => Array.isArray(value) ? value.map(normalize)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])])) : value
const canonical = value => JSON.stringify(normalize(value))
const sorted = rows => rows.map(canonical).sort()
const newColumn = (table, name) => table === 'tasks' && name === 'dependency_version'

/** Run only after the parent's exact identity/inventory/session fences and native schema83 drill. */
export async function taskDependencyMigrationDrill({ db, write, migrate, snapshot, rows, columns, state, weddingId, ownerId }) {
  assert.equal((await db.query('select name from pgmigrations order by name desc limit 1')).rows[0].name, '1763825000000_offer_comparison_terms')
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  for (const [i, id] of ids.entries()) await write(`insert into tasks(id,wedding_id,title,source,period,due,due_mode,assignee_id,reminder_days_before,reminder_time)
    values($1,$2,$3,'user','1','2027-05-14','fixed',$4,2,'09:30')`, [id, weddingId, `FR005 historical task ${i}`, ownerId])
  const before = await snapshot(), original = await state(), layout = {}
  for (const table of Object.keys(before.data)) layout[table] = await columns(table)
  async function priorPreserved() {
    const now = await snapshot()
    for (const [table, data] of Object.entries(before.data)) {
      const actual = await rows(table, layout[table])
      assert.deepEqual(table === 'pgmigrations' ? actual.filter(r => r.name !== NAME) : actual, data, `83->84 preserves all old ${table} values`)
    }
    const normalized = structuredClone(now.schema)
    normalized.relations = normalized.relations.filter(r => !relations.has(r.relname))
    normalized.columns = normalized.columns.filter(r => r.table_name !== 'task_dependencies' && !newColumn(r.table_name, r.column_name))
    normalized.columnMetadata = normalized.columnMetadata.filter(r => !relations.has(r.relname) && !newColumn(r.relname, r.attname))
    normalized.constraints = normalized.constraints.filter(r => !constraints.has(r.conname))
    normalized.indexes = normalized.indexes.filter(r => !relations.has(r.indexname))
    normalized.triggers = normalized.triggers.filter(r => !triggers.has(r.tgname))
    normalized.functions = normalized.functions.filter(r => !functions.has(r.proname))
    normalized.types = normalized.types.filter(r => !['task_dependencies', '_task_dependencies'].includes(r.typname))
    assert.deepEqual(normalized, before.schema, 'Every old catalogue definition, ACL, comment and extension record is preserved')
    const current = await state()
    for (const old of original.objects) assert(current.objects.some(r => JSON.stringify(r) === JSON.stringify(old)), `Old object/OID preserved: ${old.kind}/${old.name}`)
    for (const old of original.attributes) assert(current.attributes.some(r => JSON.stringify(r) === JSON.stringify(old)), 'All old physical attribute slots remain unchanged')
  }
  await migrate('up', STAMP)
  await priorPreserved()
  assert.equal((await db.query('select count(*)::int n from task_dependencies')).rows[0].n, 0)
  assert((await db.query('select dependency_version::text v from tasks')).rows.every(r => r.v === '0'), 'No inferred dependencies or synthetic versions')
  const initial = await snapshot(); await migrate('up', STAMP); assert.deepEqual(await snapshot(), initial)
  await migrate('down', NAME, undefined, true)
  await priorPreserved()
  assert.equal((await db.query("select to_regclass('public.task_dependencies') as name")).rows[0].name, null)
  await migrate('up', STAMP); await priorPreserved()

  await write('insert into task_dependencies(wedding_id,task_id,prerequisite_id) values($1,$2,$3)', [weddingId, ids[1], ids[0]])
  const linked = await state()
  await migrate('down', NAME, 'Refusing to remove task dependency behavior with retained dependency or override evidence', true)
  assert.deepEqual(await state(), linked, 'Populated down keeps every row/catalogue/OID unchanged')
  await assert.rejects(write('insert into task_dependencies(wedding_id,task_id,prerequisite_id) values($1,$2,$3)', [weddingId, ids[0], ids[1]]), e => e.constraint === 'task_dependency_cycle')
  assert.deepEqual(await state(), linked, 'Failed cycle has no partial edge/version write')
  await assert.rejects(write('update tasks set done_at=now() where id=$1', [ids[1]]), e => e.constraint === 'task_dependencies_pending')
  assert.deepEqual(await state(), linked, 'Refused completion preserves existing task reminders/history')
  await write('begin')
  try {
    await write(`select set_config('tili.task_override_target',$1,true),set_config('tili.task_override_actor',$2,true),
      set_config('tili.task_override_reason','Synthetic preserving migration decision',true),set_config('tili.task_override_blockers',$3,true)`, [ids[1], ownerId, '{' + ids[0] + '}'])
    await write('update tasks set done_at=now() where id=$1', [ids[1]])
    await write('commit')
  } catch (e) { await db.query('rollback'); throw e }
  const audit = (await db.query("select actor_id,diff from audit_log where action='task.dependencies.overridden' and entity_id=$1", [ids[1]])).rows
  assert.equal(audit.length, 1); assert.equal(audit[0].actor_id, ownerId)
  assert.deepEqual(audit[0].diff.prerequisiteIds, [ids[0]])
  assert.equal(audit[0].diff.reason, 'Synthetic preserving migration decision')
  await write('delete from task_dependencies where task_id=$1', [ids[1]])
  for (const id of [ids[1], ids[0], ids[2]]) await write('delete from tasks where id=$1', [id])
  assert.equal((await db.query('select count(*)::int n from task_dependencies')).rows[0].n, 0)
  const retained = await state()
  await migrate('down', NAME, 'Refusing to remove task dependency behavior with retained dependency or override evidence', true)
  assert.deepEqual(await state(), retained, 'Audit-only down cannot erase historical behavior')
  await migrate('up', STAMP); assert.deepEqual(await state(), retained, 'Latest repeated up remains a preserving no-op')
  const originalAudits = sorted(before.data.audit_log)
  const afterAudits = sorted((await snapshot()).data.audit_log)
  assert(originalAudits.every(r => afterAudits.includes(r)))
  assert.equal(afterAudits.length, originalAudits.length + 1, 'Only one explicitly created synthetic audit remains')
  console.log('FR005_MIGRATION_PRESERVATION_PASSED schema83to84=true oldRowsCatalogueOids=true emptyDownReup=true cycleRefused=true pendingRefused=true populatedDownRefused=true auditOnlyDownRefused=true explicitAudit=1')
}
