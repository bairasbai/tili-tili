import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { allowedRoles } from '../src/wedding/access.js'
import { inviteCode, referralCode } from '../src/wedding/codes.js'
import { SLOT_TEMPLATE, TASK_TEMPLATE, TIMELINE_TEMPLATE } from '../src/wedding/templates.generated.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 2: свадьба и команда', () => {
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

  /** Готовый пользователь: вошёл, согласие дано. */
  async function newUser(name?: string): Promise<{ token: string; id: string }> {
    const phone = nextPhone()
    const asked = await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    expect(asked.statusCode).toBe(200)
    const verified = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(verified.statusCode).toBe(200)
    const { accessToken, user } = verified.json()
    const c = await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(accessToken),
      payload: { policyVersion: '2026-09-02' },
    })
    expect(c.statusCode).toBe(201)
    if (name) {
      await app.inject({ method: 'PATCH', url: '/users/me', headers: auth(accessToken), payload: { name } })
    }
    return { token: accessToken, id: user.id }
  }

  async function createWedding(token: string, extra: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date: '2027-06-14',
        city: { name: 'Уфа', region: 'Башкортостан' },
        budgetTotal: { amount: 150_000_000, currency: 'RUB' },
        guestsPlanned: 80,
        style: 'нежная классика',
        ...extra,
      },
    })
    expect(res.statusCode).toBe(201)
    return res.json()
  }

  /** Приглашает нового человека в команду и возвращает его токен. */
  async function addMember(coupleToken: string, weddingId: string, role: string) {
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(coupleToken),
      payload: { role },
    })
    expect(invite.statusCode).toBe(201)
    const { code } = invite.json()
    const user = await newUser()
    const accepted = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(user.token) })
    expect(accepted.statusCode).toBe(200)
    return { ...user, code }
  }

  /* ── создание ─────────────────────────────────────────────────────── */
  it('свадьба создаётся с мозаикой, чек-листом и таймингом', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)

    expect(w.title).toBe('Алина ♥ Тимур')
    expect(w.city).toEqual({ name: 'Уфа', region: 'Башкортостан' })
    expect(w.budgetTotal).toEqual({ amount: 150_000_000, currency: 'RUB' })
    expect(w.members).toHaveLength(1)
    expect(w.members[0].role).toBe('couple')

    const counts = await app.db!.query<{ slots: string; tasks: string; events: string }>(
      `select (select count(*) from slots where wedding_id = $1)::text as slots,
              (select count(*) from tasks where wedding_id = $1)::text as tasks,
              (select count(*) from timeline_events where wedding_id = $1)::text as events`,
      [w.id],
    )
    expect(Number(counts.rows[0]!.slots)).toBe(SLOT_TEMPLATE.length)
    expect(Number(counts.rows[0]!.tasks)).toBe(TASK_TEMPLATE.length)
    expect(Number(counts.rows[0]!.events)).toBe(TIMELINE_TEMPLATE.length)
  })

  it('новой паре достаётся пустая мозаика, а не чужие брони', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    // В моке фронта площадка забронирована и пять задач сделаны — это демо
    // чужой свадьбы. У новой пары не должно быть ни сделок, ни отметок.
    const { rows } = await app.db!.query<{ done: string }>(
      'select count(*)::text as done from tasks where wedding_id = $1 and done_at is not null',
      [w.id],
    )
    expect(Number(rows[0]!.done)).toBe(0)
  })

  it('срок задачи считается от даты свадьбы', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token, { date: '2027-06-14' })
    const { rows } = await app.db!.query<{ due: string; title: string }>(
      `select due::text as due, title from tasks where wedding_id = $1 and period = '9' order by sort limit 1`,
      [w.id],
    )
    expect(rows[0]!.due).toBe('2026-09-14')
  })

  it('город берётся из справочника, выдуманный — 404', async () => {
    const { token } = await newUser()
    const res = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: { partnerName: 'Тимур', city: { name: 'Нью-Васюки', region: 'Нигде' } },
    })
    expect(res.statusCode).toBe(404)
  })

  /* ── главный критерий этапа: матрица доступа ──────────────────────── */
  it('helper не видит бюджет — 403, хотя бюджета ещё нет', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const helper = await addMember(token, w.id, 'helper')

    const res = await app.inject({
      method: 'GET',
      url: `/weddings/${w.id}/budget`,
      headers: auth(helper.token),
    })
    // Не 501: путь этапа 4 закрыт матрицей уже сейчас и не откроется
    // по недосмотру, когда обработчик появится.
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden')

    // Паре тот же путь открыт — значит дело в роли, а не в отсутствии пути.
    const couple = await app.inject({ method: 'GET', url: `/weddings/${w.id}/budget`, headers: auth(token) })
    expect(couple.statusCode).toBe(200)
  })

  it('матрица ролей на путях этапа', async () => {
    const { token: coupleToken } = await newUser('Алина')
    const w = await createWedding(coupleToken)
    const helper = await addMember(coupleToken, w.id, 'helper')
    const coordinator = await addMember(coupleToken, w.id, 'coordinator')
    const stranger = await newUser()

    const tokens: Record<string, string> = {
      couple: coupleToken,
      helper: helper.token,
      coordinator: coordinator.token,
    }

    // [метод, путь, что ожидает каждая роль]
    const table: [string, string, Record<string, number>][] = [
      ['GET', '', { couple: 200, helper: 200, coordinator: 200 }],
      ['PATCH', '', { couple: 200, helper: 403, coordinator: 403 }],
      ['GET', '/members', { couple: 200, helper: 200, coordinator: 200 }],
      ['GET', '/invites', { couple: 200, helper: 200, coordinator: 200 }],
      ['POST', '/invites', { couple: 201, helper: 403, coordinator: 403 }],
      ['GET', '/budget', { couple: 200, helper: 403, coordinator: 403 }],
      ['GET', '/wishlist', { couple: 501, helper: 403, coordinator: 403 }],
      ['GET', '/slots', { couple: 200, helper: 200, coordinator: 200 }],
      ['GET', '/documents', { couple: 200, helper: 403, coordinator: 403 }],
      ['GET', '/guests', { couple: 501, helper: 501, coordinator: 501 }],
    ]

    const wrong: string[] = []
    for (const [method, tail, expected] of table) {
      for (const [role, want] of Object.entries(expected)) {
        const res = await app.inject({
          method: method as 'GET',
          url: `/weddings/${w.id}${tail}`,
          headers: auth(tokens[role]!),
          ...(method === 'PATCH' ? { payload: { style: 'бохо' } } : {}),
          ...(method === 'POST' ? { payload: { role: 'helper' } } : {}),
        })
        if (res.statusCode !== want) wrong.push(`${role} ${method} ${tail || '/'} → ${res.statusCode}, ждали ${want}`)
      }
    }
    expect(wrong).toEqual([])

    // Посторонний не должен даже узнать, что такая свадьба есть.
    const outside = await app.inject({ method: 'GET', url: `/weddings/${w.id}`, headers: auth(stranger.token) })
    expect(outside.statusCode).toBe(404)
  })

  it('неописанный путь свадьбы по умолчанию закрыт всем, кроме пары', () => {
    // Запрет по умолчанию: путь следующего этапа не откроется помощнику
    // просто потому, что правило для него забыли написать.
    expect(allowedRoles('/weddings/:weddingId/что-то-новое', 'GET')).toEqual(['couple'])
    expect(allowedRoles('/weddings/:weddingId/budget', 'GET')).toEqual(['couple'])
    expect(allowedRoles('/weddings/:weddingId/guests', 'GET')).toContain('helper')
  })

  /* ── приглашения ──────────────────────────────────────────────────── */
  it('ссылка принимается ровно один раз', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(token),
      payload: { role: 'helper', label: 'Для Кати' },
    })
    const { code } = invite.json()

    const first = await newUser()
    const ok = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(first.token) })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().role).toBe('helper')

    const second = await newUser()
    const again = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(second.token) })
    expect(again.statusCode).toBe(410)

    // И второй человек в команду не попал.
    const members = await app.inject({ method: 'GET', url: `/weddings/${w.id}/members`, headers: auth(token) })
    expect(members.json()).toHaveLength(2)
  })

  it('просмотр приглашения не раскрывает, какие коды существовали', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(token),
      payload: { role: 'coordinator' },
    })
    const { code } = invite.json()

    const view = await app.inject({ method: 'GET', url: `/invites/${code}` })
    expect(view.statusCode).toBe(200)
    expect(view.json()).toMatchObject({ role: 'coordinator', weddingTitle: 'Алина ♥ Тимур', inviterName: 'Алина' })

    // Погашенный и несуществующий отвечают одинаково.
    const user = await newUser()
    await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(user.token) })
    const used = await app.inject({ method: 'GET', url: `/invites/${code}` })
    const missing = await app.inject({ method: 'GET', url: '/invites/ДРУГ-ZZZZ-ZZZZ' })
    expect(used.statusCode).toBe(410)
    expect(missing.statusCode).toBe(410)
    expect(used.json()).toEqual(missing.json())
  })

  it('отозванное приглашение не принимается', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(token),
      payload: { role: 'helper' },
    })
    const { code } = invite.json()

    expect((await app.inject({ method: 'DELETE', url: `/invites/${code}`, headers: auth(token) })).statusCode).toBe(204)

    const user = await newUser()
    const res = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(user.token) })
    expect(res.statusCode).toBe(410)
  })

  it('чужое приглашение отозвать нельзя', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(token),
      payload: { role: 'helper' },
    })
    const stranger = await newUser()
    const res = await app.inject({
      method: 'DELETE',
      url: `/invites/${invite.json().code}`,
      headers: auth(stranger.token),
    })
    expect(res.statusCode).toBe(404)
  })

  it('помощник не может выдать приглашение', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const helper = await addMember(token, w.id, 'helper')
    const res = await app.inject({
      method: 'POST',
      url: `/weddings/${w.id}/invites`,
      headers: auth(helper.token),
      payload: { role: 'couple' },
    })
    expect(res.statusCode).toBe(403)
  })

  /* ── участники ────────────────────────────────────────────────────── */
  it('роль участника меняет только пара', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const helper = await addMember(token, w.id, 'helper')

    const byHelper = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.id}/members/${helper.id}`,
      headers: auth(helper.token),
      payload: { role: 'couple' },
    })
    expect(byHelper.statusCode).toBe(403)

    const byCouple = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.id}/members/${helper.id}`,
      headers: auth(token),
      payload: { role: 'coordinator' },
    })
    expect(byCouple.statusCode).toBe(200)

    const members = await app.inject({ method: 'GET', url: `/weddings/${w.id}/members`, headers: auth(token) })
    expect(members.json().find((m: { user: { id: string } }) => m.user.id === helper.id).role).toBe('coordinator')
  })

  it('последнего участника с ролью «пара» убрать нельзя', async () => {
    const { token, id } = await newUser('Алина')
    const w = await createWedding(token)

    const demote = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.id}/members/${id}`,
      headers: auth(token),
      payload: { role: 'helper' },
    })
    expect(demote.statusCode).toBe(409)
    expect(demote.json().error.code).toBe('last_couple')

    const remove = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.id}/members/${id}`,
      headers: auth(token),
    })
    expect(remove.statusCode).toBe(409)
  })

  it('участника можно удалить, доступ пропадает сразу', async () => {
    const { token } = await newUser('Алина')
    const w = await createWedding(token)
    const helper = await addMember(token, w.id, 'helper')

    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${w.id}`, headers: auth(helper.token) })).statusCode,
    ).toBe(200)

    const res = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.id}/members/${helper.id}`,
      headers: auth(token),
    })
    expect(res.statusCode).toBe(204)

    expect(
      (await app.inject({ method: 'GET', url: `/weddings/${w.id}`, headers: auth(helper.token) })).statusCode,
    ).toBe(404)
  })

  /* ── рефералы ─────────────────────────────────────────────────────── */
  it('реферальный код выдаётся один и тот же', async () => {
    const { token } = await newUser('Алина')
    const first = await app.inject({ method: 'GET', url: '/users/me/referral', headers: auth(token) })
    const second = await app.inject({ method: 'GET', url: '/users/me/referral', headers: auth(token) })
    expect(first.statusCode).toBe(200)
    expect(first.json().code).toBe(second.json().code)
    expect(first.json()).toMatchObject({ invited: 0, earned: { amount: 0, currency: 'RUB' } })
  })

  it('чужой код применяется один раз, свой — никогда', async () => {
    const owner = await newUser('Алина')
    const { code } = (await app.inject({ method: 'GET', url: '/users/me/referral', headers: auth(owner.token) })).json()

    const own = await app.inject({ method: 'POST', url: `/referral/${code}/apply`, headers: auth(owner.token) })
    expect(own.statusCode).toBe(409)
    expect(own.json().error.code).toBe('own_code')

    const invited = await newUser()
    expect(
      (await app.inject({ method: 'POST', url: `/referral/${code}/apply`, headers: auth(invited.token) })).statusCode,
    ).toBe(200)
    const twice = await app.inject({ method: 'POST', url: `/referral/${code}/apply`, headers: auth(invited.token) })
    expect(twice.statusCode).toBe(409)
    expect(twice.json().error.code).toBe('referral_used')

    const stats = await app.inject({ method: 'GET', url: '/users/me/referral', headers: auth(owner.token) })
    expect(stats.json().invited).toBe(1)
  })

  it('несуществующий реферальный код — 404', async () => {
    const { token } = await newUser()
    const res = await app.inject({ method: 'POST', url: '/referral/ТИЛИ-НЕТУ/apply', headers: auth(token) })
    expect(res.statusCode).toBe(404)
  })
})

