import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'
import { PUSH_LIMIT_PER_DAY } from '../src/notify/notify.js'

/**
 * Админка платформы (фича tasks/фичи/001-админка), фаза 2 — основа.
 *
 * Две вещи, без которых панели не бывает.
 *
 * Первая: человек должен узнать, сотрудник он или нет. Признак `users.is_staff`
 * лежал в базе и наружу не выходил вовсе — меню «Мы» не могло решить, показывать
 * ли пункт «Админка», и единственным способом это выяснить был запрос в саму
 * панель с чтением 403. Признак отдаётся только про себя и только на чтение:
 * тело `PATCH /users/me` его не принимает, иначе «сделай меня админом» стало бы
 * одним запросом (SC-004).
 *
 * Вторая: `PUT /admin/categories` заменяет словарь синонимов ЦЕЛИКОМ, а прочитать
 * его было неоткуда. Экран правил бы словарь вслепую и стирал бы строки, которых
 * сотрудник ни разу не видел.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Категория для круга PUT → GET. Ни один тест её не трогает, значения возвращаются. */
const CAT = 'vykup'
/** Вторая — для проверок словаря и журнала. Новых категорий не заводим: их ровно 35. */
const CAT2 = 'honeymoon'
/** Нулевой идентификатор: с него начинается страница очереди по курсору. */
const ZERO_ID = '00000000-0000-0000-0000-000000000000'

interface AdminCategory {
  id: string
  title: string
  icon: string | null
  sort: number
}

