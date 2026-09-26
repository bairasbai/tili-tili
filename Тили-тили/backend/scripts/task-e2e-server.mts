import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { randomInt } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !process.env.E2E_FIXTURE_FILE) throw new Error('TEST_DATABASE_URL and E2E_FIXTURE_FILE are required')
const target = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('Only disposable local *_test databases are allowed')
const app = await buildApp({env:'test', databaseUrl, redisUrl:null,
  jwtAccessSecret:'a'.repeat(48), jwtRefreshSecret:'b'.repeat(48), policyVersion:'2026-09-02',corsOrigins:['http://127.0.0.1:3000']})
await app.ready()
async function user(name:string) {
 const phone='+79'+String(randomInt(100000000,999999999))
 const a=await app.inject({method:'POST',url:'/auth/otp',payload:{phone}})
 if(a.statusCode!==200)throw new Error(a.body)
 const {rows}=await app.db!.query('select code_hash from otp_codes where phone=$1 order by created_at desc limit 1',[phone])
 let code=''
 for(let i=0;i<10000;i++){const c=String(i).padStart(4,'0');if(hashCode('b'.repeat(48),phone,c)===rows[0].code_hash){code=c;break}}
 const b=await app.inject({method:'POST',url:'/auth/otp/verify',payload:{phone,code}})
 const tokens=b.json(); const headers={authorization:'Bearer '+tokens.accessToken}
 await app.inject({method:'POST',url:'/users/me/consent',headers,payload:{policyVersion:'2026-09-02',adult:true}})
 await app.inject({method:'PATCH',url:'/users/me',headers,payload:{name}})
 return{tokens,headers,id:tokens.user.id}
}
const owner=await user('Аня E2E'), helper=await user('Боря E2E')
const w=await app.inject({method:'POST',url:'/weddings',headers:owner.headers,payload:{partnerName:'Боря E2E',city:{name:'Уфа',region:'Башкортостан'},date:'2027-06-14'}})
if(w.statusCode!==201)throw new Error(w.body)
const weddingId=w.json().id
await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values ($1,$2,$3)',[weddingId,helper.id,'helper'])
await writeFile(process.env.E2E_FIXTURE_FILE,JSON.stringify({owner,helper,weddingId}), {mode: 0o600})
await app.listen({host:'127.0.0.1',port:3001})
process.stdout.write('BROWSER_FIXTURE_READY\n')
process.on('SIGTERM',()=>{void app.close()})
