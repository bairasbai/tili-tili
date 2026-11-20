import { sendTaskReminders } from '../src/notify/task-notifications.js'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { createRefreshToken, hashRefreshToken, signAccessToken } from '../src/auth/tokens.js'
import { createHash, randomInt, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { completeMainProgramFixture, seedUntrackedSlotDeal } from '../test/helpers/dayFixture.js'
import { normalizeOfferPriceComponents } from '../src/offers/price-breakdown.js'
import { managedMediaFixture, syntheticPdf } from '../test/helpers/managedMediaFixture.js'
import { storeTillyActions } from '../src/tilly/actions.js'
const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !process.env.E2E_FIXTURE_FILE) throw new Error('TEST_DATABASE_URL and E2E_FIXTURE_FILE are required')
const target = new URL(databaseUrl)
if (!['127.0.0.1', 'localhost'].includes(target.hostname) || !target.pathname.endsWith('_test')) throw new Error('Only disposable local *_test databases are allowed')
const accessSecret = 'local-browser-fixture-access-only-2026-test-secret'
const policyVersion = '2026-09-02'
const mediaProvider = process.env.E2E_CONTRACT_ACCESS === 'yes' || process.env.E2E_WP01_PDF === 'yes'
  ? await managedMediaFixture('http://127.0.0.1:3000') : null
const app = await buildApp({env:'test', databaseUrl, redisUrl:null,
  jwtAccessSecret:accessSecret, jwtRefreshSecret:'b'.repeat(48), policyVersion,corsOrigins:['http://127.0.0.1:3000'],
  ...(mediaProvider ? { mediaStorage: mediaProvider.config } : {}),
  ...(process.env.E2E_SC013 === 'yes' ? { vapidPublicKey: null, vapidPrivateKey: null } : {})})
let tick: Promise<unknown> | null = null
const timer: { handle?: ReturnType<typeof setInterval> } = {}
app.addHook('onClose', async () => { clearInterval(timer.handle); try { await tick } finally { await mediaProvider?.close() } })
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
const timelineEditors = process.env.E2E_SC017_PROGRAM === 'yes' ? {
  ru: await browserAccount('Редактор программы RU'),
  en: await browserAccount('Редактор программы EN'),
  contractor: (await browserAccount('Организатор для подрядчика SC-017')).first,
} : undefined

