import { isIP } from 'node:net'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { AppError, TooManyRequests, unauthorized } from '../errors.js'
import { uuidv7 } from '../ids.js'
import { consentState } from '../auth/consent.js'
import {
  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
  RESEND_AFTER_SECONDS,
  generateCode,
  hashCode,
  maskPhone,
  normalizePhone,
} from '../auth/otp.js'
import { codeMessage } from '../auth/sms.js'
import { eraseUser } from '../jobs/index.js'
import {
  ACCESS_TTL_SECONDS,
  REFRESH_TTL_SECONDS,
  createRefreshToken,
  hashRefreshToken,
  safeEqual,
  signAccessToken,
} from '../auth/tokens.js'

interface Tokens {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: { id: string; name: string | null; phone: string }
}

/**
 * Адрес клиента — только если это адрес. При `TRUST_PROXY` больше числа прокси
 * Fastify берёт значение из `X-Forwarded-For` как есть, и мусор оттуда уходил
 * в `::inet` — 500 вместо ответа, а лимиты по адресу обходились подставным
 * адресом (ревью 015). Не адрес — считаем неизвестным: лимиты по номеру и общий
 * потолок остаются.
 */
export function clientIp(request: FastifyRequest): string | null {
  const ip = request.ip
  if (!ip) return null
  /* Зона интерфейса отрезается до проверки: `net.isIP` считает
   * `fe80::1%eth0` валидным IPv6 (возвращает 6), а PostgreSQL тип `inet`
   * такую строку не принимает и отвечает 22P02 — заголовок
   * `X-Forwarded-For` с таким значением давал 500 на `POST /auth/otp` и
   * на записи согласия (F-RL-1-01, ревью 016). Сам адрес без зоны —
   * ровно то, что нужно для счётчика лимитов; остаток без адреса — не адрес. */
  const zone = ip.indexOf('%')
  const bare = zone === -1 ? ip : ip.slice(0, zone)
  return isIP(bare) ? bare : null
}

/**
 * Сколько после обмена прежний refresh считается «второй вкладкой», а не
 * кражей. Вкладки одного браузера расходятся на миллисекунды; десяти секунд
 * хватает с запасом, а вору за это окно достаётся только 401.
 */
export const REFRESH_GRACE_MS = 10_000

/** Сколько дней после `DELETE /users/me` аккаунт можно вернуть входом (План §19.1; фича 005, В2). */
export const RESTORE_WINDOW_DAYS = 30

/**
 * Через сколько секунд окно лимита освободится хотя бы на одну выдачу.
 *
 * `ages` — возраст выдач в окне в секундах, свежие первыми. Окно откроет
 * выход самой старой из «лишних» строк: при пределе `max` это `max`-я по
 * свежести. «Через час» наугад клиенту не годится: таймер на экране входа
 * читает заголовок и показывает человеку именно это число.
 */
export function windowFreesIn(ages: number[], windowSeconds: number, max: number): number {
  const blocking = ages[Math.max(0, Math.min(max, ages.length) - 1)] ?? 0
  return Math.max(1, Math.ceil(windowSeconds - blocking))
}

/**
 * Ключ advisory-блокировки выдачи кода (ревью 016, R-271) — замок на номер,
 * а не на таблицу: параллельный залп на один номер иначе проходит окно
 * лимитов целиком до первой вставки (шесть запросов — шесть SMS).
 *
 * Двухключевая форма (`$1::int, hashtext(phone)`) — чтобы этот замок
 * никогда не столкнулся с одноключевым `CATEGORIES_LOCK` (`routes/admin.ts`):
 * у одноключевой формы 64-битный ключ делится пополам, а здесь оба
 * 32-битных ключа свои.
 *
 * Advisory, а не `select … for update`: у незарегистрированного номера нет
 * строки в `otp_codes`, которую можно запереть.
 */
