import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { cleanup, eraseUser } from '../src/jobs/index.js'

/**
 * Этап 9: эксплуатация и 152-ФЗ.
 *
 * Новых путей нет — этап про то, что происходит с данными и со стендом.
 * Главная проверка: удалённый аккаунт через 31 день не находится нигде,
 * кроме журнала аудита. Проверяется не «мы вроде всё удалили», а обходом
 * ВСЕХ таблиц базы: список колонок берётся из самой базы, а не из памяти.
 */
const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)

const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
const futureDate = (days: number) => {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}
const WEDDING_DATE = futureDate(730)
const OFFER_VALID_UNTIL = futureDate(1095)

describe.skipIf(!live)('этап 9: эксплуатация и 152-ФЗ', () => {
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
    const token = v.json().accessToken as string
    await app.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(token),
      payload: { policyVersion: '2026-09-02' },
    })
    const { rows } = await app.db!.query<{ id: string }>('select id from users where phone = $1', [phone])
    return { token, userId: rows[0]!.id, phone }
  }

  /** Обходит ВСЕ колонки базы и ищет идентификатор. Список — из самой базы. */
  async function findEverywhere(value: string): Promise<string[]> {
    const { rows: columns } = await app.db!.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema = 'public'
          and data_type in ('uuid', 'text', 'character varying', 'json', 'jsonb')
        order by table_name, column_name`,
    )
    const found: string[] = []
    for (const c of columns) {
      // Журнал аудита переживает удаление намеренно: он и нужен, чтобы
      // ответить «кто и когда удалил», когда самих данных уже нет.
      if (c.table_name === 'audit_log') continue
      if (c.table_name === 'pgmigrations') continue
      const cast = ['uuid', 'json', 'jsonb'].includes(c.data_type) ? '::text' : ''
      const { rows } = await app.db!.query<{ n: string }>(
        `select count(*)::text as n from "${c.table_name}" where position($1 in "${c.column_name}"${cast}) > 0`,
        [value],
      )
      if (Number(rows[0]!.n) > 0) found.push(`${c.table_name}.${c.column_name}`)
    }
    return found
  }


  async function offerFixture019(accepted: boolean) {
    const owner = await newUser(), vendor = await newUser()
    const wedding = await app.inject({method:'POST',url:'/weddings',headers:auth(owner.token),
      payload:{partnerName:'019',date:WEDDING_DATE,city:{name:'Уфа',region:'Башкортостан'}}})
    expect(wedding.statusCode, wedding.body).toBe(201)
    const wid = wedding.json().id as string
    const profile = await app.inject({method:'PUT',url:'/vendor/profile',headers:auth(vendor.token),payload:{
      name:`Erase019-${randomUUID()}`,categoryId:'photo',city:{name:'Уфа',region:'Башкортостан'},
      priceFrom:{amount:100000,currency:'RUB'},portfolioUrls:['https://example.com/photo.jpg']}})
    expect(profile.statusCode, profile.body).toBe(200)
    const vid = profile.json().id as string
    expect((await app.inject({method:'POST',url:'/vendor/profile/publish',headers:auth(vendor.token)})).statusCode).toBe(200)
    const candidate = await app.inject({method:'PUT',url:`/weddings/${wid}/shortlist/${vid}`,headers:auth(owner.token)})
    expect(candidate.statusCode,candidate.body).toBe(200)
    const sid = candidate.json().slotId as string
    const sent = await app.inject({method:'POST',url:`/weddings/${wid}/slots/${sid}/offer-requests`,headers:{...auth(owner.token),'idempotency-key':randomUUID()},payload:{entryIds:[candidate.json().id]}})
    expect(sent.statusCode,sent.body).toBe(201)
    const rid = sent.json().results[0].requestId as string
    const privateText = `Private019-${randomUUID()}`
    const offer = await app.inject({method:'POST',url:`/vendor/offer-requests/${rid}/offers`,headers:{...auth(vendor.token),'idempotency-key':randomUUID()},payload:{kind:'offer',title:'Договорённый пакет',includes:['8 часов'],price:{amount:1234500,currency:'RUB'},message:privateText,validUntil:OFFER_VALID_UNTIL}})
    expect(offer.statusCode,offer.body).toBe(201)
    if (accepted) {
      const book = await app.inject({method:'POST',url:`/weddings/${wid}/offers/${offer.json().id}/accept`,headers:{...auth(owner.token),'idempotency-key':randomUUID()}})
      expect(book.statusCode,book.body).toBe(200)
      // Активную бронь нельзя удалять мягко: доводим сделку до истории,
      // чтобы этот fixture проверял именно 30-дневное стирание.
      await app.db!.query("update deals set state = 'done', done_at = now() where slot_id = $1", [sid])
    }
    return {owner,vendor,wid,vid,sid,rid,privateText,name:profile.json().name as string}
  }

  it.each([false,true])('019: cleanup стирает подрядчика, accepted=%s; tombstone и снимок сделки сохранены', async accepted => {
    const f = await offerFixture019(accepted)
    expect((await app.inject({method:'DELETE',url:'/users/me',headers:auth(f.vendor.token)})).statusCode).toBe(204)
    await app.db!.query("update users set deleted_at=now()-interval '31 days' where id=$1",[f.vendor.userId])
    await cleanup(app)
    for (const value of [f.vendor.userId,f.vid,f.vendor.phone,f.name,f.privateText]) expect(await findEverywhere(value),value).toEqual([])
    const rows = await app.db!.query('select vendor_id,status,close_reason,wishes from offer_requests where id=$1',[f.rid])
    expect(rows.rows[0]).toEqual({vendor_id:null,status:'closed',close_reason:'vendor_erased',wishes:null})
    const shortlist = await app.db!.query('select vendor_id from slot_shortlist where slot_id=$1',[f.sid])
    expect(shortlist.rows).toEqual([{vendor_id:null}])
    if (accepted) {
      const deals = await app.db!.query(
        'select vendor_id,external_name,external_phone,performer_erased_at,package_title_snapshot,package_includes_snapshot,price::text from deals where slot_id=$1',
        [f.sid],
      )
      expect(deals.rows).toEqual([{
        vendor_id:null,external_name:null,external_phone:null,performer_erased_at:expect.any(Date),
        package_title_snapshot:'Договорённый пакет',package_includes_snapshot:['8 часов'],price:'1234500',
      }])
    }
    await app.db!.tx(client => eraseUser(client,f.owner.userId))
  })

  it.each(['owner','archive','otp'] as const)('019: удаление через %s убирает связанные предложения', async method => {
    const f = await offerFixture019(true)
    if (method === 'archive') {
      expect((await app.inject({method:'POST',url:`/weddings/${f.wid}/cancel`,headers:auth(f.owner.token)})).statusCode).toBe(200)
      await app.db!.query("update weddings set archived_at=now()-interval '400 days' where id=$1",[f.wid])
      await cleanup(app)
    } else if (method === 'owner') {
      const deleted = await app.inject({method:'DELETE',url:'/users/me',headers:auth(f.owner.token)})
      expect(deleted.statusCode,deleted.body).toBe(204)
      await app.db!.query("update users set deleted_at=now()-interval '31 days' where id=$1",[f.owner.userId])
      await cleanup(app)
    } else {
      const deleted = await app.inject({method:'DELETE',url:'/users/me',headers:auth(f.vendor.token)})
      expect(deleted.statusCode,deleted.body).toBe(204)
      await app.db!.query("update users set deleted_at=now()-interval '31 days' where id=$1",[f.vendor.userId])
      await app.db!.query(
        "update otp_codes set created_at=now()-interval '31 days', expires_at=now()-interval '31 days' where phone=$1",
        [f.vendor.phone],
      )
      const otp = await app.inject({method:'POST',url:'/auth/otp',payload:{phone:f.vendor.phone},remoteAddress:IP})
      expect(otp.statusCode,otp.body).toBe(200)
      const verified = await app.inject({method:'POST',url:'/auth/otp/verify',payload:{phone:f.vendor.phone,code:await readCode(f.vendor.phone)}})
      expect(verified.statusCode,verified.body).toBe(200)
      const replacementId = verified.json().user.id as string
      expect(replacementId).not.toBe(f.vendor.userId)
      expect(await findEverywhere(f.vid)).toEqual([])
      await app.db!.tx(client => eraseUser(client,replacementId))
    }
    expect((await app.db!.query('select id from offers where request_id=$1',[f.rid])).rows).toEqual([])
    await app.db!.tx(client => eraseUser(client,f.owner.userId))
    await app.db!.tx(client => eraseUser(client,f.vendor.userId))
  })

  it('019: hard-delete ждёт request до user/vendor, ответ завершается без parent↔request deadlock', async () => {
    const f = await offerFixture019(false)
    const db = app.db!
    await Promise.all(Array.from({length:6},()=>db.query('select pg_sleep(0.05)')))
    let deleting: Promise<void> | undefined
    try {
      await db.tx(async client => {
        // Hold precisely the mutex held by the response route. Deletion must
        // wait here WITHOUT holding user/vendor, so response can still lock them.
        await client.query('select id from offer_requests where id=$1 for update',[f.rid])
        const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid
        deleting = db.tx(c => eraseUser(c,f.vendor.userId))
        const deadline = Date.now()+5000
        for (;;) {
          await client.query('select pg_stat_clear_snapshot()')
          const waiting = await client.query("select query from pg_stat_activity where wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))",[pid])
          if (waiting.rows.length) { expect(waiting.rows[0].query).toContain('offer_requests'); break }
          if (Date.now()>deadline) throw new Error('erase did not reach the request mutex')
          await new Promise(resolve=>setTimeout(resolve,10))
        }
        await client.query('select v.id from vendors v join users u on u.id=v.user_id where v.id=$1 for share of v,u',[f.vid])
        await client.query("update offers set message='ответ завершён' where request_id=$1",[f.rid])
      })
    } finally { await deleting }
    expect((await db.query('select id from users where id=$1',[f.vendor.userId])).rows).toEqual([])
    expect(await findEverywhere(f.vid)).toEqual([])
    await db.tx(client=>eraseUser(client,f.owner.userId))
  })

  /* ── удаление аккаунта ────────────────────────────────────────────── */
  it('через 31 день от удалённого аккаунта не остаётся ничего, кроме журнала', async () => {
    const user = await newUser()

    // Заводим следы во всех углах: свадьба, гость, чат, уведомление, анкета.
    const w = await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: WEDDING_DATE,
        city: { name: 'Казань', region: 'Татарстан' },
        budgetTotal: { amount: 100_000_000, currency: 'RUB' },
      },
    })
    const weddingId = w.json().id as string
    await app.inject({
      method: 'POST',
      url: `/weddings/${weddingId}/guests`,
      headers: auth(user.token),
      payload: { name: 'Аня' },
    })
    await app.inject({
      method: 'PATCH',
      url: '/users/me',
      headers: auth(user.token),
      payload: { name: 'Алина', push: { chats: false } },
    })

    const vendorUser = await newUser()
    const vendor = await app.inject({
      method: 'PUT',
      url: '/vendor/profile',
      headers: auth(vendorUser.token),
      payload: {
        name: `Фотограф ${RUN}`,
        categoryId: 'photo',
        city: { name: 'Казань', region: 'Татарстан' },
        priceFrom: { amount: 5_000_000, currency: 'RUB' },
      },
    })
    await app.inject({ method: 'POST', url: '/vendor/profile/publish', headers: auth(vendorUser.token) })
    const chatId = (
      await app.inject({
        method: 'POST',
        url: `/chats/vendor/${vendor.json().id}`,
        headers: auth(user.token),
      })
    ).json().id as string
    await app.inject({
      method: 'POST',
      url: `/chats/${chatId}/messages`,
      headers: auth(user.token),
      payload: { text: 'Здравствуйте!' },
    })
    await app.inject({
      method: 'POST',
      url: '/complaints',
      headers: auth(user.token),
      payload: { targetKind: 'vendor', targetId: vendor.json().id, category: 'spam' },
    })

    // След до удаления есть — иначе проверка ничего не доказывает.
    expect((await findEverywhere(user.userId)).length).toBeGreaterThan(0)

    const deleted = await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(user.token) })
    expect(deleted.statusCode).toBe(204)

    // Мягкое удаление: 30 дней аккаунт можно вернуть (План §19.1).
    const { rows: soft } = await app.db!.query<{ deleted_at: Date | null }>(
      'select deleted_at from users where id = $1',
      [user.userId],
    )
    expect(soft[0]!.deleted_at).not.toBeNull()

    // Тридцать первый день.
    await app.db!.query("update users set deleted_at = now() - interval '31 days' where id = $1", [user.userId])
    await cleanup(app)

    const left = await findEverywhere(user.userId)
    expect(left).toEqual([])

    // А в журнале аудита след обязан остаться: он отвечает на вопрос
    // «кто и когда удалил», когда самих данных уже нет.
    const { rows: audit } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from audit_log where actor_id = $1',
      [user.userId],
    )
    expect(Number(audit[0]!.n)).toBeGreaterThan(0)
  })

  it('до тридцать первого дня аккаунт ещё можно вернуть', async () => {
    const user = await newUser()
    await app.inject({ method: 'DELETE', url: '/users/me', headers: auth(user.token) })
    await app.db!.query("update users set deleted_at = now() - interval '29 days' where id = $1", [user.userId])
    await cleanup(app)

    const { rows } = await app.db!.query<{ n: string }>('select count(*)::text as n from users where id = $1', [
      user.userId,
    ])
    // Тридцать дней — это обещание, а не приблизительный срок.
    expect(Number(rows[0]!.n)).toBe(1)
  })

  /* ── экспорт данных ───────────────────────────────────────────────── */
  it('экспорт отдаёт данные пары одним файлом', async () => {
    const user = await newUser()
    await app.inject({
      method: 'POST',
      url: '/weddings',
      headers: auth(user.token),
      payload: {
        partnerName: 'Тимур',
        date: WEDDING_DATE,
        city: { name: 'Казань', region: 'Татарстан' },
      },
    })

    const dump = await app.inject({ method: 'GET', url: '/users/me/export', headers: auth(user.token) })
    expect(dump.statusCode).toBe(200)
    const data = dump.json() as Record<string, unknown>
    // 152-ФЗ: человек имеет право забрать свои данные, а не список ссылок.
    expect(Object.keys(data).length).toBeGreaterThan(1)
    expect(JSON.stringify(data)).toContain('Тимур')
  })

  /* ── ограничитель как критерий этапа ──────────────────────────────── */
  it('одиннадцатый запрос за секунду получает 429', async () => {
    const limited = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: process.env.TEST_REDIS_URL ?? null,
      corsOrigins: [],
      jwtAccessSecret: SECRET_A,
      jwtRefreshSecret: SECRET_R,
      policyVersion: '2026-09-02',
      rateLimitPerSecond: 10,
    })
    await limited.ready()
    try {
      if (!limited.redis) {
        // Без Redis ограничителя нет — и это честно сказано в логе.
        expect(limited.redis).toBeNull()
        return
      }
      // Подключение к Redis идёт параллельно старту приложения — дожидаемся
      // его здесь, иначе первая пачка может застать момент 'connecting' и
      // словить фиктивный пропуск лимитера через таймаут 250 мс, тот же
      // риск, что и в ratelimit.test.ts (F3-b, см. :39-47 там).
      await new Promise<void>((resolve, reject) => {
        const redis = limited.redis!
        if (redis.status === 'ready') return resolve()
        const timer = setTimeout(() => reject(new Error('Redis не поднялся за 10 с')), 10_000)
        redis.once('ready', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      const token = `Bearer ${'z'.repeat(40)}-${randomInt(1, 1_000_000)}`
      // Дождаться начала свежей секунды: пачка из 11 должна попасть целиком
      // в одно окно лимитера, иначе тест мигает на границе окна (F3-b).
      await new Promise((resolve) => setTimeout(resolve, 1000 - (Date.now() % 1000) + 20))
      const burst = await Promise.all(
        Array.from({ length: 11 }, () =>
          limited.inject({ method: 'GET', url: '/geo/cities?q=Ка', headers: { authorization: token } }),
        ),
      )
      // Критерий этапа дословно: одиннадцатый за секунду — отказ.
      expect(burst.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(10)
      expect(burst.some((r) => r.statusCode === 429)).toBe(true)
    } finally {
      await limited.close()
    }
  })

  /* ── уборка не трогает живое ──────────────────────────────────────── */
  it('уборка не задевает действующие аккаунты', async () => {
    const alive = await newUser()
    await cleanup(app)
    const { rows } = await app.db!.query<{ n: string }>(
      'select count(*)::text as n from users where id = $1 and deleted_at is null',
      [alive.userId],
    )
    expect(Number(rows[0]!.n)).toBe(1)
  })
})
