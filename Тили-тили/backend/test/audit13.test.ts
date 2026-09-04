import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../src/app.js'
import { newShareCode } from '../src/guests/access.js'
import { decodeCursor, encodeCursor, parsePageQuery } from '../src/pagination.js'
import { maskUrl } from '../src/redact.js'
import { CONTRACT_OPERATIONS } from '../src/contract/paths.generated.js'
import { CANCEL_CONFIRM_HOURS, cancelRequestPending } from '../src/routes/weddingLifecycle.js'
import { localDayBounds } from '../src/notify/quiet.js'
import { rolesSeeing } from '../src/chats/access.js'
import { seesInviteUrl, toGuest } from '../src/routes/guests.js'
import { toWedding } from '../src/routes/weddings.js'
import { allowedRoles } from '../src/wedding/access.js'
import type { AppError } from '../src/errors.js'

/**
 * Регрессии по аудиту 2026-09-03.
 *
 * Каждый набор здесь падал бы до своего исправления — в этом весь смысл:
 * тест, который проходит и на сломанном коде, ничего не сторожит.
 *
 * Живая база не нужна: обе проверки работают на уровне чистой функции и
 * маршрутизатора, поэтому они идут в общем прогоне, а не под skipIf.
 */
const TEST_CONFIG = { env: 'test' as const, databaseUrl: null, redisUrl: null, corsOrigins: [] }

describe('код ссылки-приглашения гостя (ERR: Math.random в секрете доступа)', () => {
  const realRandom = Math.random
  afterEach(() => {
    Math.random = realRandom
  })

  it('не зависит от Math.random: с замороженным Math.random коды всё равно разные', () => {
    // Math.random в V8 — не криптостойкий генератор с общим состоянием на
    // процесс: пара, выпускающая ссылки на своей свадьбе, набирает выборку
    // и предсказывает коды чужих гостей. Замораживаем его — если код
    // построен на нём, все значения совпадут.
    Math.random = () => 0.5

    const codes = new Set(Array.from({ length: 200 }, () => newShareCode()))

    // До фикса здесь была бы ровно одна строка на 200 вызовов.
    expect(codes.size).toBeGreaterThan(150)
  })

  it('сохраняет формат XXXX-XXXX из читаемого алфавита', () => {
    // Алфавит без похожих знаков: код диктуют вслух. Смена генератора
    // не должна была затронуть форму.
    for (let i = 0; i < 50; i++) {
      expect(newShareCode()).toMatch(/^[ACDEFGHJKMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    }
  })
})

describe('идентификаторы подарков в адресе (ERR: 500 от драйвера базы)', () => {
  /*
   * До фикса строка из адреса уходила прямо в запрос по колонке uuid: драйвер
   * отвечал `invalid input syntax for type uuid`, обработчик переводил это
   * в 500 и писал в лог как о падении сервера.
   *
   * Ответ — 422 «не прошло проверку», а НЕ 404: путь контракта не должен
   * отвечать 404 ни при каких параметрах (инвариант 10). Проверка идёт схемой,
   * то есть до обработчика, поэтому ответ одинаков с базой и без неё.
   */
  it('не-UUID в пути резерва даёт 422, а не ошибку драйвера базы', async () => {
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/gifts/some-guest-token/not-a-uuid/reserve',
        headers: { 'idempotency-key': 'regression-1' },
      })
      expect(res.statusCode).toBe(422)
      expect(res.json().error.code).toBe('validation_failed')
    } finally {
      await app.close()
    }
  })

  it('не-UUID в пути снятия резерва тоже даёт 422', async () => {
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({ method: 'DELETE', url: '/gifts/some-guest-token/12345/reserve' })
      expect(res.statusCode).toBe(422)
    } finally {
      await app.close()
    }
  })

  it('корректный UUID проходит проверку и доходит до обработчика', async () => {
    // Иначе схема могла бы отсекать всё подряд, и тесты выше проходили бы
    // по неверной причине. Без базы обработчик отвечает 503 — это и значит
    // «до него дошло».
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: '/gifts/some-guest-token/0192f3a4-5b6c-7d8e-9f01-234567890abc/reserve',
      })
      expect(res.statusCode).not.toBe(422)
    } finally {
      await app.close()
    }
  })
})