describe.skipIf(!live)('админка: основа панели сотрудника', () => {
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

  const readCategories = async (token: string) => {
    const res = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as { categories: AdminCategory[]; synonyms: Record<string, string> }
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
    return { ...user, vendorId: created.json().id as string }
  }

  const vendorRow = async (vendorId: string) =>
    (
      await app.db!.query<{
        created_at: Date
        published_at: Date | null
        moderated_at: Date | null
        verified_at: Date | null
        downranked_at: Date | null
        blocked_at: Date | null
      }>(
        `select created_at, published_at, moderated_at, verified_at, downranked_at, blocked_at
           from vendors where id = $1`,
        [vendorId],
      )
    ).rows[0]!

  /** Уведомления одного человека — свежие сверху. */
  const notesOf = async (userId: string) =>
    (
      await app.db!.query<{ kind: string; title: string; body: string; link: string | null; deliver_after: Date }>(
        'select kind, title, body, link, deliver_after from notifications where user_id = $1 order by created_at desc',
        [userId],
      )
    ).rows

  /** Журнал по одной сущности. Из него ничего не удаляется — только добавляется (FR-014). */
  const logOf = async (entityId: string) =>
    (
      await app.db!.query<{ action: string; entity: string; diff: Record<string, unknown> | null }>(
        'select action, entity, diff from audit_log where entity_id = $1 order by id',
        [entityId],
      )
    ).rows

  /**
   * Очередь модерации с курсором «сразу перед этой анкетой».
   *
   * Очередь идёт от старейших, база у наборов общая — без курсора наша анкета
   * оказалась бы на сотой странице, и проверять было бы нечего.
   */
  const queueSince = async (token: string, at: Date) => {
    const cursor = Buffer.from(`${new Date(at.getTime() - 1).toISOString()}|${ZERO_ID}`, 'utf8').toString('base64url')
    const res = await app.inject({
      method: 'GET',
      url: `/admin/moderation/vendors?limit=100&cursor=${cursor}`,
      headers: auth(token),
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as { items: { id: string; createdAt: string; publishedAt: string | null }[] }
  }

  /**
   * `critical` в базе не колонка, а срок доставки: критичное идёт мимо тихих
   * часов и мимо дневного лимита (§18.6). Чтобы это было видно тестом в любое
   * время суток, гасим тихие часы (пустое окно) и забиваем дневную норму:
   * некритичное после этого уедет на сутки, критичное придёт сейчас.
   */
  async function fillPushQuota(userId: string) {
    await app.db!.query(
      `insert into notification_prefs (user_id, quiet_from, quiet_to) values ($1, '00:00', '00:00')
       on conflict (user_id) do update set quiet_from = '00:00', quiet_to = '00:00'`,
      [userId],
    )
    for (let i = 0; i < PUSH_LIMIT_PER_DAY; i++) {
      await app.db!.query(
        `insert into notifications (id, user_id, kind, title, body, deliver_after)
         values ($1, $2, 'system', 'норма дня', 'норма дня', now())`,
        [uuidv7(), userId],
      )
    }
  }

  const soon = (at: Date) => Math.abs(at.getTime() - Date.now()) < 60_000

  const decideVendor = (token: string, vendorId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/admin/moderation/vendors/${vendorId}`, headers: auth(token), payload })

  /** Жалоба от человека на объект. Ответ идентификатора не отдаёт — берём из базы. */
  async function complain(
    reporter: { token: string; userId: string },
    targetKind: string,
    targetId: string,
    category: string,
  ) {
    const res = await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(reporter.token),
      payload: { targetKind, targetId, category, text: `жалоба ${RUN}` },
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(201)
    const { rows } = await app.db!.query<{ id: string }>(
      'select id from complaints where reporter_id = $1 and target_id = $2',
      [reporter.userId, targetId],
    )
    return rows[0]!.id
  }

  const decideComplaint = (token: string, complaintId: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/admin/complaints/${complaintId}`, headers: auth(token), payload })

  const complaintRow = async (id: string) =>
    (
      await app.db!.query<{ status: string; resolution: string | null }>(
        'select status, resolution from complaints where id = $1',
        [id],
      )
    ).rows[0]!

  /* ── признак сотрудника ───────────────────────────────────────────── */
  it('профиль называет признак сотрудника, а изменить его нельзя', async () => {
    const user = await newUser()
    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(before.statusCode).toBe(200)
    /* Именно false, а не отсутствие поля: «не знаем» и «не сотрудник» —
     * разные ответы, и меню «Мы» рисуется по этому различию. */
    expect(before.json().isStaff).toBe(false)

    // Права в теле профиля — это повышение прав в один запрос (SC-004).
    const patched = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(user.token),
      payload: { isStaff: true },
    })
    expect(patched.statusCode).toBe(422)
    expect(patched.json().error.code).toBe('validation_failed')

    const still = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(still.json().isStaff).toBe(false)
    // Проверка по базе, а не по ответу экрана: 422 мог бы прийти уже после записи.
    const { rows } = await app.db!.query<{ is_staff: boolean }>('select is_staff from users where id = $1', [
      user.userId,
    ])
    expect(rows[0]!.is_staff).toBe(false)

    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(user.token) })
    expect(after.json().isStaff).toBe(true)
  })

  /* ── категории и словарь ──────────────────────────────────────────── */
  it('категории панели закрыты для постороннего и открыты сотруднику', async () => {
    const stranger = await newUser()
    const denied = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(stranger.token) })
    // 404 сказал бы, что пути нет, и это была бы неправда.
    expect(denied.statusCode).toBe(403)
    expect(denied.json().error.code).toBe('forbidden')

    const staff = await newStaff()
    const body = await readCategories(staff.token)
    expect(body.categories.length).toBeGreaterThan(30)
    const photo = body.categories.find((c) => c.id === 'photo')
    expect(photo).toBeDefined()
    expect(photo!.title.length).toBeGreaterThan(0)
    expect(typeof photo!.sort).toBe('number')
    // Словарь — объект «слово → категория», а не список и не пропущенное поле.
    expect(Array.isArray(body.synonyms)).toBe(false)
    expect(typeof body.synonyms).toBe('object')
  })

  it('словарь синонимов читается целиком — иначе панель правит его вслепую', async () => {
    const staff = await newStaff()
    const word = `синоним${RUN}`
    await app.db!.query(
      `insert into category_synonyms (word, category_id) values ($1, 'photo')
       on conflict (word) do update set category_id = excluded.category_id`,
      [word],
    )
    const body = await readCategories(staff.token)
    expect(body.synonyms[word]).toBe('photo')
  })

  it('круг PUT → GET сходится, а пропущенный значок остаётся прежним', async () => {
    const staff = await newStaff()
    const pick = async () => (await readCategories(staff.token)).categories.find((c) => c.id === CAT)!
    const before = await pick()
    expect(before).toBeDefined()

    const put = async (payload: unknown) => {
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/categories',
        headers: auth(staff.token),
        payload,
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      return res.json() as { categories: number; synonyms: number; version: string }
    }

    try {
      const written = await put({ categories: [{ id: CAT, title: `Выкуп ${RUN}`, icon: '🧪', sort: before.sort + 7 }] })
      /* Ответ несёт ещё и новую версию справочника (фича 004): счётчики
       * строк сверяются по-прежнему строго, версия — отдельно, потому что
       * её значение зависит от содержимого базы. Что она означает и когда
       * меняется, проверяет audit27. */
      expect({ categories: written.categories, synonyms: written.synonyms }).toEqual({ categories: 1, synonyms: 0 })
      expect(written.version).toMatch(/^[0-9a-f]{16}$/)
      const saved = await pick()
      expect(saved.title).toBe(`Выкуп ${RUN}`)
      expect(saved.icon).toBe('🧪')
      expect(saved.sort).toBe(before.sort + 7)

      /* Клиент не шлёт `icon: null` — он опускает поле, и значок должен
       * остаться прежним. Иначе правка названия стирала бы картинку.
       * То же с `sort`: пропущенный порядок — «не менять», а не «наверх»:
       * `coalesce(0, старое)` — это 0, и правка названия поднимала бы
       * категорию на первое место мозаики. */
      await put({ categories: [{ id: CAT, title: `Выкуп ${RUN} и ещё` }] })
      const kept = await pick()
      expect(kept.title).toBe(`Выкуп ${RUN} и ещё`)
      expect(kept.icon).toBe('🧪')
      expect(kept.sort).toBe(before.sort + 7)
    } finally {
      // Справочник общий: возвращаем как было, чтобы соседние наборы читали своё.
      await put({
        categories: [
          before.icon === null
            ? { id: CAT, title: before.title, sort: before.sort }
            : { id: CAT, title: before.title, icon: before.icon, sort: before.sort },
        ],
      })
    }
  })

  /* ── US1: очередь модерации анкет ─────────────────────────────────── */
  it('очередь модерации: заблокированной анкеты в ней нет, а у остальных есть дата публикации', async () => {
    const staff = await newStaff()
    const blocked = await newVendor('Заблокированная')
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [blocked.vendorId])
    const fresh = await newVendor('Свежая')

    const page = await queueSince(staff.token, (await vendorRow(blocked.vendorId)).created_at)
    const ids = page.items.map((v) => v.id)
    /* Очередь идёт от старейших: заблокированная заведена РАНЬШЕ свежей.
     * Свежая на странице есть — значит, окно страницы покрывает обеих,
     * и отсутствие заблокированной не объясняется границей страницы. */
    expect(ids).toContain(fresh.vendorId)
    // Решение по заблокированной уже принято, второй раз его не принимают.
    expect(ids).not.toContain(blocked.vendorId)

    const item = page.items.find((v) => v.id === fresh.vendorId)!
    /* Срок проверки считается от публикации: у анкеты, пролежавшей месяц
     * в черновике, это другой день, чем дата заведения. */
    expect(typeof item.publishedAt).toBe('string')
    expect(Number.isNaN(Date.parse(item.publishedAt!))).toBe(false)
    expect(typeof item.createdAt).toBe('string')
  })

  it('снятие с публикации без причины не принимается, и анкета остаётся в каталоге', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Без причины')

    for (const payload of [{ action: 'reject' }, { action: 'reject', reason: '   ' }]) {
      const res = await decideVendor(staff.token, vendor.vendorId, payload)
      expect(res.statusCode, res.body.slice(0, 200)).toBe(422)
      // Форма ответа — та же, что у отказа схемы: код один, поле названо.
      expect(res.json().error.code).toBe('validation_failed')
      expect(res.json().error.fields.reason).toBeTruthy()
    }

    const row = await vendorRow(vendor.vendorId)
    // Проверка по базе: 422 мог бы прийти уже после записи.
    expect(row.published_at).not.toBeNull()
    expect(row.moderated_at).toBeNull()
    expect(await notesOf(vendor.userId)).toEqual([])
  })

  it('одобрение: анкета проверена, подрядчик уведомлён, решение в журнале', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Одобряемая')

    const res = await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect(res.json()).toEqual({ vendorId: vendor.vendorId, action: 'approve' })

    const row = await vendorRow(vendor.vendorId)
    expect(row.moderated_at).not.toBeNull()
    // Одобрение оставляет анкету в каталоге — это не снятие с публикации.
    expect(row.published_at).not.toBeNull()

    const notes = await notesOf(vendor.userId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'system', title: 'Анкета проверена', link: '/vendor-app' })

    const log = (await logOf(vendor.vendorId)).filter((r) => r.action === 'vendor.approve')
    expect(log).toHaveLength(1)
    expect(log[0]!.entity).toBe('vendor')
  })

  it('снятие с публикации с причиной: анкета вне каталога, новость срочная, причина в журнале', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Снимаемая')
    await fillPushQuota(vendor.userId)
    const reason = `Фото не свои ${RUN}`

    const res = await decideVendor(staff.token, vendor.vendorId, { action: 'reject', reason })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)

    const row = await vendorRow(vendor.vendorId)
    expect(row.published_at).toBeNull()
    expect(row.moderated_at).not.toBeNull()

    const notes = (await notesOf(vendor.userId)).filter((n) => n.title === 'Анкета снята с публикации')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'system', link: '/vendor-app', body: reason })
    // Потеря дохода не ждёт утра: дневная норма забита, а новость всё равно сейчас.
    expect(soon(notes[0]!.deliver_after)).toBe(true)

    const log = (await logOf(vendor.vendorId)).filter((r) => r.action === 'vendor.reject')
    expect(log).toHaveLength(1)
    expect(log[0]!.diff).toEqual({ reason })
  })

  /* ── US2: санкции по жалобам ──────────────────────────────────────── */
  it('санкция, неприменимая к цели, жалобу не разбирает', async () => {
    const staff = await newStaff()
    const reporter = await newUser()

    /* Ни сообщение, ни сделку сервер не блокирует и не понижает. Приняв
     * такое решение, он закрыл бы жалобу вообще без санкции: `resolution`
     * записан, а не сделано ничего. */
    const messageId = uuidv7()
    const onMessage = await complain(reporter, 'message', messageId, 'spam')
    for (const action of ['block', 'downrank']) {
      const denied = await decideComplaint(staff.token, onMessage, { action })
      expect({ action, code: denied.statusCode }).toEqual({ action, code: 422 })
      expect(denied.json().error.code).toBe('validation_failed')
      expect(denied.json().error.fields.action).toBeTruthy()
      // Жалоба обязана остаться нерассмотренной: её разберёт следующий.
      expect(await complaintRow(onMessage)).toEqual({ status: 'new', resolution: null })
    }
    // Применимая санкция после отказа проходит — путь не сломан.
    expect((await decideComplaint(staff.token, onMessage, { action: 'warn' })).statusCode).toBe(200)
    expect(await complaintRow(onMessage)).toEqual({ status: 'resolved', resolution: 'warn' })
  })

  it('предупреждение по жалобе доходит до подрядчика, а заметка модератора — нет', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Предупреждённая')
    const reporter = await newUser()
    const id = await complain(reporter, 'vendor', vendor.vendorId, 'fraud')
    const secret = `внутренняя заметка ${RUN}`

    const res = await decideComplaint(staff.token, id, { action: 'warn', note: secret })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)

    const notes = await notesOf(vendor.userId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'system', title: 'Предупреждение от модерации', link: '/vendor-app' })
    // Повод — словами: иначе подрядчику нечего исправлять.
    expect(notes[0]!.body).toContain('мошенничество')
    // Заметка пишется для журнала и для следующего сотрудника (FR-006).
    expect(`${notes[0]!.title} ${notes[0]!.body}`).not.toContain(secret)

    // Предупреждение ничего не меняет в выдаче — только в журнале.
    const row = await vendorRow(vendor.vendorId)
    expect(row.downranked_at).toBeNull()
    expect(row.blocked_at).toBeNull()

    const log = (await logOf(vendor.vendorId)).filter((r) => r.action === 'complaint.warn')
    expect(log).toHaveLength(1)
    expect(log[0]!.diff).toEqual({ complaintId: id, note: secret })
    expect(await complaintRow(id)).toEqual({ status: 'resolved', resolution: 'warn' })
  })

  it('понижение в выдаче помечает анкету и доходит до подрядчика', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Понижаемая')
    const reporter = await newUser()
    const id = await complain(reporter, 'vendor', vendor.vendorId, 'content')

    expect((await decideComplaint(staff.token, id, { action: 'downrank' })).statusCode).toBe(200)
    expect((await vendorRow(vendor.vendorId)).downranked_at).not.toBeNull()

    const notes = await notesOf(vendor.userId)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ kind: 'system', title: 'Анкета понижена в выдаче', link: '/vendor-app' })
    expect(notes[0]!.body).toContain('недопустимое содержание')
  })

  it('блокировка по жалобе: анкета вне каталога, а новость срочная', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Блокируемая')
    await fillPushQuota(vendor.userId)
    const reporter = await newUser()
    const id = await complain(reporter, 'vendor', vendor.vendorId, 'no_show')

    expect((await decideComplaint(staff.token, id, { action: 'block' })).statusCode).toBe(200)
    expect((await vendorRow(vendor.vendorId)).blocked_at).not.toBeNull()

    const notes = (await notesOf(vendor.userId)).filter((n) => n.title === 'Анкета заблокирована')
    expect(notes).toHaveLength(1)
    expect(notes[0]!.body).toContain('неявка')
    // Дневная норма забита, а новость всё равно сейчас: это потеря дохода.
    expect(soon(notes[0]!.deliver_after)).toBe(true)

    const log = (await logOf(vendor.vendorId)).filter((r) => r.action === 'complaint.block')
    expect(log).toHaveLength(1)
    expect(log[0]!.diff).toMatchObject({ complaintId: id })
  })

  it('жалоба на отзыв: понизить его нельзя, скрыть — можно', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('С отзывом')
    /* Отзыв заводится прямо в базе: путь его создания проверяют наборы
     * каталога, а здесь важно решение модератора по нему. */
    const reviewId = uuidv7()
    await app.db!.query(
      `insert into reviews (id, vendor_id, source, guest_token, stars, text)
       values ($1, $2, 'guest', $3, 1, 'текст отзыва')`,
      [reviewId, vendor.vendorId, `guest-${uuidv7()}`],
    )
    const reporter = await newUser()
    const id = await complain(reporter, 'review', reviewId, 'content')

    // Понижают в выдаче анкету, а не отзыв: у отзыва два исхода — оставить или скрыть.
    const denied = await decideComplaint(staff.token, id, { action: 'downrank' })
    expect(denied.statusCode, denied.body.slice(0, 200)).toBe(422)
    expect(denied.json().error.fields.action).toBeTruthy()
    expect(await complaintRow(id)).toEqual({ status: 'new', resolution: null })

    expect((await decideComplaint(staff.token, id, { action: 'block' })).statusCode).toBe(200)
    const { rows } = await app.db!.query<{ hidden_at: Date | null }>(
      'select hidden_at from reviews where id = $1',
      [reviewId],
    )
    expect(rows[0]!.hidden_at).not.toBeNull()
    // Санкция здесь не к подрядчику: уведомлять его не о чем.
    expect(await notesOf(vendor.userId)).toEqual([])

    const log = (await logOf(reviewId)).filter((r) => r.action === 'complaint.block')
    expect(log).toHaveLength(1)
    expect(log[0]!.entity).toBe('review')
  })

  /* ── US4: словарь синонимов и журнал ──────────────────────────────── */
  it('слово словаря на несуществующую категорию — ошибка проверки, и справочник не тронут', async () => {
    const staff = await newStaff()
    const before = (await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!
    const word = `слово${RUN}`

    const res = await app.inject({
      method: 'PUT',
      url: '/admin/categories',
      headers: auth(staff.token),
      payload: {
        categories: [{ id: CAT2, title: `Переименовано ${RUN}`, sort: before.sort }],
        synonyms: { [word]: `нет-такой-${RUN}` },
      },
    })
    /* До фикса сюда доходил `insert` и падал на внешнем ключе: 500
     * «внутренняя ошибка» вместо ошибки проверки, и словарь к этому моменту
     * уже стёрт целиком — спасал только откат транзакции. */
    expect(res.statusCode, res.body.slice(0, 200)).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
    // Поле называет само слово: форма подсветит именно ту строку словаря.
    expect(res.json().error.fields[`synonyms.${word}`]).toBeTruthy()

    // Не изменилось ничего: ни словарь, ни категория из того же тела.
    const { rows } = await app.db!.query('select 1 from category_synonyms where word = $1', [word])
    expect(rows).toHaveLength(0)
    expect((await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!.title).toBe(before.title)
  })

  it('журнал — часть той же транзакции: не записался журнал, не изменился и справочник', async () => {
    const staff = await newStaff()
    const before = (await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!

    /* Инъекция сбоя: временный триггер роняет ЗАПИСЬ ЖУРНАЛА этого
     * сотрудника. Условие по актору — соседние наборы, идущие параллельно,
     * его не замечают. Снимается в finally. */
    const name = `audit23_fault_${RUN}`
    await app.db!.query(
      `create function ${name}() returns trigger language plpgsql as $$
         begin
           if new.action = 'categories.update' and new.actor_id = '${staff.userId}' then
             raise exception 'fault injected by audit23';
           end if;
           return new;
         end $$`,
    )
    await app.db!.query(`create trigger ${name} before insert on audit_log for each row execute function ${name}()`)
    let afterFault = ''
    let failedCode = 0
    try {
      const failed = await app.inject({
        method: 'PUT',
        url: '/admin/categories',
        headers: auth(staff.token),
        payload: { categories: [{ id: CAT2, title: `Сорвалось ${RUN}`, sort: before.sort }] },
      })
      failedCode = failed.statusCode
      afterFault = (await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!.title
    } finally {
      await app.db!.query(`drop trigger if exists ${name} on audit_log`)
      await app.db!.query(`drop function if exists ${name}()`)
      /* Справочник общий: если проверка не сойдётся, имя категории останется
       * испорченным для соседних наборов и следующих прогонов. */
      await app.db!.query('update categories set name = $1 where id = $2', [before.title, CAT2])
    }

    expect(failedCode).toBe(500)
    /* До фикса журнал писался ПОСЛЕ транзакции: категория оставалась
     * переименованной, а записи о том, кто её переименовал, не было —
     * а удалить из журнала нельзя ничего, значит и появиться там задним
     * числом ничего не может. */
    expect(afterFault).toBe(before.title)
  })

  it('успешное сохранение справочника принимает null у значка и оставляет запись в журнале', async () => {
    const staff = await newStaff()
    const before = (await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!
    const put = (payload: unknown) =>
      app.inject({ method: 'PUT', url: '/admin/categories', headers: auth(staff.token), payload })

    try {
      /* `icon: null` — «значок не трогать». Контракт объявляет поле
       * `nullable`, панель шлёт тело тем же типом, что читает, — а ручная
       * копия схемы в обработчике объявляла `icon` строкой. Отказа при этом
       * не было: AJV с `coerceTypes` превращал `null` в пустую строку, и
       * значок стирался молча — правка названия съедала картинку. */
      const saved = await put({ categories: [{ id: CAT2, title: `Медовый ${RUN}`, icon: null, sort: before.sort }] })
      expect(saved.statusCode, saved.body.slice(0, 200)).toBe(200)
      const written = saved.json() as { categories: number; synonyms: number; version: string }
      // Версия — новое поле ответа (фича 004); её смысл проверяет audit27.
      expect({ categories: written.categories, synonyms: written.synonyms }).toEqual({ categories: 1, synonyms: 0 })
      expect(written.version).toMatch(/^[0-9a-f]{16}$/)

      const now = (await readCategories(staff.token)).categories.find((c) => c.id === CAT2)!
      expect(now.title).toBe(`Медовый ${RUN}`)
      expect(now.icon).toBe(before.icon)

      const { rows } = await app.db!.query<{ diff: Record<string, unknown> }>(
        "select diff from audit_log where actor_id = $1 and action = 'categories.update'",
        [staff.userId],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.diff).toEqual({ categories: 1, synonyms: 0 })
    } finally {
      // Справочник общий: возвращаем как было.
      await put({
        categories: [
          before.icon === null
            ? { id: CAT2, title: before.title, sort: before.sort }
            : { id: CAT2, title: before.title, icon: before.icon, sort: before.sort },
        ],
      })
    }
  })
})
