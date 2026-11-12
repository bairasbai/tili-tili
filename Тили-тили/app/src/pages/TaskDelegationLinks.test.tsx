// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegatedTasks } from './TaskDelegations'

vi.mock('@/lib/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/client')>(),
  isAuthorized: () => true,
}))
vi.mock('@/lib/api/taskDelegations', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/taskDelegations')>(),
  getDelegatedTasks: async () => [],
}))

afterEach(() => {
  cleanup()
  window.history.replaceState(null, '', '/')
})

it('loads the invitation code after a fragment-only navigation with the same location key', async () => {
  const entry = { idx: 0, key: 'same-entry' }
  window.history.replaceState(entry, '', '/delegated-tasks')
  render(<BrowserRouter><DelegatedTasks /></BrowserRouter>)
  const input = await screen.findByLabelText<HTMLInputElement>('Код поручения')
  expect(input.value).toBe('')

  const code = 'A'.repeat(32)
  act(() => {
    window.history.replaceState(entry, '', '/delegated-tasks#' + code)
    window.dispatchEvent(new PopStateEvent('popstate', { state: entry }))
  })
  await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>('Код поручения').value).toBe(code))
})
