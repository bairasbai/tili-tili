import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'

/**
 * Перепроверка этапов 1 и 2: то, что не проверялось, когда их сдавали.
 * Каждый набор здесь появился из вопроса «а что будет, если», а не из
 * пересказа уже написанного кода.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('перепроверка этапов 1 и 2', () => {
  let app: FastifyInstance
  let counter = 0
  const RUN = String(randomInt(100_000, 1_000_000))

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

  // Свой адрес на каждый набор: ограничитель по адресу общий для процесса,
  // и без этого наборы отбирали бы друг у друга лимит.
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`

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

  async function signIn(device = 'iPhone · Safari') {
    const phone = nextPhone()
    expect((await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })).statusCode).toBe(200)
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone), device },
    })
    expect(v.statusCode).toBe(200)
    return { ...(v.json() as { accessToken: string; refreshToken: string; user: { id: string } }), phone }
  }

  async function newUser(name?: string) {
    const s = await signIn()
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/users/me/consent',
          headers: auth(s.accessToken),
          payload: { policyVersion: '2026-09-02' },
        })
      ).statusCode,
    ).toBe(201)
    if (name) {
      await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(s.accessToken), payload: { name } })
    }
    return { token: s.accessToken, refresh: s.refreshToken, id: s.user.id }
  }

  async function createWedding(token: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  /* ── этап 1: сессии переживают ротацию ────────────────────────────── */
  it('после обновления токенов устройство остаётся одной сессией, а не новой', async () => {
    const user = await newUser()
    const before = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(user.token) })
    const original = (before.json() as { createdAt: string; device: string }[])[0]!

    const rotated = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refresh } })
    expect(rotated.statusCode).toBe(200)
    const next = rotated.json() as { accessToken: string }

    const after = await app.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(next.accessToken) })
    const list = after.json() as { createdAt: string; device: string }[]

    // Одно устройство — одна строка. Иначе экран «Сессии и устройства»
    // за неделю превращается в список из сотен «входов».
    expect(list).toHaveLength(1)
    expect(list[0]!.device).toBe(original.device)
    // И время входа то же: обновление токена — не новый вход. Иначе экран
    // говорит «вошли пять минут назад» про устройство, живущее полгода,
    // и по нему нельзя заметить чужое устройство.
    expect(list[0]!.createdAt).toBe(original.createdAt)
  })

  /* ── этап 1: коды не копятся ──────────────────────────────────────── */
  it('старые коды не хранятся вечно — это персональные данные', async () => {
    const phone = nextPhone()
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    // Сдвигаем в прошлое: так выглядят коды недельной давности.
    await app.db!.query("update otp_codes set created_at = now() - interval '30 days' where phone = $1", [phone])
    await app.db!.query("update otp_codes set expires_at = now() - interval '30 days' where phone = $1", [phone])

    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const { rows } = await app.db!.query<{ old: string }>(
      "select count(*)::text as old from otp_codes where phone = $1 and created_at < now() - interval '1 day'",
      [phone],
    )
    expect(Number(rows[0]!.old)).toBe(0)
  })

  /* ── этап 1: экспорт по 152-ФЗ полный ─────────────────────────────── */
  it('экспорт отдаёт и свадьбы, а не только профиль', async () => {
    const user = await newUser('Алина')
    const w = await createWedding(user.token)
    const res = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(user.token) })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // 152-ФЗ даёт право получить ВСЕ свои данные. Свадьба — главные из них.
    expect(Array.isArray(body.weddings)).toBe(true)
    expect(body.weddings.map((x: { id: string }) => x.id)).toContain(w.id)
  })

  /* ── этап 2: свою свадьбу можно найти после переустановки ─────────── */
  it('после входа свадьба находится без сохранённого идентификатора', async () => {
    const user = await newUser('Алина')
    const created = await createWedding(user.token)

    // Человек переустановил приложение: localStorage пуст, есть только вход.
    const res = await app.inject({ method: 'GET', url: '/weddings', headers: auth(user.token) })
    expect(res.statusCode).toBe(200)
    const list = res.json() as { id: string; title: string }[]
    expect(list.map((w) => w.id)).toContain(created.id)
  })

  it('в списке только свои свадьбы', async () => {
    const mine = await newUser('Алина')
    const own = await createWedding(mine.token)
    const other = await newUser('Ольга')
    await createWedding(other.token)

    const res = await app.inject({ method: 'GET', url: '/weddings', headers: auth(mine.token) })
    const ids = (res.json() as { id: string }[]).map((w) => w.id)
    expect(ids).toEqual([own.id])
  })

  it('приглашённый видит свадьбу в своём списке', async () => {
    const couple = await newUser('Алина')
    const w = await createWedding(couple.token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    const helper = await newUser('Катя')
    await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(helper.token),
    })

    const res = await app.inject({ method: 'GET', url: '/weddings', headers: auth(helper.token) })
    const list = res.json() as { id: string; role: string }[]
    expect(list.map((x) => x.id)).toContain(w.id)
    expect(list.find((x) => x.id === w.id)!.role).toBe('helper')
  })

  /* ── деньги не видны помощнику НИГДЕ, а не только в разделе «Бюджет» ── */
  it('помощник и координатор не видят сумму бюджета в карточке свадьбы', async () => {
    const couple = await newUser('Алина')
    const w = await createWedding(couple.token)
    expect(w.budgetTotal).toEqual({ amount: 150_000_000, currency: 'RUB' })

    for (const role of ['helper', 'coordinator']) {
      const invite = await app.inject({
        method: 'POST',
        url: `/weddings/${w.id}/invites`,
        headers: auth(couple.token),
        payload: { role },
      })
      const member = await newUser()
      await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(member.token) })

      // Путь открыт — карточку смотреть можно. Но сумма из неё вырезана:
      // матрица закрывает пути целиком и на поля повлиять не может.
      const card = await app.inject({ method: 'GET', url: `/weddings/${w.id}`, headers: auth(member.token) })
      expect(card.statusCode).toBe(200)
      expect(`${role}: ${JSON.stringify(card.json()).includes('budgetTotal')}`).toBe(`${role}: false`)

      // И в списке своих свадеб — тоже.
      const list = await app.inject({ method: 'GET', url: '/weddings', headers: auth(member.token) })
      expect(JSON.stringify(list.json())).not.toContain('budgetTotal')
    }
  })

  /* ── этап 2: роль vendor в матрице ────────────────────────────────── */
  it('подрядчик в команде не видит ни карточку, ни бюджет', async () => {
    const couple = await newUser('Алина')
    const w = await createWedding(couple.token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'vendor' },
    })
    const vendor = await newUser()
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${invite.json().code}/accept`,
      headers: auth(vendor.token),
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json().role).toBe('vendor')

    // Матрица: у vendor нет доступа к карточке свадьбы, команде и деньгам.
    for (const tail of ['', '/members', '/invites', '/budget', '/guests', '/tasks']) {
      const res = await app.inject({ method: 'GET', url: `/weddings/${w.id}${tail}`, headers: auth(vendor.token) })
      expect(`${tail || '/'} → ${res.statusCode}`).toBe(`${tail || '/'} → 403`)
    }
  })

  it('помощник не видит кодов приглашений — это готовое повышение прав', async () => {
    const couple = await newUser('Алина')
    const w = await createWedding(couple.token)
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'couple', label: 'Для Тимура' },
    })
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    const helper = await newUser()
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(helper.token) })

    const asCouple = await app.inject({ method: 'GET', url: `/weddings/${w.id}/invites`, headers: auth(couple.token) })
    expect(asCouple.json()[0].code).toBeTruthy()

    // Помощнику список виден — но без ключей. Иначе он берёт приглашение
    // с ролью couple и в один клик становится парой со всеми деньгами.
    const asHelper = await app.inject({ method: 'GET', url: `/weddings/${w.id}/invites`, headers: auth(helper.token) })
    expect(asHelper.statusCode).toBe(200)
    expect(asHelper.json().length).toBeGreaterThan(0)
    expect(JSON.stringify(asHelper.json())).not.toContain('ПАРА-')
    for (const row of asHelper.json() as Record<string, unknown>[]) {
      expect(row.code).toBeUndefined()
      expect(row.url).toBeUndefined()
    }
  })

  it('общий потолок отправок останавливает перебор номеров', async () => {
    // Лимит на номер (5 в час) бесполезен против скрипта с тысячей номеров:
    // он отправит тысячу сообщений и не нарушит ни одного правила. Лимит на
    // адрес обходится ботнетом. Останавливает только общий потолок — и он же
    // единственное, что реально ограничивает счёт за SMS.
    const { rows } = await app.db!.query<{ sends: string }>(
      "select count(*)::text as sends from otp_codes where created_at > now() - interval '1 hour'",
    )
    const already = Number(rows[0]!.sends)

    const withCap = async (limit: number) => {
      const instance = await buildApp({
        env: 'test',
        databaseUrl: DB ?? null,
        redisUrl: null,
        corsOrigins: [],
        jwtAccessSecret: SECRET_A,
        jwtRefreshSecret: SECRET_R,
        otpMaxPerIpHour: 1_000_000,
        otpMaxPerHourTotal: limit,
      })
      await instance.ready()
      const res = await instance.inject({
        method: 'POST',
        url: '/auth/otp',
        payload: { phone: nextPhone() },
        // Новый адрес и новый номер: ни один другой ограничитель сработать
        // не может, остаётся только общий потолок.
        remoteAddress: `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`,
      })
      await instance.close()
      return res
    }

    // Потолок заведомо ниже текущего числа — отказ обязателен. Сравнение
    // «текущее + 2» было бы гонкой: соседние наборы тестов шлют коды
    // в ту же таблицу, и счётчик растёт между чтением и отправкой.
    const stopped = await withCap(Math.max(1, already - 1))
    expect(stopped.statusCode).toBe(429)
    expect(Number(stopped.headers['retry-after'])).toBeGreaterThan(0)

    // Потолок заведомо выше — проходит.
    expect((await withCap(1_000_000)).statusCode).toBe(200)
  })

  it('подделанный X-Forwarded-For не подменяет адрес', async () => {
    // При trustProxy: true любой клиент назначает себе адрес одной строкой,
    // и ограничитель по адресу превращается в украшение.
    const strict = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      // Общий потолок отправок проверяется отдельным тестом; здесь он не должен
      // мешать — база копит коды за час всех прогонов подряд.
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 2,
      otpMaxPerHourTotal: 1_000_000,
      trustProxy: false,
    })
    await strict.ready()

    const ip = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const res = await strict.inject({
        method: 'POST',
        url: '/auth/otp',
        payload: { phone: nextPhone() },
        remoteAddress: ip,
        // Каждый раз новый «адрес» в заголовке — если ему верят, лимит не сработает.
        headers: { 'x-forwarded-for': `203.0.113.${i + 1}` },
      })
      statuses.push(res.statusCode)
    }
    expect(statuses).toEqual([200, 200, 429, 429])
    await strict.close()
  })

  /* ── этап 2: последняя пара не теряется под гонкой ────────────────── */
  it('две одновременные попытки убрать пару не оставляют свадьбу ничьей', async () => {
    const a = await newUser('Алина')
    const w = await createWedding(a.token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(a.token),
      payload: { role: 'couple' },
    })
    const b = await newUser('Тимур')
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code}/accept`, headers: auth(b.token) })

    // Оба одновременно удаляют друг друга. Проверка «есть ли ещё пара»
    // и удаление должны быть одним действием, иначе оба увидят «есть»
    // и оба удалят.
    const [first, second] = await Promise.all([
      app.inject({ method: 'DELETE', url: `/weddings/${w.id}/members/${b.id}`, headers: auth(a.token) }),
      app.inject({ method: 'DELETE', url: `/weddings/${w.id}/members/${a.id}`, headers: auth(b.token) }),
    ])
    // Ровно один запрос проходит. Второй получает 404 (его автора уже убрали)
    // или 409 (он ещё в команде, но убрать последнюю пару нельзя) — что именно,
    // зависит от того, кто успел первым, и проверять это бессмысленно.
    const codes = [first.statusCode, second.statusCode]
    expect(codes.filter((c) => c === 204)).toHaveLength(1)
    expect(codes.filter((c) => c === 404 || c === 409)).toHaveLength(1)

    const { rows } = await app.db!.query<{ couples: string }>(
      "select count(*)::text as couples from wedding_members where wedding_id = $1 and role = 'couple'",
      [w.id],
    )
    expect(Number(rows[0]!.couples)).toBe(1)
  })

  it('предполётный запрос браузера не упирается в матрицу доступа', async () => {
    // Матрица закрывает всё, для чего не написано правило, — а метод OPTIONS
    // в правилах не значится. Если бы хук успевал сработать, браузер получал бы
    // 403 на предполётный запрос и фронт не смог бы обратиться ни к одному
    // пути свадьбы вообще.
    const cors = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: ['https://tili-tili.ru'],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      // Общий потолок отправок проверяется отдельным тестом; здесь он не должен
      // мешать — база копит коды за час всех прогонов подряд.
      otpMaxPerHourTotal: 1_000_000,
    })
    await cors.ready()

    const res = await cors.inject({
      method: 'OPTIONS',
      url: '/weddings/01a06413-08b9-7629-b3f0-3d5f8d644781/budget',
      headers: {
        origin: 'https://tili-tili.ru',
        'access-control-request-method': 'GET',
      },
    })
    expect(res.statusCode).toBeLessThan(300)
    expect(res.headers['access-control-allow-origin']).toBe('https://tili-tili.ru')
    await cors.close()
  })

  /* ── этап 2: коды нечувствительны к регистру ──────────────────────── */
  it('код приглашения принимается в любом регистре', async () => {
    const couple = await newUser('Алина')
    const w = await createWedding(couple.token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    const code: string = invite.json().code
    // Человек переписывает код с экрана — регистр он не сохранит.
    const view = await app.inject({ method: 'GET', url: `/invites/${code.toLowerCase()}` })
    expect(view.statusCode).toBe(200)

    const helper = await newUser()
    const accepted = await app.inject({
      method: 'POST',
      url: `/invites/${code.toLowerCase()}/accept`,
      headers: auth(helper.token),
    })
    expect(accepted.statusCode).toBe(200)
  })

  /* ── деньги: границы ──────────────────────────────────────────────── */
  it('нереальная сумма бюджета отвергается, а не теряет точность', async () => {
    const user = await newUser()
    // Тело собирается строкой, а не объектом: этот литерал в JavaScript
    // сам по себе округляется, и через объект до сервера дошло бы уже
    // испорченное число — проверять было бы нечего.
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: { ...auth(user.token), 'content-type': 'application/json' },
      payload:
        '{"partnerName":"Тимур","city":{"name":"Уфа","region":"Башкортостан"},' +
        '"budgetTotal":{"amount":9007199254740993,"currency":"RUB"}}',
    })
    expect(res.statusCode).toBe(422)
  })

  it('крупный, но реальный бюджет возвращается копейка в копейку', async () => {
    const user = await newUser()
    const amount = 999_999_999_99 // 999 999 999,99 ₽
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().budgetTotal.amount).toBe(amount)
  })

  /* ── этап 1: чужой номер нельзя заваливать сообщениями ────────────── */
  it('запросы кода ограничены и по адресу, а не только по номеру', async () => {
    // Лимит на номер не мешает перебирать номера: платим за SMS мы, а коды
    // получают незнакомые люди. Порог занижен в отдельном приложении и адрес
    // взят свой — иначе ограничитель зацепил бы соседние тесты.
    const strict = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      // Общий потолок отправок проверяется отдельным тестом; здесь он не должен
      // мешать — база копит коды за час всех прогонов подряд.
      otpMaxPerHourTotal: 1_000_000,
      otpMaxPerIpHour: 3,
      // Общий потолок проверяется отдельно; здесь он мешал бы измерять адрес.
      otpMaxPerHourTotal: 1_000_000,
    })
    await strict.ready()

    /* Адрес выводим из номера прогона, а не берём случайный из 250.
       Лимит считает строки `otp_codes` за час, база общая, и при частых
       прогонах два набора брали один адрес: тогда тест видел 429 с первого
       запроса и падал в полном прогоне, проходя в одиночку. Улик после себя
       он не оставлял — истёкшие коды удаляет фоновая уборка. */
    const ip = `198.51.${Number(RUN) % 256}.${((Number(RUN) >> 8) % 254) + 1}`
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      const res = await strict.inject({
        method: 'POST',
        url: '/auth/otp',
        payload: { phone: nextPhone() },
        remoteAddress: ip,
      })
      statuses.push(res.statusCode)
    }
    // Первые проходят, дальше отказ: перебор номеров упирается в адрес.
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200])
    expect(statuses.slice(3)).toEqual([429, 429])

    // И порог по-настоящему щадящий: в проде за одним адресом сидит
    // весь мобильный оператор, и жёсткий лимит отрезал бы его целиком.
    expect(strict.appConfig.otpMaxPerIpHour).toBe(3)
    await strict.close()
  })
})
