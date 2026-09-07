// @vitest-environment jsdom
/* Клик-шторм: на каждом экране кликаем ВСЕ кнопки по очереди.
 * Любое исключение в обработчике = найденная дыра. */
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/* Гостевая страница живёт по токену: без него на ней нет ни одной кнопки, и
   шторм молча проверял бы пустой экран. Мок отдаёт минимальное приглашение —
   с вариантом меню, маршрутом и отелем, чтобы кликнуть было по чему. */
vi.mock('@/lib/api/guest', async (orig) => ({
  ...await orig<object>(),
  getRsvp: async () => ({
    guestName: 'Ольга',
    status: 'pending',
    wedding: { title: 'Алина & Тимур', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 },
  }),
  sendRsvp: async () => undefined,
  getGuestMenu: async () => ({ question: 'Что на горячее?', options: [{ id: 'o1', name: 'Мясо' }], chosenOptionId: null }),
  getGuestShuttle: async () => ({ myBusId: null, routes: [{ id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 45, taken: 0 }] }),
  getGuestHotels: async () => [{ id: 'h1', name: 'Хилтон', rooms: 10, booked: 0, price: { amount: 450000, currency: 'RUB' } }],
  voteMenu: async () => undefined,
  joinShuttle: async () => undefined,
  bookHotelRoom: async () => undefined,
}))

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
  '/deal/d1', '/tools/alcohol', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/notes', '/inspiration', '/venues',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
  '/admin', '/admin/moderation', '/admin/moderation/v1', '/admin/complaints', '/admin/categories', '/admin/wedding',
]

/* Экраны приезжают отдельными чанками. Без ожидания шторм кликал бы по пустой
 * заглушке Suspense и молча ничего не проверял — в том числе после переходов,
 * которые сами вызваны кликом. */
const settled = (container: HTMLElement) =>
  waitFor(() => expect(container.querySelector('[data-testid="route-loading"]')).toBeNull())

describe('клик-шторм: все кнопки всех экранов нажимаются без падения', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_guest_token', 'g-token')
    // браузерные API, которых нет в jsdom — подменяем, чтобы тестить логику, а не среду
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn(() => 'blob:x'), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    Object.defineProperty(window, 'print', { value: vi.fn(), configurable: true })
    Object.defineProperty(window, 'open', { value: vi.fn(() => null), configurable: true })
  })
  afterEach(cleanup)

  for (const r of ROUTES) {
    it(`клики на ${r}`, async () => {
      const errors: string[] = []
      const errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0])) })
      const { container, unmount } = render(<MemoryRouter initialEntries={[r]}><App /></MemoryRouter>)
      await settled(container)
      // кликаем кнопки волнами: каждый клик может менять DOM и открывать новые кнопки
      let clicked = 0
      for (let wave = 0; wave < 4; wave++) {
        const btns = Array.from(container.querySelectorAll('button:not([disabled])'))
        for (const b of btns) {
          try {
            clicked++
            fireEvent.click(b)
          } catch (e) {
            errors.push(`${r} кнопка «${(b.textContent ?? '').slice(0, 40)}»: ${String(e)}`)
          }
        }
        await settled(container)
      }
      errSpy.mockRestore()
      // реальные исключения React логируются как "The above error occurred" — отфильтруем шум
      const fatal = errors.filter(e => /error occurred|is not a function|Cannot read|undefined is not/i.test(e))
      // страховка от вырождения: если экран не догрузился, кликать было бы не по чему
      expect(clicked).toBeGreaterThan(0)
      expect(container.innerHTML.length).toBeGreaterThan(50)
      unmount()
      expect(fatal).toEqual([])
    })
  }
})