async function bookedPhotoFixture(label: string) {
  const owner = await browserAccount('Пара ' + label)
  const vendor = await browserAccount('Подрядчик ' + label)
  const headers = { authorization: 'Bearer ' + owner.first.accessToken }
  const wedding = await app.inject({ method: 'POST', url: '/weddings', headers,
    payload: { partnerName: 'Пара ' + label, city: { name: 'Уфа', region: 'Башкортостан' }, date: '2027-06-14' } })
  if (wedding.statusCode !== 201) throw new Error(`${label} wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  const vendorId = randomUUID()
  await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo',$3,now())",
    [vendorId, vendor.userId, 'Подрядчик ' + label])
  const slot = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' limit 1", [weddingId])).rows[0]!
  const deal = await seedUntrackedSlotDeal(app, { weddingId, slotId: slot.id, vendorId, state: 'booked', price: 1234500 })
  return { weddingId, ...deal, vendorId, owner: owner.first, vendor: vendor.first }
}

async function deliveryFixture(lang: string) {
  const { vendorId, ...booked } = await bookedPhotoFixture('WP06 ' + lang)
  const worker = await browserAccount('Сотрудник WP06 ' + lang)
  const vendorHeaders = { authorization: 'Bearer ' + booked.vendor.accessToken }
  const staff = await app.inject({ method: 'POST', url: `/vendor/companies/${vendorId}/staff`, headers: vendorHeaders,
    payload: { targetUserId: worker.userId, role: 'worker' } })
  if (staff.statusCode !== 201) throw new Error(`WP06 staff invitation returned ${staff.statusCode}`)
  const joined = await app.inject({ method: 'POST', url: '/users/me/vendor-staff/invitations/accept',
    headers: { authorization: 'Bearer ' + worker.first.accessToken }, payload: { token: staff.json<{ token: string }>().token } })
  if (joined.statusCode !== 200) throw new Error(`WP06 staff acceptance returned ${joined.statusCode}`)
  return { ...booked, worker: worker.first }
}
const wp06 = process.env.E2E_WP06 === 'yes' ? { ru: await deliveryFixture('RU'), en: await deliveryFixture('EN') } : undefined

async function pdfFixture(lang: string) {
  const data = await bookedPhotoFixture('WP01 PDF ' + lang)
  const document = await app.inject({ method: 'POST', url: `/deals/${data.dealId}/contract`,
    headers: { authorization: 'Bearer ' + data.owner.accessToken },
    payload: { templateCode: 'photographer', fields: { customerFullName: 'Пара WP01', performerFullName: 'Фотограф WP01' } } })
  if (document.statusCode !== 201) throw new Error(`WP01 PDF contract returned ${document.statusCode}`)
  return { weddingId: data.weddingId, dealId: data.dealId, owner: data.owner, documentId: document.json<{ id: string }>().id }
}
const wp01Pdf = process.env.E2E_WP01_PDF === 'yes'
  ? { ru: await pdfFixture('RU'), en: await pdfFixture('EN'), bytes: syntheticPdf().toString('base64') } : undefined

async function calendarFixture(lang: string) {
  const vendor = await browserAccount('Календарь WP05 ' + lang)
  await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo',$3,now())",
    [randomUUID(), vendor.userId, 'Календарь WP05 ' + lang])
  return vendor.first
}
const wp05 = process.env.E2E_WP05 === 'yes' ? { ru: await calendarFixture('RU'), en: await calendarFixture('EN') } : undefined

async function delegationFixture(lang: string) {
  const owner = await browserAccount('Пара WP09 ' + lang)
  const recipient = await browserAccount('Помощник WP09 ' + lang)
  const date = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10)
  const wedding = await app.inject({ method: 'POST', url: '/weddings',
    headers: { authorization: 'Bearer ' + owner.first.accessToken },
    payload: { partnerName: 'Пара WP09 ' + lang, city: { name: 'Уфа', region: 'Башкортостан' }, date } })
  if (wedding.statusCode !== 201) throw new Error(`WP09 wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  const taskTitle = 'Confirm meeting point WP09 ' + lang
  await app.db!.query("insert into tasks(id,wedding_id,title,kind,source,period) values($1,$2,$3,'checklist','user','3')",
    [randomUUID(), weddingId, taskTitle])
  return { weddingId, taskTitle, owner: owner.first, recipient: recipient.first }
}
const wp09 = process.env.E2E_WP09 === 'yes' ? { ru: await delegationFixture('RU'), en: await delegationFixture('EN') } : undefined

async function priceFixture(lang: string) {
  const booked = await bookedPhotoFixture('WP12 ' + lang)
  const path = `/deals/${booked.dealId}/order`
  const call = async (token: string, method: 'GET' | 'POST', url: string, payload?: object) => {
    const response = await app.inject({ method, url, headers: { authorization: 'Bearer ' + token,
      ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) }, payload })
    if (response.statusCode !== 200) throw new Error(`WP12 ${method} ${url} returned ${response.statusCode}`)
    return response
  }
  const rate = { amount: 12505, currency: 'RUB' }
  const components = normalizeOfferPriceComponents(1234500, [{ kind: 'overtime', status: 'separate',
    amount: null, formula: { unit: 'hour', quantity: '2', rate } }])
  await app.db!.query('insert into offer_price_breakdowns(deal_id,base_amount,components) values($1,$2,$3::jsonb)',
    [booked.dealId, 1234500, JSON.stringify(components)])
  const order = (await call(booked.owner.accessToken, 'GET', path)).json<{ version: string }>()
  await call(booked.owner.accessToken, 'POST', path + '/terms/proposals',
    { expectedOrderVersion: order.version, expectedTermsRevision: '0' })
  for (const actor of [booked.owner, booked.vendor]) {
    const terms = (await call(actor.accessToken, 'GET', path + '/terms'))
      .json<{ selected: { id: string; version: string; digest: string }; readToken: string }>()
    await call(actor.accessToken, 'POST', path + '/terms/' + terms.selected.id + '/accept',
      { expectedTermsVersion: terms.selected.version, digest: terms.selected.digest, readToken: terms.readToken })
  }
  return booked
}
const wp12 = process.env.E2E_WP12 === 'yes' ? { ru: await priceFixture('RU'), en: await priceFixture('EN') } : undefined

