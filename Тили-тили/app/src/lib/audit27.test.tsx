// @vitest-environment jsdom
/*
 * Ревью старого кода (D1/D2/D4/D6), фронт: вход и сессия, каркас, push,
 * команда, чат, стор. Каждый тест здесь был красным на коде до фикса —
 * цитаты красного в отчёте `FIX-FE-A.md`.
 *
 * Проверяется то, что ушло на сервер и что осталось на устройстве, а не то,
 * что нарисовал обработчик (приём из `audit25.test.tsx`).
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { projectFile } from '@/test/projectFiles'
import { api, ApiError, SESSION_EXPIRED } from '@/lib/api/client'
import { useServerHealth } from '@/lib/api/health'
import { StoreProvider, useStore } from './store'
import { LEGAL_TEXT_VERSION } from './legal'
import { Auth, Settings } from '@/pages/Account'
import { Join, Team } from '@/pages/Team'
import { Chat, Us } from '@/pages/Us'
import type { ChatEvent } from '@/lib/api/chats'

/*
 * Живой канал чата подменяется: настоящий `WebSocket` в jsdom тянулся бы к
 * серверу и переподключался по таймеру. Обработчики событий собираются, чтобы
 * тест мог «прислать» событие сам (D4-08). Остальное в модуле — настоящее.
 */
const socketEvents: Array<(e: ChatEvent) => void> = []
vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: (_chatId: string, onEvent: (e: ChatEvent) => void) => { socketEvents.push(onEvent); return () => undefined },
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown; headers: Record<string, string> }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')
/* Ответ, которого ещё нет: запрос ушёл и висит. Настоящий fetch при этом
   честно отвечает на `abort` — подделка делает то же, иначе таймаут клиента
   проверить нельзя. */
const PENDING = Symbol('pending')

/** Ответ со своим кодом и, при необходимости, заголовками. */
const withStatus = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  ({ __status: status, body: { error: { code, message } }, headers })

function isStatus(v: unknown): v is { __status: number; body: unknown; headers: Record<string, string> } {
  return typeof v === 'object' && v !== null && '__status' in v
}

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    /* Ключ таблицы — путь как он написан в тесте: кириллический код приглашения
       клиент кодирует процентами, здесь он раскодируется обратно. */
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body, headers }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    if (reply === DOWN) return Promise.reject(new TypeError('Failed to fetch'))
    if (reply === PENDING) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status, reply.headers))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const TOKENS = { accessToken: 'a', refreshToken: 'r' }
const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
}
const storedTokens = () => JSON.parse(localStorage.getItem('tt_auth') ?? 'null') as typeof TOKENS | null

/* ── D6-07 / D6-08 / D6-09: обмен refresh ────────────────────────────────── */

describe('D6-07: отказ сервера на refresh — не конец входа', () => {
  beforeEach(signedIn)
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  /** Первый ответ на `/users/me` — 401 с истёкшим access, повтор — по новому токену. */
  const expiredThenOk = (c: Call) =>
    c.headers.authorization === 'Bearer a'
      ? withStatus(401, 'token_expired', 'Срок действия токена истёк')
      : { id: 'u1' }

  it('503 на refresh: токены на месте, наружу — «сервер недоступен»', async () => {
    serve({ '/users/me': expiredThenOk, '/auth/refresh': withStatus(503, 'unavailable', 'Выкат') })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).isDown, 'ошибка выката не названа недоступностью сервера').toBe(true)
    expect(storedTokens(), 'токены стёрты из-за 503 на refresh').toEqual(TOKENS)
  })

  it('429 на refresh: токены на месте, retryAfter из заголовка', async () => {
    serve({ '/users/me': expiredThenOk, '/auth/refresh': withStatus(429, 'too_many_requests', 'Подождите', { 'retry-after': '60' }) })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(429)
    expect((err as ApiError).retryAfter).toBe(60)
    expect(storedTokens(), 'токены стёрты из-за 429 на refresh').toEqual(TOKENS)
  })

  it('сеть упала на refresh: токены на месте', async () => {
    serve({ '/users/me': expiredThenOk, '/auth/refresh': DOWN })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect((err as ApiError).isDown).toBe(true)
    expect(storedTokens()).toEqual(TOKENS)
  })

  it('D6-08: refresh завис — отказ за 15 с таймаутом, токены на месте', async () => {
    vi.useFakeTimers()
    serve({ '/users/me': expiredThenOk, '/auth/refresh': PENDING })
    let settled: unknown = 'висит'
    const p = api.get('/users/me').then(() => { settled = 'ok' }, (e: unknown) => { settled = e })
    await vi.advanceTimersByTimeAsync(16_000)
    await p
    expect(settled, 'запрос не завершился за 16 с').toBeInstanceOf(ApiError)
    expect((settled as ApiError).kind).toBe('timeout')
    expect(storedTokens()).toEqual(TOKENS)
  })

  it('D6-09: 401 на refresh — сессия истекла своими словами, токены сняты', async () => {
    serve({ '/users/me': expiredThenOk, '/auth/refresh': withStatus(401, 'unauthorized', 'Нужен заголовок Authorization: Bearer') })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('session_expired')
    expect((err as ApiError).message).toBe(SESSION_EXPIRED)
    expect((err as ApiError).message).not.toContain('Authorization')
    expect(storedTokens()).toBeNull()
  })

  it('D6-13: retryAfter читается из Retry-After у любого 429', async () => {
    serve({ '/auth/otp': withStatus(429, 'too_many_requests', 'Через час', { 'retry-after': '3600' }) })
    const err = await api.post('/auth/otp', { phone: '+79170000000' }).catch((e: unknown) => e)
    expect((err as ApiError).retryAfter).toBe(3600)
  })
})

/* ── D6-09: AsyncState после смерти сессии ведёт на вход ─────────────────── */

