import { sendTaskReminders } from '../src/notify/task-notifications.js'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../src/auth/tokens.js'
import { randomInt, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { completeMainProgramFixture, seedUntrackedSlotDeal } from '../test/helpers/dayFixture.js'
const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !process.env.E2E_FIXTURE_FILE) throw new Error('TEST_DATABASE_URL and E2E_FIXTURE_FILE are required')
const target = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('Only disposable local *_test databases are allowed')
const accessSecret = 'local-browser-fixture-access-only-2026-test-secret'
const policyVersion = '2026-09-02'
const app = await buildApp({env:'test', databaseUrl, redisUrl:null,
  jwtAccessSecret:accessSecret, jwtRefreshSecret:'b'.repeat(48), policyVersion,corsOrigins:['http://127.0.0.1:3000'],
  ...(process.env.E2E_SC013 === 'yes' ? { vapidPublicKey: null, vapidPrivateKey: null } : {})})
let tick: Promise<unknown> | null = null
const timer: { handle?: ReturnType<typeof setInterval> } = {}
app.addHook('onClose', async () => { clearInterval(timer.handle); await tick })
await app.ready()
async function user(name:string) {
 const phone='+79'+String(randomInt(100000000,999999999))
 const a=await app.inject({method:'POST',url:'/auth/otp',payload:{phone}})
 if(a.statusCode!==200)throw new Error(a.body)
 const {rows}=await app.db!.query('select code_hash from otp_codes where phone=$1 order by created_at desc limit 1',[phone])
 const otp=rows[0]
 if(!otp)throw new Error('Missing test OTP')
 let code=''
 for(let i=0;i<10000;i++){const c=String(i).padStart(4,'0');if(hashCode('b'.repeat(48),phone,c)===otp.code_hash){code=c;break}}
 const b=await app.inject({method:'POST',url:'/auth/otp/verify',payload:{phone,code}})
 const tokens=b.json(); const headers={authorization:'Bearer '+tokens.accessToken}
 await app.inject({method:'POST',url:'/users/me/consent',headers,payload:{policyVersion:'2026-09-02',adult:true}})
 await app.inject({method:'PATCH',url:'/users/me',headers,payload:{name}})
 await app.db!.query("update users set tz='UTC' where id=$1",[tokens.user.id])
 return{tokens,headers,id:tokens.user.id}
}
const owner=await user('Аня E2E'), helper=await user('Боря E2E')
const w=await app.inject({method:'POST',url:'/weddings',headers:owner.headers,payload:{partnerName:'Боря E2E',city:{name:'Уфа',region:'Башкортостан'},date:'2027-06-14'}})
if(w.statusCode!==201)throw new Error(w.body)
const weddingId=w.json().id
await app.db!.query('insert into wedding_members(wedding_id,user_id,role) values ($1,$2,$3)',[weddingId,helper.id,'helper'])
const vendors = []
if (process.env.E2E_PAYMENT_VENDOR === 'yes') {
  for (const name of ['Видео E2E 021', 'Чужой E2E 021']) {
    const person = await user(name)
    const profile = await app.inject({ method: 'PUT', url: '/vendor/profile', headers: person.headers, payload: {
      name, categoryId: 'video', city: { name: 'Уфа', region: 'Башкортостан' },
      portfolioUrls: ['https://example.com/portfolio.jpg'], priceFrom: { amount: 1000000, currency: 'RUB' },
    } })
    if (profile.statusCode !== 200) throw new Error('Payment vendor fixture profile failed')
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: person.headers })
    if (published.statusCode !== 200) throw new Error('Payment vendor fixture publication failed')
    vendors.push({ ...person, vendorId: profile.json().id })
  }
}
async function browserAccount(name: string) {
  const userId = randomUUID()
  await app.db!.query("insert into users(id,phone,name,tz) values($1,$2,$3,'UTC')",
    [userId, '+79' + String(randomInt(100000000, 999999999)), name])
  await app.db!.query('insert into consents(id,user_id,policy_version,adult) values($1,$2,$3,true)',
    [randomUUID(), userId, policyVersion])
  async function session() {
    const id = randomUUID()
    const refreshToken = createRefreshToken()
    await app.db!.query('insert into sessions(id,user_id,refresh_hash) values($1,$2,$3)', [id, userId, hashRefreshToken(refreshToken)])
    return { accessToken: await signAccessToken(accessSecret, { sub: userId, sid: id }), refreshToken }
  }
  return { userId, first: await session(), reopened: await session() }
}

const sc001 = process.env.E2E_SC001 === 'yes' ? {
  undated: { owner: await browserAccount('Пара без даты'), helper: await browserAccount('Помощник без даты') },
  short: { owner: await browserAccount('Пара со сроком'), helper: await browserAccount('Помощник со сроком') },
} : undefined

