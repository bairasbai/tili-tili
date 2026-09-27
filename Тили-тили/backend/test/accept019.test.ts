import { randomInt, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface UserFixture {
  id: string
  token: string
}

interface WeddingFixture extends UserFixture {
  weddingId: string
  date: string
}

interface VendorFixture extends UserFixture {
  vendorId: string
  name: string
  packageId: string
  packageName: string
}

describe.skipIf(!live)('019 / US3: принятие, снимки, закрытие и приватность', () => {
  let app: FastifyInstance
  let counter = 0
  let vendorCounter = 0
  let RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUsers: string[] = []

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string, key = randomUUID()) => ({ ...auth(token), 'idempotency-key': key })
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 1_000_000,
    })
    await app.ready()
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
      if (rows.length === 0) break
      RUN = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => {
    if (!app) return
    /* Владельцы свадеб создаются раньше подрядчиков своих
     * сценариев: прямой порядок сначала удаляет каскад свадьбы. */
    const failures: unknown[] = []
    try {
      for (const id of createdUsers) {
        try {
          await app.db!.tx((client) => eraseUser(client, id))
        } catch (error) {
          failures.push(error)
        }
      }
      try {
        await app.db!.query('delete from otp_codes where phone like $1', [`+79${RUN}%`])
      } catch (error) {
        failures.push(error)
      }
    } finally {
      await app?.close()
    }
    if (failures.length > 0) throw new AggregateError(failures, 'не все фикстуры offers019 очищены')
  })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10_000; i++) {
      const code = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, code) === rows[0]!.code_hash) return code
    }
    throw new Error('код не подобрался')
  }

  async function newUser(): Promise<UserFixture> {
    const phone = nextPhone()
    const requested = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(requested.statusCode, requested.body).toBe(200)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verified.statusCode, verified.body).toBe(200)
    const body = verified.json() as { accessToken: string; user: { id: string } }
    const consent = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(consent.statusCode, consent.body).toBe(201)
    createdUsers.push(body.user.id)
    return { id: body.user.id, token: body.accessToken }
  }

  async function newWedding(date = '2034-06-14', guestsPlanned = 88): Promise<WeddingFixture> {
    const user = await newUser()
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Уфа', region: 'Башкортостан' },
        guestsPlanned,
      },
    })
    expect(created.statusCode, created.body).toBe(201)
    return { ...user, weddingId: created.json().id as string, date }
  }

  async function newVendor(categoryId = 'photo'): Promise<VendorFixture> {
    /* Номер фиксируем до первого await: параллельные newVendor()
     * иначе читали общий counter уже после чужих await. */
    const vendorSeq = ++vendorCounter
    const user = await newUser()
    const name = `Подрядчик ${RUN}-${vendorSeq}`
    const packageName = `Пакет ${RUN}-${vendorSeq}`
    const saved = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        portfolioUrls: [`https://example.com/${RUN}-${vendorSeq}.jpg`],
        priceFrom: { amount: 8_000_000, currency: 'RUB' },
        packages: [
          {
            name: packageName,
            price: { amount: 10_000_000, currency: 'RUB' },
            includes: ['8 часов', 'Ретушь'],
          },
        ],
      },
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    expect(published.statusCode, published.body).toBe(200)
    const body = saved.json() as { id: string; packages: { id: string; name: string }[] }
    return { ...user, vendorId: body.id, name, packageId: body.packages[0]!.id, packageName }
  }

  async function member(wedding: WeddingFixture, role: 'helper' | 'coordinator' | 'couple'): Promise<UserFixture> {
    const user = await newUser()
    const issued = await app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/invites`,
      headers: auth(wedding.token),
      payload: { role, label: `019-${role}` },
    })
    expect(issued.statusCode, issued.body).toBe(201)
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${issued.json().code as string}/accept`,
      headers: auth(user.token),
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    return user
  }

  async function slotOf(wedding: WeddingFixture, categoryId = 'photo'): Promise<string> {
    const response = await app.inject({
      method: 'GET',
      url: `/weddings/${wedding.weddingId}/slots`,
      headers: auth(wedding.token),
    })
    expect(response.statusCode, response.body).toBe(200)
    const slots = response.json() as { id: string; categoryId: string }[]
    const slot = slots.find((item) => item.categoryId === categoryId)
    if (!slot) throw new Error(`нет слота ${categoryId}`)
    return slot.id
  }

  const addCandidate = (wedding: WeddingFixture, vendor: VendorFixture) =>
    app.inject({
      method: 'PUT',
      url: `/weddings/${wedding.weddingId}/shortlist/${vendor.vendorId}`,
      headers: auth(wedding.token),
    })

  const requestOffers = (
    wedding: WeddingFixture,
    slotId: string,
    entryIds: string[],
    key = randomUUID(),
    extra: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${wedding.weddingId}/slots/${slotId}/offer-requests`,
      headers: idem(wedding.token, key),
      payload: { entryIds, ...extra },
    })

  const answer = (
    vendor: VendorFixture,
    requestId: string,
    payload: Record<string, unknown>,
    key = randomUUID(),
  ) =>
    app.inject({
      method: 'POST',
      url: `/vendor/offer-requests/${requestId}/offers`,
      headers: idem(vendor.token, key),
      payload,
    })

  const customOffer = (number: number) => ({
    kind: 'offer',
    title: `Версия ${number}`,
    price: { amount: 11_000_000 + number, currency: 'RUB' },
    includes: [`Пункт ${number}`],
    message: `Сообщение ${number}`,
    validUntil: '2034-06-01',
  })


  async function fixture() {
    const wedding = await newWedding()
    const vendor = await newVendor()
    const slotId = await slotOf(wedding)
    const candidate = await addCandidate(wedding, vendor)
    expect(candidate.statusCode, candidate.body).toBe(200)
    const sent = await requestOffers(wedding, slotId, [candidate.json().id])
    expect(sent.statusCode, sent.body).toBe(201)
    const requestId = sent.json().results[0].requestId as string
    const response = await answer(vendor, requestId, customOffer(1))
    expect(response.statusCode, response.body).toBe(201)
    return { wedding, vendor, slotId, requestId, offerId: response.json().id as string }
  }
  const accept = (w: WeddingFixture, offerId: string, key = randomUUID(), token = w.token) => app.inject({
    method: 'POST', url: `/weddings/${w.weddingId}/offers/${offerId}/accept`, headers: idem(token, key),
  })

  it('фиксирует цену, название и состав; replay не создаёт второй брони; снимок переживает удаление пакета и offer', async () => {
    const f = await fixture()
    const response = await answer(f.vendor, f.requestId, {
      kind: 'offer', packageId: f.vendor.packageId, price: { amount: 1234567, currency: 'RUB' }, validUntil: '2034-06-01',
    })
    expect(response.statusCode, response.body).toBe(201)
    const offer = response.json()
    const key = randomUUID()
    const booked = await accept(f.wedding, offer.id, key)
    expect(booked.statusCode, booked.body).toBe(200)
    expect(booked.json().deal).toMatchObject({ packageName: f.vendor.packageName, packageIncludes: ['8 часов', 'Ретушь'], price: { amount: 1234567, currency: 'RUB' } })
    const replay = await accept(f.wedding, offer.id, key)
    expect(replay.json()).toEqual(booked.json())
    expect(replay.headers['idempotent-replay']).toBe('true')
    await app.db!.query('delete from vendor_packages where id = $1', [f.vendor.packageId])
    await app.db!.query('delete from offers where id = $1', [offer.id])
    const read = await app.inject({ method: 'GET', url: `/weddings/${f.wedding.weddingId}/slots`, headers: auth(f.wedding.token) })
    expect(read.json().find((s: { id: string }) => s.id === f.slotId).deal).toEqual(booked.json().deal)
    const cabinet = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(f.vendor.token) })
    expect(cabinet.body).toContain(f.vendor.packageName)
    expect(cabinet.body).toContain('Ретушь')
    const count = await app.db!.query('select count(*)::int as n from deals where slot_id = $1', [f.slotId])
    expect(count.rows[0].n).toBe(1)
  })

  it.each(['expired', 'stale_date', 'superseded', 'declined', 'closed', 'unavailable', 'busy'] as const)('отклоняет %s без частичной брони', async reason => {
    const f = await fixture()
    let offerId = f.offerId
    const code = { expired: 'offer_expired', stale_date: 'offer_stale_date', superseded: 'offer_superseded', declined: 'offer_declined', closed: 'request_closed', unavailable: 'vendor_unavailable', busy: 'date_taken' }[reason]
    if (reason === 'expired') await app.db!.query("update offers set valid_until = '2000-01-01' where id = $1", [offerId])
    if (reason === 'stale_date') await app.db!.query("update offer_requests set wedding_date = '2034-06-15' where id = $1", [f.requestId])
    if (reason === 'superseded') expect((await answer(f.vendor, f.requestId, customOffer(2))).statusCode).toBe(201)
    if (reason === 'declined') offerId = (await answer(f.vendor, f.requestId, { kind: 'decline', message: 'Не могу' })).json().id
    if (reason === 'closed') await app.db!.query("update offer_requests set status='closed', close_reason='removed', closed_at=now() where id=$1", [f.requestId])
    if (reason === 'unavailable') await app.db!.query('update vendors set published_at=null where id=$1', [f.vendor.vendorId])
    if (reason === 'busy') await app.db!.query("insert into vendor_busy_dates(vendor_id,date,source) values ($1,$2,'manual')", [f.vendor.vendorId, f.wedding.date])
    const result = await accept(f.wedding, offerId)
    expect(result.statusCode, result.body).toBe(409)
    expect(result.json().error.code).toBe(code)
    expect((await app.db!.query('select deal_id from slots where id=$1', [f.slotId])).rows[0].deal_id).toBeNull()
  })

  it('сегодня считается в поясе свадьбы, последний день включён', async () => {
    const f = await fixture()
    await app.db!.query("update weddings set tz='Pacific/Kiritimati' where id=$1", [f.wedding.weddingId])
    await app.db!.query("update offers set valid_until=(now() at time zone 'Pacific/Kiritimati')::date where id=$1", [f.offerId])
    const result = await accept(f.wedding, f.offerId)
    expect(result.statusCode, result.body).toBe(200)
  })

  it('помощник, координатор и чужая пара не принимают предложение', async () => {
    const f = await fixture()
    for (const role of ['helper', 'coordinator'] as const) {
      const u = await member(f.wedding, role)
      expect((await accept(f.wedding, f.offerId, randomUUID(), u.token)).statusCode).toBe(403)
    }
    const other = await newWedding()
    expect((await accept(other, f.offerId)).statusCode).toBe(404)
  })

  it('два партнёра одновременно выбирают разные предложения: одна бронь, второй 409; проигравшему без цены и имени', async () => {
    const f = await fixture()
    const partner = await member(f.wedding, 'couple')
    const second = await newVendor()
    const candidate = await addCandidate(f.wedding, second)
    const req = await requestOffers(f.wedding, f.slotId, [candidate.json().id])
    const secondRequest = req.json().results[0].requestId
    const secondOffer = await answer(second, secondRequest, customOffer(2))
    const results = await Promise.all([accept(f.wedding, f.offerId), accept(f.wedding, secondOffer.json().id, randomUUID(), partner.token)])
    expect(results.map(r => r.statusCode).sort()).toEqual([200, 409])
    const { rows } = await app.db!.query('select close_reason from offer_requests where slot_id=$1 order by close_reason', [f.slotId])
    expect(rows.map(r => r.close_reason)).toEqual(['booked', 'booked_other'])
    const notices = await app.db!.query("select body from notifications where user_id=any($1::uuid[]) and title='Пара выбрала другого исполнителя'", [[f.vendor.id, second.id]])
    expect(notices.rows).toHaveLength(1)
    expect(JSON.stringify(notices.rows)).not.toContain(f.vendor.name)
    expect(JSON.stringify(notices.rows)).not.toContain('1100000')
  })

  it('одновременные accept X и новая версия Y согласованы', async () => {
    const f = await fixture()
    const [accepted, replacement] = await Promise.all([accept(f.wedding, f.offerId), answer(f.vendor, f.requestId, customOffer(2))])
    expect([accepted.statusCode, replacement.statusCode]).toEqual(accepted.statusCode === 200 ? [200, 409] : [409, 201])
    if (accepted.statusCode === 409) expect(accepted.json().error.code).toBe('offer_superseded')
    const rows = await app.db!.query('select accepted_at, superseded_at from offers where id=$1', [f.offerId])
    expect(Boolean(rows.rows[0].accepted_at)).toBe(accepted.statusCode === 200)
    expect(Boolean(rows.rows[0].superseded_at)).toBe(replacement.statusCode === 201)
  })

  it.each(['catalog', 'external'] as const)('бронь %s закрывает запросы', async kind => {
    const f = await fixture()
    const response = await app.inject({ method: 'POST', url: `/weddings/${f.wedding.weddingId}/slots/${f.slotId}/${kind === 'catalog' ? 'book' : 'external'}`,
      headers: idem(f.wedding.token), payload: kind === 'catalog' ? { vendorId: f.vendor.vendorId, price: { amount: 100000, currency: 'RUB' } } : { vendorName: 'Свой', price: { amount: 100000, currency: 'RUB' } } })
    expect(response.statusCode, response.body).toBe(200)
    const rows = await app.db!.query('select status,close_reason from offer_requests where id=$1',[f.requestId])
    expect(rows.rows[0]).toEqual({ status:'closed', close_reason:kind === 'catalog' ? 'booked' : 'booked_other' })
  })

  it.each(['reschedule', 'first_date', 'cancel'] as const)('%s закрывает запросы и уведомляет', async action => {
    const f = await fixture()
    if (action === 'first_date') {
      await app.db!.query('update weddings set date=null where id=$1', [f.wedding.weddingId])
      await app.db!.query('update offer_requests set wedding_date=null where id=$1',[f.requestId])
    }
    const result = await app.inject({ method:'POST', url:`/weddings/${f.wedding.weddingId}/${action === 'cancel' ? 'cancel' : 'reschedule'}`, headers:idem(f.wedding.token), ...(action === 'cancel' ? {} : {payload:{date:'2034-06-15'}}) })
    expect(result.statusCode,result.body).toBe(200)
    const rows = await app.db!.query('select status,close_reason from offer_requests where id=$1',[f.requestId])
    expect(rows.rows[0]).toEqual({status:'closed',close_reason:action === 'cancel' ? 'wedding_cancelled' : 'date_changed'})
    const notices = await app.db!.query('select body from notifications where user_id=$1 order by created_at desc',[f.vendor.id])
    expect(notices.rows[0].body).toContain('запрос предложения закрыт')
  })

  it('выгрузка пары содержит свои запросы/ответы, подрядчика — только свои, helper — без приватных условий', async () => {
    const f = await fixture()
    const helper = await member(f.wedding, 'helper')
    for (const [user, isCouple, isVendor] of [[f.wedding,true,false],[f.vendor,false,true],[helper,false,false]] as const) {
      const res = await app.inject({method:'GET',url:'/users/me/export',headers:auth(user.token)})
      expect(res.statusCode,res.body).toBe(200)
      expect(res.json().offers).toHaveLength(isCouple ? 1 : 0)
      expect(res.json().offerRequests).toHaveLength(isCouple ? 1 : 0)
      expect(res.json().vendorOffers).toHaveLength(isVendor ? 1 : 0)
      if (!isCouple && !isVendor) expect(res.body).not.toContain('Сообщение 1')
    }
  })
})