async function eventRsvpFixture(lang: string) {
  const owner = await browserAccount('Пара WP04 ' + lang)
  const headers = { authorization: 'Bearer ' + owner.first.accessToken }
  const wedding = await app.inject({ method: 'POST', url: '/weddings', headers,
    payload: { partnerName: 'Пара WP04 ' + lang, city: { name: 'Уфа', region: 'Башкортостан' } } })
  if (wedding.statusCode !== 201) throw new Error(`WP04 wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  const guestName = 'Guest WP04 ' + lang
  const guest = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests`, headers, payload: { name: guestName } })
  if (guest.statusCode !== 201) throw new Error(`WP04 guest returned ${guest.statusCode}`)
  const guestId = guest.json<{ id: string }>().id
  const path = `/weddings/${weddingId}/events`
  const events = []
  for (const name of ['Ceremony WP04', 'Brunch WP04']) {
    const listing = await app.inject({ method: 'GET', url: path, headers })
    const created = await app.inject({ method: 'POST', url: path, headers: { ...headers, 'if-match': listing.headers.etag },
      payload: { name, kind: 'other', timeZone: 'Asia/Yekaterinburg' } })
    if (created.statusCode !== 201) throw new Error(`WP04 event returned ${created.statusCode}`)
    const id = created.json<{ id: string }>().id
    const roster = path + '/' + id + '/invitations'
    const current = await app.inject({ method: 'GET', url: roster, headers })
    const invited = await app.inject({ method: 'PUT', url: roster, headers: { ...headers, 'if-match': current.headers.etag },
      payload: { guestIds: [guestId] } })
    if (invited.statusCode !== 200) throw new Error(`WP04 invitation returned ${invited.statusCode}`)
    events.push({ id, name })
  }
  const link = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/${guestId}/invite-link`, headers })
  if (link.statusCode !== 200) throw new Error(`WP04 link returned ${link.statusCode}`)
  return { guestId, guestName, events, code: link.json<{ url: string }>().url.split('/').pop()! }
}
const wp04 = process.env.E2E_WP04 === 'yes' ? { ru: await eventRsvpFixture('RU'), en: await eventRsvpFixture('EN') } : undefined

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
  const viewer = await browserAccount('Участник альбома SC-015')
  const staff = await browserAccount('Ответственный за обращение SC-015')
  const wedding = await app.inject({
    method: 'POST', url: '/weddings', headers: { authorization: 'Bearer ' + owner.first.accessToken },
    payload: { partnerName: 'Партнёр SC-015', city: { name: 'Уфа', region: 'Башкортостан' } },
  })
  if (wedding.statusCode !== 201) throw new Error(`SC-015 fixture wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  await completeMainProgramFixture(app, weddingId, 2)
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, viewer.userId])
  await app.db!.query('update users set is_staff=true where id=$1', [staff.userId])
  await app.db!.query("insert into album_photos(id,wedding_id,url,approved) values($1,$2,'http://127.0.0.1:3000/icon-512.png',false)",
    [randomUUID(), weddingId])
  return { owner: owner.first, weddingId, viewer: viewer.first, viewerId: viewer.userId, staff: staff.first }
}
const sc015 = process.env.E2E_SC015 === 'yes' ? await thanksFixture() : undefined

