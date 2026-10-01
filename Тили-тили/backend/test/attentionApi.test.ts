import { randomInt, randomUUID } from 'node:crypto'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken } from '../src/auth/tokens.js'
import { notify, PUSH_LIMIT_PER_DAY } from '../src/notify/notify.js'

const DB = process.env.TEST_DATABASE_URL
const SECRET = 'a'.repeat(48)
describe.skipIf(!DB)('attention HTTP boundaries and truthful silent inbox', () => {
  let app: FastifyInstance
  const users: string[] = [], weddings: string[] = []
  beforeAll(async () => {
    app = await buildApp({ env: 'test', databaseUrl: DB!, redisUrl: null, corsOrigins: [],
      jwtAccessSecret: SECRET, jwtRefreshSecret: 'b'.repeat(48), policyVersion: '2026-09-02' })
    await app.ready()
  })
  afterAll(async () => {
    for (const id of weddings) await app.db!.query('delete from weddings where id=$1', [id])
    for (const id of users) await app.db!.query('delete from users where id=$1', [id])
    await app.close()
  })
  async function user() {
    const id = randomUUID(), sid = randomUUID(); users.push(id)
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [id, '+79'+randomInt(100_000_000,999_999_999),'Attention HTTP'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sid,id,randomUUID()])
    await app.db!.query("insert into consents(id,user_id,policy_version,adult) values($1,$2,'2026-09-02',true)", [randomUUID(),id])
    return { id, sid, headers: { authorization: `Bearer ${await signAccessToken(SECRET,{sub:id,sid})}` } }
  }
  async function wedding() {
    const owner = await user(), coordinator = await user(), helper = await user(), outsider = await user()
    const id = randomUUID(); weddings.push(id)
    await app.db!.query("insert into weddings(id,owner_id,title,invite_code) values($1,$2,'Attention HTTP',$3)",[id,owner.id,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple'),($1,$3,'coordinator'),($1,$4,'helper')",[id,owner.id,coordinator.id,helper.id])
    return { id, owner, coordinator, helper, outsider, path: `/weddings/${id}/attention` }
  }
  it('reads actual default with ETag; helper reads but cannot configure; outsiders see no data', async () => {
    const w = await wedding()
    const own = await app.inject({url:w.path,headers:w.owner.headers})
    expect(own.statusCode,own.body).toBe(200); expect(own.headers.etag).toBe('"1"')
    expect(own.json()).toMatchObject({mode:'essential',effectiveMode:'essential',coordinator:null})
    expect((await app.inject({url:w.path,headers:w.helper.headers})).statusCode).toBe(200)
    expect((await app.inject({method:'PATCH',url:w.path,headers:{...w.helper.headers,'if-match':'"1"'},payload:{mode:'detailed'}})).statusCode).toBe(403)
    expect((await app.inject({url:w.path,headers:w.outsider.headers})).statusCode).toBe(404)
  })
  it('requires exact version, saves accepted coordinator, rejects stale version and supports explicit clear', async () => {
    const w = await wedding(), patch = (payload: unknown, version?: string) => app.inject({method:'PATCH',url:w.path,
      headers:{...w.owner.headers,...(version ? {'if-match':version} : {})},payload:payload as object})
    expect((await patch({mode:'detailed'})).statusCode).toBe(428)
    expect((await patch({mode:'detailed'},'1')).statusCode).toBe(422)
    const saved = await patch({mode:'coordinator',coordinatorUserId:w.coordinator.id},'"1"')
    expect(saved.statusCode,saved.body).toBe(200); expect(saved.headers.etag).toBe('"2"')
    expect(saved.json()).toMatchObject({effectiveMode:'coordinator',coordinator:{id:w.coordinator.id}})
    expect((await patch({mode:'detailed'},'"1"')).statusCode).toBe(409)
    const cleared = await patch({coordinatorUserId:null},'"2"')
    expect(cleared.statusCode,cleared.body).toBe(200); expect(cleared.json()).toMatchObject({coordinator:null,effectiveMode:'essential'})
  })
  it('revoked current session cannot configure and leaves mode/audit unchanged', async () => {
    const w = await wedding()
    await app.db!.query('update sessions set revoked_at=now() where id=$1',[w.owner.sid])
    const denied = await app.inject({method:'PATCH',url:w.path,headers:{...w.owner.headers,'if-match':'"1"'},payload:{mode:'detailed'}})
    expect(denied.statusCode).toBe(401)
    expect((await app.db!.query('select attention_version::text,attention_mode from weddings where id=$1',[w.id])).rows[0]).toEqual({attention_version:'1',attention_mode:'essential'})
    expect((await app.db!.query("select 1 from audit_log where entity_id=$1 and action='wedding.attention_changed'",[w.id])).rowCount).toBe(0)
  })
  it('personal incident opt-in starts false, toggles independently, and omitted patches preserve it', async () => {
    const u = await user()
    expect((await app.inject({url:'/users/me',headers:u.headers})).json().urgentIncidents).toBe(false)
    const set = await app.inject({method:'PATCH',url:'/users/me',headers:u.headers,payload:{urgentIncidents:true}})
    expect(set.statusCode,set.body).toBe(200); expect(set.json().urgentIncidents).toBe(true)
    const other = await app.inject({method:'PATCH',url:'/users/me',headers:u.headers,payload:{name:'Updated'}})
    expect(other.json().urgentIncidents).toBe(true)
    const off = await app.inject({method:'PATCH',url:'/users/me',headers:u.headers,payload:{urgentIncidents:false}})
    expect(off.json().urgentIncidents).toBe(false)
  })
  it('session revoked while waiting for wedding lock rolls back mode and audit', async () => {
    const w = await wedding()
    let unlock!: () => void, locked!: () => void
    const acquired = new Promise<void>(resolve => { locked=resolve })
    const release = new Promise<void>(resolve => { unlock=resolve })
    const blocker = app.db!.tx(async client => {
      await client.query('select id from weddings where id=$1 for update',[w.id]); locked(); await release
    })
    await acquired
    const pending = app.inject({method:'PATCH',url:w.path,headers:{...w.owner.headers,'if-match':'"1"'},payload:{mode:'detailed'}})
    try {
      const deadline = Date.now()+5000
      let waiting = false
      while (Date.now()<deadline) {
        const blocked = await app.db!.query(`select 1 from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and query like 'select attention_version::text, attention_mode,%'`)
        if (blocked.rowCount) { waiting=true; break }
        await new Promise(resolve => setTimeout(resolve,10))
      }
      expect(waiting,'the request must actually reach the locked domain query').toBe(true)
      await app.db!.query('update sessions set revoked_at=now() where id=$1',[w.owner.sid])
    } finally { unlock(); await blocker }
    const denied = await pending
    expect(denied.statusCode,denied.body).toBe(401)
    expect((await app.db!.query('select attention_version::text,attention_mode from weddings where id=$1',[w.id])).rows[0]).toEqual({attention_version:'1',attention_mode:'essential'})
    expect((await app.db!.query("select 1 from audit_log where entity_id=$1 and action='wedding.attention_changed'",[w.id])).rowCount).toBe(0)
  })
  it('hard deletion of selected coordinator invalidates version without inventing an actor', async () => {
    const w = await wedding()
    const saved = await app.inject({method:'PATCH',url:w.path,headers:{...w.owner.headers,'if-match':'"1"'},
      payload:{mode:'coordinator',coordinatorUserId:w.coordinator.id}})
    expect(saved.statusCode,saved.body).toBe(200)
    await app.db!.query('delete from users where id=$1',[w.coordinator.id])
    const actual = await app.inject({url:w.path,headers:w.owner.headers})
    expect(actual.json()).toMatchObject({version:'3',coordinator:null,coordinatorUserId:null,effectiveMode:'essential'})
    const audit = await app.db!.query("select actor_id from audit_log where entity_id=$1 and action='wedding.attention_selection_cleared'",[w.id])
    expect(audit.rows).toEqual([{actor_id:null}])
  })
  it('disabled or explicitly silent push stays in inbox and consumes no ordinary quota', async () => {
    const u = await user()
    await app.db!.query('insert into notification_prefs(user_id,chats,quiet_from,quiet_to) values($1,false,\'00:00\',\'00:00\')',[u.id])
    const now = new Date(), silent = await notify(app.db!,{userId:u.id,kind:'chat',title:'Silent',body:'Inbox'},now)
    expect(silent).not.toBeNull()
    expect((await app.db!.query('select push_disposition from notifications where id=$1',[silent])).rows[0]!.push_disposition).toBe('inbox_only')
    for (let i=0;i<PUSH_LIMIT_PER_DAY;i++) await notify(app.db!,{userId:u.id,kind:'system',title:'Action',body:'Own action'},now)
    const due = await app.db!.query("select 1 from notifications where user_id=$1 and push_disposition='planned' and deliver_after=$2",[u.id,now])
    expect(due.rowCount).toBe(PUSH_LIMIT_PER_DAY)
  })
  it('wedding date and critical hints do not bypass personal quiet hours', async () => {
    const w = await wedding()
    await app.db!.query("update users set tz='Europe/Moscow' where id=$1",[w.owner.id])
    await app.db!.query('update weddings set date=current_date where id=$1',[w.id])
    const night = new Date('2026-10-01T20:00:00Z')
    const id = await notify(app.db!,{userId:w.owner.id,kind:'system',title:'Normal',body:'A hint is not an incident',critical:true},night)
    expect((await app.db!.query('select deliver_after from notifications where id=$1',[id])).rows[0]!.deliver_after.toISOString()).toBe('2026-10-02T06:00:00.000Z')
  })
  it.each(['essential','coordinator','detailed'] as const)('creation stores optional %s without granting a coordinator', async mode => {
    const u = await user()
    const created = await app.inject({method:'POST',url:'/weddings',headers:u.headers,
      payload:{partnerName:'Partner',city:{name:'Уфа',region:'Башкортостан'},attentionMode:mode}})
    expect(created.statusCode,created.body).toBe(201)
    const id = created.json().id as string; weddings.push(id)
    const actual = await app.inject({url:`/weddings/${id}/attention`,headers:u.headers})
    expect(actual.json()).toMatchObject({mode,version:'1',coordinator:null,coordinatorUserId:null,
      effectiveMode:mode==='coordinator' ? 'essential' : mode})
  })
})
