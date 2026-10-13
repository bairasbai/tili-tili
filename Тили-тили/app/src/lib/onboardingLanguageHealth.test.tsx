// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import App from '@/App'
import { reloadToRoot, setI18nLang } from '@/lib/i18n'

// Observe the real Store-only transition independently of deliberate document navigation.
vi.mock('@/lib/i18n', async original => ({
  ...await original<typeof import('@/lib/i18n')>(),
  reloadToRoot: vi.fn(),
}))

let setStoreLanguage: ((language: 'ru' | 'en') => void) | undefined
// Capture the real provider's setter without replacing its state, effects or route.
vi.mock('@/lib/store', async original => {
  const actual = await original<typeof import('@/lib/store')>()
  function CaptureSetter() { setStoreLanguage = actual.useStore().setLang; return null }
  return { ...actual, StoreProvider: ({ children }: { children: import('react').ReactNode }) =>
    <actual.StoreProvider>{children}<CaptureSetter /></actual.StoreProvider> }
})

const healthReplies: Array<(response: Response) => void> = []

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  setI18nLang('ru')
  setStoreLanguage = undefined
  vi.mocked(reloadToRoot).mockClear()
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const reply of healthReplies.splice(0)) {
      reply(new Response(JSON.stringify({ status: 'ok' }), {
        headers: { 'content-type': 'application/json' },
      }))
    }
    await Promise.resolve()
  })
  vi.unstubAllGlobals()
  setI18nLang('ru')
})

it('language change resets the keyed scene without restarting pending shell health', async () => {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const path = new URL(String(input), location.origin).pathname
    calls.push(path)
    if (path !== '/api/health') throw new Error('Unexpected anonymous shell request')
    return new Promise<Response>(resolve => { healthReplies.push(resolve) })
  }))
  render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  expect(screen.getByRole('heading', { name: 'Все специалисты' })).toBeTruthy()
  expect(calls).toEqual(['/api/health'])

  fireEvent.click(screen.getByRole('button', { name: /Далее/ }))
  expect(screen.getByRole('heading', { name: 'Один день' })).toBeTruthy()
  expect(setStoreLanguage).toBeTypeOf('function')
  act(() => { setStoreLanguage!('en') })

  expect(reloadToRoot).not.toHaveBeenCalled()
  expect(localStorage.getItem('tt_lang')).toBe('en')
  expect(document.documentElement.lang).toBe('en')
  expect(screen.getByRole('button', { name: 'RU' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'All vendors' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'One day' })).toBeNull()
  expect(calls, 'one pending health request survives the language state update').toEqual(['/api/health'])
})