/* ── чистые функции ───────────────────────────────────────────────── */
describe('коды приглашений', () => {
  it('приставка называет роль, а тело читается вслух', () => {
    expect(inviteCode('helper')).toMatch(/^ДРУГ-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    expect(inviteCode('couple').startsWith('ПАРА-')).toBe(true)
    expect(inviteCode('vendor').startsWith('ПОДР-')).toBe(true)
  })

  it('в алфавите нет знаков, которые путают при переписывании', () => {
    const codes = Array.from({ length: 200 }, () => inviteCode('helper')).join('')
    for (const bad of ['0', 'O', '1', 'I', 'L', '5', 'S', '8', 'B']) {
      expect(codes.slice(5)).not.toContain(bad)
    }
  })

  it('коды не повторяются', () => {
    const codes = new Set(Array.from({ length: 500 }, () => inviteCode('helper')))
    expect(codes.size).toBe(500)
  })

  it('реферальный код берёт имя, а без имени — случайный', () => {
    expect(referralCode('Алина')).toBe('ТИЛИ-АЛИНА')
    expect(referralCode('Алина и Тимур')).toBe('ТИЛИ-АЛИНАИТИМУ')
    expect(referralCode(null)).toMatch(/^ТИЛИ-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    expect(referralCode('Li')).toMatch(/^ТИЛИ-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
    // Имён «Алина» много: второй такой код занять нельзя, но имя сохраняется.
    expect(referralCode('Алина', 1)).toMatch(/^ТИЛИ-АЛИНА-[ACDEFGHJKMNPQRTUVWXYZ234679]{4}$/)
  })
})
