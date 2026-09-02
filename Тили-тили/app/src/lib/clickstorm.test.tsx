// @vitest-environment jsdom
/* Клик-шторм: на каждом экране кликаем ВСЕ кнопки по очереди.
 * Любое исключение в обработчике = найденная дыра. */
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

const ROUTES = [
  '/', '/quiz', '/invite', '/auth', '/join/ДРУГ-7F3K',
  '/home', '/notifications', '/settings', '/support',
  '/search', '/search/photo', '/vendor/v1',
  '/wedding', '/wedding/slot/s1', '/wedding/budget', '/wedding/checklist',
  '/wedding/timeline', '/wedding/guests', '/wedding/documents', '/wedding/documents/new',
  '/wedding/invites', '/wedding/seating', '/wedding/wishlist', '/gifts', '/wedding/album',
  '/wedding/logistics', '/wedding/catering', '/wedding/planb',
  '/us', '/us/chats', '/us/chats/ch1', '/us/team',
  '/deal', '/tools/alcohol', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/notes', '/inspiration', '/venues',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
]

describe('клик-шторм: все кнопки всех экранов нажимаются без падения', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    // браузерные API, которых нет в jsdom — подменяем, чтобы тестить логику, а не среду
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    Object.defineProperty(window, 'print', { value: vi.fn(), configurable: true })
    Object.defineProperty(window, 'open', { value: vi.fn(() => null), configurable: true })
  })
  afterEach(cleanup)

  for (const r of ROUTES) {
    it(`клики на ${r}`, () => {
      const errors: string[] = []
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0])) })
      const { container, unmount } = render(<MemoryRouter initialEntries={[r]}><App /></MemoryRouter>)
      // кликаем кнопки волнами: каждый клик может менять DOM и открывать новые кнопки
      for (let wave = 0; wave < 4; wave++) {
        const btns = Array.from(container.querySelectorAll('button:not([disabled])'))
        for (const b of btns) {
          try {
            fireEvent.click(b)
          } catch (e) {
            errors.push(`${r} кнопка «${(b.textContent ?? '').slice(0, 40)}»: ${String(e)}`)
          }
        }
      }
      errSpy.mockRestore()
      // реальные исключения React логируются как "The above error occurred" — отфильтруем шум
      const fatal = errors.filter(e => /error occurred|is not a function|Cannot read|undefined is not/i.test(e))
      expect(container.innerHTML.length).toBeGreaterThan(50)
      unmount()
      expect(fatal).toEqual([])
    })
  }
})
