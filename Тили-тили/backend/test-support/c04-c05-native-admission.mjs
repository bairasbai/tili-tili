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
export function assertJournal(actual,expected){assert.equal(expected.length,83);assert.equal(new Set(expected).size,83);assert.deepEqual(expected,[...expected].sort());assert.equal(expected.at(-1),'1763825000000_offer_comparison_terms');assert.deepEqual(actual,expected)}
export function inside(root,name){assert.equal(typeof name,'string');assert(!isAbsolute(name));const path=resolve(root,name),rel=relative(realpathSync(root),realpathSync(path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));return path}
export function verifySource(source){
  assert.equal(source.kind,'c04_c05_current_source83_v1');assert.equal(source.backend,realpathSync(backend));assert.equal(source.repo,realpathSync(repo));assert(source.files.length>100)
  const paths=new Set();for(const f of source.files){assert(!paths.has(f.path));paths.add(f.path);assert.equal(fileSHA(inside(repo,f.path)),f.sha256)}
  for(const path of ['Тили-тили/backend/test-support/c04-c05-native-admission.mjs','Тили-тили/backend/test-support/c04-c05-native-admission.d.mts','Тили-тили/backend/test-support/c04-c05-migrations.json','Тили-тили/backend/test-support/c04-c05-test-inverse.json','Тили-тили/backend/vitest.c04-isolated.config.ts','Тили-тили/backend/vitest.c05-worker-isolated.config.ts','Тили-тили/backend/scripts/c04-c05-isolated-lane.mjs','Тили-тили/backend/scripts/c04-c05-receipt-barrier-control.mjs','Тили-тили/backend/test-isolated/c04FanoutAdmission.test.ts','Тили-тили/backend/test-isolated/c05WorkerFinalBatch.test.ts','.github/workflows/ci.yml','init.sh'])assert(paths.has(path))
  const expected=readJSON(join(backend,'test-support/c04-c05-migrations.json'))
  verifyMigrationDirectory(join(backend,'migrations'),expected)
  verifyTestInverses()
  return expected.map(f=>f.name)
}
// Local83 requires one independently root-qualified preserving transition; no82/83 runtime union.
export function assertLocalUpgrade83(u,before,after,upgradeSource,portable82,currentSource,p,creation){
  assert.equal(p.mode,'local');assertCreation(creation,p)
  assert.equal(u.kind,'root_actual_preserving_C04_C05_local_82_to_83_v1');assert.equal(u.runtime,'ACTUAL_NATIVE');assert.equal(u.overall,'PASSED')
  assert.equal(u.targetURL,p.targetURL);assert.equal(u.targetName,p.targetName);assert.equal(u.databaseOID,p.fixedOID);assert.equal(u.creationSHA256,fileSHA(localBase+'/a12-c04-root-createdb.json'))
  assert.equal(u.migration.name,'1763825000000_offer_comparison_terms');assert.equal(u.migration.sha256,'F682B9156C28792A70F4539BBCF1799E39FED0BE71D7CFA741BAB53D2A9275BA')
  assert.equal(u.nativeMigration.exitCode,0);assert.equal(u.nativeMigration.signal,null);assert.equal(u.nativeMigration.timedOut,false);assert.equal(u.nativeMigration.spawnError,null);assert.equal(u.nativeMigration.checkOrder,true)
  assert.deepEqual(u.nativeMigration.argv,['node_modules/node-pg-migrate/bin/node-pg-migrate.js','-m','migrations','up'])
  assert(Number.isFinite(Date.parse(u.startedAt))&&Date.parse(u.finishedAt)>=Date.parse(u.startedAt))
  assert.equal(upgradeSource.kind,'c04_c05_current_source83_v1');for(const field of ['backend','repo','checkoutSHA','files'])assert.deepEqual(upgradeSource[field],currentSource[field])
  assert.equal(u.sourceSHA256,sha(JSON.stringify(upgradeSource,null,2)+'\n'))
  assert.equal(u.beforeSHA256,sha(JSON.stringify(before,null,2)+'\n'));assert.equal(u.afterSHA256,sha(JSON.stringify(after,null,2)+'\n'))
  assert.equal(u.portable82FinalProofSHA256,sha(JSON.stringify(portable82,null,2)+'\n'))
  assertIdentity(before.identity,p,creation);assertIdentity(after.identity,p,creation)
  for(const key of ['journalNames','triggers','schemaCatalog','counts','audits','otherSessions','locks'])assert.deepEqual(before[key],portable82[key])
  assert.equal(before.journalNames.length,82);assert.equal(before.journalNames.at(-1),'1763820000000_planb_system_template_keys')
  assertJournal(after.journalNames,currentSource.files.filter(f=>/^Тили-тили\/backend\/migrations\/[0-9]{13}_[^/]+\.cjs$/.test(f.path)).map(f=>f.path.split('/').at(-1).slice(0,-4)).sort())
  assert.deepEqual(after.journalNames.slice(0,-1),before.journalNames);assertFKs(before.triggers);assert.deepEqual(after.triggers,before.triggers)
  assert.equal(before.audits.length,6);assert.deepEqual(after.audits,before.audits);assert.deepEqual(after.counts,before.counts);assert(Object.values(before.counts).every(v=>v==='0'))
  for(const snapshot of [before,after]){assert.deepEqual(snapshot.otherSessions,[]);assert.deepEqual(snapshot.locks,[]);assert.deepEqual(snapshot.ownedCatalog,[])}
  const newColumns=[['offers','comparison_terms'],['deals','offer_comparison_terms_snapshot']]
  const addedColumns=after.schemaCatalog.columns.filter(c=>newColumns.some(([table,name])=>c.table_name===table&&c.column_name===name));assert.equal(addedColumns.length,2);assert(addedColumns.every(c=>c.udt_name==='jsonb'&&c.is_nullable==='YES'))
  assert.deepEqual(after.schemaCatalog.columns.filter(c=>!newColumns.some(([table,name])=>c.table_name===table&&c.column_name===name)),before.schemaCatalog.columns)
  const expectedChecks=[{"table":"deals","name":"deals_offer_comparison_terms_canonical","definitionSHA256":"E0C885165E8E315F1B7FAF686F8B7BC7308068B124BF9E22545F3A9F753415B9"},{"table":"offers","name":"offers_comparison_terms_canonical","definitionSHA256":"0D3F1D0D8B9792075D35D12E4DC4B62669565139A020B217BAB1061934E804CE"},{"table":"offers","name":"offers_decline_no_comparison_terms","definitionSHA256":"66816F719D0ECC9BDADA271ADE5D85F6DA0107CA4B8F4A0CB7B2C455AFC38614"}];const newChecks=expectedChecks.map(c=>c.name);const addedChecks=after.schemaCatalog.constraints.filter(c=>newChecks.includes(c.name));assert.deepEqual(addedChecks.map(c=>({table:c.table,name:c.name,definitionSHA256:sha(c.definition)})).sort((a,b)=>(a.table+'/'+a.name).localeCompare(b.table+'/'+b.name)),expectedChecks)
  assert.deepEqual(after.schemaCatalog.constraints.filter(c=>!newChecks.includes(c.name)),before.schemaCatalog.constraints);assert.deepEqual(after.schemaCatalog.indexes,before.schemaCatalog.indexes)
  assert.equal(before.publicTables.length,after.publicTables.length);assert.equal(new Set(before.publicTables.map(t=>t.table)).size,before.publicTables.length)
  assert(before.publicTables.some(t=>t.table==='audit_log'));assert(before.publicTables.some(t=>t.table==='pgmigrations'))
  for(const snapshot of [before,after]){const names=[...new Set(snapshot.schemaCatalog.columns.map(c=>c.table_name))].sort();assert.deepEqual(snapshot.publicTables.map(t=>t.table).sort(),names);for(const table of snapshot.publicTables){assert.deepEqual(table.columns,snapshot.schemaCatalog.columns.filter(c=>c.table_name===table.table).sort((a,b)=>a.ordinal_position-b.ordinal_position).map(c=>c.column_name));for(const row of table.rows)assert.deepEqual(Object.keys(row).sort(),[...table.columns].sort())}}
  for(const old of before.publicTables){const next=after.publicTables.find(t=>t.table===old.table);assert(next);assert.deepEqual(next.columns.filter(c=>!newColumns.some(([table,name])=>table===old.table&&name===c)),old.columns)
    const rows=next.rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>!newColumns.some(([table,name])=>table===old.table&&name===key))))
    if(old.table==='pgmigrations'){const added=rows.filter(r=>r.name==='1763825000000_offer_comparison_terms');assert.equal(added.length,1);assert.deepEqual(rows.filter(r=>r.name!=='1763825000000_offer_comparison_terms'),old.rows)}else assert.deepEqual(rows,old.rows)
  }
  assert.equal(u.publicRowsPreserved,true);assert.equal(u.auditCountBefore,6);assert.equal(u.auditCountAfter,6)
  return after
}
export function loadLocalUpgrade83(env=process.env){
  const path=env.C04_C05_LOCAL83_UPGRADE,expected=env.C04_C05_LOCAL83_UPGRADE_SHA256;assert(path&&expected,'A NEW actual root preserving83 receipt is mandatory')
  assert.match(expected,/^[A-F0-9]{64}$/);assert.equal(dirname(realpathSync(path)),realpathSync(localBase));assert(/^a12-c04-schema83-preserving-root-[a-z0-9_-]+\.json$/.test(path.slice(path.lastIndexOf('/')+1).split('\\').at(-1)));assert(!lstatSync(path).isSymbolicLink());assert.equal(fileSHA(path),expected)
  const upgrade=readJSON(path),load=key=>{const ref=upgrade.files[key];assert(ref);const rel=relative(realpathSync(localBase),realpathSync(ref.path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert(!lstatSync(ref.path).isSymbolicLink());assert.equal(fileSHA(ref.path),ref.sha256);return readJSON(ref.path)}
  for(const name of ['migrationStdout','migrationStderr']){const ref=upgrade.files[name];assert(ref);const rel=relative(realpathSync(localBase),realpathSync(ref.path));assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel));assert(!lstatSync(ref.path).isSymbolicLink());assert.equal(fileSHA(ref.path),ref.sha256)}
  return {upgrade,before:load('before'),after:load('after'),source:load('source')}
}

