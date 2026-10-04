import type { paths } from './schema'
import { AUTH_CHANGED_EVENT, externalProgramNamespace, forgetOfflineDay, forgetOfflinePrograms, forgetOfflineSeating, offlineScope, sameOfflineScope } from '../offlineAccess'

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
  const previous = readTokens()
  const changed = !sameOfflineScope(offlineScope(previous?.accessToken ?? null), offlineScope(t?.accessToken ?? null))
    && previous?.accessToken !== t?.accessToken
  if (changed || !t) {
    forgetOfflineDay()
    forgetOfflineSeating()
    forgetOfflinePrograms(t ? { registeredOnly: true } : undefined)
  }
  try {
    if (t) localStorage.setItem(TOKENS_KEY, JSON.stringify(t))
    else localStorage.removeItem(TOKENS_KEY)
  } catch { /* см. readTokens */ }
  if (changed) window.dispatchEvent(new Event(AUTH_CHANGED_EVENT))
  for (const observe of scopeObservers) {
    try { observe() } catch { /* A reader cannot interrupt credential renewal. */ }
  }
}

// Only a local privacy boundary, never authentication or permission evidence.
// Access-token renewal for the same subject/session keeps an active reader;
// logout or switching account/session destroys its private in-memory state.
const scopeObservers = new Set<() => void>()
function tokenSessionScope(token: string | null): string | null {
  if (!token) return null
  const scope = offlineScope(token)
  return scope ? JSON.stringify([scope.userId, scope.sessionId]) : 'unparsed:' + token
}
function localSessionScope(): string | null {
  return tokenSessionScope(readTokens()?.accessToken ?? null)
}
export function onSessionChanged(listener: () => void): () => void {
  let scope = localSessionScope()
  const observe = () => {
    const current = localSessionScope()
    if (current !== scope) { scope = current; listener() }
  }
  const storage = (event: StorageEvent) => { if (event.storageArea === localStorage && (event.key === TOKENS_KEY || event.key === null)) observe() }
  scopeObservers.add(observe)
  window.addEventListener('storage', storage)
  window.addEventListener('focus', observe)
  document.addEventListener('visibilitychange', observe)
  return () => {
    scopeObservers.delete(observe)
    window.removeEventListener('storage', storage)
    window.removeEventListener('focus', observe)
    document.removeEventListener('visibilitychange', observe)
  }
}

/** Local privacy fence only; decoded claims never authorize a request. */
function localSessionAction(initial: string | null, message: string) {
  let stopped = false
  const stop = onSessionChanged(() => { stopped = true })
  const scopeOfStored = (raw: string | null): string | null => {
    try {
      const tokens = raw ? JSON.parse(raw) as Partial<Tokens> : null
      return tokens?.accessToken && tokens.refreshToken ? tokenSessionScope(tokens.accessToken) : null
    } catch { return null }
  }
  // Queued storage events retain observed A→B→A evidence even if the current
  // storage already contains A again. Unobserved transitions are not proven.
  const observeStorage = (event: StorageEvent) => {
    if (event.storageArea !== localStorage) return
    if (event.key === null || (event.key === TOKENS_KEY &&
      (scopeOfStored(event.oldValue) !== initial || scopeOfStored(event.newValue) !== initial))) stopped = true
  }
  window.addEventListener('storage', observeStorage)
  return {
    assertCurrent: () => {
      if (stopped || localSessionScope() !== initial) throw new Error(message)
    },
    close: () => { stop(); window.removeEventListener('storage', observeStorage) },
  }
}

