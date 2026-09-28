/** Feature 021 migration rehearsal on a disposable local *_test database only.
 * Proves legacy-row mapping, amount-unknown constraints and guarded rollback semantics.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const url = process.env.TEST_DATABASE_URL
assert(url && process.env.ALLOW_PAYMENT_PRIVACY_MIGRATION_DRILL === 'yes', 'Explicit disposable-database drill opt-in is required')
const target = new URL(url)
assert(['127.0.0.1','localhost'].includes(target.hostname) && /^\/[a-z0-9_]+_test$/.test(target.pathname),
  'Only a named local *_test database is allowed')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const exists = await client.query("select to_regclass('public.users') as users")
  if (exists.rows[0].users) {
    const users = await client.query('select count(*)::int as n from users')
    assert.equal(users.rows[0].n, 0, 'Refusing to rehearse against a populated database')
  }

  const PREV = '1761600000000_family_guest_parties'
  const STAGE = '1761700000000_payment_methods_privacy'
  function run(args) {
    return spawnSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js','-m','migrations',...args],
      { cwd: root, env: { ...process.env, DATABASE_URL: url }, encoding:'utf8', timeout:60000, maxBuffer:4*1024*1024 })
  }
  function migrate(args) {
    const p=run(args)
    assert.equal(p.status,0,`Migration ${args.join(' ')} failed; raw logs are deliberately not published`)
  }

  // Build the exact pre-021 schema. node-pg-migrate --to on a fresh database can
  // skip prerequisite migrations, so apply the normal chain then step 021 back while empty.
  migrate(['up'])
  migrate(['down'])
  const before021=await client.query('select name from pgmigrations order by id desc limit 1')
  assert.equal(before021.rows[0].name,PREV)
  const owner=randomUUID(), wedding=randomUUID(), slot=randomUUID(), deal=randomUUID(), payment=randomUUID()
  await client.query("insert into users(id,phone) values($1,'+79000000211')",[owner])
  await client.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'021 migration','2027-06-18','Asia/Yekaterinburg',$3)",
    [wedding,owner,randomUUID()])
  await client.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[wedding,owner])
  await client.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Photo')",[slot,wedding])
  await client.query("insert into deals(id,wedding_id,slot_id,external_name,state,price) values($1,$2,$3,'Photo','booked',12000000)",
    [deal,wedding,slot])
  await client.query("insert into payments(id,deal_id,kind,amount,status,created_at) values($1,$2,'deposit',3000000,'recorded','2027-06-18 20:30:00+00')",
    [payment,deal])

  migrate(['up',STAGE])
  const latest=await client.query('select name from pgmigrations order by id desc limit 1')
  assert.equal(latest.rows[0].name,STAGE)

  const legacy=await client.query(`select amount::text as amount,payment_method,visibility,amount_known,paid_on::text as paid_on
    from payments where id=$1`,[payment])
  assert.deepEqual(legacy.rows[0],{
    amount:'3000000',payment_method:'other',visibility:'private',amount_known:true,paid_on:'2027-06-19',
  })

  const unknown=randomUUID()
  await client.query(`insert into payments(id,deal_id,kind,amount,status,payment_method,visibility,amount_known,paid_on)
    values($1,$2,'deposit',null,'recorded','cash','private',false,'2027-06-20')`,[unknown,deal])
  const lower=await client.query(`select coalesce(sum(amount),0)::text as known,
    count(*) filter(where not amount_known)::int as unknown from payments where deal_id=$1`,[deal])
  assert.deepEqual(lower.rows[0],{known:'3000000',unknown:1})

  await assert.rejects(
    client.query(`insert into payments(id,deal_id,kind,amount,status,payment_method,visibility,amount_known,paid_on)
      values($1,$2,'deposit',0,'recorded','cash','private',false,'2027-06-20')`,[randomUUID(),deal]),
  )

  // A rollback with any payment would expose data to old code that knows no visibility.
  const guarded=run(['down','1'])
  assert.notEqual(guarded.status,0,'Populated rollback must refuse')
  assert.equal((await client.query('select count(*)::int as n from payments')).rows[0].n,2)

  // Empty/disposable rollback is reversible, then the stage applies again.
  await client.query('delete from payment_receipts where wedding_id=$1',[wedding])
  await client.query('delete from payments where deal_id=$1',[deal])
  migrate(['down','1'])
  const cols=await client.query(`select column_name from information_schema.columns
    where table_schema='public' and table_name='payments' and column_name in
      ('payment_method','visibility','amount_known','paid_on')`)
  assert.equal(cols.rowCount,0)
  migrate(['up',STAGE])

  process.stdout.write(JSON.stringify({
    status:'passed',migration:STAGE,legacyRowsPreserved:true,legacyMapping:'other/private/known',
    unknownAmountStoredAsNull:true,knownAggregateIsLowerBound:true,populatedRollbackRefused:true,
    emptyDownUpCycle:true,
  },null,2)+'\n')
} finally {
  await client.end()
}
