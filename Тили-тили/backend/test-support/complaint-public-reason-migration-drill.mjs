import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const COMPLAINT_REASON_MIGRATION = '1764950000000_complaint_public_reason'
export const COMPLAINT_REASON_LATEST = 1764950000000
const column = 'public_reason'
const constraint = 'complaints_public_reason_valid'
const index = 'complaints_reporter_history'

export async function runComplaintReasonCycle({ db, migrate, snapshot }, owner) {
  const id = randomUUID()
  await db.query(`insert into complaints(id,reporter_id,target_kind,target_id,category,status,resolution,note,resolved_at)
    values($1,$2,'vendor',$3,'spam','resolved','dismiss','Synthetic private legacy note',now())`, [id, owner, randomUUID()])
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 110)
  await migrate('up', COMPLAINT_REASON_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 111)
  assert.deepEqual({
    ...installed.data,
    pgmigrations: installed.data.pgmigrations.filter(row => row.name !== COMPLAINT_REASON_MIGRATION),
    complaints: installed.data.complaints.map(({ public_reason, ...old }) => {
      assert.equal(public_reason, null)
      return old
    }),
  }, before.data)
  assert.deepEqual({
    ...installed.schema,
    columns: installed.schema.columns.filter(row => row.table_name !== 'complaints' || row.column_name !== column),
    columnMetadata: installed.schema.columnMetadata.filter(row =>
      row.relname !== index && (row.relname !== 'complaints' || row.attname !== column)),
    constraints: installed.schema.constraints.filter(row => row.conname !== constraint),
    indexes: installed.schema.indexes.filter(row => row.indexname !== index),
    relations: installed.schema.relations.filter(row => row.relname !== index),
  }, before.schema)
  assert(installed.schema.indexes.some(row => row.tablename === 'complaints' && row.indexname === index))
  assert(installed.schema.constraints.some(row => row.table_name === 'complaints' && row.conname === constraint && row.convalidated))
  await migrate('up', COMPLAINT_REASON_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', COMPLAINT_REASON_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', COMPLAINT_REASON_LATEST)
  await db.query("update complaints set public_reason='Synthetic public decision' where id=$1", [id])
  const populated = await snapshot()
  await migrate('down', COMPLAINT_REASON_MIGRATION, 'complaint_public_reason_preserving_down_fr069', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from complaints where id=$1', [id])
  process.stdout.write('FR-069 complaint reasons: legacy rows preserved, repeat up stable, empty down reversible, populated down refused\n')
}
