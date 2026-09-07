import 'dotenv/config'
import { MAX_SENDS_PER_HOUR_PER_IP, MAX_SENDS_PER_HOUR_TOTAL } from './auth/otp.js'

export const ENVS = ['development', 'test', 'production'] as const
export type Env = (typeof ENVS)[number]

export interface Config {
  env: Env
  port: number
  host: string
  corsOrigins: string[]
  databaseUrl: string | null
  redisUrl: string | null
  jwtAccessSecret: string | null
  jwtRefreshSecret: string | null
  /** Версия текстов оферты и политики, под которой сейчас даётся согласие. */
  policyVersion: string
  /** Порог запросов кода с одного адреса в час. Настраивается: за CGNAT нужен выше. */
  otpMaxPerIpHour: number
  /** Потолок на ВСЕ отправки кода в час — защита счёта за SMS. */
  otpMaxPerHourTotal: number
  /**
   * Доверять ли заголовку X-Forwarded-For. `false` — адрес берётся из сокета;
   * число — сколько прокси стоит впереди. Значение по умолчанию false, потому
   * что безусловное доверие превращает ограничитель по адресу в украшение.
   */
  trustProxy: boolean | number
  /** Сколько кадров может добавить один гость. */
  albumMaxPerGuest: number
  /** Сколько взносов один гость делает в один подарок или фонд. */
  contributionsMaxPerGuest: number
  /** Запросов в секунду на токен (§13.4). Ноль выключает ограничитель. */
  rateLimitPerSecond: number
  /** Сколько новых переписок в день начинает НЕпроверенный подрядчик (§18.2). */
  coldOutreachPerDay: number
  /** Сколько дней отменённая свадьба лежит в архиве, прежде чем уборка сотрёт её. */
  weddingArchiveDays: number
  /** Куда слать неожиданные ошибки. Пусто — не слать никуда и сказать об этом. */
  sentryDsn: string | null
  /** Ключи Web Push. Пока их нет, подписка отвечает 501 — см. routes/notifications. */
  vapidPublicKey: string | null
  vapidPrivateKey: string | null
  /** Контакт отправителя: спецификация Web Push требует mailto: или адрес сайта. */
  vapidSubject: string
  smsProvider: string | null
  smsAeroEmail: string | null
  smsAeroKey: string | null
  smsAeroSign: string | null
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

function required(name: string, value: string | undefined): string {
  if (!value) throw new ConfigError(`Переменная окружения ${name} обязательна в production. См. .env.example`)
  return value
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3000
  const n = Number(raw)
  // Number('три') — это NaN, и listen({ port: NaN }) падает где-то глубоко
  // внутри Node сообщением, по которому опечатку в переменной не найти.
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new ConfigError(`PORT должен быть целым числом 1..65535, получено: ${JSON.stringify(raw)}`)
  }
  return n
}

/**
 * `TRUST_PROXY` — сколько обратных прокси стоит перед приложением.
 *
 * Безусловное `true` означает «верю заголовку X-Forwarded-For от кого угодно»:
 * любой клиент присылает `X-Forwarded-For: 1.2.3.4`, и ограничитель по адресу
 * обходится одной строкой. Поэтому по умолчанию заголовку не верим, а за
 * балансировщиком Timeweb ставится число прыжков (обычно 1).
 */
function parseTrustProxy(raw: string | undefined): boolean | number {
  if (raw === undefined || raw === '' || raw === 'false') return false
  const hops = Number(raw)
  if (Number.isInteger(hops) && hops >= 0) return hops
  throw new ConfigError(`TRUST_PROXY — число прокси впереди (обычно 1) или пусто. Получено: ${JSON.stringify(raw)}`)
}

/*
 * Число из переменной окружения.
 *
 * `Number(source.X ?? 50)` выглядит как «значение по умолчанию 50», но `??`
 * срабатывает только на `undefined`. В `.env`, собранном из `.env.example`,
 * необязательные ключи стоят пустыми — а `Number('')` это ноль. Так предел
 * загрузок в альбом становился нулём, и гость получал 429 на первый же кадр,
 * не нарушив ничего.
 */
