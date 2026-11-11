import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { signAccessToken, ACCESS_TTL_SECONDS } from '../src/auth/tokens.js'
import { parseTillyReply, storeTillyActions, type TillyProposal } from '../src/tilly/actions.js'
import type { TillyModel, TillyRequest } from '../src/tilly/model.js'
import type { Queryable } from '../src/plugins/db.js'
import type { QueryResultRow } from 'pg'

const DB = process.env.TEST_DATABASE_URL, SECRET = 'tilly031-synthetic-access-'.repeat(3), POLICY = '2026-09-02'
const known = randomUUID()
describe('untrusted model proposals', () => {
  it('keeps plain replies and rejects non-allowlisted actions, dates, fields and invented tasks', () => {
    expect(parseTillyReply('Plain answer', {})).toEqual({ text: 'Plain answer', proposals: [] })
    for (const action of [
      {kind:'delete_task',taskId:known}, {kind:'complete_task',taskId:randomUUID()},
      {kind:'create_task',title:'Task',due:'2027-02-30'}, {kind:'create_task',title:'a\nb',due:null},
      {kind:'create_task',title:'Task',due:null,html:'x'}, {kind:'reschedule_task',taskId:known,due:null},
    ]) expect(parseTillyReply(JSON.stringify({reply:'Answer',actions:[action]}), {[known]:{title:'Known',revision:'7'}}).proposals).toEqual([])
  })
  it('takes title/revision from the captured server context and bounds/deduplicates actions', () => {
    const action={kind:'complete_task',taskId:known},context={[known]:{title:'Known',revision:'7'}}
    expect(parseTillyReply(JSON.stringify({reply:'Answer',actions:[action,action]}),context).proposals).toEqual([{kind:'complete_task',title:'Known',revision:'7',due:null,taskId:known}])
    expect(parseTillyReply(JSON.stringify({reply:'Answer',actions:Array(4).fill(action)}),context).proposals).toEqual([])
  })
  it('accepts three distinct proposals and exact title lengths1/200, but rejects0/201',()=>{
    const actions=[{kind:'create_task',title:'a',due:null},{kind:'create_task',title:'b'.repeat(200),due:'2028-02-29'},{kind:'complete_task',taskId:known}],context={[known]:{title:'Known',revision:'1'}}
    expect(parseTillyReply(JSON.stringify({reply:'Answer',actions}),context).proposals).toHaveLength(3)
    for(const title of ['', 'x'.repeat(201)])expect(parseTillyReply(JSON.stringify({reply:'Answer',actions:[{kind:'create_task',title,due:null}]}),{}).proposals).toEqual([])
    expect(parseTillyReply(JSON.stringify({reply:'Answer',actions:[...actions,{kind:'create_task',title:'fourth',due:null}]}),context).proposals).toEqual([])
  })
})
type Actor={id:string;sid:string;authorization:string}
type Fixture={wid:string;chat:string;question:string;reply:string;owner:Actor;partner:Actor;task:string}
describe.skipIf(!DB)('explicit Tilly actions on live PostgreSQL', () => {
  let app:FastifyInstance
  const options={env:'test' as const,databaseUrl:DB,redisUrl:null,jwtAccessSecret:SECRET,jwtRefreshSecret:'tilly031-refresh-'.repeat(4),policyVersion:POLICY,rateLimitPerSecond:0}
  const model:TillyModel={provider:'test',model:'scripted-031',complete:async()=>({text:JSON.stringify({reply:'Can add it.',actions:[{kind:'create_task',title:'Synthetic AI task',due:'2027-06-02'}]}),usage:{inputTokens:2,outputTokens:2},finish:'stop',model:'scripted-031'})}
  beforeAll(async()=>{app=await buildApp(options,[],{tillyModel:model});await app.ready()})
  afterAll(async()=>{await app?.close()})
  async function actor():Promise<Actor>{
    const id=randomUUID(),sid=randomUUID()
    await app.db!.query("insert into users(id,phone,name) values($1,$2,'Synthetic Tilly actor')",[id,'+79'+randomInt(100000000,999999999)])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sid,id,randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',[randomUUID(),id,POLICY])
    return{id,sid,authorization:'Bearer '+await signAccessToken(SECRET,{sub:id,sid})}
  }
  async function fixture():Promise<Fixture>{
    const owner=await actor(),partner=await actor(),wid=randomUUID(),question=randomUUID(),reply=randomUUID(),task=randomUUID()
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Tilly actions','2027-06-14','Europe/Moscow',$3)",[wid,owner.id,randomUUID()])
    for(const who of [owner,partner])await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[wid,who.id])
    const chat=(await app.db!.query<{id:string}>("select id from chats where wedding_id=$1 and kind='tilly'",[wid])).rows[0]!.id
    await app.db!.query("insert into messages(id,chat_id,sender_id,text) values($1,$2,$3,'My question')",[question,chat,owner.id])
    await app.db!.query("insert into messages(id,chat_id,sender_id,text) values($1,$2,null,'Answer')",[reply,chat])
    await app.db!.query("insert into tasks(id,wedding_id,title,source,kind,sort) values($1,$2,'Original task','user','checklist',0)",[task,wid])
    // Keep this fixture's single user task; normal wedding creation also seeds templates.
    await app.db!.query('delete from tasks where wedding_id=$1 and id<>$2',[wid,task])
    return{wid,chat,question,reply,owner,partner,task}
  }
  async function proposal(f:Fixture,kind:TillyProposal['kind']='create_task',remainingMs?:number){
    const revision=(await app.db!.query<{revision:string}>('select revision::text from tasks where id=$1',[f.task])).rows[0]!.revision
    return app.db!.tx(async c=>{
      await c.query('select id from weddings where id=$1 for update',[f.wid])
      const rows=await storeTillyActions(c,{weddingId:f.wid,chatId:f.chat,userId:f.owner.id,questionMessageId:f.question},f.reply,[{kind,title:'Original task',due:kind==='complete_task'?null:'2027-07-01',taskId:kind==='create_task'?null:f.task,revision:kind==='create_task'?null:revision}])
      if(remainingMs!==undefined){ // Insert a separate bounded causal receipt: identity/TTL cannot be edited later.
        await c.query('delete from tilly_actions where id=$1',[rows[0]!.id])
        const row=rows[0]!
        return (await c.query(`insert into tilly_actions(id,wedding_id,chat_id,message_id,question_message_id,recipient_user_id,kind,payload,ordinal,created_at,expires_at,target_task_id,expected_revision)
          values($1,$2,$3,$4,$5,$6,$7,$8,0,now()+$9::int*interval '1 millisecond'-interval '24 hours',now()+$9::int*interval '1 millisecond',$10,$11) returning *`,[randomUUID(),f.wid,f.chat,f.reply,f.question,f.owner.id,kind,JSON.stringify(row.payload),remainingMs,row.target_task_id,row.expected_revision])).rows[0]!
      }
      return rows[0]!
    })
  }
  const accept=(f:Fixture,id:string,who=f.owner,payload={})=>app.inject({method:'POST',url:`/weddings/${f.wid}/tilly/actions/${id}/accept`,headers:{authorization:who.authorization},payload})
  async function ledger(id:string){return(await app.db!.query('select state,result from tilly_actions where id=$1',[id])).rows[0]!}
  it('creates no task before confirmation; only the question author can apply, retries/concurrent taps have one effect',async()=>{
    const f=await fixture(),a=await proposal(f)
    const count=async()=>(await app.db!.query('select count(*)::int n from tasks where wedding_id=$1',[f.wid])).rows[0]!.n
    expect(await count()).toBe(1)
    expect((await accept(f,a.id,f.partner)).statusCode).toBe(403);expect(await count()).toBe(1)
    expect((await accept(f,a.id,f.owner,{kind:'delete_task'})).statusCode).toBe(422)
    const responses=await Promise.all([accept(f,a.id),accept(f,a.id)])
    expect(responses.map(r=>r.statusCode),responses.map(r=>r.body).join('\n')).toEqual([200,200]);expect(responses[0]!.json()).toEqual(responses[1]!.json())
    expect(await count()).toBe(2);expect(responses[0]!.json()).toMatchObject({id:a.id,state:'applied',canApply:false})
    const restarted=await buildApp(options,[],{tillyModel:null});await restarted.ready()
    try{const retry=await restarted.inject({method:'POST',url:`/weddings/${f.wid}/tilly/actions/${a.id}/accept`,headers:{authorization:f.owner.authorization},payload:{}});expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual(responses[0]!.json())}finally{await restarted.close()}
    expect(await count()).toBe(2)
  })
  it.each(['complete_task','reschedule_task'] as const)('applies %s to the captured task and increments its database revision once',async kind=>{
    const f=await fixture(),a=await proposal(f,kind),r=await accept(f,a.id);expect(r.statusCode,r.body).toBe(200)
    const row=(await app.db!.query('select done_at,due::text,revision::text from tasks where id=$1',[f.task])).rows[0]!
    expect(row.revision).toBe('2');if(kind==='complete_task')expect(row.done_at).not.toBeNull();else expect(row.due).toBe('2027-07-01')
    expect((await accept(f,a.id)).statusCode).toBe(200);expect((await app.db!.query('select revision::text from tasks where id=$1',[f.task])).rows[0]!.revision).toBe('2')
  })
  it('rejects A→B→A, including an identical visible title, with no hidden task UPDATE',async()=>{
    const f=await fixture(),a=await proposal(f,'complete_task')
    await app.db!.query("update tasks set title='Changed' where id=$1",[f.task]);await app.db!.query("update tasks set title='Original task' where id=$1",[f.task])
    const before=(await app.db!.query('select row_to_json(t) data from tasks t where id=$1',[f.task])).rows
    const r=await accept(f,a.id);expect(r.statusCode,r.body).toBe(409);expect((await ledger(a.id)).state).toBe('stale')
    expect((await app.db!.query('select row_to_json(t) data from tasks t where id=$1',[f.task])).rows).toEqual(before)
  })
  it('commits expiry without an effect and refuses foreign wedding, deleted task, revoked session and role',async()=>{
    const f=await fixture(),a=await proposal(f,'create_task',-3600000)
    expect((await accept(f,a.id)).statusCode).toBe(409);expect((await ledger(a.id)).state).toBe('stale')
    const other=await fixture();expect((await accept(other,a.id)).statusCode).toBe(404)
    const missing=await proposal(other,'complete_task');await app.db!.query('delete from tasks where id=$1',[other.task]);expect((await accept(other,missing.id)).statusCode).toBe(409)
    const revoked=await fixture(),receipt=await proposal(revoked);await app.db!.query('update sessions set revoked_at=now() where id=$1',[revoked.owner.sid]);expect((await accept(revoked,receipt.id)).statusCode).toBe(401);expect((await ledger(receipt.id)).state).toBe('pending')
    const role=await fixture(),pending=await proposal(role);await app.db!.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2",[role.wid,role.owner.id]);expect((await accept(role,pending.id)).statusCode).toBe(403)
  })
  async function waitFor(c:Queryable,pid:number){
    const until=Date.now()+8000
    while(Date.now()<until){await c.query('select pg_stat_clear_snapshot()');if((await c.query("select 1 from pg_stat_activity where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount)return;await new Promise(r=>setTimeout(r,10))}
    throw new Error('Actual PostgreSQL lock wait was not observed')
  }
  it('rechecks permission after a real wedding-lock wait, leaving both receipt and tasks unchanged',async()=>{
    const f=await fixture(),a=await proposal(f);let pending:ReturnType<typeof accept>|undefined
    try{await app.db!.tx(async c=>{const pid=(await c.query('select pg_backend_pid() pid')).rows[0]!.pid;await c.query('select id from weddings where id=$1 for update',[f.wid]);pending=accept(f,a.id);await waitFor(c,pid);await c.query('update sessions set revoked_at=clock_timestamp() where id=$1',[f.owner.sid])})}finally{if(pending)await pending}
    const r=await pending!;expect(r.statusCode,r.body).toBe(401);expect((await ledger(a.id)).state).toBe('pending');expect((await app.db!.query('select count(*)::int n from tasks where wedding_id=$1',[f.wid])).rows[0]!.n).toBe(1)
  })
  it('persists model proposals against the exact human question, exposes cards only with a fresh viewer, and preserves ordinary chat history',async()=>{
    const f=await fixture()
    app.tilly.answer({chatId:f.chat,weddingId:f.wid,userId:f.owner.id,questionMessageId:f.question});await app.tilly.settle()
    const read=async(who:Actor)=>app.inject({method:'GET',url:`/chats/${f.chat}/messages`,headers:{authorization:who.authorization}})
    const owner=await read(f.owner);expect(owner.statusCode,owner.body).toBe(200)
    const chats=await app.inject({method:'GET',url:'/chats',headers:{authorization:f.owner.authorization}});expect(chats.json().find((c:{id:string})=>c.id===f.chat).weddingId).toBe(f.wid)
    const reply=owner.json().items.find((m:{actions?:unknown[]})=>m.actions?.length)
    expect(reply.text).toBe('Can add it.');expect(reply.actions[0]).toMatchObject({kind:'create_task',canApply:true,state:'pending'})
    const partner=await read(f.partner);expect(partner.json().items.find((m:{id:string})=>m.id===reply.id).actions[0].canApply).toBe(false)
    expect((await app.db!.query('select count(*)::int n from tasks where wedding_id=$1',[f.wid])).rows[0]!.n).toBe(1)
    expect((await app.db!.query('select question_message_id,recipient_user_id from tilly_actions where message_id=$1',[reply.id])).rows).toEqual([{question_message_id:f.question,recipient_user_id:f.owner.id}])
  })
  it('previews the current task and assignee only for the original author and matching revision', async () => {
    const f = await fixture()
    await app.db!.query("update tasks set due='2027-05-12', assignee_id=$2 where id=$1", [f.task, f.partner.id])
    const action = await proposal(f, 'reschedule_task')
    async function readAction(who: Actor) {
      const response = await app.inject({ url: `/chats/${f.chat}/messages`, headers: { authorization: who.authorization } })
      expect(response.statusCode, response.body).toBe(200)
      return response.json().items.find((message: { id: string }) => message.id === f.reply).actions[0]
    }

    expect(await readAction(f.owner)).toMatchObject({
      due: '2027-07-01',
      canApply: true,
      preview: { currentDue: '2027-05-12', assignee: { name: 'Synthetic Tilly actor' } },
    })
    const partnerAction = await readAction(f.partner)
    expect(partnerAction.canApply).toBe(false)
    expect(partnerAction).not.toHaveProperty('preview')
    expect((await ledger(action.id)).state).toBe('pending')
    expect((await app.db!.query('select due::text from tasks where id=$1', [f.task])).rows[0]!.due).toBe('2027-05-12')

    await app.db!.query("update tasks set due='2027-05-19' where id=$1", [f.task])
    expect(await readAction(f.owner)).not.toHaveProperty('preview')
    expect((await accept(f, action.id)).statusCode).toBe(409)
    expect((await ledger(action.id)).state).toBe('stale')
  })
  it('SC-014 keeps model context in the caller wedding and changes a task only after its author confirms', async () => {
    const current = await fixture()
    const other = await fixture()
    const helper = await actor()
    const question = 'Please suggest moving the room check to 12 June.'
    const attachment = 'https://example.invalid/synthetic-welcome-plan.pdf'
    await app.db!.query("update tasks set title='Room check', due='2027-06-10', assignee_id=$2 where id=$1", [current.task, current.partner.id])
    await app.db!.query("update weddings set title='Separate wedding fixture', budget_total=987654321 where id=$1", [other.wid])
    await app.db!.query("update tasks set title='Separate checklist fixture' where id=$1", [other.task])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [current.wid, helper.id])

    const complete = vi.fn(async (_input: TillyRequest) => ({
      text: JSON.stringify({ reply: 'I can suggest a new due date.', actions: [
        { kind: 'reschedule_task', taskId: current.task, due: '2027-06-12' },
      ] }),
      usage: { inputTokens: 2, outputTokens: 2 },
      finish: 'stop' as const,
      model: 'scripted-sc014',
    }))
    const scoped = await buildApp(options, [], { tillyModel: { provider: 'test', model: 'scripted-sc014', complete } })
    try {
      const chatUrl = `/chats/${current.chat}/messages`
      for (const [who, status] of [[helper, 403], [other.owner, 404]] as const) {
        const denied = await scoped.inject({ url: chatUrl, headers: { authorization: who.authorization } })
        expect(denied.statusCode, denied.body).toBe(status)
      }
      const sent = await scoped.inject({
        method: 'POST', url: chatUrl, headers: { authorization: current.owner.authorization },
        payload: { text: question, attachmentUrl: attachment },
      })
      expect(sent.statusCode, sent.body).toBe(201)
      await scoped.tilly.settle()
      expect(complete).toHaveBeenCalledOnce()
      const input = complete.mock.calls[0]![0]
      expect(input.system).toContain('Room check')
      expect(input.system).not.toContain('Separate wedding fixture')
      expect(input.system).not.toContain('Separate checklist fixture')
      expect(input.system).not.toContain(other.task)
      expect(input.messages.at(-1)?.content).toContain(question)
      expect(JSON.stringify({ system: input.system, messages: input.messages })).not.toContain(attachment)

      const history = await scoped.inject({ url: chatUrl, headers: { authorization: current.owner.authorization } })
      expect(history.statusCode, history.body).toBe(200)
      const suggestion = history.json().items.find((message: { text: string }) => message.text === 'I can suggest a new due date.').actions[0]
      expect(suggestion).toMatchObject({ state: 'pending', due: '2027-06-12', canApply: true, preview: { currentDue: '2027-06-10' } })
      const due = async () => (await app.db!.query('select due::text from tasks where id=$1', [current.task])).rows[0]!.due
      expect(await due()).toBe('2027-06-10')
      expect((await accept(current, suggestion.id, current.partner)).statusCode).toBe(403)
      expect(await due()).toBe('2027-06-10')
      expect((await accept(current, suggestion.id)).statusCode).toBe(200)
      expect(await due()).toBe('2027-06-12')
    } finally {
      await scoped.close()
    }
  })
  it('rejects causal/payload/revision tampering in native SQL, including a deferred foreign question author',async()=>{
    const f=await fixture(),a=await proposal(f)
    const before=(await app.db!.query('select row_to_json(t) value from tilly_actions t where id=$1',[a.id])).rows
    for(const sql of ["update tilly_actions set payload=jsonb_set(payload,'{title}','\"changed\"') where id=$1","update tilly_actions set expires_at=expires_at+interval '1 second' where id=$1","update tilly_actions set recipient_user_id=gen_random_uuid() where id=$1"]){await expect(app.db!.tx(c=>c.query(sql,[a.id]))).rejects.toMatchObject({code:'23514'})}
    for(const payload of [{title:'x',due:'2027-02-30'},{title:'x',due:null,html:'unsafe'},{title:' '.repeat(4),due:null}]){
      await expect(app.db!.tx(c=>c.query(`insert into tilly_actions(id,wedding_id,chat_id,message_id,question_message_id,recipient_user_id,kind,payload,ordinal) select gen_random_uuid(),wedding_id,chat_id,message_id,question_message_id,recipient_user_id,'create_task',$2,1 from tilly_actions where id=$1`,[a.id,JSON.stringify(payload)]))).rejects.toMatchObject({code:'23514'})
    }
    await expect(app.db!.tx(c=>c.query(`insert into tilly_actions(id,wedding_id,chat_id,message_id,question_message_id,recipient_user_id,kind,payload,ordinal) select gen_random_uuid(),wedding_id,chat_id,message_id,question_message_id,$2,'create_task',payload,1 from tilly_actions where id=$1`,[a.id,f.partner.id]))).rejects.toMatchObject({code:'23503'})
    await expect(app.db!.tx(c=>c.query('update tasks set revision=revision+1 where id=$1',[f.task]))).rejects.toMatchObject({code:'23514',constraint:'tasks_revision_owned'})
    expect((await app.db!.query('select row_to_json(t) value from tilly_actions t where id=$1',[a.id])).rows).toEqual(before)
    expect((await app.db!.query("select tilly_real_date_031('2028-02-29') good,tilly_real_date_031('2027-02-29') bad,tilly_real_date_031('0000-01-01') zero")).rows).toEqual([{good:true,bad:false,zero:false}])
  })
  it('rolls back a task if receipt storage fails, then permits one successful retry',async()=>{
    const f=await fixture(),a=await proposal(f,'complete_task'),original=app.db!.tx.bind(app.db!)
    app.db!.tx=fn=>original(c=>fn({query:async<T extends QueryResultRow>(text:string,values?:readonly unknown[])=>{if(text.startsWith("update tilly_actions set state='applied',resolved_at=clock_timestamp(),result=$2 where id=$1"))throw new Error('Synthetic031 storage failure');return c.query<T>(text,values)}}))
    try{expect((await accept(f,a.id)).statusCode).toBe(500)}finally{app.db!.tx=original}
    expect((await ledger(a.id)).state).toBe('pending');expect((await app.db!.query('select done_at,revision::text from tasks where id=$1',[f.task])).rows).toEqual([{done_at:null,revision:'1'}])
    expect((await accept(f,a.id)).statusCode).toBe(200)
  })
  it('rolls back the effect if its deadline passes at the final native ledger UPDATE',async()=>{
    const f=await fixture(),a=await proposal(f,'complete_task',450),original=app.db!.tx.bind(app.db!)
    app.db!.tx=fn=>original(c=>fn({query:async<T extends QueryResultRow>(text:string,values?:readonly unknown[])=>{if(text.startsWith("update tilly_actions set state='applied',resolved_at=clock_timestamp(),result=$2 where id=$1"))await new Promise(r=>setTimeout(r,650));return c.query<T>(text,values)}}))
    try{const r=await accept(f,a.id);expect(r.statusCode,r.body).toBe(409)}finally{app.db!.tx=original}
    expect((await ledger(a.id)).state).toBe('stale');expect((await app.db!.query('select done_at,revision::text from tasks where id=$1',[f.task])).rows).toEqual([{done_at:null,revision:'1'}])
  })
  for(const door of ['accept','read'] as const)for(const revoke of ['role','session','consent','expiry'] as const){
    if(door==='accept'&&revoke==='session')continue // Existing observed-wait case above remains the control.
    it(`${door} refuses ${revoke} revoked during a real access-lock wait, with no task/receipt/read/event effect`,async()=>{
      const f=await fixture(),a=await proposal(f),expires=Math.floor(Date.now()/1000)+3
      if(revoke==='expiry')f.owner.authorization='Bearer '+await signAccessToken(SECRET,{sub:f.owner.id,sid:f.owner.sid},(expires-ACCESS_TTL_SECONDS)*1000)
      const taskBefore=(await app.db!.query('select row_to_json(t) value from tasks t where id=$1',[f.task])).rows
      const readsBefore=(await app.db!.query('select * from chat_reads where chat_id=$1',[f.chat])).rows
      const events=vi.spyOn(app.realtime,'publish');let pending:ReturnType<typeof accept>|undefined
      try{
        try{await app.db!.tx(async c=>{
          const pid=(await c.query('select pg_backend_pid() pid')).rows[0]!.pid;await c.query('select id from weddings where id=$1 for update',[f.wid])
          pending=door==='accept'?accept(f,a.id):app.inject({method:'GET',url:`/chats/${f.chat}/messages`,headers:{authorization:f.owner.authorization}})
          await waitFor(c,pid)
          if(revoke==='role')await c.query("update wedding_members set role='helper' where wedding_id=$1 and user_id=$2",[f.wid,f.owner.id])
          if(revoke==='session')await c.query('update sessions set revoked_at=clock_timestamp() where id=$1',[f.owner.sid])
          if(revoke==='consent')await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1',[f.owner.id])
          if(revoke==='expiry')await new Promise(r=>setTimeout(r,Math.max(0,expires*1000+120-Date.now())))
        })}finally{if(pending)await pending}
        const result=await pending!;expect(result.statusCode,result.body).toBe(revoke==='role'||revoke==='consent'?403:401)
        expect((await ledger(a.id)).state).toBe('pending');expect((await app.db!.query('select row_to_json(t) value from tasks t where id=$1',[f.task])).rows).toEqual(taskBefore)
        expect((await app.db!.query('select * from chat_reads where chat_id=$1',[f.chat])).rows).toEqual(readsBefore);expect(events).not.toHaveBeenCalled()
        if(door==='read')expect(result.json()).not.toHaveProperty('items')
      }finally{events.mockRestore()}
    })
  }
  it('keeps the first question context and author when a second actual answer finishes before it',async()=>{
    const f=await fixture(),second=randomUUID();let release!:()=>void,entered!:()=>void
    let firstRequest:TillyRequest|undefined,timer:ReturnType<typeof setTimeout>|undefined
    const waiting=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
    const modelCall=vi.spyOn(model,'complete').mockImplementationOnce(async request=>{
      firstRequest=request
      entered();await gate;return{text:JSON.stringify({reply:'First exact answer',actions:[{kind:'create_task',title:'First exact task',due:null}]}),usage:{inputTokens:1,outputTokens:1},finish:'stop',model:'scripted-031'}
    })
    try{
      await app.db!.query("insert into messages(id,chat_id,sender_id,text) values($1,$2,$3,'LATER_PARTNER_QUESTION')",[second,f.chat,f.partner.id])
      app.tilly.answer({chatId:f.chat,weddingId:f.wid,userId:f.owner.id,questionMessageId:f.question});await Promise.race([waiting,new Promise<void>((_,reject)=>{timer=setTimeout(()=>reject(new Error('First model call did not start')),5000)})]);clearTimeout(timer)
      app.tilly.answer({chatId:f.chat,weddingId:f.wid,userId:f.partner.id,questionMessageId:second})
      let secondReady=false;const until=Date.now()+5000
      while(Date.now()<until){if((await app.db!.query('select 1 from tilly_actions where question_message_id=$1',[second])).rowCount){secondReady=true;break}await new Promise(r=>setTimeout(r,10))}
      expect(secondReady,'Second actual answer must persist while first model call is still waiting').toBe(true)
      expect(firstRequest!.messages.map(m=>m.content).join('\n')).toContain('My question');expect(firstRequest!.messages.map(m=>m.content).join('\n')).not.toContain('LATER_PARTNER_QUESTION')
      release();await app.tilly.settle()
      const rows=(await app.db!.query('select id,question_message_id,recipient_user_id from tilly_actions where chat_id=$1 order by question_message_id',[f.chat])).rows
      expect(rows).toHaveLength(2);expect(rows.find(r=>r.question_message_id===f.question)?.recipient_user_id).toBe(f.owner.id);expect(rows.find(r=>r.question_message_id===second)?.recipient_user_id).toBe(f.partner.id)
      expect((await accept(f,rows.find(r=>r.question_message_id===second)!.id,f.owner)).statusCode).toBe(403)
    }finally{clearTimeout(timer);release?.();await app.tilly.settle();modelCall.mockRestore()}
  })
  it('does not store applicable actions for a foreign question/chat/wedding or different original author',async()=>{
    const f=await fixture(),other=await fixture(),item:TillyProposal={kind:'create_task',title:'Synthetic',due:null,taskId:null,revision:null}
    for(const change of [{questionMessageId:other.question},{chatId:other.chat},{weddingId:other.wid},{userId:f.partner.id}]){
      expect(await app.db!.tx(c=>storeTillyActions(c,{weddingId:f.wid,chatId:f.chat,userId:f.owner.id,questionMessageId:f.question,...change},f.reply,[item]))).toEqual([])
    }
    expect((await app.db!.query('select 1 from tilly_actions where message_id=$1',[f.reply])).rowCount).toBe(0)
  })
  it.each(['card','JWT'] as const)('rejects a real task-row wait crossing the%s deadline, with no task effect or success event',async deadline=>{
    const f=await fixture(),a=await proposal(f,'complete_task',deadline==='card'?1000:undefined),expires=Math.floor(Date.now()/1000)+3
    if(deadline==='JWT')f.owner.authorization='Bearer '+await signAccessToken(SECRET,{sub:f.owner.id,sid:f.owner.sid},(expires-ACCESS_TTL_SECONDS)*1000)
    const events=vi.spyOn(app.realtime,'publish');let pending:ReturnType<typeof accept>|undefined
    try{
      try{await app.db!.tx(async c=>{
        const pid=(await c.query('select pg_backend_pid() pid')).rows[0]!.pid;await c.query('select id from tasks where id=$1 for update',[f.task]);pending=accept(f,a.id);await waitFor(c,pid)
        const until=deadline==='card'?new Date(a.expires_at).getTime()+150:expires*1000+120;await new Promise(r=>setTimeout(r,Math.max(0,until-Date.now())))
      })}finally{if(pending)await pending}
      const result=await pending!;expect(result.statusCode,result.body).toBe(deadline==='card'?409:401)
      expect((await ledger(a.id)).state).toBe(deadline==='card'?'stale':'pending');expect((await app.db!.query('select done_at,revision::text from tasks where id=$1',[f.task])).rows).toEqual([{done_at:null,revision:'1'}]);expect(events).not.toHaveBeenCalled()
    }finally{events.mockRestore()}
  })
  it('rolls back an actual deferred database refusal at COMMIT without publishing success',async()=>{
    const f=await fixture(),a=await proposal(f,'complete_task'),name='tilly031_refuse_'+randomUUID().replaceAll('-','')
    expect(name).toMatch(/^[a-z0-9_]+$/)
    const target=new URL(DB!);expect(['127.0.0.1','localhost','[::1]']).toContain(target.hostname)
    const identity=(await app.db!.query('select current_database() database,current_user principal')).rows[0]!
    expect(identity.database).toBe(decodeURIComponent(target.pathname.slice(1)));expect(identity.principal).toBe(target.username)
    const local=identity.database==='tili_ecosystem_full_20260930_test'&&target.port==='15432'&&target.username==='codex_test'
    const ci=process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='bairasbai/tili-tili'&&process.env.GITHUB_JOB==='backend'
      &&['tili','tili_privacy_test'].includes(identity.database)&&target.port==='5432'&&target.username==='tili'
    expect(local||ci,'Transient DDL only on the registered local test database or genuine repository backend CI').toBe(true)
    process.stdout.write('TILLY031_TRANSIENT_DDL_OWNER '+JSON.stringify({owner:'tillyActions.test.ts',pid:process.pid,name,database:identity.database,actionId:a.id,cleanup:'finally drop trigger/function and verify absence'})+'\n')
    const events=vi.spyOn(app.realtime,'publish')
    try{
      await app.db!.query(`create function ${name}() returns trigger language plpgsql as $$ begin if NEW.id='${a.id}'::uuid and NEW.state='applied' then raise exception using errcode='23514',constraint='tilly031_test_commit_refusal'; end if; return NEW; end $$`)
      await app.db!.query(`create constraint trigger ${name} after update on tilly_actions deferrable initially deferred for each row execute function ${name}()`)
      const result=await accept(f,a.id);expect(result.statusCode,result.body).toBe(500)
      expect((await ledger(a.id)).state).toBe('pending');expect((await app.db!.query('select done_at,revision::text from tasks where id=$1',[f.task])).rows).toEqual([{done_at:null,revision:'1'}]);expect(events).not.toHaveBeenCalled()
    }finally{
      await app.db!.query(`drop trigger if exists ${name} on tilly_actions`);await app.db!.query(`drop function if exists ${name}()`);events.mockRestore()
      expect((await app.db!.query('select to_regprocedure($1) object',[name+'()'])).rows[0]!.object).toBeNull()
    }
    expect((await accept(f,a.id)).statusCode).toBe(200)
  })
})
