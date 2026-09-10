import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Версия справочника категорий (фича tasks/фичи/004-версия-справочника).
 *
 * `PUT /admin/categories` заменяет справочник и словарь ЦЕЛИКОМ. Двое
 * сотрудников, открывших экран одновременно, затирали правки друг друга
 * молча: выигрывал тот, кто сохранил последним, и второй об этом не узнавал
 * (ревью фичи 001, A-09). Диалог предупреждал, что словарь заменится целиком,
 * но не о том, что он заменится поверх чужого.
 *
 * Версия — отпечаток СОДЕРЖИМОГО, а не счётчик сохранений: правка мимо
 * панели (владелец или разработчик прямо в базе) тоже меняет его, и панель
 * это увидит. Отсюда проверка «правка напрямую в базе меняет версию».
 *
 * База общая с соседними наборами (R-177). Свою категорию тесты берут одну
 * и возвращают её в `finally`; новых не заводят — их ровно 35 (stage3).
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

/**
 * Категория, которую правят эти тесты.
 *
 * Не `vykup` и не `honeymoon`: их занял audit23, а файлы идут параллельно
 * по одной базе — два набора, правящие одну строку, мешали бы друг другу
 * не своей проверкой, а совпадением имени.
 */
const CAT = 'rings'

/** Шестнадцать шестнадцатеричных знаков — ровно то, что объявляет контракт. */
const VERSION = /^[0-9a-f]{16}$/

interface AdminCategory {
  id: string
  title: string
  icon: string | null
  sort: number
}

interface Catalog {
  categories: AdminCategory[]
  synonyms: Record<string, string>
  version: string
}

interface Saved {
  categories: number
  synonyms: number
  version: string
}

