import type { paths } from './schema'

/*
 * Слой запросов к API. Единственное место во фронте, которое ходит в сеть.
 *
 * Три вещи, ради которых он существует отдельным файлом:
 *
 * 1. Пути и тела берутся из openapi.yaml через schema.ts, а не пишутся руками.
 *    Опечатка в адресе или лишнее поле в теле — ошибка сборки, а не 404 в проде.
 * 2. Ошибка сети и ошибка приложения приходят в одном виде (ApiError). Экрану
 *    не нужно знать, отвалился ли fetch, пришёл ли 500 или тело без JSON.
 * 3. Протухший accessToken обновляется один раз на все параллельные запросы.
 *    Иначе десять запросов после разлогина дают десять обменов refresh, а он
 *    одноразовый: девять получат «повторное предъявление» и погасят все сессии
 *    пользователя (см. описание /auth/refresh в контракте).
 */

/** База адресов. В разработке — прокси Vite на бэкенд, в проде — переменная сборки. */
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api'

/** Сколько ждём ответ. Дольше — пользователь уже решил, что приложение зависло. */
const TIMEOUT_MS = 15_000

const TOKENS_KEY = 'tt_auth'

type Tokens = { accessToken: string; refreshToken: string }

function readTokens(): Tokens | null {
  try {
    const raw = localStorage.getItem(TOKENS_KEY)
    if (!raw) return null
    const t = JSON.parse(raw) as Partial<Tokens>
    return t.accessToken && t.refreshToken ? { accessToken: t.accessToken, refreshToken: t.refreshToken } : null
  } catch {
    /* приватный режим или заблокированные данные сайта — ведём себя как гость */
    return null
  }
}

export function saveTokens(t: Tokens | null): void {
  try {
    if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t))
    else localStorage.removeItem(TOKENS_KEY)
  } catch { /* см. readTokens */ }
}

export function isAuthorized(): boolean {
  return readTokens() !== null
}

/**
 * Токен для WebSocket.
 *
 * Живой канал не умеет заголовков — токен уходит строкой запроса, и это
 * единственное место, где он покидает заголовок. Отдельная функция, а не
 * экспорт `readTokens`: так видно, зачем токен понадобился снаружи.
 *
 * Обновлением здесь не занимаемся: канал живёт до истечения токена, дальше
 * сервер сам закрывает соединение, а клиент подключается заново со свежим.
 */
export function accessTokenForWs(): string | null {
  return readTokens()?.accessToken ?? null
}

/**
 * Ошибка запроса в одном виде.
 *
 * `kind` отвечает на вопрос «что показать пользователю», а не «что случилось
 * в протоколе»: сеть отвалилась, сервер отказал, или мы слишком долго ждали.
 */
export class ApiError extends Error {
  /* Поля объявлены явно, а не параметрами конструктора: tsconfig проекта
     включает erasableSyntaxOnly, а сокращённая запись оставляет код после
     стирания типов и потому запрещена. */
  readonly kind: 'network' | 'timeout' | 'http'
  readonly status: number
  readonly code: string
  /**
   * Какие поля не прошли проверку (только у 422): имя поля → что с ним не так.
   * Контракт отдаёт `error.fields` с v0.26.0; форма подсвечивает поле, а
   * человеку по-прежнему показывается `message`.
   */
  readonly fields: Readonly<Record<string, string>>

  constructor(
    kind: 'network' | 'timeout' | 'http',
    status: number,
    code: string,
    message: string,
    fields: Readonly<Record<string, string>> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
    this.fields = fields
  }

  /** Текст сервера про конкретное поле или `null`, если сервер поле не назвал. */
  field(name: string): string | null {
    return this.fields[name] ?? null
  }

  /**
   * Сервер недоступен целиком: сеть, таймаут или 5xx. Экраны показывают одно и то же.
   *
   * 501 — исключение: это не поломка, а честный ответ «этого сервер пока не
   * умеет» со своим текстом (`push_not_configured`, `storage_not_configured`,
   * `oauth_not_configured`). Показывать вместо него «Сервер недоступен»
   * значит прятать причину (аудит 2026-09-07, блок 8).
   */
  get isDown(): boolean {
    return this.kind !== 'http' || (this.status >= 500 && this.status !== 501)
  }
}

/* Обмен refresh идёт один на всех: остальные ждут этот же промис. */
let refreshing: Promise<Tokens | null> | null = null

