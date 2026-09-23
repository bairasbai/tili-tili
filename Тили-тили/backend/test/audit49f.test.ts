/*
 * Ревью 016, FL-6 — F-RL7-01 + F-RL7-02 / ERR-0276 / R-276: `decodeCursor`
 * (`src/pagination.ts:85-103` at e67ffcf) проверял курсор по времени только
 * по форме ISO — `Date.parse` принимает 30 февраля и год 0000, а
 * `'…'::timestamptz` в PostgreSQL 16 на них падает ошибкой приведения, то
 * есть 500 с записью в журнал как об аварии (класс ERR-0221). Целочисленные
 * ключи каталога (`popular` → `::int`, `price_asc`/`price_desc` → `::bigint`)
 * проверялись только регэкспом «цифры», без проверки диапазона колонки —
 * число за пределами типа тоже роняет запрос в 500 (TR-1 §3.3, `RL-7-repro.log`
 * A ×4, `RL-7-probes.log` — ошибка приведения PG; findings\TR-1.md §7 FL-6).
 *
 * A-сценарий (курсор по времени, три подделки + одна на очереди модерации,
 * тот же `decodeCursor`): 30 февраля, год 0000, 31 апреля — календарная
 * форма ISO проходит, база — нет. B-сценарий (целочисленный курсор каталога, три
 * подделки — по одной на sort): число вне диапазона колонки, к которой его
 * приводит SQL. Обе группы — 400 `bad_cursor`, не 500, и без строки уровня
 * error в логе (`app.ts:236` — до неё код теперь не доходит: `AppError`
 * перехватывается веткой `error instanceof AppError` раньше generic-ветки).
 *
 * `24:00:00Z` — законная запись PostgreSQL для полуночи конца суток, курсор
 * с ней должен продолжать приниматься (не регрессия). Настоящий курсор
 * второй страницы очереди модерации и каталога должен продолжать листать
 * как прежде.
 *
 * Раунд правки 1 (`findings\FL-6.G5.md` F-G5-02/03, `findings\FL-6.G6.md`
 * §8 S3): третья подделка А-сценария была часом 25 (`…T25:00:00Z`) — тот
 * уже давал `Date.parse` → `NaN` и отвечал 400 ещё на HEAD, ничего не
 * воспроизводя; заменена на 31 апреля из `RL-7-repro.log` A (`…T00:00:00Z`,
 * 500 на HEAD, красный на HEAD перепроверен этим раундом). Отдельно найдена
 * и закрыта тем же классом дыра: смещение пояса шире ±16:00 (`Date.parse`
 * принимает вплоть до ±23:59, PostgreSQL 16 — только до ±15:59) проходило
 * первый раунд фикса непроверенным.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'
import { encodeCursor } from '../src/pagination.js'
import { uuidv7 } from '../src/ids.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/** Три подделки А-сценария (курсор по времени): форма ISO верна, календарь — нет. */
const FORGED_FEB30 = '2026-02-30T10:00:00Z'
const FORGED_YEAR0 = '0000-01-01T00:00:00Z'
/**
 * 31 апреля — в апреле 30 дней; `Date.parse` молча переносит на 1 мая
 * вместо `NaN` (красный на HEAD: `findings\RL-7-repro.log` A, `findings\
 * RL-7\repro.mts:109`). Раунд правки 1 (`findings\FL-6.G5.md` F-G5-02)
 * заменяет прежний `FORGED_HOUR25` (`…T25:00:00Z`): час 25 форму ISO
 * проходит по счёту цифр, но `Date.parse` на нём уже даёт `NaN`, и на HEAD
 * такой курсор отвечал 400 — находку не воспроизводил.
 */
const FORGED_APR31 = '2026-04-31T12:00:00.000Z'
/** Законная запись PostgreSQL (полночь конца суток) — не регрессия. */
const REAL_HOUR24 = '2026-06-15T24:00:00Z'
/**
 * Смещение пояса шире ±16:00: `Date.parse` принимает вплоть до ±23:59,
 * PostgreSQL 16 — только до ±15:59 («смещение часового пояса вне
 * диапазона», проверено прямым запросом к базе этим раундом). Раунд правки
 * 1 (`findings\FL-6.G6.md` §8 S3) — дыра того же класса ERR-0221/ERR-0276,
 * не закрытая первым раундом фикса.
 */
const FORGED_TZ_OFFSET = '2026-06-15T10:00:00+16:00'

