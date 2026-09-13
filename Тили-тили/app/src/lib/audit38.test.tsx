/*
 * Фича 011 «Радиус поиска» — фронт (блокер №16).
 *
 * Сервер и раньше искал в ста километрах от города молча; теперь радиус виден и
 * меняется. Проверяется то, что ушло на сервер и что видно: запрос списка несёт
 * `radiusKm=100` по умолчанию; «только город» → `radiusKm=0`, «до 300 км» →
 * `radiusKm=300` (новая первая страница); подпись под заголовком называет радиус
 * запроса; карточка анкеты из другого города — «· Бирск · 80 км», у своего города
 * (0) и без координат (null) — ничего. Красный без фикса: на HEAD запрос шёл без
 * `radiusKm`, переключателя не было, километров на карточке — тоже.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string }

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = full.split('?')[0] ?? ''
    const call: Call = { method: init?.method ?? 'GET', path, url: full }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    return Promise.resolve(json(reply))
  }))
  return calls
}

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const BASE: Routes = {
  '/weddings': [WEDDING],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null },
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
}
const vendor = (over: Record<string, unknown> = {}) => ({
  id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
  priceFrom: { amount: 5_000_000, currency: 'RUB' }, rating: null as number | null, reviewsCount: 0, distanceKm: 0 as number | null,
  ...over,
})
const radiusOf = (c: Call) => new URL('http://x' + c.url).searchParams.get('radiusKm')
const listCalls = (calls: Call[]) => calls.filter(c => c.path === '/catalog/vendors')

describe('фича 011: радиус поиска в каталоге', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('по умолчанию запрос несёт radiusKm=100, подпись — «до 100 км»; карточка из Бирска — «· Бирск · 80 км», своя и без координат — без километров', async () => {
    const calls = serve({
      ...BASE,
      '/catalog/vendors': {
        items: [
          vendor(),
          vendor({ id: 'v2', name: 'Фото Бирск', city: 'Бирск', distanceKm: 80 }),
          vendor({ id: 'v3', name: 'Фото Агидель', city: 'Агидель', distanceKm: null }),
        ],
        nextCursor: null,
      },
    })
    const r = await open('/search/photo', 'Фото Бирск')
    const text = r.container.textContent ?? ''
    expect(listCalls(calls).length).toBeGreaterThanOrEqual(1)
    expect(radiusOf(listCalls(calls)[0]!), 'радиус должен уходить на сервер явно').toBe('100')
    expect(text).toContain('3 рядом · до 100 км')
    expect(text, 'анкета из другого города — с городом и километрами').toContain('Бирск · 80 км')
    expect(text).not.toContain('Уфа · 0 км')
    expect(text).not.toContain('Агидель ·')
  })

  it('«только город» → новый запрос с radiusKm=0 и подпись «только город»; «до 300 км» → radiusKm=300', async () => {
    const calls = serve({
      ...BASE,
      '/catalog/vendors': (c: Call) => radiusOf(c) === '0'
        ? { items: [vendor()], nextCursor: null }
        : { items: [vendor(), vendor({ id: 'v2', name: 'Фото Стерлитамак', city: 'Стерлитамак', distanceKm: 123 })], nextCursor: null },
    })
    const r = await open('/search/photo', 'Фотостудия Свет')
    const select = screen.getByLabelText('Радиус поиска') as HTMLSelectElement
    expect(select.value).toBe('100')

    fireEvent.change(select, { target: { value: '0' } })
    await waitFor(() => expect(listCalls(calls).some(c => radiusOf(c) === '0')).toBe(true), { timeout: 4000 })
    await waitFor(() => expect(r.container.textContent ?? '').toContain('1 рядом · только город'), { timeout: 4000 })
    expect(r.container.textContent ?? '').not.toContain('Стерлитамак')

    fireEvent.change(select, { target: { value: '300' } })
    await waitFor(() => expect(listCalls(calls).some(c => radiusOf(c) === '300')).toBe(true), { timeout: 4000 })
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Стерлитамак · 123 км'), { timeout: 4000 })
    expect(r.container.textContent ?? '').toContain('до 300 км')
  })
})
