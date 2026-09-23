// @vitest-environment jsdom
/*
 * FL-5 · ERR-0275 / R-275 (ревью-016, RUN-NONCE ffed980e5bceaf1d), D-волна 2 (ARB-1 §C2, W2′).
 *
 * F-RL-8-01 (S2, CONFIRMED, TR-1 §3.2 row 3 / §7 FL-5): корень `VendorLead`
 * (`VendorExtras.tsx:177`) держал класс `min-h-dvh flex flex-col pb-10`. На
 * маршруте `/vendor-app/leads/:id` (`vendorTab`, `App.tsx:144/216`) снизу
 * стоит панель кабинета подрядчика — `fixed bottom-0`, 56px + вырез экрана
 * (`index.css`), а `pb-10` (40px) её не перекрывает: поле «Написать паре…»
 * и кнопка отправки ответа лежали под таб-баром на каждом телефоне (тот же
 * класс ошибки, что ERR-0268 — панели действий анкеты/договора).
 *
 * Адаптировано из `evidence\RL-8\rl8-repro.test.tsx` (тест F-RL-8-01, красный
 * на HEAD e67ffcf). Харнесс (`serve`/`open`/`signedIn`/`vendorRoutes`) — из
 * `audit49c.test.tsx` / `rl8-repro.test.tsx`, которые сами берут его из
 * `audit48.test.tsx`.
 *
 * T1-T2 — обязательные приёмочные тесты TR-1 §7 FL-5 (исходный код корня;
 * рендер заявки со статусом `new`, поле ответа и класс `pb-28` у корня).
 */
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, afterEach, vi } from 'vitest'
import App from '@/App'
import { projectFile } from '@/test/projectFiles'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body }
    calls.push(call)
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
}
const ME = { id: 'u1', name: 'Елена', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const PROFILE = {
  id: 'v1', name: 'Елена', categoryId: 'photo', city: 'Уфа', cityRegion: 'Башкортостан', about: 'Снимаю свадьбы',
  phone: null, priceFrom: null, published: true, blocked: false, verified: false, rating: null,
  packages: [], gallery: [], media: [], completeness: { pct: 100, missing: [] },
}
const LEAD = { id: 'l1', coupleName: 'Аня и Боря', weddingDate: '2027-06-14', city: 'Уфа', status: 'new', message: 'Здравствуйте! Ищем фотографа на июнь.', holdUntil: null, chatId: null }
const vendorRoutes = (over: Routes = {}): Routes => ({
  '/weddings': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
  '/chats': [],
  '/vendor/profile': PROFILE,
  '/vendor/leads': [LEAD],
  '/vendor/reviews': [],
  '/vendor/updates': [],
  '/vendor/calendar': [],
  ...over,
})

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('FL-5 · поле ответа на заявку не лежит под таб-баром кабинета (F-RL-8-01)', () => {
  it('T1: исходники — у корня VendorLead нет pb-10, есть pb-28', () => {
    const src = projectFile('src/pages/VendorExtras.tsx')
    expect(src, 'VendorExtras.tsx: остался корень "min-h-dvh flex flex-col pb-10" — поле ответа ляжет под таб-бар кабинета')
      .not.toMatch(/min-h-dvh flex flex-col pb-10"/)
    expect(src, 'VendorExtras.tsx: у корня VendorLead нет "min-h-dvh flex flex-col pb-28" — таб-бар кабинета перекроет поле ответа')
      .toMatch(/min-h-dvh flex flex-col pb-28"/)
  })

  it('T2: /vendor-app/leads/l1 (статус new) — поле ответа отрисовано, у корня экрана класс pb-28, не pb-10', async () => {
    signedIn()
    serve(vendorRoutes())
    const r = await open('/vendor-app/leads/l1', 'Аня и Боря')
    const composer = r.container.querySelector('input[placeholder="Написать паре…"]')
    expect(composer, 'поле ответа не отрисовалось для заявки со статусом new').toBeTruthy()
    const root = r.container.querySelector('.min-h-dvh')
    expect(root, 'корневой элемент экрана заявки (.min-h-dvh) не найден').toBeTruthy()
    expect(root!.className, 'корень экрана заявки держит pb-10 — поле ответа ляжет под таб-бар кабинета').not.toMatch(/\bpb-10\b/)
    expect(root!.className, 'у корня экрана заявки нет pb-28 — таб-бар кабинета перекроет поле ответа').toMatch(/\bpb-28\b/)
  })
})