describe('курсор пагинации (ERR: 500 от драйвера базы на шести маршрутах)', () => {
  const UUID = '0192f3a4-5b6c-7d8e-9f01-234567890abc'
  const ISO = '2026-09-04T08:30:00.000Z'
  const bad = (raw: string, kind?: 'timestamp' | 'number') => {
    try {
      decodeCursor(raw, kind)
      return null
    } catch (error) {
      return error as AppError
    }
  }

  /*
   * Половинки курсора уходят в запрос с приведением типа. До фикса единственной
   * проверкой был разделитель `|`, и `мусор|мусор` её проходил: база отвечала
   * ошибкой синтаксиса, обработчик — 500 с записью в лог как о падении сервера.
   */
  it('мусор в обеих половинках даёт 400, а не проходит дальше', () => {
    const err = bad(encodeCursor('не-дата-вообще', 'не-uuid-вообще'))
    expect(err?.statusCode).toBe(400)
    expect(err?.code).toBe('bad_cursor')
  })

  it('подделанный идентификатор отвергается при верной дате', () => {
    expect(bad(encodeCursor(ISO, "'; drop table users; --"))?.statusCode).toBe(400)
  })

  it('подделанная дата отвергается при верном идентификаторе', () => {
    expect(bad(encodeCursor('вчера', UUID))?.statusCode).toBe(400)
  })

  it('числовой ключ каталога: буквы отвергаются, число проходит', () => {
    expect(bad(encodeCursor('abc', UUID), 'number')?.statusCode).toBe(400)
    expect(bad(encodeCursor('4.7', UUID), 'number')).toBeNull()
    expect(bad(encodeCursor('-1', UUID), 'number')).toBeNull()
    // Number() принял бы оба, PostgreSQL — нет.
    expect(bad(encodeCursor('0x10', UUID), 'number')?.statusCode).toBe(400)
    expect(bad(encodeCursor(' 12 ', UUID), 'number')?.statusCode).toBe(400)
  })

  it('дата в курсоре каталога отвергается: он листается числами', () => {
    expect(bad(encodeCursor(ISO, UUID), 'number')?.statusCode).toBe(400)
  })

  it('свои курсоры переживают круг без потерь', () => {
    // Иначе проверка могла бы отсекать законные значения, и листание сломалось
    // бы на второй странице — молча, потому что тесты выше это не увидят.
    expect(decodeCursor(encodeCursor(ISO, UUID))).toEqual({ sort: ISO, id: UUID })
    expect(decodeCursor(encodeCursor('9223372036854775807', UUID), 'number')).toEqual({
      sort: '9223372036854775807',
      id: UUID,
    })
  })

  it('parsePageQuery передаёт вид ключа дальше', () => {
    expect(() => parsePageQuery({ cursor: encodeCursor('abc', UUID) }, 'number')).toThrow()
    expect(parsePageQuery({ cursor: encodeCursor(ISO, UUID) }).cursor).toEqual({ sort: ISO, id: UUID })
    // Без курсора ничего не проверяется — обычный первый запрос страницы.
    expect(parsePageQuery({}).cursor).toBeNull()
  })
})