async function planBFixture() {
  const owner = await browserAccount('Пара SC-013')
  const offlineOwner = await browserAccount('Пара SC-018')
  const coordinator = await browserAccount('Координатор SC-013')
  const helper = await browserAccount('Помощник SC-013')
  const today = (await app.db!.query<{ date: string }>("select (now() at time zone 'Asia/Yekaterinburg')::date::text as date")).rows[0]!.date
  const wedding = await app.inject({
    method: 'POST', url: '/weddings', headers: { authorization: 'Bearer ' + owner.first.accessToken },
    payload: { partnerName: 'Партнёр SC-013', city: { name: 'Уфа', region: 'Башкортостан' }, date: today },
  })
  if (wedding.statusCode !== 201) throw new Error(`SC-013 fixture wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  await app.db!.query(`insert into wedding_members(wedding_id,user_id,role)
    values($1,$2,'coordinator'),($1,$3,'helper')`, [weddingId, coordinator.userId, helper.userId])
  return { owner: owner.first, offlineOwner: offlineOwner.first, coordinator: coordinator.first, helper: helper.first, weddingId, today }
}
const sc013 = process.env.E2E_SC013 === 'yes' ? await planBFixture() : undefined
async function thanksFixture() {
  const owner = await browserAccount('Пара SC-015')
  const wedding = await app.inject({
    method: 'POST', url: '/weddings', headers: { authorization: 'Bearer ' + owner.first.accessToken },
    payload: { partnerName: 'Партнёр SC-015', city: { name: 'Уфа', region: 'Башкортостан' } },
  })
  if (wedding.statusCode !== 201) throw new Error(`SC-015 fixture wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  await completeMainProgramFixture(app, weddingId, 2)
  return { owner: owner.first, weddingId }
}
const sc015 = process.env.E2E_SC015 === 'yes' ? await thanksFixture() : undefined

async function contractFixture() {
  const owner = await browserAccount('Владелец договора SC-017')
  const viewer = await browserAccount('Участник договора SC-017')
  const headers = { authorization: 'Bearer ' + owner.first.accessToken }
  const wedding = await app.inject({ method: 'POST', url: '/weddings', headers,
    payload: { partnerName: 'Пара SC-017', city: { name: 'Уфа', region: 'Башкортостан' } } })
  if (wedding.statusCode !== 201) throw new Error(`SC-017 wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, viewer.userId])
  const slot = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' limit 1", [weddingId])).rows[0]!
  const { dealId } = await seedUntrackedSlotDeal(app, { weddingId, slotId: slot.id, externalName: 'Фотограф SC-017', state: 'booked', price: null })
  const journalNote = 'Изменение цены SC-017'
  await app.db!.query(`insert into deal_events(id,deal_id,from_state,to_state,actor_id,note,kind)
    values($1,$2,'booked','booked',$3,$4,'price')`, [randomUUID(), dealId, owner.userId, journalNote])
  const marker = 'Заказчик редакции SC-017'
  const document = await app.inject({ method: 'POST', url: `/deals/${dealId}/contract`, headers, payload: {
    templateCode: 'photographer', fields: { customerFullName: marker, performerFullName: 'Фотограф SC-017' },
  } })
  if (document.statusCode !== 201) throw new Error(`SC-017 contract returned ${document.statusCode}`)
  const eventsUrl = `/weddings/${weddingId}/events`
  const year = new Date().getUTCFullYear() + 1
  const timeZone = 'Asia/Yekaterinburg'
  const title = 'Второй день SC-017'
  const events = await app.inject({ method: 'GET', url: eventsUrl, headers })
  const event = await app.inject({ method: 'POST', url: eventsUrl, headers: { ...headers, 'if-match': events.headers.etag },
    payload: { name: title, kind: 'second_day', date: `${year}-07-11`, timeZone } })
  if (event.statusCode !== 201) throw new Error(`SC-017 event returned ${event.statusCode}`)
  const { id: eventId, date } = event.json<{ id: string; date: string }>()
  const added = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/additional`,
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { categoryId: 'photo', programEventId: eventId, label: 'Фотограф второго дня' } })
  if (added.statusCode !== 201) throw new Error(`SC-017 additional slot returned ${added.statusCode}`)
  const vendor = await browserAccount('Исполнитель переноса SC-017'), vendorId = randomUUID()
  await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Фотограф второго дня',now())",
    [vendorId, vendor.userId])
  const booking = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${added.json<{ id: string }>().id}/book`,
    headers: { ...headers, 'idempotency-key': randomUUID(), 'x-program-event-context': JSON.stringify({ id: eventId, date, timeZone }) },
    payload: { vendorId, price: { amount: 1234500, currency: 'RUB' } } })
  if (booking.statusCode !== 200) throw new Error(`SC-017 move booking returned ${booking.statusCode}`)
  const latest = await app.inject({ method: 'GET', url: eventsUrl, headers })
  const proposal = await app.inject({ method: 'POST', url: `${eventsUrl}/${eventId}/move-proposals`,
    headers: { ...headers, 'if-match': latest.headers.etag, 'idempotency-key': randomUUID() },
    payload: { date: `${year}-07-12`, timeZone, location: 'Площадка второго дня SC-017' } })
  if (proposal.statusCode !== 201) throw new Error(`SC-017 move proposal returned ${proposal.statusCode}`)
  const move = { title, dealId: booking.json<{ deal: { id: string } }>().deal.id, proposalId: proposal.json<{ id: string }>().id }
  return { weddingId, dealId, documentId: document.json<{ id: string }>().id, marker, journalNote, move,
    owner: owner.first, viewer: viewer.first, viewerId: viewer.userId }
}
const contractAccess = process.env.E2E_CONTRACT_ACCESS === 'yes' ? await contractFixture() : undefined
await writeFile(process.env.E2E_FIXTURE_FILE,JSON.stringify({owner,helper,vendors,weddingId,sc001,sc013,sc015,contractAccess,today:new Date().toISOString().slice(0,10)}), {mode: 0o600})
await app.listen({host:'127.0.0.1',port:3001})
process.stdout.write('BROWSER_FIXTURE_READY\n')
// The production worker runs every minute. The disposable fixture exercises the
// same job function more frequently; it exposes no extra HTTP endpoint.
timer.handle = setInterval(() => {
  if (tick) return
  tick = sendTaskReminders(app).catch(err => app.log.error({ err }, 'browser reminder tick failed'))
    .finally(() => { tick = null })
}, 500)
process.on('SIGTERM',()=>{void app.close()})
