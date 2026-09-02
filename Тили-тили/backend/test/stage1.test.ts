import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode, normalizePhone, maskPhone } from '../src/auth/otp.js'
import { uuidv7, uuidv7Time } from '../src/ids.js'
import { normalizeQuery } from '../src/routes/geo.js'

/**
 * Проверки этапа 1 против настоящей базы. Идут только при TEST_DATABASE_URL —
 * см. integration.test.ts, там же объяснение, почему пропуск, а не падение.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 1: вход, согласие, профиль, гео', () => {
  let app: FastifyInstance
  let phoneCounter = 0

  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      // Общий потолок отправок проверяется отдельным тестом; здесь он не должен
      // мешать — база копит коды за час всех прогонов подряд.
      otpMaxPerHourTotal: 1_000_000,
      policyVersion: '2026-09-02',
    })
    await app.ready()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => {
    phoneCounter += 1
  })

  // База между прогонами не чистится, а лимит «5 кодов на номер в час» живёт
  // в ней. Номера из прошлого запуска упёрлись бы в лимит и вернули 429 —
  // поэтому у каждого прогона свой диапазон.
  const RUN = String(randomInt(100_000, 1_000_000))
  /** Свой номер на каждый тест. */
  // Свой адрес на каждый набор: ограничитель по адресу общий для процесса,
  // и без этого наборы отбирали бы друг у друга лимит.
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

  const nextPhone = () => `+79${RUN}${String(phoneCounter).padStart(3, '0')}`

  /** Код не приходит по SMS в тестах — берём его хеш-сравнением по базе. */
  async function readCode(phone: string): Promise<string> {
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    const hash = rows[0]!.code_hash
    for (let i = 0; i < 10000; i++) {
      const candidate = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, candidate) === hash) return candidate
    }
    throw new Error('код не подобрался — изменился алгоритм хеширования')
  }

  async function requestCode(phone: string) {
    return app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
  }

  async function signIn(phone: string, device = 'iPhone · Safari') {
    const asked = await requestCode(phone)
    // Иначе провал запроса кода превращается в невнятное «401 при проверке».
    expect(asked.statusCode).toBe(200)
    const code = await readCode(phone)
    const res = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code, device } })
    expect(res.statusCode).toBe(200)
    return res.json() as { accessToken: string; refreshToken: string; expiresIn: number; user: { id: string } }
  }

  /**
   * Сдвигает прошлые коды номера в прошлое. Пауза между отправками — настоящее
   * правило продукта, и обходить его в тесте нельзя; но и спать минуту незачем.
   */
  async function pretendMinutePassed(phone: string) {
    await app.db!.query(
      "update otp_codes set created_at = created_at - interval '2 minutes' where phone = $1",
      [phone],
    )
  }

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function consent(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(res.statusCode).toBe(201)
  }

  /* ── главный сценарий из «готово, когда» ──────────────────────────── */
  it('телефон → код → токены → refresh → выход со всех устройств', async () => {
    const phone = nextPhone()

    const first = await signIn(phone, 'iPhone · Safari')
    expect(first.expiresIn).toBe(900)
    expect(first.user.id).toMatch(/^[0-9a-f-]{36}$/)
    await consent(first.accessToken)

    // Второй вход с другого устройства — теперь сессий две.
    await pretendMinutePassed(phone)
    const second = await signIn(phone, 'MacBook · Chrome')
    expect(second.user.id).toBe(first.user.id)

    const list = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(second.accessToken) })
    expect(list.statusCode).toBe(200)
    const sessions = list.json() as { id: string; device: string; current: boolean }[]
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((s) => s.current)).toHaveLength(1)
    expect(sessions.map((s) => s.device)).toContain('iPhone · Safari')

    // Обновление токенов: refresh одноразовый, выдаётся новая пара.
    const refreshed = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: second.refreshToken },
    })
    expect(refreshed.statusCode).toBe(200)
    const next = refreshed.json() as { accessToken: string; refreshToken: string }
    expect(next.refreshToken).not.toBe(second.refreshToken)

    // Выход со всех устройств: остаётся текущая сессия.
    const bye = await app.inject({ method: 'DELETE', url: '/users/me/sessions', headers: auth(next.accessToken) })
    expect(bye.statusCode).toBe(204)

    const after = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(next.accessToken) })
    expect(after.json()).toHaveLength(1)

    // Токен выгнанного устройства больше не работает — сессия проверяется по базе.
    const kicked = await app.inject({ method: 'GET', url: '/users/me', headers: auth(first.accessToken) })
    expect(kicked.statusCode).toBe(401)
  })

  it('без согласия защищённый путь отвечает 403', async () => {
    const { accessToken } = await signIn(nextPhone())

    const profile = await app.inject({ method: 'GET', url: '/users/me', headers: auth(accessToken) })
    expect(profile.statusCode).toBe(403)
    expect(profile.json().error.code).toBe('forbidden')

    // 403, а не 401: человек вошёл. 401 отправил бы его на вход по кругу.
    await consent(accessToken)
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(accessToken) })
    expect(after.statusCode).toBe(200)
  })

  it('согласие под чужой редакцией текста не принимается', async () => {
    const { accessToken } = await signIn(nextPhone())
    const res = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2020-01-01' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('policy_version_stale')
  })

  /* ── защита кода ──────────────────────────────────────────────────── */
  it('повторный запрос кода раньше минуты — 429', async () => {
    const phone = nextPhone()
    const first = await requestCode(phone)
    expect(first.statusCode).toBe(200)
    expect(first.json()).toMatchObject({ expiresIn: 300, resendAfter: 60 })

    const again = await requestCode(phone)
    expect(again.statusCode).toBe(429)
    expect(again.json().error.code).toBe('too_many_requests')
    // Клиент должен знать, когда повторить, — иначе либо долбится, либо гадает.
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0)

    // Прошла минута — код снова можно запросить.
    await pretendMinutePassed(phone)
    expect((await requestCode(phone)).statusCode).toBe(200)
  })

  it('неверный код не пускает и считает попытки', async () => {
    const phone = nextPhone()
    await requestCode(phone)
    const real = await readCode(phone)
    const wrong = real === '0000' ? '1111' : '0000'

    const bad = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: wrong } })
    expect(bad.statusCode).toBe(401)

    const { rows } = await app.db!.query<{ attempts: number }>(
      'select attempts from otp_codes where phone = $1 order by created_at desc limit 1',
      [phone],
    )
    expect(rows[0]!.attempts).toBe(1)
  })

  it('код одноразовый: второй обмен тем же кодом не проходит', async () => {
    const phone = nextPhone()
    await requestCode(phone)
    const code = await readCode(phone)

    const ok = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    expect(ok.statusCode).toBe(200)

    const twice = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code } })
    expect(twice.statusCode).toBe(401)
  })

  it('код чужого номера не подходит', async () => {
    const mine = nextPhone()
    await requestCode(mine)
    const code = await readCode(mine)
    phoneCounter += 1
    const other = nextPhone()
    await requestCode(other)

    const res = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: other, code } })
    // Совпасть код может один раз на 10 000 — тогда тест мигал бы. Проверяем,
    // что хеш действительно привязан к номеру, а не полагаемся на удачу.
    const { rows } = await app.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 order by created_at desc limit 1',
      [other],
    )
    if (hashCode(SECRET_R, other, code) !== rows[0]!.code_hash) expect(res.statusCode).toBe(401)
  })

  /* ── кража refresh ────────────────────────────────────────────────── */
  it('повторное использование погашенного refresh гасит все сессии', async () => {
    const phone = nextPhone()
    const session = await signIn(phone)
    await consent(session.accessToken)

    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })
    expect(rotated.statusCode).toBe(200)
    const fresh = rotated.json() as { accessToken: string }

    // Тот же старый refresh предъявлен второй раз — это либо вор, либо жертва.
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    })
    expect(reuse.statusCode).toBe(401)

    // Даже свежий access перестаёт работать: погашены ВСЕ сессии.
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(fresh.accessToken) })
    expect(after.statusCode).toBe(401)

    const { rows } = await app.db!.query<{ action: string }>(
      `select action from audit_log where actor_id = $1 and action = 'auth.refresh_reuse'`,
      [session.user.id],
    )
    expect(rows).toHaveLength(1)
  })

  it('чужую сессию завершить нельзя', async () => {
    const a = await signIn(nextPhone())
    await consent(a.accessToken)
    phoneCounter += 1
    const b = await signIn(nextPhone())
    await consent(b.accessToken)

    const res = await app.inject({
      method: 'DELETE',
      url: `/users/me/sessions/${b.user.id === a.user.id ? 'x' : (await sessionIdOf(b.accessToken))}`,
      headers: auth(a.accessToken),
    })
    expect(res.statusCode).toBe(404)
  })

  async function sessionIdOf(token: string): Promise<string> {
    const res = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(token) })
    return (res.json() as { id: string; current: boolean }[]).find((s) => s.current)!.id
  }

  /* ── профиль ──────────────────────────────────────────────────────── */
  it('профиль читается и правится, пропущенные поля не затираются', async () => {
    const { accessToken } = await signIn(nextPhone())
    await consent(accessToken)

    const before = await app.inject({ method: 'GET', url: '/users/me', headers: auth(accessToken) })
    expect(before.json()).toMatchObject({
      lang: 'ru',
      push: { tasks: true, chats: true, deals: true, tips: true },
      quietHours: { from: '22:00', to: '09:00' },
    })

    const patched = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(accessToken),
      payload: { name: 'Алина', tz: 'Asia/Yekaterinburg', push: { tips: false }, quietHours: { from: '23:30' } },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json()).toMatchObject({
      name: 'Алина',
      tz: 'Asia/Yekaterinburg',
      lang: 'ru',
      push: { tasks: true, tips: false },
      quietHours: { from: '23:30', to: '09:00' },
    })

    // Правка только имени не сбрасывает уже выставленные тумблеры.
    const again = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(accessToken),
      payload: { name: 'Алина и Тимур' },
    })
    expect(again.json()).toMatchObject({ name: 'Алина и Тимур', push: { tips: false }, quietHours: { from: '23:30' } })
  })

  it('неизвестное поле в профиле отвергается', async () => {
    const { accessToken } = await signIn(nextPhone())
    await consent(accessToken)
    const res = await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(accessToken),
      payload: { name: 'Алина', isAdmin: true },
    })
    expect(res.statusCode).toBe(422)
  })

  it('экспорт отдаёт профиль, согласия и сессии', async () => {
    const { accessToken } = await signIn(nextPhone())
    await consent(accessToken)
    const res = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(accessToken) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.profile.phone).toMatch(/^\+7/)
    expect(body.consents).toHaveLength(1)
    expect(body.sessions.length).toBeGreaterThan(0)
  })

  it('удаление аккаунта гасит сессии', async () => {
    const { accessToken } = await signIn(nextPhone())
    await consent(accessToken)
    const del = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(accessToken) })
    expect(del.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(accessToken) })
    expect(after.statusCode).toBe(401)
  })

  it('отзыв согласия равносилен удалению аккаунта', async () => {
    const { accessToken } = await signIn(nextPhone())
    await consent(accessToken)
    const res = await app.inject({ method: 'DELETE', url: '/users/me/consent', headers: auth(accessToken) })
    expect(res.statusCode).toBe(204)
    const after = await app.inject({ method: 'GET', url: '/users/me', headers: auth(accessToken) })
    expect(after.statusCode).toBe(401)
  })

  /* ── гео ──────────────────────────────────────────────────────────── */
  it('поиск городов: «сиб» отдаёт Сибай первым', async () => {
    const res = await app.inject({ method: 'GET', url: '/geo/cities?q=сиб' })
    expect(res.statusCode).toBe(200)
    const cities = res.json() as { name: string; region: string }[]
    expect(cities[0]!.name).toBe('Сибай')
    expect(cities.map((c) => c.name)).toContain('Новосибирск')
  })

  it('поиск не зависит от ё и регистра', async () => {
    const withE = await app.inject({ method: 'GET', url: '/geo/cities?q=БЕЛОРЕЦК' })
    const withYo = await app.inject({ method: 'GET', url: '/geo/cities?q=белорёцк' })
    expect(withE.json()[0]?.name).toBe('Белорецк')
    expect(withYo.json()[0]?.name).toBe('Белорецк')
  })

  it('запрос короче двух символов отвергается', async () => {
    const res = await app.inject({ method: 'GET', url: '/geo/cities?q=с' })
    expect(res.statusCode).toBe(422)
  })

  it('ближайший город по координатам', async () => {
    // Координаты центра Уфы.
    const res = await app.inject({ method: 'GET', url: '/geo/nearest?lat=54.7388&lon=55.9721' })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Уфа')

    // Точка рядом с Сибаем — не Уфа.
    const sibay = await app.inject({ method: 'GET', url: '/geo/nearest?lat=52.72&lon=58.66' })
    expect(sibay.json().name).toBe('Сибай')
  })

  it('координаты вне диапазона отвергаются', async () => {
    const res = await app.inject({ method: 'GET', url: '/geo/nearest?lat=200&lon=0' })
    expect(res.statusCode).toBe(422)
  })

  /* ── OAuth отложен осознанно ──────────────────────────────────────── */
  it('OAuth отвечает 501 с внятной причиной, а не 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/oauth/vk' })
    expect(res.statusCode).toBe(501)
    expect(res.json().error.code).toBe('oauth_not_configured')
  })

  it('журнал действий только дописывается', async () => {
    await expect(app.db!.query("update audit_log set action = 'подмена'")).rejects.toThrow(/дописывается/)
  })
})