describe('маскирование секретов в логе (ERR: коды приглашений уходили открытым текстом)', () => {
  const SECRET = 'SEKRET-TOKEN-abc123'
  const SECRET_PARAM = /token|code/i

  /**
   * Главная проверка выведена ИЗ КОНТРАКТА, а не из списка путей руками.
   *
   * Именно список руками и подвёл: в нём был `invite`, но не было `invites`
   * и `guest-vendor`. Список в тесте повторил бы ту же ошибку — новый путь
   * с токеном в него точно так же забыли бы вписать. Здесь новый путь
   * появляется в проверке сам, вместе с контрактом.
   */
  it('ни один путь контракта с секретом во втором сегменте не уходит в лог открытым', () => {
    const leaked: string[] = []
    for (const op of CONTRACT_OPERATIONS) {
      const parts = op.url.split('/')
      const param = parts[2] ?? ''
      if (!(parts.length > 2 && param.startsWith(':') && SECRET_PARAM.test(param))) continue
      const filled = op.url.replace(/:[a-zA-Z]+/g, (m) => (m === param ? SECRET : 'x'))
      if (maskUrl(filled).includes(SECRET)) leaked.push(op.url)
    }
    expect(leaked).toEqual([])
  })

  it('коды приглашения в команду больше не видны в логе', () => {
    // Принявший такое приглашение получает роль вплоть до `couple` — то есть
    // бюджет, договоры и переписку чужой свадьбы.
    expect(maskUrl(`/invites/${SECRET}`)).toBe('/invites/***')
    expect(maskUrl(`/invites/${SECRET}/accept`)).toBe('/invites/***/accept')
  })

  it('токен своего подрядчика больше не виден в логе', () => {
    expect(maskUrl(`/guest-vendor/${SECRET}`)).toBe('/guest-vendor/***')
    expect(maskUrl(`/guest-vendor/${SECRET}/messages`)).toBe('/guest-vendor/***/messages')
  })

  it('ранее закрытые пути закрыты по-прежнему', () => {
    expect(maskUrl(`/gifts/${SECRET}/g1/reserve`)).toBe('/gifts/***/g1/reserve')
    expect(maskUrl(`/rsvp/${SECRET}`)).toBe('/rsvp/***')
    expect(maskUrl(`/join/${SECRET}/hotels`)).toBe('/join/***/hotels')
    expect(maskUrl(`/invite/${SECRET}`)).toBe('/invite/***')
  })

  it('секрет в строке запроса маскируется по имени параметра', () => {
    expect(maskUrl(`/weddings/w1/album?guestToken=${SECRET}`)).toBe('/weddings/w1/album?guestToken=***')
    expect(maskUrl(`/chats/c1/ws?token=${SECRET}`)).toBe('/chats/c1/ws?token=***')
    // Имя с `code` тоже секрет — раньше маскировались только два имени списком.
    expect(maskUrl(`/x?inviteCode=${SECRET}&limit=20`)).toBe('/x?inviteCode=***&limit=20')
  })

  it('несекретные идентификаторы остаются в логе читаемыми', () => {
    // Иначе лечение хуже болезни: по замаскированному адресу не разобрать
    // ни одну жалобу.
    expect(maskUrl('/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/budget')).toContain('0192f3a4')
    expect(maskUrl('/chats/c1/messages?limit=20')).toBe('/chats/c1/messages?limit=20')
  })
})

describe('идентификаторы сессий и участников в адресе', () => {
  /*
   * Схема проверяет параметр ДО preHandler, поэтому ответ 422 приходит и без
   * входа: проверка формата не зависит от того, кто спрашивает. До фикса
   * строка уходила в запрос по колонке uuid и давала 500.
   */
  const cases: [string, 'DELETE' | 'PATCH', string][] = [
    ['сессия', 'DELETE', '/users/me/sessions/не-uuid'],
    ['участник, смена роли', 'PATCH', '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/members/не-uuid'],
    ['участник, удаление', 'DELETE', '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/members/не-uuid'],
  ]

  for (const [name, method, url] of cases) {
    it(`${name}: не-uuid даёт 422, а не ошибку драйвера базы`, async () => {
      const app = await buildApp(TEST_CONFIG)
      try {
        const res = await app.inject({ method, url, payload: method === 'PATCH' ? { role: 'helper' } : undefined })
        expect(res.statusCode).toBe(422)
      } finally {
        await app.close()
      }
    })
  }
})

