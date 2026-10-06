import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readAdmission, assertJournal, assertIdentity as assertProfileIdentity, backend as laneBackend, AUDITS, fileSHA, sha } from '../test-support/c04-c05-native-admission.mjs'

const admission = readAdmission('barrier')
export const TARGET = admission.targetName, URL = admission.targetURL
export const OID = admission.oid, NAMESPACE = 2147483001
// Evidence root comes from the closed portable admission.
const backend = laneBackend
// Source hashes are validated by readAdmission before native work.
export function assertIdentity(row) {
  assertProfileIdentity(row, admission.profile, admission.creation)
  assert(Number.isInteger(row.pid) && row.pid > 0)
}
export { assertJournal }
export function assertNativeTriggers(actual, expected) {
  assert.equal(expected.length, 2)
  for (const row of expected) { assert.equal(row.tgenabled, 'O'); assert.equal(row.tgisinternal, true); assert(row.definition.includes('RI_FKey_check_')) }
  assert.deepEqual(actual, expected)
}
export function names(runId, userId, matchId, otherId) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
  for (const value of [runId,userId,matchId,otherId]) assert.match(value, uuid)
  assert.equal(new Set([runId,userId,matchId,otherId]).size, 4)
  const hex = runId.replaceAll('-', '')
  return { schema: 'c04b_' + hex, trigger: 'c04bt_' + hex,
    matchingKey: `${userId}:timeline-shift-v2:${matchId}`, otherKey: `${userId}:timeline-shift-v2:${otherId}` }
}
export function ddl(scope) {
  assert.match(scope.schema, /^c04b_[0-9a-f]{32}$/); assert.match(scope.trigger, /^c04bt_[0-9a-f]{32}$/)
  assert.match(scope.matchingKey, /^[0-9a-f-]{36}:timeline-shift-v2:[0-9a-f-]{36}$/)
  return [
    `create schema ${scope.schema}`,
    `create function ${scope.schema}.receipt_wait() returns trigger language plpgsql as $c04$ begin perform pg_advisory_xact_lock(${NAMESPACE},1); return NEW; end; $c04$`,
    `create trigger ${scope.trigger} before update of status,body on public.idempotency_keys for each row when (OLD.status is null and NEW.status=200 and NEW.key='${scope.matchingKey}') execute function ${scope.schema}.receipt_wait()`,
  ]
}
export const UPDATE = 'update public.idempotency_keys set status=200,body=$3::jsonb where key=$1 and user_id=$2 returning key,status,body'
const IDENTITY = `select current_database() as name,current_user as username,host(inet_server_addr()) as address,
  inet_server_port() as port,pg_backend_pid() as pid,(select oid::text from pg_database where datname=current_database()) as oid`
const TRIGGERS = `select t.oid::text,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition
  from pg_trigger t where t.tgrelid='public.idempotency_keys'::regclass order by t.tgname`
const COUNTS = `select (select count(*)::text from users) as users,(select count(*)::text from idempotency_keys) as receiptkeys,
  (select count(*)::text from audit_log) as audits,(select count(*)::text from weddings) as weddings,(select count(*)::text from notifications) as notices`
const LOCKS = `select pid,database::text,classid::text,objid::text,objsubid,granted from pg_locks
  where locktype='advisory' and database=$1::oid and classid=$2::oid order by pid,objid,granted`