describe('D6-09: экран после смерти сессии', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('вместо «Повторить» — «Войти», и она ведёт на /auth', async () => {
    serve({
      '/users/me/sessions': withStatus(401, 'token_expired', 'Срок действия токена истёк'),
      '/users/me': withStatus(401, 'token_expired', 'Срок действия токена истёк'),
      '/auth/refresh': withStatus(401, 'unauthorized', 'Нужен заголовок Authorization: Bearer'),
      '/weddings': [],
    })
    const { container } = render(
      <MemoryRouter initialEntries={['/settings']}>
        <StoreProvider>
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByText('Войти').length).toBeGreaterThan(0), { timeout: 4000 })
    expect(container.textContent).not.toContain('Authorization')
    fireEvent.click(screen.getAllByText('Войти')[0]!)
    await waitFor(() => expect(container.textContent).toContain('ЭКРАН ВХОДА'))
  })
})

/* ── D6-12: опрос /health — один таймер ──────────────────────────────────── */

function HealthProbe() {
  const s = useServerHealth()
  return <span data-testid="health">{s}</span>
}

describe('D6-12: опрос /health', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  const healthCalls = (calls: Call[]) => calls.filter(c => c.path === '/health').length

  it('два события online подряд не заводят параллельные цепочки опроса', async () => {
    const calls = serve({ '/health': { status: 'ok' } })
    render(<HealthProbe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(healthCalls(calls)).toBe(1)
    await act(async () => {
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('online'))
      await vi.advanceTimersByTimeAsync(0)
    })
    /* Сеть вернулась — спрашиваем сразу, это правильно. */
    expect(healthCalls(calls)).toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    /* Сервер жив — раз в 15 с его не дёргаем; и уж точно не тремя цепочками. */
    expect(healthCalls(calls), 'через 15 с после двух online').toBe(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })
    /* Через минуту — ровно одна перепроверка, а не три. */
    expect(healthCalls(calls), 'через 60 с').toBe(4)
  })

  it('сервер лежит — перепроверка через 15 с, одна', async () => {
    const calls = serve({ '/health': DOWN })
    render(<HealthProbe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByTestId('health').textContent).toBe('down')
    expect(healthCalls(calls)).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(healthCalls(calls)).toBe(2)
  })
})

/* ── D6-06: шим deep-link не уводит с домена ─────────────────────────────── */

/**
 * Шим — первый `<script>` в index.html. Выполняем его строкой из файла с
 * подменёнными `window` и `sessionStorage`: проверяется тот код, который
 * уйдёт в сборку, а не его пересказ в тесте.
 */
function runShim(pathname: string) {
  const html = projectFile('index.html')
  const shim = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  expect(shim, 'первый <script> в index.html не найден').toBeTruthy()
  const replaced: string[] = []
  const stored: Record<string, string> = {}
  const fakeWindow = {
    location: { pathname, search: '', hash: '', origin: 'https://tili-tili.ru', replace: (u: string) => { replaced.push(u) } },
  }
  const fakeStorage = { setItem: (k: string, v: string) => { stored[k] = v } }
  new Function('window', 'sessionStorage', shim!)(fakeWindow, fakeStorage)
  return { replaced, stored }
}

describe('D6-06: шим deep-link', () => {
  it('двойной слеш в начале — не схема-относительный адрес чужого домена', () => {
    const { replaced } = runShim('//evil.com/auth')
    for (const u of replaced) {
      expect(u.startsWith('//'), `редирект на ${u}`).toBe(false)
      expect(u.startsWith('https://tili-tili.ru/'), `редирект мимо своего домена: ${u}`).toBe(true)
    }
  })

  it('обратные слеши схлопываются так же', () => {
    const { replaced } = runShim('\\\\evil.com/auth')
    for (const u of replaced) expect(u.startsWith('https://tili-tili.ru/'), `редирект мимо своего домена: ${u}`).toBe(true)
  })

  it('двойной слеш внутри пути — без редиректа вовсе', () => {
    expect(runShim('/wedding//guests').replaced).toEqual([])
    expect(runShim('/x//evil.com/auth').replaced).toEqual([])
  })

  it('обычная прямая ссылка уводит на корень своего домена и помнит адрес', () => {
    const plain = runShim('/wedding/guests')
    expect(plain.replaced).toEqual(['https://tili-tili.ru/'])
    expect(plain.stored.tt_redirect).toBe('/wedding/guests')
    const sub = runShim('/app/wedding/guests')
    expect(sub.replaced).toEqual(['https://tili-tili.ru/app/'])
  })

  it('корень, index.html и файлы ассетов не трогаются', () => {
    expect(runShim('/').replaced).toEqual([])
    expect(runShim('/index.html').replaced).toEqual([])
    expect(runShim('/assets/app.js').replaced).toEqual([])
  })
})

describe('D6-06: восстановление адреса в main.tsx', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    history.replaceState(null, '', '/')
    document.body.innerHTML = '<div id="root"></div>'
    /* Сбрасывается реестр модулей, чтобы `main.tsx` выполнился заново. Экраны
       импортированы статически выше — они остаются в одном экземпляре со
       `StoreProvider`, иначе контекст стора не совпал бы. */
    vi.resetModules()
    serve({})
  })
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  it('адрес с двойным слешем не восстанавливается', async () => {
    sessionStorage.setItem('tt_redirect', '//evil.com/auth')
    /* На старом коде `history.replaceState(null, '', '//evil.com/auth')` бросал
       SecurityError (чужой origin), и приложение не монтировалось вовсе. */
    await import('@/main')
    expect(location.pathname).toBe('/')
    expect(location.hostname).not.toContain('evil')
  })

  it('свой путь восстанавливается, запись сгорает', async () => {
    sessionStorage.setItem('tt_redirect', '/wedding/guests?x=1')
    await import('@/main')
    expect(location.pathname).toBe('/wedding/guests')
    expect(sessionStorage.getItem('tt_redirect')).toBeNull()
  })
})

/* ── D1-12 / D1-03 / D4-04 / D1-21 / D6-13: экран входа ─────────────────── */

const MY_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

/** Вход: сеть по таблице, затем экран `/auth` с заглушками мест, куда он ведёт. */
async function openAuth(routes: Routes, initial = '/auth') {
  const calls = serve(routes)
  const r = render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/home" element={<p>ГЛАВНАЯ</p>} />
          <Route path="/quiz" element={<p>КВИЗ</p>} />
          <Route path="/join/:code" element={<JoinProbe />} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  return { ...r, calls }
}

