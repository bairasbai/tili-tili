import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { uuidv7 } from '../src/ids.js'

/**
 * Админка платформы (фича tasks/фичи/001-админка) — регрессии ревью 2026-09-07.
 *
 * Ревью нашло семь дефектов, и все они об одном: решение модератора
 * принимается по строке, состояние которой никто не спросил.
 *
 * `approve` по снятой анкете писал «проверена» и слал подрядчику новость об
 * этом, публикацию при этом не возвращая; второй `reject` подряд слал вторую
 * новость о том же; счётчик очереди на дашборде считал не то, что показывает
 * сама очередь; падение уведомления отменяло ответ, но не решение.
 *
 * Каждый набор здесь краснел до своего исправления — проверено прогоном
 * до правки обработчика.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('админка: решения принимаются по живой анкете', () => {
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
    return { ...user, vendorId: created.json().id as string }
  }

  async function newWedding() {
    const user = await newUser()
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })
    expect(w.statusCode, w.body.slice(0, 200)).toBe(201)
    return { ...user, weddingId: w.json().id as string }
  }

  const vendorRow = async (vendorId: string) =>
    (
      await app.db!.query<{
        published_at: Date | null
        moderated_at: Date | null
        verified_at: Date | null
        downranked_at: Date | null
        blocked_at: Date | null
        views: number
      }>(
        `select published_at, moderated_at, verified_at, downranked_at, blocked_at, views
           from vendors where id = $1`,
        [vendorId],
      )
    ).rows[0]!

  /** Уведомления одного человека — свежие сверху. */
  const notesOf = async (userId: string) =>
    (
      await app.db!.query<{ kind: string; title: string; body: string }>(
        'select kind, title, body from notifications where user_id = $1 order by created_at desc',
        [userId],
      )
    ).rows

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

  const metrics = async (token: string) => {
    const res = await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as { moderationQueue: number }
  }

  const putCategories = (token: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/admin/categories', headers: auth(token), payload })

  /**
   * Инъекция сбоя: временный триггер роняет запись, попадающую под условие.
   * Имя уникально на прогон, условие — по получателю, поэтому соседние наборы,
   * идущие параллельно, его не замечают. Снимается в finally.
   */
  async function withNotifyFault(userId: string, fn: () => Promise<void>): Promise<void> {
    const name = `audit24_fault_${RUN}_${++counter}`
    await app.db!.query(
      `create function ${name}() returns trigger language plpgsql as $$
         begin
           if new.user_id = '${userId}' then raise exception 'fault injected by audit24'; end if;
           return new;
         end $$`,
    )
    await app.db!.query(
      `create trigger ${name} before insert on notifications for each row execute function ${name}()`,
    )
    try {
      await fn()
    } finally {
      await app.db!.query(`drop trigger if exists ${name} on notifications`)
      await app.db!.query(`drop function if exists ${name}()`)
    }
  }

  /* ── A-01: счётчик очереди и сама очередь ─────────────────────────── */
  it('счётчик очереди на дашборде считает ровно то, что показывает очередь', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Заблокированная по жалобе')
    const reporter = await newUser()
    const complaintId = await complain(reporter, 'vendor', vendor.vendorId, 'fraud')
    expect((await decideComplaint(staff.token, complaintId, { action: 'block' })).statusCode).toBe(200)

    // Анкета заблокирована и при этом ни разу не проверена модератором:
    // ровно тот набор, который счётчик считал, а очередь — нет.
    const row = await vendorRow(vendor.vendorId)
    expect(row.blocked_at).not.toBeNull()
    expect(row.moderated_at).toBeNull()

    const queueSize = async () =>
      Number(
        (
          await app.db!.query<{ n: string }>(
            `select count(*)::text as n from vendors v
               join users u on u.id = v.user_id and u.deleted_at is null
              where v.moderated_at is null and v.published_at is not null and v.blocked_at is null`,
          )
        ).rows[0]!.n,
      )

    /* База общая, соседние наборы заводят анкеты параллельно — поэтому
     * счётчик зажимается между двумя замерами очереди, а не сравнивается
     * с одним. До фикса он был больше обоих: считал и заблокированных,
     * и анкеты ушедших пользователей. */
    const before = await queueSize()
    const shown = (await metrics(staff.token)).moderationQueue
    const after = await queueSize()
    expect(shown).toBeGreaterThanOrEqual(Math.min(before, after))
    expect(shown).toBeLessThanOrEqual(Math.max(before, after))
  })

  /* ── A-02: решение только по живой анкете ─────────────────────────── */
  it('по заблокированной анкете решение не принимается', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Уже заблокированная')
    await app.db!.query('update vendors set blocked_at = now() where id = $1', [vendor.vendorId])

    for (const payload of [
      { action: 'approve' },
      { action: 'verify' },
      { action: 'reject', reason: `Причина ${RUN}` },
    ]) {
      const res = await decideVendor(staff.token, vendor.vendorId, payload)
      expect({ payload, code: res.statusCode }).toEqual({ payload, code: 409 })
      expect(res.json().error.code).toBe('vendor_not_live')
      // Сообщение по случаю: блокировку снимают не отсюда.
      expect(res.json().error.message).toContain('заблокирована')
    }

    /* Проверка по базе, а не по ответу экрана: до фикса `approve` писал
     * «проверена», публикацию не возвращал и слал подрядчику новость
     * о проверке анкеты, которой в каталоге нет. */
    const row = await vendorRow(vendor.vendorId)
    expect(row.published_at).not.toBeNull()
    expect(row.moderated_at).toBeNull()
    expect(row.verified_at).toBeNull()
    expect(await notesOf(vendor.userId)).toEqual([])
  })

  it('по снятой с публикации анкете решение не принимается', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Уже снятая')
    await app.db!.query('update vendors set published_at = null where id = $1', [vendor.vendorId])

    const approve = await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })
    expect(approve.statusCode, approve.body.slice(0, 200)).toBe(409)
    expect(approve.json().error.code).toBe('vendor_not_live')
    // Одобрять нечего: в каталоге анкеты нет, и одобрение её туда не вернёт.
    expect(approve.json().error.message).toContain('не опубликована')

    const reject = await decideVendor(staff.token, vendor.vendorId, { action: 'reject', reason: `Ещё раз ${RUN}` })
    expect(reject.statusCode, reject.body.slice(0, 200)).toBe(409)
    expect(reject.json().error.code).toBe('vendor_not_live')
    expect(reject.json().error.message).toContain('снята')

    const row = await vendorRow(vendor.vendorId)
    expect(row.published_at).toBeNull()
    expect(row.moderated_at).toBeNull()
    expect(await notesOf(vendor.userId)).toEqual([])
  })

  it('второй модератор с тем же решением опаздывает: 409 и одно уведомление', async () => {
    const staff = await newStaff()
    const second = await newStaff()
    const vendor = await newVendor('Снимаемая дважды')
    const reason = `Фото не свои ${RUN}`

    const first = await decideVendor(staff.token, vendor.vendorId, { action: 'reject', reason })
    expect(first.statusCode, first.body.slice(0, 200)).toBe(200)

    const again = await decideVendor(second.token, vendor.vendorId, { action: 'reject', reason })
    expect(again.statusCode, again.body.slice(0, 200)).toBe(409)
    expect(again.json().error.code).toBe('vendor_not_live')

    /* Новость о снятии с публикации приходит один раз: второе решение по той
     * же анкете — это не второе нарушение, а опоздавший сотрудник. */
    const notes = (await notesOf(vendor.userId)).filter((n) => n.title === 'Анкета снята с публикации')
    expect(notes).toHaveLength(1)
  })

  it('повторное одобрение живой анкеты остаётся 200', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Одобряемая дважды')

    expect((await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })).statusCode).toBe(200)
    // Проверка живой анкеты — действие идемпотентное: 409 здесь означал бы,
    // что второй модератор не может подтвердить то же самое решение.
    const twice = await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })
    expect(twice.statusCode, twice.body.slice(0, 200)).toBe(200)

    const row = await vendorRow(vendor.vendorId)
    expect(row.published_at).not.toBeNull()
    expect(row.moderated_at).not.toBeNull()
  })

  /* ── A-12: ветки 404 ──────────────────────────────────────────────── */
  it('решение по несуществующей анкете — 404', async () => {
    const staff = await newStaff()
    const res = await decideVendor(staff.token, uuidv7(), { action: 'approve' })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(404)
    expect(res.json().error.code).toBe('not_found')
  })

  it('второе решение по разобранной жалобе — 404, и первое не переписано', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Наказанная однажды')
    const reporter = await newUser()
    const id = await complain(reporter, 'vendor', vendor.vendorId, 'spam')

    expect((await decideComplaint(staff.token, id, { action: 'warn' })).statusCode).toBe(200)

    const again = await decideComplaint(staff.token, id, { action: 'block' })
    expect(again.statusCode, again.body.slice(0, 200)).toBe(404)
    expect(again.json().error.code).toBe('not_found')
    // Решение первого модератора остаётся тем, каким он его принял.
    expect(await complaintRow(id)).toEqual({ status: 'resolved', resolution: 'warn' })
    // И санкция второго не применена: анкета осталась в каталоге.
    expect((await vendorRow(vendor.vendorId)).blocked_at).toBeNull()
  })

  /* ── A-14: уведомление после фиксации решения ─────────────────────── */
  it('сбой уведомления не отменяет уже принятого решения по анкете', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Без новости')
    let code = 0

    await withNotifyFault(vendor.userId, async () => {
      code = (await decideVendor(staff.token, vendor.vendorId, { action: 'approve' })).statusCode
    })

    /* Решение записано, а новость — нет: 500 здесь означал бы «не принято»,
     * и модератор одобрил бы анкету второй раз поверх уже одобренной. */
    expect(code).toBe(200)
    expect((await vendorRow(vendor.vendorId)).moderated_at).not.toBeNull()
    expect(await notesOf(vendor.userId)).toEqual([])
    // Сервер жив, а не упал вместе с обработчиком.
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200)
  })

  it('сбой уведомления не отменяет уже наложенной санкции', async () => {
    const staff = await newStaff()
    const vendor = await newVendor('Понижённая молча')
    const reporter = await newUser()
    const id = await complain(reporter, 'vendor', vendor.vendorId, 'content')
    let code = 0

    await withNotifyFault(vendor.userId, async () => {
      code = (await decideComplaint(staff.token, id, { action: 'downrank' })).statusCode
    })

    expect(code).toBe(200)
    expect((await vendorRow(vendor.vendorId)).downranked_at).not.toBeNull()
    expect(await complaintRow(id)).toEqual({ status: 'resolved', resolution: 'downrank' })
    expect(await notesOf(vendor.userId)).toEqual([])
  })

  /* ── A-04: идентификатор категории ────────────────────────────────── */
  it('идентификатор категории — строчная латиница, цифры, дефис и подчёркивание', async () => {
    const staff = await newStaff()

    for (const id of ['', 'PHOTO']) {
      const res = await putCategories(staff.token, {
        categories: [{ id, title: `Проверка ${RUN}` }],
        /* Слово на несуществующую категорию — страховка на случай, когда
         * схема идентификатор пропускает: обработчик тогда сорвётся на
         * словаре, транзакция откатится, и мусорная строка не осядет
         * в общем справочнике. Отличить один отказ от другого можно
         * по имени поля. */
        synonyms: { [`страховка${RUN}`]: `нет-такой-${RUN}` },
      })
      expect({ id, code: res.statusCode }).toEqual({ id, code: 422 })
      expect(res.json().error.code).toBe('validation_failed')
      // Поле называет именно идентификатор, а не слово словаря: значит,
      // запрос отвергнут схемой и до обработчика не дошёл.
      expect(res.json().error.fields['categories/0/id']).toBeTruthy()
    }

    const { rows } = await app.db!.query('select 1 from categories where id = $1 or id = $2', ['', 'PHOTO'])
    expect(rows).toHaveLength(0)
  })

  /* ── A-05: словарь и регистр ──────────────────────────────────────── */
  it('два слова словаря, различающиеся регистром, — ошибка проверки, а не падение', async () => {
    const staff = await newStaff()
    const word = `Тамада${RUN}`

    /* Слово хранится в нижнем регистре, и «Тамада» с «тамада» — одна строка
     * словаря. До фикса вторая вставка падала на первичном ключе: 500
     * «внутренняя ошибка» вместо ошибки проверки, а словарь к этому моменту
     * был уже стёрт целиком — спасал только откат транзакции. */
    const res = await putCategories(staff.token, { synonyms: { [word]: 'host', [word.toLowerCase()]: 'host' } })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(422)
    expect(res.json().error.code).toBe('validation_failed')
    // Поле называет само слово: форма подсветит именно ту строку словаря.
    expect(res.json().error.fields[`synonyms.${word}`]).toBeTruthy()

    const { rows } = await app.db!.query('select 1 from category_synonyms where word = $1', [word.toLowerCase()])
    expect(rows).toHaveLength(0)
  })

  /* ── A-03: пишущие пути закрыты для постороннего ──────────────────── */
  it('все пути админки закрыты для обычного пользователя, и следа в базе нет', async () => {
    const stranger = await newUser()
    const staff = await newStaff()
    const vendor = await newVendor('Неприкосновенная')
    const reporter = await newUser()
    const complaintId = await complain(reporter, 'vendor', vendor.vendorId, 'spam')
    const wedding = await newWedding()
    const before = await vendorRow(vendor.vendorId)
    const photoTitle = async () =>
      (await app.db!.query<{ name: string }>('select name from categories where id = $1', ['photo'])).rows[0]!.name
    const titleBefore = await photoTitle()
    const synonymsBefore = Number(
      (await app.db!.query<{ n: string }>('select count(*)::text as n from category_synonyms')).rows[0]!.n,
    )

    /* Восемь операций раздела — все, а не только чтение: 403 у списка ничего
     * не говорит про кнопку «Снять с публикации» рядом с ним. */
    const calls: { method: 'GET' | 'PUT' | 'POST'; url: string; payload?: unknown }[] = [
      { method: 'GET', url: '/admin/metrics' },
      { method: 'GET', url: '/admin/categories' },
      { method: 'PUT', url: '/admin/categories', payload: { categories: [{ id: 'photo', title: `Взлом ${RUN}` }] } },
      { method: 'GET', url: '/admin/moderation/vendors' },
      {
        method: 'POST',
        url: `/admin/moderation/vendors/${vendor.vendorId}`,
        payload: { action: 'reject', reason: `Взлом ${RUN}` },
      },
      { method: 'GET', url: '/admin/complaints' },
      { method: 'POST', url: `/admin/complaints/${complaintId}`, payload: { action: 'block' } },
      {
        method: 'GET',
        url: `/admin/weddings/${wedding.weddingId}?reason=${encodeURIComponent('любопытство')}`,
      },
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
    expect(await vendorRow(vendor.vendorId)).toEqual(before)
    expect(await complaintRow(complaintId)).toEqual({ status: 'new', resolution: null })
    expect(await photoTitle()).toBe(titleBefore)
    expect(
      Number((await app.db!.query<{ n: string }>('select count(*)::text as n from category_synonyms')).rows[0]!.n),
    ).toBe(synonymsBefore)
    /* Записи о самом входе и согласии у обычного человека есть — журнал
     * пишет не только админка. Смотрим на действия раздела: ни одного. */
    const { rows: log } = await app.db!.query<{ action: string }>(
      `select action from audit_log
        where actor_id = $1
          and (action like 'complaint.%' or action = 'categories.update' or action = 'wedding.view'
               or action in ('vendor.approve', 'vendor.reject', 'vendor.verify'))`,
      [stranger.userId],
    )
    expect(log).toEqual([])
    // Сотрудник тем же путём проходит — раздел закрыт, а не сломан.
    expect((await app.inject({ method: 'GET', url: '/admin/metrics', headers: auth(staff.token) })).statusCode).toBe(200)
  })

  /* ── A-08: просмотр модератором не считается воронкой ─────────────── */
  it('просмотр карточки сотрудником не поднимает счётчик просмотров', async () => {
    const vendor = await newVendor('Просматриваемая')
    const staff = await newStaff()
    const guestOfCatalog = await newUser()
    const views = async () => (await vendorRow(vendor.vendorId)).views
    const before = await views()

    /* Первая ступень воронки в кабинете подрядчика — это интерес пары.
     * Модератор, открывший карточку по жалобе, интересом не является. */
    for (let i = 0; i < 2; i++) {
      const seen = await app.inject({
        method: 'GET',
        url: `/catalog/vendors/${vendor.vendorId}`,
        headers: auth(staff.token),
      })
      expect(seen.statusCode, seen.body.slice(0, 200)).toBe(200)
    }
    expect(await views()).toBe(before)

    const opened = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendor.vendorId}`,
      headers: auth(guestOfCatalog.token),
    })
    expect(opened.statusCode, opened.body.slice(0, 200)).toBe(200)
    // Обычный просмотр считается по-прежнему — иначе воронка обнулилась бы.
    expect(await views()).toBe(before + 1)
  })
})
