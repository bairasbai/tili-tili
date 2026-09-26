/*
 * F4 · RL-1 — «Повторное согласие при смене редакции политики».
 *
 * До фикса `assertConsent` (`plugins/auth.ts:73-83`) и `consentRequired`
 * (`routes/auth.ts:421-430`) искали ЛЮБОЕ неотозванное согласие, не сверяя
 * `policy_version`: подняли `POLICY_VERSION` — вошедшие ничего не заметили,
 * хотя текст, под которым они подписались, уже не тот, что на сервере.
 *
 * `appOld` держит прежнюю редакцию (`2026-09-02`), `appNew` — новую
 * (`2026-10-01`); секреты токенов и БД общие — оба экземпляра видят одни и
 * те же строки `users`/`sessions`/`consents`. «Устаревший» человек — тот, кто
 * вошёл и согласился через `appOld`, а затем обращается через `appNew`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomInt, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { hashCode } from '../src/auth/otp.js'
import { eraseUser } from '../src/jobs/index.js'

const DB = process.env.TEST_DATABASE_URL
const live = Boolean(DB)
const SECRET_A = 'a'.repeat(48)
const SECRET_R = 'b'.repeat(48)
const OLD_POLICY = '2026-09-02'
const NEW_POLICY = '2026-10-01'

/**
 * B-T11 — сторож «второй копии»: проверка согласия по редакции должна жить
 * только в `auth/consent.ts` (план F4, `audit54.test.ts#B-T11`). Не требует
 * живой базы — сканирует исходники прямо с диска.
 *
 * F4-B-G6-03 (репорт G4-repair): буквальный сторож ловил только точную форму
 * c24d211 и терял переставленный порядок условий, алиас, заглавный SQL и
 * второй номер параметра — расширен одним комбинированным регэкспом.
 *
 * F4-B-G6r5-01 (репорт G4r6): расширенный сторож всё ещё пропускал восемь
 * правдоподобных переформулировок: третий предикат (`policy_version`) МЕЖДУ
 * двумя проверками, алиас через `AS`, схему (`public.consents`), приведение
 * типа (`::uuid`), кавычки у идентификаторов, `is null` без пробела, JOIN
 * между `consents` и `where`, сравнение `user_id` со столбцом другой таблицы
 * вместо параметра. Каждый класс закреплён своим тестом ниже (`B-T11 доп.`,
 * без живой базы); разрыв внутри JOIN ограничен по длине (`JOIN_GAP`), чтобы
 * не «перепрыгнуть» на несвязанный запрос дальше по тому же файлу — см. там
 * же негативный контроль «не перепрыгивает через несвязанный JOIN».
 */
const IDENT = String.raw`"?\w+"?`
const QUAL = String.raw`(?:${IDENT}\.)?`
const RESERVED_WORD = String.raw`(?!where\b|join\b|inner\b|left\b|right\b|full\b|cross\b|on\b)`
const TABLE = String.raw`${QUAL}"?consents"?`
const ALIAS = String.raw`(?:\s+(?:as\s+)?${RESERVED_WORD}${IDENT})?`
const JOIN_GAP = String.raw`[\s\S]{1,120}?`
const JOIN_CLAUSE = String.raw`(?:\s+(?:inner\s+|left\s+(?:outer\s+)?|right\s+(?:outer\s+)?|full\s+(?:outer\s+)?)?join\s+${JOIN_GAP}\s+on\s+${JOIN_GAP})?`
const PARAM = String.raw`\$\d+(?:::\w+)?`
const COL_USER = String.raw`${QUAL}"?user_id"?\s*=\s*(?:${PARAM}|${QUAL}${IDENT})`
const COL_WITHDRAWN = String.raw`${QUAL}"?withdrawn_at"?\s+is\s*null`
const PRED_EXTRA = String.raw`(?:${QUAL}"?\w+"?\s*(?:=\s*\S+|is\s+(?:not\s+)?null)\s+and\s+)?`
const CONSENT_QUERY_PATTERN = new RegExp(
  String.raw`from\s+${TABLE}${ALIAS}${JOIN_CLAUSE}\s+where\s+` +
    String.raw`(?:${COL_USER}\s+and\s+${PRED_EXTRA}${COL_WITHDRAWN}` +
    String.raw`|${COL_WITHDRAWN}\s+and\s+${PRED_EXTRA}${COL_USER})`,
  'i',
)