/** Settings actions capture current local scope; claims never authorize. */
export function beginLocalSessionAction(message = 'Аккаунт или сессия изменились — повторите действие') {
  return localSessionAction(localSessionScope(), message)
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
  /**
   * Через сколько секунд повторить (заголовок `Retry-After` у 429). Контракт
   * обещает его ради клиента (ERR-0051), но экраны его не читали: таймер
   * повторной отправки кода считался от выдуманных 60 секунд, а сервер мог
   * просить час. `null` — сервер срок не назвал.
   */
  readonly retryAfter: number | null
  /**
   * Подробности отказа, если сервер их назвал (`error.details`): 409
   * `wedding_exists` несёт `weddingId` живой свадьбы — без него квиз мог
   * только показать текст, а открыть свою свадьбу было нечем (фича 005).
   * Берётся как есть: форму знает только конкретный код ошибки.
   */
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    kind: 'network' | 'timeout' | 'http',
    status: number,
    code: string,
    message: string,
    fields: Readonly<Record<string, string>> = {},
    retryAfter: number | null = null,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
    this.fields = fields
    this.retryAfter = retryAfter
    this.details = details
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

/**
 * Слова, которыми клиент называет смерть сессии: выход со всех устройств с
 * другого телефона, 30 дней бездействия, повторное предъявление refresh.
 *
 * Экспортируется, потому что по ним `AsyncState` отличает «войдите снова» от
 * прочих отказов и показывает кнопку «Войти» вместо «Повторить»: повтор без
 * токена получал бы от сервера служебное «Нужен заголовок Authorization» —
 * и именно этот текст человек читал на экране (ревью D6-09).
 */
export const SESSION_EXPIRED = 'Сессия истекла — войдите снова'

/**
 * Запрос ушёл БЕЗ токена и получил 401 «Нужен заголовок Authorization: Bearer»
 * (`bearer()` в `plugins/auth.ts` бэкенда — единственный источник этого текста).
 * Так бывает после смерти сессии (ревью 015, FA1): стор забыл свадьбу, экраны
 * перечитали данные уже без токена — и человек читал служебный текст про
 * заголовок с кнопкой «Повторить» (тот же класс, что D6-09; живая проверка
 * 2026-09-18, анкета подрядчика). Здесь — свои слова, `AsyncState` ведёт на вход.
 * Код `unauthorized` и статус 401 остаются: экраны, которые по ним ведут на вход
 * (`Team.tsx`, `Join.tsx`), работают как раньше. Остальные 401 без токена —
 * «Код неверный или устарел» у входа, токен гостя — идут как есть.
 */
export const SIGN_IN_REQUIRED = 'Войдите, чтобы продолжить'
const NO_BEARER = 'Нужен заголовок Authorization: Bearer'

/*
 * Кто узнаёт о смерти сессии (ревью 015, FA1).
 *
 * Сервер отверг refresh — токены стёрты здесь, в слое запросов, а стор об
 * этом не знал: свадьба, мозаика с телефонами подрядчиков и избранное жили
 * в памяти до перезагрузки страницы, и «Назад» открывал их без токена — тот
 * же класс, что RF-01 при выходе. Слой запросов о сторе не знает (он ниже),
 * поэтому событие: стор подписывается при старте и зовёт `forgetSession`.
 */
type SessionListener = () => void
const sessionListeners = new Set<SessionListener>()

/** Подписка на смерть сессии; возвращает отписку. */
export function onSessionExpired(listener: SessionListener): () => void {
  sessionListeners.add(listener)
  return () => { sessionListeners.delete(listener) }
}

function announceSessionExpired(): void {
  for (const listener of sessionListeners) {
    try { listener() } catch { /* слушатель не должен ронять запрос */ }
  }
}

/**
 * Кто узнаёт об устаревшем согласии (F4, RL-1).
 *
 * Сервер отвечает 403 `consent_outdated` на любом пути за `requireConsent` —
 * редакция политики поднялась, а этот вход подписан под прежней. Тот же код
 * закрывает живой канал (`4403`, обрабатывается в `chats.ts`). Флаг переживает
 * перезагрузку и офлайн: без него гейт исчезал бы на каждом обновлении
 * страницы до следующего защищённого запроса. Приём тот же, что у смерти
 * сессии выше (`onSessionExpired`/`announceSessionExpired`).
 */
export const CONSENT_OUTDATED_KEY = 'tt_consent_outdated'

export function consentOutdated(): boolean {
  try {
    return localStorage.getItem(CONSENT_OUTDATED_KEY) === '1'
  } catch {
    /* см. readTokens — приватный режим читаем как «флага нет» */
    return false
  }
}

export function clearConsentOutdated(): void {
  try { localStorage.removeItem(CONSENT_OUTDATED_KEY) } catch { /* см. readTokens */ }
}

type ConsentListener = () => void
const consentListeners = new Set<ConsentListener>()

/** Подписка на устаревшее согласие; возвращает отписку. */
export function onConsentOutdated(listener: ConsentListener): () => void {
  consentListeners.add(listener)
  return () => { consentListeners.delete(listener) }
}

export function reportConsentOutdated(): void {
  forgetOfflineDay()
  forgetOfflineSeating()
  forgetOfflinePrograms({ registeredOnly: true })
  try { localStorage.setItem(CONSENT_OUTDATED_KEY, '1') } catch { /* см. readTokens */ }
  for (const listener of consentListeners) {
    try { listener() } catch { /* слушатель не должен ронять запрос */ }
  }
}

/** Секунды из `Retry-After`: число или HTTP-дата; нет заголовка — `null`. */
function readRetryAfter(res: Response): number | null {
  const h = res.headers.get('retry-after')
  if (!h) return null
  const n = Number(h)
  if (Number.isFinite(n)) return n >= 0 ? Math.ceil(n) : null
  const at = Date.parse(h)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** Ошибка из не-2xx ответа: код и текст сервера, поля 422, срок повтора 429. */
async function errorFrom(res: Response): Promise<ApiError> {
  let code = String(res.status)
  let message = `Сервер ответил ${res.status}`
  let fields: Record<string, string> = {}
  let details: Record<string, unknown> = {}
  try {
    const j = (await res.json()) as { error?: { code?: string; message?: string; fields?: unknown; details?: unknown } }
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
    const d = j.error?.details
    if (d && typeof d === 'object' && !Array.isArray(d)) details = d as Record<string, unknown>
  } catch { /* тело не JSON — оставляем сообщение по статусу */ }
  return new ApiError('http', res.status, code, message, fields, readRetryAfter(res), details)
}

/*
 * Чем кончился обмен refresh.
 *
 * Три исхода, а не два: «вход кончился» (сервер отверг сам refresh — 401),
 * «сервер не смог» (5xx выката, 429 ограничителя, 403 прокси, сеть, таймаут)
 * и успех. До ревью D6-07 первые два были одним `null` со стиранием
 * хранилища: 503 на двадцать секунд выката выбрасывал человека на вход, а
 * повторный вход стоит SMS. Теперь хранилище трогает только первый исход.
 * 403 приложение на `/auth/refresh` не отвечает никогда (у пути нет
 * проверки прав) — он может прийти только от WAF или прокси, и это тот же
 * класс, что 503 (ревью RF-08).
 */
type RefreshResult =
  | { ok: true; tokens: Tokens }
  | { ok: false; why: 'expired' }
  | { ok: false; why: 'down'; error: ApiError }
  | { ok: false; why: 'scope-changed'; error: Error }

/* Обмен refresh идёт один на всех: остальные ждут этот же промис. */
let refreshing: Promise<RefreshResult> | null = null

/*
 * Сколько ждать соседнюю вкладку при `refresh_superseded` (ревью RF-08).
 *
 * Две вкладки с одним истёкшим access шлют один и тот же refresh; сервер
 * обменивает его один раз (D1-06), проигравшей отвечает 401 с этим кодом.
 * Ответ проигравшей может прийти раньше, чем победившая успела положить
 * новую пару в общее хранилище, — тогда «пара под нами не сменилась» ещё не
 * значит «вход кончился». Даём победившей время дописать, перечитываем и
 * только если пара всё та же — считаем вход законченным.
 */
const SUPERSEDED_GRACE_MS = 300
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

type ResponseOwner = {
  response: Response
  read: <T>(consume: (response: Response) => Promise<T>) => Promise<T>
  dispose: () => Promise<void>
}

function ownResponse(response: Response): ResponseOwner {
  // A read attempt belongs to this response even for null-body 204/205, where
  // native bodyUsed remains false. A failed read is not retried or called done.
  let readAttempted = false
  const read = async <T>(consume: (response: Response) => Promise<T>): Promise<T> => {
    readAttempted = true
    return await consume(response)
  }
  return {
    response, read,
    dispose: async () => {
      if (!readAttempted) await read(response => response.arrayBuffer())
    },
  }
}

function responseDisposalFailure(primary: unknown, disposal: unknown): AggregateError {
  return new AggregateError([primary, disposal], primary instanceof Error ? primary.message : String(primary), { cause: primary })
}

async function withOwnedResponse<T>(response: Response, work: (owned: ResponseOwner) => Promise<T>, assertCurrent?: () => void): Promise<T> {
  const owned = ownResponse(response)
  try {
    const value = await work(owned)
    await owned.dispose()
    assertCurrent?.()
    return value
  } catch (primary) {
    try { await owned.dispose() } catch (disposal) { throw responseDisposalFailure(primary, disposal) }
    throw primary
  }
}

async function refreshTokens(): Promise<RefreshResult> {
  const current = readTokens()
  if (!current) return { ok: false, why: 'expired' }
  refreshing ??= Promise.resolve().then(async (): Promise<RefreshResult> => {
    const owner = localSessionAction(tokenSessionScope(current.accessToken), 'Аккаунт или сессия изменились — повторите действие')
    let expiredHere = false
    /* Тот же потолок ожидания, что у всех запросов (D6-08): зависший на
       прокси refresh без него держал `refreshing` навсегда, и все следующие
       401 ждали тот же промис — приложение «висело» без единой ошибки. */
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      owner.assertCurrent()
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
      return await withOwnedResponse<RefreshResult>(res, async owned => {
        owner.assertCurrent()
        if (!res.ok) {
          /* Отказ на refresh не всегда значит «вход кончился». Вторая вкладка
             того же браузера могла обменять токен секундой раньше и уже
             положить новую пару в общее хранилище — тогда наш refresh просто
             устарел (сервер отвечает `refresh_superseded`). Стирать хранилище
             в этот момент значит выкинуть и ту вкладку, у которой всё в
             порядке. Сначала смотрим, не сменилась ли пара под нами. */
          const stored = readTokens()
          if (stored && stored.refreshToken !== current.refreshToken) return { ok: true, tokens: stored }
          const error = await owned.read(errorFrom)
          owner.assertCurrent()
          /* Вход кончился, только если сервер отверг сам refresh (401). Всё
             остальное — 5xx, 429, 403 прокси, 4xx неожиданного вида — сервер не
             смог ответить по делу: хранилище не трогаем, повтор сделает
             следующий запрос. */
          if (res.status !== 401) return { ok: false, why: 'down', error }
          if (error.code === 'refresh_superseded') {
            /* Соседняя вкладка обменяла тот же refresh и, возможно, ещё пишет
               новую пару в хранилище — см. SUPERSEDED_GRACE_MS. */
            await sleep(SUPERSEDED_GRACE_MS)
            owner.assertCurrent()
            const later = readTokens()
            if (later && later.refreshToken !== current.refreshToken) return { ok: true, tokens: later }
          }
          owner.assertCurrent()
          expiredHere = true
          saveTokens(null)
          announceSessionExpired()
          return { ok: false, why: 'expired' }
        }
        const body = (await owned.read(response => response.json())) as Tokens
        owner.assertCurrent()
        const next = { accessToken: body.accessToken, refreshToken: body.refreshToken }
        owner.assertCurrent()
        saveTokens(next)
        return { ok: true, tokens: next }
      }, () => { if (!expiredHere) owner.assertCurrent() })
    } catch (e) {
      try { owner.assertCurrent() } catch (changed) {
        return { ok: false, why: 'scope-changed', error: e instanceof AggregateError ? e : changed instanceof Error ? changed : new Error('Аккаунт или сессия изменились — повторите действие') }
      }
      /* Сеть отвалилась или мы не дождались — токены не трогаем, попробуем в другой раз. */
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { ok: false, why: 'down', error: new ApiError('timeout', 0, 'timeout', 'Сервер не ответил вовремя') }
      }
      const error = new ApiError('network', 0, 'network', 'Нет связи с сервером')
      error.cause = e
      return { ok: false, why: 'down', error }
    } finally {
      clearTimeout(timer)
      owner.close()
      refreshing = null
    }
  })
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
  /** Link-authorized routes must not send or refresh an unrelated account token. */
  auth?: boolean
  /** Значение заголовка `Idempotency-Key` для необратимых действий. */
  idempotencyKey?: string
  /** Свой срок ожидания ответа — для больших тел (файл подтверждения оплаты, ревью 018 BF-13). */
  timeoutMs?: number
  /** Version of the exact snapshot being edited, never a global cached ETag. */
  ifMatch?: string
  onResponse?: (response: Response) => void
  /** Optional action-local privacy fence; never server authorization. */
  assertCurrent?: () => void
}

