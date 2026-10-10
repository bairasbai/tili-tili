// @vitest-environment jsdom
import { StrictMode, useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorTabBar } from '@/components/chrome'
import { setI18nLang, t } from './i18n'

// Only the language context is isolated. VendorTabBar, useApi, getChats and
// the authenticated API client are real; fetch records the attempted HTTP.
const language = vi.hoisted(() => ({ lang: 'ru' }))
vi.mock('@/lib/store', () => ({ useStore: () => language }))

type Call = { path: string; method: string; authorization: string | null }
const chat = (unread: number) => ({ id: 'chat-own', kind: 'vendor', title: 'Own wedding', unread })
function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>(r => { resolve = r })
  return { promise, resolve }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
function serve(reply: () => Response | Promise<Response> = () => json([chat(2), { ...chat(3), id: 'chat-second' }])) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
    return Promise.resolve().then(reply)
  }))
  return calls
}
function online(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value })
}
const drain = () => act(async () => { await Promise.resolve() })
const bar = () => screen.getByLabelText(t('Навигация кабинета'))
const badge = () => bar().querySelector('.tabular')?.textContent ?? null
let navigate: ReturnType<typeof useNavigate>
function LocationProbe() {
  const nav = useNavigate(), loc = useLocation()
  useEffect(() => { navigate = nav }, [nav])
  return <output data-testid="vendor-path">{loc.pathname}</output>
}
function open(strict = false) {
  const tree = <MemoryRouter initialEntries={['/vendor-app/programs']}><VendorTabBar /><LocationProbe /></MemoryRouter>
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}
async function move(path: string) {
  await act(async () => { await navigate(path) })
  await drain()
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'vendor-access', refreshToken: 'vendor-refresh' }))
  language.lang = 'ru'; setI18nLang('ru'); online(true)
})
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks()
  delete (navigator as unknown as Record<string, unknown>).onLine
  localStorage.clear(); setI18nLang('ru')
})