async function contractFixture() {
  const owner = await browserAccount('Владелец договора SC-017')
  const viewer = await browserAccount('Участник договора SC-017')
  const candidateViewer = await browserAccount('Участник поиска SC-017')
  const familyOwner = await browserAccount('Владелец семейного приглашения SC-017')
  const headers = { authorization: 'Bearer ' + owner.first.accessToken }
  const familyHeaders = { authorization: 'Bearer ' + familyOwner.first.accessToken }
  const wedding = await app.inject({ method: 'POST', url: '/weddings', headers,
    payload: { partnerName: 'Пара SC-017', city: { name: 'Уфа', region: 'Башкортостан' } } })
  if (wedding.statusCode !== 201) throw new Error(`SC-017 wedding returned ${wedding.statusCode}`)
  const weddingId = wedding.json<{ id: string }>().id
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'couple')", [weddingId, viewer.userId])
  await app.db!.query("insert into wedding_members(wedding_id,user_id,role) values($1,$2,'helper')", [weddingId, candidateViewer.userId])
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
  const guestWedding = await app.inject({ method: 'POST', url: '/weddings', headers: familyHeaders,
    payload: { partnerName: 'Семейное приглашение SC-017', city: { name: 'Уфа', region: 'Башкортостан' } } })
  if (guestWedding.statusCode !== 201) throw new Error(`SC-017 guest wedding returned ${guestWedding.statusCode}`)
  const guestWeddingId = guestWedding.json<{ id: string }>().id
  const guestEvents = `/weddings/${guestWeddingId}/events`
  const guestEventList = await app.inject({ method: 'GET', url: guestEvents, headers: familyHeaders })
  const guestEvent = await app.inject({ method: 'POST', url: guestEvents, headers: { ...familyHeaders, 'if-match': guestEventList.headers.etag },
    payload: { name: 'Событие для семьи SC-017', kind: 'second_day', date, timeZone } })
  if (guestEvent.statusCode !== 201) throw new Error(`SC-017 guest event returned ${guestEvent.statusCode}`)
  const guestEventId = guestEvent.json<{ id: string }>().id
  const guestsUrl = `/weddings/${guestWeddingId}/guests`
  const parent = await app.inject({ method: 'POST', url: guestsUrl, headers: familyHeaders, payload: { name: 'Семья SC-017' } })
  if (parent.statusCode !== 201) throw new Error(`SC-017 family returned ${parent.statusCode}`)
  const familyUrl = `${guestsUrl}/${parent.json<{ id: string }>().id}`
  const member = await app.inject({ method: 'POST', url: familyUrl + '/members', headers: familyHeaders, payload: { name: 'Гость второго дня SC-017' } })
  if (member.statusCode !== 201) throw new Error(`SC-017 family member returned ${member.statusCode}`)
  const guestId = member.json<{ id: string }>().id
  const invitationsUrl = `${guestEvents}/${guestEventId}/invitations`
  const invitationList = await app.inject({ method: 'GET', url: invitationsUrl, headers: familyHeaders })
  const invitation = await app.inject({ method: 'PUT', url: invitationsUrl, headers: { ...familyHeaders, 'if-match': invitationList.headers.etag },
    payload: { guestIds: [guestId] } })
  if (invitation.statusCode !== 200) throw new Error(`SC-017 invitation roster returned ${invitation.statusCode}`)
  const link = await app.inject({ method: 'POST', url: familyUrl + '/invite-link', headers: familyHeaders })
  if (link.statusCode !== 200) throw new Error(`SC-017 guest link returned ${link.statusCode}`)
  const code = link.json<{ url: string }>().url.split('/').pop()!
  const redeemed = await app.inject({ method: 'GET', url: '/invite/' + code })
  if (redeemed.statusCode !== 200) throw new Error(`SC-017 link exchange returned ${redeemed.statusCode}`)
  const { guestToken } = redeemed.json<{ guestToken: string }>()
  const programmeName = 'Программа приглашённого SC-017'
  const timelineUrl = `/weddings/${guestWeddingId}/timeline`
  const timeline = await app.inject({ method: 'GET', url: timelineUrl, headers: familyHeaders })
  const programme = await app.inject({ method: 'PUT', url: timelineUrl, headers: { ...familyHeaders, 'if-match': timeline.headers.etag },
    payload: [{ name: programmeName, forGuests: true, eventId: guestEventId }, { name: 'Внутренний блок SC-017', forGuests: false, eventId: guestEventId }] })
  if (programme.statusCode !== 200) throw new Error(`SC-017 programme returned ${programme.statusCode}`)
  const added = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/additional`,
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { categoryId: 'photo', programEventId: eventId, label: 'Фотограф второго дня' } })
  if (added.statusCode !== 201) throw new Error(`SC-017 additional slot returned ${added.statusCode}`)
  const vendor = await browserAccount('Исполнитель переноса SC-017'), vendorId = randomUUID()
  await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Фотограф второго дня',now())",
    [vendorId, vendor.userId])
  const searchSlotId = added.json<{ id: string }>().id
  const booking = await app.inject({ method: 'POST', url: `/weddings/${weddingId}/slots/${searchSlotId}/book`,
    headers: { ...headers, 'idempotency-key': randomUUID(), 'x-program-event-context': JSON.stringify({ id: eventId, date, timeZone }) },
    payload: { vendorId, price: { amount: 1234500, currency: 'RUB' } } })
  if (booking.statusCode !== 200) throw new Error(`SC-017 move booking returned ${booking.statusCode}`)
  await app.db!.query('insert into slot_shortlist(id,slot_id,vendor_id,position,added_by) values($1,$2,$3,1,$4)',
    [randomUUID(), searchSlotId, vendorId, owner.userId])
  const moveDealId = booking.json<{ deal: { id: string } }>().deal.id
  const approvalDocument = await app.inject({ method: 'POST', url: `/deals/${moveDealId}/contract`, headers, payload: {
    templateCode: 'photographer', fields: { customerFullName: 'Пара согласования SC-012', performerFullName: 'Фотограф SC-012' },
  } })
  if (approvalDocument.statusCode !== 201) throw new Error(`SC-012 contract returned ${approvalDocument.statusCode}`)
  const approvalDocumentId = approvalDocument.json<{ id: string }>().id
  const pdf = syntheticPdf()
  const uploads = `/deals/${moveDealId}/documents/${approvalDocumentId}/attachments`
  const issue = await app.inject({ method: 'POST', url: uploads,
    headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { sizeBytes: pdf.length } })
  if (issue.statusCode !== 201) throw new Error(`SC-012 PDF grant returned ${issue.statusCode}`)
  const grant = issue.json<{ uploadId: string; fields: Record<string, string>; uploadUrl: string }>()
  if (!mediaProvider || new URL(grant.uploadUrl).origin !== mediaProvider.config.endpoint) throw new Error('SC-012 PDF grant must target the test provider')
  const form = new FormData()
  for (const [key, value] of Object.entries(grant.fields)) form.append(key, value)
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'synthetic-contract.pdf')
  const sent = await fetch(grant.uploadUrl, { method: 'POST', body: form, redirect: 'error' })
  await sent.arrayBuffer()
  if (sent.status !== 204) throw new Error(`SC-012 PDF upload returned ${sent.status}`)
  const checked = await app.inject({ method: 'POST', url: `${uploads}/${grant.uploadId}/complete`, headers })
  if (checked.statusCode !== 200 || checked.json<{ state: string }>().state !== 'ready') throw new Error(`SC-012 PDF check returned ${checked.statusCode}`)
  const components = normalizeOfferPriceComponents(1234500, [{
    kind: 'overtime', status: 'separate', amount: null,
    formula: { unit: 'hour', quantity: '2', rate: { amount: 10000, currency: 'RUB' } },
  }])
  await app.db!.query('insert into offer_price_breakdowns(deal_id,base_amount,components) values($1,$2,$3::jsonb)',
    [moveDealId, 1234500, JSON.stringify(components)])
  const orderUrl = `/deals/${moveDealId}/order`
  const order = await app.inject({ method: 'GET', url: orderUrl, headers })
  if (order.statusCode !== 200) throw new Error(`SC-017 order returned ${order.statusCode}`)
  const terms = await app.inject({ method: 'POST', url: orderUrl + '/terms/proposals',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: { expectedOrderVersion: order.json<{ version: string }>().version, expectedTermsRevision: '0' } })
  if (terms.statusCode !== 200) throw new Error(`SC-017 order terms returned ${terms.statusCode}`)
  const termsId = terms.json<{ selected: { id: string } }>().selected.id
  const material = 'https://example.invalid/sc017-result'
  const delivery = await app.inject({ method: 'POST', url: orderUrl + '/delivery',
    headers: { authorization: 'Bearer ' + vendor.first.accessToken, 'idempotency-key': randomUUID() },
    payload: { kind: 'submitted', expectedRevision: 0, summary: 'Результат SC-017', materialUrl: material, dueOn: date } })
  if (delivery.statusCode !== 200) throw new Error(`SC-017 order delivery returned ${delivery.statusCode}`)
  const latest = await app.inject({ method: 'GET', url: eventsUrl, headers })
  const proposal = await app.inject({ method: 'POST', url: `${eventsUrl}/${eventId}/move-proposals`,
    headers: { ...headers, 'if-match': latest.headers.etag, 'idempotency-key': randomUUID() },
    payload: { date: `${year}-07-12`, timeZone, location: 'Площадка второго дня SC-017' } })
  if (proposal.statusCode !== 201) throw new Error(`SC-017 move proposal returned ${proposal.statusCode}`)
  const move = { title, dealId: moveDealId, proposalId: proposal.json<{ id: string }>().id }
  const worker = await browserAccount('Сотрудник SC-017')
  const workOwner = await browserAccount('Организатор поручения SC-017')
  const workVendor = await browserAccount('Компания назначения SC-017')
  const workVendorId = randomUUID()
  await app.db!.query("insert into vendors(id,user_id,category_id,name,published_at) values($1,$2,'photo','Компания назначения SC-017',now())",
    [workVendorId, workVendor.userId])
  const workHeaders = { authorization: 'Bearer ' + workOwner.first.accessToken }
  const workerHeaders = { authorization: 'Bearer ' + worker.first.accessToken }
  const vendorHeaders = { authorization: 'Bearer ' + workVendor.first.accessToken }
  const workWedding = await app.inject({ method: 'POST', url: '/weddings', headers: workHeaders,
    payload: { partnerName: 'Рабочие назначения SC-017', city: { name: 'Уфа', region: 'Башкортостан' } } })
  if (workWedding.statusCode !== 201) throw new Error(`SC-017 work wedding returned ${workWedding.statusCode}`)
  const workWeddingId = workWedding.json<{ id: string }>().id
  const workSlot = (await app.db!.query<{ id: string }>("select id from slots where wedding_id=$1 and category_id='photo' limit 1", [workWeddingId])).rows[0]!
  const workEvent = (await app.db!.query<{ id: string }>('select id from wedding_events where wedding_id=$1 and is_main', [workWeddingId])).rows[0]!
  const workDeal = await seedUntrackedSlotDeal(app, { weddingId: workWeddingId, slotId: workSlot.id, vendorId: workVendorId, state: 'booked', price: null })
  const taskId = randomUUID(), taskTitle = 'Поручение сотруднику SC-017'
  await app.db!.query("insert into tasks(id,wedding_id,title,kind,source,period) values($1,$2,$3,'checklist','user','3')", [taskId, workWeddingId, taskTitle])
  const delegationPath = `/weddings/${workWeddingId}/task-delegations`
  const issued = await app.inject({ method: 'POST', url: delegationPath, headers: workHeaders, payload: { taskId, targetUserId: worker.userId } })
  if (issued.statusCode !== 201) throw new Error(`SC-017 delegation returned ${issued.statusCode}`)
  const delegation = issued.json<{ id: string; code: string }>()
  const acceptedTask = await app.inject({ method: 'POST', url: '/users/me/task-delegations/accept', headers: workerHeaders,
    payload: { code: delegation.code } })
  if (acceptedTask.statusCode !== 204) throw new Error(`SC-017 delegation acceptance returned ${acceptedTask.statusCode}`)
  const staff = await app.inject({ method: 'POST', url: `/vendor/companies/${workVendorId}/staff`, headers: vendorHeaders,
    payload: { targetUserId: worker.userId, role: 'worker' } })
  if (staff.statusCode !== 201) throw new Error(`SC-017 staff invitation returned ${staff.statusCode}`)
  const staffInvite = staff.json<{ token: string }>()
  const acceptedStaff = await app.inject({ method: 'POST', url: '/users/me/vendor-staff/invitations/accept', headers: workerHeaders,
    payload: { token: staffInvite.token } })
  if (acceptedStaff.statusCode !== 200) throw new Error(`SC-017 staff acceptance returned ${acceptedStaff.statusCode}`)
  const dutyPath = `/vendor/deals/${workDeal.dealId}/staff-duties`, dutyTitle = 'Рабочее назначение SC-017'
  const duty = await app.inject({ method: 'POST', url: dutyPath, headers: vendorHeaders,
    payload: { memberId: acceptedStaff.json<{ id: string }>().id, programEventId: workEvent.id, role: 'performer', label: dutyTitle } })
  if (duty.statusCode !== 201) throw new Error(`SC-017 duty returned ${duty.statusCode}`)
  const assigned = duty.json<{ id: string; version: string }>()
  const chat = (await app.db!.query<{ id: string }>("select id from chats where wedding_id=$1 and kind='tilly'", [weddingId])).rows[0]!.id
  const tilly = await app.db!.tx(async client => {
    await client.query('select id from weddings where id=$1 for update', [weddingId])
    return Promise.all(['RU', 'EN'].map(async lang => {
      const question = randomUUID(), reply = randomUUID(), title = `Tilly keyboard task ${lang}`
      await client.query('insert into messages(id,chat_id,sender_id,text) values($1,$2,$3,$4),($5,$2,null,$6)',
        [question, chat, owner.userId, `Prepare a checklist item ${lang}`, reply, `Prepared a checklist item ${lang}`])
      const [action] = await storeTillyActions(client, { weddingId, chatId: chat, userId: owner.userId, questionMessageId: question }, reply,
        [{ kind: 'create_task', title, due: date, taskId: null, revision: null }])
      if (!action) throw new Error('WP08 test proposal could not be recorded')
      return { id: action.id, title }
    }))
  })
  return { weddingId, dealId, documentId: document.json<{ id: string }>().id, marker, journalNote, move, termsId, material,
    agreement: { dealId: moveDealId, documentId: approvalDocumentId, vendor: vendor.first,
      uploadId: grant.uploadId, pdfSha256: createHash('sha256').update(pdf).digest('hex') },
    search: { slotId: searchSlotId, vendorId, viewer: candidateViewer.first, viewerId: candidateViewer.userId },
    guestProgramme: { weddingId: guestWeddingId, eventId: guestEventId, guestId, guestToken, programmeName, owner: familyOwner.first },
    staff: { viewer: worker.first, taskOwner: workOwner.first, companyOwner: workVendor.first, taskTitle, dutyTitle, delegationPath: delegationPath + '/' + delegation.id,
      dutyRevokePath: dutyPath + '/' + assigned.id + '/revoke', dutyVersion: assigned.version },
    owner: owner.first, viewer: viewer.first, viewerId: viewer.userId, tilly: { chat, actions: tilly } }
}
const contractAccess = process.env.E2E_CONTRACT_ACCESS === 'yes' ? await contractFixture() : undefined
await writeFile(process.env.E2E_FIXTURE_FILE,JSON.stringify({owner,helper,vendors,weddingId,sc001,sc013,sc015,timelineEditors,wp01Pdf,wp04,wp05,wp06,wp09,wp12,contractAccess,today:new Date().toISOString().slice(0,10)}), {mode: 0o600})
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
