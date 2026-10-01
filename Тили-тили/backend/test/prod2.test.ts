import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Волна 2: пустые поля, которые притворялись данными.
 *
 * Мягкая бронь, отзывы в карточке, чат своего подрядчика и дата рассылки
 * отдавались пустыми с тех этапов, когда для них ещё не было источника.
 * Источник давно есть — проверяем, что поля перестали врать.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('прод: мягкая бронь, отзывы и свой подрядчик', () => {
  let app: FastifyInstance
  let counter = 0
  /* Префикс телефонов прогона перебирается до свободного (R-259): в общей
   * дев-базе сотня тысяч номеров `+79RRRRRRNNN` от прежних
   * прогонов, и случайный RUN иногда совпадает с занятым — тогда на
   * свежем номере прилетает 409 «wedding_exists». */
  let RUN = String(randomInt(100_000, 1_000_000))
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
    for (let i = 0; i < 20; i++) {
      const { rows } = await app.db!.query('select 1 from users where phone like $1 limit 1', [`+79${RUN}%`])
      if (rows.length === 0) break
      RUN = String(randomInt(100_000, 1_000_000))
    }
  })

  afterAll(async () => {
    await app?.close()
  })

  const coupleTokens = new Map<string, string>()
  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
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
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: rows[0]!.id }
  }

  async function newWedding(date: string) {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(w.statusCode).toBe(201)
    const weddingId = w.json().id as string
    coupleTokens.set(weddingId, user.token)
    return { ...user, weddingId }
  }

  /** Опубликованная анкета подрядчика со своим владельцем. */
  async function newVendor(name: string) {
    const owner = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name, categoryId: 'photo', city: { name: 'Казань', region: 'Татарстан' } },
    })
    expect(created.statusCode).toBe(200)
    const vendorId = created.json().id as string
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    return { ...owner, vendorId }
  }

  /** Слот пары под нужную категорию. */
  async function slotOf(weddingId: string) {
    const { rows } = await app.db!.query<{ id: string }>(
      "select id from slots where wedding_id = $1 and category_id = 'photo' limit 1",
      [weddingId],
    )
    return rows[0]!.id
  }

  /** Сделка в переговорах: срок мягкой брони идёт, договорённости ещё нет. */
  async function negotiating(weddingId: string, vendorId: string) {
    const slotId = await slotOf(weddingId)
    const dealId = crypto.randomUUID()
    await app.db!.query(
      `insert into deals (id, wedding_id, slot_id, vendor_id, state, price, currency, negotiating_until)
       values ($1,$2,$3,$4,'negotiating',5000000,'RUB', now() + interval '48 hours')`,
      [dealId, weddingId, slotId, vendorId],
    )
    await app.db!.query('update slots set deal_id = $2 where id = $1', [slotId, dealId])
    return dealId
  }

  /** Сделка, доведённая до конца: только по такой можно оставить отзыв. */
  async function done(weddingId: string, vendorId: string) {
    const slotId = await slotOf(weddingId)
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slotId}/book`,
      headers: { ...auth(coupleTokens.get(weddingId)!), 'idempotency-key': crypto.randomUUID() },
      payload: { vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    expect(res.statusCode).toBe(200)
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slotId])
    await app.db!.query("update deals set state = 'done', done_at = now() where id = $1", [rows[0]!.id])
    return rows[0]!.id
  }

  /* ── мягкая бронь ─────────────────────────────────────────────────── */
  it('дата в переговорах видна обеим сторонам как «под вопросом»', async () => {
    const vendor = await newVendor(`Фотограф ${RUN}A`)
    const couple = await newWedding('2027-07-03')
    await negotiating(couple.weddingId, vendor.vendorId)

    /* Другая пара смотрит календарь той же анкеты. Пустой список означал бы
     * «свободно»: она выбрала бы дату, которая вот-вот уйдёт (План §18.3). */
    const other = await newWedding('2027-08-01')
    const cal = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}/availability`,
      headers: auth(other.token),
    })
    expect(cal.json().holdDates).toContain('2027-07-03')
    expect(cal.json().busyDates).not.toContain('2027-07-03')

    // И сам подрядчик видит, что дату ждут, а не что она свободна.
    const own = await app.inject({ method: 'GET', url: '/vendor/calendar', headers: auth(vendor.token) })
    expect((own.json() as { date: string; status: string }[]).find((d) => d.date === '2027-07-03')?.status).toBe('hold')
  })

  /* ── отзывы в карточке ────────────────────────────────────────────── */
  it('карточка подрядчика отдаёт отзывы, а не пустой список', async () => {
    const vendor = await newVendor(`Фотограф ${RUN}B`)
    const couple = await newWedding('2027-07-04')
    await done(couple.weddingId, vendor.vendorId)

    const review = await app.inject({
      method: 'POST',
      url: `/catalog/vendors/${vendor.vendorId}/reviews`,
      headers: auth(couple.token),
      payload: { rating: 5, text: 'Снимал так, что плакала даже тёща' },
    })
    expect(review.statusCode).toBe(201)

    const card = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(couple.token),
    })
    /* Контракт объявляет массив отзывов в карточке, а реализация всегда
     * отдавала пустой: пара видела «отзывов нет» у подрядчика с отзывами. */
    const reviews = card.json().reviews as { text: string; source: string }[]
    expect(reviews.map((r) => r.text)).toContain('Снимал так, что плакала даже тёща')
    expect(reviews[0]!.source).toBe('couple')
  })

  /* ── свой подрядчик ───────────────────────────────────────────────── */
  async function externalSetup(marker: string) {
    const couple = await newWedding('2027-07-05')
    const { rows: slots } = await app.db!.query<{ id: string }>(
      "select id from slots where wedding_id = $1 and category_id = 'photo' limit 1",
      [couple.weddingId],
    )
    const slotId = slots[0]!.id
    const added = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/slots/${slotId}/external`,
      headers: auth(couple.token),
      payload: { vendorName: `Дядя Ваня ${marker}`, price: { amount: 3_000_000, currency: 'RUB' } },
    })
    expect(added.statusCode).toBe(200)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/slots/${slotId}/external/invite`,
      headers: auth(couple.token),
    })
    expect(invite.statusCode).toBe(201)
    return { couple, slotId, dealId: added.json().deal.id as string, token: invite.json().token as string }
  }

  it('кабинет своего подрядчика отдаёт чат и тайминг, а не пустое поле', async () => {
    const { couple, token, dealId } = await externalSetup('T')
    const snapshot = await app.inject({ method: 'GET', url: `/weddings/${couple.weddingId}/timeline`, headers: auth(couple.token) })
    const saved = await app.inject({
      method: 'PUT',
      url: `/weddings/${couple.weddingId}/timeline`,
      headers: { ...auth(couple.token), 'if-match': snapshot.headers.etag! },
      payload: [
        { name: 'Сбор гостей', startsAt: '2027-07-05T12:00:00.000Z', who: 'Дядя Ваня', responsible: { kind: 'deal', id: dealId } },
        { name: 'Служебный неназначенный блок', forGuests: false },
      ],
    })
    expect(saved.statusCode, saved.body).toBe(200)

    const view = await app.inject({ method: 'GET', url: `/guest-vendor/${token}` })
    expect(view.statusCode).toBe(200)
    /* §11: «видит дату, тайминг и чат с парой». Чат отдавался пустым
     * с этапа 6 — то есть подрядчик не мог написать паре вообще. */
    expect(view.json().chatId).toBeTruthy()
    expect((view.json().timeline as { name: string }[]).map((e) => e.name)).toContain('Сбор гостей')
    expect(view.json().timeline).toHaveLength(1)
    expect(view.json().timeline[0].who).toBeNull()
    expect(view.body).not.toContain('Служебный неназначенный блок')
  })

  it('свой подрядчик и пара переписываются в одном чате', async () => {
    const { couple, token } = await externalSetup('P')

    const sent = await app.inject({
      method: 'POST',
      url: `/guest-vendor/${token}/messages`,
      payload: { text: 'Буду к 14:00, свет свой' },
    })
    expect(sent.statusCode).toBe(201)
    // Аккаунта у него нет — отправитель пустой, и в этом чате это он.
    expect(sent.json().senderId).toBeNull()

    const chats = (await app.inject({ method: 'GET', url: '/chats', headers: auth(couple.token) })).json() as {
      id: string
      kind: string
      title: string
      lastMessage: string
    }[]
    const chat = chats.find((c) => c.kind === 'external')
    expect(chat?.title).toContain('Дядя Ваня')
    expect(chat?.lastMessage).toBe('Буду к 14:00, свет свой')

    const answer = await app.inject({
      method: 'POST',
      url: `/chats/${chat!.id}/messages`,
      headers: auth(couple.token),
      payload: { text: 'Ждём, розетки у сцены' },
    })
    expect(answer.statusCode).toBe(201)

    const history = await app.inject({ method: 'GET', url: `/guest-vendor/${token}/messages` })
    expect((history.json().items as { text: string }[]).map((m) => m.text)).toEqual([
      'Ждём, розетки у сцены',
      'Буду к 14:00, свет свой',
    ])
  })

  it('чужой и отозванный токен не открывают переписку', async () => {
    const { couple, slotId, token } = await externalSetup('R')
    expect((await app.inject({ method: 'GET', url: '/guest-vendor/не-тот-токен/messages' })).statusCode).toBe(410)

    await app.inject({
      method: 'DELETE',
      url: `/weddings/${couple.weddingId}/slots/${slotId}/external`,
      headers: auth(couple.token),
    })
    /* Подрядчика убрали — ссылка мертва. Иначе человек, которого сняли
     * со свадьбы, продолжает читать переписку и писать в неё. */
    expect((await app.inject({ method: 'GET', url: `/guest-vendor/${token}/messages` })).statusCode).toBe(410)
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/guest-vendor/${token}/messages`,
          payload: { text: 'а я всё ещё тут' },
        })
      ).statusCode,
    ).toBe(410)
  })

  /* ── рассылка и опрос меню ────────────────────────────────────────── */
  it('рассылка не только считает получателей, но и оповещает команду', async () => {
    const couple = await newWedding('2027-07-06')
    const helper = await newUser()
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${link.json().code}/accept`,
      headers: auth(helper.token),
    })

    await app.inject({
      method: 'PUT',
      url: `/weddings/${couple.weddingId}/menu-poll`,
      headers: auth(couple.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/menu-poll/remind`,
      headers: { ...auth(couple.token), 'idempotency-key': `r-${RUN}-1` },
    })
    expect(res.statusCode).toBe(202)
    // Раньше в ответе было только «сколько человек касается». Отправки
    // не было ни в каком виде — рассылка молча записывалась в таблицу.
    expect(res.json().notified).toBeGreaterThan(0)

    const notes = await app.inject({ method: 'GET', url: '/notifications', headers: auth(helper.token) })
    expect((notes.json() as { title: string }[]).some((n) => n.title === 'Рассылка гостям')).toBe(true)
  })

  /* ── цена сделки ──────────────────────────────────────────────────── */
  it('цену сделки правят до аванса, а после — уже нет', async () => {
    const vendor = await newVendor(`Фотограф ${RUN}C`)
    const couple = await newWedding('2027-07-10')
    const slotId = await slotOf(couple.weddingId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(couple.token), 'idempotency-key': `bk-${RUN}-c` },
      payload: { vendorId: vendor.vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slotId])
    const dealId = rows[0]!.id

    /* Подрядчик прислал новую смету. До этой правки поменять сумму можно
     * было только отменив сделку — а отмена освобождает дату, и её успевает
     * занять другая пара. */
    const fixed = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(couple.token), 'idempotency-key': `pr-${RUN}-c1` },
      payload: { price: { amount: 6_200_000, currency: 'RUB' } },
    })
    expect(fixed.statusCode).toBe(200)
    expect(fixed.json().price.amount).toBe(6_200_000)
    // Состояние правка цены не трогает: бронь осталась бронью.
    expect(fixed.json().state).toBe('booked')

    const { rows: journal } = await app.db!.query<{ kind: string; note: string }>(
      "select kind, note from deal_events where deal_id = $1 and kind = 'price'",
      [dealId],
    )
    expect(journal).toHaveLength(1)
    // Intl ставит неразрывный пробел — сравниваем по цифрам, а не по виду.
    expect(journal[0]!.note.replace(/\s/g, ' ')).toBe('Сумма изменена: 50 000 ₽ → 62 000 ₽')

    // Дата подрядчика на месте — ради этого правка и заводилась.
    const { rows: busy } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from vendor_busy_dates where deal_id = $1',
      [dealId],
    )
    expect(busy[0]!.n).toBe('1')

    await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(couple.token), 'idempotency-key': `pr-${RUN}-c2` },
      payload: { state: 'paid_deposit' },
    })
    const late = await app.inject({
      method: 'PATCH',
      url: `/deals/${dealId}`,
      headers: { ...auth(couple.token), 'idempotency-key': `pr-${RUN}-c3` },
      payload: { price: { amount: 100, currency: 'RUB' } },
    })
    /* Аванс уже внесён: молчаливая правка сметы задним числом развела бы
     * платёж и договор. */
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('price_locked')
  })

  it('правка сделки без state и price — отказ, а не молчаливое ничего', async () => {
    const vendor = await newVendor(`Фотограф ${RUN}D`)
    const couple = await newWedding('2027-07-11')
    const slotId = await slotOf(couple.weddingId)
    await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/slots/${slotId}/book`,
      headers: { ...auth(couple.token), 'idempotency-key': `bk-${RUN}-d` },
      payload: { vendorId: vendor.vendorId, price: { amount: 5_000_000, currency: 'RUB' } },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from deals where slot_id = $1', [slotId])
    const empty = await app.inject({
      method: 'PATCH',
      url: `/deals/${rows[0]!.id}`,
      headers: { ...auth(couple.token), 'idempotency-key': `pr-${RUN}-d` },
      payload: { note: 'просто заметка' },
    })
    // Приложение отвечает на непрошедшее проверку тело 422 (единый формат).
    expect(empty.statusCode).toBe(422)
  })

  /* ── избранные истории ────────────────────────────────────────────── */
  it('отметки «Вдохновения» переживают устройство', async () => {
    const user = await newUser()
    expect((await app.inject({ method: 'GET', url: '/inspiration/likes', headers: auth(user.token) })).json()).toEqual({
      storyIds: [],
    })

    for (const story of ['w1', 'w4']) {
      const res = await app.inject({
        method: 'PUT',
        url: `/inspiration/likes/${story}`,
        headers: auth(user.token),
      })
      expect(res.statusCode).toBe(204)
    }
    // Повторное нажатие — то же состояние, а не ошибка и не второй лайк.
    await app.inject({ method: 'PUT', url: '/inspiration/likes/w1', headers: auth(user.token) })
    const mine = await app.inject({ method: 'GET', url: '/inspiration/likes', headers: auth(user.token) })
    expect((mine.json().storyIds as string[]).sort()).toEqual(['w1', 'w4'])

    await app.inject({ method: 'DELETE', url: '/inspiration/likes/w1', headers: auth(user.token) })
    // Снятие того, чего нет, — тоже «нет».
    expect(
      (await app.inject({ method: 'DELETE', url: '/inspiration/likes/w9', headers: auth(user.token) })).statusCode,
    ).toBe(204)
    expect(
      (await app.inject({ method: 'GET', url: '/inspiration/likes', headers: auth(user.token) })).json().storyIds,
    ).toEqual(['w4'])

    // Чужие отметки — чужие: список личный (§8.4).
    const other = await newUser()
    expect(
      (await app.inject({ method: 'GET', url: '/inspiration/likes', headers: auth(other.token) })).json().storyIds,
    ).toEqual([])
  })

  /* ── чек-лист плана Б ─────────────────────────────────────────────── */
  it('отметки плана Б переживают устройство и видны второму партнёру', async () => {
    const couple = await newWedding('2027-07-08')
    const coordinator = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'coordinator' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(coordinator.token),
    })

    const first = await app.inject({
      method: 'GET',
      url: `/weddings/${couple.weddingId}/planb`,
      headers: auth(couple.token),
    })
    expect(first.statusCode).toBe(200)
    const list = first.json().checklist as { id: string; title: string; done: boolean }[]
    // §13.1 называет чек-лист персистентным: он заводится на сервере,
    // а не в браузере одного из двоих.
    expect(list).toHaveLength(6)
    expect(list.every((c) => !c.done)).toBe(true)

    await app.inject({
      method: 'PATCH',
      url: `/weddings/${couple.weddingId}/tasks/${list[0]!.id}`,
      headers: auth(couple.token),
      payload: { done: true },
    })
    const asCoordinator = await app.inject({
      method: 'GET',
      url: `/weddings/${couple.weddingId}/planb`,
      headers: auth(coordinator.token),
    })
    expect((asCoordinator.json().checklist as { done: boolean }[])[0]!.done).toBe(true)
    // Повторное открытие не заводит второй комплект пунктов.
    expect((asCoordinator.json().checklist as unknown[]).length).toBe(6)

    /* Пункты «накануне» не должны сыпаться в чек-лист по месяцам:
     * это разные экраны, и «Powerbank и аптечка» среди дел за полгода
     * читается как ошибка. */
    const tasks = await app.inject({
      method: 'GET',
      url: `/weddings/${couple.weddingId}/tasks`,
      headers: auth(couple.token),
    })
    expect((tasks.json() as { title: string }[]).some((t) => t.title.startsWith('Powerbank'))).toBe(false)
  })

  it('планом Б командует координатор, а помощник его не объявляет', async () => {
    const couple = await newWedding('2027-07-09')
    const helper = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(helper.token),
    })

    // Сверять чек-лист накануне — работа всей команды.
    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${couple.weddingId}/planb`, headers: auth(helper.token) }))
        .statusCode,
    ).toBe(200)
    /* А объявлять запасной сценарий — нет: активация рассылает уведомление
     * всем и переписывает планы на день (Бизнес-логика §2). */
    const declared = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/planb/activate`,
      headers: { ...auth(helper.token), 'idempotency-key': `pb-${RUN}-h` },
      payload: { scenario: 'rain' },
    })
    expect(declared.statusCode).toBe(403)
  })

  it('правка блюд не стирает дату рассылки опроса', async () => {
    const couple = await newWedding('2027-07-07')
    await app.inject({
      method: 'PUT',
      url: `/weddings/${couple.weddingId}/menu-poll`,
      headers: auth(couple.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    const sent = await app.inject({
      method: 'POST',
      url: `/weddings/${couple.weddingId}/menu-poll/remind`,
      headers: { ...auth(couple.token), 'idempotency-key': `r-${RUN}-2` },
    })
    expect(sent.statusCode).toBe(202)
    const edited = await app.inject({
      method: 'PUT',
      url: `/weddings/${couple.weddingId}/menu-poll`,
      headers: auth(couple.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }, { name: 'Веган' }] },
    })
    /* Пустая дата читается как «ещё не рассылали» — и пара отправляет
     * напоминание второй раз, каждый раз после правки меню. */
    expect(edited.json().sentAt).not.toBeNull()
  })
})
