// @vitest-environment jsdom
/*
 * FL-14 · F-RL-8-02 + F-RL-8-11 — ERR-0284 / R-284: у каждого `useApi`-блока
 * каталога три не-ready состояния — `ErrorState` на ошибку, слова сервера на
 * 403 (`forbiddenText`), «пусто» только на пустой ответ, — а `Search.tsx`
 * знал только про error/loading. Два самостоятельных отказа:
 *
 *  T1 (= F-RL-8-02, `Search.tsx:78,731`): смерть сессии на поиске по имени и
 *  на «Похожих» показывала голый `<p role="alert">` без «Войти» — сообщение
 *  видно, а куда идти дальше, ответа нет (тот же класс, что ERR-0264 закрыл
 *  для основных блоков экрана).
 *
 *  T2 (= F-RL-8-11, `Search.tsx:89,271,486` + `useApi.ts:122`): 403 сводился
 *  к флагу `forbidden` без слов сервера, а «пусто» проверяло только
 *  `!error` — категории/список/анкета, закрытые по правам, читались как
 *  «Ничего не нашлось» / «Под фильтр никто не подходит» / «Анкета не
 *  найдена». Правило R-284 требует третье состояние — слова сервера
 *  (`forbiddenText`) и «Войти», а не тишину под видом пустой выдачи.
 *
 * Харнесс — вариант `serve`/`withStatus`/`renderAt` из audit34.test.tsx (тот
 * же файл держит `VendorDetail`), урезанный под три экрана каталога.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { SearchCategories, VendorList, VendorDetail } from '@/pages/Search'

type RoutesMap = Record<string, unknown>
type Call = { method: string; path: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
/** Отказ сервера в формате контракта: код и текст. */
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })

function serve(routes: RoutesMap): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const TOKENS = { accessToken: 'a', refreshToken: 'r' }
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }

/** Пара со свадьбой на устройстве — тот же фикстур, что audit34/audit49g. */
const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
/** Вошедший без свадьбы: `forgetSession` на смерти сессии не меняет `city`/
 * `weddingDate` (нечего забывать), поэтому зависимости `useApi`-блоков не
 * переигрываются гонкой — нужно только для теста смерти сессии ниже. */
const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
}

/** Всё, что читает стор, вне запросов, которые называет каждый тест сам. */
const base = (over: RoutesMap = {}): RoutesMap => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': ME,
  ...over,
})
/** Вариант `base()` без свадьбы — для сигнатур `signedIn()`. */
const guest = (over: RoutesMap = {}): RoutesMap => ({
  '/weddings': [],
  '/me/favorites': [],
  '/users/me': ME,
  ...over,
})