function findLiveConsentQueryFiles(): string[] {
  const testDir = path.dirname(fileURLToPath(import.meta.url))
  const srcRoot = path.join(testDir, '..', 'src')
  const hits: string[] = []
  for (const entry of fs.readdirSync(srcRoot, { recursive: true }) as string[]) {
    if (!entry.endsWith('.ts') || entry.endsWith('.generated.ts')) continue
    const abs = path.join(srcRoot, entry)
    if (!fs.statSync(abs).isFile()) continue
    if (CONSENT_QUERY_PATTERN.test(fs.readFileSync(abs, 'utf8'))) hits.push(`src/${entry.replace(/\\/g, '/')}`)
  }
  return hits.sort()
}

describe.skipIf(!live)('F4 · RL-1: повторное согласие при смене редакции политики', () => {
  let appOld: FastifyInstance
  let appNew: FastifyInstance
  let counter = 0
  /*
   * Собственный несменяемый префикс: "540540" — не пересекается с занятыми
   * (490100, 490600, 490900, 491000, 491200, 491801-491803, ROADMAP F4).
   */
  const RUN = '540540'
  const IP = `198.18.${randomInt(0, 255)}.${randomInt(1, 254)}`
  const createdUserIds: string[] = []

  const baseConfig = (policyVersion: string) => ({
    env: 'test' as const,
    databaseUrl: DB ?? null,
    redisUrl: null,
    corsOrigins: [],
    jwtAccessSecret: SECRET_A,
    jwtRefreshSecret: SECRET_R,
    policyVersion,
    otpMaxPerHourTotal: 1_000_000,
    otpMaxPerIpHour: 1_000_000,
  })

  beforeAll(async () => {
    appOld = await buildApp(baseConfig(OLD_POLICY))
    appNew = await buildApp(baseConfig(NEW_POLICY))
    await appOld.ready()
    await appNew.ready()
    /*
     * Уборка хвостов прошлого прогона — ROADMAP.md:793-794: eraseUser
     * пользователей префикса и otp_codes префикса (как audit49i.test.ts:56-64,
     * но там нет живых consents — тут есть, и телефоны детерминированы:
     * "+79540540" + счётчик с 1). Прерванный прошлый прогон (смерть процесса
     * до afterAll) оставляет пользователей префикса живыми — без этой уборки
     * следующий прогон логинится в них же и видит чужие строки consents
     * (B-T2 — не 2, а больше; B-T7 — consentRequired лжёт, потому что старая
     * живая строка НОВОЙ редакции уже делает состояние 'current').
     */
    const { rows: leftoverUsers } = await appOld.db!.query<{ id: string }>(
      "select id from users where phone like '+79' || $1 || '%'",
      [RUN],
    )
    for (const { id } of leftoverUsers) {
      await appOld.db!.tx((client) => eraseUser(client, id))
    }
    await appOld.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
  })

  afterAll(async () => {
    for (const id of createdUserIds) {
      await appOld.db!.tx((client) => eraseUser(client, id))
    }
    await appOld.db!.query("delete from otp_codes where phone like '+79' || $1 || '%'", [RUN])
    await appOld?.close()
    await appNew?.close()
  })

  const nextPhone = () => `+79${RUN}${String(++counter).padStart(3, '0')}`
  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function readCode(phone: string): Promise<string> {
    const { rows } = await appOld.db!.query<{ code_hash: string }>(
      'select code_hash from otp_codes where phone = $1 and consumed_at is null order by created_at desc limit 1',
      [phone],
    )
    for (let i = 0; i < 10000; i++) {
      const c = String(i).padStart(4, '0')
      if (hashCode(SECRET_R, phone, c) === rows[0]!.code_hash) return c
    }
    throw new Error('код не подобрался')
  }

  /** Сдвигает прошлые коды номера в прошлое — тот же приём, что stage1.test.ts:99-104. */
  async function pretendMinutePassed(phone: string) {
    await appOld.db!.query("update otp_codes set created_at = created_at - interval '2 minutes' where phone = $1", [
      phone,
    ])
  }

  async function loginVia(
    app: FastifyInstance,
    phone: string,
  ): Promise<{ accessToken: string; consentRequired: boolean; user: { id: string } }> {
    await app.inject({ method: 'POST', url: '/auth/otp', payload: { phone }, remoteAddress: IP })
    const v = await app.inject({
      method: 'POST',
      url: '/auth/otp/verify',
      payload: { phone, code: await readCode(phone) },
    })
    expect(v.statusCode, v.body.slice(0, 300)).toBe(200)
    return v.json() as { accessToken: string; consentRequired: boolean; user: { id: string } }
  }

  /** Заводит человека и делает его согласие «устаревшим»: вход и согласие —
   * через `appOld`, под прежней редакцией. */
  async function outdatedUser() {
    const phone = nextPhone()
    const u = await loginVia(appOld, phone)
    createdUserIds.push(u.user.id)
    const res = await appOld.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: OLD_POLICY, adult: true },
    })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)
    return { phone, userId: u.user.id, accessToken: u.accessToken }
  }

  it('B-T1: устаревшее согласие — GET /users/me через appNew отвечает 403 consent_outdated', async () => {
    const u = await outdatedUser()
    const res = await appNew.inject({ method: 'GET', url: '/users/me', headers: auth(u.accessToken) })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(403)
    expect(res.json().error.code).toBe('consent_outdated')
  })

  it('B-T2: новое согласие через appNew — 201, доступ восстановлен, старая строка не отзывается', async () => {
    const u = await outdatedUser()
    const res = await appNew.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: NEW_POLICY, adult: true },
    })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(201)

    const me = await appNew.inject({ method: 'GET', url: '/users/me', headers: auth(u.accessToken) })
    expect(me.statusCode, me.body.slice(0, 300)).toBe(200)

    const { rows } = await appOld.db!.query<{ policy_version: string; withdrawn_at: Date | null; adult: boolean }>(
      'select policy_version, withdrawn_at, adult from consents where user_id = $1 order by given_at',
      [u.userId],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ policy_version: OLD_POLICY, withdrawn_at: null })
    expect(rows[1]).toMatchObject({ policy_version: NEW_POLICY, withdrawn_at: null, adult: true })

    const { rows: log } = await appOld.db!.query<{ diff: { policyVersion: string; adult: boolean } }>(
      `select diff from audit_log where actor_id = $1 and action = 'consent.given' order by at desc limit 1`,
      [u.userId],
    )
    expect(log[0]?.diff).toMatchObject({ policyVersion: NEW_POLICY, adult: true })
  })

  it('B-T3: POST с прежней редакцией через appNew — 409 policy_version_stale', async () => {
    const u = await outdatedUser()
    const res = await appNew.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: OLD_POLICY, adult: true },
    })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(409)
    expect(res.json().error.code).toBe('policy_version_stale')
  })

  it('B-T4: устаревшее согласие — выход и отписка от push всё равно работают', async () => {
    const u = await outdatedUser()
    const endpoint = `https://fcm.googleapis.com/fcm/send/${RUN}-bt4-${u.userId.slice(0, 8)}`
    // Строка заведена SQL — как audit34.test.ts:522-532.
    await appOld.db!.query('insert into push_subscriptions (id, user_id, endpoint, keys) values ($1, $2, $3, $4)', [
      randomUUID(),
      u.userId,
      endpoint,
      JSON.stringify({ p256dh: 'p', auth: 'a' }),
    ])

    const delPush = await appNew.inject({
      method: 'DELETE',
      url: `/users/me/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`,
      headers: auth(u.accessToken),
    })
    expect(delPush.statusCode, delPush.body.slice(0, 300)).toBe(204)
    const { rows: left } = await appOld.db!.query('select 1 from push_subscriptions where endpoint = $1', [endpoint])
    expect(left).toHaveLength(0)

    const sessions = await appNew.inject({ method: 'GET', url: '/users/me/sessions', headers: auth(u.accessToken) })
    expect(sessions.statusCode, sessions.body.slice(0, 300)).toBe(200)
    const list = sessions.json() as { id: string; current: boolean }[]
    const current = list.find((s) => s.current)
    expect(current, JSON.stringify(list)).toBeDefined()

    const delOthers = await appNew.inject({ method: 'DELETE', url: '/users/me/sessions', headers: auth(u.accessToken) })
    expect(delOthers.statusCode, delOthers.body.slice(0, 300)).toBe(204)

    const delCurrent = await appNew.inject({
      method: 'DELETE',
      url: `/users/me/sessions/${current!.id}`,
      headers: auth(u.accessToken),
    })
    expect(delCurrent.statusCode, delCurrent.body.slice(0, 300)).toBe(204)

    const afterLogout = await appNew.inject({
      method: 'GET',
      url: '/users/me/sessions',
      headers: auth(u.accessToken),
    })
    expect(afterLogout.statusCode, afterLogout.body.slice(0, 300)).toBe(401)
  })

  it('B-T5: без согласия вовсе — 403 forbidden, не consent_outdated', async () => {
    const phone = nextPhone()
    const u = await loginVia(appNew, phone)
    createdUserIds.push(u.user.id)
    const res = await appNew.inject({ method: 'GET', url: '/users/me', headers: auth(u.accessToken) })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(403)
    expect(res.json().error.code).toBe('forbidden')
  })

  it('B-T6: DELETE /users/me/consent при устаревшем — 204, аккаунт помечен удалённым', async () => {
    const u = await outdatedUser()
    const res = await appNew.inject({ method: 'DELETE', url: '/users/me/consent', headers: auth(u.accessToken) })
    expect(res.statusCode, res.body.slice(0, 300)).toBe(204)
    const { rows } = await appOld.db!.query<{ deleted_at: Date | null }>('select deleted_at from users where id = $1', [
      u.userId,
    ])
    expect(rows[0]?.deleted_at).not.toBeNull()
  })

  it('B-T7: вход при устаревшем согласии — consentRequired: true; после нового — false', async () => {
    const phone = nextPhone()
    const first = await loginVia(appOld, phone)
    createdUserIds.push(first.user.id)
    const given = await appOld.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(first.accessToken),
      payload: { policyVersion: OLD_POLICY, adult: true },
    })
    expect(given.statusCode, given.body.slice(0, 300)).toBe(201)

    await pretendMinutePassed(phone)
    const second = await loginVia(appNew, phone)
    expect(second.consentRequired).toBe(true)

    const newConsent = await appNew.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(second.accessToken),
      payload: { policyVersion: NEW_POLICY, adult: true },
    })
    expect(newConsent.statusCode, newConsent.body.slice(0, 300)).toBe(201)

    await pretendMinutePassed(phone)
    const third = await loginVia(appNew, phone)
    expect(third.consentRequired).toBe(false)
  })

  it('B-T8: живой канал — authorizeToken отклоняет устаревшее согласие', async () => {
    const u = await outdatedUser()
    await expect(appNew.authorizeToken(u.accessToken)).rejects.toMatchObject({
      statusCode: 403,
      code: 'consent_outdated',
    })
  })

  it('B-T9: вне allow-list — DELETE /users/me и GET /users/me/export дают 403 consent_outdated', async () => {
    const u1 = await outdatedUser()
    const del = await appNew.inject({ method: 'DELETE', url: '/users/me', headers: auth(u1.accessToken) })
    expect(del.statusCode, del.body.slice(0, 300)).toBe(403)
    expect(del.json().error.code).toBe('consent_outdated')

    const u2 = await outdatedUser()
    const exp = await appNew.inject({ method: 'GET', url: '/users/me/export', headers: auth(u2.accessToken) })
    expect(exp.statusCode, exp.body.slice(0, 300)).toBe(403)
    expect(exp.json().error.code).toBe('consent_outdated')
  })

  it('B-T10: два POST подряд с действующей редакцией — 201 и 201, доступ остаётся', async () => {
    const phone = nextPhone()
    const u = await loginVia(appNew, phone)
    createdUserIds.push(u.user.id)
    const first = await appNew.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: NEW_POLICY, adult: true },
    })
    expect(first.statusCode, first.body.slice(0, 300)).toBe(201)
    const second = await appNew.inject({
      method: 'POST',
      url: '/users/me/consent',
      headers: auth(u.accessToken),
      payload: { policyVersion: NEW_POLICY, adult: true },
    })
    expect(second.statusCode, second.body.slice(0, 300)).toBe(201)
    const me = await appNew.inject({ method: 'GET', url: '/users/me', headers: auth(u.accessToken) })
    expect(me.statusCode, me.body.slice(0, 300)).toBe(200)
  })

  it('B-T11: проверка согласия по редакции — только в auth/consent.ts, без второй копии', () => {
    expect(findLiveConsentQueryFiles()).toEqual(['src/auth/consent.ts'])
  })
})

