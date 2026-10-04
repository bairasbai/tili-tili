import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, readdirSync, lstatSync } from 'node:fs'
import { dirname, join, resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'

export const NAMESPACE=2147483001, QUOTA=4210005
// Native migration seeds are required source inputs, not executable migrations.
export const MIGRATION_DATA=[{"name":"categories.json","sha256":"9FF447728CE1A2C00B681E73407F216C5D4258BC297D8261EC6F81AF776E9212"},{"name":"cities.json","sha256":"3646863DF60BCFB89EB119E5855AF02506C2BFE4EBFC7C5238FA895F43F7F332"}]
export const backend=resolve(dirname(fileURLToPath(import.meta.url)),'..')
export const repo=resolve(backend,'../..')
export const sha=value=>createHash('sha256').update(value).digest('hex').toUpperCase()
export const fileSHA=path=>sha(readFileSync(path))
export const readJSON=path=>JSON.parse(readFileSync(path,'utf8'))
const oid=value=>assert.match(value,/^[1-9][0-9]*$/)
const localBase='C:/Тили-тили/.unlazy/codex-planb-20261003'
const localName='tili_ecosystem_c04batch_20261003_test'
const LOOPBACK=['127.0.0.1','::1','::ffff:127.0.0.1']
export function selectProfile(env=process.env){
  const mode=env.C04_C05_NATIVE_PROFILE
  if(mode==='local'){
    assert.notEqual(env.GITHUB_ACTIONS,'true','CI cannot use local admission')
    return {mode,targetName:localName,targetURL:'postgres://codex_test@127.0.0.1:15432/'+localName,username:'codex_test',port:15432,fixedOID:'616406'}
  }
  assert.equal(mode,'github-ci','Explicit closed local or github-ci profile required')
  assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.GITHUB_WORKFLOW,'CI');assert.equal(env.GITHUB_JOB,'backend');assert.equal(env.GITHUB_REPOSITORY,'bairasbai/tili-tili')
  for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])assert.match(env[key],/^[1-9][0-9]{0,19}$/)
  assert.match(env.GITHUB_SHA,/^[0-9a-f]{40}$/);assert.match(env.C04_C05_CI_POSTGRES_CONTAINER_ID,/^[0-9a-f]{12,64}$/)
  const targetName=`tili_c04_c05_${env.GITHUB_RUN_ID}_${env.GITHUB_RUN_ATTEMPT}_test`;assert(targetName.length<=63)
  return {mode,targetName,targetURL:'postgres://tili:tili@127.0.0.1:5432/'+targetName,adminURL:'postgres://tili:tili@127.0.0.1:5432/postgres',username:'tili',port:5432,
    context:{workflow:'CI',job:'backend',repository:env.GITHUB_REPOSITORY,runID:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,checkoutSHA:env.GITHUB_SHA,postgresContainerID:env.C04_C05_CI_POSTGRES_CONTAINER_ID}}
}
export function assertTestURLs(env,p){assert.equal(env.DATABASE_URL,p.targetURL);assert.equal(env.TEST_DATABASE_URL,p.targetURL)}
export function assertCreation(c,p){
  assert.equal(c.absentBeforeCreate,true);assert.equal(c.beforeRowCount,0);assert.equal(c.targetName,p.targetName);oid(c.databaseOID)
  if(p.mode==='local'){
    assert.equal(c.kind,'root_actual_absent_before_create');assert.equal(c.targetURL,p.targetURL);assert.equal(c.databaseOID,p.fixedOID)
    assert.equal(c.actualMain,'03f41a0f12bbd369450501fb30e2381972b15b0c');assert.equal(c.actualAdmin.database,'postgres');assert.equal(c.actualAdmin.username,'codex_test');assert.equal(c.actualAdmin.port,15432);assert.equal(c.actualAdmin.address,'127.0.0.1')
  }else{
    assert.equal(c.kind,'c04_c05_ci_absent_before_create_v1');assert.deepEqual(c.context,p.context);assert.equal(c.targetURLSHA256,sha(p.targetURL));assert.equal(c.source.checkoutSHA,p.context.checkoutSHA);assert.match(c.source.inputsSHA256,/^[A-F0-9]{64}$/)
    assert.equal(c.actualAdmin.database,'postgres');assert.equal(c.actualAdmin.username,'tili');assert.equal(c.actualAdmin.port,5432);oid(c.actualAdmin.roleOID);assert.equal(c.targetOwnerRoleOID,c.actualAdmin.roleOID)
    assert.equal(c.actualAdmin.version.startsWith('16.'),true);assert.equal(c.actualAdmin.createPrivilege,true)
    assert.equal(c.service.id,p.context.postgresContainerID);assert.equal(c.service.image,'postgres:16-alpine');assert(c.service.hostBindings.some(b=>b.containerPort===5432&&b.hostPort===5432))
    assert(c.service.addresses.length>0&&c.service.addresses.every(a=>isIP(a)>0));assert(c.service.addresses.includes(c.actualAdmin.address))
    assert(Number.isFinite(Date.parse(c.beforeAt))&&Date.parse(c.createdAt)>=Date.parse(c.beforeAt))
  }
}
export function assertIdentity(row,p,c){assertCreation(c,p);assert.equal(row.name,p.targetName);assert.equal(row.username,p.username);assert.equal(row.port,p.port);assert.equal(row.oid,c.databaseOID);assert(Number.isInteger(row.pid)&&row.pid>0)
  if(p.mode==='local')assert(LOOPBACK.includes(row.address));else assert.equal(row.address,c.actualAdmin.address)
}
export function assertJournal(actual,expected){assert.equal(expected.length,82);assert.equal(new Set(expected).size,82);assert.deepEqual(expected,[...expected].sort());assert.equal(expected.at(-1),'1763820000000_planb_system_template_keys');assert.deepEqual(actual,expected)}
export function inside(root,name){assert.equal(typeof name,'string');assert(!isAbsolute(name));const path=resolve(root,name),rel=relative(realpathSync(root),realpathSync(path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return path}
export function verifySource(source){
  assert.equal(source.kind,'c04_c05_current_source_v1');assert.equal(source.backend,realpathSync(backend));assert.equal(source.repo,realpathSync(repo));assert(source.files.length>100)
  const paths=new Set();for(const f of source.files){assert(!paths.has(f.path));paths.add(f.path);assert.equal(fileSHA(inside(repo,f.path)),f.sha256)}
  for(const path of ['Тили-тили/backend/test-support/c04-c05-native-admission.mjs','Тили-тили/backend/test-support/c04-c05-native-admission.d.mts','Тили-тили/backend/test-support/c04-c05-migrations.json','Тили-тили/backend/test-support/c04-c05-test-inverse.json','Тили-тили/backend/vitest.c04-isolated.config.ts','Тили-тили/backend/vitest.c05-worker-isolated.config.ts','Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs','Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs','Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts','Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts','.github/workflows/ci.yml','init.sh'])assert(paths.has(path))
  const expected=readJSON(join(backend,'test-support/c04-c05-migrations.json'))
  verifyMigrationDirectory(join(backend,'migrations'),expected)
  verifyTestInverses()
  return expected.map(f=>f.name)
}
export function assertFKs(rows){assert.equal(rows.length,2);for(const r of rows){assert.equal(r.tgenabled,'O');assert.equal(r.tgisinternal,true);assert(r.definition.includes('RI_FKey_check_'))}}
const entryShape=entry=>({name:entry.name,kind:entry.isSymbolicLink()?'symlink':entry.isFile()?'file':entry.isDirectory()?'directory':'other'})
const sortedEntries=entries=>entries.map(entryShape).sort((a,b)=>a.name.localeCompare(b.name))
export function assertMigrationFiles(actual,expected){
  assertJournal(expected.map(f=>f.name),expected.map(f=>f.name))
  const entries=[...expected.map(f=>({name:f.name+'.cjs',kind:'file'})),{name:'data',kind:'directory'}].sort((a,b)=>a.name.localeCompare(b.name))
  assert.deepEqual(sortedEntries(actual),entries,'Only exact82 reviewed migration files and the required data directory are admitted')
}
export function verifyMigrationDirectory(directory,expected){
  const root=lstatSync(directory);assert(root.isDirectory()&&!root.isSymbolicLink(),'Migration root must be a real directory')
  assertMigrationFiles(readdirSync(directory,{withFileTypes:true}),expected)
  for(const f of expected)assert.equal(fileSHA(join(directory,f.name+'.cjs')),f.sha256)
  const data=join(directory,'data'),stat=lstatSync(data);assert(stat.isDirectory()&&!stat.isSymbolicLink(),'Migration data must be a real directory')
  assert.deepEqual(sortedEntries(readdirSync(data,{withFileTypes:true})),MIGRATION_DATA.map(f=>({name:f.name,kind:'file'})),'Only the two reviewed regular seed data files are admitted')
  for(const f of MIGRATION_DATA)assert.equal(fileSHA(join(data,f.name)),f.sha256)
  return expected.map(f=>f.name)
}
export function verifyTestInverses(){
  const ledger=readJSON(join(backend,'test-support/c04-c05-test-inverse.json')).ledger
  assert.equal(ledger.length,4)
  const expected=['E7D300AEE242A3249382A09AC602667B4B828E6F11A0F369256CF22605436629','53B81479D2FBBE6EC6507A561B336F5E0EAB02DE515375FDE16DEA9C7538DF96','A6E04C24385EB3956B2688749057C67C11B3EEB109E4CEAE715A4574CADDBB0B','A7ED2624198A76367260F7325962835AE827E49BF219ABB5B680F998117305D1']
  const targets=['backend/test-isolated/c04FanoutAdmission.test.ts','backend/test-isolated/c05WorkerFinalBatch.test.ts','backend/vitest.c04-isolated.config.ts','backend/vitest.c05-worker-isolated.config.ts']
  for(let i=0;i<ledger.length;i++){
    const row=ledger[i];assert.equal(row.target,targets[i]);assert.equal(row.originalSHA256,expected[i]);let bytes=readFileSync(join(backend,row.target.slice('backend/'.length)),'utf8');assert.equal(sha(bytes),row.candidateSHA256)
    for(const r of [...row.replacements].reverse()){assert(r.new);assert.equal(bytes.split(r.new).length,2);bytes=bytes.replace(r.new,r.old)}assert.equal(sha(bytes),expected[i])
  }
}
export function assertControl(control,admission){
  assert.equal(control.kind,'root_actual_C04_conditional_receipt_barrier_control');assert.equal(control.runtime,'ACTUAL_NATIVE');assert.equal(control.overall,'PASSED');assert.equal(control.status,'PASSED');assert.equal(control.targetOID,admission.creation.databaseOID);assert.equal(control.namespace,NAMESPACE)
  assert.equal(control.targetURLSHA256,sha(admission.profile.targetURL))
  assert.equal(control.gates.length,8);assert.deepEqual(control.cleanupErrors,[]);assert.equal(control.primaryError,null);assert.deepEqual(control.ownedConnectedClients,[]);assert.equal(control.unrelatedReceiptPassedWhileHeld,true);assert.equal(control.automaticNamespaceAdmission,false)
  assertIdentity(control.identity,admission.profile,admission.creation)
  const w=control.directWait;assert(Number.isInteger(w.applicationPID)&&Number.isInteger(w.controllerPID)&&w.applicationPID!==w.controllerPID);assert.deepEqual(w.blockers,[w.controllerPID]);assert.equal(w.state,'active');assert.equal(w.waitEventType,'Lock')
  assert(w.locks.some(l=>l.pid===w.applicationPID&&!l.granted&&l.database===control.targetOID&&l.classid===String(NAMESPACE)&&l.objid==='1'&&l.objsubid===2));assert(w.locks.some(l=>l.pid===w.controllerPID&&l.granted&&l.database===control.targetOID&&l.classid===String(NAMESPACE)&&l.objid==='1'&&l.objsubid===2))
  assert.deepEqual(control.before.counts,control.after.counts);assert.deepEqual(control.before.nativeTriggers,control.after.nativeTriggers);assert.deepEqual(control.after.barrierLocks,[]);assert.deepEqual(control.after.otherSessions,[]);assert.deepEqual(control.after.ownedCatalogRemaining,[])
  assert.deepEqual(control.retainedAuditsBefore,control.retainedAuditsAfter);assert.equal(control.sourceSHA256,admission.sourceSHA256)
  assert.match(control.runId,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  const names=['owned-identities','preflight','committed-owned-catalog','actual-matching-wait','actual-unrelated-control','actual-matching-completion','postflight'];assert.equal(control.ledger.length,names.length)
  const raw={};for(let i=0;i<names.length;i++){const entry=control.ledger[i];assert.equal(entry.path,'barrier/'+control.runId+'/'+names[i]+'.json');const file=inside(admission.directory,entry.path);assert.equal(fileSHA(file),entry.sha256);raw[names[i]]=readJSON(file)}
  assert.deepEqual(raw.preflight,control.before);assert.deepEqual(raw.postflight,control.after);assert.deepEqual(raw['actual-matching-wait'],control.directWait)
  assertJournal(raw.preflight.journal,admission.schema.journalNames)
  assertFKs(raw.preflight.nativeTriggers);assertFKs(raw.postflight.nativeTriggers)
  assert.deepEqual(raw.preflight.nativeTriggers,admission.schema.triggers);assert.deepEqual(raw.postflight.nativeTriggers,admission.schema.triggers)
  const own=raw['owned-identities'];assert.equal(own.runId,control.runId);assert.equal(own.targetOID,admission.creation.databaseOID);assert.equal(own.namespace,NAMESPACE);assert.match(own.schema,/^c04b_[0-9a-f]{32}$/);assert.match(own.trigger,/^c04bt_[0-9a-f]{32}$/)
  assert.equal(own.targetURLSHA256,sha(admission.profile.targetURL))
  const unrelated=raw['actual-unrelated-control'];assert.equal(unrelated.matchingStillUnsettled,true);assert.equal(unrelated.controllerStillHeld,true);assert.deepEqual(unrelated.rows,[{key:own.otherKey,status:200,body:{barrierControlRun:control.runId,kind:'unrelated'}}])
  assert.deepEqual(raw['actual-matching-completion'].rows,[{key:own.matchingKey,status:200,body:{barrierControlRun:control.runId,kind:'matching'}}])
  const catalog=raw['committed-owned-catalog'].catalog;assert.deepEqual(catalog.map(r=>r.kind),['schema','function','trigger']);for(const r of catalog){oid(r.oid);oid(r.owner)}assert.equal(catalog[2].tgenabled,'O');assert.equal(catalog[2].tgisinternal,false);assert(catalog[2].definition.includes(own.matchingKey));assert(catalog[1].definition.includes('pg_advisory_xact_lock('+NAMESPACE+',1)'))
}
export function readAdmission(stage,env=process.env){
  assert(['barrier','tests'].includes(stage));const profile=selectProfile(env),file=env.C04_C05_ADMISSION
  assert(file,'Parent-generated admission bundle required');const phase=stage==='barrier'?'barrier':env.C04_C05_ADMISSION_PHASE;assert(['barrier','c04','worker'].includes(phase));const directory=realpathSync(dirname(resolve(file)));assert.equal(resolve(file),join(directory,phase+'-admission.json'))
  if(profile.mode==='github-ci')assert.equal(directory,realpathSync(join(backend,'.ci/c04-c05-native',profile.context.runID+'-'+profile.context.attempt)))
  else{assert.equal(realpathSync(backend),realpathSync('C:/Тили-тили/tili-orchestrate-publish-20261003/Тили-тили/backend'));assert.equal(dirname(directory),realpathSync(localBase));assert.match(directory.slice(dirname(directory).length+1),/^c04-c05-ported-local-[0-9a-f-]{36}$/)}
  const bundle=readJSON(file);assert.equal(bundle.kind,'c04_c05_native_admission_v1');assert.equal(bundle.stage,stage);assert.equal(bundle.phase,phase);assert.equal(bundle.profile,profile.mode)
  const load=name=>{const f=bundle.files[name];assert(f);assert.equal(fileSHA(inside(directory,f.path)),f.sha256);return readJSON(inside(directory,f.path))}
  const creation=load('creation'),schema=load('schema'),source=load('source'),sourceSHA256=bundle.files.source.sha256
  assert.equal(schema.kind,'c04_c05_actual_schema_v1')
  assertCreation(creation,profile);const names=verifySource(source);assert.equal(schema.sourceSHA256,sourceSHA256);assert.equal(schema.creationSHA256,bundle.files.creation.sha256);assertJournal(schema.journalNames,names);assert.equal(schema.migrationCount,82);assertFKs(schema.triggers)
  assert.equal(schema.identity.oid,creation.databaseOID);assert.equal(schema.identity.name,profile.targetName);assert.equal(schema.identity.username,profile.username);assert.equal(schema.identity.port,profile.port)
  if(profile.mode==='github-ci'){assert.equal(creation.source.inputsSHA256,sourceSHA256);assert.equal(schema.identity.address,creation.actualAdmin.address);assert.equal(schema.identity.ownerRoleOID,creation.targetOwnerRoleOID);assert.equal(source.checkoutSHA,profile.context.checkoutSHA)}
  const admission={profile,creation,schema,source,sourceSHA256,directory,files:bundle.files,targetName:profile.targetName,targetURL:profile.targetURL,oid:creation.databaseOID,stage}
  if(stage==='tests'){const control=load('control');assertControl(control,admission);admission.control=control;assertTestURLs(env,profile);assert.equal(env.C04_BATCH_BARRIER_NAMESPACE_ADMITTED,String(NAMESPACE))}
  return admission
}
export const IDENTITY=`select current_database() as name,current_user as username,inet_server_port() as port,host(inet_server_addr()) as address,pg_backend_pid() as pid,
  (select oid::text from pg_database where datname=current_database()) as oid,(select datdba::text from pg_database where datname=current_database()) as "ownerRoleOID"`
export const TRIGGERS=`select t.oid::text,t.tgname,t.tgenabled,t.tgisinternal,pg_get_triggerdef(t.oid) as definition from pg_trigger t where t.tgrelid='public.idempotency_keys'::regclass order by t.tgname`
export const AUDITS='select id::text,actor_id,action,entity,entity_id,at from audit_log order by id'
export const SCHEMA_CATALOG=`select
  (select coalesce(jsonb_agg(to_jsonb(c) order by c.table_name,c.ordinal_position),'[]'::jsonb) from information_schema.columns c where c.table_schema='public') as columns,
  (select coalesce(jsonb_agg(jsonb_build_object('oid',c.oid::text,'name',c.conname,'table',c.conrelid::regclass::text,'definition',pg_get_constraintdef(c.oid)) order by c.oid),'[]'::jsonb) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='public') as constraints,
  (select coalesce(jsonb_agg(jsonb_build_object('oid',i.indexrelid::text,'definition',pg_get_indexdef(i.indexrelid)) order by i.indexrelid),'[]'::jsonb) from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public') as indexes`
export async function inspectNative(client,admission,allowedTags=[]){
  const identity=(await client.query(IDENTITY)).rows[0];assertIdentity(identity,admission.profile,admission.creation)
  const otherSessions=(await client.query('select pid,application_name,state from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and not(application_name=any($1::text[])) order by pid',[allowedTags])).rows;assert.deepEqual(otherSessions,[])
  const journalNames=(await client.query('select name from pgmigrations order by name')).rows.map(r=>r.name);assertJournal(journalNames,verifySource(admission.source))
  const triggers=(await client.query(TRIGGERS)).rows;assertFKs(triggers);assert.deepEqual(triggers,admission.schema.triggers)
  const schemaCatalog=(await client.query(SCHEMA_CATALOG)).rows[0];assert.deepEqual(schemaCatalog,admission.schema.catalog)
  assert.deepEqual((await client.query("select oid from pg_namespace where left(nspname,5)='c04b_' order by nspname")).rows,[])
  assert.deepEqual((await client.query("select oid from pg_trigger where left(tgname,6)='c04bt_' order by tgname")).rows,[])
  const locks=(await client.query('select pid,classid::text,objid::text,granted from pg_locks where locktype=\'advisory\' and database=$1::oid and classid=any($2::oid[]) order by pid,classid,objid',[admission.oid,[String(NAMESPACE),String(QUOTA)]])).rows;assert.deepEqual(locks,[])
  const counts=(await client.query(`select (select count(*)::text from users) as users,(select count(*)::text from weddings) as weddings,(select count(*)::text from vendors) as vendors,
    (select count(*)::text from sessions) as sessions,(select count(*)::text from consents) as consents,(select count(*)::text from notification_prefs) as prefs,
    (select count(*)::text from idempotency_keys) as keys,(select count(*)::text from notifications) as notices,(select count(*)::text from push_subscriptions) as subscriptions,
    (select count(*)::text from notification_push_deliveries) as deliveries`)).rows[0];assert(Object.values(counts).every(v=>v==='0'))
  const audits=(await client.query(AUDITS)).rows.map(r=>({...r,at:r.at.toISOString()}))
  return {identity,journalNames,triggers,schemaCatalog,counts,audits,otherSessions,locks,ownedCatalog:[]}
}
export async function assertNativeAdmission(client,a,allowedTags=[]){const current=await inspectNative(client,a,allowedTags);assert.deepEqual(current.audits,a.schema.retainedAudits);return current}
