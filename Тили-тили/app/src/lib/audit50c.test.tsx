// @vitest-environment jsdom
/*
 * F-RL-8-10 (хвост ревью 016) — подрядчик на `/notifications` получал нижнюю
 * навигацию ПАРЫ: «Свадьба» вела в состояние без свадьбы, «Чаты» — в чужие
 * чаты пары вместо `/vendor-app/chats`. Обрамление выбирается по пути
 * (`App.tsx`, `vendorTab`), а двойника `/vendor-app/notifications` не было —
 * в отличие от `/vendor-app/chats` и `/vendor-app/settings`.
 *
 * Закрыто двойником маршрута: страница та же, путь — кабинетный, и навигация
 * встаёт правильная. Кнопка «Открыть уведомления» в кабинете ведёт туда же.
 *
 * Навигация кабинета отличается от навигации пары подписью
 * `aria-label="Навигация кабинета"` — по ней и проверяем.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '@/App'
import { StoreProvider } from '@/lib/store'

type Routes = Record<string, unknown>

function serve(routes: Routes) {
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const path = decodeURIComponent(String(input).replace(/^\/api/, '').split('?')[0] ?? '')
      if (!(path in routes)) {
        return Promise.resolve(json({ error: { code: 'not_found', message: path } }, 404))
      }
      return Promise.resolve(json(routes[path]))
    }),
  )
}

const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

const VENDOR_PROFILE = {
  id: 'v1',
  name: 'Студия «Пион»',
  categoryId: 'photo',
  city: 'Уфа',
  verified: false,
  hasVideo: false,
  priceFrom: { amount: 4_000_000, currency: 'RUB' },
  rating: null,
  reviewsCount: 0,
  packages: [],
}

async function open(route: string) {
  const r = render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        <App />
      </StoreProvider>
    </MemoryRouter>,
  )
  await waitFor(
    () => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(),
    { timeout: 4000 },
  )
  return r
}

const cabinetNav = (r: { container: HTMLElement }) =>
  r.container.querySelector('nav[aria-label="Навигация кабинета"]')
const anyNav = (r: { container: HTMLElement }) => r.container.querySelector('nav.glass-tab')

describe('F-RL-8-10: уведомления подрядчика — с навигацией кабинета, а не пары', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('на /vendor-app/notifications стоит навигация кабинета', async () => {
    signedIn()
    serve({ '/notifications': [], '/vendor/profile': VENDOR_PROFILE, '/chats': [], '/weddings': [] })
    const r = await open('/vendor-app/notifications')
    await waitFor(() => expect(cabinetNav(r), 'у подрядчика нижняя навигация пары').not.toBeNull())
  })

  it('на /notifications у пары навигация пары и остаётся — кабинетной там нет', async () => {
    signedIn()
    serve({ '/notifications': [], '/chats': [], '/weddings': [] })
    const r = await open('/notifications')
    await waitFor(() => expect(anyNav(r)).not.toBeNull())
    expect(cabinetNav(r)).toBeNull()
  })
})