export function assertFKs(rows){assert.equal(rows.length,2);for(const r of rows){assert.equal(r.tgenabled,'O');assert.equal(r.tgisinternal,true);assert(r.definition.includes('RI_FKey_check_'))}}
const entryShape=entry=>({name:entry.name,kind:entry.isSymbolicLink()?'symlink':entry.isFile()?'file':entry.isDirectory()?'directory':'other'})
const sortedEntries=entries=>entries.map(entryShape).sort((a,b)=>a.name.localeCompare(b.name))
export function assertMigrationFiles(actual,expected){
  assertJournal(expected.map(f=>f.name),expected.map(f=>f.name))
  const entries=[...expected.map(f=>({name:f.name+'.cjs',kind:'file'})),{name:'data',kind:'directory'}].sort((a,b)=>a.name.localeCompare(b.name))
  assert.deepEqual(sortedEntries(actual),entries,'Only exact83 reviewed migration files and the required data directory are admitted')
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
  const bundle=readJSON(file);assert.equal(bundle.kind,'c04_c05_native_admission83_v1');assert.equal(bundle.stage,stage);assert.equal(bundle.phase,phase);assert.equal(bundle.profile,profile.mode)
  const load=name=>{const f=bundle.files[name];assert(f);assert.equal(fileSHA(inside(directory,f.path)),f.sha256);return readJSON(inside(directory,f.path))}
  const creation=load('creation'),schema=load('schema'),source=load('source'),sourceSHA256=bundle.files.source.sha256
  assert.equal(schema.kind,'c04_c05_actual_schema83_v1')
  assertCreation(creation,profile);const names=verifySource(source);assert.equal(schema.sourceSHA256,sourceSHA256);assert.equal(schema.creationSHA256,bundle.files.creation.sha256);assertJournal(schema.journalNames,names);assert.equal(schema.migrationCount,83);assertFKs(schema.triggers)
  assert.equal(schema.identity.oid,creation.databaseOID);assert.equal(schema.identity.name,profile.targetName);assert.equal(schema.identity.username,profile.username);assert.equal(schema.identity.port,profile.port)
  if(profile.mode==='github-ci'){assert.equal(creation.source.inputsSHA256,sourceSHA256);assert.equal(schema.identity.address,creation.actualAdmin.address);assert.equal(schema.identity.ownerRoleOID,creation.targetOwnerRoleOID);assert.equal(source.checkoutSHA,profile.context.checkoutSHA)}
  if(profile.mode==='local'){const upgrade=load('upgrade'),before=load('upgradeBefore'),after=load('upgradeAfter'),upgradeSource=load('upgradeSource'),portable=load('portable82');assertLocalUpgrade83(upgrade,before,after,upgradeSource,portable,source,profile,creation);assert.deepEqual(schema.catalog,after.schemaCatalog);assert.deepEqual(schema.triggers,after.triggers);for(const audit of after.audits)assert.deepEqual(schema.retainedAudits.find(r=>r.id===audit.id),audit)}
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