describe('запрос на отмену свадьбы протухает (ERR: подтверждение жило вечно)', () => {
  const A = 'partner-a'
  const HOUR = 3_600_000
  const now = new Date('2026-09-04T12:00:00Z')
  const ago = (hours: number) => new Date(now.getTime() - hours * HOUR)

  it('запроса не было — подтверждать нечего', () => {
    expect(cancelRequestPending(null, null, now)).toBe(false)
  })

  it('свежий запрос жив', () => {
    expect(cancelRequestPending(A, ago(1), now)).toBe(true)
    expect(cancelRequestPending(A, ago(CANCEL_CONFIRM_HOURS - 1), now)).toBe(true)
  })

  it('запрос старше срока мёртв', () => {
    /* До фикса `cancel_requested_at` писалась и не читалась нигде. Партнёр,
     * нажавший «Отменить» в январе и остывший, оставлял запрос навсегда:
     * в июне первое же нажатие второго стирало свадьбу без подтверждения. */
    expect(cancelRequestPending(A, ago(CANCEL_CONFIRM_HOURS + 1), now)).toBe(false)
    expect(cancelRequestPending(A, ago(24 * 180), now)).toBe(false)
  })

  it('время запроса без автора и наоборот — не запрос', () => {
    expect(cancelRequestPending(A, null, now)).toBe(false)
    expect(cancelRequestPending(null, ago(1), now)).toBe(false)
  })
})

describe('местные сутки для лимита push (ERR: сутки резались по UTC)', () => {
  const KAMCHATKA = 'Asia/Kamchatka'

  it('два момента одних местных суток дают одни границы, хотя лежат в разных сутках UTC', () => {
    // Камчатка +12. Местное 04.09 02:00 = UTC 03.09 14:00, местное 04.09 20:00
    // = UTC 04.09 08:00. По UTC это разные дни — по местным одни и те же.
    const early = new Date('2026-09-03T14:00:00Z')
    const late = new Date('2026-09-04T08:00:00Z')
    expect(early.getUTCDate()).not.toBe(late.getUTCDate())

    const a = localDayBounds(early, KAMCHATKA)
    const b = localDayBounds(late, KAMCHATKA)
    expect(a.from.toISOString()).toBe(b.from.toISOString())
    expect(a.to.toISOString()).toBe(b.to.toISOString())
  })

  it('границы длиной ровно в сутки и момент лежит внутри', () => {
    for (const tz of ['Europe/Moscow', 'Asia/Kamchatka', 'Europe/Kaliningrad', 'Asia/Vladivostok']) {
      const at = new Date('2026-09-04T08:30:00Z')
      const { from, to } = localDayBounds(at, tz)
      expect(to.getTime() - from.getTime()).toBe(86_400_000)
      expect(from.getTime()).toBeLessThanOrEqual(at.getTime())
      expect(to.getTime()).toBeGreaterThan(at.getTime())
    }
  })

  it('соседние местные сутки стыкуются без зазора и нахлёста', () => {
    const first = localDayBounds(new Date('2026-09-04T08:30:00Z'), KAMCHATKA)
    const second = localDayBounds(new Date(first.to.getTime() + 60_000), KAMCHATKA)
    expect(second.from.toISOString()).toBe(first.to.toISOString())
  })
})

describe('получатели уведомления о сообщении (ERR: помощник получал чужую переписку)', () => {
  it('переписку с подрядчиком помощнику не пересказывают', () => {
    // Матрица доступа закрывает от помощника чаты `vendor` и `external`:
    // там суммы и условия сделок, а денег он не видит нигде (§6, ERR-0026).
    // Рассылка слала ему туда первые 120 символов сообщения.
    expect(rolesSeeing('vendor')).not.toContain('helper')
    expect(rolesSeeing('external')).not.toContain('helper')
  })

  it('состав получателей совпадает с матрицей видимости', () => {
    expect([...rolesSeeing('vendor')].sort()).toEqual(['coordinator', 'couple'])
    expect([...rolesSeeing('external')].sort()).toEqual(['coordinator', 'couple'])
    expect([...rolesSeeing('team')].sort()).toEqual(['coordinator', 'couple', 'helper'])
    expect([...rolesSeeing('day')].sort()).toEqual(['coordinator', 'couple', 'helper'])
    // Чат исполнителей ведёт координатор, пара в нём не состоит.
    expect([...rolesSeeing('crew')].sort()).toEqual(['coordinator'])
    expect([...rolesSeeing('tilly')].sort()).toEqual(['couple'])
  })
})