describe.skipIf(!live)('FL-6 / ERR-0276 / R-276: подделанный курсор — 400 bad_cursor, не 500', () => {
  let app: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс лейна FL-6 (conductor ruling, GATELOG
   * line 50 + ARB-1 §C4 data-safety rules): "490600" — не производный от
   * вывода psql.exe, отличается от FL-01 (490100) и FL-18/p,q,r (491801,
   * 491802, 491803).
   */
  const RUN = '490600'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []
  let errorSpy: ReturnType<typeof vi.spyOn>

  async function staleCount(): Promise<number> {
    const { rows: u } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from users where phone like '+79' || $1 || '%'",
      [RUN],
    )
    const { rows: o } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from otp_codes where phone like '+79' || $1 || '%'",
      [RUN],
    )
    return Number(u[0]?.n ?? 0) + Number(o[0]?.n ?? 0)
  }

  async function eraseByPrefix(): Promise<void> {
    const { rows } = await app.db!.query<{ id: string }>(
      "select id from users where phone like '+79' || $1 || '%'",
      [RUN],
    )
    for (const row of rows) {
      await app.db!.tx((client) => eraseUser(client, row.id))
    }
    await app.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
  }

  beforeAll(async () => {
    app = await buildApp(
      {
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        policyVersion: '2026-09-02',
        otpMaxPerHourTotal: 1_000_000,
        otpMaxPerIpHour: 1_000_000,
      },
      [],
    )
    await app.ready()
    // Защитная предочистка: чужого не трогает, только строки этого префикса.
    if ((await staleCount()) > 0) await eraseByPrefix()
    // Уровень error (pino level 50) в тестовом окружении не пишется никуда
    // (`app.ts`: `logger: config.env === 'test' ? false : {...}`) — шпион
    // на сам метод объекта `app.log` ловит вызов независимо от того, пишет
    // ли реализация под ним куда-нибудь физически.
    errorSpy = vi.spyOn(app.log, 'error')
  })

  afterAll(async () => {
    for (const id of createdUserIds) {
      await app.db!.tx((client) => eraseUser(client, id))
    }
    if ((await staleCount()) > 0) await eraseByPrefix()
    const left = await staleCount()
    await app?.close()
    if (left > 0) throw new Error(`FL-6/audit49f: остались фикстуры префикса ${RUN}: ${left}`)
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1',
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
    createdUserIds.push(user.id)
    return { token: accessToken, id: user.id }
  }

  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.id])
    return user
  }

  async function newVendor(token: string, name: string): Promise<string> {
    const created = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(token),
      payload: {
        name,
        categoryId: 'decor',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode, created.body).toBe(200)
    const published = await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(token) })
    expect(published.statusCode, published.body).toBe(200)
    return created.json().id as string
  }

  it('три подделанных курсора по времени на ленте отзывов подрядчика — 400 bad_cursor, не 500', async () => {
    const vendorId = await newVendor(await (await newUser()).token, `Курсор-время-${RUN}`)
    const reader = (await newUser()).token
    errorSpy.mockClear()

    for (const forged of [FORGED_FEB30, FORGED_YEAR0, FORGED_APR31]) {
      const cursor = encodeCursor(forged, uuidv7())
      const res = await app.inject({
        method: 'GET',
        url: `/catalog/vendors/${vendorId}/reviews?cursor=${cursor}`,
        headers: auth(reader),
      })
      expect(res.statusCode, `${forged}: ${res.body}`).toBe(400)
      expect(res.json().error.code, forged).toBe('bad_cursor')
    }
    expect(errorSpy, 'уровень error (50) не должен писаться для отклонённого курсора').not.toHaveBeenCalled()
  })

  it('тот же подделанный курсор по времени на очереди модерации — 400 bad_cursor, не 500', async () => {
    const staff = await newStaff()
    errorSpy.mockClear()

    const cursor = encodeCursor(FORGED_FEB30, uuidv7())
    const res = await app.inject({
      method: 'GET',
      url: `/admin/moderation/vendors?cursor=${cursor}`,
      headers: auth(staff.token),
    })
    expect(res.statusCode, res.body).toBe(400)
    expect(res.json().error.code).toBe('bad_cursor')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('курсор по времени со смещением пояса вне диапазона PostgreSQL — 400 bad_cursor, не 500', async () => {
    const vendorId = await newVendor(await (await newUser()).token, `Курсор-пояс-${RUN}`)
    const reader = (await newUser()).token
    errorSpy.mockClear()

    const cursor = encodeCursor(FORGED_TZ_OFFSET, uuidv7())
    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendorId}/reviews?cursor=${cursor}`,
      headers: auth(reader),
    })
    expect(res.statusCode, `${FORGED_TZ_OFFSET}: ${res.body}`).toBe(400)
    expect(res.json().error.code).toBe('bad_cursor')
    expect(errorSpy, 'уровень error (50) не должен писаться для отклонённого курсора').not.toHaveBeenCalled()
  })

  it('три целочисленных курсора каталога за пределами колонки — 400 bad_cursor, не 500', async () => {
    const reader = (await newUser()).token
    errorSpy.mockClear()

    const cases: Array<{ sort: 'popular' | 'price_asc' | 'price_desc'; key: string }> = [
      { sort: 'popular', key: '9999999999' }, // > int32 max (2 147 483 647)
      { sort: 'price_asc', key: '99999999999999999999' }, // > bigint max
      { sort: 'price_desc', key: '-99999999999999999999' }, // < bigint min
    ]
    for (const { sort, key } of cases) {
      const cursor = encodeCursor(`${sort}|0|${key}`, uuidv7())
      const res = await app.inject({
        method: 'GET',
        url: `/catalog/vendors?sort=${sort}&cursor=${cursor}`,
        headers: auth(reader),
      })
      expect(res.statusCode, `${sort}=${key}: ${res.body}`).toBe(400)
      expect(res.json().error.code, sort).toBe('bad_cursor')
    }
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('24:00:00Z — законная запись PostgreSQL, курсор всё ещё принимается (не регрессия)', async () => {
    const vendorId = await newVendor(await (await newUser()).token, `Курсор-полночь-${RUN}`)
    const reader = (await newUser()).token
    const cursor = encodeCursor(REAL_HOUR24, uuidv7())
    const res = await app.inject({
      method: 'GET',
      url: `/catalog/vendors/${vendorId}/reviews?cursor=${cursor}`,
      headers: auth(reader),
    })
    expect(res.statusCode, res.body).toBe(200)
  })

  it('настоящий курсор по времени на очереди модерации — тоже листает (не регрессия)', async () => {
    // Раунд правки 1 (findings\FL-6.G5.md F-G5-01): закрывает акцептанс
    // TR-1 «a valid ISO cursor from a real page still pages» для курсора
    // ПО ВРЕМЕНИ — до этого теста ветка `hour < 24 → true` в isRealTimestamp
    // не исполнялась ни разу ни в одном тесте лейна (0 hits, coverage).
    const staff = await newStaff()
    const owner1 = (await newUser()).token
    const owner2 = (await newUser()).token
    await newVendor(owner1, `Курсор-модерация-${RUN} 1`)
    await newVendor(owner2, `Курсор-модерация-${RUN} 2`)

    const page1 = await app.inject({
      method: 'GET',
      url: '/admin/moderation/vendors?limit=1',
      headers: auth(staff.token),
    })
    expect(page1.statusCode, page1.body).toBe(200)
    const body1 = page1.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(body1.items).toHaveLength(1)
    expect(body1.nextCursor, 'в очереди минимум две анкеты — курсор обязан быть').not.toBeNull()

    const page2 = await app.inject({
      method: 'GET',
      url: `/admin/moderation/vendors?limit=1&cursor=${body1.nextCursor}`,
      headers: auth(staff.token),
    })
    expect(page2.statusCode, page2.body).toBe(200)
    const body2 = page2.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(body2.items).toHaveLength(1)
    expect(body2.items[0]!.id).not.toBe(body1.items[0]!.id)
  })

  it('настоящий курсор второй страницы каталога всё ещё листает', async () => {
    const owner = (await newUser()).token
    const q = `Курсор-лист-${RUN}`
    const v1 = await newVendor(owner, `${q} 1`)
    const v2Token = (await newUser()).token
    const v2 = await newVendor(v2Token, `${q} 2`)
    const reader = (await newUser()).token

    const page1 = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?sort=popular&limit=1&q=${encodeURIComponent(q)}`,
      headers: auth(reader),
    })
    expect(page1.statusCode, page1.body).toBe(200)
    const body1 = page1.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(body1.items).toHaveLength(1)
    expect(body1.nextCursor, 'первая страница из двух должна нести курсор').not.toBeNull()

    const page2 = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?sort=popular&limit=1&q=${encodeURIComponent(q)}&cursor=${body1.nextCursor}`,
      headers: auth(reader),
    })
    expect(page2.statusCode, page2.body).toBe(200)
    const body2 = page2.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(body2.items).toHaveLength(1)
    expect(body2.items[0]!.id).not.toBe(body1.items[0]!.id)
    expect([v1, v2]).toContain(body1.items[0]!.id)
    expect([v1, v2]).toContain(body2.items[0]!.id)

    // `sort=rating` (по умолчанию контракта) — тот же курсор-round-trip, но
    // ключ идёт через `keyInRange`'s `rating`-ветку (диапазон не сужается,
    // `key.cast` = `::numeric`), а не через `popular`/`price_*`.
    const ratingPage1 = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?sort=rating&limit=1&q=${encodeURIComponent(q)}`,
      headers: auth(reader),
    })
    expect(ratingPage1.statusCode, ratingPage1.body).toBe(200)
    const ratingBody1 = ratingPage1.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(ratingBody1.items).toHaveLength(1)
    expect(ratingBody1.nextCursor).not.toBeNull()

    const ratingPage2 = await app.inject({
      method: 'GET',
      url: `/catalog/vendors?sort=rating&limit=1&q=${encodeURIComponent(q)}&cursor=${ratingBody1.nextCursor}`,
      headers: auth(reader),
    })
    expect(ratingPage2.statusCode, ratingPage2.body).toBe(200)
    const ratingBody2 = ratingPage2.json() as { items: Array<{ id: string }>; nextCursor: string | null }
    expect(ratingBody2.items).toHaveLength(1)
    expect(ratingBody2.items[0]!.id).not.toBe(ratingBody1.items[0]!.id)
  })
})
