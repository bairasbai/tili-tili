import 'dotenv/config'
import { MAX_SENDS_PER_HOUR_PER_IP, MAX_SENDS_PER_HOUR_TOTAL } from './auth/otp.js'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, type TillyConfig, type TillyProvider } from './tilly/model.js'

export const ENVS = ['development', 'test', 'production'] as const
export type Env = (typeof ENVS)[number]

/**
 * Лимиты выдачи кода на номер (фича 005, В3; спека FR-008).
 *
 * Прежний «5 в час на номер» считал всех вместе: посторонний, знающий чужой
 * номер, пятью запросами с одного адреса закрывал жертве вход на час.
 * Теперь рабочий ограничитель — пара «номер + адрес»: три кода в час, и
 * упирается в него тот, кто их запросил. Потолки по номеру — от рассылки
 * с многих адресов: десять в час и тридцать в сутки на один номер хватает
 * любому живому человеку, а счёт за SMS они держат.
 */
export const MAX_SENDS_PER_PHONE_IP_HOUR = 3
export const MAX_SENDS_PER_PHONE_HOUR = 10
export const MAX_SENDS_PER_PHONE_DAY = 30

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
   * Лимиты выдачи кода на НОМЕР (фича 005, В3). Пара «номер + адрес» —
   * рабочий ограничитель: посторонний с одного адреса упирается в него, а
   * владелец номера с другого адреса код получает. Потолки по номеру за час
   * и за сутки — от рассылки с многих адресов за наши деньги.
   */
  otpMaxPerPhoneIpHour: number
  otpMaxPerPhoneHour: number
  otpMaxPerPhoneDay: number
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
  /** Сколько подарков один гость держит в резерве одновременно (§9). */
  reservationsMaxPerGuest: number
  /** Запросов в секунду на токен (§13.4). Ноль выключает ограничитель. */
  rateLimitPerSecond: number
  /** Сколько новых переписок в день начинает НЕпроверенный подрядчик (§18.2). */
  coldOutreachPerDay: number
  /** Сколько дней отменённая свадьба лежит в архиве, прежде чем уборка сотрёт её. */
  weddingArchiveDays: number
  /**
   * Где лежат приватные подтверждения оплат (018-B). `db` — файл до 512 КБ в
   * самой базе; пусто — загрузка новых выключена и отвечает 501
   * `storage_not_configured`, а список, скачивание и удаление уже загруженных
   * работают. По умолчанию выключено: файлы в базе раздувают её и резервные
   * копии, и включает их владелец, а не выкладка (ревью 018, BB-01).
   */
  receiptsStorage: 'db' | null
  /** Квоты подтверждений на свадьбу: файлов и байт всего (ревью 018, BB-01). */
  receiptsMaxPerWedding: number
  receiptsMaxBytesPerWedding: number
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
  /**
   * Языковая модель за Тилем (фича 010). Провайдер пуст — Тиль отвечает честной
   * заглушкой, и сервер стартует и в production: без SMS входа нет, без Тиля —
   * есть. Провайдер назван, а ключа/адреса нет — ошибка на старте.
   */
  tilly: TillyConfig
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

/** `RECEIPTS_STORAGE`: `db` или пусто. Опечатка — ошибка на старте, а не тихо выключенная загрузка. */
function parseReceiptsStorage(raw: string | undefined): 'db' | null {
  const value = envText(raw)
  if (value === null) return null
  if (value.trim() === 'db') return 'db'
  throw new ConfigError(`RECEIPTS_STORAGE — db или пусто (загрузка подтверждений оплат выключена). Получено: ${JSON.stringify(raw)}`)
}

const TILLY_PROVIDERS: readonly TillyProvider[] = ['openrouter', 'ollama', 'openai']

/**
 * Тиль: провайдер, адрес, ключ, модели — из `TILLY_*` (фича 010, В1).
 *
 * Один протокол на всех (OpenAI-совместимые chat completions), поэтому
 * умолчания — по провайдеру: OpenRouter — `https://openrouter.ai/api/v1` и
 * маршрутизатор бесплатных моделей `openrouter/free` (В2); Ollama на своём
 * сервере — `http://127.0.0.1:11434/v1` и `hermes3`; `openai` — любой
 * совместимый сервер (vLLM, llama.cpp, LM Studio) — адрес и модель обязательны.
 * `TILLY_MODEL` через запятую — основная и запасные (OpenRouter `models[]`).
 * Неполная настройка — `ConfigError`: провайдер без ключа молча превращал бы
 * Тиля в «временно без ИИ» на каждый вопрос, и это заметили бы через неделю.
 */
