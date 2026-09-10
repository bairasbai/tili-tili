import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'

/**
 * Очередь заявок на верификацию (фича tasks/фичи/002-верификация).
 *
 * Галочка «Проверен» ставилась только из очереди модерации анкет: после того
 * как анкету одобрили, верифицировать подрядчика было негде, а поданные
 * документы лежали в базе, которую никто не открывал (RELEASE-BLOCKERS №25).
 * Подрядчик при этом не видел ни «на проверке», ни «отклонено» — только есть
 * галочка или нет.
 *
 * Здесь проверяется вся цепочка: заявка → очередь → карточка с записью в
 * журнал → решение → галочка и уведомление → статус в кабинете. И отдельно —
 * что снятие анкеты с публикации заявку больше не закрывает: документы и
 * публикация разные решения (FR-009).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

interface QueueItem {
  id: string
  vendorId: string
  vendorName: string
  kind: string
  hasFile: boolean
  createdAt: string
}

describe.skipIf(!live)('верификация: очередь, решения и статус у подрядчика', () => {
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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const nextPhone = () => `+79${RUN}${String(counter++).padStart(3, '0')}`

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
    const body = v.json() as { accessToken: string; user: { id: string } }
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(body.accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    return { token: body.accessToken, userId: body.user.id, phone }
  }

  /** Права сотрудника ставятся руками в базе при найме — пути для этого нет и не будет. */
  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

  /** Подрядчик с опубликованной анкетой — тем же путём, каким он приходит сам. */
  async function newVendor(name: string) {
    const user = await newUser()
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(user.token),
      payload: {
        name: `${name} ${RUN}-${counter}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        about: 'Снимаю свадьбы',
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body.slice(0, 200)).toBe(200)
    const published = await app.inject({
      method: 'POST',
      url: '/vendor/profile/publish',
      headers: auth(user.token),
    })
    expect(published.statusCode, published.body.slice(0, 200)).toBe(200)
    return { ...user, vendorId: created.json().id as string, vendorName: created.json().name as string }
  }

  /**
   * Заявка подаётся тем же путём, каким её подаёт подрядчик. Идентификатор
   * ответом не отдаётся (документы наружу не выходят) — берём его из базы.
   */
  async function submit(
    vendor: { token: string; vendorId: string },
    payload: { kind?: string; fileUrl?: string | null; inn?: string } = {},
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/vendor/verification',
      headers: auth(vendor.token),
      payload: {
        kind: payload.kind ?? 'ip',
        fileUrl: payload.fileUrl ?? `https://cdn.tili-tili.ru/doc-${RUN}-${counter++}.pdf`,
        ...(payload.inn ? { inn: payload.inn } : {}),
      },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    const { rows } = await app.db!.query<{ id: string }>(
      'select id from vendor_verifications where vendor_id = $1 order by created_at desc, id desc limit 1',
      [vendor.vendorId],
    )
    return rows[0]!.id
  }

  const requestRow = async (id: string) =>
    (
      await app.db!.query<{ status: string; checked_at: Date | null; file_url: string | null; inn: string | null }>(
        'select status, checked_at, file_url, inn from vendor_verifications where id = $1',
        [id],
      )
    ).rows[0]!

  const vendorRow = async (vendorId: string) =>
    (
      await app.db!.query<{
        published_at: Date | null
        moderated_at: Date | null
        verified_at: Date | null
        blocked_at: Date | null
      }>('select published_at, moderated_at, verified_at, blocked_at from vendors where id = $1', [vendorId])
    ).rows[0]!

  /** Уведомления одного человека — свежие сверху. */
  const notesOf = async (userId: string) =>
    (
      await app.db!.query<{ kind: string; title: string; body: string; link: string | null }>(
        'select kind, title, body, link from notifications where user_id = $1 order by created_at desc',
        [userId],
      )
    ).rows

  /** Записи журнала по заявке — журнал только дописывается, порядок хронологический. */
  const logOf = async (entityId: string) =>
    (
      await app.db!.query<{ actor_id: string; action: string; entity: string; diff: Record<string, unknown> }>(
        'select actor_id, action, entity, diff from audit_log where entity_id = $1 order by id',
        [entityId],
      )
    ).rows

  /**
   * Вся очередь, а не первая страница: база общая с соседними наборами,
   * и своя заявка легко оказывается на второй сотне.
   */
  async function queueAll(token: string): Promise<QueueItem[]> {
    const items: QueueItem[] = []
    let cursor: string | null = null
    for (let page = 0; page < 50; page++) {
      const url: string = `/admin/verifications?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      const res = await app.inject({ method: 'GET', url, headers: auth(token) })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      const body = res.json() as { items: QueueItem[]; nextCursor: string | null }
      items.push(...body.items)
      cursor = body.nextCursor
      if (!cursor) break
    }
    return items
  }

  /** Длина очереди тем же условием, что у списка и у показателя дашборда. */
  const queueSize = async () =>
    Number(
      (
        await app.db!.query<{ n: string }>(
          `select count(*)::text as n from vendor_verifications r
             join vendors v on v.id = r.vendor_id
             join users u on u.id = v.user_id and u.deleted_at is null
            where r.status = 'pending'`,
        )
      ).rows[0]!.n,
    )

  const card = (token: string, requestId: string) =>
    app.inject({ method: 'GET', url: `/admin/verifications/${requestId}`, headers: auth(token) })

  const decide = (token: string, requestId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/admin/verifications/${requestId}`, headers: auth(token), payload })

  const myStatus = (token: string) =>
    app.inject({ method: 'GET', url: '/vendor/verification', headers: auth(token) })

  /**
   * Окно тишины вокруг «сейчас»: некритичное уведомление откладывается до его
   * конца, критичное уходит немедленно. Так проверяется `critical: false` —
   * отдельной колонки у уведомления нет, есть только срок отправки.
   */
  async function quietNow(userId: string): Promise<void> {
    await app.db!.query(
      `insert into notification_prefs (user_id, quiet_from, quiet_to)
       values ($1, (now() at time zone 'Europe/Moscow')::time - interval '1 hour',
                   (now() at time zone 'Europe/Moscow')::time + interval '1 hour')
       on conflict (user_id) do update set quiet_from = excluded.quiet_from, quiet_to = excluded.quiet_to`,
      [userId],
    )
  }

  const deliveryDelayMinutes = async (userId: string) =>
    Number(
      (
        await app.db!.query<{ m: string }>(
          `select (extract(epoch from (deliver_after - created_at)) / 60)::text as m
             from notifications where user_id = $1 order by created_at desc limit 1`,
          [userId],
        )
      ).rows[0]!.m,
    )

  /* ── FR-001: раздел закрыт для постороннего ───────────────────────── */
  it('все четыре пути закрыты для постороннего, и следа в базе нет', async () => {
    const stranger = await newUser()
    const staff = await newStaff()
    const vendor = await newVendor('Неприкосновенная заявка')
    const requestId = await submit(vendor, { inn: '1234567890' })

    const calls: { method: 'GET' | 'POST'; url: string; payload?: unknown }[] = [
      { method: 'GET', url: '/admin/verifications' },
      { method: 'GET', url: `/admin/verifications/${requestId}` },
      {
        method: 'POST',
        url: `/admin/verifications/${requestId}`,
        payload: { action: 'reject', reason: `Взлом ${RUN}` },
      },
      // Кабинет подрядчика открыт подрядчику с анкетой: у постороннего её нет.
      { method: 'GET', url: '/vendor/verification' },
    ]
    for (const call of calls) {
      const res = await app.inject({ ...call, headers: auth(stranger.token) })
      const key = `${call.method} ${call.url}`
      // 404 сказал бы, что пути нет, и это была бы неправда.
      expect({ key, code: res.statusCode }).toEqual({ key, code: 403 })
      expect(res.json().error.code).toBe('forbidden')
    }

    // След в базе — единственная надёжная проверка: 403 мог бы прийти
    // уже после записи.
    expect((await requestRow(requestId)).status).toBe('pending')
    expect(await logOf(requestId)).toEqual([])
    // Сотрудник тем же путём проходит — раздел закрыт, а не сломан.
    expect((await card(staff.token, requestId)).statusCode).toBe(200)
  })

  /* ── FR-001: состав очереди ───────────────────────────────────────── */
  it('в очереди только неразобранные заявки, старейшие сверху и без документов', async () => {
    const staff = await newStaff()
    const older = await newVendor('Подал первым')
    const newer = await newVendor('Подал вторым')
    const done = await newVendor('Уже разобранный')

    const olderId = await submit(older, { kind: 'passport', inn: '027812345678' })
    const newerId = await submit(newer, { kind: 'company' })
    const doneId = await submit(done)

    // Порядок задаётся датой подачи, а не порядком вставки: заявка недельной
    // давности обязана быть выше сегодняшней (SC-004).
    await app.db!.query("update vendor_verifications set created_at = now() - interval '7 days' where id = $1", [
      olderId,
    ])
    await app.db!.query("update vendor_verifications set status = 'approved', checked_at = now() where id = $1", [
      doneId,
    ])

    const items = await queueAll(staff.token)
    const ids = items.map((i) => i.id)
    expect(ids).toContain(olderId)
    expect(ids).toContain(newerId)
    // Разобранная заявка в очереди не висит: решение по ней уже принято.
    expect(ids).not.toContain(doneId)
    expect(ids.indexOf(olderId)).toBeLessThan(ids.indexOf(newerId))

    const mine = items.find((i) => i.id === olderId)!
    expect(mine.vendorId).toBe(older.vendorId)
    expect(mine.vendorName).toBe(older.vendorName)
    expect(mine.kind).toBe('passport')
    expect(mine.hasFile).toBe(true)
    expect(items.find((i) => i.id === newerId)!.kind).toBe('company')

    /* Список не раздаёт документы: ни ссылки, ни ИНН в нём нет, и проверяется
     * это по телу целиком, а не по полям одной записи (FR-008). */
    const raw = await app.inject({ method: 'GET', url: '/admin/verifications?limit=100', headers: auth(staff.token) })
    expect(raw.body).not.toContain('027812345678')
    expect(raw.body).not.toContain('fileUrl')
    expect(raw.body).not.toContain('file_url')
  })

  it('заявка без ссылки на документ видна в очереди с пометкой', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Без документа')
    const requestId = await submit(vendor)
    /* Подать заявку без ссылки через API нельзя — `fileUrl` обязателен, — но
     * в базе строка без документа возможна (столбец не `not null`), и очередь
     * обязана сказать это словами, а не показать пустую ссылку (US1 §5). */
    await app.db!.query('update vendor_verifications set file_url = null where id = $1', [requestId])

    const item = (await queueAll(staff.token)).find((i) => i.id === requestId)!
    expect(item.hasFile).toBe(false)
  })

  it('заявка ушедшего подрядчика в очереди не показывается', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Ушедший')
    const requestId = await submit(vendor)
    expect((await queueAll(staff.token)).map((i) => i.id)).toContain(requestId)

    // Удаление аккаунта мягкое, строка остаётся — но разбирать документы
    // ушедшего человека некому и незачем.
    await app.db!.query('update users set deleted_at = now() where id = $1', [vendor.userId])

    expect((await queueAll(staff.token)).map((i) => i.id)).not.toContain(requestId)
    // И карточки у неё тоже нет: очередь и карточка смотрят на одно и то же.
    expect((await card(staff.token, requestId)).statusCode).toBe(404)
  })

  /* ── FR-002, FR-003: карточка и запись в журнал ───────────────────── */
  it('карточка отдаёт документ и ИНН и пишет просмотр в журнал', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Открываемая')
    const fileUrl = `https://cdn.tili-tili.ru/scan-${RUN}.pdf`
    const requestId = await submit(vendor, { kind: 'ip', fileUrl, inn: '1234567890' })

    const res = await card(staff.token, requestId)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.id).toBe(requestId)
    expect(body.vendorId).toBe(vendor.vendorId)
    expect(body.vendorName).toBe(vendor.vendorName)
    expect(body.kind).toBe('ip')
    expect(body.fileUrl).toBe(fileUrl)
    expect(body.inn).toBe('1234567890')
    expect(body.status).toBe('pending')
    expect(body.checkedAt).toBeNull()
    expect(typeof body.createdAt).toBe('string')
    // Анкета в каталоге — карточке есть куда вести.
    expect(body.vendorPublished).toBe(true)

    /* Документы выходят наружу только здесь, поэтому «кто смотрел» обязано
     * оставаться проверяемым: запись делается ДО ответа (FR-003). */
    const log = (await logOf(requestId)).filter((r) => r.action === 'verification.view')
    expect(log).toHaveLength(1)
    expect(log[0]!.actor_id).toBe(staff.userId)
    expect(log[0]!.entity).toBe('verification')

    // Второй просмотр — вторая запись: журнал считает открытия, а не людей.
    expect((await card(staff.token, requestId)).statusCode).toBe(200)
    expect((await logOf(requestId)).filter((r) => r.action === 'verification.view')).toHaveLength(2)
  })

  it('карточка по снятой с публикации анкете открывается и говорит об этом', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Снятая с публикации')
    const requestId = await submit(vendor)
    await app.db!.query('update vendors set published_at = null where id = $1', [vendor.vendorId])

    const res = await card(staff.token, requestId)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    // Документы от публикации не зависят: заявка разбирается, а признак
    // нужен экрану, чтобы не вести на анкету, которой в каталоге нет.
    expect(res.json().vendorPublished).toBe(false)
  })

  it('карточка несуществующей заявки — 404', async () => {
    const staff = await newStaff()
    const res = await card(staff.token, uuidv7())
    expect(res.statusCode, res.body.slice(0, 200)).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  /* ── FR-004: подтверждение документов ─────────────────────────────── */
  it('подтверждение документов закрывает заявку, ставит галочку и зовёт подрядчика', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Проверяемая')
    const requestId = await submit(vendor, { inn: '1234567890' })
    await quietNow(vendor.userId)
    expect((await vendorRow(vendor.vendorId)).verified_at).toBeNull()

    const res = await decide(staff.token, requestId, { action: 'approve' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json()).toEqual({ requestId, action: 'approve' })

    const row = await requestRow(requestId)
    expect(row.status).toBe('approved')
    expect(row.checked_at).not.toBeNull()
    // Галочка появляется сразу, а не «когда-нибудь»: этого ради и решение.
    expect((await vendorRow(vendor.vendorId)).verified_at).not.toBeNull()
    // Заявка ушла из очереди.
    expect((await queueAll(staff.token)).map((i) => i.id)).not.toContain(requestId)

    const notes = await notesOf(vendor.userId)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.kind).toBe('system')
    expect(notes[0]!.title).toBe('Вы проверены')
    expect(notes[0]!.link).toBe('/vendor-app/verification')
    // Проверка документов не срочная: тихие часы соблюдаются (A6).
    expect(await deliveryDelayMinutes(vendor.userId)).toBeGreaterThan(30)

    const log = (await logOf(requestId)).filter((r) => r.action === 'verification.approve')
    expect(log).toHaveLength(1)
    expect(log[0]!.actor_id).toBe(staff.userId)
    expect(log[0]!.entity).toBe('verification')
    expect(log[0]!.diff).toEqual({ vendorId: vendor.vendorId, reason: null })
  })

  it('подтверждение по уже проверенному подрядчику второй новости не шлёт', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Проверенная из модерации')

    // Галочку поставили из очереди анкет — подрядчик уже получил «Вы проверены».
    const verified = await app.inject({
      method: 'POST',
      url: `/admin/moderation/vendors/${vendor.vendorId}`,
      headers: auth(staff.token),
      payload: { action: 'verify' },
    })
    expect(verified.statusCode, verified.body.slice(0, 200)).toBe(200)
    const stamp = (await vendorRow(vendor.vendorId)).verified_at
    expect(stamp).not.toBeNull()
    const before = await notesOf(vendor.userId)
    expect(before.filter((n) => n.title === 'Вы проверены')).toHaveLength(1)

    // Старая заявка, поданная до того, всё равно разбирается — и закрывается.
    const requestId = await submit(vendor)
    expect((await decide(staff.token, requestId, { action: 'approve' })).statusCode).toBe(200)

    expect((await requestRow(requestId)).status).toBe('approved')
    // Дата первой проверки не переписывается, и второго «Вы проверены» нет:
    // одно и то же событие дважды новостью не бывает (FR-004).
    expect((await vendorRow(vendor.vendorId)).verified_at).toEqual(stamp)
    expect(await notesOf(vendor.userId)).toEqual(before)
  })

  /* ── FR-005: отказ по документам ──────────────────────────────────── */
  it('отказ без причины не принимается', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Отклоняемая молча')
    const requestId = await submit(vendor)

    for (const payload of [{ action: 'reject' }, { action: 'reject', reason: '   ' }]) {
      const res = await decide(staff.token, requestId, payload)
      expect({ payload, code: res.statusCode }).toEqual({ payload, code: 422 })
      expect(res.json().error.code).toBe('validation_failed')
      // Поле называет причину: форма подсветит именно её.
      expect(res.json().error.fields.reason).toBeTruthy()
    }

    // Отказ без объяснения подрядчику нечем исправить, поэтому заявка
    // остаётся неразобранной, а не закрывается молча.
    expect((await requestRow(requestId)).status).toBe('pending')
    expect(await notesOf(vendor.userId)).toEqual([])
  })

  it('отказ с причиной закрывает заявку, анкету не трогает и объясняет подрядчику', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Отклоняемая по делу')
    const requestId = await submit(vendor)
    await quietNow(vendor.userId)
    const before = await vendorRow(vendor.vendorId)
    const reason = `Скан нечитаемый ${RUN}`

    const res = await decide(staff.token, requestId, { action: 'reject', reason })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json()).toEqual({ requestId, action: 'reject' })

    const row = await requestRow(requestId)
    expect(row.status).toBe('rejected')
    expect(row.checked_at).not.toBeNull()
    // Галочки нет и анкета осталась ровно такой, какой была: снятие
    // с публикации — другое решение и другой путь (FR-005).
    expect(await vendorRow(vendor.vendorId)).toEqual(before)
    expect((await vendorRow(vendor.vendorId)).verified_at).toBeNull()

    const notes = await notesOf(vendor.userId)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.title).toBe('Документы не подтверждены')
    // Причина уходит подрядчику: своего поля у заявки нет, читает он её здесь (A3).
    expect(notes[0]!.body).toBe(reason)
    expect(notes[0]!.link).toBe('/vendor-app/verification')
    expect(await deliveryDelayMinutes(vendor.userId)).toBeGreaterThan(30)

    const log = (await logOf(requestId)).filter((r) => r.action === 'verification.reject')
    expect(log).toHaveLength(1)
    expect(log[0]!.diff).toEqual({ vendorId: vendor.vendorId, reason })
  })

  /* ── FR-006: двое сотрудников ─────────────────────────────────────── */
  it('решение по уже разобранной заявке — 409, и первое не переписано', async () => {
    const staff = await newStaff()
    const second = await newStaff()
    const vendor = await newVendor('Разбираемая дважды')
    const requestId = await submit(vendor)
    const reason = `Не тот документ ${RUN}`

    expect((await decide(staff.token, requestId, { action: 'reject', reason })).statusCode).toBe(200)

    const again = await decide(second.token, requestId, { action: 'approve' })
    expect(again.statusCode, again.body.slice(0, 200)).toBe(409)
    expect(again.json().error.code).toBe('verification_not_pending')

    // Решение первого сотрудника остаётся тем, каким он его принял, галочки
    // нет, и подрядчик не получает вторую новость об одном и том же.
    expect((await requestRow(requestId)).status).toBe('rejected')
    expect((await vendorRow(vendor.vendorId)).verified_at).toBeNull()
    expect(await notesOf(vendor.userId)).toHaveLength(1)
  })

  it('решение по несуществующей заявке — 404', async () => {
    const staff = await newStaff()
    const res = await decide(staff.token, uuidv7(), { action: 'approve' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('решение по заявке ушедшего подрядчика — 404, и заявка остаётся неразобранной', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Ушедший до решения')
    const requestId = await submit(vendor)

    /* Из очереди и из карточки такая заявка пропадает, а решение по прямой
     * ссылке проходило: сотрудник ставил галочку человеку, которого на
     * платформе больше нет, и заявка закрывалась задним числом. Условие
     * должно быть одно на все три пути. */
    await app.db!.query('update users set deleted_at = now() where id = $1', [vendor.userId])

    const res = await decide(staff.token, requestId, { action: 'approve' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(404)
    expect(res.json().error.code).toBe('not_found')

    const row = await requestRow(requestId)
    expect(row.status).toBe('pending')
    expect(row.checked_at).toBeNull()
    expect((await vendorRow(vendor.vendorId)).verified_at).toBeNull()
  })

  /* ── V-10: ограничения тела заявки живут в контракте ──────────────── */
  it('ссылка на документ не по https не принимается', async () => {
    const vendor = await newVendor('Со ссылкой не по https')

    for (const fileUrl of ['http://cdn.tili-tili.ru/doc.pdf', 'javascript:alert(1)', 'file:///c:/scan.pdf']) {
      const res = await app.inject({
        method: 'POST',
        url: '/vendor/verification',
        headers: auth(vendor.token),
        payload: { kind: 'ip', fileUrl },
      })
      /* Ссылку открывает сотрудник в новой вкладке из карточки заявки:
       * `javascript:` там — не документ, а то, что ему подсунули. Требование
       * жило только в схеме обработчика, и клиент, писавший по контракту,
       * узнавал о нём из 422. */
      expect({ fileUrl, code: res.statusCode }).toEqual({ fileUrl, code: 422 })
      expect(res.json().error.code).toBe('validation_failed')
    }

    // Заявки от этих попыток не осталось: отказ схемы — до обработчика.
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from vendor_verifications where vendor_id = $1',
      [vendor.vendorId],
    )
    expect(Number(rows[0]!.n)).toBe(0)
  })

  /* ── FR-009: снятие анкеты заявку не закрывает ────────────────────── */
  it('снятие анкеты с публикации заявку на верификацию не трогает', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Снимаемая с заявкой')
    const requestId = await submit(vendor)

    const rejected = await app.inject({
      method: 'POST',
      url: `/admin/moderation/vendors/${vendor.vendorId}`,
      headers: auth(staff.token),
      payload: { action: 'reject', reason: `Фото не свои ${RUN}` },
    })
    expect(rejected.statusCode, rejected.body.slice(0, 200)).toBe(200)
    expect((await vendorRow(vendor.vendorId)).published_at).toBeNull()

    /* Документы и публикация — разные решения. Раньше снятие анкеты заодно
     * отклоняло заявку: документы никто не смотрел, а подрядчик получал
     * «отклонено» за фотографии в анкете (FR-009). */
    const row = await requestRow(requestId)
    expect(row.status).toBe('pending')
    expect(row.checked_at).toBeNull()
    expect((await queueAll(staff.token)).map((i) => i.id)).toContain(requestId)
  })

  it('отметка «проверен» из очереди анкет заявку по-прежнему закрывает', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Проверяемая из очереди')
    const requestId = await submit(vendor)

    const verified = await app.inject({
      method: 'POST',
      url: `/admin/moderation/vendors/${vendor.vendorId}`,
      headers: auth(staff.token),
      payload: { action: 'verify' },
    })
    expect(verified.statusCode, verified.body.slice(0, 200)).toBe(200)

    // Галочка без закрытой заявки оставила бы её «на проверке» навсегда (A7).
    expect((await requestRow(requestId)).status).toBe('approved')
    expect((await vendorRow(vendor.vendorId)).verified_at).not.toBeNull()
  })

  /* ── FR-010: показатель на дашборде ───────────────────────────────── */
  it('показатель заявок на дашборде считает ровно то, что показывает очередь', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Считаемая')
    await submit(vendor)

    /* База общая, соседние наборы подают заявки параллельно — поэтому
     * показатель зажимается между двумя замерами очереди, а не сравнивается
     * с одним (тот же приём, что у очереди анкет, A-01). */
    const before = await queueSize()
    const res = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(staff.token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const shown = (res.json() as { verificationQueue: number }).verificationQueue
    const after = await queueSize()

    expect(typeof shown).toBe('number')
    expect(shown).toBeGreaterThanOrEqual(Math.min(before, after))
    expect(shown).toBeLessThanOrEqual(Math.max(before, after))
  })

  /* ── FR-007: статус в кабинете подрядчика ─────────────────────────── */
  it('подрядчик видит свой статус: нет заявки → на проверке → одобрена', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Следящая за статусом')

    const none = await myStatus(vendor.token)
    expect(none.statusCode, none.body.slice(0, 200)).toBe(200)
    // «Заявок не было» — это состояние, а не пустой ответ: экран различает
    // «не подавал» и «подал, ждём» (FR-007).
    expect(none.json()).toEqual({ status: 'none', kind: null, submittedAt: null, checkedAt: null })

    const requestId = await submit(vendor, { kind: 'passport', inn: '1234567890' })
    const pending = await myStatus(vendor.token)
    expect(pending.statusCode, pending.body.slice(0, 200)).toBe(200)
    const waiting = pending.json() as Record<string, unknown>
    expect(waiting.status).toBe('pending')
    expect(waiting.kind).toBe('passport')
    expect(typeof waiting.submittedAt).toBe('string')
    expect(waiting.checkedAt).toBeNull()
    /* Свои документы экрану не нужны, а лишний ответ с документом — это
     * документ, осевший в кэше устройства (FR-008). */
    expect(pending.body).not.toContain('fileUrl')
    expect(pending.body).not.toContain('1234567890')

    expect((await decide(staff.token, requestId, { action: 'approve' })).statusCode).toBe(200)
    const approved = await myStatus(vendor.token)
    expect(approved.statusCode, approved.body.slice(0, 200)).toBe(200)
    const done = approved.json() as Record<string, unknown>
    expect(done.status).toBe('approved')
    expect(typeof done.checkedAt).toBe('string')
    expect(done.submittedAt).toBe(waiting.submittedAt)
  })

  it('после отказа подрядчик видит отклонённую заявку с датой решения', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Получившая отказ')
    const requestId = await submit(vendor)
    expect((await decide(staff.token, requestId, { action: 'reject', reason: `Нечитаемо ${RUN}` })).statusCode).toBe(200)

    const res = await myStatus(vendor.token)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.status).toBe('rejected')
    expect(typeof body.checkedAt).toBe('string')
    // Причины в ответе нет: она приходит уведомлением (A3).
    expect(res.body).not.toContain('Нечитаемо')
  })

  it('подрядчик видит свою последнюю заявку, а не чужую и не первую', async () => {
    const staff = await newStaff()
    const mine = await newVendor('Своя заявка')
    const other = await newVendor('Чужая заявка')

    const first = await submit(mine, { kind: 'passport' })
    expect((await decide(staff.token, first, { action: 'reject', reason: `Первый отказ ${RUN}` })).statusCode).toBe(200)
    await app.db!.query("update vendor_verifications set created_at = now() - interval '7 days' where id = $1", [first])
    await submit(other, { kind: 'company' })
    await submit(mine, { kind: 'ip' })

    // Экран показывает состояние дел на сейчас: после отказа подрядчик подаёт
    // документы заново, и «отклонена» с прошлой недели — уже неправда.
    const res = await myStatus(mine.token)
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json().status).toBe('pending')
    expect(res.json().kind).toBe('ip')

    // И чужая заявка на этот экран не попадает: `company` подавал сосед.
    const theirs = await myStatus(other.token)
    expect(theirs.json().kind).toBe('company')
  })
})
