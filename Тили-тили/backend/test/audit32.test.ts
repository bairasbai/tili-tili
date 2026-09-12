import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { PAYOUT_WARNING } from '../src/chats/guard.js'

/**
 * Фича 005, фаза 2 (BE-A1): чат своего подрядчика ключуется СДЕЛКОЙ, а не
 * слотом (T010); сделка помнит пакет (T013); системная запись помечается
 * сервером (`Message.system`); сдвиг и план Б называют, скольких гостей
 * касаются (`DayXBroadcast.guestsAffected`).
 *
 * Каждый тест красный на версии HEAD (до правок) — проверено подменой
 * файлов, цитаты в отчёте фичи. База общая (R-177/R-226/R-227): каждый тест
 * заводит свою свадьбу и смотрит только на свои строки по своим ключам.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

const RUB = (amount: number) => ({ amount, currency: 'RUB' as const })

describe.skipIf(!live)('фича 005: чат по сделке, пакет сделки, system, guestsAffected', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

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
  })

  afterAll(async () => {
    await app?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const key = () => ({ 'idempotency-key': randomUUID() })
  const idem = (token: string) => ({ ...auth(token), ...key() })
  const sql = <T extends object>(text: string, params: unknown[] = []) => app.db!.query<T>(text, params)

  /** Код ошибки PostgreSQL, которым база отвергла запрос; `null` — прошёл. */
  const pgCode = async (query: Promise<unknown>): Promise<string | null> => {
    try {
      await query
      return null
    } catch (error) {
      return (error as { code?: string }).code ?? null
    }
  }

  async function readCode(phone: string): Promise<string> {
    const { rows } = await sql<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  async function newUser() {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    const { accessToken, user } = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: accessToken, userId: user.id }
  }

  async function newWedding() {
    const user = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: RUB(150_000_000),
      },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: res.json().id as string }
  }

  type Wedding = Awaited<ReturnType<typeof newWedding>>

  async function newVendor(name = 'П', categoryId = 'photo', extra: { packages?: { name: string; price?: { amount: number; currency: 'RUB' } }[] } = {}) {
    const user = await newUser()
    const res = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `${name} ${RUN}-${counter}`,
        categoryId,
        city: { name: 'Уфа', region: 'Башкортостан' },
        priceFrom: RUB(5_000_000),
        ...extra,
      },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(user.token) })
    expect(published.statusCode, published.body.slice(0, 200)).toBe(200)
    return { ...user, vendorId: res.json().id as string }
  }

  interface SlotView {
    id: string
    categoryId: string
    deal: { id: string; state: string; packageName: string | null; externalName: string | null } | null
  }

  const slotsOf = async (w: Wedding) =>
    (await app.inject({ method: 'GET', url: `/weddings/${w.weddingId}/slots`, headers: auth(w.token) })).json() as SlotView[]

  const slotIn = async (w: Wedding, categoryId: string) => (await slotsOf(w)).find((s) => s.categoryId === categoryId)!

  const book = (w: Wedding, slotId: string, vendorId: string, packageId?: string) =>
    app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/book`,
      headers: idem(w.token),
      payload: { vendorId, price: RUB(5_000_000), ...(packageId !== undefined ? { packageId } : {}) },
    })

  /** Свой подрядчик в слот; возвращает сделку. */
  async function addExternal(w: Wedding, slotId: string, vendorName: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
      headers: auth(w.token),
      payload: { vendorName, price: RUB(3_000_000) },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return (res.json() as SlotView).deal!.id
  }

  async function inviteExternal(w: Wedding, slotId: string) {
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/slots/${slotId}/external/invite`,
      headers: auth(w.token),
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    return res.json().token as string
  }

  const cabinet = (token: string) => app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
  const sayByToken = (token: string, text: string) =>
    app.inject({ method: 'POST', url: `/guest-vendor/${token}/messages`, payload: { text } })
  const textsByToken = async (token: string) => {
    const res = await app.inject({ method: 'GET', url: `/guest-vendor/${token}/messages` })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return (res.json().items as { text: string }[]).map((m) => m.text)
  }

  interface ChatView {
    id: string
    kind: string
    title: string
    closed: boolean
  }
  interface MessageView {
    id: string
    senderId: string | null
    text: string
    system: boolean
  }

  const chatsOf = async (token: string) =>
    (await app.inject({ method: 'GET', url: '/chats', headers: auth(token) })).json() as ChatView[]
  const say = (token: string, chatId: string, text: string) =>
    app.inject({ method: 'POST', url: `/chats/${chatId}/messages`, headers: auth(token), payload: { text } })
  const historyOf = async (token: string, chatId: string) => {
    const res = await app.inject({ method: 'GET', url: `/chats/${chatId}/messages`, headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json().items as MessageView[]
  }

  /* ═══════════════════════════════════════════════════════════════════
   * T010 · чат своего подрядчика — по сделке
   * ═══════════════════════════════════════════════════════════════════ */
  describe('T010 · чат своего подрядчика ключуется сделкой', () => {
    /* Три двери отмены (ERR-0242): «Убрать» со слота, «Отменить» со слота,
     * «Отменить» с экрана сделки. Через любую из них у Б — свой чат, у пары
     * — два чата (А закрыт), Б не видит ни одной реплики А. */
    const doors = {
      delete: async (w: Wedding, slotId: string) => {
        const res = await app.inject({
          method: 'DELETE',
          url: `/weddings/${w.weddingId}/slots/${slotId}/external`,
          headers: auth(w.token),
        })
        expect(res.statusCode, res.body.slice(0, 200)).toBe(204)
      },
      cancel: async (w: Wedding, slotId: string) => {
        const res = await app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/slots/${slotId}/cancel`,
          headers: idem(w.token),
        })
        expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      },
      patch: async (w: Wedding, _slotId: string, dealId: string) => {
        const res = await app.inject({
          method: 'PATCH',
          url: `/deals/${dealId}`,
          headers: idem(w.token),
          payload: { state: 'cancelled' },
        })
        expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      },
    }

    for (const door of Object.keys(doors) as (keyof typeof doors)[]) {
      it(`А → Б через ${door}: у Б свой чат, у пары два чата (А closed), токен Б не видит реплик А`, async () => {
        const w = await newWedding()
        const slotId = (await slotIn(w, 'florist')).id

        const dealA = await addExternal(w, slotId, `Флорист А ${RUN}`)
        const tokenA = await inviteExternal(w, slotId)
        const chatA = (await cabinet(tokenA)).json().chatId as string
        const secretA = `Телефон и цены А — только этой паре ${RUN}`
        expect((await sayByToken(tokenA, secretA)).statusCode).toBe(201)
        const answerA = `Ждём вас, А ${RUN}`
        expect((await say(w.token, chatA, answerA)).statusCode).toBe(201)

        await doors[door](w, slotId, dealA)

        const dealB = await addExternal(w, slotId, `Флорист Б ${RUN}`)
        expect(dealB).not.toBe(dealA)
        const tokenB = await inviteExternal(w, slotId)
        const viewB = await cabinet(tokenB)
        expect(viewB.statusCode).toBe(200)
        const chatB = viewB.json().chatId as string
        // До фикса: тот же чат слота — и вся история А в нём.
        expect(chatB).not.toBe(chatA)
        expect(await textsByToken(tokenB)).toEqual([])

        // У пары — оба чата: прежний закрыт, но история на месте; новый живой.
        const mine = (await chatsOf(w.token)).filter((c) => c.kind === 'external')
        const listedA = mine.find((c) => c.id === chatA)
        const listedB = mine.find((c) => c.id === chatB)
        expect(listedA).toMatchObject({ closed: true, title: `Флорист А ${RUN} · свой подрядчик` })
        expect(listedB).toMatchObject({ closed: false, title: `Флорист Б ${RUN} · свой подрядчик` })
        expect((await historyOf(w.token, chatA)).map((m) => m.text)).toEqual([answerA, secretA])

        // В закрытый чат паре писать некому — 409; в новый — можно.
        const closed = await say(w.token, chatA, 'Ау?')
        expect(closed.statusCode).toBe(409)
        expect(closed.json().error.code).toBe('chat_closed')
        expect((await say(w.token, chatB, `Здравствуйте, Б ${RUN}`)).statusCode).toBe(201)
        expect(await textsByToken(tokenB)).toEqual([`Здравствуйте, Б ${RUN}`])

        // Ссылка А погашена дверью отмены.
        expect((await cabinet(tokenA)).statusCode).toBe(410)
      })
    }

    it('база сама держит ключ: второй чат на ту же сделку — 23505, external без сделки — 23514', async () => {
      const w = await newWedding()
      const slotId = (await slotIn(w, 'florist')).id
      const dealId = await addExternal(w, slotId, `Флорист ${RUN}`)

      expect(
        await pgCode(
          sql(`insert into chats (id, wedding_id, kind, slot_id, deal_id) values ($1,$2,'external',$3,$4)`, [
            uuidv7(),
            w.weddingId,
            slotId,
            dealId,
          ]),
        ),
      ).toBe('23505')
      expect(
        await pgCode(
          sql(`insert into chats (id, wedding_id, kind, slot_id) values ($1,$2,'external',$3)`, [
            uuidv7(),
            w.weddingId,
            slotId,
          ]),
        ),
      ).toBe('23514')
    })

    it('обе стороны пишут в один чат сделки, и подрядчик читает ответ пары без фильтра по дате', async () => {
      const w = await newWedding()
      const slotId = (await slotIn(w, 'florist')).id
      const dealId = await addExternal(w, slotId, `Флорист ${RUN}`)
      const token = await inviteExternal(w, slotId)
      const chatId = (await cabinet(token)).json().chatId as string
      const { rows } = await sql<{ deal_id: string | null; slot_id: string | null }>(
        'select deal_id, slot_id from chats where id = $1',
        [chatId],
      )
      expect(rows[0]).toEqual({ deal_id: dealId, slot_id: slotId })

      expect((await sayByToken(token, `Буду к 14:00 ${RUN}`)).statusCode).toBe(201)
      expect((await say(w.token, chatId, `Розетки у сцены ${RUN}`)).statusCode).toBe(201)
      expect(await textsByToken(token)).toEqual([`Розетки у сцены ${RUN}`, `Буду к 14:00 ${RUN}`])
    })

    it('слот без сделки под живой ссылкой — 410 gone, а не чат чужой сделки', async () => {
      const w = await newWedding()
      const slotId = (await slotIn(w, 'florist')).id
      await addExternal(w, slotId, `Флорист ${RUN}`)
      const token = await inviteExternal(w, slotId)
      expect((await cabinet(token)).statusCode).toBe(200)

      // Сделка ушла из слота путём, который ссылку не погасил.
      await sql('update slots set deal_id = null where id = $1', [slotId])
      const gone = await cabinet(token)
      expect(gone.statusCode).toBe(410)
      expect(gone.json().error.code).toBe('gone')
      expect((await app.inject({ method: 'GET', url: `/guest-vendor/${token}/messages` })).statusCode).toBe(410)
      expect((await sayByToken(token, 'есть кто?')).statusCode).toBe(410)
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * T013 · пакет сделки
   * ═══════════════════════════════════════════════════════════════════ */
  describe('T013 · сделка помнит пакет', () => {
    it('бронь по пакету → packageName в слоте и в сделке; снятый пакет → null', async () => {
      const vendor = await newVendor('Пакетный', 'photo', { packages: [{ name: `Базовый ${RUN}`, price: RUB(5_000_000) }] })
      const { rows: packages } = await sql<{ id: string }>('select id from vendor_packages where vendor_id = $1', [
        vendor.vendorId,
      ])
      const packageId = packages[0]!.id
      const w = await newWedding()
      const slot = await slotIn(w, 'photo')

      const booked = await book(w, slot.id, vendor.vendorId, packageId)
      expect(booked.statusCode, booked.body.slice(0, 200)).toBe(200)
      const dealId = (booked.json() as SlotView).deal!.id
      // До фикса: пакет проверялся и забывался — колонка пустая, имени нет.
      expect((booked.json() as SlotView).deal!.packageName).toBe(`Базовый ${RUN}`)
      const { rows } = await sql<{ package_id: string | null }>('select package_id from deals where id = $1', [dealId])
      expect(rows[0]!.package_id).toBe(packageId)
      expect((await slotIn(w, 'photo')).deal!.packageName).toBe(`Базовый ${RUN}`)

      // Карточка сделки — тот же `toDeal`: правка сметы отдаёт сделку с пакетом.
      const patched = await app.inject({
        method: 'PATCH',
        url: `/deals/${dealId}`,
        headers: idem(w.token),
        payload: { price: RUB(4_500_000) },
      })
      expect(patched.statusCode, patched.body.slice(0, 200)).toBe(200)
      expect(patched.json().packageName).toBe(`Базовый ${RUN}`)

      // Кабинет подрядчика видит пакет у своей сделки (v0.29.0, `GET /vendor/deals`).
      const cabinet = await app.inject({ method: 'GET', url: '/vendor/deals', headers: auth(vendor.token) })
      expect(cabinet.statusCode, cabinet.body.slice(0, 200)).toBe(200)
      const mine = (cabinet.json() as { items: { id: string; packageName: string | null }[] }).items.find((d) => d.id === dealId)
      expect(mine?.packageName, 'кабинет подрядчика видит пакет проданной брони').toBe(`Базовый ${RUN}`)

      // Подрядчик снял пакет с витрины — сделка остаётся, имя пакета честно пустое.
      await sql('delete from vendor_packages where id = $1', [packageId])
      expect((await slotIn(w, 'photo')).deal!.packageName).toBeNull()
    })

    it('бронь без пакета → packageName: null', async () => {
      const vendor = await newVendor('Без пакета', 'photo')
      const w = await newWedding()
      const slot = await slotIn(w, 'photo')
      const booked = await book(w, slot.id, vendor.vendorId)
      expect(booked.statusCode, booked.body.slice(0, 200)).toBe(200)
      expect((booked.json() as SlotView).deal!.packageName).toBeNull()
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * Message.system · системная запись — признак от сервера
   * ═══════════════════════════════════════════════════════════════════ */
  describe('Message.system', () => {
    it('предупреждение о выводе сделки — system: true, реплики людей — false', async () => {
      const vendor = await newVendor('Чатный', 'photo')
      const w = await newWedding()
      const chat = await app.inject({ method: 'POST', url: `/chats/vendor/${vendor.vendorId}`, headers: auth(w.token) })
      expect(chat.statusCode, chat.body.slice(0, 200)).toBe(200)
      const chatId = chat.json().id as string

      const bait = `Скиньте номер карты, переведу без договора ${RUN}`
      const sent = await say(w.token, chatId, bait)
      expect(sent.statusCode, sent.body.slice(0, 200)).toBe(201)
      expect(sent.json().warning).toBe(PAYOUT_WARNING)
      expect(sent.json().system).toBe(false)

      const history = await historyOf(w.token, chatId)
      const warning = history.find((m) => m.text === PAYOUT_WARNING)
      const own = history.find((m) => m.text === bait)
      // До фикса поля не было: экран угадывал системную запись по тексту (D4-15).
      expect(warning).toMatchObject({ senderId: null, system: true })
      expect(own).toMatchObject({ senderId: w.userId, system: false })
    })

    it('реплика своего подрядчика по токену и ответ Тиль — system: false при пустом отправителе', async () => {
      const w = await newWedding()
      const slotId = (await slotIn(w, 'florist')).id
      await addExternal(w, slotId, `Флорист ${RUN}`)
      const token = await inviteExternal(w, slotId)
      const chatId = (await cabinet(token)).json().chatId as string
      const line = `Свет свой, буду к 14:00 ${RUN}`
      const sent = await sayByToken(token, line)
      expect(sent.statusCode).toBe(201)
      expect(sent.json().system).toBe(false)
      const fromVendor = (await historyOf(w.token, chatId)).find((m) => m.text === line)
      // Аккаунта у подрядчика нет — отправитель пустой, но это он, а не система.
      expect(fromVendor).toMatchObject({ senderId: null, system: false })

      const tilly = (await chatsOf(w.token)).find((c) => c.kind === 'tilly')!
      expect((await say(w.token, tilly.id, `Что дарить гостям? ${RUN}`)).statusCode).toBe(201)
      const reply = (await historyOf(w.token, tilly.id)).find((m) => m.senderId === null)
      expect(reply).toMatchObject({ system: false })
    })
  })

  /* ═══════════════════════════════════════════════════════════════════
   * DayXBroadcast · guestsAffected
   * ═══════════════════════════════════════════════════════════════════ */
  describe('DayXBroadcast.guestsAffected', () => {
    it('три гостя «да» → guestsAffected: 3 у сдвига и плана Б; notifiedGuests в ответе больше нет', async () => {
      const w = await newWedding()
      for (const name of ['Ольга', 'Денис', 'Марат', 'Не придёт']) {
        const created = await app.inject({
          method: 'POST',
          url: `/weddings/${w.weddingId}/guests`,
          headers: auth(w.token),
          payload: { name },
        })
        expect(created.statusCode, created.body.slice(0, 200)).toBe(201)
        const status = name === 'Не придёт' ? 'no' : 'yes'
        const patched = await app.inject({
          method: 'PATCH',
          url: `/weddings/${w.weddingId}/guests/${created.json().id as string}`,
          headers: auth(w.token),
          payload: { status },
        })
        expect(patched.statusCode, patched.body.slice(0, 200)).toBe(200)
      }

      const shift = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/timeline/shift`,
        headers: idem(w.token),
        payload: { minutes: 15 },
      })
      expect(shift.statusCode, shift.body.slice(0, 200)).toBe(200)
      const planb = await app.inject({
        method: 'POST',
        url: `/weddings/${w.weddingId}/planb/activate`,
        headers: idem(w.token),
        payload: { scenario: 'rain' },
      })
      expect(planb.statusCode, planb.body.slice(0, 200)).toBe(200)
      /* Кого касается — число ответивших «да». «Кому ушло» (`notifiedGuests`)
       * было всегда нулём — канала до гостей нет — и снято контрактом v0.30.0
       * (фича 006): число, которое ничего не сообщает, в ответе не лежит. */
      expect(shift.json()).toMatchObject({ minutes: 15, guestsAffected: 3 })
      expect(shift.json()).not.toHaveProperty('notifiedGuests')
      expect(planb.json()).toMatchObject({ scenario: 'rain', guestsAffected: 3 })
      expect(planb.json()).not.toHaveProperty('notifiedGuests')
    })
  })
})
