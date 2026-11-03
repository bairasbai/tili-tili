import { randomInt, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseInvitationDesign, normalizeInvitationPhoto } from '../src/invitations/design.js'
import { buildApp } from '../src/app.js'
import { signAccessToken, ACCESS_TTL_SECONDS } from '../src/auth/tokens.js'
import { readFileSync } from 'node:fs'
import { crc32 } from 'node:zlib'
const block = { type:'Text',props:{id:'greeting',heading:'Әлиә ♥ Иван',body:'<script>alert(1)</script>'} }
const draft = { schemaVersion:1,content:[block] }
const animation = (type:'png'|'webp') => readFileSync(new URL(`./fixtures/oss031-animated.${type}`,import.meta.url))
const photoUri = (bytes:Buffer,type='png') => `data:image/${type};base64,${bytes.toString('base64')}`
async function png(width=4,height=4){return sharp({create:{width,height,channels:3,background:'#abc'}}).png().toBuffer()}
function paddedPng(base:Buffer,size:number){
  const data=Buffer.from('Padding\0'+'x'.repeat(size-base.length-20)),type=Buffer.from('tEXt'),length=Buffer.alloc(4),crc=Buffer.alloc(4)
  length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([type,data])))
  const result=Buffer.concat([base.subarray(0,-12),length,type,data,crc,base.subarray(-12)]);expect(result.length).toBe(size);return result
}
describe('closed invitation vocabulary',()=>{
  it('preserves plain text without executing or interpreting markup',async()=>expect(await parseInvitationDesign(draft)).toEqual(draft))
  it.each([
    null,{}, {...draft,root:{props:{}}}, {...draft,schemaVersion:2}, {...draft,content:Array.from({length:17},()=>block)},
    {...draft,content:[block,block]}, {...draft,content:[{...block,type:'HTML'}]},
    {...draft,content:[{...block,props:{...block.props,id:'../path'}}]},
    {...draft,content:[{...block,props:{...block.props,css:'color:red'}}]},
    {...draft,content:[{...block,props:{...block.props,heading:'x'.repeat(121)}}]},
    {...draft,content:[{...block,props:{...block.props,body:'x'.repeat(4001)}}]},
    {...draft,content:[{type:'Program',props:{id:'p',items:[{time:'25:00',label:'no'}]}}]},
    {...draft,content:[{type:'Program',props:{id:'p',items:Array.from({length:25},()=>({time:'12:00',label:'no'}))}}]},
    {...draft,content:[{type:'Place',props:{id:'p',name:'Place',address:'x'.repeat(501)}}]},
    {...draft,content:[{type:'Photo',props:{id:'p',image:'https://example.invalid/photo.jpg',caption:'no'}}]},
  ])('rejects unsafe shape %#',async value=>{await expect(parseInvitationDesign(value)).rejects.toMatchObject({statusCode:422})})
  it.each(['png','jpeg','webp'] as const)('fully decodes and normalizes %s without EXIF',async format=>{
    const raw=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).withExif({IFD0:{Artist:'PRIVATE_EXIF'}}).toFormat(format).toBuffer()
    const normalized=await normalizeInvitationPhoto(`data:image/${format};base64,${raw.toString('base64')}`)
    expect(normalized).toMatch(/^data:image\/webp;base64,/)
    const meta=await sharp(Buffer.from(normalized.split(',')[1]!,'base64')).metadata()
    expect(meta.format).toBe('webp');expect(meta.exif).toBeUndefined();expect(meta.width).toBe(10)
  })
  it.each(['data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,AA==','data:image/jpeg;base64,AAAA','data:image/webp;base64,AAAA'])('rejects invalid, mismatched and vector bytes %s',async value=>{await expect(normalizeInvitationPhoto(value)).rejects.toMatchObject({statusCode:422})})
  it('rejects a corrupt PNG after its valid signature',async()=>{
    const png=await sharp({create:{width:10,height:10,channels:3,background:'#abc'}}).png().toBuffer()
    await expect(normalizeInvitationPhoto('data:image/png;base64,'+png.subarray(0,30).toString('base64'))).rejects.toMatchObject({statusCode:422})
  })
  it('rejects excessive dimensions before saving',async()=>{
    const png=await sharp({create:{width:4097,height:1,channels:3,background:'#abc'}}).png().toBuffer()
    await expect(normalizeInvitationPhoto('data:image/png;base64,'+png.toString('base64'))).rejects.toMatchObject({statusCode:422})
  })
  it('accepts exact text/id/block/program limits, then rejects every immediate overflow',async()=>{
    const text={type:'Text',props:{id:'a'.repeat(80),heading:'h'.repeat(120),body:'b'.repeat(4000)}}
    const program={type:'Program',props:{id:'p',items:Array.from({length:24},()=>({time:'23:59',label:'x'.repeat(240)}))}}
    const place={type:'Place',props:{id:'v',name:'n'.repeat(240),address:'a'.repeat(500)}}
    const exact={schemaVersion:1,content:[text,program,place,...Array.from({length:13},(_,i)=>({type:'Text',props:{id:'x'+i,heading:'',body:''}}))]}
    expect((await parseInvitationDesign(exact)).content).toHaveLength(16)
    for(const props of [{...text.props,id:'a'.repeat(81)},{...text.props,heading:'h'.repeat(121)},{...text.props,body:'b'.repeat(4001)}])await expect(parseInvitationDesign({schemaVersion:1,content:[{...text,props}]})).rejects.toMatchObject({statusCode:422})
    for(const invalid of [{...exact,content:[...exact.content,{type:'Text',props:{id:'extra',heading:'',body:''}}]},
      {schemaVersion:1,content:[{...program,props:{...program.props,items:[...program.props.items,{time:'00:00',label:''}]}}]},
      {schemaVersion:1,content:[{...program,props:{id:'p',items:[{time:'00:00',label:'x'.repeat(241)}]}}]},
      {schemaVersion:1,content:[{...place,props:{...place.props,name:'n'.repeat(241)}}]},
      {schemaVersion:1,content:[{...place,props:{...place.props,address:'a'.repeat(501)}}]}])await expect(parseInvitationDesign(invalid)).rejects.toMatchObject({statusCode:422})
  })
  it('accepts exactly three photos and240character captions; rejects a fourth or241',async()=>{
    const image=photoUri(await png()),photos=Array.from({length:3},(_,i)=>({type:'Photo',props:{id:'photo'+i,image,caption:'c'.repeat(240)}}))
    expect((await parseInvitationDesign({schemaVersion:1,content:photos})).content).toHaveLength(3)
    await expect(parseInvitationDesign({schemaVersion:1,content:[...photos,{...photos[0],props:{...photos[0]!.props,id:'fourth'}}]})).rejects.toMatchObject({statusCode:422})
    await expect(parseInvitationDesign({schemaVersion:1,content:[{type:'Photo',props:{id:'p',image,caption:'c'.repeat(241)}}]})).rejects.toMatchObject({statusCode:422})
  })
  it.each([[4096,1],[1,4096],[4000,2000]])('fully decodes the allowed raster boundary%s×%s',async(width,height)=>{
    const result=await normalizeInvitationPhoto(photoUri(await png(width,height)))
    const meta=await sharp(Buffer.from(result.split(',')[1]!,'base64')).metadata();expect([meta.width,meta.height]).toEqual([width,height])
  })
  it.each([[4097,1],[1,4097],[4001,2000]])('rejects excess raster dimensions/pixels%s×%s',async(width,height)=>{await expect(normalizeInvitationPhoto(photoUri(await png(width,height)))).rejects.toMatchObject({statusCode:422})})
  it('accepts a valid128KiB PNG and rejects one extra decoded byte and wrong MIME',async()=>{
    const base=await png(),exact=paddedPng(base,128*1024),above=paddedPng(base,128*1024+1)
    expect((await sharp(exact).metadata()).width).toBe(4)
    expect(await normalizeInvitationPhoto(photoUri(exact))).toMatch(/^data:image\/webp;/)
    await expect(normalizeInvitationPhoto(photoUri(above))).rejects.toMatchObject({statusCode:422})
    await expect(normalizeInvitationPhoto(photoUri(base,'jpeg'))).rejects.toMatchObject({statusCode:422})
  })
  it.each(['png','webp'] as const)('refuses a real two-frame%s animation',async type=>{
    const bytes=animation(type);if(type==='webp')expect((await sharp(bytes,{animated:true}).metadata()).pages).toBe(2)
    else expect(bytes.includes(Buffer.from('acTL'))).toBe(true)
    await expect(normalizeInvitationPhoto(photoUri(bytes,type))).rejects.toMatchObject({statusCode:422})
  })
})
const DB=process.env.TEST_DATABASE_URL,SECRET='i'.repeat(48),POLICY='2026-09-02'
describe.skipIf(!DB)('draft publication and versions on live PostgreSQL',()=>{
  let app:FastifyInstance
  beforeAll(async()=>{app=await buildApp({env:'test',databaseUrl:DB,redisUrl:null,jwtAccessSecret:SECRET,jwtRefreshSecret:'r'.repeat(48),policyVersion:POLICY});await app.ready()})
  afterAll(async()=>{await app?.close()})
  async function setup(){
    const uid=randomUUID(),sid=randomUUID(),wid=randomUUID()
    await app.db!.query('insert into users(id,phone,name) values($1,$2,$3)',[uid,'+79'+randomInt(100000000,999999999),'Synthetic invitations'])
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)',[sid,uid,randomUUID()])
    await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',[randomUUID(),uid,POLICY])
    await app.db!.query("insert into weddings(id,owner_id,title,date,tz,invite_code) values($1,$2,'Invitation','2027-06-14','Europe/Moscow',$3)",[wid,uid,randomUUID()])
    await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')",[wid,uid])
    const authorization='Bearer '+await signAccessToken(SECRET,{sub:uid,sid})
    return {uid,sid,wid,authorization,path:`/weddings/${wid}/invitation-design`}
  }
  it('keeps draft private, publishes explicitly, and refuses a stale device',async()=>{
    const w=await setup(),headers={authorization:w.authorization}
    const initial=await app.inject({method:'GET',url:w.path,headers});expect(initial.statusCode).toBe(200);expect(initial.headers.etag).toBe('"invitation-0"')
    const save=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':initial.headers.etag!},payload:draft})
    expect(save.statusCode,save.body).toBe(200);expect(save.json().published).toBeNull()
    const stale=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':initial.headers.etag!},payload:draft});expect(stale.statusCode,stale.body).toBe(409)
    const published=await app.inject({method:'POST',url:w.path+'/publish',headers:{...headers,'if-match':save.headers.etag!},payload:{}})
    expect(published.statusCode,published.body).toBe(200);expect(published.json().published).toEqual(draft)
    const second={schemaVersion:1,content:[{...block,props:{...block.props,body:'PRIVATE_DRAFT'}}]}
    const saved=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':published.headers.etag!},payload:second});expect(saved.statusCode,saved.body).toBe(200)
    const guest=await app.inject({method:'POST',url:`/weddings/${w.wid}/guests`,headers,payload:{name:'Synthetic guest'}});expect(guest.statusCode,guest.body).toBe(201)
    const link=await app.inject({method:'POST',url:`/weddings/${w.wid}/guests/${guest.json().id}/invite-link`,headers});expect(link.statusCode,link.body).toBe(200)
    const code=new URL(link.json().url,'http://localhost').pathname.split('/').pop()!
    const exchange=await app.inject({method:'GET',url:`/invite/${code}`});expect(exchange.statusCode,exchange.body).toBe(200)
    expect(exchange.json().wedding.invitationDesign).toEqual(draft);expect(exchange.body).not.toContain('PRIVATE_DRAFT')
    const rsvp=await app.inject({method:'GET',url:`/rsvp/${exchange.json().guestToken}`});expect(rsvp.statusCode,rsvp.body).toBe(200)
    expect(rsvp.json().wedding.invitationDesign).toEqual(draft);expect(rsvp.body).not.toContain('PRIVATE_DRAFT')
  })
  it('serializes two devices so one wins and the other receives 409',async()=>{
    const w=await setup(), headers={authorization:w.authorization,'if-match':'"invitation-0"'}
    const responses=await Promise.all([1,2].map(()=>app.inject({method:'PUT',url:w.path,headers,payload:draft})))
    expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409])
    expect((await app.db!.query('select version::text from invitation_designs where wedding_id=$1',[w.wid])).rows[0].version).toBe('1')
  })
  it('does not give a newer publication to a link revoked during an actual wedding-lock wait',async()=>{
    const w=await setup(),headers={authorization:w.authorization}
    const save=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':'"invitation-0"'},payload:draft});expect(save.statusCode,save.body).toBe(200)
    const publish=await app.inject({method:'POST',url:w.path+'/publish',headers:{...headers,'if-match':save.headers.etag!},payload:{}});expect(publish.statusCode,publish.body).toBe(200)
    const guest=await app.inject({method:'POST',url:`/weddings/${w.wid}/guests`,headers,payload:{name:'Synthetic guest'}})
    const link=await app.inject({method:'POST',url:`/weddings/${w.wid}/guests/${guest.json().id}/invite-link`,headers})
    const code=new URL(link.json().url).pathname.split('/').pop()!
    let pending:ReturnType<FastifyInstance['inject']>|undefined,settled=false
    try {
      await app.db!.tx(async client=>{
        const pid=(await client.query<{pid:number}>('select pg_backend_pid() as pid')).rows[0]!.pid
        await client.query('select id from weddings where id=$1 for update',[w.wid])
        pending=app.inject({method:'GET',url:`/invite/${code}`}).then(response=>{settled=true;return response})
        let blocked=false;const deadline=Date.now()+12_000
        while(Date.now()<deadline&&!settled){
          await client.query('select pg_stat_clear_snapshot()')
          if((await client.query('select 1 from pg_stat_activity where wait_event_type=\'Lock\' and $1=any(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break}
          await new Promise(resolve=>setTimeout(resolve,10))
        }
        expect(blocked,'must observe real PostgreSQL wait').toBe(true)
        await client.query("update guest_invite_codes set expires_at=clock_timestamp()-interval '1 second' where code=$1",[code])
        await client.query('update guest_parties set invite_token=$2 where wedding_id=$1',[w.wid,randomUUID()])
        const newer={schemaVersion:1,content:[{...block,props:{...block.props,body:'NEW_PUBLICATION_AFTER_REVOCATION'}}]}
        await client.query('update invitation_designs set published=$2,version=version+1 where wedding_id=$1',[w.wid,JSON.stringify(newer)])
      })
    } finally {if(pending)await pending}
    const response=await pending!;expect(response.statusCode,response.body).toBe(410);expect(response.body).not.toContain('NEW_PUBLICATION_AFTER_REVOCATION');expect(response.json()).not.toHaveProperty('guestToken')
  })
  it('requires a valid version and current couple permission',async()=>{
    const w=await setup(),headers={authorization:w.authorization}
    expect((await app.inject({method:'PUT',url:w.path,headers,payload:draft})).statusCode).toBe(428)
    expect((await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':'*'},payload:draft})).statusCode).toBe(422)
    await app.db!.query("update wedding_members set role='helper' where wedding_id=$1",[w.wid])
    expect((await app.inject({method:'GET',url:w.path,headers})).statusCode).toBe(200)
    expect((await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':'"invitation-0"'},payload:draft})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:w.path+'/publish',headers:{...headers,'if-match':'"invitation-0"'},payload:{}})).statusCode).toBe(403)
  })
  it('refuses stale publish and an empty publication; concurrent save/publish has exactly one version winner',async()=>{
    const w=await setup(),headers={authorization:w.authorization}
    const save=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':'"invitation-0"'},payload:draft});expect(save.statusCode,save.body).toBe(200)
    expect((await app.inject({method:'POST',url:w.path+'/publish',headers:{...headers,'if-match':'"invitation-0"'},payload:{}})).statusCode).toBe(409)
    const results=await Promise.all([app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':save.headers.etag!},payload:draft}),app.inject({method:'POST',url:w.path+'/publish',headers:{...headers,'if-match':save.headers.etag!},payload:{}})])
    expect(results.map(r=>r.statusCode).sort()).toEqual([200,409]);expect((await app.db!.query('select version::text from invitation_designs where wedding_id=$1',[w.wid])).rows[0].version).toBe('2')
    const empty=await setup(),saved=await app.inject({method:'PUT',url:empty.path,headers:{authorization:empty.authorization,'if-match':'"invitation-0"'},payload:{schemaVersion:1,content:[]}})
    expect(saved.statusCode,saved.body).toBe(200);expect((await app.inject({method:'POST',url:empty.path+'/publish',headers:{authorization:empty.authorization,'if-match':saved.headers.etag!},payload:{}})).statusCode).toBe(422)
  })
  it('HTTP rejects bad photo bytes without changing saved draft/version/publication',async()=>{
    const w=await setup(),headers={authorization:w.authorization}
    const save=await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':'"invitation-0"'},payload:draft});expect(save.statusCode,save.body).toBe(200)
    const before=(await app.db!.query('select row_to_json(d) value from invitation_designs d where wedding_id=$1',[w.wid])).rows
    for(const image of [photoUri(await png(),'jpeg'),photoUri(animation('png')),photoUri(animation('webp')),photoUri(paddedPng(await png(),128*1024+1))]){
      const bad={schemaVersion:1,content:[{type:'Photo',props:{id:'p',image,caption:''}}]}
      expect((await app.inject({method:'PUT',url:w.path,headers:{...headers,'if-match':save.headers.etag!},payload:bad})).statusCode).toBe(422)
      expect((await app.db!.query('select row_to_json(d) value from invitation_designs d where wedding_id=$1',[w.wid])).rows).toEqual(before)
    }
  })
  for(const method of ['GET','PUT','publish'] as const)for(const revoke of ['role','session','consent','expiry'] as const)it(`${method} refuses ${revoke} revoked during an observed native wedding-lock wait`,async()=>{
    const w=await setup(),save=await app.inject({method:'PUT',url:w.path,headers:{authorization:w.authorization,'if-match':'"invitation-0"'},payload:draft});expect(save.statusCode,save.body).toBe(200)
    const before=(await app.db!.query('select row_to_json(d) value from invitation_designs d where wedding_id=$1',[w.wid])).rows
    const expires=Math.floor(Date.now()/1000)+3
    if(revoke==='expiry')w.authorization='Bearer '+await signAccessToken(SECRET,{sub:w.uid,sid:w.sid},(expires-ACCESS_TTL_SECONDS)*1000)
    let pending:ReturnType<FastifyInstance['inject']>|undefined,settled=false
    try{await app.db!.tx(async c=>{
      const pid=(await c.query('select pg_backend_pid() pid')).rows[0].pid;await c.query('select id from weddings where id=$1 for update',[w.wid])
      pending=app.inject({method:method==='publish'?'POST':method,url:w.path+(method==='publish'?'/publish':''),headers:{authorization:w.authorization,'if-match':save.headers.etag!},...(method==='GET'?{}:{payload:method==='PUT'?draft:{}})}).then(r=>{settled=true;return r})
      let blocked=false;const until=Date.now()+8000
      while(Date.now()<until&&!settled){await c.query('select pg_stat_clear_snapshot()');if((await c.query("select 1 from pg_stat_activity where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break}await new Promise(r=>setTimeout(r,10))}
      expect(blocked,'actual PostgreSQL access wait required').toBe(true)
      if(revoke==='role')await c.query("update wedding_members set role='vendor' where wedding_id=$1 and user_id=$2",[w.wid,w.uid])
      if(revoke==='session')await c.query('update sessions set revoked_at=clock_timestamp() where id=$1',[w.sid])
      if(revoke==='consent')await c.query('update consents set withdrawn_at=clock_timestamp() where user_id=$1',[w.uid])
      if(revoke==='expiry')await new Promise(r=>setTimeout(r,Math.max(0,expires*1000+120-Date.now())))
    })}finally{if(pending)await pending}
    const result=await pending!;expect(result.statusCode,result.body).toBe(revoke==='role'||revoke==='consent'?403:401)
    expect((await app.db!.query('select row_to_json(d) value from invitation_designs d where wedding_id=$1',[w.wid])).rows).toEqual(before)
  })
})
