/** Destructive schema rehearsal on an EMPTY, disposable local *_test database only.
 * Keeps actual payments across rollback. It never connects to a remote database.
 * Usage: ALLOW_PAYMENT_MIGRATION_DRILL=yes TEST_DATABASE_URL=postgres://.../payment_drill_test node scripts/payment-migration-rehearsal.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const url = process.env.TEST_DATABASE_URL
assert(url && process.env.ALLOW_PAYMENT_MIGRATION_DRILL === 'yes', 'Explicit disposable-database drill opt-in is required')
const target = new URL(url)
assert(['127.0.0.1', 'localhost'].includes(target.hostname) && /^\/[a-z0-9_]+_test$/.test(target.pathname), 'Only a named local *_test database is allowed')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const client = new pg.Client({ connectionString: url })
await client.connect()
try {
  const exists = await client.query("select to_regclass('public.users') as users")
  if (exists.rows[0].users) {
    const users = await client.query('select count(*)::int as n from users')
    assert.equal(users.rows[0].n, 0, 'Refusing to rehearse against a populated database')
  }
  const STAGE = '1761310000000_payment_schedule'
  function run(args, extraEnv = {}) {
    return spawnSync(process.execPath, ['node_modules/node-pg-migrate/bin/node-pg-migrate.js', '-m', 'migrations', ...args],
      { cwd: root, env: { ...process.env, DATABASE_URL: url, ...extraEnv }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 })
  }
  function migrate(args, extraEnv = {}) {
    const p = run(args, extraEnv)
    assert.equal(p.status, 0, `Migration ${args.join(' ')} failed; raw logs are deliberately not published`)
  }
  // Ровно до 018-A: после неё в ветке есть 018-B (1761400000000), и голый `up` откатывал бы не ту миграцию.
  migrate(['up', STAGE])
  const latest = await client.query('select name from pgmigrations order by id desc limit 1')
  assert.equal(latest.rows[0].name, STAGE, 'This drill only rolls back stage 018-A, never a later migration')
  const user = randomUUID(), wedding = randomUUID(), slot = randomUUID(), deal = randomUUID(), stage = randomUUID(), payment = randomUUID()
  await client.query("insert into users(id,phone) values($1,'+79000000181')", [user])
  await client.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Migration drill',$3)", [wedding,user,randomUUID()])
  await client.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Drill')", [slot,wedding])
  await client.query("insert into deals(id,wedding_id,slot_id,external_name,state,price) values($1,$2,$3,'Drill','booked',1000000)", [deal,wedding,slot])
  await client.query("insert into payment_installments(id,deal_id,title,amount,due) values($1,$2,'Deposit',400000,'2027-05-01')", [stage,deal])
  await client.query("insert into payments(id,deal_id,kind,amount,status,installment_id) values($1,$2,'deposit',100000,'recorded',$3)", [payment,deal,stage])
  // Защита отката: без явного флага откат на базе с этапами отказывает и ничего не стирает.
  const guarded = run(['down', '1'])
  assert.notEqual(guarded.status, 0, 'Rollback without tili.allow_data_loss must refuse on a populated schedule')
  assert.equal((await client.query('select count(*)::int as n from payment_installments')).rows[0].n, 1)
  migrate(['down', '1'], { PGOPTIONS: '-c tili.allow_data_loss=yes' })
  const afterDown = await client.query('select id,amount::text as amount,kind,status from payments where id=$1', [payment])
  assert.equal(afterDown.rowCount, 1)
  assert.equal(afterDown.rows[0].amount, '100000')
  assert.equal(afterDown.rows[0].status, 'recorded')
  assert.equal((await client.query("select to_regclass('public.payment_installments') as plan")).rows[0].plan, null)
  migrate(['up', STAGE])
  const afterUp = await client.query('select amount::text as amount,installment_id,plan_version from payments where id=$1', [payment])
  assert.deepEqual(afterUp.rows[0], { amount:'100000', installment_id:null, plan_version:1 })
  assert.equal((await client.query('select count(*)::int as n from payment_installments')).rows[0].n, 0)
  process.stdout.write(JSON.stringify({ status:'passed', migration:STAGE, guardedRollbackRefused:true,
    cycle:['up','down 1','up'], retainedPaymentRecords:1, retainedAmountKopecks:100000,
    retainedCurrency:'RUB', recreatedPlanEmpty:true, limitation:'Rollback removes installment metadata and links, not actual payments' }, null, 2)+'\n')
} finally {
  await client.end()
}
