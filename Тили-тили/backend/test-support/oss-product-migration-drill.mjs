// Root owns the connection and native migration CLI. Synthetic history only.
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
export const INVITATION_MIGRATION='1764800000000_invitation_designs', TILLY_ACTION_MIGRATION='1764810000000_tilly_task_actions'
const PRIOR=1763930000000, INVITES=1764800000000, ACTIONS=1764810000000
function oldRows(before,after,revision){
  assert.deepEqual(Object.keys(after.data).filter(t=>!['invitation_designs','tilly_actions'].includes(t)),Object.keys(before.data))
  for(const [table,rows] of Object.entries(before.data)){
    let current=after.data[table]
    if(table==='pgmigrations')current=current.filter(r=>![INVITATION_MIGRATION,TILLY_ACTION_MIGRATION].includes(r.name))
    if(table==='tasks'&&revision){assert(current.every(r=>r.revision===1));current=current.map(({revision:_revision,...r})=>r)}
    const canonical=rows=>rows.map(r=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))))).sort()
    assert.deepEqual(canonical(current),canonical(rows),'Every old public row/column must be preserved: '+table)
  }
  // Any existing catalogue fact must remain literal; only reviewed new entries may appear.
  for(const [key,value] of Object.entries(before.schema)){
    const afterValue=after.schema[key]
    if(Array.isArray(value))for(const row of value)assert(afterValue.some(r=>JSON.stringify(r)===JSON.stringify(row)),'Old catalogue fact changed: '+key)
    else assert.deepEqual(afterValue,value)
  }
}
async function journal(c,count,last){const names=(await c.db.query('select name from pgmigrations order by id')).rows.map(r=>r.name);assert.equal(names.length,count);assert.equal(names.at(-1),last)}
export async function runOssProductEmptyCycle(c){
  await c.migrate('up',PRIOR);await journal(c,95,'1763930000000_legacy_calendar_adoption')
  const before=await c.snapshot();assert.equal(Object.keys(before.data).length,125)
  await c.migrate('up',INVITES);await journal(c,96,INVITATION_MIGRATION);const withInvitations=await c.snapshot();oldRows(before,withInvitations,false)
  assert.deepEqual(withInvitations.data.invitation_designs,[])
  await c.migrate('up',ACTIONS);await journal(c,97,TILLY_ACTION_MIGRATION);const withActions=await c.snapshot();oldRows(before,withActions,true);assert.deepEqual(withActions.data.tilly_actions,[])
  await c.migrate('up',ACTIONS);assert.deepEqual(await c.snapshot(),withActions,'Repeated native up is a full no-op')
  await c.migrate('down',TILLY_ACTION_MIGRATION,undefined,true);assert.deepEqual(await c.snapshot(),withInvitations,'Empty97 down restores complete96 rows and catalogue')
  await c.migrate('down',INVITATION_MIGRATION,undefined,true);assert.deepEqual(await c.snapshot(),before,'Empty96 down restores complete95 rows and catalogue')
  await c.migrate('up',ACTIONS);oldRows(before,await c.snapshot(),true)
  await c.migrate('down',TILLY_ACTION_MIGRATION,undefined,true);await c.migrate('down',INVITATION_MIGRATION,undefined,true);assert.deepEqual(await c.snapshot(),before)
  process.stdout.write('OSS031_EMPTY_NATIVE_PASSED '+JSON.stringify({oldTables:125,currentTables:127,nativeUps:4,emptyDowns:4,repeat:1,oldRowsAndCataloguePreserved:true,realHumanAgreement:false})+'\n')
}
export async function runOssProductPopulatedCycle(c){
  await journal(c,95,'1763930000000_legacy_calendar_adoption');const before=await c.snapshot()
  await c.migrate('up',INVITES);oldRows(before,await c.snapshot(),false)
  await c.migrate('up',ACTIONS);oldRows(before,await c.snapshot(),true)
  const user=randomUUID(),wedding=randomUUID(),question=randomUUID(),reply=randomUUID(),receipt=randomUUID()
  await c.db.query('begin')
  try{
    await c.db.query("insert into users(id,phone,name) values($1,$2,'Synthetic031 migration')",[user,'+79'+randomInt(100000000,999999999)])
    await c.db.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic031','2027-06-14','Europe/Moscow',$3)",[wedding,user,randomUUID()])
    const chat=(await c.db.query("select id from chats where wedding_id=$1 and kind='tilly'",[wedding])).rows[0].id
    await c.db.query("insert into messages(id,chat_id,sender_id,text) values($1,$2,$3,'Synthetic question'),($4,$2,null,'Synthetic reply')",[question,chat,user,reply])
    await c.db.query("insert into invitation_designs(wedding_id,draft,version) values($1,$2,1)",[wedding,JSON.stringify({schemaVersion:1,content:[]})])
    await c.db.query("insert into tilly_actions(id,wedding_id,chat_id,message_id,question_message_id,recipient_user_id,kind,payload,ordinal) values($1,$2,$3,$4,$5,$6,'create_task',$7,0)",[receipt,wedding,chat,reply,question,user,JSON.stringify({title:'Synthetic task',due:null})])
    await c.db.query('commit')
  }catch(error){await c.db.query('rollback');throw error}
  const populated=await c.snapshot();assert.equal(Object.keys(populated.data).length,127)
  for(const [name,message] of [[TILLY_ACTION_MIGRATION,'tilly_actions_down_refused'],[INVITATION_MIGRATION,'invitation_designs_down_refused']]){
    await c.migrate('down',name,message,true);assert.deepEqual(await c.snapshot(),populated,'Refused native down preserves ALL127 rows and complete catalogue')
  }
  await c.migrate('up',ACTIONS);assert.deepEqual(await c.snapshot(),populated);await journal(c,97,TILLY_ACTION_MIGRATION)
  process.stdout.write('OSS031_POPULATED_NATIVE_PASSED '+JSON.stringify({oldTables:125,currentTables:127,nativeDownRefusals:2,repeat:1,oldRowsAndCataloguePreserved:true,fixture:{user,wedding,receipt},realHumanAgreement:false})+'\n')
}