async function bounded(promise, label, ms = 12000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ': deadline')), ms) })]) }
  finally { clearTimeout(timer) }
}
async function runNative() {
  assert.deepEqual(process.argv.slice(2), ['--run-approved-native'], 'Explicit root-only native invocation required')
  const selectedOutput = process.env.C04_BARRIER_CONTROL_OUTPUT
  assert(selectedOutput, 'Root must choose a fresh C04_BARRIER_CONTROL_OUTPUT JSON path')
  const output = resolve(selectedOutput)
  assert.equal(dirname(output), admission.directory, 'Control receipt must stay in the parent-owned evidence directory')
  assert(output.endsWith('.json')); assert(!existsSync(output), 'Preserve previous root receipt')
  const bindings = { migrationNames: admission.schema.journalNames }
  const reference = { identity: admission.schema.identity, triggers: admission.schema.triggers, journalNames: admission.schema.journalNames }
  assertIdentity(reference.identity); assertJournal(reference.journalNames, bindings.migrationNames)
  const runId = randomUUID(), userId = randomUUID(), scope = names(runId,userId,randomUUID(),randomUUID())
  const directory = join(admission.directory, 'barrier', runId)
  assert(!existsSync(directory)); mkdirSync(directory, { recursive: true })
  const save = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
  save('owned-identities.json', { runId,userId,...scope,namespace:NAMESPACE, targetURL:admission.profile.mode==='local'?URL:null, targetURLSHA256:sha(URL), targetOID:OID })
  const { Client } = createRequire(join(backend, 'package.json'))('pg')
  const clients = [], pending = [], catalog = [], gates = [], cleanupErrors = []
  let observer, controller, matching, unrelated, before, afterProof, identity, directWait, beforeProof, primaryError
  let setupCommitted = false, userCreated = false, unrelatedReceiptPassedWhileHeld = false
  let retainedAuditsBefore, retainedAuditsAfter
  const errorRecord = error => ({ name:error.name,code:error.code ?? null,message:error.message,stack:error.stack })
  const connect = async kind => {
    const client = new Client({ connectionString: URL, application_name: `c04bc_${kind}_${runId.replaceAll('-','')}`, connectionTimeoutMillis:3000, statement_timeout:10000, query_timeout:12000 })
    const owned = { kind,client,connected:false,pid:null }; clients.push(owned)
    await bounded(client.connect(),kind+' connect'); owned.connected=true
    const identity = (await client.query(IDENTITY)).rows[0]; assertIdentity(identity); owned.pid=identity.pid
    return owned
  }
  const sessions = async () => (await observer.client.query('select pid,application_name,state from pg_stat_activity where datname=current_database() and not (pid=any($1::int[])) order by pid', [clients.filter(x=>x.connected).map(x=>x.pid)])).rows
  const nativeTriggers = async () => (await observer.client.query(TRIGGERS)).rows
  const locks = async () => (await observer.client.query(LOCKS,[OID,String(NAMESPACE)])).rows
  try {
    observer = await connect('observe')
    await observer.client.query('begin read only')
    assert.deepEqual(await sessions(), [])
    const journal = (await observer.client.query('select name from pgmigrations order by name')).rows.map(x=>x.name)
    assertJournal(journal, bindings.migrationNames)
    before = (await observer.client.query(COUNTS)).rows[0]; for (const [key,value] of Object.entries(before)) assert.equal(value,key==='audits'?String(admission.schema.retainedAudits.length):'0')
    retainedAuditsBefore=(await observer.client.query(AUDITS)).rows.map(r=>({...r,at:r.at.toISOString()}));assert.deepEqual(retainedAuditsBefore,admission.schema.retainedAudits)
    assert.deepEqual((await observer.client.query("select oid from pg_namespace where left(nspname,5)='c04b_' order by nspname")).rows, [])
    assert.deepEqual((await observer.client.query("select oid from pg_trigger where left(tgname,6)='c04bt_' order by tgname")).rows, [])
    assertNativeTriggers(await nativeTriggers(), reference.triggers)
    assert.deepEqual(await locks(), [])
    const columns = (await observer.client.query(`select column_name,udt_name from information_schema.columns
      where table_schema='public' and table_name='idempotency_keys' order by ordinal_position`)).rows
    assert.deepEqual(columns, [{column_name:'key',udt_name:'text'},{column_name:'user_id',udt_name:'uuid'},
      {column_name:'route',udt_name:'text'},{column_name:'request_hash',udt_name:'text'},
      {column_name:'status',udt_name:'int4'},{column_name:'body',udt_name:'jsonb'},{column_name:'created_at',udt_name:'timestamptz'}])
    await observer.client.query('commit')
    identity=(await observer.client.query(IDENTITY)).rows[0]
    beforeProof={journal,identity,counts:before,columns,nativeTriggers:reference.triggers,otherSessions:[],barrierLocks:[],ownedCatalog:[]}
    save('preflight.json',beforeProof)
    gates.push('exact identity/journal82/schema/nativeFK/empty-scope preflight')
    await observer.client.query('begin')
    assert.deepEqual(await sessions(), [])
    assert.deepEqual((await observer.client.query('select oid from pg_namespace where nspname=$1',[scope.schema])).rows, [])
    for (const sql of ddl(scope)) await observer.client.query(sql)
    const schema = (await observer.client.query('select oid::text,nspowner::text as owner from pg_namespace where nspname=$1',[scope.schema])).rows[0]
    const fn = (await observer.client.query('select oid::text,proowner::text as owner,pg_get_functiondef(oid) as definition from pg_proc where pronamespace=$1::oid and proname=$2',[schema.oid,'receipt_wait'])).rows
    assert.equal(fn.length,1)
    const trig = (await observer.client.query(`select t.oid::text,c.relowner::text as owner,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname=$1 and t.tgrelid='public.idempotency_keys'::regclass`,[scope.trigger])).rows
    assert.equal(trig.length,1); assert.equal(trig[0].tgenabled,'O'); assert.equal(trig[0].tgisinternal,false)
    for(let attempt=0;attempt<8&&!userCreated;attempt++) {
      const rows=await observer.client.query('insert into users(id,phone,name) values($1,$2,$3) on conflict(phone) do nothing returning id',
        [userId,'+79'+randomInt(100000000,999999999),`Synthetic C04 barrier control ${runId}`])
      userCreated=rows.rows[0]?.id===userId
    }
    assert(userCreated,'bounded synthetic user allocation exhausted')
    await observer.client.query('insert into public.idempotency_keys(key,user_id,route,request_hash) values($1,$2,$3,$4)',[scope.otherKey,userId,'timeline-shift-v2',runId])
    await observer.client.query('commit'); setupCommitted=true
    catalog.push({kind:'schema',...schema},{kind:'function',...fn[0]},{kind:'trigger',...trig[0]})
    save('committed-owned-catalog.json',{catalog,userId,otherKey:scope.otherKey})
    gates.push('atomic fresh own catalog/user/unrelated receipt setup')
    controller=await connect('controller');matching=await connect('matching');unrelated=await connect('unrelated')
    assert.deepEqual(await sessions(), [])
    await controller.client.query('begin');await controller.client.query('select pg_advisory_xact_lock($1::int,$2::int)',[NAMESPACE,1])
    assert.deepEqual((await locks()).filter(x=>x.granted),[{pid:controller.pid,database:OID,classid:String(NAMESPACE),objid:'1',objsubid:2,granted:true}])
    gates.push('controller owns exact advisory xact lock')
    await matching.client.query('begin')
    await matching.client.query('insert into public.idempotency_keys(key,user_id,route,request_hash) values($1,$2,$3,$4)',[scope.matchingKey,userId,'timeline-shift-v2',runId])
    let settled=false
    const matchBody={barrierControlRun:runId,kind:'matching'}
    const matchQuery=matching.client.query(UPDATE,[scope.matchingKey,userId,JSON.stringify(matchBody)])
    pending.push(matchQuery);void matchQuery.then(()=>{settled=true},()=>{settled=true})
    const deadline=Date.now()+3000;let wait
    while(Date.now()<deadline) {
      const rows=(await observer.client.query(`select pid,query,state,wait_event_type,pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname=$1 and pid=$2 and state='active' and wait_event_type='Lock'`,[TARGET,matching.pid])).rows
      if(rows.length) {assert.equal(rows.length,1);assert.equal(rows[0].query,UPDATE);assert.deepEqual(rows[0].blockers,[controller.pid]);wait=rows[0];break}
      assert(!settled,'matching UPDATE settled before mandatory native wait');await new Promise(resolve=>setTimeout(resolve,25))
    }
    assert(wait,'native matching receipt barrier wait not observed');assert(!settled)
    const waitedLocks=await locks();assert(waitedLocks.some(x=>x.pid===matching.pid&&!x.granted&&x.objid==='1'&&x.objsubid===2))
    directWait={applicationPID:matching.pid,controllerPID:controller.pid,blockers:wait.blockers,query:wait.query,
      state:wait.state,waitEventType:wait.wait_event_type,locks:waitedLocks}
    save('actual-matching-wait.json',directWait)
    gates.push('matching BEFORE UPDATE actual direct controller wait')
    await unrelated.client.query('begin')
    const otherBody={barrierControlRun:runId,kind:'unrelated'}
    const otherQuery=unrelated.client.query(UPDATE,[scope.otherKey,userId,JSON.stringify(otherBody)]);pending.push(otherQuery)
    const other=await bounded(otherQuery,'unrelated own key must update while matching held',2000)
    assert.equal(other.rowCount,1);assert.deepEqual(other.rows,[{key:scope.otherKey,status:200,body:otherBody}])
    await unrelated.client.query('commit');assert(!settled)
    assert((await locks()).some(x=>x.pid===controller.pid&&x.granted&&x.objid==='1'&&x.objsubid===2))
    unrelatedReceiptPassedWhileHeld=true
    save('actual-unrelated-control.json',{rows:other.rows,matchingStillUnsettled:true,controllerStillHeld:true})
    gates.push('unrelated own key updates/commits with matching wait held')
    await controller.client.query('commit')
    const matched=await bounded(matchQuery,'matching receipt after controller commit')
    assert.equal(matched.rowCount,1);assert.deepEqual(matched.rows,[{key:scope.matchingKey,status:200,body:matchBody}])
    await matching.client.query('commit');save('actual-matching-completion.json',{rows:matched.rows})
    gates.push('matching native UPDATE resumes and commits')
  } catch(error) {primaryError=errorRecord(error)}
  finally {
    // Release holder first, settle original pending queries, then rollback/end
    // only registered own clients. No cancellation of foreign PIDs is allowed.
    if(controller?.connected)try{await bounded(controller.client.query('rollback'),'release own controller')}catch(error){cleanupErrors.push(errorRecord(error))}
    try{const values=await bounded(Promise.allSettled(pending),'settle own pending native statements');for(const value of values)if(value.status==='rejected')cleanupErrors.push(errorRecord(value.reason))}catch(error){cleanupErrors.push(errorRecord(error))}
    for(const owned of clients.filter(x=>x!==observer).reverse()) {
      if(owned.connected)try{await bounded(owned.client.query('rollback'),'rollback own '+owned.kind)}catch(error){cleanupErrors.push(errorRecord(error))}
      try{await bounded(owned.client.end(),'end own '+owned.kind);owned.connected=false}catch(error){cleanupErrors.push(errorRecord(error))}
    }
    if(observer?.connected) {
      try {
        await observer.client.query('rollback');assert.deepEqual(await sessions(), [])
        if(setupCommitted) {
          const trigger=catalog.find(x=>x.kind==='trigger'),fn=catalog.find(x=>x.kind==='function'),schema=catalog.find(x=>x.kind==='schema')
          const currentTrigger=(await observer.client.query(`select t.oid::text,c.relowner::text as owner,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition
            from pg_trigger t join pg_class c on c.oid=t.tgrelid where t.tgname=$1 and t.tgrelid='public.idempotency_keys'::regclass`,[scope.trigger])).rows
          assert.deepEqual(currentTrigger,[{oid:trigger.oid,owner:trigger.owner,tgenabled:trigger.tgenabled,tgisinternal:trigger.tgisinternal,definition:trigger.definition}])
          await observer.client.query(`drop trigger ${scope.trigger} on public.idempotency_keys`)
          const currentFn=(await observer.client.query('select oid::text,proowner::text as owner,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::oid',[fn.oid])).rows
          assert.deepEqual(currentFn,[{oid:fn.oid,owner:fn.owner,definition:fn.definition}]);await observer.client.query(`drop function ${scope.schema}.receipt_wait()`)
          assert.deepEqual((await observer.client.query('select oid::text,nspowner::text as owner from pg_namespace where nspname=$1',[scope.schema])).rows,[{oid:schema.oid,owner:schema.owner}])
          for(const [table,key]of [['pg_class','relnamespace'],['pg_proc','pronamespace'],['pg_type','typnamespace']])
            assert.deepEqual((await observer.client.query(`select oid from ${table} where ${key}=$1::oid`,[schema.oid])).rows,[])
          await observer.client.query(`drop schema ${scope.schema}`)
          const ownRows=(await observer.client.query('select key,user_id from public.idempotency_keys where key=any($1::text[]) order by key',[[scope.matchingKey,scope.otherKey]])).rows
          for(const row of ownRows) {assert.equal(row.user_id,userId);assert([scope.matchingKey,scope.otherKey].includes(row.key))}
          await observer.client.query('delete from public.idempotency_keys where key=any($1::text[]) and user_id=$2',[[scope.matchingKey,scope.otherKey],userId])
          const ownUser=(await observer.client.query('select id,name from users where id=$1',[userId])).rows
          assert.deepEqual(ownUser,[{id:userId,name:`Synthetic C04 barrier control ${runId}`}])
          await observer.client.query('delete from users where id=$1',[userId])
          gates.push('exact reverse OID/owner/definition own catalog and scoped fixture cleanup')
        }
        assertNativeTriggers(await nativeTriggers(),reference.triggers)
        assert.deepEqual(await locks(),[]);assert.deepEqual(await sessions(),[])
        assert.deepEqual((await observer.client.query("select oid from pg_namespace where left(nspname,5)='c04b_'")).rows,[])
        assert.deepEqual((await observer.client.query("select oid from pg_trigger where left(tgname,6)='c04bt_'")).rows,[])
        const after=(await observer.client.query(COUNTS)).rows[0];if(before)assert.deepEqual(after,before)
        retainedAuditsAfter=(await observer.client.query(AUDITS)).rows.map(r=>({...r,at:r.at.toISOString()}));assert.deepEqual(retainedAuditsAfter,retainedAuditsBefore)
        assertIdentity((await observer.client.query(IDENTITY)).rows[0]);assertJournal((await observer.client.query('select name from pgmigrations order by name')).rows.map(x=>x.name),bindings.migrationNames)
        afterProof={counts:after,nativeTriggers:reference.triggers,barrierLocks:[],otherSessions:[],ownedCatalogRemaining:[]}
        save('postflight.json',afterProof)
        gates.push('postflight exact native FK/journal/counts and no own sessions/locks/catalog')
      }catch(error){cleanupErrors.push(errorRecord(error))}
      finally{try{await bounded(observer.client.end(),'end own observer');observer.connected=false}catch(error){cleanupErrors.push(errorRecord(error))}}
    }
    const passed=!primaryError&&!cleanupErrors.length&&gates.length===8&&clients.every(x=>!x.connected)
    const result={kind:'root_actual_C04_conditional_receipt_barrier_control',runtime:'ACTUAL_NATIVE',runId,targetURL:admission.profile.mode==='local'?URL:null,targetURLSHA256:sha(URL),targetOID:OID,
      overall:passed?'PASSED':'FAILED',identity:identity??null,directWait:directWait??null,unrelatedReceiptPassedWhileHeld,
      sourceSHA256:admission.sourceSHA256,retainedAuditsBefore:retainedAuditsBefore??null,retainedAuditsAfter:retainedAuditsAfter??null,
      before:beforeProof??null,after:afterProof??null,automaticNamespaceAdmission:false,
      namespace:NAMESPACE,gates,primaryError:primaryError??null,cleanupErrors,ownedConnectedClients:clients.filter(x=>x.connected).map(x=>({kind:x.kind,pid:x.pid})),
      status:passed?'PASSED':'FAILED',
      limitations:['No HTTP/JWT/fanout/receipt transaction acceptance','No application provider/device or full C04/C05/A12 acceptance','Namespace control is temporal evidence, not permanent reservation']}
    result.ledger=['owned-identities','preflight','committed-owned-catalog','actual-matching-wait','actual-unrelated-control','actual-matching-completion','postflight'].filter(name=>existsSync(join(directory,name+'.json'))).map(name=>({path:'barrier/'+runId+'/'+name+'.json',sha256:fileSHA(join(directory,name+'.json'))}))
    save('result.json',result);writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'})
    process.stdout.write(JSON.stringify({runId,overall:result.overall,gates:gates.length,primaryError:result.primaryError,cleanupErrors:result.cleanupErrors,artifactDirectory:directory,rootReceipt:output})+'\n')
    if(result.status!=='PASSED')process.exitCode=1
  }
}

// Importing this file for CPU checks does not load pg or connect. Native work
// requires the exact explicit root-only argument; all other arguments refuse.
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length===3&&process.argv[2]==='--run-approved-native')await runNative()
  else throw new Error('UNRUN: use the reviewed explicit root-only native command')
}
