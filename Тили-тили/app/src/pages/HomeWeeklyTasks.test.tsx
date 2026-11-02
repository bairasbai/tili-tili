// @vitest-environment jsdom
import { useLayoutEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api/client'
import { setI18nLang } from '@/lib/i18n'
import Home from './Home'

const fixture = vi.hoisted(() => ({ weddingId: 'w1', getTasks: vi.fn() }))
vi.mock('@/lib/store', async original => ({
  ...(await original<Record<string, unknown>>()),
  useStore: () => ({ slots: [], slotsState: 'ready', weddingDate: null, weddingId: fixture.weddingId, weddingsState: 'ready', lang: 'ru' }),
}))
vi.mock('@/lib/useIsCouple', () => ({ useIsCouple: () => false }))
vi.mock('@/lib/api/client', async original => ({
  ...(await original<Record<string, unknown>>()), isAuthorized: () => true,
}))
vi.mock('@/lib/api/notifications', async original => ({
  ...(await original<Record<string, unknown>>()), getNotifications: () => Promise.resolve([]),
}))
vi.mock('@/lib/api/weddingData', async original => ({
  ...(await original<Record<string, unknown>>()),
  getTasks: (id: string) => fixture.getTasks(id),
  getBudget: () => Promise.resolve({ total: { amount: 0 }, spent: { amount: 0 } }),
  getGuests: () => Promise.resolve([]),
  getWedding: (id: string) => Promise.resolve({ id, title: `Wedding ${id}`, tz: 'Europe/Moscow' }),
  getTips: () => Promise.resolve({ items: [] }),
}))

const task = (title: string, due?: string) => ({ id: title, title, due, done: false })
function Location() { return <span data-testid="route">{useLocation().pathname}</span> }
function Capture({ scope, onCapture }: { scope: string; onCapture: (text: string) => void }) {
  // Observe the committed DOM before useApi's passive effect can erase stale data.
  useLayoutEffect(() => { onCapture(document.body.textContent ?? '') }, [scope, onCapture])
  return null
}

beforeEach(() => { fixture.weddingId = 'w1'; fixture.getTasks.mockReset(); setI18nLang('ru') })
afterEach(() => { cleanup(); setI18nLang('ru') })

describe('Home task wiring with real useApi and controlled API responses', () => {
  it('shows the three earliest real deadlines rather than the first three API rows and keeps the checklist route', async () => {
    fixture.getTasks.mockResolvedValue([
      task('Distant', '2030-01-01'), task('Undated'), task('Third', '2026-10-10'),
      task('First', '2026-10-05'), task('Second', '2026-10-07'),
    ])
    render(<MemoryRouter><Home /><Location /></MemoryRouter>)
    const first = await screen.findByRole('button', { name: /First/ })
    expect(screen.getByRole('button', { name: /Second/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Third/ })).toBeTruthy()
    expect(screen.queryByText('Distant')).toBeNull()
    expect(screen.queryByText('Undated')).toBeNull()
    fireEvent.click(first)
    expect(screen.getByTestId('route').textContent).toBe('/wedding/checklist')
    expect(fixture.getTasks).toHaveBeenCalledTimes(1)
  })

  it('hides previous wedding titles in the first committed frame, before the new request effect runs', async () => {
    let finish!: (value: ReturnType<typeof task>[]) => void
    const pending = new Promise<ReturnType<typeof task>[]>(resolve => { finish = resolve })
    fixture.getTasks.mockImplementation((id: string) => id === 'w1' ? Promise.resolve([task('private-old', '2026-10-05')]) : pending)
    const capture = vi.fn()
    const ui = () => <MemoryRouter><Home /><Capture scope={fixture.weddingId} onCapture={capture} /></MemoryRouter>
    const view = render(ui())
    await screen.findByText('private-old')
    capture.mockClear()
    fixture.weddingId = 'w2'; view.rerender(ui())
    expect(capture).toHaveBeenCalled()
    expect(capture.mock.calls[0]?.[0]).not.toContain('private-old')
    expect(screen.queryByText('private-old')).toBeNull()
    await act(async () => { finish([task('current-new', '2026-10-07')]) })
    expect(screen.getByText('current-new')).toBeTruthy()
    expect(screen.queryByText('private-old')).toBeNull()
    expect(fixture.getTasks.mock.calls.map(call => call[0])).toEqual(['w1', 'w2'])
  })

  it('keeps old tasks and weekly controls hidden when the next wedding refuses access', async () => {
    let refuse!: (error: Error) => void
    const pending = new Promise<ReturnType<typeof task>[]>((_resolve, reject) => { refuse = reject })
    fixture.getTasks.mockImplementation((id: string) => id === 'w1' ? Promise.resolve([task('private-old', '2026-10-05')]) : pending)
    const view = render(<MemoryRouter><Home /></MemoryRouter>)
    await screen.findByText('private-old')
    fixture.weddingId = 'w2'; view.rerender(<MemoryRouter><Home /></MemoryRouter>)
    await act(async () => { refuse(new ApiError('http', 403, 'forbidden', 'Restricted tasks')) })
    expect(screen.queryByText('private-old')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Показать недельный обзор' })).toBeNull()
    expect(screen.getByText('Чек-лист ведёт пара — у вашей роли к нему доступа нет.')).toBeTruthy()
    expect(screen.queryByText('Чек-лист пуст — добавьте первую задачу')).toBeNull()
  })
})