function envNumber(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/** Строка из окружения: пустая тоже значит «не задано». */
function envText(raw: string | undefined): string | null {
  return raw === undefined || raw.trim() === '' ? null : raw
}

/**
 * Срок хранения отменённой свадьбы в днях (План §19.1 — 12 месяцев).
 *
 * Число отсюда уходит в `make_interval(days => …)` уборки архива, и уборка
 * по нему УДАЛЯЕТ свадьбы со всем содержимым. Поэтому граница снизу и
 * округление — не украшение:
 *   `WEDDING_ARCHIVE_DAYS=0` стёрло бы всё отменённое в первый же час;
 *   `-1` стёрло бы вообще всё отменённое, включая отменённое завтра;
 *   `0.5` уронил бы `make_interval`, а с ним и всю остальную уборку — она
 *   идёт одним списком, как когда-то падало стирание аккаунтов.
 *
 * Мусор и пустая строка дают значение по умолчанию (`envNumber`).
 * Предупреждения в лог тут нет намеренно: конфигурация читается до того,
 * как появляется логгер Fastify, а `console.warn` в проде уходит мимо
 * структурированного лога и не находится по requestId.
 */
function parseArchiveDays(raw: string | undefined): number {
  return Math.max(30, Math.round(envNumber(raw, 365)))
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const rawEnv = source.NODE_ENV ?? 'development'
  // Опечатка вроде NODE_ENV=prod тихо переводит сервер в режим разработки:
  // секреты перестают быть обязательными, и он поднимается в проде без них.
  if (!(ENVS as readonly string[]).includes(rawEnv)) {
    throw new ConfigError(`NODE_ENV должен быть одним из: ${ENVS.join(', ')}. Получено: ${JSON.stringify(rawEnv)}`)
  }
  const env = rawEnv as Env
  const production = env === 'production'

  const corsOrigins = (source.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Пустой список в проде означает «браузеру запрещено всё»: приложение
  // поднимется и будет отвечать на curl, а фронт получит ошибку CORS
  // на каждый запрос. Такое лучше поймать на старте.
  if (production && corsOrigins.length === 0) {
    throw new ConfigError('CORS_ORIGINS обязателен в production, иначе фронт не сможет обратиться к API')
  }

  const config: Config = {
    env,
    port: parsePort(source.PORT),
    host: source.HOST ?? '0.0.0.0',
    corsOrigins,
    // В production подключения обязательны: сервер без базы поднимется и будет
    // отдавать 200 на /health, притворяясь живым. Лучше не стартовать вовсе.
    databaseUrl: production ? required('DATABASE_URL', source.DATABASE_URL) : envText(source.DATABASE_URL),
    redisUrl: production ? required('REDIS_URL', source.REDIS_URL) : envText(source.REDIS_URL),
    jwtAccessSecret: production
      ? required('JWT_ACCESS_SECRET', source.JWT_ACCESS_SECRET)
      : (source.JWT_ACCESS_SECRET ?? null),
    jwtRefreshSecret: production
      ? required('JWT_REFRESH_SECRET', source.JWT_REFRESH_SECRET)
      : (source.JWT_REFRESH_SECRET ?? null),
    // Версия документа записывается в согласие и служит доказательством по
    // 152-ФЗ. Клиент присылает ту, которую показал человеку; если она разошлась
    // с серверной, согласие не принимается — иначе в базе окажется подпись
    // под текстом, которого пользователь не видел.
    policyVersion: source.POLICY_VERSION ?? '2026-09-02',
    otpMaxPerIpHour: envNumber(source.OTP_MAX_PER_IP_HOUR, MAX_SENDS_PER_HOUR_PER_IP),
    otpMaxPerHourTotal: envNumber(source.OTP_MAX_PER_HOUR_TOTAL, MAX_SENDS_PER_HOUR_TOTAL),
    trustProxy: parseTrustProxy(source.TRUST_PROXY),
    albumMaxPerGuest: envNumber(source.ALBUM_MAX_PER_GUEST, 50),
    contributionsMaxPerGuest: envNumber(source.CONTRIBUTIONS_MAX_PER_GUEST, 20),
    rateLimitPerSecond: envNumber(source.RATE_LIMIT_PER_SECOND, 10),
    coldOutreachPerDay: envNumber(source.COLD_OUTREACH_PER_DAY, 5),
    weddingArchiveDays: parseArchiveDays(source.WEDDING_ARCHIVE_DAYS),
    sentryDsn: envText(source.SENTRY_DSN),
    vapidPublicKey: envText(source.VAPID_PUBLIC_KEY),
    vapidPrivateKey: envText(source.VAPID_PRIVATE_KEY),
    vapidSubject: source.VAPID_SUBJECT ?? 'mailto:support@tili-tili.ru',
    smsProvider: envText(source.SMS_PROVIDER),
    smsAeroEmail: envText(source.SMSAERO_EMAIL),
    smsAeroKey: envText(source.SMSAERO_KEY),
    smsAeroSign: envText(source.SMSAERO_SIGN),
  }

  if (production) {
    // Один секрет на оба типа токенов означает, что refresh-токен принимается
    // там, где ждут access. Пара минут на генерацию второго — против кражи
    // сессии по протухшему токену.
    if (config.jwtAccessSecret === config.jwtRefreshSecret) {
      throw new ConfigError('JWT_ACCESS_SECRET и JWT_REFRESH_SECRET должны различаться')
    }
    for (const [name, value] of [
      ['JWT_ACCESS_SECRET', config.jwtAccessSecret],
      ['JWT_REFRESH_SECRET', config.jwtRefreshSecret],
    ] as const) {
      if ((value ?? '').length < 32) {
        throw new ConfigError(`${name} короче 32 символов. Сгенерировать: openssl rand -base64 48`)
      }
    }
  }

  return config
}
