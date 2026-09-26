// @vitest-environment jsdom
/*
 * F4 · Повторное согласие при смене редакции политики (RL-1, review016-tail6).
 *
 * Гейт стоит в `Shell` (`App.tsx`) вместо маршрутов: живёт вошедший с
 * устаревшей подписью (`tt_consent_outdated` + `tt_auth`), любой несвободный
 * путь показывает один и тот же экран независимо от адреса. Харнесс — всё
 * приложение под `MemoryRouter`, как в `audit49h`/`audit50e`: гейт обходит
 * `<Routes>` целиком, и только реальные маршруты и переходы это доказывают.
 *
 * F-T1..F-T14 — по имени из ROADMAP.md (F4 · Тесты первыми, фронт).
 * F-T7 и F-T9 разнесены на два `it()` каждый — в тексте плана это варианты
 * одного пункта, а не один прогон.
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { t, setI18nLang } from '@/lib/i18n'
import { LEGAL_TEXT_VERSION } from '@/lib/legal'
import { projectFile } from '@/test/projectFiles'

/* «Обновить приложение» вызывает настоящую навигацию (`location.replace`),
   которую jsdom не переживает молча — подменяем только её, весь остальной
   модуль (`t`, `getI18nLang`, `setI18nLang`, `key`, `appRoot`) настоящий. */
const reloadToRootSpy = vi.hoisted(() => vi.fn())
vi.mock('@/lib/i18n', async (orig) => ({
  ...await orig<object>(),
  reloadToRoot: reloadToRootSpy,
}))

type Call = { method: string; path: string; body: unknown }
type Routes = Record<string, unknown>

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const toResponse = (reply: unknown) => (isStatus(reply) ? json(reply.body, reply.__status) : json(reply))
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, body }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    return Promise.resolve(reply).then(toResponse)
  }))
  return calls
}

/** Действующая редакция как её видит гейт: совпадает со сборкой, галочки открыты. */
const POLICY = { policyVersion: LEGAL_TEXT_VERSION }

function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}
const locOf = (r: { container: HTMLElement }) => r.container.querySelector('[data-testid="loc"]')?.textContent ?? ''

/** Зонд навигации для F-T3: «Назад» и переход на документ в том же `MemoryRouter`, что у `<App/>`. */
function NavProbe() {
  const nav = useNavigate()
  return (
    <div>
      <button onClick={() => nav(-1)}>ПРОБА: назад</button>
      <button onClick={() => nav('/legal/privacy')}>ПРОБА: политика</button>
    </div>
  )
}

const gateConsentBox = () => screen.getByRole('checkbox', { name: /обработку персональных данных/ })
const gateAdultBox = () => screen.getByRole('checkbox', { name: 'Мне есть 18 лет' })
const gateHeading = () => screen.getByText(t('Мы обновили документы'))

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}
const withGate = () => localStorage.setItem('tt_consent_outdated', '1')