async function refreshTokens(): Promise<Tokens | null> {
  const current = readTokens()
  if (!current) return null
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
      if (!res.ok) {
        /* Отказ на refresh не всегда значит «вход кончился». Вторая вкладка
           того же браузера могла обменять токен секундой раньше и уже
           положить новую пару в общее хранилище — тогда наш refresh просто
           устарел (сервер отвечает `refresh_superseded`). Стирать хранилище
           в этот момент значит выкинуть и ту вкладку, у которой всё в
           порядке. Сначала смотрим, не сменилась ли пара под нами. */
        const stored = readTokens()
        if (stored && stored.refreshToken !== current.refreshToken) return stored
        saveTokens(null)
        return null
      }
      const body = (await res.json()) as Tokens
      const next = { accessToken: body.accessToken, refreshToken: body.refreshToken }
      saveTokens(next)
      return next
    } catch {
      /* сеть отвалилась во время обмена — токены не трогаем, попробуем в другой раз */
      return null
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/**
 * Ключ идемпотентности.
 *
 * Бронь, оплата и другие необратимые действия требуют его заголовком: по нему
 * сервер отличает повтор одного нажатия от второго намерения. Без него двойной
 * тап по «Забронировать» на медленной сети создаёт две сделки, и вторую уже
 * никто не отменит.
 */
export const newIdempotencyKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${performance.now()}`

interface Options {
  /** Значение заголовка `Idempotency-Key` для необратимых действий. */
  idempotencyKey?: string
}

async function raw(method: Method, path: string, body: unknown, token: string | null, opts?: Options): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(BASE + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(method: Method, path: string, body?: unknown, opts?: Options): Promise<T> {
  let tokens = readTokens()
  let res: Response
  try {
    res = await raw(method, path, body, tokens?.accessToken ?? null, opts)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('timeout', 0, 'timeout', 'Сервер не ответил вовремя')
    }
    throw new ApiError('network', 0, 'network', 'Нет связи с сервером')
  }

  /* 401 с токеном на руках — пробуем обновить и повторить ровно один раз. */
  if (res.status === 401 && tokens) {
    tokens = await refreshTokens()
    if (tokens) {
      try {
        res = await raw(method, path, body, tokens.accessToken, opts)
      } catch {
        throw new ApiError('network', 0, 'network', 'Нет связи с сервером')
      }
    }
  }

  if (!res.ok) {
    let code = String(res.status)
    let message = `Сервер ответил ${res.status}`
    let fields: Record<string, string> = {}
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string; fields?: unknown } }
      if (j.error?.code) code = j.error.code
      if (j.error?.message) message = j.error.message
      /* Берём только строки: чужое тело с `fields: [1, 2]` не должно
         превращаться в подпись под полем. */
      const f = j.error?.fields
      if (f && typeof f === 'object' && !Array.isArray(f)) {
        fields = Object.fromEntries(
          Object.entries(f as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'),
        )
      }
    } catch { /* тело не JSON — оставляем сообщение по статусу */ }
    throw new ApiError('http', res.status, code, message, fields)
  }

  /* Тело есть не у всех успешных ответов: 204 у удаления, 201 без содержимого
     у фиксации согласия. Разбирать JSON вслепую нельзя — пустое тело роняет
     запрос, который на самом деле прошёл. */
  if (res.status === 204 || res.status === 205) return undefined as T
  if (!res.headers.get('content-type')?.includes('json')) return undefined as T
  const text = await res.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/* ── Типизированный доступ ───────────────────────────────────────────────
   Путь можно взять только из контракта: `paths` — это ключи openapi.yaml.
   Ответ выводится из того же контракта, поэтому `any` в вызовах не появляется. */

type PathsWith<M extends string> = { [K in keyof paths]: paths[K] extends Record<M, unknown> ? K : never }[keyof paths]

type Ok<T> = T extends { responses: infer R }
  ? R extends { 200: { content: { 'application/json': infer B } } } ? B
  : R extends { 201: { content: { 'application/json': infer B } } } ? B
  : void
  : void

export const api = {
  get: <P extends PathsWith<'get'>>(path: P) =>
    request<Ok<paths[P] extends { get: infer O } ? O : never>>('GET', path as string),
  post: <P extends PathsWith<'post'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { post: infer O } ? O : never>>('POST', path as string, body ?? {}, opts),
  /* PUT и PATCH тоже принимают ключ идемпотентности: контракт требует его,
     например, на переходах сделки — без него второе нажатие на плохой связи
     двигает состояние дважды. */
  put: <P extends PathsWith<'put'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { put: infer O } ? O : never>>('PUT', path as string, body ?? {}, opts),
  patch: <P extends PathsWith<'patch'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { patch: infer O } ? O : never>>('PATCH', path as string, body ?? {}, opts),
  delete: <P extends PathsWith<'delete'>>(path: P) =>
    request<Ok<paths[P] extends { delete: infer O } ? O : never>>('DELETE', path as string),
}

/**
 * Адреса с подстановкой (`/weddings/{weddingId}`) собираются здесь.
 *
 * Значения кодируются: идентификатор приходит из ответа сервера, но гостевой
 * токен — из адресной строки, а он может содержать что угодно.
 */
export function url<P extends keyof paths>(template: P, params: Record<string, string | number>): P {
  return String(template).replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k]
    if (v === undefined) throw new Error(`нет значения для {${k}} в ${String(template)}`)
    return encodeURIComponent(String(v))
  }) as P
}
