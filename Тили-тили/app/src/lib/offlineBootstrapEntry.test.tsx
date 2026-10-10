// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const entry = vi.hoisted(() => ({ render: vi.fn(), beforeRender: vi.fn() }))
vi.mock('react-dom/client', () => ({ createRoot: () => {
  entry.beforeRender()
  return { render: entry.render }
} }))
vi.mock('../App.tsx', () => ({ default: () => null }))
vi.mock('./serviceWorkerUpdate', () => ({ observeController: vi.fn(), observeRegistration: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  localStorage.clear(); sessionStorage.clear()
  entry.render.mockClear(); entry.beforeRender.mockReset()
  document.body.innerHTML = '<div id="root"></div>'
  window.history.replaceState(null, '', '/invite')
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.innerHTML = '' })

it('removes the old unscoped private DayX copy before React boots offline on another route', async () => {
  localStorage.setItem('tt_dayx_offline', JSON.stringify({ weddingId: 'former-wedding', savedAt: '2026-09-20T10:00:00Z',
    timeline: [{ name: 'Former private programme', startsAt: '2027-06-14T11:00:00Z' }],
    team: [{ phone: '+79990000099', vendor: 'Former private contact' }] }))
  localStorage.setItem('tt_lang', 'en'); localStorage.setItem('tt_theme', 'dark')
  localStorage.setItem('unrelated-data', 'keep')
  entry.beforeRender.mockImplementation(() => {
    expect(navigator.onLine).toBe(false)
    expect(window.location.pathname).toBe('/invite')
    expect(localStorage.getItem('tt_dayx_offline')).toBeNull()
    expect(localStorage.getItem('tt_lang')).toBe('en')
    expect(localStorage.getItem('tt_theme')).toBe('dark')
    expect(localStorage.getItem('unrelated-data')).toBe('keep')
  })
  await import('../main')
  expect(entry.beforeRender).toHaveBeenCalledOnce()
  expect(entry.render).toHaveBeenCalledOnce()
})
