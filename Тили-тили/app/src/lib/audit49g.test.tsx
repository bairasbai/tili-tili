// @vitest-environment jsdom
/*
 * FL-7 · ERR-0277 / R-277: у выхода три двери — кнопка «Выйти», отказ refresh
 * (смерть сессии) и `storage`-событие без токена в соседней вкладке — а
 * убирала устройство и память только первая. T1 = evidence\RL-4\...\sb02.test.tsx
 * (родная — SB-02, отказ refresh не снимал `tt_fav`/`tt_onboarded`/гостевой
 * токен). T2/T3 = evidence\RL-4\...\crosstab.test.tsx (F-RL-4-02 — соседняя
 * вкладка не чистила память: мозаика с телефоном подрядчика оставалась на
 * экране). Контроль — TR-1 §7 FL-7 unhappy paths: обычный анонимный 401
 * (гость без токена) не должен звать `forgetSession` и стирать черновик квиза
 * — этот путь НЕ трогаем (`client.ts` bare-401 branch), поэтому его нет среди
 * T1..T3, а есть отдельной проверкой без единого `storage`-события.
 *
 * Харнесс T1 — из sb02.test.tsx (`serve`/`base`/`open` вокруг реального `App`).
 * Харнесс T2/T3 — из crosstab.test.tsx (`StoreProvider` + `SlotDetail`/`Us`
 * напрямую, `NavProbe` для перехода между экранами, `StorageEvent`).
 * Оба харнесса читаны как evidence перед написанием (TR-1 §7 FL-7, «red
 * sb02/crosstab opened»).
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useEffect, useState } from 'react'
import App from '@/App'
import { StoreProvider } from '@/lib/store'
import { SlotDetail } from '@/pages/Wedding'
import { Us } from '@/pages/Us'
import { api, ApiError } from '@/lib/api/client'

vi.mock('@/lib/api/chats', async (orig) => ({ ...await orig<object>(), openChatSocket: () => () => undefined }))

type RoutesMap = Record<string, unknown>
type Call = { method: string; path: string; headers: Record<string, string> }
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })
const isStatus = (v: unknown): v is { __status: number; body: unknown } => typeof v === 'object' && v !== null && '__status' in v
const NO_BEARER = withStatus(401, 'unauthorized', 'Нужен заголовок Authorization: Bearer')

/** Один стаб `fetch` на весь файл: без Bearer — сразу «нужен заголовок», кроме
 * `/auth/refresh` — он по протоколу не шлёт токен вовсе (меняет refreshToken
 * телом запроса), поэтому его отвечает таблица маршрутов, как и остальные. */
function serve(routes: RoutesMap): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { method: init?.method ?? 'GET', path, headers }
    calls.push(call)
    if (!headers.authorization && path !== '/auth/refresh') return Promise.resolve(json(NO_BEARER.body, 401))
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const externalSlot = {
  id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'booked',
  deal: { id: 'd1', state: 'booked', externalName: 'Фото «Кадр»', externalPhone: '+79170000001', price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
}
const base = (over: RoutesMap = {}): RoutesMap => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/notifications': [],
  '/me/favorites': [{ id: 'v9', name: 'Прежний фотограф' }],
  '/users/me': ME,
  '/users/me/referral': { code: 'ТИЛИ-АНЯ', invited: 0, earned: { amount: 0, currency: 'RUB' } },
  '/catalog/categories': [],
  ...over,
})

/** Кнопки-пробы, чтобы уйти со слота и вернуться — без них повторный запрос
 * слота с новым (пустым) токеном не случится. */
function NavProbe() {
  const nav = useNavigate()
  return (
    <div>
      <button onClick={() => nav('/us')}>ПРОБА: на /us</button>
      <button onClick={() => nav('/wedding/slot/s1')}>ПРОБА: на слот</button>
    </div>
  )
}

/** Чужая вкладка того же браузера делает `forgetLocally()`: `clear()`, кроме
 * ключей устройства, и шлёт настоящий `storage`-событие остальным вкладкам —
 * ровно так же, как это делает браузер взаправду (не «тот же документ»,
 * TR-1 §7 FL-7 unhappy paths). */
function otherTabSignedOut(eventInit: StorageEventInit) {
  const keep = ['tt_theme', 'tt_lang', 'tt_city', 'tt_city_region'].map(k => [k, localStorage.getItem(k)] as const)
  localStorage.clear()
  for (const [k, v] of keep) if (v !== null) localStorage.setItem(k, v)
  window.dispatchEvent(new StorageEvent('storage', eventInit))
}

/** Общий сценарий T2/T3: смерть токена видна в соседней вкладке, различается
 * только форма `storage`-события. */