function JoinProbe() {
  const { code } = useParams()
  return <p>ПРИЁМ ПРИГЛАШЕНИЯ {code}</p>
}

const checkbox = () => screen.getByRole('checkbox')
const phoneInput = () => screen.getByPlaceholderText('917 123-45-67')

/** Сеть для входа: редакция, код, проверка, согласие, профиль. Свадьбы — параметром. */
const authRoutes = (weddings: unknown[]): Routes => ({
  '/legal/policy': { policyVersion: LEGAL_TEXT_VERSION },
  '/auth/otp': { resendAfter: 60 },
  '/auth/otp/verify': { accessToken: 'a', refreshToken: 'r', user: { id: 'u1' } },
  '/users/me/consent': withStatus(201, '', ''),
  '/users/me': (c: Call) => (c.method === 'PATCH' ? { id: 'u1', name: null, phone: '+79171234567', ...(c.body as object) } : { id: 'u1' }),
  '/weddings': weddings,
  '/weddings/w1': { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14' },
  '/weddings/w1/slots': [],
  '/me/favorites': [],
})

/** Номер, галочка, код — до ответа сервера о том, куда идти дальше. */
async function signInThrough() {
  await waitFor(() => expect(checkbox().hasAttribute('disabled')).toBe(false))
  fireEvent.change(phoneInput(), { target: { value: '9171234567' } })
  fireEvent.click(checkbox())
  fireEvent.click(screen.getByText('Получить код').closest('button')!)
  await waitFor(() => expect(document.getElementById('otp-0')).toBeTruthy())
  for (let k = 0; k < 4; k++) fireEvent.change(document.getElementById(`otp-${k}`)!, { target: { value: String(k + 1) } })
  fireEvent.click(screen.getByText('Войти').closest('button')!)
}

describe('D1-12: согласие — состояние экрана, не хранилища', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('запись tt_consent в хранилище галочку не ставит', async () => {
    localStorage.setItem('tt_consent', JSON.stringify({ at: '2026-09-01T00:00:00.000Z' }))
    await openAuth(authRoutes([]))
    await waitFor(() => expect(checkbox().hasAttribute('disabled')).toBe(false))
    expect(checkbox().getAttribute('aria-checked'), 'галочка стоит заранее — из хранилища').toBe('false')
  })

  it('галочка не пишется в хранилище и снимается при смене номера', async () => {
    await openAuth(authRoutes([]))
    await waitFor(() => expect(checkbox().hasAttribute('disabled')).toBe(false))
    fireEvent.change(phoneInput(), { target: { value: '9171234567' } })
    fireEvent.click(checkbox())
    expect(checkbox().getAttribute('aria-checked')).toBe('true')
    expect(localStorage.getItem('tt_consent'), 'согласие легло в localStorage').toBeNull()
    fireEvent.change(phoneInput(), { target: { value: '9170000000' } })
    expect(checkbox().getAttribute('aria-checked'), 'галочка пережила смену номера').toBe('false')
  })

  it('возврат с шага кода на шаг номера снимает галочку', async () => {
    await openAuth(authRoutes([]))
    await waitFor(() => expect(checkbox().hasAttribute('disabled')).toBe(false))
    fireEvent.change(phoneInput(), { target: { value: '9171234567' } })
    fireEvent.click(checkbox())
    fireEvent.click(screen.getByText('Получить код').closest('button')!)
    await waitFor(() => expect(document.getElementById('otp-0')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Назад'))
    await waitFor(() => expect(checkbox()).toBeTruthy())
    expect(checkbox().getAttribute('aria-checked'), 'галочка пережила возврат на шаг 0').toBe('false')
  })
})

describe('D1-03 / D4-04: после входа — своя свадьба, а не второй квиз; пояс уходит на сервер', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('свадьба есть — сразу на главную, свадьба выбрана, онбординг пройден', async () => {
    const { container, calls } = await openAuth(authRoutes([{ id: 'w1', title: 'Аня ♥ Боря', role: 'couple' }]))
    await signInThrough()
    await waitFor(() => expect(container.textContent).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    expect(container.textContent, 'вернувшемуся показан выбор «Кто вы?»').not.toContain('Кто вы?')
    expect(JSON.parse(localStorage.getItem('tt_wedding_id') ?? 'null')).toBe('w1')
    expect(localStorage.getItem('tt_onboarded')).toBe('1')
    /* Согласие ушло раньше, чем что-либо ещё: без него все пути 403. */
    expect(calls.findIndex(c => c.path === '/users/me/consent')).toBeLessThan(calls.findIndex(c => c.path === '/weddings'))
  })

  it('D4-04: часовой пояс устройства уходит в профиль сразу после входа', async () => {
    const { calls } = await openAuth(authRoutes([]))
    await signInThrough()
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && c.path === '/users/me')).toBe(true), { timeout: 4000 })
    const patch = calls.find(c => c.method === 'PATCH' && c.path === '/users/me')!
    expect(patch.body).toEqual({ tz: MY_TZ })
    expect(patch.headers.authorization).toBe('Bearer a')
  })

  it('свадеб нет — экран «Кто вы?»', async () => {
    const { container } = await openAuth(authRoutes([]))
    await signInThrough()
    await waitFor(() => expect(container.textContent).toContain('Кто вы?'), { timeout: 4000 })
    expect(container.textContent).not.toContain('ГЛАВНАЯ')
  })

  it('список свадеб не пришёл — не квиз и не «Кто вы?», а ошибка словами и «Продолжить»', async () => {
    const { container } = await openAuth({ ...authRoutes([]), '/weddings': DOWN })
    await signInThrough()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(container.textContent).not.toContain('Кто вы?')
    expect(screen.getByText('Продолжить')).toBeTruthy()
  })
})

