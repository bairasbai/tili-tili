// @vitest-environment jsdom
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import App from '@/App'

const ROUTES = [
  '/', '/quiz', '/invite', '/auth', '/join/ДРУГ-7F3K', '/invite/day-chat',
  '/home', '/notifications', '/settings', '/support',
  '/search', '/search/photo', '/vendor/v1',
  '/wedding', '/wedding/week', '/wedding/slot/s1', '/wedding/budget', '/wedding/checklist',
  '/wedding/timeline', '/wedding/guests', '/wedding/documents', '/wedding/documents/new',
  '/wedding/invites', '/wedding/seating', '/wedding/wishlist', '/gifts', '/wedding/album', '/wedding/logistics', '/wedding/catering', '/wedding/planb',
  '/us', '/us/chats', '/us/chats/ch1', '/us/team',
  '/deal/d1', '/tools/alcohol', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/notes', '/inspiration', '/venues',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
  '/admin', '/admin/moderation', '/admin/moderation/v1',
  '/admin/verifications', '/admin/verifications/r1',
  '/admin/complaints', '/admin/categories', '/admin/wedding',
  '/totally-unknown-route',
]

/** Экраны грузятся отдельными чанками — ждём, пока заглушка Suspense уйдёт,
 *  иначе тест проверял бы саму заглушку и всегда был бы зелёным.
 *
 *  Падение экрана ловит `ErrorBoundary` и рисует «Что-то пошло не так» с
 *  кнопкой — это заведомо больше 50 символов разметки, и проверка длины была
 *  зелёной при рендер-крэше любого из маршрутов (ревью D6-11). Слова заглушки
 *  на экране — провал. */
export const settled = async (container: HTMLElement) => {
  await waitFor(() => expect(container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  expect(container.textContent, 'экран упал в ErrorBoundary').not.toContain('Что-то пошло не так')
}

describe('smoke: каждый экран рендерится без падения', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
  })
  afterEach(cleanup)

  for (const r of ROUTES) {
    it(`рендер ${r}`, async () => {
      const { container, unmount } = render(
        <MemoryRouter initialEntries={[r]}>
          <App />
        </MemoryRouter>
      )
      await settled(container)
      expect(container.innerHTML.length).toBeGreaterThan(50)
      unmount()
    })
  }
})
