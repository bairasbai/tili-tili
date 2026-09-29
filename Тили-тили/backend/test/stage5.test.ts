import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { personCount } from '../src/routes/guests.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('этап 5: гости, RSVP, рассадка, логистика, меню, альбом', () => {
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

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })
  const idem = (token: string) => ({ ...auth(token), 'idempotency-key': randomUUID() })

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

  async function newWedding() {
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
    const w = await app.inject({
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
    return { token, weddingId: w.json().id as string }
  }

  /** Гость с персональным токеном — так, как его получает живой человек. */
  async function newGuest(w: { token: string; weddingId: string }, name = 'Ольга', plusOne = false) {
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name, plusOne },
    })
    expect(created.statusCode).toBe(201)
    const guestId = created.json().id as string

    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    expect(link.statusCode).toBe(200)
    const code = (link.json().url as string).split('/').pop()!
    const exchanged = await app.inject({ method: 'GET', url: `/invite/${code}` })
    expect(exchanged.statusCode).toBe(200)
    return { guestId, token: exchanged.json().guestToken as string, code }
  }

  /* ── гости и токен ────────────────────────────────────────────────── */
  it('сырой токен гостя паре не отдаётся', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    const list = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
    })
    expect(list.statusCode).toBe(200)
    // Пара увидела бы резерв подарка гостя, открыв его страницу (ERR-0019).
    expect(list.body).not.toContain(guest.token)
    expect(list.body).not.toContain('rsvpToken')
    expect(list.json()[0].inviteUrlUsed).toBe(true)
  })

  it('одноразовая ссылка гаснет после обмена — за окном повтора', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)
    /* Внутри десяти минут тот же код отдаёт тот же токен: медленная сеть
       гасила ссылку впустую (ERR-0220, D3-07). За окном — 410. */
    const soon = await app.inject({ method: 'GET', url: `/invite/${guest.code}` })
    expect(soon.statusCode).toBe(200)
    expect(soon.json().guestToken).toBe(guest.token)
    await app.db!.query("update guest_invite_codes set used_at = now() - interval '11 minutes' where code = $1", [guest.code])
    const again = await app.inject({ method: 'GET', url: `/invite/${guest.code}` })
    expect(again.statusCode).toBe(410)
  })

  it('перевыпуск ссылки гасит прежнюю', async () => {
    const w = await newWedding()
    const created = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
      payload: { name: 'Катя' },
    })
    const guestId = created.json().id as string
    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    const firstCode = (first.json().url as string).split('/').pop()!
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/guests/${guestId}/invite-link`,
      headers: auth(w.token),
    })
    // Старая ссылка могла уйти не туда — она обязана перестать работать.
    expect((await app.inject({ method: 'GET', url: `/invite/${firstCode}` })).statusCode).toBe(410)
  })

  it('гость отвечает на приглашение без аккаунта', async () => {
    const w = await newWedding()
    const guest = await newGuest(w, 'Ольга', true)

    const page = await app.inject({ method: 'GET', url: `/rsvp/${guest.token}` })
    expect(page.statusCode).toBe(200)
    expect(page.json()).toMatchObject({ guestName: 'Ольга', status: 'pending' })
    // Гость видит свою свадьбу, но не список остальных гостей и не бюджет.
    expect(page.body).not.toContain('budget')
    expect(page.body).not.toContain('guests')

    const answer = await app.inject({
      method: 'POST',
      url: `/rsvp/${guest.token}`,
      payload: { status: 'yes', plusOne: true, diet: 'vegetarian', transfer: 'need' },
    })
    expect(answer.statusCode).toBe(200)

    const list = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/guests`,
      headers: auth(w.token),
    })
    const people = list.json() as { name: string; status: string; plusOne: boolean; diet: string | null; transfer: string | null }[]
    expect(people).toHaveLength(2)
    expect(people.find((p) => p.name === 'Ольга')).toMatchObject({ status: 'yes', plusOne: true, diet: 'vegetarian', transfer: 'need' })
    expect(people.find((p) => p.name !== 'Ольга')).toMatchObject({ status: 'pending' })
  })

  it('чужой токен не открывает страницу', async () => {
    const res = await app.inject({ method: 'GET', url: '/rsvp/выдуманный-токен' })
    expect(res.statusCode).toBe(401)
  })

  /* ── рассадка ─────────────────────────────────────────────────────── */
  it('состав стола вычисляется из назначений, а не хранится', async () => {
    const w = await newWedding()
    const a = await newGuest(w, 'Ольга')
    const b = await newGuest(w, 'Денис')
    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол 1', capacity: 6 },
    })
    expect(table.statusCode).toBe(201)
    const tableId = table.json().id as string

    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${a.guestId}`,
      headers: auth(w.token),
      payload: { tableId },
    })

    const seating = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
    })
    expect(seating.json()[0].guestIds).toEqual([a.guestId])

    // Пересадка не оставляет человека за двумя столами (ERR-0016).
    const second = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
      payload: { name: 'Стол 2' },
    })
    await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/guests/${a.guestId}`,
      headers: auth(w.token),
      payload: { tableId: second.json().id },
    })
    const after = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/tables`,
      headers: auth(w.token),
    })
    const seats = (after.json() as { guestIds: string[] }[]).flatMap((t) => t.guestIds)
    expect(seats.filter((id) => id === a.guestId)).toHaveLength(1)
    expect(seats).not.toContain(b.guestId)
  })

  it('стол чужой свадьбы гостю не назначить', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const guest = await newGuest(mine)
    const table = await app.inject({
      method: 'POST',
      url: `/weddings/${other.weddingId}/tables`,
      headers: auth(other.token),
      payload: { name: 'Чужой' },
    })
    const res = await app.inject({
      method: 'PATCH',
      url: `/weddings/${mine.weddingId}/guests/${guest.guestId}`,
      headers: auth(mine.token),
      payload: { tableId: table.json().id },
    })
    expect(res.statusCode).toBe(404)
  })

  /* ── главный критерий: места в автобусе ───────────────────────────── */
  it('21 параллельная запись в автобус на 20 мест — ровно 20 успешных', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус №1', from: 'Гостиный двор', time: '14:30', seats: 20 },
    })
    expect(bus.statusCode).toBe(201)
    const busId = bus.json().id as string

    const guests = []
    for (let i = 0; i < 21; i++) guests.push(await newGuest(w, `Гость ${i}`))

    const results = await Promise.all(
      guests.map((g) =>
        app.inject({
          method: 'POST',
          url: `/join/${g.token}/shuttle`,
          headers: { 'idempotency-key': randomUUID() },
          payload: { busId },
        }),
      ),
    )
    const ok = results.filter((r) => r.statusCode === 200)
    const full = results.filter((r) => r.statusCode === 409)
    expect(ok).toHaveLength(20)
    expect(full).toHaveLength(1)
    expect(full[0]!.json().error.code).toBe('bus_full')

    const { rows } = await app.db!.query<{ taken: number; booked: string }>(
      `select b.taken, (select count(*)::text from bus_bookings k where k.bus_id = b.id) as booked
         from bus_routes b where b.id = $1`,
      [busId],
    )
    // Счётчик и число записей обязаны совпадать: расхождение означает,
    // что кто-то едет без места или место пропало.
    expect(rows[0]!.taken).toBe(20)
    expect(Number(rows[0]!.booked)).toBe(20)
  })

  it('повторная запись в тот же автобус не занимает второе место', async () => {
    const w = await newWedding()
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/buses`,
      headers: auth(w.token),
      payload: { name: 'Автобус', seats: 5 },
    })
    const busId = bus.json().id as string
    const guest = await newGuest(w)

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `/join/${guest.token}/shuttle`,
        headers: { 'idempotency-key': randomUUID() },
        payload: { busId },
      })
      expect(res.statusCode).toBe(200)
    }
    const { rows } = await app.db!.query<{ taken: number }>('select taken from bus_routes where id = $1', [busId])
    expect(rows[0]!.taken).toBe(1)
  })

  /* ── главный критерий: голос за блюдо ─────────────────────────────── */
  it('повтор menu-vote меняет голос, а сумма не растёт', async () => {
    const w = await newWedding()
    const poll = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
      payload: {
        question: 'Что будете на горячее?',
        options: [{ name: 'Рыба', icon: '🐟' }, { name: 'Мясо', icon: '🥩' }],
      },
    })
    expect(poll.statusCode).toBe(200)
    const [fish, meat] = poll.json().options as { id: string }[]
    const guest = await newGuest(w)

    for (const optionId of [fish!.id, meat!.id, fish!.id]) {
      const res = await app.inject({
        method: 'POST',
        url: `/join/${guest.token}/menu-vote`,
        payload: { optionId },
      })
      expect(res.statusCode).toBe(200)
    }

    const result = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/menu-poll`,
      headers: auth(w.token),
    })
    const options = result.json().options as { id: string; votes: number }[]
    expect(options.reduce((a, o) => a + o.votes, 0)).toBe(1)
    expect(options.find((o) => o.id === fish!.id)!.votes).toBe(1)
    expect(options.find((o) => o.id === meat!.id)!.votes).toBe(0)
  })

  it('блюда чужого опроса выбрать нельзя', async () => {
    const mine = await newWedding()
    const other = await newWedding()
    const poll = await app.inject({
      method: 'PUT',
      url: `/weddings/${other.weddingId}/menu-poll`,
      headers: auth(other.token),
      payload: { options: [{ name: 'Чужое' }] },
    })
    const guest = await newGuest(mine)
    const res = await app.inject({
      method: 'POST',
      url: `/join/${guest.token}/menu-vote`,
      payload: { optionId: poll.json().options[0].id },
    })
    expect(res.statusCode).toBe(404)
  })

  /* ── главный критерий: дебаунс рассылки ───────────────────────────── */
  it('notify-pickup дважды за 30 секунд — одна рассылка', async () => {
    const w = await newWedding()
    const first = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/notify-pickup`,
      headers: idem(w.token),
    })
    // Второе нажатие приходит со СВОИМ ключом — идемпотентность его
    // не поймает, ловит дебаунс.
    const second = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/notify-pickup`,
      headers: idem(w.token),
    })
    expect(first.statusCode).toBe(202)
    expect(second.statusCode).toBe(202)
    expect(first.json().debounced).toBe(false)
    expect(second.json().debounced).toBe(true)

    const { rows } = await app.db!.query<{ n: number }>(
      "select count(*)::int as n from broadcasts where wedding_id = $1 and action = 'notify-pickup'",
      [w.weddingId],
    )
    expect(rows[0]!.n).toBe(1)
  })

  it('через полминуты рассылка снова возможна', async () => {
    const w = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/menu-poll/remind`,
      headers: idem(w.token),
    })
    await app.db!.query("update broadcasts set created_at = now() - interval '2 minutes' where wedding_id = $1", [
      w.weddingId,
    ])
    const again = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/menu-poll/remind`,
      headers: idem(w.token),
    })
    expect(again.json().debounced).toBe(false)
  })

  /* ── чек-лист ─────────────────────────────────────────────────────── */
  it('задачи шаблона отмечаются, но не удаляются', async () => {
    const w = await newWedding()
    const tasks = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/tasks`,
      headers: auth(w.token),
    })
    const list = tasks.json() as { id: string; custom: boolean; done: boolean }[]
    expect(list).toHaveLength(12)
    expect(list.every((t) => !t.custom && !t.done)).toBe(true)

    const marked = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/tasks/${list[0]!.id}`,
      headers: auth(w.token),
      payload: { done: true },
    })
    expect(marked.json().done).toBe(true)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/weddings/${w.weddingId}/tasks/${list[0]!.id}`,
      headers: auth(w.token),
    })
    expect(removed.statusCode).toBe(409)
    expect(removed.json().error.code).toBe('system_task')

    const own = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/tasks`,
      headers: auth(w.token),
      payload: { title: 'Забрать кольца', period: '1' },
    })
    expect(own.json().custom).toBe(true)
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/weddings/${w.weddingId}/tasks/${own.json().id}`,
          headers: auth(w.token),
        })
      ).statusCode,
    ).toBe(204)
  })

  /* ── тайминг ──────────────────────────────────────────────────────── */
  it('021: тайминг заменяется целиком без смены ID, автоплан только предлагает', async () => {
    const w = await newWedding()
    const before = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const initial = before.json() as { id: string }[]
    expect(initial.length).toBe(6)
    expect(before.headers.etag).toMatch(/^"timeline-\d+"$/)

    const replaced = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': before.headers.etag! },
      payload: [
        {
          id: initial[0]!.id,
          name: 'Сборы',
          startsAt: '2027-06-14T05:00:00Z',
          endsAt: '2027-06-14T09:00:00Z',
          timingMode: 'flexible',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [],
        },
        {
          id: initial[1]!.id,
          name: 'Церемония',
          startsAt: '2027-06-14T10:00:00Z',
          endsAt: '2027-06-14T11:00:00Z',
          outdoor: true,
          timingMode: 'fixed',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [{ eventId: initial[0]!.id, travelMinutes: 30, bufferMinutes: 30 }],
        },
      ],
    })
    expect(replaced.statusCode).toBe(200)
    const saved = replaced.json() as { id: string; name: string }[]
    expect(saved.map((event) => event.id)).toEqual([initial[0]!.id, initial[1]!.id])
    expect(replaced.headers.etag).toMatch(/^"timeline-\d+"$/)
    expect(replaced.headers.etag).not.toBe(before.headers.etag)

    const auto = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/timeline/autogen`,
      headers: auth(w.token),
    })
    // Временного конфликта нет; штатное предупреждение о незабронированной
    // команде остаётся частью autogen и не является конфликтом графа.
    expect(auto.json().conflicts).toEqual(['Команда ещё не забронирована — план собран без исполнителей'])

    // И автоплан ничего не переписал: контракт обещает предпросмотр.
    const still = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const persisted = still.json() as { id: string; name: string }[]
    expect(persisted.map((e) => e.name)).toEqual(['Сборы', 'Церемония'])
    expect(persisted.map((e) => e.id)).toEqual(saved.map((e) => e.id))
  })

  it('021: stale вкладка получает 409 и не затирает более свежий тайминг', async () => {
    const w = await newWedding()
    const tabA = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const tabB = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    expect(tabA.headers.etag).toBe(tabB.headers.etag)
    const original = tabA.json() as {
      id: string
      name: string
      startsAt?: string | null
      endsAt?: string | null
      forGuests?: boolean
      timingMode?: 'fixed' | 'flexible'
      assigneeUserIds?: string[]
      dealIds?: string[]
      dependsOn?: { eventId: string; travelMinutes: number; bufferMinutes: number }[]
    }[]
    const first = original[0]!

    const accepted = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': tabA.headers.etag! },
      payload: original.map((event, index) => ({
        id: event.id,
        name: index === 0 ? 'Правка из вкладки A' : event.name,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        forGuests: event.forGuests ?? true,
        timingMode: event.timingMode ?? 'flexible',
        assigneeUserIds: event.assigneeUserIds ?? [],
        dealIds: event.dealIds ?? [],
        dependsOn: event.dependsOn ?? [],
      })),
    })
    expect(accepted.statusCode, accepted.body).toBe(200)
    expect(accepted.headers.etag).not.toBe(tabA.headers.etag)

    const stale = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': tabB.headers.etag! },
      payload: original.map((event, index) => ({
        id: event.id,
        name: index === 0 ? 'Устаревшая правка из вкладки B' : event.name,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        forGuests: event.forGuests ?? true,
        timingMode: event.timingMode ?? 'flexible',
        assigneeUserIds: event.assigneeUserIds ?? [],
        dealIds: event.dealIds ?? [],
        dependsOn: event.dependsOn ?? [],
      })),
    })
    expect(stale.statusCode, stale.body).toBe(409)
    expect(stale.json().error.code).toBe('timeline_version_conflict')
    expect(stale.headers.etag).toBe(accepted.headers.etag)

    const finalState = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const finalEvents = finalState.json() as { id: string; name: string }[]
    expect(finalEvents[0]).toEqual({ ...finalEvents[0], id: first.id, name: 'Правка из вкладки A' })
    expect(finalState.headers.etag).toBe(accepted.headers.etag)
  })

  it('021: DAG сохраняет переезд/запас, а цикл отклоняется без изменения версии', async () => {
    const w = await newWedding()
    const before = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const initial = before.json() as { id: string; name: string }[]
    const [parent, child] = initial
    expect(parent && child).toBeTruthy()

    const saved = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': before.headers.etag! },
      payload: [
        {
          id: parent!.id,
          name: 'Фотосессия',
          startsAt: '2027-06-14T08:00:00Z',
          endsAt: '2027-06-14T09:00:00Z',
          forGuests: false,
          timingMode: 'flexible',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [],
        },
        {
          id: child!.id,
          name: 'Церемония',
          startsAt: '2027-06-14T10:00:00Z',
          endsAt: '2027-06-14T11:00:00Z',
          forGuests: true,
          timingMode: 'fixed',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [{ eventId: parent!.id, travelMinutes: 30, bufferMinutes: 15 }],
        },
      ],
    })
    expect(saved.statusCode, saved.body).toBe(200)
    const body = saved.json() as { id: string; timingMode: string; dependsOn: unknown[] }[]
    expect(body[1]).toMatchObject({
      id: child!.id,
      timingMode: 'fixed',
      dependsOn: [{ eventId: parent!.id, travelMinutes: 30, bufferMinutes: 15 }],
    })

    const cycle = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: { ...auth(w.token), 'if-match': saved.headers.etag! },
      payload: [
        {
          id: parent!.id,
          name: 'Фотосессия',
          startsAt: '2027-06-14T08:00:00Z',
          endsAt: '2027-06-14T09:00:00Z',
          forGuests: false,
          timingMode: 'flexible',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [{ eventId: child!.id, travelMinutes: 0, bufferMinutes: 0 }],
        },
        {
          id: child!.id,
          name: 'Церемония',
          startsAt: '2027-06-14T10:00:00Z',
          endsAt: '2027-06-14T11:00:00Z',
          forGuests: true,
          timingMode: 'fixed',
          assigneeUserIds: [],
          dealIds: [],
          dependsOn: [{ eventId: parent!.id, travelMinutes: 30, bufferMinutes: 15 }],
        },
      ],
    })
    expect(cycle.statusCode, cycle.body).toBe(422)
    expect(cycle.json().error.code).toBe('validation_failed')

    const after = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    expect(after.headers.etag).toBe(saved.headers.etag)
    expect(after.body).toBe(saved.body)
  })

  it('021: нельзя назначить участника другой свадьбы на блок тайминга', async () => {
    const own = await newWedding()
    const foreign = await newWedding()
    const foreignMembers = await app.inject({
      method: 'GET',
      url: `/weddings/${foreign.weddingId}/members`,
      headers: auth(foreign.token),
    })
    const foreignUserId = foreignMembers.json()[0].user.id as string

    const before = await app.inject({
      method: 'GET',
      url: `/weddings/${own.weddingId}/timeline`,
      headers: auth(own.token),
    })
    const events = before.json() as { id: string; name: string; startsAt?: string | null; endsAt?: string | null; forGuests?: boolean }[]
    const attempted = await app.inject({
      method: 'PUT',
      url: `/weddings/${own.weddingId}/timeline`,
      headers: { ...auth(own.token), 'if-match': before.headers.etag! },
      payload: events.map((event, index) => ({
        id: event.id,
        name: event.name,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        forGuests: event.forGuests ?? true,
        timingMode: 'flexible',
        assigneeUserIds: index === 0 ? [foreignUserId] : [],
        dealIds: [],
        dependsOn: [],
      })),
    })
    expect(attempted.statusCode, attempted.body).toBe(422)
    expect(attempted.json().error.fields.assigneeUserIds).toBeTruthy()
  })

  it('021: full PUT без версии не меняет тайминг', async () => {
    const w = await newWedding()
    const before = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    const attempted = await app.inject({
      method: 'PUT',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
      payload: [],
    })
    expect(attempted.statusCode, attempted.body).toBe(428)
    expect(attempted.json().error.code).toBe('timeline_version_required')

    const after = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/timeline`,
      headers: auth(w.token),
    })
    expect(after.body).toBe(before.body)
    expect(after.headers.etag).toBe(before.headers.etag)
  })

  /* ── альбом ───────────────────────────────────────────────────────── */
  it('гость добавляет кадр, паре виден сразу, гостям — после одобрения', async () => {
    const w = await newWedding()
    const guest = await newGuest(w)

    const added = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
      payload: { fileUrl: 'https://storage.test/photo.jpg', consent: true },
    })
    expect(added.statusCode).toBe(201)
    expect(added.json().approved).toBe(false)

    const forCouple = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/album`,
      headers: auth(w.token),
    })
    expect((forCouple.json() as unknown[]).length).toBe(1)

    const forGuest = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
    })
    expect(forGuest.json()).toEqual([])

    const approved = await app.inject({
      method: 'PATCH',
      url: `/weddings/${w.weddingId}/album/${added.json().id}`,
      headers: auth(w.token),
      payload: { approved: true },
    })
    expect(approved.json().approved).toBe(true)

    const now = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
    })
    expect((now.json() as unknown[]).length).toBe(1)
  })

  it('кадр без согласия не принимается, чужой токен не пускает', async () => {
    const w = await newWedding()
    const other = await newWedding()
    const guest = await newGuest(w)
    const stranger = await newGuest(other)

    const noConsent = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(guest.token)}`,
      payload: { fileUrl: 'https://storage.test/a.jpg', consent: false },
    })
    expect(noConsent.statusCode).toBe(422)

    const foreign = await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/album?guestToken=${encodeURIComponent(stranger.token)}`,
      payload: { fileUrl: 'https://storage.test/a.jpg', consent: true },
    })
    expect(foreign.statusCode).toBe(404)

    const anonymous = await app.inject({
      method: 'GET',
      url: `/weddings/${w.weddingId}/album`,
    })
    expect(anonymous.statusCode).toBe(401)
  })

  /* ── отели ────────────────────────────────────────────────────────── */
  it('гость видит отельные блоки своей свадьбы', async () => {
    const w = await newWedding()
    await app.inject({
      method: 'POST',
      url: `/weddings/${w.weddingId}/logistics/hotels`,
      headers: auth(w.token),
      payload: {
        name: 'Отель «Ривьера»',
        rooms: 10,
        price: { amount: 450_000, currency: 'RUB' },
        deadline: '2027-05-14',
        promo: 'TILI10',
      },
    })
    const guest = await newGuest(w)
    const res = await app.inject({ method: 'GET', url: `/join/${guest.token}/hotels` })
    expect(res.statusCode).toBe(200)
    expect(res.json()[0]).toMatchObject({ name: 'Отель «Ривьера»', rooms: 10, booked: 0, promo: 'TILI10' })
  })
})

/* ── чистая функция ───────────────────────────────────────────────── */
describe('счётчик персон', () => {
  it('020: считает реальные person rows ровно один раз и игнорирует deprecated plusOne', () => {
    expect(
      personCount([
        { status: 'yes', plusOne: true },
        { status: 'yes', plusOne: false },
        { status: 'no', plusOne: true },
        { status: 'pending', plusOne: false },
      ]),
    ).toBe(2)
  })

  it('пустой список — ноль персон', () => {
    expect(personCount([])).toBe(0)
  })
})