function renderAt(initial: string, routes: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        <Routes>{routes}</Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const SESSION_EXPIRED_TEXT = 'Сессия истекла — войдите снова'
const CONSENT_TEXT = 'Нужно согласие на обработку данных — войдите заново'
const AUTH_PROBE = <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
const SEARCH_PLACEHOLDER = 'Фотограф, торт, шатёр…'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/* ── T1 (= F-RL-8-02): смерть сессии — ErrorState с «Войти», не голый alert ── */

describe('T1 (= F-RL-8-02): Search.tsx — смерть сессии на found.error / similar.error даёт ErrorState с «Войти»', () => {
  it('поиск по имени (found.error): кнопка «Войти» есть, голого <p role="alert"> без кнопки нет', async () => {
    signedIn()
    serve(guest({
      '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
      '/catalog/vendors': withStatus(401, 'unauthorized', 'irrelevant'),
      '/auth/refresh': withStatus(401, 'refresh_expired', 'Сессия истекла'),
    }))
    const r = renderAt('/search', <>
      <Route path="/search" element={<SearchCategories />} />
      {AUTH_PROBE}
    </>)
    await waitFor(() => expect(text(r)).toContain('Фотограф'), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'Торт' } })
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toBe(SESSION_EXPIRED_TEXT)
      expect(screen.getByRole('button', { name: 'Войти' })).toBeTruthy()
    }, { timeout: 4000 })
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
  })

  it('похожие специалисты (similar.error): ErrorState с «Повторить», голого <p role="alert"> без кнопки нет', async () => {
    couple()
    const DETAIL = {
      id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
      priceFrom: { amount: 5_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, about: 'Снимаем свадьбы', phone: null,
      gallery: [], packages: [],
    }
    /* Не смерть сессии: она чистит weddingDate в сторе и переигрывает зависимости
       `similar` гонкой, не относящейся к границе FL-14 (Search.tsx/useApi.ts).
       500 доказывает ту же правку — «голый alert» стал `ErrorState` — без гонки. */
    const calls = serve(base({
      '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
      '/catalog/vendors/v1': DETAIL,
      '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
      '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
      '/catalog/vendors': withStatus(500, 'internal', 'Сбой сервера'),
    }))
    const r = renderAt('/vendor/v1', <>
      <Route path="/vendor/:id" element={<VendorDetail />} />
    </>)
    await waitFor(() => expect(text(r)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Сервер недоступен. Попробуйте позже'), { timeout: 4000 })
    const before = calls.filter(c => c.path === '/catalog/vendors').length
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await waitFor(() => expect(calls.filter(c => c.path === '/catalog/vendors').length).toBeGreaterThan(before), { timeout: 4000 })
  })
})

/* ── T2 (= F-RL-8-11): 403 — слова сервера, а не пустая выдача ─────────────── */

describe('T2 (= F-RL-8-11): Search.tsx — 403 рендерит forbiddenText и «Войти», не «пусто»', () => {
  it('/search — категории закрыты (cats.forbidden): слова сервера, не «Ничего не нашлось»', async () => {
    couple()
    serve(base({ '/catalog/categories': withStatus(403, 'consent_required', CONSENT_TEXT) }))
    const r = renderAt('/search', <>
      <Route path="/search" element={<SearchCategories />} />
      {AUTH_PROBE}
    </>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CONSENT_TEXT), { timeout: 4000 })
    expect(screen.queryByText('Ничего не нашлось'), 'закрытые права прочитаны как пустая выдача').toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
  })

  it('/search — поиск по имени закрыт (found.forbidden): слова сервера под строкой поиска', async () => {
    couple()
    serve(base({
      '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
      '/catalog/vendors': withStatus(403, 'consent_required', CONSENT_TEXT),
    }))
    const r = renderAt('/search', <>
      <Route path="/search" element={<SearchCategories />} />
      {AUTH_PROBE}
    </>)
    await waitFor(() => expect(text(r)).toContain('Фотограф'), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText(SEARCH_PLACEHOLDER), { target: { value: 'Торт' } })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CONSENT_TEXT), { timeout: 4000 })
    expect(screen.queryByText('Ничего не нашлось'), 'закрытые права прочитаны как пустая выдача').toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
  })

  it('/search/:catId — список закрыт (list.forbidden): слова сервера, не «Под фильтр никто не подходит»', async () => {
    couple()
    serve(base({
      '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
      '/catalog/vendors': withStatus(403, 'consent_required', CONSENT_TEXT),
    }))
    const r = renderAt('/search/photo', <>
      <Route path="/search/:catId" element={<VendorList />} />
      {AUTH_PROBE}
    </>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CONSENT_TEXT), { timeout: 4000 })
    expect(screen.queryByText('Под фильтр никто не подходит'), 'закрытые права прочитаны как пустая выдача').toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
  })

  it('/vendor/:id — анкета закрыта (detail.forbidden): слова сервера, не «Анкета не найдена»', async () => {
    couple()
    serve(base({
      '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
      '/catalog/vendors/v1': withStatus(403, 'consent_required', CONSENT_TEXT),
      '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
      '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
    }))
    const r = renderAt('/vendor/v1', <>
      <Route path="/vendor/:id" element={<VendorDetail />} />
      {AUTH_PROBE}
    </>)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(CONSENT_TEXT), { timeout: 4000 })
    expect(screen.queryByText('Анкета не найдена'), 'закрытые права прочитаны как «не найдена»').toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
  })
})