/* ── чистые функции, база не нужна ────────────────────────────────── */
describe('телефон и идентификаторы', () => {
  it('номер приводится к E.164 из любого привычного вида', () => {
    for (const raw of ['9171234567', '89171234567', '+7 (917) 123-45-67', '7917 123 45 67']) {
      expect(normalizePhone(raw)).toBe('+79171234567')
    }
  })

  it('мусор вместо номера — 422, а не молчаливый мусор в базе', () => {
    expect(() => normalizePhone('123')).toThrow(/не похож/)
    expect(() => normalizePhone('телефон')).toThrow()
  })

  it('маска скрывает середину, но оставляет узнаваемым', () => {
    expect(maskPhone('+79171234567')).toBe('+7917****567')
  })

  it('uuidv7 сортируется по времени и имеет правильную версию', () => {
    const early = uuidv7(1_700_000_000_000)
    const late = uuidv7(1_800_000_000_000)
    expect(early < late).toBe(true)
    expect(early[14]).toBe('7')
    expect('89ab').toContain(early[19])
    expect(uuidv7Time(early)).toBe(1_700_000_000_000)
  })

  it('uuidv7 не повторяется в пределах одной миллисекунды', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7(1_700_000_000_000)))
    expect(ids.size).toBe(500)
  })

  it('нормализация запроса совпадает с колонкой в базе', () => {
    expect(normalizeQuery('  БелорЁцк ')).toBe('белорецк')
  })
})
