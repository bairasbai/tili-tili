import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { SCHEMA_CATALOG, reviewedMigrationPins, verifyMigrationDirectory } from '../test-support/c04-c05-native-admission.mjs'
import { runOssProductEmptyCycle, runOssProductPopulatedCycle } from '../test-support/oss-product-migration-drill.mjs'
const DB=process.env.TEST_DATABASE_URL
describe.skipIf(!DB)('031 actual native CLI migration preservation',()=>{
  let admin:pg.Client,db:pg.Client,url:string,oid:string
  const name='tili_oss031_'+randomUUID().replaceAll('-','')+'_test'
  const backend=resolve('.'),cli=resolve('node_modules/node-pg-migrate/bin/node-pg-migrate.js')
  beforeAll(async()=>{
    const target=new URL(DB!);assert.equal(target.hostname,'127.0.0.1');assert.equal(target.port,'15432');assert.equal(target.username,'codex_test');assert.equal(target.pathname,'/tili_ecosystem_full_20260930_test')
    admin=new pg.Client({connectionString:DB,statement_timeout:15000});await admin.connect()
    const identity=(await admin.query("select current_setting('data_directory') data,current_user principal,inet_server_port() port")).rows[0]
    assert.equal(identity.principal,'codex_test');assert.equal(identity.port,15432)
    if(process.platform==='win32')assert(['/tili-calendar371-consents-20261025-pg','/tili-pr81-83-audit-fixes-20261104-pg'].some(suffix=>identity.data.replaceAll('\\','/').endsWith(suffix)))
    else{
      assert.equal(process.platform,'linux');assert.equal(process.env.CI,'true');assert.equal(process.env.GITHUB_ACTIONS,'true')
      assert.equal(process.env.GITHUB_REPOSITORY,'bairasbai/tili-tili');assert.equal(process.env.GITHUB_WORKFLOW,'CI');assert.equal(process.env.GITHUB_JOB,'backend')
      assert(process.env.GITHUB_WORKSPACE);assert.equal(backend,resolve(process.env.GITHUB_WORKSPACE,'Тили-тили/backend'))
      for(const key of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])assert.match(process.env[key]??'',/^[1-9][0-9]*$/)
      assert.match(process.env.GITHUB_SHA??'',/^[0-9a-f]{40}$/);assert.equal(process.env.TILI_DISPOSABLE_PG_PORT,'15432')
      assert.equal(identity.data,'/var/lib/postgresql/data','Only the workflow-owned postgres16 ecosystem container is admitted')
    }
    assert.equal((await admin.query('select 1 from pg_database where datname=$1',[name])).rowCount,0)
    process.stdout.write('OSS031_DATABASE_OWNER '+JSON.stringify({owner:'ossProductMigrations.test.ts',name,cluster:identity.data,createdAt:new Date().toISOString(),purpose:'synthetic native96/97 proof',cleanup:'only same OID after test'})+'\n')
    await admin.query(`create database "${name}" template template0 locale_provider icu icu_locale 'und'`)
    oid=(await admin.query('select oid::text from pg_database where datname=$1',[name])).rows[0].oid
    target.pathname='/'+name;url=target.toString();db=new pg.Client({connectionString:url,statement_timeout:15000});await db.connect()
    verifyMigrationDirectory(resolve('migrations'),reviewedMigrationPins(128))
  })
  afterAll(async()=>{
    await db?.end()
    if(admin&&oid){const current=(await admin.query('select oid::text from pg_database where datname=$1',[name])).rows[0];assert.equal(current?.oid,oid);assert.equal((await admin.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount,0);await admin.query(`drop database "${name}"`);assert.equal((await admin.query('select 1 from pg_database where datname=$1',[name])).rowCount,0);process.stdout.write('OSS031_DATABASE_CLEANED '+JSON.stringify({name,oid})+'\n')}
    await admin?.end()
  })
  async function migrate(direction:string,target:string|number,message?:string,exact=false){
    const args=[cli,direction,String(target),...(exact?[]:['--timestamp']),'-m','migrations','--single-transaction','--verbose','false','--envPath',resolve('oss031-dotenv-must-not-exist')]
    const result=await new Promise<{code:number|null;output:string}>((done,reject)=>{
      const child=spawn(process.execPath,args,{cwd:backend,env:{...process.env,DATABASE_URL:url,TEST_DATABASE_URL:url},windowsHide:true});let output=''
      process.stdout.write('OSS031_CLI_OWNER '+JSON.stringify({owner:'ossProductMigrations.test.ts',pid:child.pid,startedAt:new Date().toISOString(),cwd:backend,args,ports:[]})+'\n')
      const timer=setTimeout(()=>{child.kill();reject(new Error('Owned native migration timed out'))},60000)
      child.stdout.on('data',b=>{output+=String(b)});child.stderr.on('data',b=>{output+=String(b)});child.on('error',error=>{clearTimeout(timer);reject(error)})
      child.on('close',(code,signal)=>{clearTimeout(timer);if(signal)return reject(new Error('Native migration terminated'));done({code,output})})
    })
    if(message){assert.notEqual(result.code,0);assert(result.output.includes(message),result.output)}else assert.equal(result.code,0,result.output)
    return{status:result.code,output:result.output}
  }
  async function snapshot(){
    const schema=(await db.query(SCHEMA_CATALOG)).rows[0]
    const data:Record<string,unknown[] >={}
    for(const {tablename} of (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows){const safe='"'+tablename.replaceAll('"','""')+'"';data[tablename]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${safe} t`)).rows[0].rows}
    return{schema,data}
  }
  it('preserves the exact adoption95 through real96/97 empty cycles and populated refusal',async()=>{
    await runOssProductEmptyCycle({db,migrate,snapshot})
    await runOssProductPopulatedCycle({db,migrate,snapshot})
    expect((await db.query('select count(*)::int n from pgmigrations')).rows[0].n).toBe(97)
  },120000)
})