beforeEach(signedIn)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('F4-F: гейт устаревшего согласия', () => {
  it('F-T1: deep-link на защищённый путь — сервер отвечает 403 consent_outdated, флаг и гейт заводятся сами, один заголовок, ни экрана, ни таб-бара, адрес прежний', async () => {
    /* Без withGate(): единственный тест, который проверяет настоящий сигнал —
       первый запрос стора (`GET /weddings`, `store.tsx:172-195`) отвечает 403
       `consent_outdated`, и флаг заводит именно `client.ts:433`
       (`reportConsentOutdated()`), а не заранее выставленное значение. */
    serve({
      '/legal/policy': POLICY,
      '/weddings': withStatus(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить'),
    })
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
    const r = render(
      <MemoryRouter initialEntries={['/wedding/budget']}><App /><LocationProbe /></MemoryRouter>,
    )
    await waitFor(() => expect(screen.getAllByText(t('Мы обновили документы'))).toHaveLength(1))
    expect(r.container.querySelector('nav')).toBeNull()
    expect(locOf(r)).toBe('/wedding/budget')
    expect(localStorage.getItem('tt_consent_outdated')).toBe('1')
  })

  it('F-T2: гейт закрывает несвободные пути и не трогает свободные', async () => {
    withGate()
    serve({ '/legal/policy': POLICY })
    const gated = ['/', '/auth', '/home', '/notifications', '/us/chats/c1', '/vendor-app/deals/d1', '/admin', '/нет-такого']
    for (const p of gated) {
      render(<MemoryRouter initialEntries={[p]}><App /></MemoryRouter>)
      await waitFor(() => expect(screen.getAllByText(t('Мы обновили документы')).length).toBeGreaterThan(0))
      cleanup()
    }
    const free = ['/legal/offer', '/legal/privacy', '/invite', '/guest-vendor/tok1', '/gifts']
    for (const p of free) {
      render(<MemoryRouter initialEntries={[p]}><App /></MemoryRouter>)
      await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
      cleanup()
    }
  })

  it('F-T2b: ссылки «оферту» и «политику конфиденциальности» на самом гейте уводят на документы', async () => {
    withGate()
    serve({ '/legal/policy': POLICY })
    render(<MemoryRouter initialEntries={['/home']}><App /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText(t('оферту')))
    await waitFor(() => expect(screen.getByText(/Редакция от/)).toBeTruthy())
    expect(screen.getByTestId('loc').textContent).toBe('/legal/offer')
    cleanup()

    render(<MemoryRouter initialEntries={['/home']}><App /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText(t('политику конфиденциальности')))
    await waitFor(() => expect(screen.getByText(/Редакция от/)).toBeTruthy())
    expect(screen.getByTestId('loc').textContent).toBe('/legal/privacy')
  })

  it('F-T3: «Назад» и переход на документ не обходят гейт и не путают его', async () => {
    withGate()
    serve({ '/legal/policy': POLICY })
    render(
      <MemoryRouter initialEntries={['/home', '/wedding/budget']}><App /><NavProbe /></MemoryRouter>,
    )
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText('ПРОБА: назад'))
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText('ПРОБА: политика'))
    await waitFor(() => expect(screen.getByText(/Редакция от/)).toBeTruthy())
    expect(screen.queryByText(t('Мы обновили документы'))).toBeNull()
    fireEvent.click(screen.getByText('ПРОБА: назад'))
    await waitFor(() => expect(gateHeading()).toBeTruthy())
  })

  it('F-T4: холодный старт офлайн — гейт в первом кадре, «Повторить», галочки закрыты, «Выйти» доступна', async () => {
    withGate()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    /* Без waitFor: `gated` считается синхронно при первом рендере
       (`App.tsx:183`) — если гейт стоит только «когда-нибудь», а не в первом
       кадре, этот синхронный поиск должен упасть сам, а не подождать. */
    expect(gateHeading()).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Не удалось проверить редакцию документов/)).toBeTruthy())
    expect(gateConsentBox().hasAttribute('disabled')).toBe(true)
    expect(gateAdultBox().hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(t('Выйти')).closest('button')!.hasAttribute('disabled')).toBe(false)
  })

  it('F-T5: «Принять» — закрыта без обеих галочек, ровно одно тело, флаг снят, тот же адрес, стор пересверен', async () => {
    withGate()
    const calls = serve({ '/legal/policy': POLICY, '/users/me/consent': { __status: 201, body: null }, '/weddings': [] })
    const r = render(<MemoryRouter initialEntries={['/wedding/budget']}><App /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    const acceptBtn = () => screen.getByText(t('Принять')).closest('button')!
    await waitFor(() => expect(gateConsentBox().hasAttribute('disabled')).toBe(false))
    expect(acceptBtn().hasAttribute('disabled')).toBe(true)
    fireEvent.click(gateConsentBox())
    expect(acceptBtn().hasAttribute('disabled')).toBe(true)
    fireEvent.click(gateAdultBox())
    expect(acceptBtn().hasAttribute('disabled')).toBe(false)
    fireEvent.click(acceptBtn())
    await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
    const posts = calls.filter(c => c.method === 'POST' && c.path === '/users/me/consent')
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toEqual({ policyVersion: LEGAL_TEXT_VERSION, adult: true })
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
    expect(locOf(r)).toBe('/wedding/budget')
    const postIdx = calls.findIndex(c => c.method === 'POST' && c.path === '/users/me/consent')
    const weddingsAfter = calls.findIndex((c, i) => i > postIdx && c.method === 'GET' && c.path === '/weddings')
    expect(weddingsAfter).toBeGreaterThan(postIdx)
  })

  it('F-T6: проба своего профиля 200 — гейт уходит без нажатий, флаг снят', async () => {
    withGate()
    serve({ '/legal/policy': POLICY, '/users/me': { id: 'u1' } })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
  })

  it('F-T7a: «Выйти» — сессии гасятся, токены и флаг пусты, экран входа', async () => {
    withGate()
    /* Реалистичное состояние вошедшего аккаунта — как после настоящего входа
       (`store.tsx:452` ставит его же при сверке свадеб), а не защита от гонки
       `/home` → `/`: она закрыта в `Consent.tsx` одним `startTransition`
       независимо от этого флага (F4-F-G5r5.txt, находка -03: без него тест
       тоже зелёный с фиксом — M5, а без фикса тем же путём краснел и F-T8,
       который `tt_onboarded` вовсе не ставит). */
    localStorage.setItem('tt_onboarded', '1')
    const calls = serve({
      '/legal/policy': POLICY,
      '/users/me/sessions': (c: Call) => (c.method === 'GET' ? [{ id: 's1', current: true }] : { __status: 204, body: null }),
      '/users/me/sessions/s1': { __status: 204, body: null },
    })
    const r = render(<MemoryRouter initialEntries={['/home']}><App /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText(t('Выйти')).closest('button')!)
    await waitFor(() => expect(localStorage.getItem('tt_auth')).toBeNull())
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
    await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
    /* «Выйти» действительно гасит именно текущую сессию (`signOutHere()`,
       `auth.ts:130-140`), а не просто чистит хранилище, и после неё —
       настоящий экран входа, а не пустой адрес. */
    await waitFor(() => expect(locOf(r)).toBe('/auth'))
    expect(calls.filter(c => c.method === 'GET' && c.path === '/users/me/sessions')).toHaveLength(1)
    expect(calls.filter(c => c.method === 'DELETE' && c.path === '/users/me/sessions/s1')).toHaveLength(1)
  })

  it('F-T7b: вариант «сервер без ARB-2» — GET /users/me/sessions 403 consent_outdated → текст под кнопкой, токены на месте', async () => {
    withGate()
    serve({
      '/legal/policy': POLICY,
      '/users/me/sessions': withStatus(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить'),
    })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    fireEvent.click(screen.getByText(t('Выйти')).closest('button')!)
    await waitFor(() => expect(screen.getByText(/Мы обновили документы — подтвердите новую редакцию, чтобы продолжить/)).toBeTruthy())
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual({ accessToken: 'a', refreshToken: 'r' })
    expect(gateHeading()).toBeTruthy()
  })

  it('F-T8: «Не согласен — удалить аккаунт» — второй шаг отзывает согласие; 500 — текст, токены на месте, шаг снят', async () => {
    withGate()
    const state = { fail: true }
    const calls = serve({
      '/legal/policy': POLICY,
      '/users/me/consent': () => (state.fail ? withStatus(500, 'internal', 'Ошибка сервера') : { __status: 204, body: null }),
    })
    const r = render(<MemoryRouter initialEntries={['/home']}><App /><LocationProbe /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())

    fireEvent.click(screen.getByText(t('Не согласен — удалить аккаунт')).closest('button')!)
    await waitFor(() => expect(screen.getByText(t('Подтвердить отзыв согласия'))).toBeTruthy())
    fireEvent.click(screen.getByText(t('Подтвердить отзыв согласия')).closest('button')!)
    await waitFor(() => expect(screen.getByText(t('Сервер недоступен. Попробуйте позже'))).toBeTruthy())
    expect(JSON.parse(localStorage.getItem('tt_auth')!)).toEqual({ accessToken: 'a', refreshToken: 'r' })
    expect(screen.queryByText(t('Подтвердить отзыв согласия'))).toBeNull()
    expect(screen.getByText(t('Не согласен — удалить аккаунт'))).toBeTruthy()
    expect(calls.filter(c => c.method === 'DELETE' && c.path === '/users/me/consent')).toHaveLength(1)

    state.fail = false
    fireEvent.click(screen.getByText(t('Не согласен — удалить аккаунт')).closest('button')!)
    fireEvent.click(screen.getByText(t('Подтвердить отзыв согласия')).closest('button')!)
    await waitFor(() => expect(localStorage.getItem('tt_auth')).toBeNull())
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
    /* Второй, удавшийся вызов действительно ушёл на сервер (`withdrawConsent()`,
       `auth.ts:150`), и итог — настоящий экран входа, а не пустой адрес. */
    expect(calls.filter(c => c.method === 'DELETE' && c.path === '/users/me/consent')).toHaveLength(2)
    await waitFor(() => expect(locOf(r)).toBe('/auth'))
  })

  it('F-T9a: редакция сборки разошлась с сервера с самого начала — галочки закрыты, «Обновить приложение» зовёт reloadToRoot', async () => {
    withGate()
    serve({ '/legal/policy': { policyVersion: '2099-01-01' } })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText(/Документы обновились/)).toBeTruthy())
    expect(gateConsentBox().hasAttribute('disabled')).toBe(true)
    expect(gateAdultBox().hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByText(t('Обновить приложение')).closest('button')!)
    expect(reloadToRootSpy).toHaveBeenCalledTimes(1)
  })

  it('F-T9b: 409 во время гейта — редакция на сервере успела разойтись, галочки сняты и закрыты, второго POST нет', async () => {
    withGate()
    const state = { policy: LEGAL_TEXT_VERSION }
    const calls = serve({
      '/legal/policy': () => ({ policyVersion: state.policy }),
      '/users/me/consent': () => { state.policy = '2099-01-01'; return withStatus(409, 'policy_version_stale', 'Текст обновился') },
    })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(gateConsentBox().hasAttribute('disabled')).toBe(false))
    fireEvent.click(gateConsentBox())
    fireEvent.click(gateAdultBox())
    fireEvent.click(screen.getByText(t('Принять')).closest('button')!)
    await waitFor(() => expect(screen.getByText(/Документы обновились/)).toBeTruthy())
    expect(gateConsentBox().getAttribute('aria-checked')).toBe('false')
    expect(gateAdultBox().getAttribute('aria-checked')).toBe('false')
    expect(gateConsentBox().hasAttribute('disabled')).toBe(true)
    expect(calls.filter(c => c.method === 'POST' && c.path === '/users/me/consent')).toHaveLength(1)
  })

  it('F-T10: сеть при «Принять» — текст, галочки стоят; второй клик уходит успехом, ровно два POST', async () => {
    withGate()
    const state = { fail: true }
    const calls = serve({
      '/legal/policy': POLICY,
      '/users/me/consent': () => (state.fail ? Promise.reject(new TypeError('offline')) : { __status: 201, body: null }),
      '/weddings': [],
    })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(gateConsentBox().hasAttribute('disabled')).toBe(false))
    fireEvent.click(gateConsentBox())
    fireEvent.click(gateAdultBox())
    fireEvent.click(screen.getByText(t('Принять')).closest('button')!)
    await waitFor(() => expect(screen.getByText(t('Сервер недоступен. Попробуйте позже'))).toBeTruthy())
    expect(gateConsentBox().getAttribute('aria-checked')).toBe('true')
    expect(gateAdultBox().getAttribute('aria-checked')).toBe('true')
    state.fail = false
    fireEvent.click(screen.getByText(t('Принять')).closest('button')!)
    await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
    expect(calls.filter(c => c.method === 'POST' && c.path === '/users/me/consent')).toHaveLength(2)
  })

  it('F-T11: 403 forbidden («Нужно согласие…») — не гейт и не флаг (спецификация)', async () => {
    /* Без withGate(): проверяется, что ОБЫЧНЫЙ отказ по правам сам не заводит
       ни гейт, ни флаг — это другой код (`forbidden`, не `consent_outdated`). */
    serve({ '/legal/policy': POLICY, '/weddings': withStatus(403, 'forbidden', 'Нужно согласие, чтобы продолжить') })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.queryByTestId('route-loading')).toBeNull())
    expect(screen.queryByText(t('Мы обновили документы'))).toBeNull()
    expect(localStorage.getItem('tt_consent_outdated')).toBeNull()
  })

  it('F-T12: живой канал — 4403 consent_outdated переводит на гейт даже когда REST чата отвечает 200; после размонтирования новых сокетов нет', async () => {
    /* Таймаут теста поднят вручную: последняя проверка ждёт реальные
       `RECONNECT_MS` (`chats.ts:47`) + запас, а не долю миллисекунды. */
    /* Без withGate(): гейт должен появиться ИМЕННО из события живого канала. */
    class FakeSocket {
      static last: FakeSocket | null = null
      static count = 0
      onopen: (() => void) | null = null
      onmessage: ((e: MessageEvent<string>) => void) | null = null
      onclose: ((e: CloseEvent) => void) | null = null
      url: string
      closed = false
      constructor(url: string) { this.url = url; FakeSocket.last = this; FakeSocket.count++ }
      close() { this.closed = true }
    }
    vi.stubGlobal('WebSocket', FakeSocket)
    serve({
      '/legal/policy': POLICY,
      '/chats': [{ id: 'c1', kind: 'vendor', title: 'Фото «Кадр»', unread: 0, lastMessage: '', openFrom: null, closed: false }],
      '/chats/c1/messages': { items: [], nextCursor: null },
      /* `/users/me` намеренно НЕ обслужен (404): и `Chat` (свой `getMe()` для
         `myId`), и позже проба гейта при монтировании должны увидеть отказ, а
         не 200 или 403 `consent_outdated` — иначе тот же перехват `client.ts`
         сработал бы от REST-запроса раньше живого канала, который здесь и
         проверяется, либо проба гейта сняла бы флаг сразу после появления. */
    })
    render(<MemoryRouter initialEntries={['/us/chats/c1']}><App /></MemoryRouter>)
    await waitFor(() => expect(FakeSocket.last?.onmessage).toBeTruthy())
    const opened = FakeSocket.count
    act(() => {
      FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'error', status: 403, code: 'consent_outdated' }) } as MessageEvent<string>)
      FakeSocket.last!.onclose!({ code: 4403 } as CloseEvent)
    })
    await waitFor(() => expect(screen.getByText(t('Мы обновили документы'))).toBeTruthy())
    await waitFor(() => expect(FakeSocket.last!.closed).toBe(true))
    expect(FakeSocket.count).toBe(opened)
    /* Настоящая проверка «после размонтирования новых сокетов нет»: ждём
       дольше `RECONNECT_MS` (3000, `chats.ts:47`), чтобы отложенный
       `connect()` из `onclose` (`chats.ts:116`) успел бы создать новый
       сокет, если бы гейт не размонтировал канал раньше — `closedByUs` +
       `clearTimeout` (`chats.ts:122-124`) гасят именно этот таймер. Проверка
       сразу после закрытия (строка выше) этого не доказывает: `RECONNECT_MS`
       ещё не истёк. */
    await new Promise(resolve => setTimeout(resolve, 3100))
    expect(FakeSocket.count).toBe(opened)
  }, 8000)

  it('F-T13: EN — гейт переведён, ни одного русского ключа на экране', async () => {
    localStorage.setItem('tt_lang', 'en')
    setI18nLang('en')
    withGate()
    serve({ '/legal/policy': POLICY })
    try {
      render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
      await waitFor(() => expect(screen.getByText('We have updated our documents')).toBeTruthy())
      expect(screen.getByText('Accept')).toBeTruthy()
      expect(screen.getByRole('checkbox', { name: 'I am 18 or older' })).toBeTruthy()
      expect(screen.queryByText('Мы обновили документы')).toBeNull()
      expect(screen.queryByText('Принять')).toBeNull()
      expect(screen.queryByText('Мне есть 18 лет')).toBeNull()
    } finally {
      setI18nLang('ru')
    }
  })

  it('F-T14: вторая вкладка приняла или вышла — storage по tt_consent_outdated снимает гейт', async () => {
    withGate()
    serve({ '/legal/policy': POLICY })
    render(<MemoryRouter initialEntries={['/home']}><App /></MemoryRouter>)
    await waitFor(() => expect(gateHeading()).toBeTruthy())
    localStorage.removeItem('tt_consent_outdated')
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'tt_consent_outdated', newValue: null })) })
    await waitFor(() => expect(screen.queryByText(t('Мы обновили документы'))).toBeNull())
  })
})

