// @vitest-environment jsdom
import { render, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import App from '@/App'

const ROUTES = [
  '/', '/quiz', '/invite', '/auth', '/join/ДРУГ-7F3K',
  '/home', '/notifications', '/settings', '/support',
  '/search', '/search/photo', '/vendor/v1',
  '/wedding', '/wedding/slot/s1', '/wedding/budget', '/wedding/checklist',
  '/wedding/timeline', '/wedding/guests', '/wedding/documents', '/wedding/documents/new',
  '/wedding/invites', '/wedding/seating', '/wedding/wishlist', '/gifts',
  '/us', '/us/chats', '/us/chats/ch1', '/us/team',
  '/deal', '/tools/alcohol', '/assistant', '/compare', '/dayx', '/after',
  '/favorites', '/notes', '/inspiration', '/venues',
  '/vendor-app', '/vendor-app/profile', '/vendor-app/deals',
  '/vendor-app/leads/l1', '/vendor-app/reviews', '/vendor-app/analytics',
  '/totally-unknown-route',
]

describe('smoke: каждый экран рендерится без падения', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
  })
  afterEach(cleanup)

  for (const r of ROUTES) {
    it(`рендер ${r}`, () => {
      const { container, unmount } = render(
        <MemoryRouter initialEntries={[r]}>
          <App />
        </MemoryRouter>
      )
      expect(container.innerHTML.length).toBeGreaterThan(50)
      unmount()
    })
  }
})