describe('D1-21: приглашение в команду доводится до конца', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Принять» без входа: код запоминается, человек ведётся на вход', async () => {
    serve({
      '/invites/ДРУГ-7F3K': { role: 'helper', weddingTitle: 'Аня ♥ Боря', inviterName: 'Аня' },
      '/invites/ДРУГ-7F3K/accept': withStatus(401, 'unauthorized', 'Нужен заголовок Authorization: Bearer'),
    })
    const { container } = render(
      <MemoryRouter initialEntries={['/join/ДРУГ-7F3K']}>
        <StoreProvider>
          <Routes>
            <Route path="/join/:code" element={<Join />} />
            <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(screen.getByText('Принять приглашение').closest('button')!.hasAttribute('disabled')).toBe(false))
    fireEvent.click(screen.getByText('Принять приглашение'))
    await waitFor(() => expect(container.textContent).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    expect(sessionStorage.getItem('tt_join_code')).toBe('ДРУГ-7F3K')
  })

  it('после входа и согласия с запомненным кодом — обратно на приём приглашения', async () => {
    sessionStorage.setItem('tt_join_code', 'ДРУГ-7F3K')
    const { container } = await openAuth(authRoutes([]))
    await signInThrough()
    await waitFor(() => expect(container.textContent).toContain('ПРИЁМ ПРИГЛАШЕНИЯ ДРУГ-7F3K'), { timeout: 4000 })
    expect(sessionStorage.getItem('tt_join_code'), 'код не сгорел после перехода').toBeNull()
  })

  it('на шаге «Кто вы?» есть путь для приглашённого: код → /join/<код>', async () => {
    const { container } = await openAuth(authRoutes([]))
    await signInThrough()
    await waitFor(() => expect(container.textContent).toContain('Кто вы?'), { timeout: 4000 })
    fireEvent.click(screen.getByText('У меня есть приглашение в команду'))
    fireEvent.change(screen.getByPlaceholderText('ДРУГ-7F3K'), { target: { value: ' друг-7f3k ' } })
    fireEvent.click(screen.getByText('Открыть приглашение'))
    await waitFor(() => expect(container.textContent).toContain('ПРИЁМ ПРИГЛАШЕНИЯ ДРУГ-7F3K'))
  })
})

describe('D6-13: таймер повторной отправки — от Retry-After сервера', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('429 на повторную отправку: таймер берёт срок сервера, а не выдуманные 60 с', async () => {
    let sends = 0
    await openAuth({
      ...authRoutes([]),
      '/auth/otp': () => (++sends === 1 ? { resendAfter: 0 } : withStatus(429, 'too_many_requests', 'Слишком часто', { 'retry-after': '3600' })),
    })
    await waitFor(() => expect(checkbox().hasAttribute('disabled')).toBe(false))
    fireEvent.change(phoneInput(), { target: { value: '9171234567' } })
    fireEvent.click(checkbox())
    fireEvent.click(screen.getByText('Получить код').closest('button')!)
    await waitFor(() => expect(screen.getByText('Отправить код повторно')).toBeTruthy())
    fireEvent.click(screen.getByText('Отправить код повторно'))
    await waitFor(() => expect(screen.getByText(/Отправить код повторно · 60:00/)).toBeTruthy())
  })
})

/* ── D1-14 / D1-25 / D1-17: экран команды ───────────────────────────────── */

const teamMember = (id: string, name: string, role: string) => ({ user: { id, name }, role, joinedAt: '2026-01-01T00:00:00.000Z' })

/** Команда: я — `myRole`, рядом помощник u2 и вторая пара u3. */
const teamRoutes = (myRole: string, over: Routes = {}): Routes => ({
  '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', role: myRole }],
  '/weddings/w1': { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14' },
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Аня' },
  '/weddings/w1/members': [teamMember('u1', 'Аня', myRole), teamMember('u2', 'Мама', 'helper'), teamMember('u3', 'Боря', 'couple')],
  '/weddings/w1/invites': [{ code: myRole === 'couple' ? 'ДРУГ-7F3K' : undefined, url: myRole === 'couple' ? 'https://tili-tili.ru/join/ДРУГ-7F3K' : undefined, role: 'helper', expiresAt: '2030-01-01T00:00:00.000Z', used: false }],
  ...over,
})

/** Кнопка действия в строке участника — или внятный отказ, если её нет. */
function memberAction(name: string, label: string): Element {
  const btn = screen.getByText(name).closest('[data-member]')?.querySelector(`[aria-label="${label}"]`)
  expect(btn, `у строки участника «${name}» нет кнопки «${label}»`).toBeTruthy()
  return btn!
}

async function openTeam(routes: Routes) {
  const calls = serve(routes)
  const r = render(
    <MemoryRouter initialEntries={['/us/team']}>
      <StoreProvider>
        <Routes><Route path="/us/team" element={<Team />} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('Мама')).toBeTruthy(), { timeout: 4000 })
  return { ...r, calls }
}

describe('D1-14: пара может сменить роль участника и убрать его', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Сменить роль» → PATCH /weddings/w1/members/u2 с новой ролью', async () => {
    const { calls } = await openTeam(teamRoutes('couple', { '/weddings/w1/members/u2': { ok: true } }))
    fireEvent.click(memberAction('Мама', 'Сменить роль'))
    fireEvent.click(screen.getByText('Координатор', { selector: 'button' }))
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && c.path === '/weddings/w1/members/u2')).toBe(true))
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/weddings/w1/members/u2')!.body).toEqual({ role: 'coordinator' })
  })

  it('«Убрать из команды»: первое нажатие ничего не шлёт, второе — DELETE', async () => {
    const { calls } = await openTeam(teamRoutes('couple', { '/weddings/w1/members/u2': withStatus(204, '', '') }))
    fireEvent.click(memberAction('Мама', 'Убрать из команды'))
    expect(calls.some(c => c.method === 'DELETE'), 'участник удалён с первого нажатия').toBe(false)
    fireEvent.click(screen.getByText('Да, убрать'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/weddings/w1/members/u2')).toBe(true))
  })

  it('409 last_couple — словами сервера', async () => {
    await openTeam(teamRoutes('couple', {
      '/weddings/w1/members/u3': withStatus(409, 'last_couple', 'Нельзя убрать последнего участника с ролью «пара» — свадьба останется ничьей'),
    }))
    fireEvent.click(memberAction('Боря', 'Убрать из команды'))
    fireEvent.click(screen.getByText('Да, убрать'))
    expect(await screen.findByText('Нельзя убрать последнего участника с ролью «пара» — свадьба останется ничьей')).toBeTruthy()
  })
})