/**
 * B-T11 доп. (F4-B-G6r5-01): расширенный сторож (F4-B-G6-03) всё ещё пропускал
 * восемь правдоподобных переформулировок второй копии запроса — не требует
 * живой базы, поэтому вынесено из `describe.skipIf(!live)` выше. Красное на
 * прежнем регэкспе (сторож не заметил бы вторую копию в такой форме), зелёное
 * после расширения; отдельные негативные контроли и регрессии на прежних
 * известно-хороших формах доказывают, что расширение не даёт ложных срабатываний.
 */
describe('B-T11 доп.: сторож устойчив к переформулировкам SQL (F4-B-G6r5-01)', () => {
  const matches = (sql: string) => CONSENT_QUERY_PATTERN.test(sql)

  it('ловит третий предикат (policy_version) между user_id и withdrawn_at', () => {
    expect(
      matches('select 1 from consents where user_id = $1 and policy_version = $2 and withdrawn_at is null'),
    ).toBe(true)
  })

  it('ловит алиас через ключевое слово AS', () => {
    expect(matches('select 1 from consents as c where c.user_id = $1 and c.withdrawn_at is null')).toBe(true)
  })

  it('ловит таблицу, уточнённую схемой (public.consents)', () => {
    expect(matches('select 1 from public.consents where user_id = $1 and withdrawn_at is null')).toBe(true)
  })

  it('ловит приведение типа параметра (::uuid)', () => {
    expect(matches('select 1 from consents where user_id = $1::uuid and withdrawn_at is null')).toBe(true)
  })

  it('ловит запрос с кавычками у идентификаторов', () => {
    expect(matches('select 1 from "consents" where "user_id" = $1 and "withdrawn_at" is null')).toBe(true)
  })

  it('ловит "withdrawn_at is null" без пробела (isnull)', () => {
    expect(matches('select 1 from consents where user_id = $1 and withdrawn_at isnull')).toBe(true)
  })

  it('ловит JOIN между consents и WHERE', () => {
    expect(
      matches(
        'select 1 from consents c join sessions s on s.user_id = c.user_id where c.user_id = $1 and c.withdrawn_at is null',
      ),
    ).toBe(true)
  })

  it('ловит сравнение user_id со столбцом другой таблицы вместо параметра', () => {
    expect(matches('select 1 from consents where user_id = other_users.id and withdrawn_at is null')).toBe(true)
  })

  it('по-прежнему ловит исходную форму c24d211 (регрессия)', () => {
    expect(matches('select true as ok from consents where user_id = $1 and withdrawn_at is null limit 1')).toBe(true)
  })

  it('по-прежнему ловит многострочную форму (регрессия)', () => {
    expect(
      matches(`select exists (
        select 1 from consents
        where user_id = $1
          and withdrawn_at is null
      ) as any`),
    ).toBe(true)
  })

  it('не ловит другую таблицу (негативный контроль)', () => {
    expect(matches('select 1 from other_table where user_id = $1 and withdrawn_at is null')).toBe(false)
  })

  it('не ловит похожее имя колонки (негативный контроль)', () => {
    expect(matches('select 1 from consents where user_id_extra = $1 and withdrawn_at is null')).toBe(false)
  })

  it('не ловит чужую колонку вместо withdrawn_at (негативный контроль)', () => {
    expect(matches('select 1 from consents where user_id = $1 and revoked_at is null')).toBe(false)
  })

  it('не ловит один предикат без второго (негативный контроль)', () => {
    expect(matches('select 1 from consents where withdrawn_at is null')).toBe(false)
  })

  it('не перепрыгивает через несвязанный JOIN дальше по файлу (негативный контроль)', () => {
    const unrelatedJoinFarAway =
      'select policy_version from consents where user_id = $1 order by given_at\n' +
      `-- ${'padding '.repeat(20)}\n` +
      'select 1 from sessions s join users u on u.id = s.user_id where s.revoked_at is null'
    expect(matches(unrelatedJoinFarAway)).toBe(false)
  })
})
