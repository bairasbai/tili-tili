import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync, readdirSync, createWriteStream } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backend,repo,selectProfile,assertCreation,assertIdentity,assertJournal,assertFKs,assertControl,inspectNative,verifySource,sha,fileSHA,readJSON,IDENTITY,TRIGGERS,AUDITS,SCHEMA_CATALOG,NAMESPACE,assertLocalUpgrade83,loadLocalUpgrade83,profileMigrationCount } from '../test-support/c04-c05-native-admission.mjs'

const localBase='C:/Тили-тили/.unlazy/codex-planb-20261003'
const localInputs={creation:[localBase+'/a12-c04-root-createdb.json','0FAE33852E797024F9D56680D3D34BC7EB89851DE89D3EF75F4BC7A80A93B708'],schema:[localBase+'/a12-c04-root-schema382.json','D2E41E7104378348A3BB0AB95EF2DECF0B25091C6F806BBDE58D150B711EAC4E'],qualification:[localBase+'/a12-c04-native-green-v2-root-3/qualified-root-1.json','E3B1B9BC7E25BCDEE61E2F72778E52DA1A30EEDBC2DD6DB4481B973D2B1FF0DF']}
localInputs.worker=[localBase+'/a12-c05-worker-native-v1-root-1/qualified-root-1.json','B441D4EF0748C6260276A26E65571648EC3A725AE0D713B723AAE9FFB9D0A1F7']
localInputs.portable=[localBase+'/a12-portable-ci-v2-native-qualified-root-1.json','AEECC1A0D2D09A3835C3E003E050C6B2186C237C405E1E3A667A6F060A65C60F']
localInputs.portableFinal=[localBase+'/c04-c05-ported-local-e6ca386c-0692-40d8-8cdc-56b1a31e8349/final.json','54036A06A5B1D63374A076B6F27747DC7ABDB2235BE73862A42FF2AB657145D0']
const err=e=>({name:e.name,message:e.message,code:e.code??null,stack:e.stack})
export function sanitizedService(inspect,id){
  assert.equal(inspect.Id,id);assert.equal(inspect.Config.Image,'postgres:16-alpine');assert.equal(inspect.State.Running,true);assert.equal(inspect.State.Health.Status,'healthy')
  const bindings=inspect.NetworkSettings.Ports['5432/tcp'];assert(Array.isArray(bindings)&&bindings.length>0)
  const hostBindings=bindings.map(b=>({containerPort:5432,hostPort:Number(b.HostPort),hostIP:b.HostIp}));assert(hostBindings.some(b=>b.hostPort===5432))
  const addresses=[...new Set(Object.values(inspect.NetworkSettings.Networks).flatMap(n=>[n.IPAddress,n.GlobalIPv6Address]).filter(Boolean))]
  return {id,image:inspect.Config.Image,hostBindings,addresses}
}
export function qualifyJSON(result,count){
  assert.equal(result.numTotalTests,count);assert.equal(result.numPendingTests,0);assert.equal(result.numTodoTests,0);assert.equal(result.testResults.length,1)
  const assertions=result.testResults[0].assertionResults;assert.equal(assertions.length,count);assert(assertions.every(r=>['passed','failed'].includes(r.status)))
  assert(assertions.every(r=>typeof r.fullName==='string'&&r.fullName.length>0));assert.equal(new Set(assertions.map(r=>r.fullName)).size,count)
  const passed=assertions.filter(r=>r.status==='passed').length,failed=assertions.filter(r=>r.status==='failed').length;assert.equal(result.numPassedTests,passed);assert.equal(result.numFailedTests,failed);assert.equal(passed+failed,count)
  return {total:count,passed,failed,pending:0,todo:0}
}
export function extendAudits(before,after,owned){
  const previous=new Map(before.map(r=>[r.id,r]));assert.equal(previous.size,before.length)
  const current=new Map(after.map(r=>[r.id,r]));assert.equal(current.size,after.length)
  for(const r of before)assert.deepEqual(current.get(r.id),r)
  const added=after.filter(r=>!previous.has(r.id));for(const r of added)assert(owned.has(r.actor_id)||owned.has(r.entity_id),'Unowned new immutable audit row')
  return added
}
function captureSource(profile){
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',timeout:10000}).trim();assert.match(head,/^[0-9a-f]{40}$/)
  if(profile.mode==='github-ci'){assert.equal(realpathSync(repo),realpathSync(process.env.GITHUB_WORKSPACE));assert.equal(head,profile.context.checkoutSHA);assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:repo,encoding:'utf8',timeout:10000}),'')}
  const paths=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:repo,encoding:'utf8',timeout:10000}).split('\0').filter(Boolean)
    .filter(p=>!p.includes('/.ci/')&&!p.includes('/node_modules/')&&!p.includes('/dist/'))
  const files=[...new Set(paths)].sort().map(path=>({path,sha256:fileSHA(join(repo,path))}))
  const source={kind:`c04_c05_current_source${profileMigrationCount(profile)}_v1`,at:new Date().toISOString(),backend:realpathSync(backend),repo:realpathSync(repo),checkoutSHA:head,files};verifySource(source);return source
}
function witnesses(log,prefix){return log.split(/\r?\n/).filter(line=>line.includes(prefix)).map(line=>JSON.parse(line.slice(line.indexOf(prefix)+prefix.length)))}
export function qualifyWitnesses(phase,rows){
  if(phase==='c04'){
    const waits=rows.filter(r=>r.event==='real-wait');assert.equal(waits.length,7);for(const w of waits){assert.notEqual(w.row.pid,w.holder);assert.deepEqual(w.row.blockers,[w.holder])}
    assert.equal(rows.filter(r=>r.event==='actual-exp-crossed').length,2);for(const r of rows.filter(r=>r.event==='actual-exp-crossed'))assert(Date.parse(r.at)/1000>=r.exp)
    const batches=rows.filter(r=>r.event==='actual-batch');assert.equal(batches.length,12);assert.equal(new Set(batches.map(r=>r.owner)).size,12)
    const faults=rows.filter(r=>r.case==='second-notice-real-error');assert.equal(faults.length,4);for(const r of faults){assert.equal(r.sqlState,'22012');assert.equal(r.status,500);assert.deepEqual(r.after,r.before)}
    const scope=rows.filter(r=>r.case==='subscription-source-change'||r.case==='subscription-delete-source-change');assert.equal(scope.length,3);for(const r of scope)assert.equal(r.status,409)
    const capacity=rows.filter(r=>r.case==='final-domain-capacity');assert.equal(capacity.length,3);for(const r of capacity)assert.deepEqual(r.observedDays,r.expectedFinalDomainDays)
    assert.equal(rows.filter(r=>r.event==='owned-catalog-removed').length,6)
    const before=rows.find(r=>r.event==='audit-retention-before-cleanup'),cleanup=rows.find(r=>r.event==='cleanup');assert(before&&cleanup);assert(Object.values(cleanup.counts).every(v=>v==='0'));assert.deepEqual(cleanup.retainedAudits,before.rows)
  }else{
    assert.equal(rows.filter(r=>r.event==='completed-first-native-locator').length,5)
    const waits=rows.filter(r=>r.event==='actual-direct-blocker');assert.equal(waits.length,2);for(const r of waits){assert.notEqual(r.pid,r.holder);assert.deepEqual(r.blockers,[r.holder])}
    const faults=rows.filter(r=>r.event==='real-post-update-failure');assert.equal(faults.length,1);assert.equal(faults[0].sqlstate,'22012');assert(Number.isInteger(faults[0].meta.pid));assert.equal(typeof faults[0].meta.xid,'string')
    assert.equal(rows.filter(r=>r.event==='completed-native-original-parent').length,1)
    const clean=rows.filter(r=>r.event==='owned-cleanup');assert(clean.length>=19);for(const r of clean)assert(Object.values(r.counts).every(v=>v==='0'))
  }
}
async function main(){
  const profile=selectProfile(),expected=profile.mode==='github-ci'?['--github-ci','--run-approved-native']:['--local','--run-approved-native'];assert.deepEqual(process.argv.slice(2),expected)
  assert(!process.env.NODE_OPTIONS,'No source loader override in the native lane');assert(!process.env.PGOPTIONS,'No database search-path/options override')
  assert.equal(realpathSync(process.cwd()),realpathSync(backend),'Run from the adopted backend only')
  let directory
  if(profile.mode==='github-ci')directory=join(backend,'.ci/c04-c05-native',profile.context.runID+'-'+profile.context.attempt)
  else{assert.equal(realpathSync(backend),realpathSync('C:/Тили-тили/tili-orchestrate-publish-20261003/Тили-тили/backend'));assert(process.env.C04_C05_NATIVE_OUTPUT);directory=resolve(process.env.C04_C05_NATIVE_OUTPUT);assert.equal(dirname(directory),realpathSync(localBase));assert.match(directory.slice(dirname(directory).length+1),/^c04-c05-ported-local-[0-9a-f-]{36}$/)}
  assert(!existsSync(directory),'Never overwrite evidence or reuse a CI attempt');mkdirSync(directory,{recursive:true})
  const save=(name,value)=>{const path=join(directory,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{flag:'wx'});return {path:name,sha256:fileSHA(path)}}
  const childRecords=[]
  async function child(label,args,env,timeout){
    const dir=join(directory,label);mkdirSync(dir,{recursive:true});const stdout=createWriteStream(join(dir,'stdout.log'),{flags:'wx'}),stderr=createWriteStream(join(dir,'stderr.log'),{flags:'wx'})
    const flushed=Promise.all([stdout,stderr].map(stream=>new Promise((r,reject)=>{stream.once('finish',r);stream.once('error',reject)})))
    void flushed.catch(()=>{}) // Keep early file errors handled until awaited below.
    let timedOut=false,spawnError=null,killTimer;const at=new Date().toISOString()
    const result=await new Promise(resolveDone=>{const p=spawn(process.execPath,args,{cwd:backend,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});p.stdout.pipe(stdout);p.stderr.pipe(stderr)
      const deadline=setTimeout(()=>{timedOut=true;p.kill('SIGTERM');killTimer=setTimeout(()=>p.kill('SIGKILL'),15000)},timeout)
      p.on('error',e=>{spawnError=err(e)});p.on('close',(exitCode,signal)=>{clearTimeout(deadline);clearTimeout(killTimer);resolveDone({at,endedAt:new Date().toISOString(),pid:p.pid??null,exitCode,signal,timedOut,spawnError})})
    });await flushed;childRecords.push({label,...result});save(label+'/execution.json',result);return result
  }
  let primaryError=null,creation,schema,source,sourceRef,creationRef,schemaRef,controlRef,phaseResults={},lastAudits=[],finalProof=null,localTriggers=null,localUpgrade=null
  const {Client}=createRequire(join(backend,'package.json'))('pg')
  async function connect(url,tag){const c=new Client({connectionString:url,application_name:tag,connectionTimeoutMillis:5000,statement_timeout:15000,query_timeout:18000});try{await c.connect();return c}catch(e){await c.end().catch(()=>{});throw e}}
  const admission=()=>({profile,creation,schema,source,sourceSHA256:sourceRef.sha256,directory,oid:creation.databaseOID})
  async function nativeClean(){const c=await connect(profile.targetURL,'c04ci_post_'+randomUUID());try{return await inspectNative(c,admission())}finally{await c.end()}}
  function bundle(stage,phase,control){return save(phase+'-admission.json',{kind:`c04_c05_native_admission${profileMigrationCount(profile)}_v1`,stage,phase,profile:profile.mode,files:{creation:creationRef,schema:schemaRef,source:sourceRef,...(localUpgrade?localUpgrade.refs:{}),...(control?{control}: {})}})}
  try{
    save('invocation.json',{kind:'c04_c05_explicit_native_invocation',at:new Date().toISOString(),profile:profile.mode,context:profile.context??null,argv:expected,automaticAdmission:false})
    source=captureSource(profile);sourceRef=save('source.json',source)
    if(profile.mode==='github-ci'){
      const raw=JSON.parse(execFileSync('docker',['inspect',profile.context.postgresContainerID],{encoding:'utf8',timeout:10000}));assert.equal(raw.length,1);const service=sanitizedService(raw[0],profile.context.postgresContainerID);save('service.json',service)
      const admin=await connect(profile.adminURL,'c04ci_create_'+randomUUID());try{
        const a=(await admin.query(`select current_database() as database,current_user as username,inet_server_port() as port,host(inet_server_addr()) as address,
          (select oid::text from pg_roles where rolname=current_user) as "roleOID",current_setting('server_version') as version,
          (select rolcreatedb or rolsuper from pg_roles where rolname=current_user) as "createPrivilege"`)).rows[0]
        assert.equal(a.database,'postgres');assert.equal(a.username,'tili');assert.equal(a.port,5432);assert(a.version.startsWith('16.'));assert.equal(a.createPrivilege,true);assert(service.addresses.includes(a.address))
        const beforeAt=new Date().toISOString(),before=(await admin.query('select oid::text,datdba::text from pg_database where datname=$1',[profile.targetName])).rows;assert.deepEqual(before,[],'Fresh CI name must be absent; never reuse')
        save('absent-before-create.json',{beforeAt,targetName:profile.targetName,rows:before})
        assert.match(profile.targetName,/^tili_c04_c05_[1-9][0-9]{0,19}_[1-9][0-9]{0,19}_test$/)
        await admin.query('create database "'+profile.targetName+'" template template0')
        const owned=(await admin.query('select oid::text,datdba::text from pg_database where datname=$1',[profile.targetName])).rows;assert.equal(owned.length,1);assert.equal(owned[0].datdba,a.roleOID)
        creation={kind:'c04_c05_ci_absent_before_create_v1',context:profile.context,targetName:profile.targetName,targetURLSHA256:sha(profile.targetURL),databaseOID:owned[0].oid,targetOwnerRoleOID:owned[0].datdba,actualAdmin:a,service,absentBeforeCreate:true,beforeRowCount:0,beforeAt,createdAt:new Date().toISOString(),source:{checkoutSHA:source.checkoutSHA,inputsSHA256:sourceRef.sha256}}
      }finally{await admin.end()}
      assertCreation(creation,profile);creationRef=save('creation.json',creation)
      const migrated=await child('migrations',['node_modules/node-pg-migrate/bin/node-pg-migrate.js','-m','migrations','up'],{DATABASE_URL:profile.targetURL,TEST_DATABASE_URL:profile.targetURL},120000);assert.equal(migrated.exitCode,0);assert.equal(migrated.signal,null);assert.equal(migrated.timedOut,false);assert.equal(migrated.spawnError,null)
    }else{
      const read=name=>{const [path,expectedSHA]=localInputs[name];assert.equal(fileSHA(path),expectedSHA);return readJSON(path)}
      creation=read('creation');assertCreation(creation,profile);creationRef=save('creation.json',creation)
      const originalSchema=read('schema');assert.equal(originalSchema.journalNames.length,82);assert.equal(originalSchema.journalNames.at(-1),'1763820000000_planb_system_template_keys');assert.deepEqual(originalSchema.journalNames,verifySource(source).slice(0,-1));assert.equal(originalSchema.identity.oid,'616406')
      const q=read('qualification');assert.equal(q.kind,'root_actual_independent_C04_native_virtual_source_GREEN');assert.equal(q.actualTotal,30);assert.equal(q.passed,30);assert.equal(q.baseline.failed,18);assert.equal(q.baseline.passed,12);assert.equal(q.current.retainedAudits.length,4);lastAudits=q.current.retainedAudits
      const worker=read('worker');assert.equal(worker.kind,'root_actual_worker19_native_virtual_source_regressions');assert.equal(worker.actualTotal,19);assert.equal(worker.passed,19);assert.equal(worker.failed,0);assert.equal(worker.pending,0);assert.equal(worker.todo,0);assert.equal(worker.providerGuardCalls,0);assert.deepEqual(worker.current.retainedAudits,lastAudits)
      localTriggers=worker.current.nativeTriggers;assert.deepEqual(localTriggers,q.current.nativeTriggers)
      const portable=read('portable'),portableFinal=read('portableFinal');assert.equal(portable.kind,'root_actual_adopted_portable_C04_C05_local_v2_49_tests');assert.deepEqual(portable.tests,{total:49,passed:49,failed:0,pending:0,todo:0});assert.equal(portable.control.gates,8);assert.equal(portable.postflight.immutableAuditCount,6);assert.equal(portable.postflight.retainedHistoricalAuditCount,4);assert.equal(portable.postflight.addedOwnedAuditCount,2);assert.equal(portable.sourceEqual,true)
      assert.equal(portable.final.path,localInputs.portableFinal[0]);assert.equal(portable.final.sha256,localInputs.portableFinal[1]);assert.equal(portableFinal.overall,'PASSED');assert.equal(portableFinal.runtime,'ACTUAL_NATIVE');assert.equal(portableFinal.profile,'local');assert.equal(portableFinal.databaseOID,'616406');assert.equal(portableFinal.targetName,profile.targetName);assert.equal(portableFinal.primaryError,null)
      for(const phase of ['c04','worker']){assert.equal(portableFinal.phaseResults[phase].total,phase==='c04'?30:19);assert.equal(portableFinal.phaseResults[phase].passed,true);assert.equal(portableFinal.phaseResults[phase].failed,0);assert.equal(portableFinal.phaseResults[phase].pending,0);assert.equal(portableFinal.phaseResults[phase].todo,0);assert.equal(portableFinal.phaseResults[phase].exitCode,0);assert.equal(portableFinal.phaseResults[phase].witnessError,null)}
      const previous=portableFinal.finalProof;assert.equal(previous.journalNames.length,82);assert.deepEqual(previous.journalNames,originalSchema.journalNames);assert.deepEqual(previous.triggers,localTriggers);assert.equal(previous.audits.length,6);for(const old of lastAudits)assert.deepEqual(previous.audits.find(r=>r.id===old.id),old);assert.deepEqual(previous.otherSessions,[]);assert.deepEqual(previous.locks,[]);assert(Object.values(previous.counts).every(v=>v==='0'))
      for(const phase of ['c04','worker']){const ref=portable.phases[phase];assert.equal(fileSHA(ref.rawPath),ref.rawSHA256);const raw=readJSON(ref.rawPath);qualifyJSON(raw,phase==='c04'?30:19)}assert.equal(fileSHA(portable.control.path),portable.control.sha256);const control82=readJSON(portable.control.path);assert.equal(control82.overall,'PASSED');assert.equal(control82.gates.length,8)
      const loaded=loadLocalUpgrade83(process.env);assertLocalUpgrade83(loaded.upgrade,loaded.before,loaded.after,loaded.source,previous,source,profile,creation);lastAudits=loaded.after.audits;localTriggers=loaded.after.triggers
      localUpgrade={after:loaded.after,refs:{upgrade:save('local83-upgrade.json',loaded.upgrade),upgradeBefore:save('local83-before.json',loaded.before),upgradeAfter:save('local83-after.json',loaded.after),upgradeSource:save('local83-source.json',loaded.source),portable82:save('local82-portable-final-proof.json',previous)}}
      save('local-historical-provenance.json',{inputs:localInputs,creationHistoricalMain:creation.actualMain,currentSource:sourceRef,historicalAudits4:q.current.retainedAudits,actualPortableAudits6:previous.audits,upgrade83:localUpgrade.refs})
    }
    const c=await connect(profile.targetURL,'c04ci_schema_'+randomUUID());try{
      const identity=(await c.query(IDENTITY)).rows[0];assertIdentity(identity,profile,creation);if(profile.mode==='github-ci')assert.equal(identity.ownerRoleOID,creation.targetOwnerRoleOID)
      const journalNames=(await c.query('select name from pgmigrations order by name')).rows.map(r=>r.name);assertJournal(journalNames,verifySource(source))
      const triggers=(await c.query(TRIGGERS)).rows;assertFKs(triggers)
      if(localTriggers)assert.deepEqual(triggers,localTriggers)
      const columns=(await c.query("select column_name,udt_name from information_schema.columns where table_schema='public' and table_name='idempotency_keys' order by ordinal_position")).rows
      assert.deepEqual(columns,[{column_name:'key',udt_name:'text'},{column_name:'user_id',udt_name:'uuid'},{column_name:'route',udt_name:'text'},{column_name:'request_hash',udt_name:'text'},{column_name:'status',udt_name:'int4'},{column_name:'body',udt_name:'jsonb'},{column_name:'created_at',udt_name:'timestamptz'}])
      const audits=(await c.query(AUDITS)).rows.map(r=>({...r,at:r.at.toISOString()}));assert.deepEqual(audits,lastAudits)
      const catalog=(await c.query(SCHEMA_CATALOG)).rows[0]
      if(localUpgrade)assert.deepEqual(catalog,localUpgrade.after.schemaCatalog)
      schema={kind:`c04_c05_actual_schema${profileMigrationCount(profile)}_v1`,at:new Date().toISOString(),sourceSHA256:sourceRef.sha256,creationSHA256:creationRef.sha256,identity,migrationCount:profileMigrationCount(profile),journalNames,triggers,columns,catalog,retainedAudits:audits}
      const current=await inspectNative(c,admission());schema.nativePreflight=current;schemaRef=save('schema.json',schema)
    }finally{await c.end()}
    const barrier=bundle('barrier','barrier')
    const executed=await child('control',['scripts/c04-c05-receipt-barrier-control.mjs','--run-approved-native'],{C04_C05_ADMISSION:join(directory,barrier.path),C04_BARRIER_CONTROL_OUTPUT:join(directory,'barrier-control.json')},120000)
    assert.equal(executed.exitCode,0);assert.equal(executed.signal,null);assert.equal(executed.timedOut,false);assert.equal(executed.spawnError,null)
    controlRef={path:'barrier-control.json',sha256:fileSHA(join(directory,'barrier-control.json'))};assertControl(readJSON(join(directory,controlRef.path)),admission());assert.deepEqual((await nativeClean()).audits,lastAudits)
    for(const [phase,config,count,prefix] of [['c04','vitest.c04-isolated.config.ts',30,'C04_BATCH_WITNESS '],['worker','vitest.c05-worker-isolated.config.ts',19,'C05_WORKER_WITNESS ']]){
      if(phase==='worker'){schema={...schema,retainedAudits:lastAudits};schemaRef=save('worker-schema.json',schema)}
      const receipt=bundle('tests',phase,controlRef),start=await nativeClean();assert.deepEqual(start.audits,lastAudits);save(phase+'/preflight.json',start)
      const result=await child(phase,['node_modules/vitest/vitest.mjs','run','--config',config,'--reporter=default','--reporter=json','--outputFile='+join(directory,phase,'result.json')],{DATABASE_URL:profile.targetURL,TEST_DATABASE_URL:profile.targetURL,C04_C05_ADMISSION:join(directory,receipt.path),C04_C05_ADMISSION_PHASE:phase,C04_BATCH_BARRIER_NAMESPACE_ADMITTED:String(NAMESPACE)},180000)
      assert.equal(result.signal,null);assert.equal(result.timedOut,false);assert.equal(result.spawnError,null)
      const json=readJSON(join(directory,phase,'result.json')),summary=qualifyJSON(json,count)
      const log=readFileSync(join(directory,phase,'stdout.log'),'utf8')+'\n'+readFileSync(join(directory,phase,'stderr.log'),'utf8');assert(!/Unhandled Errors|unhandledRejection|Test timed out|Hook timed out/.test(log))
      const rows=witnesses(log,prefix);save(phase+'/witnesses.json',rows)
      const owned=new Set(rows.flatMap(r=>r.uuidManifest?.map(x=>x[0])??[])),post=await nativeClean();const added=extendAudits(lastAudits,post.audits,owned);save(phase+'/postflight.json',{...post,addedImmutableAudits:added});lastAudits=post.audits
      let witnessError=null;try{qualifyWitnesses(phase,rows)}catch(e){witnessError=err(e)}
      const passed=summary.failed===0&&result.exitCode===0&&!witnessError;phaseResults[phase]={...summary,exitCode:result.exitCode,passed,witnessError,retainedAuditCount:lastAudits.length};save(phase+'/qualified.json',phaseResults[phase])
      if(summary.failed===0)assert.equal(result.exitCode,0)
      // A semantic test failure stays FAILED, but only a clean settled target
      // with the full registered count may proceed to the second finite suite.
    }
    finalProof=await nativeClean();assert.deepEqual(finalProof.audits,lastAudits);verifySource(source)
  }catch(e){primaryError=err(e)}
  finally{
    if(creation&&schema&&sourceRef)try{const current=await nativeClean();if(lastAudits.length)for(const r of lastAudits)assert.deepEqual(current.audits.find(a=>a.id===r.id),r);save('final-native-postflight.json',current);finalProof=current}catch(e){save('final-postflight-failure.json',err(e));if(!primaryError)primaryError=err(e)}
    const passed=!primaryError&&phaseResults.c04?.passed===true&&phaseResults.worker?.passed===true&&finalProof!==null
    save('final.json',{kind:`c04_c05_isolated_native_lane${profileMigrationCount(profile)}_v1`,runtime:'ACTUAL_NATIVE',profile:profile.mode,context:profile.context??null,overall:passed?'PASSED':'FAILED',targetName:profile.targetName,databaseOID:creation?.databaseOID??null,source:sourceRef??null,phaseResults,c04:phaseResults.c04?'EXECUTED':'UNRUN',worker:phaseResults.worker?'EXECUTED':'UNRUN',primaryError,childRecords,finalProof,limits:['Finite30+19 feature acceptance only','No provider/device/M01/fullA12 acceptance','No database drop/reuse or global/audit erasure']})
    const index=[];function tree(dir,prefix=''){for(const f of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const rel=prefix+f.name;if(f.isDirectory())tree(join(dir,f.name),rel+'/');else index.push({path:rel,sha256:fileSHA(join(dir,f.name))})}}tree(directory);save('SHA256SUMS.json',index)
    process.stdout.write(JSON.stringify({overall:passed?'PASSED':'FAILED',directory,c04:phaseResults.c04??'UNRUN',worker:phaseResults.worker??'UNRUN'})+'\n');if(!passed)process.exitCode=1
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)await main()
