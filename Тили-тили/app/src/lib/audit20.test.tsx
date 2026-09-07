// @vitest-environment jsdom
/*
 * Аудит, блок 8: живой канал и уведомления.
 *
 *  — ссылки уведомлений сервера переводятся в маршруты приложения по роли:
 *    `/wedding` и `/vendor-app` раньше вели в никуда, подрядчика по
 *    `/deal/{id}` вели на экран сделки пары;
 *  — канал чата после 4401 (истёк токен) обновляет токен запросом, а не
 *    переподключается десять раз с тем же истёкшим;
 *  — push на устройстве: клиентская половина (подписка → сервер) существует
 *    и честно показывает отказ сервера без ключей.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { notificationRoute } from '@/lib/api/notifications'
import { openChatSocket } from '@/lib/api/chats'
import App from '@/App'

describe('ссылки уведомлений → маршруты приложения', () => {
  it('пара: сделка, гости, чек-лист, день X, свадьба, чат', () => {
    expect(notificationRoute('/deal/d1')).toBe('/deal/d1')
    expect(notificationRoute('/guests')).toBe('/wedding/guests')
    expect(notificationRoute('/checklist')).toBe('/wedding/checklist')
    expect(notificationRoute('/dayx')).toBe('/dayx')
    expect(notificationRoute('/wedding')).toBe('/wedding')
    expect(notificationRoute('/chats/c1')).toBe('/us/chats/c1')
    expect(notificationRoute('/vendor-app')).toBe('/vendor-app')
  })
  it('подрядчик: сделки списком в кабинете, чужие экраны пары — никуда', () => {
    expect(notificationRoute('/deal/d1', { vendor: true })).toBe('/vendor-app/deals')
    expect(notificationRoute('/wedding', { vendor: true })).toBe('/vendor-app')
    expect(notificationRoute('/dayx', { vendor: true })).toBe('/vendor-app')
    expect(notificationRoute('/guests', { vendor: true })).toBeNull()
    expect(notificationRoute('/chats/c1', { vendor: true })).toBe('/us/chats/c1')
  })
  it('незнакомая ссылка — никуда', () => {
    expect(notificationRoute('/nowhere')).toBeNull()
    expect(notificationRoute(null)).toBeNull()
  })
})

class FakeSocket {
  static last: FakeSocket | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  url: string
  constructor(url: string) { this.url = url; FakeSocket.last = this }
  close() { /* закрыт клиентом */ }
}

describe('живой канал чата', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('4401 от сервера → запрос, обновляющий токен, а не тихий повтор с тем же', async () => {
    const close = openChatSocket('c1', () => undefined)
    expect(FakeSocket.last?.url).toContain('/chats/c1/ws?token=a')
    FakeSocket.last!.onclose!({ code: 4401 } as CloseEvent)
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('/users/me'))).toBe(true))
    close()
  })

  it('обычный обрыв токен не трогает', async () => {
    const close = openChatSocket('c1', () => undefined)
    FakeSocket.last!.onclose!({ code: 1006 } as CloseEvent)
    await new Promise(r => setTimeout(r, 20))
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(c => String(c[0]).includes('/users/me'))).toBe(false)
    close()
  })
})

/* Сеть по таблице; значение с `status` — ответ с этим кодом. */
type Reply = unknown | { status: number; body: unknown }
function serve(routes: Record<string, Reply>) {
  const calls: { method: string; path: string; body: unknown }[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0] ?? ''
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = null }
    calls.push({ method: init?.method ?? 'GET', path, body })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const r = routes[path] as { status?: number; body?: unknown }
    if (r && typeof r === 'object' && 'status' in r && typeof r.status === 'number') return Promise.resolve(json(r.body, r.status))
    return Promise.resolve(json(routes[path]))
  }))
  return calls
}

function fakeBrowserPush(subscribed: boolean) {
  const subscription = {
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p256', auth: 'auth' } }),
    unsubscribe: async () => true,
  }
  const pushManager = {
    getSubscription: async () => (subscribed ? subscription : null),
    subscribe: async () => subscription,
  }
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve({ pushManager }) }, configurable: true })
  vi.stubGlobal('PushManager', function PushManager() { /* признак поддержки */ })
  vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' })
}

const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null }

describe('push на устройстве', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BAbc123_-key')
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    Reflect.deleteProperty(navigator, 'serviceWorker')
  })

  it('включение подписывает браузер и регистрирует подписку на сервере', async () => {
    fakeBrowserPush(false)
    const calls = serve({ '/users/me': ME, '/users/me/sessions': [], '/weddings': [], '/me/favorites': [], '/notifications': [], '/users/me/push-subscriptions': {} })
    render(<MemoryRouter initialEntries={['/settings']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Push на этом устройстве выключен')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Push на этом устройстве'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/users/me/push-subscriptions')).toBe(true))
    expect(calls.find(c => c.method === 'POST' && c.path === '/users/me/push-subscriptions')!.body).toEqual({
      endpoint: 'https://push.example/abc', keys: { p256dh: 'p256', auth: 'auth' },
    })
    await waitFor(() => expect(screen.getByText('Push включён на этом устройстве')).toBeTruthy())
  })

  it('сервер без ключей VAPID (501) — его текст на экране, подписка не считается включённой', async () => {
    fakeBrowserPush(false)
    serve({
      '/users/me': ME, '/users/me/sessions': [], '/weddings': [], '/me/favorites': [], '/notifications': [],
      '/users/me/push-subscriptions': { status: 501, body: { error: { code: 'push_not_configured', message: 'Web Push ещё не настроен: нет ключей VAPID. Уведомления приходят в приложении.' } } },
    })
    render(<MemoryRouter initialEntries={['/settings']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Push на этом устройстве выключен')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Push на этом устройстве'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Web Push ещё не настроен'))
    expect(screen.queryByText('Push включён на этом устройстве')).toBeNull()
  })

  it('без ключа в сборке тумблера нет — есть честная строка', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '')
    fakeBrowserPush(false)
    serve({ '/users/me': ME, '/users/me/sessions': [], '/weddings': [], '/me/favorites': [], '/notifications': [] })
    render(<MemoryRouter initialEntries={['/settings']}><App /></MemoryRouter>)
    await waitFor(() => expect(screen.getByText('Push появится, когда будут подключены ключи Web Push — уведомления пока в приложении')).toBeTruthy(), { timeout: 4000 })
    expect(screen.queryByLabelText('Push на этом устройстве')).toBeNull()
  })
})