/*
 * Регрессия G5-03: «Подтвердить отзыв согласия» (`pages/Consent.tsx`) держала
 * `bg-[var(--rose-ink)] text-white` — хардкод `text-white` не виден общему
 * скану `contrast.test.ts` (тот смотрит только на пары `bg-[…]`+`text-[…]`
 * в квадратных скобках) и не переключается с темой (R-23): в тёмной теме
 * `--rose-ink` = `--rose-deep` = `#D69999`, белый текст на нём — 2.37:1
 * при норме AA 4.5:1. `contrast.test.ts` лежит вне границы F4-F — проверка
 * своя, здесь, а не там.
 */
describe('F4-F: контраст кнопки «Подтвердить отзыв согласия» (regression G5-03)', () => {
  const css = projectFile('src/index.css')
  const consentSrc = projectFile('src/pages/Consent.tsx')

  const hex = (h: string) => { const v = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16)) }
  const lum = (c: number[]) => {
    const s = c.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
    return 0.2126 * s[0] + 0.7152 * s[1] + 0.0722 * s[2]
  }
  const ratio = (a: string, b: string) => {
    const [l1, l2] = [lum(hex(a)), lum(hex(b))]
    const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
    return (hi + 0.05) / (lo + 0.05)
  }
  function tokens(block: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const m of block.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})/g)) out[m[1]] = m[2]
    return out
  }
  const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('[data-theme="dark"]'))
  const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'))
  const light = tokens(lightBlock)
  const dark = { ...light, ...tokens(darkBlock.slice(0, darkBlock.indexOf('}'))) }
  const THEMES = [['светлая', light], ['тёмная', dark]] as const

  it('цвет не хардкод и держит AA 4.5:1 в обеих темах', () => {
    const line = consentSrc.split('\n').find(l => l.includes('confirmWithdrawConsent()') && l.includes('className='))
    expect(line, 'кнопка подтверждения отзыва не найдена в Consent.tsx').toBeTruthy()
    expect(line).not.toMatch(/\btext-white\b/)
    expect(line).not.toMatch(/text-\[#[0-9A-Fa-f]{6}\]/)
    const bgTok = /\bbg-\[var\((--[\w-]+)\)\]/.exec(line!)
    const textTok = /\btext-\[var\((--[\w-]+)\)\]/.exec(line!)
    expect(bgTok, 'фон кнопки не задан токеном var(--...)').toBeTruthy()
    expect(textTok, 'цвет текста кнопки не задан токеном var(--...)').toBeTruthy()
    for (const [name, theme] of THEMES) {
      const bg = theme[bgTok![1]]
      const fg = theme[textTok![1]]
      expect(bg, `${bgTok![1]} не найден в теме ${name}`).toBeTruthy()
      expect(fg, `${textTok![1]} не найден в теме ${name}`).toBeTruthy()
      expect(ratio(fg, bg), `${name}: ${textTok![1]} на ${bgTok![1]} = ${ratio(fg, bg).toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