describe('D1-25: помощнику и координатору не показывают то, что им запрещено', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('у помощника нет блока «Пригласить», кнопок строк ссылок и действий над участниками', async () => {
    const { container } = await openTeam(teamRoutes('helper'))
    /* Роль известна только по ответу — ждём его, а не смотрим сразу. */
    await waitFor(() => expect(container.textContent).toContain('Активные ссылки'))
    expect(screen.queryByText('Пригласить')).toBeNull()
    expect(screen.queryByText('Партнёр')).toBeNull()
    expect(screen.queryByText('Копия')).toBeNull()
    expect(screen.queryByLabelText('Отозвать ссылку')).toBeNull()
    expect(container.querySelector('[aria-label="Убрать из команды"]')).toBeNull()
    expect(container.querySelector('[aria-label="Сменить роль"]')).toBeNull()
  })

  it('у пары блок «Пригласить» есть (контроль)', async () => {
    await openTeam(teamRoutes('couple'))
    expect(await screen.findByText('Пригласить')).toBeTruthy()
    expect(screen.getByText('Копия')).toBeTruthy()
  })
})

describe('D1-17: срок ссылки считается один раз при открытии, а не в каждой отрисовке', () => {
  beforeEach(() => {
    signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-09-01T12:00:00.000Z') })
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('перерисовка после сдвига часов не меняет «дн.» без перечитывания', async () => {
    await openTeam(teamRoutes('couple', {
      '/weddings/w1/invites': [{ code: 'ДРУГ-7F3K', url: 'https://tili-tili.ru/join/ДРУГ-7F3K', role: 'helper', expiresAt: '2026-09-04T00:00:00.000Z', used: false }],
    }))
    expect(await screen.findByText(/3 дн\./)).toBeTruthy()
    vi.setSystemTime(new Date('2026-09-03T12:00:00.000Z'))
    /* Любая перерисовка: «Копия» меняет состояние кнопки. */
    fireEvent.click(screen.getByText('Копия'))
    expect(screen.queryByText(/1 дн\./), 'срок пересчитан в отрисовке по текущему времени').toBeNull()
    expect(screen.getByText(/3 дн\./)).toBeTruthy()
  })
})

/* ── D1-20 / D4-05 / D4-06 / D4-10 / D1-22: экран «Мы», выход, push ─────── */

/** Браузерный push: подписка есть или нет, `unsubscribe` считается. */
function fakeBrowserPush(subscribed: boolean) {
  const stats = { unsubscribed: 0 }
  const subscription = {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p256', auth: 'auth' } }),
    unsubscribe: async () => { stats.unsubscribed += 1; return true },
  }
  const pushManager = {
    getSubscription: async () => (subscribed ? subscription : null),
    subscribe: async () => subscription,
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve({ pushManager }) }, configurable: true })
  vi.stubGlobal('PushManager', function PushManager() { /* признак поддержки */ })
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' })
  return stats
}

const usRoutes = (over: Routes = {}): Routes => ({
  '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', role: 'couple' }],
  '/weddings/w1': { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' } },
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Аня', isStaff: false },
  '/users/me/referral': { code: 'ТИЛИ-АНЯ', invited: 0, earned: { amount: 0, currency: 'RUB' } },
  '/users/me/sessions': (c: Call) => (c.method === 'DELETE' ? withStatus(204, '', '') : [{ id: 'other-1', device: 'Android', current: false }, { id: 'this-one', device: 'Windows', current: true }]),
  '/users/me/sessions/this-one': withStatus(204, '', ''),
  '/users/me/push-subscriptions': withStatus(204, '', ''),
  ...over,
})

async function openUs(routes: Routes) {
  const calls = serve(routes)
  const r = render(
    <MemoryRouter initialEntries={['/us']}>
      <StoreProvider>
        <Routes>
          <Route path="/us" element={<Us />} />
          <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('Аня ♥ Боря')).toBeTruthy(), { timeout: 4000 })
  return { ...r, calls }
}

