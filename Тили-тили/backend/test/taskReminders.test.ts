import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import webpush from 'web-push'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { sendTaskReminders, taskPushReady } from '../src/notify/task-notifications.js'
import { cleanup } from '../src/jobs/index.js'
import { sendDuePushes } from '../src/notify/push.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
const AT = new Date('2027-05-04T04:00:00Z') // 09:00 in Ufa

describe.skipIf(!DB)('017-B: task reminders, delivery guards and transactional assignment', () => {
  let app: FastifyInstance
  const users: string[] = []
  const weddings: string[] = []
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB ?? null, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: '2026-09-02' })
    await app.ready()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const id of weddings.splice(0)) await app.db!.query('delete from weddings where id=$1', [id])
    for (const id of users.splice(0)) await app.db!.query('delete from users where id=$1', [id])
  })
  afterAll(async () => { await app?.close() })
  async function user() {
    const id = randomUUID(), sid = randomUUID()
    users.push(id)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [id, '+79'+randomInt(100_000_000,999_999_999), 'Reminder test'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid,id,randomUUID()])
    await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(),id])
    await app.db!.query('insert into notification_prefs(user_id) values($1)', [id])
    return { id, token: await signAccessToken(SECRET,{sub:id,sid}) }
  }
  async function setup() {
    const owner = await user(), helper = await user(), id = randomUUID()
    weddings.push(id)
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Reminders','2027-06-14','Asia/Yekaterinburg',$3)", [id,owner.id,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'helper')", [id,owner.id,helper.id])
    return { id, owner, helper }
  }
  type W = Awaited<ReturnType<typeof setup>>
  const headers = (u: { token: string }) => ({ authorization: 'Bearer '+u.token })
  const create = (w: W, body: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/weddings/${w.id}/tasks`, headers: headers(w.owner),
    payload: {title:'Позвонить площадке',period:'3',assigneeId:w.owner.id,due:'2027-05-05', ...body} })
  const patch = (w: W, id: string, body: Record<string, unknown>) => app.inject({ method: 'PATCH',url:`/weddings/${w.id}/tasks/${id}`,headers:headers(w.owner),payload:body })
  const notices = async (id: string) => (await app.db!.query('select * from notifications where task_id=$1 and cancelled_at is null', [id])).rows
  const make = async (w: W, body: Record<string, unknown> = {}) => {
    const res=await create(w,{reminderDaysBefore:1,...body}); expect(res.statusCode,res.body).toBe(201);return res.json().id as string
  }
  it('old clients keep reminders off; zero is a real value', async () => {
    const w=await setup();const old=await create(w)
    expect(old.json()).toMatchObject({reminderDaysBefore:null,reminderTime:'09:00'})
    const current=await create(w,{reminderDaysBefore:0,reminderTime:'10:30'})
    expect(current.json()).toMatchObject({reminderDaysBefore:0,reminderTime:'10:30'})
  })
  it('assignment notifies only the assignee; same assignment and self-assignment are silent', async () => {
    const w=await setup();const id=await make(w,{assigneeId:w.helper.id})
    expect(await notices(id)).toHaveLength(1)
    expect((await notices(id))[0]).toMatchObject({user_id:w.helper.id,task_event:'assignment',link:`/wedding/checklist?task=${id}&wedding=${w.id}`})
    const calls=await Promise.all([patch(w,id,{assigneeId:w.helper.id}),patch(w,id,{assigneeId:w.helper.id})])
    expect(calls.map(c=>c.statusCode)).toEqual([200,200]);expect(await notices(id)).toHaveLength(1)
    const self=await make(w);expect(await notices(self)).toHaveLength(0)
  })
  it('reassignment retracts the old notice; new assignee alone receives it', async () => {
    const w=await setup();const next=await user()
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,next.id])
    const id=await make(w,{assigneeId:w.helper.id});await patch(w,id,{assigneeId:next.id})
    expect((await notices(id)).map(n=>n.user_id)).toEqual([next.id])
  })
  it.each([-1,31,1.5])('rejects invalid days %s without a task write', async days=>{
    const w=await setup();expect((await create(w,{reminderDaysBefore:days})).statusCode).toBe(422)
  })
  it.each(['24:00','12:60','9:00',''])('rejects invalid reminder time %s',async time=>{
    const w=await setup();expect((await create(w,{reminderTime:time})).statusCode).toBe(422)
  })
  it('cannot enable without a deadline or a living eligible assignee',async()=>{
    const w=await setup()
    for(const body of [{assigneeId:null},{due:null},{assigneeId:randomUUID()}]) expect((await create(w,{...body,reminderDaysBefore:1})).statusCode).toBe(422)
  })
  it('fires at the assignee time zone, not the server day; two workers produce one notice',async()=>{
    const w=await setup();const id=await make(w)
    await sendTaskReminders(app,new Date(AT.getTime()-1000));expect(await notices(id)).toHaveLength(0)
    const outcomes=await Promise.all([sendTaskReminders(app,AT),sendTaskReminders(app,AT)])
    expect(outcomes.reduce((n,r)=>n+r.queued,0)).toBe(1)
    expect((await notices(id)).filter(n=>n.task_event==='reminder')).toHaveLength(1)
    await sendTaskReminders(app,AT);expect(await notices(id)).toHaveLength(1)
  })
  it('profile zone takes precedence and invalid profile zone falls back safely',async()=>{
    const w=await setup();const id=await make(w)
    await app.db!.query("update users set tz='Asia/Vladivostok' where id=$1",[w.owner.id])
    await sendTaskReminders(app,new Date('2027-05-03T23:00:00Z'));expect(await notices(id)).toHaveLength(1)
    await patch(w,id,{reminderTime:'09:01'})
    await app.db!.query("update users set tz='Invalid/Timezone' where id=$1",[w.owner.id])
    await sendTaskReminders(app,AT);expect(await notices(id)).toHaveLength(0)
    await sendTaskReminders(app,new Date('2027-05-04T06:01:00Z'));expect(await notices(id)).toHaveLength(1)
  })
  it('quiet hours defer the push but do not hide a valid inbox reminder',async()=>{
    const w=await setup();const id=await make(w,{reminderTime:'23:00'})
    const now=new Date('2027-05-04T18:00:00Z');await sendTaskReminders(app,now)
    expect((await notices(id))[0]?.deliver_after.toISOString()).toBe('2027-05-05T04:00:00.000Z')
    expect(await taskPushReady(app.db!,(await notices(id))[0]!.id,now)).toBe(false)
  })
  it('task notices respect quiet hours even on wedding day',async()=>{
    const w=await setup();const today=new Date().toISOString().slice(0,10)
    await app.db!.query('update weddings set date=$2::date where id=$1',[w.id,today])
    const id=await make(w,{due:today,reminderDaysBefore:0,reminderTime:'01:00'})
    const at=new Date(today+'T01:00:00Z');await app.db!.query("update users set tz='UTC' where id=$1",[w.owner.id])
    await sendTaskReminders(app,at)
    expect((await notices(id))[0]?.deliver_after.toISOString()).toBe(today+'T09:00:00.000Z')
  })
  it('completed tasks never fire; a concurrent completion leaves no stale notice',async()=>{
    const w=await setup();const id=await make(w)
    const [res]=await Promise.all([patch(w,id,{done:true}),sendTaskReminders(app,AT)])
    expect(res.statusCode).toBe(200);expect(await notices(id)).toHaveLength(0)
    await sendTaskReminders(app,AT);expect(await notices(id)).toHaveLength(0)
  })
  it('clearing assignee or deadline disables the reminder and retracts queued notices',async()=>{
    const w=await setup()
    for(const body of [{assigneeId:null},{due:null}]){
      const id=await make(w);await sendTaskReminders(app,AT)
      const res=await patch(w,id,body);expect(res.statusCode,res.body).toBe(200)
      expect(res.json().reminderDaysBefore).toBeNull();expect(await notices(id)).toHaveLength(0)
    }
  })
  it('member removal and account soft deletion remove pending assignments',async()=>{
    const w=await setup();const id=await make(w,{assigneeId:w.helper.id})
    await app.db!.query('delete from wedding_members where wedding_id=$1 and user_id=$2',[w.id,w.helper.id])
    expect(await notices(id)).toHaveLength(0)
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')",[w.id,w.helper.id])
    await patch(w,id,{assigneeId:w.helper.id,reminderDaysBefore:1})
    await app.db!.query('update users set deleted_at=now() where id=$1',[w.helper.id])
    expect(await notices(id)).toHaveLength(0)
  })
  it('renaming updates text without re-arming the reminder',async()=>{
    const w=await setup();const id=await make(w);await sendTaskReminders(app,AT)
    await patch(w,id,{title:'Новое название'});expect((await notices(id))[0]?.body).toBe('Новое название')
    expect((await sendTaskReminders(app,AT)).queued).toBe(0)
  })
  it('deadline changes invalidate the queued reminder and schedule the new occurrence',async()=>{
    const w=await setup();const id=await make(w);await sendTaskReminders(app,AT)
    await patch(w,id,{due:'2027-05-06'});expect(await notices(id)).toHaveLength(0)
    await sendTaskReminders(app,AT);expect(await notices(id)).toHaveLength(0)
    await sendTaskReminders(app,new Date('2027-05-05T04:00:00Z'));expect(await notices(id)).toHaveLength(1)
  })
  it('missed reminders older than one day are marked expired, not replayed',async()=>{
    const w=await setup();const id=await make(w)
    expect((await sendTaskReminders(app,new Date('2027-05-07T04:00:00Z'))).expired).toBe(1)
    expect(await notices(id)).toHaveLength(0)
    expect((await sendTaskReminders(app,new Date('2027-05-07T04:00:00Z'))).expired).toBe(0)
  })
  it('notification opt-out suppresses both new assignments and reminders',async()=>{
    const w=await setup();await app.db!.query('update notification_prefs set tasks=false where user_id=$1',[w.helper.id])
    const id=await make(w,{assigneeId:w.helper.id});expect(await notices(id)).toHaveLength(0)
    expect((await sendTaskReminders(app,AT)).suppressed).toBe(1);expect(await notices(id)).toHaveLength(0)
  })
  it('archived weddings have no visible or deliverable task notices',async()=>{
    const w=await setup();const id=await make(w,{assigneeId:w.helper.id})
    await app.db!.query('update weddings set archived_at=now() where id=$1',[w.id])
    const res=await app.inject({method:'GET',url:'/notifications',headers:headers(w.helper)})
    expect(res.statusCode,res.body).toBe(200);expect(res.json()).toHaveLength(0)
    expect(await notices(id)).toHaveLength(0)
  })
  it('notification failure rolls back the reminder mark; retry is safe',async()=>{
    const w=await setup();const id=await make(w);const db=app.db!;const original=db.tx.bind(db)
    vi.spyOn(db,'tx').mockImplementationOnce(fn=>original(c=>fn({query:async(text,values)=>{
      if(text.includes('insert into notifications')) throw new Error('controlled notification failure')
      return c.query(text,values)
    }})))
    await expect(sendTaskReminders(app,AT)).rejects.toThrow('task-reminders')
    expect((await db.query('select reminded_version from tasks where id=$1',[id])).rows[0]?.reminded_version).toBeNull()
    expect(await notices(id)).toHaveLength(0)
    await sendTaskReminders(app,AT);expect(await notices(id)).toHaveLength(1)
  })
  it('new quiet-hour settings after enqueue defer an already claimed push',async()=>{
    const w=await setup();const id=await make(w);await sendTaskReminders(app,AT)
    const notice=(await notices(id))[0]!
    await app.db!.query("update notification_prefs set quiet_from='08:00',quiet_to='12:00' where user_id=$1",[w.owner.id])
    expect(await taskPushReady(app.db!,notice.id,AT)).toBe(false)
    expect((await notices(id))[0]?.deliver_after.toISOString()).toBe('2027-05-04T07:00:00.000Z')
  })
  it('task push rechecks opt-out and is not sent through the transport',async()=>{
    const w=await setup();const id=await make(w,{assigneeId:w.helper.id})
    await app.db!.query('update notifications set deliver_after=now() where task_id=$1',[id])
    await app.db!.query('update notification_prefs set tasks=false where user_id=$1',[w.helper.id])
    await app.db!.query('insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4)',
      [randomUUID(),w.helper.id,'https://push.example/'+randomUUID(),JSON.stringify({p256dh:'test',auth:'test'})])
    const send=vi.spyOn(webpush,'sendNotification').mockResolvedValue({statusCode:201,body:'',headers:{}})
    const keys=webpush.generateVAPIDKeys()
    await sendDuePushes(app.db!,{...app.appConfig,vapidPublicKey:keys.publicKey,vapidPrivateKey:keys.privateKey})
    expect(send).not.toHaveBeenCalled();expect(await notices(id)).toHaveLength(0)
  })
  it('helper cannot configure someone else’s wedding or plan-b tasks',async()=>{
    const w=await setup();const other=await setup();const id=await make(other)
    const res=await app.inject({method:'PATCH',url:`/weddings/${other.id}/tasks/${id}`,headers:headers(w.helper),payload:{reminderDaysBefore:1}})
    expect(res.statusCode).toBe(404)
    const planb=randomUUID();await app.db!.query("insert into tasks(id,wedding_id,title,kind) values($1,$2,'Plan B','planb')",[planb,w.id])
    expect((await patch(w,planb,{reminderTime:'10:00'})).statusCode).toBe(422)
  })
  it('deleting a task cancels inbox/push but retains spent daily quota',async()=>{
    const w=await setup()
    await app.db!.query("update users set tz='UTC' where id=$1",[w.helper.id])
    await app.db!.query("update notification_prefs set quiet_from='00:00',quiet_to='00:00' where user_id=$1",[w.helper.id])
    for(let i=0;i<3;i++){
      const id=await make(w,{assigneeId:w.helper.id})
      await app.db!.query('update notifications set pushed_at=now() where task_id=$1',[id])
      const res=await app.inject({method:'DELETE',url:`/weddings/${w.id}/tasks/${id}`,headers:headers(w.owner)})
      expect(res.statusCode,res.body).toBe(204)
    }
    const id=await make(w,{assigneeId:w.helper.id})
    const notice=(await notices(id))[0]!
    expect(notice.deliver_after.getTime()).toBeGreaterThan(Date.now()+20*3_600_000)
    const inbox=await app.inject({method:'GET',url:'/notifications',headers:headers(w.helper)})
    expect(inbox.json()).toHaveLength(1)
    const history=await app.db!.query('select id from notifications where user_id=$1 and cancelled_at is not null',[w.helper.id])
    expect(history.rows).toHaveLength(3)
  })
  it('the real delivery path hands one valid notice to a mocked push provider once',async()=>{
    const w=await setup()
    await app.db!.query("update users set tz='UTC' where id=$1",[w.helper.id])
    await app.db!.query("update notification_prefs set quiet_from='00:00',quiet_to='00:00' where user_id=$1",[w.helper.id])
    const id=await make(w,{assigneeId:w.helper.id})
    await app.db!.query("insert into push_subscriptions(id,user_id,endpoint,keys) values($1,$2,$3,$4)",
      [randomUUID(),w.helper.id,'https://push.example/'+randomUUID(),JSON.stringify({p256dh:'test',auth:'test'})])
    const send=vi.spyOn(webpush,'sendNotification').mockResolvedValue({statusCode:201,body:'',headers:{}})
    const keys=webpush.generateVAPIDKeys();const config={...app.appConfig,vapidPublicKey:keys.publicKey,vapidPrivateKey:keys.privateKey}
    await sendDuePushes(app.db!,config);await sendDuePushes(app.db!,config)
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(send.mock.calls[0]![1])).data.link).toContain(id)
    await patch(w,id,{done:true});await sendDuePushes(app.db!,config)
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('assignment notification failure rolls back the task write',async()=>{
    const w=await setup();const db=app.db!;const original=db.tx.bind(db)
    vi.spyOn(db,'tx').mockImplementationOnce(fn=>original(c=>fn({query:async(text,values)=>{
      if(text.includes('insert into notifications'))throw new Error('controlled assignment failure')
      return c.query(text,values)
    }})))
    expect((await create(w,{assigneeId:w.helper.id})).statusCode).toBe(500)
    expect((await db.query('select id from tasks where wedding_id=$1',[w.id])).rows).toHaveLength(0)
    await make(w,{assigneeId:w.helper.id})
    expect((await db.query('select id from notifications where user_id=$1',[w.helper.id])).rows).toHaveLength(1)
  })

  it('cleanup bounds cancelled history retention without resetting today’s quota',async()=>{
    const w=await setup();const id=await make(w,{assigneeId:w.helper.id})
    const stale=(await notices(id))[0]!.id
    await patch(w,id,{assigneeId:w.owner.id})
    await app.db!.query("update notifications set cancelled_at=now()-interval '91 days' where id=$1",[stale])
    const second=await make(w,{assigneeId:w.helper.id});const recent=(await notices(second))[0]!.id
    await patch(w,second,{done:true});await cleanup(app)
    expect((await app.db!.query('select id from notifications where id=$1',[stale])).rows).toHaveLength(0)
    expect((await app.db!.query('select id from notifications where id=$1',[recent])).rows).toHaveLength(1)
  })

})