describe('одноразовая ссылка гостя в списке (ERR: её видела вся команда)', () => {
  const row = {
    id: 'g1',
    name: 'Ольга',
    plus_one: false,
    group_name: null,
    rsvp: 'yes',
    table_id: null,
    diet: null,
    diet_note: null,
    menu_option_id: null,
    transfer: null,
    bus_id: null,
    hotel_id: null,
    invite_code: 'ACDE-F234',
    invite_used: null,
  }

  /*
   * Матрица закрывает помощнику ВЫДАЧУ ссылки отдельным правилом (решение
   * владельца 2026-09-03): кто её выдаёт, тот обменивает её сам и действует
   * от имени гостя. Список гостей отдавал все уже выданные ссылки всей
   * команде — и правило обходилось соседним маршрутом.
   */
  it('помощник и координатор ссылку не получают', () => {
    for (const role of ['helper', 'coordinator'] as const) {
      expect(seesInviteUrl(role)).toBe(false)
      const out = toGuest(row, seesInviteUrl(role))
      expect(out).not.toHaveProperty('inviteUrl')
      expect(JSON.stringify(out)).not.toContain('ACDE-F234')
    }
  })

  it('пара ссылку получает — она и есть отправитель', () => {
    expect(seesInviteUrl('couple')).toBe(true)
    expect(toGuest(row, true).inviteUrl).toBe('https://tili-tili.ru/i/ACDE-F234')
  })

  it('состояние приглашения остаётся всей команде: это не ключ', () => {
    // Иначе помощник не может вести список — он не видит, кому уже отправили.
    expect(toGuest({ ...row, invite_used: true }, false).inviteUrlUsed).toBe(true)
    expect(toGuest(row, false).inviteUrlUsed).toBe(false)
  })

  it('остальные поля гостя не потерялись вместе со ссылкой', () => {
    const out = toGuest(row, false)
    expect(out.id).toBe('g1')
    expect(out.name).toBe('Ольга')
    expect(out.status).toBe('yes')
  })
})

describe('сдвиг тайминга — команда днём X (решение владельца 2026-09-04)', () => {
  const SHIFT = '/weddings/:weddingId/timeline/shift'

  it('сдвигать день может только пара и координатор', () => {
    /* Действие двигает все ещё не начавшиеся блоки и шлёт КРИТИЧЕСКОЕ
     * уведомление всем гостям и забронированным подрядчикам — мимо тихих
     * часов. Общее правило по префиксу `timeline` отдавало его всей команде,
     * хотя соседний план Б закрыт по тому же рассуждению. */
    expect([...allowedRoles(SHIFT, 'POST')].sort()).toEqual(['coordinator', 'couple'])
    expect(allowedRoles(SHIFT, 'POST')).not.toContain('helper')
  })

  it('обычная правка расписания осталась всей команде', () => {
    // Иначе лечение хуже болезни: помощник перестал бы вести тайминг вообще.
    expect([...allowedRoles('/weddings/:weddingId/timeline', 'PUT')].sort()).toEqual([
      'coordinator',
      'couple',
      'helper',
    ])
  })

  it('правило стоит выше общего: порядок в матрице значим', () => {
    // Если общее правило по `timeline` окажется первым, сдвиг снова станет
    // доступен всем — и этот тест это поймает.
    expect(allowedRoles(SHIFT, 'POST')).not.toEqual(allowedRoles('/weddings/:weddingId/timeline', 'POST'))
  })
})