describe('D1-20 / D4-05 / D4-06: «Выйти из аккаунта» на экране «Мы» — настоящий выход', () => {
  beforeEach(() => {
    signedIn()
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BAbc123_-key')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, 'serviceWorker') })

  it('гасит сессии на сервере, снимает push этого устройства и чистит устройство', async () => {
    const push = fakeBrowserPush(true)
    const { calls, container } = await openUs(usRoutes())
    fireEvent.click(screen.getByText('Выйти из аккаунта'))
    await waitFor(() => expect(container.textContent).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    const seq = calls.filter(c => c.method === 'DELETE').map(c => `${c.method} ${c.url}`)
    expect(seq, 'выход не гасит сессии на сервере').toEqual([
      /* Push — первым, пока токен жив; только своя подписка, по endpoint (D4-06/D4-10). */
      'DELETE /users/me/push-subscriptions?endpoint=https%3A%2F%2Fpush.example%2Fabc',
      'DELETE /users/me/sessions',
      'DELETE /users/me/sessions/this-one',
    ])
    expect(push.unsubscribed, 'подписка браузера осталась после выхода').toBe(1)
    expect(storedTokens(), 'токены остались после выхода').toBeNull()
    expect(localStorage.getItem('tt_wedding_id'), 'свадьба осталась на устройстве после выхода').toBeNull()
  })

  it('service worker не зарегистрирован — выход не виснет на «Секунду…» (ERR-0232)', async () => {
    /* `navigator.serviceWorker.ready` без регистрации не отвечает никогда:
       dev-сборка, приватный режим, сорвавшаяся регистрация. Живая проверка:
       нажатие «Выйти из аккаунта» — ни одного запроса, токены на месте. */
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { ready: new Promise(() => {}), getRegistration: async () => undefined },
      configurable: true,
    })
    vi.stubGlobal('PushManager', function PushManager() { /* признак поддержки */ })
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' })
    const { calls, container } = await openUs(usRoutes())
    fireEvent.click(screen.getByText('Выйти из аккаунта'))
    await waitFor(() => expect(container.textContent).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    const seq = calls.filter(c => c.method === 'DELETE').map(c => `${c.method} ${c.url}`)
    // Подписки нет — на сервере от этого устройства удалять нечего; сессии гасятся как обычно.
    expect(seq).toEqual(['DELETE /users/me/sessions', 'DELETE /users/me/sessions/this-one'])
    expect(storedTokens()).toBeNull()
  })
})

describe('D4-06 / D4-10: push на этом устройстве', () => {
  beforeEach(() => {
    signedIn()
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BAbc123_-key')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, 'serviceWorker') })

  const settingsRoutes = (): Routes => ({
    '/users/me': { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null },
    '/users/me/sessions': [],
    '/weddings': [],
    '/me/favorites': [],
    '/users/me/push-subscriptions': withStatus(204, '', ''),
  })

  it('выключение снимает только свою подписку: DELETE с endpoint, не все подписки человека', async () => {
    const push = fakeBrowserPush(true)
    const calls = serve(settingsRoutes())
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Push на этом устройстве')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Push на этом устройстве'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/users/me/push-subscriptions')).toBe(true))
    const del = calls.find(c => c.method === 'DELETE' && c.path === '/users/me/push-subscriptions')!
    expect(del.url, 'удалены все подписки человека, а не подписка этого устройства').toBe('/users/me/push-subscriptions?endpoint=https%3A%2F%2Fpush.example%2Fabc')
    expect(push.unsubscribed).toBe(1)
    await waitFor(() => expect(screen.getByText('Push на этом устройстве выключен')).toBeTruthy())
  })

  it('подписка в браузере без подтверждения сервера не выдаётся за «включён»', async () => {
    fakeBrowserPush(true)
    serve(settingsRoutes())
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    await waitFor(() => expect(screen.getByLabelText('Push на этом устройстве')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByText('Push включён на этом устройстве'), 'чужая подписка выдана за свою').toBeNull()
    expect(screen.getByText(/проверить нельзя/)).toBeTruthy()
  })
})

describe('D1-23 / D1-18: настройки — отзыв согласия и отказ завершения сессии', () => {
  beforeEach(() => { signedIn() })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const settingsRoutes = (over: Routes = {}): Routes => ({
    '/users/me': (c: Call) => (c.method === 'DELETE' ? withStatus(409, 'active_deals', 'Сначала завершите или отмените сделки (1): Студия «Пион»') : { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null }),
    '/users/me/sessions': [{ id: 'other-1', device: 'Android', current: false }, { id: 'this-one', device: 'Windows', current: true }],
    '/users/me/sessions/other-1': withStatus(404, 'not_found', 'Сессия не найдена'),
    '/users/me/consent': withStatus(204, '', ''),
    '/weddings': [],
    '/me/favorites': [],
    ...over,
  })

  const openSettings = (routes: Routes) => {
    const calls = serve(routes)
    const r = render(
      <MemoryRouter initialEntries={['/settings']}>
        <StoreProvider>
          <Routes>
            <Route path="/settings" element={<Settings />} />
            <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    )
    return { ...r, calls }
  }

  it('D1-23: отзыв согласия — два нажатия, предупреждение словами кода сервера, DELETE /users/me/consent, выход', async () => {
    const { calls, container } = openSettings(settingsRoutes())
    await waitFor(() => expect(screen.getByText('Отозвать согласие на обработку данных')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Отозвать согласие на обработку данных'))
    expect(calls.some(c => c.method === 'DELETE'), 'согласие отозвано с первого нажатия').toBe(false)
    /* Что именно сделает сервер: пометка на удаление, сессии, 30 дней, сделки не проверяются. */
    expect(container.textContent).toContain('аккаунт помечен на удаление')
    expect(container.textContent).toContain('30 дней')
    expect(container.textContent).toContain('сделки при этом не проверяются')
    fireEvent.click(screen.getByText('Подтвердить отзыв согласия'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/users/me/consent')).toBe(true))
    await waitFor(() => expect(container.textContent).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    expect(storedTokens()).toBeNull()
  })

  it('D1-23: 409 на удаление аккаунта — предлагается отзыв согласия', async () => {
    const { container } = openSettings(settingsRoutes())
    await waitFor(() => expect(screen.getByText('Удалить аккаунт и все данные')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Удалить аккаунт и все данные'))
    fireEvent.click(screen.getByText('Подтвердить удаление — данные сотрутся'))
    expect(await screen.findByText('Сначала завершите или отмените сделки (1): Студия «Пион»')).toBeTruthy()
    expect(container.textContent).toContain('Отозвать согласие можно и с ними')
  })

  it('D1-18: отказ завершения чужой сессии показан словами, а не проглочен', async () => {
    openSettings(settingsRoutes())
    await waitFor(() => expect(screen.getByText('Завершить')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Завершить'))
    expect(await screen.findByText('Сессия не найдена')).toBeTruthy()
  })
})

describe('D1-22: реферальный блок — есть куда ввести чужой код', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«У меня есть код» → POST /referral/{code}/apply, счётчик перечитывается', async () => {
    let invited = 0
    const { calls, container } = await openUs(usRoutes({
      '/users/me/referral': () => ({ code: 'ТИЛИ-АНЯ', invited, earned: { amount: 0, currency: 'RUB' } }),
      '/referral/ТИЛИ-ОЛЯ/apply': () => { invited = 1; return { ok: true } },
    }))
    fireEvent.click(screen.getByText('У меня есть код'))
    fireEvent.change(screen.getByPlaceholderText('ТИЛИ-ИМЯ'), { target: { value: ' тили-оля ' } })
    fireEvent.click(screen.getByText('Применить'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/referral/ТИЛИ-ОЛЯ/apply')).toBe(true))
    expect(await screen.findByText('Код применён')).toBeTruthy()
    expect(container.textContent).not.toContain('пока не начисляются')
  })

  it('409 — словами сервера', async () => {
    await openUs(usRoutes({ '/referral/ТИЛИ-ОЛЯ/apply': withStatus(409, 'referral_used', 'Реферальный код уже применён') }))
    fireEvent.click(screen.getByText('У меня есть код'))
    fireEvent.change(screen.getByPlaceholderText('ТИЛИ-ИМЯ'), { target: { value: 'ТИЛИ-ОЛЯ' } })
    fireEvent.click(screen.getByText('Применить'))
    expect(await screen.findByText('Реферальный код уже применён')).toBeTruthy()
  })
})

/* ── D4-08 / D4-09 / D4-11 / D4-15: диалог ──────────────────────────────── */

/* Текст предупреждения платформы (§18.2) — как у сервера; после фичи 005 экран
   узнаёт запись по `system`, а не по этому тексту, и копии в `Us.tsx` больше нет. */
const PAYOUT_WARNING =
  'Переводы вне договора не защищены: деньги идут мимо эскроу, и вернуть их при отмене нечем. ' +
  'Договор формируется за две минуты в карточке сделки.'

type Msg = { id: string; chatId: string; senderId: string | null; text: string; sentAt: string }
const msg = (n: number, senderId: string | null, text = `реплика ${n}`): Msg =>
  ({ id: `m${n}`, chatId: 'ch1', senderId, text, sentAt: new Date(Date.UTC(2026, 8, 1, 10, 0, n)).toISOString() })

const chatRoutes = (kind: string, over: Routes = {}): Routes => ({
  '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', role: 'couple' }],
  '/weddings/w1': { id: 'w1', title: 'Аня ♥ Боря' },
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Аня' },
  '/chats': [{ id: 'ch1', kind, title: 'Команда свадьбы', unread: 0, lastMessage: '', openFrom: '2026-06-13T06:00:00.000Z' }],
  '/chats/ch1/messages': { items: [msg(2, 'u2'), msg(1, 'u1')], nextCursor: null },
  ...over,
})

async function openChat(routes: Routes) {
  const calls = serve(routes)
  const r = render(
    <MemoryRouter initialEntries={['/us/chats/ch1']}>
      <StoreProvider>
        <Routes><Route path="/us/chats/:id" element={<Chat />} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(screen.getByText('Команда свадьбы')).toBeTruthy(), { timeout: 4000 })
  return { ...r, calls }
}

describe('D4-08: «печатает» — только про собеседника', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')); socketEvents.length = 0 })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('своё событие typing индикатор не показывает, чужое — показывает', async () => {
    const { container } = await openChat(chatRoutes('team'))
    await waitFor(() => expect(screen.getByText('реплика 1')).toBeTruthy())
    await waitFor(() => expect(socketEvents.length).toBeGreaterThan(0))
    await act(async () => { socketEvents.forEach(h => h({ type: 'typing', chatId: 'ch1', actorId: 'u1' })) })
    expect(container.querySelector('.animate-bounce'), 'три точки «печатает» от собственного набора').toBeNull()
    await act(async () => { socketEvents.forEach(h => h({ type: 'typing', chatId: 'ch1', actorId: 'u2' })) })
    expect(container.querySelector('.animate-bounce')).toBeTruthy()
  })
})

describe('D4-09: история листается курсором', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Показать сообщения раньше» просит ?cursor=… и дописывает страницу сверху', async () => {
    const newest = Array.from({ length: 50 }, (_, i) => msg(100 - i, i % 2 ? 'u1' : 'u2'))
    const older = Array.from({ length: 50 }, (_, i) => msg(50 - i, i % 2 ? 'u1' : 'u2'))
    const { calls } = await openChat(chatRoutes('team', {
      /* Сервер режет любой limit до 100, а здесь и вовсе отдаёт одну страницу
         на любой limit: дочитать историю можно только курсором. */
      '/chats/ch1/messages': (c: Call) => (c.url.includes('cursor=c50')
        ? { items: older, nextCursor: null }
        : { items: newest, nextCursor: 'c50' }),
    }))
    await waitFor(() => expect(screen.getByText('реплика 51')).toBeTruthy())
    fireEvent.click(screen.getByText('Показать сообщения раньше'))
    await waitFor(() => expect(screen.getByText('реплика 1')).toBeTruthy(), { timeout: 4000 })
    expect(calls.some(c => c.path === '/chats/ch1/messages' && c.url.includes('cursor=c50')), 'старая страница запрошена не курсором').toBe(true)
    expect(screen.getAllByText(/^реплика \d+$/)).toHaveLength(100)
    /* Порядок — хронологический: старое сверху. Текст пузыря — его первый
       узел; дальше идёт время отправки. */
    const texts = screen.getAllByText(/^реплика \d+$/).map(e => e.childNodes[0]?.textContent)
    expect(texts[0]).toBe('реплика 1')
    expect(texts[99]).toBe('реплика 100')
    /* Дочитали до конца — кнопки больше нет. */
    expect(screen.queryByText('Показать сообщения раньше')).toBeNull()
  })

  it('новые реплики вытолкнули старые из хвоста — дыры между хвостом и дочитанным нет', async () => {
    let calls = 0
    const page = (from: number) => Array.from({ length: 50 }, (_, i) => msg(from - i, i % 2 ? 'u1' : 'u2'))
    await openChat(chatRoutes('team', {
      '/chats/ch1/messages': (c: Call) => {
        if (c.url.includes('cursor=')) return { items: page(50), nextCursor: null }
        /* Первый хвост — 51…100; после десяти новых реплик — 61…110. */
        return ++calls === 1 ? { items: page(100), nextCursor: 'c50' } : { items: page(110), nextCursor: 'c60' }
      },
    }))
    await waitFor(() => expect(screen.getByText('реплика 51')).toBeTruthy())
    fireEvent.click(screen.getByText('Показать сообщения раньше'))
    await waitFor(() => expect(screen.getByText('реплика 1')).toBeTruthy(), { timeout: 4000 })
    /* Живой канал сообщил о новом — хвост перечитан. */
    await waitFor(() => expect(socketEvents.length).toBeGreaterThan(0))
    await act(async () => { socketEvents.forEach(h => h({ type: 'message', chatId: 'ch1' })) })
    await waitFor(() => expect(screen.getByText('реплика 110')).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText('реплика 55'), 'реплика между дочитанным и новым хвостом пропала').toBeTruthy()
    expect(screen.getAllByText(/^реплика \d+$/)).toHaveLength(110)
  })
})

describe('D4-11: «чат откроется …» — только по 423', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('сеть упала у чата дня X — «Сервер недоступен», а не прошедшая дата открытия', async () => {
    const { container } = await openChat(chatRoutes('day', { '/chats/ch1/messages': DOWN }))
    await waitFor(() => expect(container.textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(container.textContent, 'обрыв сети показан как расписание').not.toContain('Чат дня свадьбы откроется')
  })

  it('423 — расписание словами (контроль)', async () => {
    const { container } = await openChat(chatRoutes('day', { '/chats/ch1/messages': withStatus(423, 'chat_locked', 'Чат откроется в день свадьбы') }))
    await waitFor(() => expect(container.textContent).toContain('Чат дня свадьбы откроется'), { timeout: 4000 })
  })
})

describe('D4-15: запись без автора — системная только если это предупреждение платформы', () => {
  beforeEach(() => { signedIn(); localStorage.setItem('tt_wedding_id', JSON.stringify('w1')) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('реплика ушедшего участника — обычное сообщение с подписью, а не «⚠»', async () => {
    const { container } = await openChat(chatRoutes('team', {
      '/chats/ch1/messages': { items: [msg(2, null, 'Заеду за тортом в 12'), msg(1, 'u1')], nextCursor: null },
    }))
    await waitFor(() => expect(screen.getByText('Заеду за тортом в 12')).toBeTruthy())
    expect(container.textContent, 'реплика человека показана как предупреждение платформы').not.toContain('⚠ Заеду')
    expect(screen.getByText('Участник вышел')).toBeTruthy()
  })

  /* Фича 005 (контракт v0.29.0): системную запись сервер помечает
     `Message.system`, экран больше не держит копию текста предупреждения и
     не сверяет его слово в слово — признак вместо угадывания (audit32, T5).
     Прежний тест «текст на клиенте совпадает с серверным» снят: сверять
     нечего, `PAYOUT_WARNING` из `Us.tsx` ушёл. */
  it('предупреждение платформы без автора — системная запись (контроль)', async () => {
    const { container } = await openChat(chatRoutes('team', {
      '/chats/ch1/messages': { items: [{ ...msg(2, null, PAYOUT_WARNING), system: true }, msg(1, 'u1')], nextCursor: null },
    }))
    await waitFor(() => expect(container.textContent).toContain('⚠'))
    expect(screen.queryByText('Участник вышел')).toBeNull()
  })
})

describe('D4-22: время в теле компонентов снимается один раз', () => {
  it('в Us.tsx, Account.tsx и Team.tsx нет `new Date()` вне инициализатора useState', () => {
    const offenders: string[] = []
    for (const f of ['src/pages/Us.tsx', 'src/pages/Account.tsx', 'src/pages/Team.tsx']) {
      projectFile(f).split('\n').forEach((line, i) => {
        if (/new Date\(\)/.test(line) && !/useState\(\(\) =>/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})

/* ── D2-10: мозаика не переживает смену свадьбы ──────────────────────────── */

function SlotsProbe() {
  const { slots, slotsState, setWeddingId, weddingId } = useStore()
  return (
    <div>
      <span data-testid="wid">{weddingId ?? 'нет'}</span>
      <span data-testid="n">{slots.length}</span>
      <span data-testid="st">{slotsState}</span>
      <button onClick={() => setWeddingId('w2')}>на w2</button>
      <button onClick={() => setWeddingId(null)}>без свадьбы</button>
    </div>
  )
}

const slotOf = (id: string, name: string) =>
  ({ id, categoryId: 'photo', label: 'Фотограф', tileState: 'booked', deal: { id: `d-${id}`, state: 'booked', externalName: name, externalPhone: '+79170000001', price: { amount: 5_000_000, currency: 'RUB' } } })

describe('D2-10: слоты одной свадьбы не показываются как слоты другой', () => {
  beforeEach(() => {
    signedIn()
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const twoWeddings = () => serve({
    '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', role: 'couple' }, { id: 'w2', title: 'Оля ♥ Петя', role: 'coordinator' }],
    '/weddings/w1': { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14' },
    '/weddings/w2': PENDING,
    '/weddings/w1/slots': [slotOf('s1', 'Фото «Кадр»')],
    /* Запрос второй свадьбы висит: ровно в этот момент экран решает, что показывать. */
    '/weddings/w2/slots': PENDING,
    '/me/favorites': [],
  })

  it('смена свадьбы при зависшем запросе: мозаика пуста и «грузится», а не слоты прежней', async () => {
    twoWeddings()
    render(<StoreProvider><SlotsProbe /></StoreProvider>)
    await waitFor(() => expect(screen.getByTestId('st').textContent).toBe('ready'))
    expect(screen.getByTestId('n').textContent).toBe('1')

    fireEvent.click(screen.getByText('на w2'))
    await waitFor(() => expect(screen.getByTestId('wid').textContent).toBe('w2'))
    expect(screen.getByTestId('n').textContent, 'слоты w1 показаны как слоты w2').toBe('0')
    expect(screen.getByTestId('st').textContent, 'состояние w1 выдано за состояние w2').toBe('loading')
  })

  it('свадьбы больше нет — слотов тоже', async () => {
    twoWeddings()
    render(<StoreProvider><SlotsProbe /></StoreProvider>)
    await waitFor(() => expect(screen.getByTestId('st').textContent).toBe('ready'))

    fireEvent.click(screen.getByText('без свадьбы'))
    await waitFor(() => expect(screen.getByTestId('wid').textContent).toBe('нет'))
    expect(screen.getByTestId('n').textContent, 'слоты отменённой свадьбы остались').toBe('0')
    expect(screen.getByTestId('st').textContent).toBe('idle')
  })
})