async function raw(method: Method, path: string, body: unknown, token: string | null, opts?: Options): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? TIMEOUT_MS)
  try {
    return await fetch(BASE + path, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts?.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        ...(opts?.ifMatch ? { 'If-Match': opts.ifMatch } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } finally {
    clearTimeout(timer)
  }
}

async function request<T>(method: Method, path: string, body?: unknown, opts?: Options): Promise<T> {
  opts?.assertCurrent?.()
  const tokens = opts?.auth === false ? null : readTokens()
  let res: Response
  try {
    res = await raw(method, path, body, tokens?.accessToken ?? null, opts)
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('timeout', 0, 'timeout', 'Сервер не ответил вовремя')
    }
    throw new ApiError('network', 0, 'network', 'Нет связи с сервером')
  }

  const finalResponse = async (owned: ResponseOwner): Promise<T> => {
    const res = owned.response
    opts?.assertCurrent?.()
    // Final refusals also clear copies when no account token was sent.
    const dayPath = /^\/weddings\/([^/?]+)(?:\/(?:timeline|events|planb|slots))?\/?$/.exec(path)
    if (opts?.auth !== false && method === 'GET' && dayPath && [401, 403, 404, 410].includes(res.status)) forgetOfflineDay(decodeURIComponent(dayPath[1]!))

    const responseError = res.ok ? null : await owned.read(errorFrom)
    opts?.assertCurrent?.()
    if (responseError && [401, 403, 404, 410].includes(res.status)) {
      if (opts?.auth !== false && method === 'GET' && path === '/weddings') forgetOfflineSeating(undefined, responseError)
      const seatingPath = /^\/weddings\/([^/?]+)(?:\/(?:guests|tables|members)(?:\/[^/?]+)?)?\/?$/.exec(path)
      if (opts?.auth !== false && seatingPath) forgetOfflineSeating(decodeURIComponent(seatingPath[1]!), responseError)
      const vendorProgram = /^\/vendor\/weddings\/([^/?]+)\/timeline(?:\/ack)?\/?$/.exec(path)
      if (vendorProgram) forgetOfflinePrograms({ registeredOnly: true, weddingId: decodeURIComponent(vendorProgram[1]!) }, responseError)
      else if (method === 'GET' && /^\/vendor\/programs(?:\?|$)/.test(path)) forgetOfflinePrograms({ registeredOnly: true }, responseError)
      const external = /^\/guest-vendor\/([^/?]+)(?:\/(?:timeline(?:\/ack)?|messages))?\/?$/.exec(path)
      if (external) {
        const namespace = await externalProgramNamespace(decodeURIComponent(external[1]!))
        opts?.assertCurrent?.()
        forgetOfflinePrograms(namespace ? { namespace } : { externalOnly: true }, responseError)
      }
    }

    /* 401 без токена на руках: служебное «нужен заголовок» — своими словами (см. SIGN_IN_REQUIRED). */
    if (res.status === 401 && !tokens) {
      const err = responseError!
      throw err.message === NO_BEARER ? new ApiError('http', 401, 'unauthorized', SIGN_IN_REQUIRED) : err
    }

    if (!res.ok) {
      const err = responseError!
      /* Гейт узнаёт об устаревшем согласии здесь же, а не в каждом экране:
         иначе первый экран, успевший позвать `request()` после выката новой
         редакции, ловил бы гейт, а остальные — нет (F4, RL-1). */
      if (opts?.auth !== false && res.status === 403 && err.code === 'consent_outdated') reportConsentOutdated()
      throw err
    }

    /* Тело есть не у всех успешных ответов: 204 у удаления, 201 без содержимого
       у фиксации согласия. Разбирать JSON вслепую нельзя — пустое тело роняет
       запрос, который на самом деле прошёл. */
    opts?.assertCurrent?.()
    opts?.onResponse?.(res)
    if (res.status === 204 || res.status === 205) {
      // Finish the browser-owned response stream before this action settles.
      await owned.read(response => response.arrayBuffer())
      opts?.assertCurrent?.()
      return undefined as T
    }
    if (!res.headers.get('content-type')?.includes('json')) return undefined as T
    const text = await owned.read(response => response.text())
    opts?.assertCurrent?.()
    return (text ? JSON.parse(text) : undefined) as T
  }

  return await withOwnedResponse(res, async owned => {
    opts?.assertCurrent?.()
    /* Dispose the actual original 401 before refresh or replacing its owner. */
    if (res.status === 401 && tokens) {
      await owned.dispose()
      opts?.assertCurrent?.()
      const refreshed = await refreshTokens()
      opts?.assertCurrent?.()
      if (refreshed.ok) {
        opts?.assertCurrent?.()
        let retry: Response
        try {
          retry = await raw(method, path, body, refreshed.tokens.accessToken, opts)
        } catch {
          throw new ApiError('network', 0, 'network', 'Нет связи с сервером')
        }
        return await withOwnedResponse(retry, finalResponse, opts?.assertCurrent)
      } else if (refreshed.why === 'expired') {
        throw new ApiError('http', 401, 'session_expired', SESSION_EXPIRED)
      } else {
        throw refreshed.error
      }
    }
    return await finalResponse(owned)
  }, opts?.assertCurrent)
}