describe('состояние запроса на отмену в карточке свадьбы', () => {
  const base = {
    id: 'w1',
    title: 'Алина ♥ Тимур',
    date: '2027-06-14',
    city_name: null,
    city_region: null,
    venue: null,
    style: null,
    guests_planned: null,
    budget_total: null,
    currency: 'RUB',
    tz: null,
    invite_theme_id: 0,
    invite_text: null,
    cancel_requested_by: 'partner-a',
    cancel_requested_at: new Date(),
  }

  it('пара видит живой запрос — без этого второй партнёр подтверждает вслепую', () => {
    const out = toWedding(base, [], 'couple') as Record<string, unknown>
    expect(out.cancelRequestedBy).toBe('partner-a')
    expect(out.cancelRequestedAt).not.toBeNull()
  })

  it('протухший запрос отдаётся пустым: он и не действует', () => {
    const stale = { ...base, cancel_requested_at: new Date(Date.now() - 24 * 3_600_000 * 180) }
    const out = toWedding(stale, [], 'couple') as Record<string, unknown>
    expect(out.cancelRequestedBy).toBeNull()
    expect(out.cancelRequestedAt).toBeNull()
  })

  it('помощнику и координатору полей нет вовсе', () => {
    for (const role of ['helper', 'coordinator'] as const) {
      const out = toWedding(base, [], role)
      expect(out).not.toHaveProperty('cancelRequestedBy')
      expect(out).not.toHaveProperty('cancelRequestedAt')
    }
  })
})

describe('идентификаторы в ТЕЛЕ запроса (ERR: первый свод искал только адреса)', () => {
  /*
   * Первый свод по параметрам пути пропустил семь мест: идентификатор приходит
   * полем тела и точно так же уходит в колонку uuid. Схема срабатывает до
   * обработчика, поэтому ответ 422 приходит и без входа, и без базы.
   */
  const cases: [string, 'POST' | 'PUT' | 'PATCH', string, unknown][] = [
    ['автобус гостя', 'POST', '/join/tok/shuttle', { busId: 'не-uuid' }],
    ['отель гостя', 'POST', '/join/tok/hotels', { hotelId: 'не-uuid' }],
    ['голос за блюдо', 'POST', '/join/tok/menu-vote', { optionId: 'не-uuid' }],
    [
      'правка опроса меню',
      'PUT',
      '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/menu-poll',
      { options: [{ id: 'не-uuid', name: 'Рыба' }] },
    ],
    [
      'рассадка гостя',
      'PATCH',
      '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/guests/0192f3a4-5b6c-7d8e-9f01-234567890abd',
      { tableId: 'не-uuid' },
    ],
    [
      'бронь слота',
      'POST',
      '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/slots/0192f3a4-5b6c-7d8e-9f01-234567890abd/book',
      { vendorId: 'не-uuid', price: { amount: 1000, currency: 'RUB' } },
    ],
    [
      'отзыв гостя',
      'POST',
      '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/guest-reviews',
      { vendorId: 'не-uuid', stars: 5 },
    ],
  ]

  for (const [name, method, url, payload] of cases) {
    it(`${name}: не-uuid в теле даёт 422, а не ошибку драйвера базы`, async () => {
      const app = await buildApp(TEST_CONFIG)
      try {
        const res = await app.inject({ method, url, payload, headers: { 'idempotency-key': 'k' } })
        expect(res.statusCode).toBe(422)
      } finally {
        await app.close()
      }
    })
  }

  it('корректный uuid в теле проходит проверку дальше', async () => {
    // Иначе схема отсекала бы всё подряд и тесты выше проходили бы
    // по неверной причине.
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/join/tok/menu-vote',
        payload: { optionId: '0192f3a4-5b6c-7d8e-9f01-234567890abc' },
      })
      expect(res.statusCode).not.toBe(422)
    } finally {
      await app.close()
    }
  })

  it('пустое блюдо без id по-прежнему заводится: поле необязательное', async () => {
    // Новое блюдо приходит без `id`. Если бы схема требовала его всегда,
    // добавить блюдо стало бы нельзя вовсе.
    const app = await buildApp(TEST_CONFIG)
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/weddings/0192f3a4-5b6c-7d8e-9f01-234567890abc/menu-poll',
        payload: { options: [{ name: 'Рыба' }] },
      })
      expect(res.statusCode).not.toBe(422)
    } finally {
      await app.close()
    }
  })
})