describe.skipIf(!live)('админка: версия справочника категорий', () => {
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
    return { token: body.accessToken, userId: body.user.id }
  }

  /** Права сотрудника ставятся руками в базе при найме — пути для этого нет и не будет. */
  async function newStaff() {
    const user = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [user.userId])
    return user
  }

  const readCategories = async (token: string): Promise<Catalog> => {
    const res = await app.inject({ method: 'GET', url: '/admin/categories', headers: auth(token) })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    return res.json() as Catalog
  }

  /** Статуса не проверяет: половине проверок нужен именно отказ. */
  const put = (token: string, payload: unknown) =>
    app.inject({ method: 'PUT', url: '/admin/categories', headers: auth(token), payload })

  const pick = async (token: string) => (await readCategories(token)).categories.find((c) => c.id === CAT)!

  /**
   * Записи журнала этого сотрудника.
   *
   * Считаем по актору, а не по действию: соседние наборы правят справочник
   * параллельно, и общий счётчик `categories.update` показывал бы их работу.
   */
  const logCount = async (userId: string) =>
    Number(
      (
        await app.db!.query<{ n: string }>('select count(*)::text as n from audit_log where actor_id = $1', [
          userId,
        ])
      ).rows[0]!.n,
    )

  /**
   * Вернуть категорию как было — прямо в базе.
   *
   * Через `PUT` пришлось бы сперва читать свежую версию, а восстановление
   * не должно зависеть от того, что именно сломалось в проверке.
   */
  const restore = (c: AdminCategory) =>
    app.db!.query('update categories set name = $1, icon = $2, sort = $3 where id = $4', [
      c.title,
      c.icon,
      c.sort,
      c.id,
    ])

  /* ── FR-001: справочник приходит с версией ────────────────────────── */
  it('чтение справочника отдаёт версию — отпечаток из шестнадцати знаков', async () => {
    const staff = await newStaff()
    const body = await readCategories(staff.token)
    expect(body.version).toMatch(VERSION)
  })

  /* ── FR-004: сохранение со своей версией проходит и даёт новую ────── */
  it('сохранение со своей версией проходит, и версия в ответе — уже новая', async () => {
    const staff = await newStaff()
    const before = await readCategories(staff.token)
    const cat = before.categories.find((c) => c.id === CAT)!
    expect(cat).toBeDefined()

    try {
      const res = await put(staff.token, {
        categories: [{ id: CAT, title: `Кольца ${RUN}`, sort: cat.sort }],
        version: before.version,
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      const saved = res.json() as Saved

      expect(saved.version).toMatch(VERSION)
      // Содержимое изменилось — значит, и отпечаток другой.
      expect(saved.version).not.toBe(before.version)
      /* Следующая правка начинается от неё, не перечитывая справочник:
       * иначе после каждого сохранения панель получала бы 409 на себя же. */
      expect((await readCategories(staff.token)).version).toBe(saved.version)
    } finally {
      await restore(cat)
    }
  })

  /* ── FR-002: сохранение поверх чужой правки отклоняется ───────────── */
  it('сохранение с устаревшей версией — 409 categories_stale, и не меняется ничего', async () => {
    const staff = await newStaff()
    const stale = await readCategories(staff.token)
    const cat = stale.categories.find((c) => c.id === CAT)!
    const foreign = `Кольца ${RUN} чужие`

    try {
      // Пока сотрудник правил экран, справочник изменил кто-то другой.
      await app.db!.query('update categories set name = $1 where id = $2', [foreign, CAT])
      const logsBefore = await logCount(staff.userId)

      const res = await put(staff.token, {
        categories: [{ id: CAT, title: `Кольца ${RUN} мои`, sort: cat.sort }],
        version: stale.version,
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(409)
      const error = res.json().error as { code: string; message: string }
      expect(error.code).toBe('categories_stale')
      // Отказ называет причину словами: экрану есть что показать человеку.
      expect(error.message).toContain('перечитайте')

      /* Главное: на сервере осталась чужая правка, а не моя. Молчаливое
       * затирание — это ровно то, ради чего фича заведена (SC-001). */
      expect((await pick(staff.token)).title).toBe(foreign)
      // Журнал тоже не тронут: отказ случился до записи, а не после.
      expect(await logCount(staff.userId)).toBe(logsBefore)
    } finally {
      await restore(cat)
    }
  })

  /* ── FR-006: сохранение без версии проходит без проверки ──────────── */
  it('сохранение без версии проходит — правило не ломает тех, кто о нём не знает', async () => {
    const staff = await newStaff()
    const cat = await pick(staff.token)

    try {
      // Справочник меняют мимо этого сотрудника, но версии он и не слал.
      await app.db!.query('update categories set name = $1 where id = $2', [`Кольца ${RUN} чужие`, CAT])

      const res = await put(staff.token, {
        categories: [{ id: CAT, title: `Кольца ${RUN} без версии`, sort: cat.sort }],
      })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
      // Версию отвечают всё равно: у неё нет причины зависеть от запроса.
      expect((res.json() as Saved).version).toMatch(VERSION)
      expect((await pick(staff.token)).title).toBe(`Кольца ${RUN} без версии`)
    } finally {
      await restore(cat)
    }
  })

  /* ── FR-005: версия отражает содержимое, а не факт сохранения ─────── */
  it('правка прямо в базе меняет версию — отпечаток считается по строкам', async () => {
    const staff = await newStaff()
    const before = await readCategories(staff.token)
    const cat = before.categories.find((c) => c.id === CAT)!

    try {
      /* Так справочник правит владелец или разработчик. Счётчик сохранений
       * и `updated_at` такой правки не заметили бы, и панель сохранила бы
       * поверх неё, ничего не заподозрив. */
      await app.db!.query('update categories set name = $1 where id = $2', [`Кольца ${RUN} мимо панели`, CAT])

      const after = await readCategories(staff.token)
      expect(after.version).toMatch(VERSION)
      expect(after.version).not.toBe(before.version)
    } finally {
      await restore(cat)
    }
  })

  it('правка словаря синонимов меняет версию так же, как правка категорий', async () => {
    const staff = await newStaff()
    const word = `версия${RUN}`
    const before = await readCategories(staff.token)

    try {
      await app.db!.query(
        `insert into category_synonyms (word, category_id) values ($1, 'photo')
         on conflict (word) do update set category_id = excluded.category_id`,
        [word],
      )
      const after = await readCategories(staff.token)
      expect(after.synonyms[word]).toBe('photo')
      /* Справочник и словарь — одно целое: `PUT` заменяет их вместе, значит
       * и отпечаток должен покрывать оба. Считай он одни категории, чужая
       * правка словаря затиралась бы молча по-прежнему. */
      expect(after.version).not.toBe(before.version)
    } finally {
      // Строка этого прогона — свою же и убираем, чужих не трогаем.
      await app.db!.query('delete from category_synonyms where word = $1', [word])
    }
  })

  /* ── пограничный случай спеки: сохранение без изменений ───────────── */
  it('сохранение, ничего не меняющее по содержанию, возвращает ту же версию', async () => {
    const staff = await newStaff()
    const before = await readCategories(staff.token)
    const cat = before.categories.find((c) => c.id === CAT)!
    expect(before.version).toMatch(VERSION)

    const res = await put(staff.token, {
      categories: [{ id: CAT, title: cat.title, sort: cat.sort }],
      version: before.version,
    })
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    const saved = res.json() as Saved
    /* Отпечаток считается по содержимому, а не по факту сохранения: пустая
     * правка не должна отправлять соседний экран перечитывать справочник. */
    expect(saved.version).toMatch(VERSION)
    expect(saved.version).toBe(before.version)
  })

  /* ── V-09: версия проверяется схемой, а не только сравнением ──────── */
  it('версия не той длины — 422, а не 409', async () => {
    const staff = await newStaff()
    const cat = await pick(staff.token)

    /* Схема обработчика объявляла `maxLength: 64` против шестнадцати в
     * контракте, и версия, которой сервер не выдавал никогда, доезжала до
     * сравнения отпечатков. Ответ приходил «справочник изменили, перечитайте
     * и повторите» — про чужую правку, которой не было: перечитывать и
     * повторять бессмысленно, потому что дело в самом запросе. */
    for (const version of ['0'.repeat(64), 'ЗАГОЛОВОК', 'ffffffffffffffffff', 'FFFFFFFFFFFFFFFF']) {
      const res = await put(staff.token, {
        categories: [{ id: CAT, title: cat.title, sort: cat.sort }],
        version,
      })
      expect({ version, code: res.statusCode }).toEqual({ version, code: 422 })
      expect(res.json().error.code).toBe('validation_failed')
    }

    // Правильная по форме, но чужая версия — по-прежнему 409: это другая беда.
    const stale = await put(staff.token, {
      categories: [{ id: CAT, title: cat.title, sort: cat.sort }],
      version: '0'.repeat(16),
    })
    expect(stale.statusCode, stale.body.slice(0, 200)).toBe(409)
    expect(stale.json().error.code).toBe('categories_stale')
  })

  /* ── V-12: у словаря есть пределы ─────────────────────────────────── */
  it('слово длиннее сорока знаков не принимается', async () => {
    const staff = await newStaff()
    // Слово этого прогона: чужая строка из соседнего набора не должна
    // выдавать себя за принятую здесь.
    const long = `с${'и'.repeat(40)}${RUN}`

    try {
      /* Словарь заменяется целиком и вставляется построчно под блокировкой
       * справочника: без пределов тело ограничивал только общий потолок
       * размера запроса, и «синоним» на абзац принимался наравне со словом. */
      const res = await put(staff.token, { synonyms: { [long]: 'photo' } })
      expect(res.statusCode, res.body.slice(0, 200)).toBe(422)
      expect(res.json().error.code).toBe('validation_failed')

      // Словарь при этом не тронут: отказ схемы случается до обработчика,
      // а обработчик стирает словарь целиком перед вставкой.
      const { rows } = await app.db!.query<{ n: string }>(
        'select count(*)::text as n from category_synonyms where word = $1',
        [long.toLowerCase()],
      )
      expect(Number(rows[0]!.n)).toBe(0)
    } finally {
      // Строка этого прогона — своя же, и убирается независимо от исхода:
      // иначе упавшая проверка оставляла бы её словарю навсегда.
      await app.db!.query('delete from category_synonyms where word = $1', [long.toLowerCase()])
    }
  })

  /* ── V-02: чтение берёт ту же блокировку, что и сохранение ────────── */
  it('чтение справочника ждёт чужую правку, а не читает половину', async () => {
    const staff = await newStaff()

    /* Уровень изоляции здесь READ COMMITTED: четыре запроса `GET` — это
     * четыре снимка. Чужое сохранение, успевшее между чтением строк и
     * подсчётом отпечатка, отдавало панели данные ДО правки вместе с
     * версией ПОСЛЕ неё — и следующее сохранение проверку проходило,
     * молча затирая чужую работу. Ловится это не гонкой, а тем, что
     * `GET` обязан взять ту же advisory-блокировку, что и `PUT`.
     *
     * Блокировку держит отдельная транзакция; `idle_in_transaction_session_timeout`
     * у пула — 10 с, поэтому держим доли секунды. */
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holding = app.db!.tx(async (client) => {
      await client.query('select pg_advisory_xact_lock($1::bigint)', [4_210_001])
      await held
    })

    const request = app.inject({ method: 'GET', url: '/admin/categories', headers: auth(staff.token) })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const raced = await Promise.race([
        Promise.resolve(request).then(() => 'ответил' as const),
        new Promise<'ждёт'>((resolve) => {
          timer = setTimeout(() => resolve('ждёт'), 500)
        }),
      ])
      expect(raced, 'GET обязан ждать блокировку справочника, как и PUT').toBe('ждёт')
    } finally {
      if (timer) clearTimeout(timer)
      release()
      await holding
    }

    // Дождавшись чужой транзакции, чтение отвечает как обычно.
    const res = await request
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200)
    expect((res.json() as Catalog).version).toMatch(VERSION)
  })

  /* ── пограничный случай спеки: два сохранения с одной версией ─────── */
  it('два сохранения подряд с одной версией — второе получает отказ', async () => {
    const staff = await newStaff()
    const before = await readCategories(staff.token)
    const cat = before.categories.find((c) => c.id === CAT)!

    try {
      const first = await put(staff.token, {
        categories: [{ id: CAT, title: `Кольца ${RUN} первый`, sort: cat.sort }],
        version: before.version,
      })
      expect(first.statusCode, first.body.slice(0, 200)).toBe(200)

      /* Второй экран открыл справочник тогда же и о первом сохранении не
       * знает. Без проверки он молча стёр бы чужую правку — и словарь
       * целиком вместе с ней. */
      const second = await put(staff.token, {
        categories: [{ id: CAT, title: `Кольца ${RUN} второй`, sort: cat.sort }],
        version: before.version,
      })
      expect(second.statusCode, second.body.slice(0, 200)).toBe(409)
      expect(second.json().error.code).toBe('categories_stale')

      expect((await pick(staff.token)).title).toBe(`Кольца ${RUN} первый`)
    } finally {
      await restore(cat)
    }
  })
})
