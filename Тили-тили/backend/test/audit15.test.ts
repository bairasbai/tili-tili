import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { randomInt } from 'node:crypto'
import webpush from 'web-push'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { REFRESH_GRACE_MS } from '../src/routes/auth.js'
import { expireStaleHolds } from '../src/jobs/index.js'
import { sendDuePushes } from '../src/notify/push.js'
import { uuidv7 } from '../src/ids.js'

/**
 * Регрессии аудита 2026-09-06, блок 2 (корректность бэкенда).
 *
 * Транзакции проверяются инъекцией сбоя: временный триггер роняет второй
 * шаг, и первый обязан откатиться. Гонки — двумя параллельными запросами.
 * Каждый набор краснел без своего исправления — проверено снятием фикса.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)

describe.skipIf(!live)('блок 2: транзакции, гонки, рассылки', () => {
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
  const key = () => ({ 'idempotency-key': `k-${RUN}-${++counter}` })
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
    const v = await app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone, code: await readCode(phone) } })
    const body = v.json() as { accessToken: string; refreshToken: string; user: { id: string } }
    await app.inject({ method: 'POST', url: '/users/me/consent', headers: auth(body.accessToken), payload: { policyVersion: '2026-09-02' } })
    return { token: body.accessToken, refresh: body.refreshToken, userId: body.user.id, phone }
  }

  async function newWedding(token: string, date = '2027-11-06') {
    const created = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(token),
      payload: {
        partnerName: 'Тимур',
        date,
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    expect(created.statusCode).toBe(201)
    return created.json().id as string
  }

  async function newVendor(categoryId: string) {
    const owner = await newUser()
    const profile = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(owner.token),
      payload: { name: `${categoryId} ${RUN}-${++counter}`, categoryId, city: { name: 'Казань', region: 'Татарстан' } },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(owner.token) })
    return { owner, vendorId: profile.json().id as string, name: profile.json().name as string }
  }

  async function bookSlot(token: string, weddingId: string, categoryId: string, vendorId: string, price: number) {
    const slots = (await app.inject({ method: 'GET', url: `/weddings/${weddingId}/slots`, headers: auth(token) })).json() as {
      id: string
      categoryId: string
    }[]
    const slot = slots.find((s) => s.categoryId === categoryId)!
    const booked = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/slots/${slot.id}/book`,
      headers: { ...auth(token), ...key() },
      payload: { vendorId, price: { amount: price, currency: 'RUB' } },
    })
    expect(booked.statusCode).toBe(200)
    return { slotId: slot.id, dealId: booked.json().deal.id as string }
  }

  /**
   * Инъекция сбоя: временный триггер роняет запись, попадающую под условие.
   * Имя уникально на прогон, условие — по идентификатору, поэтому соседние
   * наборы, идущие параллельно, его не замечают. Снимается в finally.
   */
  async function withFault(
    table: string,
    event: 'insert' | 'update' | 'delete',
    condition: string,
    fn: () => Promise<void>,
  ): Promise<void> {
    const name = `audit15_fault_${RUN}_${++counter}`
    await app.db!.query(
      `create function ${name}() returns trigger language plpgsql as $$
         begin
           if ${condition} then raise exception 'fault injected by audit15'; end if;
           return coalesce(new, old);
         end $$`,
    )
    await app.db!.query(`create trigger ${name} before ${event} on ${table} for each row execute function ${name}()`)
    try {
      await fn()
    } finally {
      await app.db!.query(`drop trigger if exists ${name} on ${table}`)
      await app.db!.query(`drop function if exists ${name}()`)
    }
  }

  /* ── транзакции ───────────────────────────────────────────────────── */

  it('приём приглашения: сбой на вступлении в команду не гасит одноразовый код', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'helper' },
    })
    const code = invite.json().code as string
    const helper = await newUser()

    await withFault('wedding_members', 'insert', `new.wedding_id = '${weddingId}'`, async () => {
      const failed = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(helper.token) })
      expect(failed.statusCode).toBe(500)
    })
    // До фикса код был уже погашен, а человека в команде не было: второй
    // переход по той же ссылке отвечал 410, и другой ссылки у него нет.
    const retry = await app.inject({ method: 'POST', url: `/invites/${code}/accept`, headers: auth(helper.token) })
    expect(retry.statusCode).toBe(200)
    expect(retry.json().role).toBe('helper')
  })

  it('RSVP «не приду»: сбой на освобождении места не оставляет «не приду» с занятым сиденьем', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(couple.token),
      payload: { name: 'Марина' },
    })
    const guestId = guest.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests/${guestId}/invite-link`,
      headers: auth(couple.token),
    })
    const shareCode = (link.json().url as string).split('/').pop()!
    const redeemed = await app.inject({ method: 'GET', url: `/invite/${shareCode}` })
    const token = redeemed.json().guestToken as string
    const bus = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/logistics/buses`,
      headers: auth(couple.token),
      payload: { name: 'Автобус', seats: 10 },
    })
    const busId = bus.json().id as string
    expect((await app.inject({ method: 'POST', url: `/rsvp/${token}`, payload: { status: 'yes' } })).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'POST', url: `/join/${token}/shuttle`, headers: key(), payload: { busId } })).statusCode,
    ).toBe(200)

    await withFault('bus_bookings', 'delete', `old.guest_id = '${guestId}'`, async () => {
      const failed = await app.inject({ method: 'POST', url: `/rsvp/${token}`, payload: { status: 'no' } })
      expect(failed.statusCode).toBe(500)
    })
    const { rows } = await app.db!.query<{ rsvp: string; seats: string }>(
      `select g.rsvp, (select count(*)::text from bus_bookings b where b.guest_id = g.id) as seats
         from guests g where g.id = $1`,
      [guestId],
    )
    // До фикса: rsvp = 'no', место по-прежнему занято.
    expect(rows[0]).toEqual({ rsvp: 'yes', seats: '1' })
  })

  it('голос за меню: сбой на отметке у гостя не оставляет голос без отметки', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const guest = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(couple.token),
      payload: { name: 'Олег' },
    })
    const guestId = guest.json().id as string
    const link = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests/${guestId}/invite-link`,
      headers: auth(couple.token),
    })
    const token = (await app.inject({ method: 'GET', url: `/invite/${(link.json().url as string).split('/').pop()!}` })).json()
      .guestToken as string
    await app.inject({
      method: 'PUT',
      url: `/weddings/${weddingId}/menu-poll`,
      headers: auth(couple.token),
      payload: { options: [{ name: 'Рыба' }, { name: 'Мясо' }] },
    })
    const poll = (await app.inject({ method: 'GET', url: `/join/${token}/menu-vote` })).json() as { options: { id: string }[] }
    const optionId = poll.options[0]!.id

    await withFault('guests', 'update', `new.id = '${guestId}' and new.menu_option_id is not null`, async () => {
      const failed = await app.inject({ method: 'POST', url: `/join/${token}/menu-vote`, payload: { optionId } })
      expect(failed.statusCode).toBe(500)
    })
    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from menu_votes where guest_id = $1', [guestId])
    // До фикса голос уже лежал в menu_votes, а у гостя выбора не было.
    expect(rows[0]!.n).toBe('0')
  })

  it('истечение мягкой брони: сбой на записи в журнал не снимает бронь молча', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const vendor = await newVendor('photo')
    const { dealId } = await bookSlot(couple.token, weddingId, 'photo', vendor.vendorId, 1_000_000)
    // Бронь — прямо в базе: обратно из booked переходов нет.
    await app.db!.query(
      `update deals set state = 'negotiating', negotiating_until = now() - interval '1 hour' where id = $1`,
      [dealId],
    )
    await withFault('deal_events', 'insert', `new.deal_id = '${dealId}'`, async () => {
      await expect(expireStaleHolds(app)).rejects.toThrow('fault injected')
    })
    const { rows } = await app.db!.query<{ state: string }>('select state from deals where id = $1', [dealId])
    // До фикса сделка уже стала candidate без записи — и без уведомления.
    expect(rows[0]!.state).toBe('negotiating')
    // После снятия сбоя повтор задачи снимает бронь и пишет событие.
    await expireStaleHolds(app)
    const { rows: after } = await app.db!.query<{ state: string; events: string }>(
      `select state, (select count(*)::text from deal_events e where e.deal_id = d.id and e.to_state = 'candidate') as events
         from deals d where id = $1`,
      [dealId],
    )
    expect(after[0]).toEqual({ state: 'candidate', events: '1' })
  })

  it('удаление аккаунта: сбой на записи в журнал не оставляет аккаунт удалённым наполовину', async () => {
    const user = await newUser()
    await withFault('audit_log', 'insert', `new.actor_id = '${user.userId}' and new.action = 'user.deleted'`, async () => {
      const failed = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(user.token) })
      expect(failed.statusCode).toBe(500)
    })
    const { rows } = await app.db!.query<{ deleted: boolean; live: string }>(
      `select (deleted_at is not null) as deleted,
              (select count(*)::text from sessions s where s.user_id = u.id and s.revoked_at is null) as live
         from users u where id = $1`,
      [user.userId],
    )
    expect(rows[0]).toEqual({ deleted: false, live: '1' })
  })

  it('жалоба: сбой на санкции не оставляет жалобу «разобранной» без санкции', async () => {
    const staff = await newUser()
    await app.db!.query('update users set is_staff = true where id = $1', [staff.userId])
    const vendor = await newVendor('decor')
    const reporter = await newUser()
    const complaint = await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(reporter.token),
      payload: { targetKind: 'vendor', targetId: vendor.vendorId, category: 'fraud', text: 'проверка' },
    })
    expect(complaint.statusCode).toBe(201)
    // Ответ идентификатор не отдаёт (контракт: 201 без тела) — берём из базы.
    const { rows: found } = await app.db!.query<{ id: string }>(
      "select id from complaints where target_id = $1 and status = 'new' order by created_at desc limit 1",
      [vendor.vendorId],
    )
    const complaintId = found[0]!.id

    await withFault('vendors', 'update', `new.id = '${vendor.vendorId}' and new.blocked_at is not null`, async () => {
      const failed = await app.inject({
        method: 'POST',
        url: `/admin/complaints/${complaintId}`,
        headers: auth(staff.token),
        payload: { action: 'block' },
      })
      expect(failed.statusCode).toBe(500)
    })
    const { rows } = await app.db!.query<{ status: string; blocked: boolean }>(
      `select c.status, (v.blocked_at is not null) as blocked
         from complaints c join vendors v on v.id = c.target_id::uuid where c.id = $1`,
      [complaintId],
    )
    // До фикса: status = 'resolved', blocked = false — жалобу больше никто не откроет.
    expect(rows[0]).toEqual({ status: 'new', blocked: false })
  })

  /* ── гонки ────────────────────────────────────────────────────────── */

  it('две одновременные оплаты не дают заплатить больше цены', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const vendor = await newVendor('photo')
    const { slotId, dealId } = await bookSlot(couple.token, weddingId, 'photo', vendor.vendorId, 100_000)
    const pay = () =>
      app.inject({
        method: 'POST',
        url: `/weddings/${weddingId}/slots/${slotId}/pay`,
        headers: { ...auth(couple.token), ...key() },
        payload: { amount: { amount: 60_000, currency: 'RUB' } },
      })
    const [a, b] = await Promise.all([pay(), pay()])
    const codes = [a.statusCode, b.statusCode].sort()
    // До фикса: [200, 200] и в payments 120 000 при цене 100 000.
    expect(codes).toEqual([200, 409])
    const { rows } = await app.db!.query<{ total: string }>(
      "select coalesce(sum(amount), 0)::text as total from payments where deal_id = $1 and status <> 'cancelled'",
      [dealId],
    )
    expect(Number(rows[0]!.total)).toBeLessThanOrEqual(100_000)
  })

  it('два одновременных перехода сделки дают одну запись в журнале', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    const vendor = await newVendor('video')
    const { dealId } = await bookSlot(couple.token, weddingId, 'video', vendor.vendorId, 500_000)
    const move = () =>
      app.inject({
        method: 'PATCH',
        url: `/deals/${dealId}`,
        headers: { ...auth(couple.token), ...key() },
        payload: { state: 'done' },
      })
    const [a, b] = await Promise.all([move(), move()])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    const { rows } = await app.db!.query<{ n: string }>(
      "select count(*)::text as n from deal_events where deal_id = $1 and to_state = 'done'",
      [dealId],
    )
    expect(rows[0]!.n).toBe('1')
  })

  it('два одновременных напоминания гостям — одна рассылка, второе 429', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token)
    for (const name of ['Аня', 'Боря']) {
      const g = await app.inject({
        method: 'POST',
        url: `/weddings/${weddingId}/guests`,
        headers: auth(couple.token),
        payload: { name, phone: `+7917${String(randomInt(1_000_000, 9_999_999))}` },
      })
      await app.inject({
        method: 'POST',
        url: `/weddings/${weddingId}/guests/${g.json().id as string}/invite-link`,
        headers: auth(couple.token),
      })
    }
    const remind = () => app.inject({ method: 'POST', url: `/weddings/${weddingId}/guests/remind`, headers: auth(couple.token) })
    const [a, b] = await Promise.all([remind(), remind()])
    const ok = [a, b].find((r) => r.statusCode === 200)
    const refused = [a, b].find((r) => r.statusCode === 429)
    // До фикса оба проходили проверку «не чаще раза в сутки» и каждому гостю уходило два SMS.
    expect(ok?.json().sent).toBe(2)
    expect(refused?.json().error.code).toBe('too_often')
  })

  /* ── refresh из двух вкладок ──────────────────────────────────────── */

  it('прежний refresh через секунды после обмена — 401 без гашения сессий; позже — кража', async () => {
    const user = await newUser()
    const rotated = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refresh } })
    expect(rotated.statusCode).toBe(200)
    const fresh = rotated.json() as { accessToken: string }

    // Вторая вкладка проснулась со старым токеном.
    const second = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refresh } })
    expect(second.statusCode).toBe(401)
    expect(second.json().error.code).toBe('refresh_superseded')
    // Свежая пара первой вкладки жива, ничего не погашено.
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: auth(fresh.accessToken) })).statusCode).toBe(200)
    const { rows: live } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from sessions where user_id = $1 and revoked_at is null',
      [user.userId],
    )
    expect(live[0]!.n).toBe('1')

    // За пределами окна тот же токен — уже кража: всё гасится.
    await app.db!.query(`update sessions set rotated_at = now() - ($2 || ' milliseconds')::interval where user_id = $1`, [
      user.userId,
      String(REFRESH_GRACE_MS + 1000),
    ])
    const theft = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refresh } })
    expect(theft.statusCode).toBe(401)
    expect(theft.json().error.code).toBe('unauthorized')
    expect((await app.inject({ method: 'GET', url: '/users/me', headers: auth(fresh.accessToken) })).statusCode).toBe(401)
  })

  /* ── каскад переноса даты ─────────────────────────────────────────── */

  it('перенос даты: подрядчик получает обновление, команда — уведомление, автор — нет', async () => {
    const couple = await newUser()
    const weddingId = await newWedding(couple.token, '2027-11-06')
    const vendor = await newVendor('photo')
    await bookSlot(couple.token, weddingId, 'photo', vendor.vendorId, 1_000_000)
    const partner = await newUser()
    const invite = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/invites`,
      headers: auth(couple.token),
      payload: { role: 'couple' },
    })
    await app.inject({ method: 'POST', url: `/invites/${invite.json().code as string}/accept`, headers: auth(partner.token) })

    const moved = await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/reschedule`,
      headers: { ...auth(couple.token), ...key() },
      payload: { date: '2027-11-20' },
    })
    expect(moved.statusCode).toBe(200)

    const { rows: updates } = await app.db!.query<{ kind: string; text: string }>(
      'select kind, text from vendor_updates where wedding_id = $1 and vendor_id = $2 and ack_at is null',
      [weddingId, vendor.vendorId],
    )
    expect(updates.some((u) => u.kind === 'timeline' && u.text.includes('20.11.2027'))).toBe(true)

    const { rows: notes } = await app.db!.query<{ user_id: string }>(
      "select user_id from notifications where title = 'Дата свадьбы изменена' and user_id = any($1)",
      [[couple.userId, partner.userId, vendor.owner.userId]],
    )
    const got = new Set(notes.map((n) => n.user_id))
    expect(got.has(partner.userId)).toBe(true)
    expect(got.has(vendor.owner.userId)).toBe(true)
    expect(got.has(couple.userId)).toBe(false)
  })

  /* ── push: просроченное не рассылается ────────────────────────────── */

  it('созревшие больше суток назад push помечаются просроченными, а не рассылаются', async () => {
    /* База у тестов общая, и соседний набор может забрать созревшие строки
       раньше нас — поэтому счётчик `expired` своего вызова не утверждаем
       (R-166). Утверждаем то, что от соседей не зависит: просроченное
       НЕ уходит в `sendNotification` этим процессом, и обе строки помечены. */
    const user = await newUser()
    const old = uuidv7()
    const fresh = uuidv7()
    const marker = `Старое-${RUN}-${++counter}`
    /* Просроченная строка — самая старая в базе (десять лет назад, как в
       ERR-0158): очередь берёт двести САМЫХ РАННИХ созревших, а на общей
       базе созревших сотни, и «трёхдневная» в выборку могла не попасть. */
    await app.db!.query(
      `insert into notifications (id, user_id, kind, title, body, deliver_after) values
         ($1, $3, 'system', $4, 'Текст', now() - interval '10 years'),
         ($2, $3, 'system', 'Свежее', 'Текст', now() - interval '1 minute')`,
      [old, fresh, user.userId, marker],
    )
    await app.db!.query(
      `insert into push_subscriptions (id, user_id, endpoint, keys) values ($1, $2, $3, $4)`,
      [uuidv7(), user.userId, `https://127.0.0.1:9/${uuidv7()}`, JSON.stringify({ p256dh: 'BP'.padEnd(87, 'A'), auth: 'AAAAAAAAAAAAAAAAAAAAAA' })],
    )
    const sent = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} })
    try {
      const keys = webpush.generateVAPIDKeys()
      await sendDuePushes(app.db!, {
        ...app.appConfig,
        vapidPublicKey: keys.publicKey,
        vapidPrivateKey: keys.privateKey,
        vapidSubject: 'mailto:test@example.com',
      })
      // До фикса трёхдневная строка уходила в рассылку наравне со свежей.
      const titles = sent.mock.calls.map(([, payload]) => (JSON.parse(String(payload)) as { title: string }).title)
      expect(titles).not.toContain(marker)
    } finally {
      sent.mockRestore()
    }
    /* Помечена — только просроченная: она самая ранняя в базе и в выборку
       попадает всегда. Свежая (минуту назад) на общей базе стоит позади
       тысяч созревших строк соседей (дайджесты недели) и в первые двести
       не попадает — её отправку держат тесты доставки, не этот (R-166;
       аудит 2026-09-07, блок 10: тест краснел ровно из-за этого). */
    const { rows } = await app.db!.query<{ id: string; pushed: boolean }>(
      'select id, (pushed_at is not null) as pushed from notifications where id = $1',
      [old],
    )
    expect(rows[0]?.pushed).toBe(true)
    void fresh
  })
})