describe('VendorTabBar: live offline HTTP boundary and fresh reconnect badge', () => {
  it('cold offline mount sends no GET /chats and asserts no unread count', async () => {
    online(false)
    const calls = serve(); open(); await drain()
    expect(calls, 'cold offline VendorTabBar attempted HTTP').toEqual([])
    expect(badge()).toBeNull()
    expect(localStorage.getItem('tt_auth')).toContain('vendor-access')
  })

  it('cold offline reconnect fetches one real answer with the current bearer', async () => {
    online(false)
    const calls = serve(); open(); await drain()
    expect(calls).toHaveLength(0)
    online(true); fireEvent(window, new Event('online'))
    await waitFor(() => expect(badge()).toBe('5'))
    await drain()
    expect(calls).toEqual([{ path: '/api/chats', method: 'GET', authorization: 'Bearer vendor-access' }])
  })

  it('online mount is one read, and one path change refreshes without blanking the shown badge', async () => {
    const later = deferred()
    let reads = 0
    const calls = serve(() => ++reads === 1 ? json([chat(4)]) : later.promise)
    open(); await waitFor(() => expect(badge()).toBe('4'))
    expect(calls).toHaveLength(1)
    await move('/vendor-app/settings')
    expect(calls).toHaveLength(2)
    expect(badge()).toBe('4')
    later.resolve(json([chat(7)]))
    await waitFor(() => expect(badge()).toBe('7'))
    await move('/vendor-app/settings')
    expect(calls).toHaveLength(2)
  })

  it('a path change sees the live offline state even before the offline event', async () => {
    const calls = serve(); open(); await waitFor(() => expect(badge()).toBe('5'))
    online(false)
    await move('/vendor-app/deals')
    expect(calls).toHaveLength(1)
    expect(screen.getByTestId('vendor-path').textContent).toBe('/vendor-app/deals')
  })

  it('offline navigation stays usable, and one reconnect refreshes the badge without a duplicate read', async () => {
    let unread = 2
    const calls = serve(() => json([chat(unread)]))
    open(); await waitFor(() => expect(badge()).toBe('2'))
    online(false); fireEvent(window, new Event('offline'))
    fireEvent.click(within(bar()).getByText('Настройки'))
    await drain()
    expect(screen.getByTestId('vendor-path').textContent).toBe('/vendor-app/settings')
    expect(calls).toHaveLength(1)
    unread = 9
    online(true); fireEvent(window, new Event('online'))
    await waitFor(() => expect(badge()).toBe('9'))
    await drain()
    expect(calls).toHaveLength(2)
  })

  it('a queued reconnect reload rechecks live connectivity before starting HTTP', async () => {
    const calls = serve(); open(); await waitFor(() => expect(badge()).toBe('5'))
    online(false); fireEvent(window, new Event('offline'))
    await act(async () => {
      online(true); window.dispatchEvent(new Event('online'))
      online(false)
    })
    await drain()
    expect(calls).toHaveLength(1)
    expect(badge(), 'local network refusal must not become a successful empty server list').toBeNull()
    online(true); fireEvent(window, new Event('online'))
    await waitFor(() => expect(badge()).toBe('5'))
    expect(calls).toHaveLength(2)
  })

  it('an online event with a still-offline navigator cannot initiate HTTP', async () => {
    online(false)
    const calls = serve(); open(); await drain()
    fireEvent(window, new Event('online')); await drain()
    expect(calls).toHaveLength(0)
    expect(badge()).toBeNull()
  })

  it('a real online HTTP403 still removes the unread claim instead of inventing a successful count', async () => {
    let denied = false
    const calls = serve(() => denied ? json({ error: { code: 'forbidden', message: 'No chat access' } }, 403) : json([chat(4)]))
    open(); await waitFor(() => expect(badge()).toBe('4'))
    denied = true; await move('/vendor-app/deals')
    await waitFor(() => expect(badge()).toBeNull())
    expect(calls).toHaveLength(2)
  })

  it('an actual network rejection is retryable on reconnect with a fresh server badge', async () => {
    let failed = true
    const calls = serve(() => {
      if (failed) return Promise.reject(new TypeError('Failed to fetch'))
      return json([chat(6)])
    })
    open(); await drain(); expect(badge()).toBeNull()
    online(false); fireEvent(window, new Event('offline'))
    failed = false; online(true); fireEvent(window, new Event('online'))
    await waitFor(() => expect(badge()).toBe('6'))
    expect(calls).toHaveLength(2)
  })

  it('StrictMode preserves its initial hook reads and adds only one read per changed path', async () => {
    const calls = serve(); open(true); await waitFor(() => expect(badge()).toBe('5'))
    expect(calls).toHaveLength(2)
    await move('/vendor-app/deals')
    expect(calls).toHaveLength(3)
    await move('/vendor-app/deals')
    expect(calls).toHaveLength(3)
  })

  it('unmount removes the online/offline listeners and never initiates a later read', async () => {
    const added = vi.spyOn(window, 'addEventListener'), removed = vi.spyOn(window, 'removeEventListener')
    const calls = serve(), view = open(true)
    await waitFor(() => expect(badge()).toBe('5'))
    const before = calls.length
    view.unmount()
    const connections = added.mock.calls.filter(([name]) => name === 'online' || name === 'offline')
    expect(connections).toHaveLength(4)
    for (const [name, listener] of connections) {
      expect(removed.mock.calls.some(([removedName, removedListener]) => removedName === name && removedListener === listener)).toBe(true)
    }
    online(false); fireEvent(window, new Event('offline'))
    online(true); fireEvent(window, new Event('online')); await drain()
    expect(calls).toHaveLength(before)
  })

  it('English labels, active navigation and the server zero-unread answer retain existing behavior', async () => {
    language.lang = 'en'; setI18nLang('en')
    const calls = serve(() => json([chat(0)])); open(); await drain()
    for (const ru of ['Кабинет', 'Сделки', 'Чаты', 'Настройки']) expect(bar().textContent).not.toContain(ru)
    expect(badge()).toBeNull()
    const settings = within(bar()).getByText('Settings')
    fireEvent.click(settings); await drain()
    expect(screen.getByTestId('vendor-path').textContent).toBe('/vendor-app/settings')
    expect(settings.closest('button')?.className).toContain('text-[var(--rose-deep)]')
    expect(calls).toHaveLength(2)
  })
})