async function crosstabLogoutHidesVendorMemory(eventInit: StorageEventInit) {
  signedIn()
  serve(base({ '/weddings/w1/slots': [externalSlot] }))
  const r = render(
    <MemoryRouter initialEntries={['/wedding/slot/s1']}>
      <StoreProvider>
        <NavProbe />
        <Routes>
          <Route path="/wedding/slot/:id" element={<SlotDetail />} />
          <Route path="/us" element={<Us />} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  await waitFor(() => expect(text(r)).toContain('+79170000001'), { timeout: 4000 })

  act(() => { otherTabSignedOut(eventInit) })
  expect(localStorage.getItem('tt_auth')).toBeNull()

  fireEvent.click(screen.getByText('ПРОБА: на /us'))
  await waitFor(() => expect(text(r)).not.toContain('+79170000001'))
  fireEvent.click(screen.getByText('ПРОБА: на слот'))
  await new Promise(resolve => setTimeout(resolve, 150))

  expect(text(r), 'имя подрядчика осталось в памяти вкладки после выхода в соседней').not.toContain('Фото «Кадр»')
  expect(text(r), 'телефон подрядчика остался в памяти вкладки после выхода в соседней').not.toContain('+79170000001')
}

/** Контроль (TR-1 §7 FL-7 unhappy paths): обычный анонимный 401 (гость без
 * токена, не «смерть сессии») не должен звать `forgetSession` — нет ни
 * одного `storage`-события в этом сценарии. */
function GuestProbe() {
  const [result, setResult] = useState('')
  useEffect(() => {
    api.get('/notifications').catch(e => setResult(e instanceof ApiError ? e.code : 'other'))
  }, [])
  return <div data-testid="probe">{result}</div>
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FL-7 · ERR-0277/R-277: смерть сессии и выход в соседней вкладке чистят устройство как «Выйти»', () => {
  it('T1 (=sb02): отказ refresh снимает tt_fav/tt_onboarded/гостевой токен — как кнопка «Выйти»; tt_theme/tt_lang/tt_city остаются', async () => {
    signedIn()
    localStorage.setItem('tt_fav', JSON.stringify(['v9']))
    localStorage.setItem('tt_guest_token', 'g-old')
    localStorage.setItem('tt_theme', 'dark')
    localStorage.setItem('tt_lang', 'ru')
    localStorage.setItem('tt_city', 'Казань')
    serve(base({
      '/weddings/w1/guests': withStatus(401, 'token_expired', 'Токен истёк'),
      '/auth/refresh': withStatus(401, 'refresh_expired', 'Сессия истекла'),
    }))
    await open('/wedding/guests', 'Войдите')
    await waitFor(() => expect(localStorage.getItem('tt_wedding_id')).toBeNull(), { timeout: 4000 })
    expect(localStorage.getItem('tt_auth')).toBeNull()
    expect(localStorage.getItem('tt_fav'), 'tt_fav пережил смерть сессии').toBeNull()
    expect(localStorage.getItem('tt_onboarded'), 'tt_onboarded пережил смерть сессии').toBeNull()
    expect(localStorage.getItem('tt_guest_token'), 'гостевой токен пережил смерть сессии').toBeNull()
    expect(localStorage.getItem('tt_theme'), 'tt_theme — свойство устройства, должно остаться').toBe('dark')
    expect(localStorage.getItem('tt_lang'), 'tt_lang — свойство устройства, должно остаться').toBe('ru')
    expect(localStorage.getItem('tt_city'), 'tt_city — свойство устройства, должно остаться').toBe('Казань')
  })

  it('T2 (=crosstab, key=null): выход в соседней вкладке («Выйти» там) — слот перестаёт показывать имя и телефон подрядчика из памяти', () =>
    crosstabLogoutHidesVendorMemory({ key: null }))

  it('T3 (=crosstab, key=tt_auth/newValue=null): точечное снятие токена (смерть сессии в соседней вкладке) даёт тот же результат', () =>
    crosstabLogoutHidesVendorMemory({ key: 'tt_auth', newValue: null }))

  it('контроль: обычный анонимный 401 у гостя без токена не трогает черновик квиза (нет storage-события — не «смерть сессии»)', async () => {
    localStorage.clear()
    const draft = JSON.stringify({ date: null, guests: '50-100', budget: null, format: null, style: null, planner: null, booked: [] })
    localStorage.setItem('tt_quiz', draft)
    serve(base())
    render(<StoreProvider><GuestProbe /></StoreProvider>)
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('unauthorized'))
    expect(localStorage.getItem('tt_quiz'), 'обычный анонимный 401 не должен звать forgetSession и стирать черновик квиза гостя').toBe(draft)
  })
})