/* ── Типизированный доступ ───────────────────────────────────────────────
   Путь можно взять только из контракта: `paths` — это ключи openapi.yaml.
   Ответ выводится из того же контракта, поэтому `any` в вызовах не появляется. */

type PathsWith<M extends string> = { [K in keyof paths]: paths[K] extends Record<M, unknown> ? K : never }[keyof paths]

/* 202 — тоже успешный ответ с телом: рассылки (`BroadcastResult`, контракт
   v0.29.0) отвечают им, и до фичи 005 их тело приходилось называть руками. */
type Ok<T> = T extends { responses: infer R }
  ? R extends { 200: { content: { 'application/json': infer B } } } ? B
  : R extends { 201: { content: { 'application/json': infer B } } } ? B
  : R extends { 202: { content: { 'application/json': infer B } } } ? B
  : void
  : void

async function snapshot<T>(method: Method, path: string, body?: unknown, opts?: Options): Promise<{ data: T; etag: string | null; headers: Headers }> {
  let etag: string | null = null
  let headers = new Headers()
  const data = await request<T>(method, path, body, {
    ...opts, onResponse: response => { etag = response.headers.get('etag'); headers = response.headers; opts?.onResponse?.(response) },
  })
  return { data, etag, headers }
}

export const api = {
  get: <P extends PathsWith<'get'>>(path: P, opts?: Options) =>
    request<Ok<paths[P] extends { get: infer O } ? O : never>>('GET', path as string, undefined, opts),
  getSnapshot: <P extends PathsWith<'get'>>(path: P, opts?: Options) =>
    snapshot<Ok<paths[P] extends { get: infer O } ? O : never>>('GET', path as string, undefined, opts),
  post: <P extends PathsWith<'post'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { post: infer O } ? O : never>>('POST', path as string, body ?? {}, opts),
  postSnapshot: <P extends PathsWith<'post'>>(path: P, body?: unknown, opts?: Options) =>
    snapshot<Ok<paths[P] extends { post: infer O } ? O : never>>('POST', path as string, body ?? {}, opts),
  /* PUT и PATCH тоже принимают ключ идемпотентности: контракт требует его,
     например, на переходах сделки — без него второе нажатие на плохой связи
     двигает состояние дважды. */
  put: <P extends PathsWith<'put'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { put: infer O } ? O : never>>('PUT', path as string, body ?? {}, opts),
  putSnapshot: <P extends PathsWith<'put'>>(path: P, body?: unknown, opts?: Options) =>
    snapshot<Ok<paths[P] extends { put: infer O } ? O : never>>('PUT', path as string, body ?? {}, opts),
  patch: <P extends PathsWith<'patch'>>(path: P, body?: unknown, opts?: Options) =>
    request<Ok<paths[P] extends { patch: infer O } ? O : never>>('PATCH', path as string, body ?? {}, opts),
  delete: <P extends PathsWith<'delete'>>(path: P, opts?: Options) =>
    request<Ok<paths[P] extends { delete: infer O } ? O : never>>('DELETE', path as string, undefined, opts),
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
