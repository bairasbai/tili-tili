// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { DelegatedTasks } from './TaskDelegations'
import { StaffDuties } from './VendorStaff'
import { getDelegatedTasks } from '@/lib/api/taskDelegations'
import { getOwnStaffDuties } from '@/lib/api/vendorStaff'

vi.mock('@/lib/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/client')>(),
  isAuthorized: () => true,
}))
vi.mock('@/lib/api/taskDelegations', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/taskDelegations')>(),
  getDelegatedTasks: vi.fn(async () => []),
}))
vi.mock('@/lib/api/vendorStaff', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/vendorStaff')>(),
  getOwnStaffDuties: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.mocked(getDelegatedTasks).mockReset().mockResolvedValue([])
  vi.mocked(getOwnStaffDuties).mockReset()
  window.history.replaceState(null, '', '/')
})

it('hides delegated tasks while the returning tab checks current assignments', async () => {
  const tasks = [{ id: 'task', title: 'Приватное поручение', done: false, blocked: false }] as Awaited<ReturnType<typeof getDelegatedTasks>>
  let finish!: (value: typeof tasks) => void
  vi.mocked(getDelegatedTasks).mockResolvedValueOnce(tasks).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  window.history.replaceState(null, '', '/delegated-tasks')
  render(<BrowserRouter><DelegatedTasks /></BrowserRouter>)
  await screen.findByText('Приватное поручение')
  fireEvent.focus(window)
  expect(screen.queryByText('Приватное поручение')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Отметить выполненной' })).toBeNull()
  await act(async () => finish([]))
  expect(await screen.findByText('Поручений пока нет')).toBeTruthy()
})

it('checks revoked staff assignments when connectivity returns before showing any old card', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  const assignment = { id: 'duty', label: 'Приватное назначение', role: 'performer', event: { name: 'Событие' } }
  type Duties = Awaited<ReturnType<typeof getOwnStaffDuties>>
  let finish!: (value: Duties) => void
  vi.mocked(getOwnStaffDuties).mockResolvedValueOnce({ items: [assignment], nextAfter: null } as Duties)
    .mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  window.history.replaceState(null, '', '/staff-duties')
  render(<BrowserRouter><StaffDuties /></BrowserRouter>)
  await screen.findByText('Приватное назначение')
  online.mockReturnValue(false)
  fireEvent(window, new Event('offline'))
  expect(screen.queryByText('Приватное назначение')).toBeNull()
  online.mockReturnValue(true)
  fireEvent(window, new Event('online'))
  expect(screen.queryByText('Приватное назначение')).toBeNull()
  await act(async () => finish({ items: [], nextAfter: null }))
  expect(await screen.findByText('Действующих рабочих назначений пока нет')).toBeTruthy()
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
