import { randomUUID, randomInt } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { signAccessToken, ACCESS_TTL_SECONDS } from '../src/auth/tokens.js'

const DB = process.env.TEST_DATABASE_URL
const APPLICATION = 'pdf_access_' + randomUUID(), SECRET = 'p'.repeat(48), POLICY = '2026-09-02'
describe.skipIf(!DB)('PDF final reads: access is fresh after actual database waits', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    const connection = new URL(DB!); connection.searchParams.set('application_name', APPLICATION)
    app = await buildApp({ env: 'test', databaseUrl: connection.href, redisUrl: null, jwtAccessSecret: SECRET, jwtRefreshSecret: 'r'.repeat(48), policyVersion: POLICY })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })
  async function setup() {
    const userId = randomUUID(), sessionId = randomUUID(), weddingId = randomUUID(), consentId = randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)', [userId, '+79' + randomInt(100000000,999999999), 'Synthetic PDF owner'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [sessionId,userId,randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)', [consentId,userId,POLICY])
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Synthetic PDF','2027-06-14','Europe/Moscow',$3)", [weddingId,userId,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId,userId])
    return { userId,sessionId,weddingId,consentId, token: await signAccessToken(SECRET,{ sub:userId,sid:sessionId }) }
  }
  type Fixture = Awaited<ReturnType<typeof setup>>
  for (const door of ['documents','timeline']) {
    const changes = [
      { name:'session',status:401, sql:'update sessions set revoked_at=now() where id=$1', value:(w:Fixture)=>w.sessionId },
      { name:'consent',status:403, sql:'update consents set withdrawn_at=now() where id=$1', value:(w:Fixture)=>w.consentId },
      { name:'membership',status:404, sql:'delete from wedding_members where wedding_id=$1', value:(w:Fixture)=>w.weddingId },
      { name:'role',status:403, sql:"update wedding_members set role='vendor' where wedding_id=$1", value:(w:Fixture)=>w.weddingId },
    ]
    for (const change of [...changes, {name:'expiry',status:401,sql:'',value:(w:Fixture)=>w.weddingId}]) {
      it(`${door} denies ${change.name} changed while waiting for its wedding lock`, async () => {
        const w = await setup()
        const expires = Math.floor(Date.now()/1000)+3
        if (change.name==='expiry') w.token = await signAccessToken(SECRET,{sub:w.userId,sid:w.sessionId},(expires-ACCESS_TTL_SECONDS)*1000)
        let pending: ReturnType<FastifyInstance['inject']> | undefined, settled=false
        try {
          await app.db!.tx(async client => {
            const pid = (await client.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid
            await client.query('select id from weddings where id=$1 for update',[w.weddingId])
            pending = app.inject({method:'GET',url:`/weddings/${w.weddingId}/${door}`,headers:{authorization:'Bearer '+w.token}}).then(response=>{settled=true;return response})
            const deadline=Date.now()+12_000
            let blocked=false
            while(Date.now()<deadline && !settled) {
              await client.query('select pg_stat_clear_snapshot()')
              const waiters=await client.query(`select 1 from pg_stat_activity where application_name=$2 and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`,[pid,APPLICATION])
              if(waiters.rowCount) {blocked=true;break}
              await new Promise(resolve=>setTimeout(resolve,10))
            }
            expect(blocked,'actual PostgreSQL wait required').toBe(true)
            if(change.name==='expiry') { while(Date.now()<expires*1000) await new Promise(resolve=>setTimeout(resolve,10)) }
            else await client.query(change.sql,[change.value(w)])
          })
        } finally { if(pending) await pending }
        const response=await pending!
        expect(response.statusCode,response.body).toBe(change.status)
        expect(response.json()).not.toHaveProperty('draft')
      })
    }
  }
})