function parseTilly(source: NodeJS.ProcessEnv): TillyConfig {
  const rawProvider = envText(source.TILLY_PROVIDER)
  if (rawProvider !== null && !(TILLY_PROVIDERS as readonly string[]).includes(rawProvider)) {
    throw new ConfigError(`TILLY_PROVIDER — один из: ${TILLY_PROVIDERS.join(', ')} или пусто (Тиль без ИИ). Получено: ${JSON.stringify(rawProvider)}`)
  }
  const provider = rawProvider as TillyProvider | null
  const models = (source.TILLY_MODEL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const config: TillyConfig = {
    provider,
    baseUrl: envText(source.TILLY_BASE_URL) ?? (provider ? DEFAULT_BASE_URL[provider] : null),
    apiKey: envText(source.TILLY_API_KEY),
    models: models.length ? models : provider && DEFAULT_MODEL[provider] ? [DEFAULT_MODEL[provider]!] : [],
    dailyLimit: Math.max(1, Math.round(envNumber(source.TILLY_DAILY_LIMIT, 50))),
    timeoutMs: Math.max(1_000, Math.round(envNumber(source.TILLY_TIMEOUT_MS, 60_000))),
    maxTokens: Math.max(64, Math.round(envNumber(source.TILLY_MAX_TOKENS, 1_500))),
    temperature: Math.min(2, Math.max(0, envNumber(source.TILLY_TEMPERATURE, 0.4))),
  }
  if (provider === 'openrouter' && !config.apiKey) {
    throw new ConfigError('TILLY_PROVIDER=openrouter требует TILLY_API_KEY (ключ с openrouter.ai/keys)')
  }
  if (provider && (!config.baseUrl || config.models.length === 0)) {
    throw new ConfigError(`TILLY_PROVIDER=${provider} требует TILLY_BASE_URL и TILLY_MODEL`)
  }
  return config
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
    host: envText(source.HOST) ?? '0.0.0.0',
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
    /* `envText`, не `??`: `.env` из шаблона оставляет `POLICY_VERSION=` пустым,
     * и пустая версия делала согласие невозможным — схема требует хотя бы
     * один знак, а сравнение ждало пустую строку (ревью 015). */
    policyVersion: envText(source.POLICY_VERSION) ?? '2026-09-02',
    otpMaxPerIpHour: envNumber(source.OTP_MAX_PER_IP_HOUR, MAX_SENDS_PER_HOUR_PER_IP),
    otpMaxPerHourTotal: envNumber(source.OTP_MAX_PER_HOUR_TOTAL, MAX_SENDS_PER_HOUR_TOTAL),
    otpMaxPerPhoneIpHour: envNumber(source.OTP_MAX_PER_PHONE_IP_HOUR, MAX_SENDS_PER_PHONE_IP_HOUR),
    otpMaxPerPhoneHour: envNumber(source.OTP_MAX_PER_PHONE_HOUR, MAX_SENDS_PER_PHONE_HOUR),
    otpMaxPerPhoneDay: envNumber(source.OTP_MAX_PER_PHONE_DAY, MAX_SENDS_PER_PHONE_DAY),
    trustProxy: parseTrustProxy(source.TRUST_PROXY),
    albumMaxPerGuest: envNumber(source.ALBUM_MAX_PER_GUEST, 50),
    contributionsMaxPerGuest: envNumber(source.CONTRIBUTIONS_MAX_PER_GUEST, 20),
    reservationsMaxPerGuest: envNumber(source.RESERVATIONS_MAX_PER_GUEST, 5),
    rateLimitPerSecond: envNumber(source.RATE_LIMIT_PER_SECOND, 10),
    coldOutreachPerDay: envNumber(source.COLD_OUTREACH_PER_DAY, 5),
    weddingArchiveDays: parseArchiveDays(source.WEDDING_ARCHIVE_DAYS),
    receiptsStorage: parseReceiptsStorage(source.RECEIPTS_STORAGE),
    receiptsMaxPerWedding: Math.max(1, Math.round(envNumber(source.RECEIPTS_MAX_PER_WEDDING, 50))),
    receiptsMaxBytesPerWedding: Math.max(524_288, Math.round(envNumber(source.RECEIPTS_MAX_BYTES_PER_WEDDING, 25 * 1024 * 1024))),
    sentryDsn: envText(source.SENTRY_DSN),
    vapidPublicKey: envText(source.VAPID_PUBLIC_KEY),
    vapidPrivateKey: envText(source.VAPID_PRIVATE_KEY),
    vapidSubject: envText(source.VAPID_SUBJECT) ?? 'mailto:support@tili-tili.ru',
    smsProvider: envText(source.SMS_PROVIDER),
    smsAeroEmail: envText(source.SMSAERO_EMAIL),
    smsAeroKey: envText(source.SMSAERO_KEY),
    smsAeroSign: envText(source.SMSAERO_SIGN),
    tilly: parseTilly(source),
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