const OTP_PHONE_LOCK = 4_210_002

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }
  const otpSecret = () => {
    const s = app.appConfig.jwtRefreshSecret ?? app.appConfig.jwtAccessSecret
    if (!s) throw new AppError(503, 'not_configured', 'Сервер не настроен: нет секрета для кодов')
    return s
  }

  /** Новая сессия — новое устройство. Обновление токена сессию не заводит. */
  async function issueTokens(userId: string, device: string | null): Promise<Tokens> {
    const refreshToken = createRefreshToken()
    const sessionId = uuidv7()
    await db().query(
      `insert into sessions (id, user_id, refresh_hash, device, created_at, last_used_at)
       values ($1, $2, $3, $4, now(), now())`,
      [sessionId, userId, hashRefreshToken(refreshToken), device],
    )
    return withUser(userId, sessionId, refreshToken)
  }

  /**
   * Обновление токенов внутри существующей сессии: строка та же, меняется
   * только хеш. Прежний сохраняется — по нему ловится повторное предъявление
   * украденного токена.
   *
   * Обмен — сравнение с заменой: строка меняется, только если в ней ещё
   * лежит предъявленный хеш. Без условия две вкладки с одним истёкшим access
   * обменивали один и тот же refresh обе: каждая получала свою пару, в базе
   * оставалась последняя, а первая вкладка держала токен, которого нет
   * нигде, — и следующим обновлением выкидывала из приложения обе (D1-06).
   * Проигравшей отвечаем «уже обменян»: клиент умеет взять свежую пару из
   * общего хранилища.
   */
  async function rotateTokens(userId: string, sessionId: string, oldHash: string): Promise<Tokens> {
    const refreshToken = createRefreshToken()
    const swapped = await db().query(
      `update sessions
          set refresh_hash = $2, prev_refresh_hash = $3, rotated_at = now(), last_used_at = now()
        where id = $1 and refresh_hash = $3 and revoked_at is null`,
      [sessionId, hashRefreshToken(refreshToken), oldHash],
    )
    if (swapped.rowCount === 0) {
      // Перечитываем, чтобы назвать причину: сессию успели завершить или токен успели обменять.
      const { rows } = await db().query<{ revoked_at: Date | null }>('select revoked_at from sessions where id = $1', [
        sessionId,
      ])
      if (!rows[0] || rows[0].revoked_at) throw unauthorized('Сессия завершена — войдите заново')
      throw new AppError(401, 'refresh_superseded', 'Токен обновления уже обменян — возьмите новый из хранилища')
    }
    return withUser(userId, sessionId, refreshToken)
  }

  async function withUser(userId: string, sessionId: string, refreshToken: string): Promise<Tokens> {
    const accessToken = await signAccessToken(app.appConfig.jwtAccessSecret!, { sub: userId, sid: sessionId })
    const { rows } = await db().query<{ id: string; name: string | null; phone: string }>(
      'select id, name, phone from users where id = $1',
      [userId],
    )
    return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user: rows[0]! }
  }

  /* ── запрос кода ──────────────────────────────────────────────────── */
  app.post(
    '/auth/otp',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone'],
          properties: { phone: { type: 'string', minLength: 1, maxLength: 32 } },
        },
      },
    },
    async (request, reply) => {
      const phone = normalizePhone((request.body as { phone: string }).phone)

      // Коды старше суток не нужны ни для проверки, ни для ограничения
      // частоты (самое длинное окно — «номер за сутки»), а номер телефона —
      // персональные данные: хранить их дольше нельзя.
      // Уборка здесь, а не в кроне: таблица растёт только от этого запроса.
      await db().query("delete from otp_codes where created_at < now() - interval '24 hours'")

      const ip = clientIp(request)
      /* Лимиты на номер (фича 005, В3): пара «номер + адрес» — 3 в час,
       * номер — 10 в час и 30 в сутки. Прежний «5 в час на номер» считал
       * всех вместе, и посторонний, знающий чужой номер, пятью запросами
       * закрывал жертве вход на час. Теперь в лимит упирается тот, кто
       * запрашивал: у владельца номера с другого адреса своя пара.
       *
       * Все окна — из одной выборки, возраст выдач считает база: `Retry-After`
       * обязан назвать секунды до освобождения окна по `created_at`, а часы
       * сервера с часами базы для этого лучше не смешивать. Строк на номер
       * за сутки — не больше суточного потолка, выборка маленькая. */
      /*
       * Окно лимитов, потолки и вставка — одной транзакцией под замком на
       * номер (ревью 016, R-271): иначе шесть параллельных запросов видят
       * одно и то же пустое окно и все шесть проходят до вставки — шесть
       * SMS и шесть живых кодов на один номер разом (счёт наш, а «неверных»
       * попыток при проверке впятеро больше положенного). Общий потолок и
       * потолок по адресу остаются мягкими проверками внутри той же
       * транзакции: у разных номеров разные замки, поэтому бурст на разные
       * номера с одного адреса их всё ещё может обойти — это сигнал массовой
       * рассылки, а не защита конкретной жертвы, и здесь не расширяется.
       */
      const { code, codeId } = await db().tx(async (client) => {
        // Замок на конкретный номер, не на таблицу: бурст на другой номер
        // под этот замок не попадает и не ждёт. Ключ — hashtext(phone), а
        // не сам номер: аргумент advisory-блокировки — int, а не text.
        await client.query('select pg_advisory_xact_lock($1::int, hashtext($2))', [OTP_PHONE_LOCK, phone])

        const { rows: sends } = await client.query<{ age_s: string; same_ip: boolean | null }>(
          `select extract(epoch from (now() - created_at))::text as age_s, (ip = $2::inet) as same_ip
             from otp_codes
            where phone = $1 and created_at > now() - interval '24 hours'
            order by created_at desc`,
          [phone, ip],
        )
        const ages = sends.map((r) => ({ age: Number(r.age_s), sameIp: r.same_ip === true }))

        const newest = ages[0]
        if (newest && newest.age < RESEND_AFTER_SECONDS) {
          throw new TooManyRequests(Math.ceil(RESEND_AFTER_SECONDS - newest.age), 'Код уже отправлен. Подождите немного.')
        }

        const HOUR = 3600
        const DAY = 24 * HOUR
        const windows = [
          {
            seconds: HOUR,
            max: app.appConfig.otpMaxPerPhoneIpHour,
            ages: ages.filter((a) => a.sameIp && a.age < HOUR),
            message: 'Слишком много запросов кода на этот номер с вашего адреса. Попробуйте позже.',
          },
          {
            seconds: HOUR,
            max: app.appConfig.otpMaxPerPhoneHour,
            ages: ages.filter((a) => a.age < HOUR),
            message: 'Слишком много запросов кода на этот номер. Попробуйте позже.',
          },
          {
            seconds: DAY,
            max: app.appConfig.otpMaxPerPhoneDay,
            ages,
            message: 'Слишком много запросов кода на этот номер за сутки. Попробуйте позже.',
          },
        ]
        for (const w of windows) {
          if (w.ages.length >= w.max) {
            throw new TooManyRequests(
              windowFreesIn(
                w.ages.map((a) => a.age),
                w.seconds,
                w.max,
              ),
              w.message,
            )
          }
        }

        // Потолок на все отправки: лимиты на номер и на адрес обходятся списком
        // номеров и ботнетом, а счёт за SMS приходит нам. Срабатывание — авария,
        // а не обычный отказ: в норме до него не доходит.
        const { rows: total } = await client.query<{ sends: string }>(
          `select count(*)::text as sends from otp_codes where created_at > now() - interval '1 hour'`,
        )
        if (Number(total[0]?.sends ?? 0) >= app.appConfig.otpMaxPerHourTotal) {
          request.log.error(
            { sends: Number(total[0]!.sends), limit: app.appConfig.otpMaxPerHourTotal },
            'достигнут часовой потолок отправки кодов — похоже на перебор номеров',
          )
          throw new TooManyRequests(3600, 'Сервис временно не отправляет коды. Попробуйте позже.')
        }

        if (ip) {
          // Лимит на номер не мешает перебирать номера: по одному коду на тысячу
          // чужих телефонов. Платим мы, а сообщения получают незнакомые люди.
          const { rows: byIp } = await client.query<{ sends: string }>(
            `select count(*)::text as sends from otp_codes
              where ip = $1 and created_at > now() - interval '1 hour'`,
            [ip],
          )
          if (Number(byIp[0]?.sends ?? 0) >= app.appConfig.otpMaxPerIpHour) {
            throw new TooManyRequests(3600, 'Слишком много запросов кода. Попробуйте через час.')
          }
        }

        const code = generateCode()
        const codeId = uuidv7()
        await client.query(
          `insert into otp_codes (id, phone, code_hash, expires_at, ip)
           values ($1, $2, $3, now() + ($4 || ' seconds')::interval, $5)`,
          [codeId, phone, hashCode(otpSecret(), phone, code), String(CODE_TTL_SECONDS), ip],
        )
        return { code, codeId }
      })

      try {
        await app.sms.send(phone, codeMessage(code))
      } catch (error) {
        /* SMS не ушла — строки кода быть не должно: иначе отказ провайдера
         * считался бы отправкой в паузе между кодами и в лимитах на номер, и
         * человек без единой SMS упирался бы в 429 (ревью 015). */
        await db().query('delete from otp_codes where id = $1', [codeId]).catch(() => undefined)
        request.log.error({ err: error, phone: maskPhone(phone) }, 'не удалось отправить код')
        throw new AppError(502, 'sms_failed', 'Не удалось отправить SMS. Попробуйте ещё раз через минуту.')
      }

      // Ответ одинаков и для нового номера, и для известного: иначе перебором
      // выясняется, кто зарегистрирован в сервисе.
      return reply.code(200).send({ expiresIn: CODE_TTL_SECONDS, resendAfter: RESEND_AFTER_SECONDS })
    },
  )

  /* ── проверка кода ────────────────────────────────────────────────── */
  app.post(
    '/auth/otp/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'code'],
          properties: {
            phone: { type: 'string', minLength: 1, maxLength: 32 },
            code: { type: 'string', minLength: 4, maxLength: 8 },
            device: { type: 'string', maxLength: 120 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as { phone: string; code: string; device?: string }
      const phone = normalizePhone(body.phone)

      /* Проверяются ВСЕ живые коды номера, а не только последний (ревью 015):
       * посторонний, запросивший код на чужой номер через минуту после
       * владельца, делал код владельца «неверным» — сверка шла с новейшим.
       *
       * Попытка засчитывается ДО сравнения и одним запросом с проверкой
       * предела — на каждый живой код: раздельно «прочитал — сравнил —
       * записал» восемь параллельных неверных кодов проходили порог, а шестой
       * инкремент упирался в CHECK `attempts <= 5` — 500 вместо 429, и перебор
       * получал больше пяти попыток на код (D1-07). Условие `attempts < 5` в
       * UPDATE атомарно: код, исчерпавший попытки, из выборки выпадает. */
      const entered = hashCode(otpSecret(), phone, body.code)
      const { rows: alive } = await db().query<{ id: string; code_hash: string }>(
        `update otp_codes set attempts = attempts + 1
          where phone = $1 and consumed_at is null and expires_at > now() and attempts < $2
          returning id, code_hash`,
        [phone, MAX_ATTEMPTS],
      )
      if (alive.length === 0) {
        const { rows: exhausted } = await db().query(
          'select 1 from otp_codes where phone = $1 and consumed_at is null and expires_at > now() limit 1',
          [phone],
        )
        if (exhausted.length > 0) throw new TooManyRequests(60, 'Слишком много попыток. Запросите новый код.')
        throw unauthorized('Код неверный или устарел. Запросите новый.')
      }
      /* Сравнение дайджестов — `safeEqual` (постоянное время), а не `===`.
       * Эксплуатации здесь нет — дайджест ключевой (HMAC на секрете), и
       * попыток всего пять, но функция для того и написана, а лежала
       * неиспользованной (F-RL-1-04, ревью 016): сравнение секретов через
       * `===` — привычка, которая рано или поздно переедет туда, где она стоит денег. */
      const otp = alive.find((row) => safeEqual(row.code_hash, entered))
      if (!otp) throw unauthorized('Код неверный или устарел. Запросите новый.')

      /* Строка старше окна восстановления — стирается сразу, до входа
       * (фича 014, A18). Уборка ежечасная, и до её прохода вход выдавал
       * токены, с которыми каждый запрос отвечал 401 «Аккаунт удалён»: SMS
       * потрачена, войти нельзя. Путь — тот же, что у уборки (`eraseUser`),
       * в одной транзакции; ниже заводится новый аккаунт с чистой историей.
       * Стирание — ДО гашения кода: сбой на большой свадьбе оставляет код
       * живым, и повтор ввода не требует новой SMS (ревью 015). */
      const { rows: stale } = await db().query<{ id: string }>(
        `select id from users
          where phone = $1 and deleted_at is not null and deleted_at <= now() - make_interval(days => $2::int)`,
        [phone, RESTORE_WINDOW_DAYS],
      )
      if (stale[0]) {
        await db().tx((client) => eraseUser(client, stale[0]!.id, { preserveOtpCodeId: otp.id }))
      }

      // Гасим код до выдачи токенов: два одновременных запроса с одним кодом
      // не должны завести две сессии. Условие consumed_at is null делает
      // обновление атомарным — второй запрос не получит ни одной строки.
      const consumed = await db().query('update otp_codes set consumed_at = now() where id = $1 and consumed_at is null', [
        otp.id,
      ])
      if (consumed.rowCount === 0) throw unauthorized('Код уже использован. Запросите новый.')

      // Регистрация и вход — одно и то же действие. Гонку закрывает
      // уникальность телефона в БД, а не проверка «а есть ли уже такой».
      const { rows: userRows } = await db().query<{ id: string }>(
        `insert into users (id, phone) values ($1, $2)
         on conflict (phone) do update set phone = excluded.phone
         returning id`,
        [uuidv7(), phone],
      )
      const userId = userRows[0]!.id

      /* Мягко удалённый аккаунт возвращается входом (фича 005, В2).
       *
       * Строка живёт 30 дней после `DELETE /users/me` (План §19.1), и до
       * 2026-09-11 вход в это окно выдавал токены, с которыми каждый запрос
       * и refresh отвечали 401 «Аккаунт удалён»: SMS потрачена, а войти
       * нельзя. Срок — условием самого `update`: строку старше окна вот-вот
       * сотрёт уборка (`eraseDeletedUsers`), и воскрешать её значило бы
       * обещать данные, которых через час не будет. Сессии, погашенные при
       * удалении, не возвращаются — новая заводится ниже. Согласие тоже:
       * его отзыв — отдельное решение человека, и после восстановления оно
       * спрашивается заново (`consentRequired`). */
      const restored = await db().query(
        `update users set deleted_at = null
          where id = $1 and deleted_at is not null and deleted_at > now() - make_interval(days => $2::int)`,
        [userId, RESTORE_WINDOW_DAYS],
      )
      if (restored.rowCount) {
        await db().query(
          `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'user.restored', 'user', $1)`,
          [userId],
        )
      }

      await db().query('insert into notification_prefs (user_id) values ($1) on conflict do nothing', [userId])
      await db().query(
        `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'auth.login', 'user', $1)`,
        [userId],
      )

      /* Есть ли живое согласие под действующей редакцией. У нового аккаунта
       * согласия нет вовсе; у восстановленного после `DELETE /users/me/consent`
       * — тоже (там ставится `withdrawn_at`); у вошедшего под старой редакцией
       * (F4, RL-1) — есть, но не действующее. Признак в ответе — чтобы клиент
       * показал согласие заново, а не узнал о нём по 403 на первом же экране. */
      const consentRequired = (await consentState(db(), userId, app.appConfig.policyVersion)) !== 'current'
      const tokens = await issueTokens(userId, body.device ?? request.headers['user-agent'] ?? null)
      return { ...tokens, consentRequired }
    },
  )

  /* ── обновление токенов ───────────────────────────────────────────── */
  app.post(
    '/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: { refreshToken: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
    },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string }
      const hash = hashRefreshToken(refreshToken)

      const { rows } = await db().query<{
        id: string
        user_id: string
        device: string | null
        revoked_at: Date | null
        last_used_at: Date
        rotated_at: Date | null
        current: boolean
        deleted_at: Date | null
      }>(
        `select s.id, s.user_id, s.device, s.revoked_at, s.last_used_at, s.rotated_at,
                (s.refresh_hash = $1) as current, u.deleted_at
           from sessions s join users u on u.id = s.user_id
          where s.refresh_hash = $1 or s.prev_refresh_hash = $1`,
        [hash],
      )
      const session = rows[0]
      if (!session) throw unauthorized('Токен обновления недействителен')

      if (session.deleted_at) {
        /* Мягко удалённый аккаунт: `assertLiveSession` отвечает ему 401 на
         * каждом запросе, а обмен токенов до 2026-09-11 проходил — клиент
         * ходил по кругу «401 → refresh 200 → повтор → 401», ротируя пару
         * впустую. Сессию гасим: она заведена повторным входом удалённого
         * (сам вход — решение владельца, см. D6-05) и больше ни к чему. */
        await db().query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [session.id])
        throw unauthorized('Аккаунт удалён')
      }

      if (!session.current && session.rotated_at && Date.now() - session.rotated_at.getTime() < REFRESH_GRACE_MS) {
        /* Прежний refresh предъявлен через секунды после обмена — это не
         * вор, а вторая вкладка того же браузера: обе проснулись с одним
         * истёкшим access и обе пошли обновляться, вторая — уже со старым
         * токеном. До 2026-09-06 это считалось кражей и гасило ВСЕ сессии
         * человека за то, что у него открыты две вкладки. Ей отвечаем
         * «уже обменян» без гашения: свежая пара у первой вкладки жива,
         * а хранилище у них общее. Окно короткое: вор со старым токеном
         * внутри него получает ровно то же — ничего. */
        throw new AppError(401, 'refresh_superseded', 'Токен обновления уже обменян — возьмите новый из хранилища')
      }

      if (!session.current) {
        // Предъявлен предыдущий refresh этой сессии. Настоящий владелец так
        // не делает: его клиент уже получил новый. Значит, токен украли —
        // и неизвестно, у кого сейчас свежий. Выводим отовсюду.
        await db().query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [
          session.user_id,
        ])
        await db().query(
          `insert into audit_log (actor_id, action, entity, entity_id)
           values ($1, 'auth.refresh_reuse', 'session', $2)`,
          [session.user_id, session.id],
        )
        throw unauthorized('Токен обновления уже использован. Все сессии завершены — войдите заново.')
      }

      if (session.revoked_at) {
        /* Завершённая сессия предъявляет свой же ТЕКУЩИЙ refresh. Это не вор,
         * а выгнанное устройство: человек нажал «выйти везде» или завершил
         * его со списка, а оно, получив 401 на access, штатно пошло обновлять
         * пару. До 2026-09-11 это считалось кражей и гасило ВСЕ сессии —
         * включая ту, с которой только что выгоняли постороннего; через
         * четверть часа она вылетала следом (D1-01). Кража — это прежний хеш
         * за окном grace, и она обработана выше. Здесь — просто 401. */
        throw unauthorized('Сессия завершена — войдите заново')
      }

      // 30 дней бездействия, а не 30 дней с первого входа: created_at теперь
      // хранит настоящее время входа и показывается на экране устройств.
      if (Date.now() - session.last_used_at.getTime() > REFRESH_TTL_SECONDS * 1000) {
        await db().query('update sessions set revoked_at = now() where id = $1', [session.id])
        throw unauthorized('Сессия истекла — войдите заново')
      }

      return rotateTokens(session.user_id, session.id, hash)
    },
  )

  /* ── OAuth ────────────────────────────────────────────────────────── */
  app.get(
    '/auth/oauth/:provider',
    async () => {
      // Не реализовано намеренно, а не забыто: нужны приложения во ВКонтакте,
      // Яндексе, Google и Telegram — их регистрирует владелец. На экране входа
      // во фронте кнопок OAuth сейчас нет вообще, продукт этим путём не ходит.
      throw new AppError(
        501,
        'oauth_not_configured',
        'Вход через соцсети не подключён: нужны приложения провайдеров. Пока вход по коду из SMS.',
      )
    },
  )
}
