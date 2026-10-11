// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { components } from '@/lib/api/schema'
import { setI18nLang } from '@/lib/i18n'
import { TaskWeekPanel } from './TaskWeekPanel'

type Task = components['schemas']['Task']
// Controlled UI data, not evidence of a live backend response.
const task = (id: string, due?: string | null, done = false) => ({ id, title: id, due, done } as Task)
const items = [
  task('sunday', '2026-10-11'), task('old', '2026-09-01'), task('today', '2026-10-07'),
  task('monday', '2026-10-05'), task('future', '2026-10-12'), task('undated'),
  task('invalid-date', '2026-02-30'), task('complete', '2026-10-06', true),
]
const props = () => ({ tasks: items, current: true, calendarReady: true, weddingTz: 'Europe/Moscow', onOpenChecklist: vi.fn() })
const open = () => fireEvent.click(screen.getByRole('button', { name: 'Показать недельный обзор' }))

beforeEach(() => {
  setI18nLang('ru')
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
})
afterEach(() => { cleanup(); vi.useRealTimers(); setI18nLang('ru') })

describe('task-only weekly overview', () => {
  it('starts collapsed without a clock, hidden task data or an invented weekly zero', () => {
    render(<TaskWeekPanel {...props()} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('region')).toBeNull()
    expect(screen.queryByText('today')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shows exact calendar boundaries, independent overdue/upcoming/undated counts and later count', () => {
    render(<TaskWeekPanel {...props()} />); open()
    expect(screen.getByText(/05.10.2026 — 11.10.2026/)).toBeTruthy()
    expect(screen.getByText('Часовой пояс календаря: Europe/Moscow')).toBeTruthy()
    expect(screen.getByText('Просроченные задачи: 2')).toBeTruthy()
    expect(screen.getByText('До конца этой недели: 2')).toBeTruthy()
    expect(screen.getByText('Задачи без срока: 2')).toBeTruthy()
    expect(screen.getByText('Следующая неделя и позже: 1')).toBeTruthy()
    expect(screen.queryByText('future')).toBeNull()
    expect(screen.queryByText('complete')).toBeNull()
  })

  it('ranks rows by the actual date inside each group', () => {
    render(<TaskWeekPanel {...props()} />); open()
    const overdue = within(screen.getByRole('region', { name: 'Просроченные задачи' }))
    expect(overdue.getAllByRole('button').map(button => button.firstElementChild?.textContent)).toEqual(['old', 'monday'])
    const upcoming = within(screen.getByRole('region', { name: 'До конца этой недели' }))
    expect(upcoming.getAllByRole('button').map(button => button.firstElementChild?.textContent)).toEqual(['today', 'sunday'])
  })

  it('explains missing and invalid deadlines without classifying them as overdue', () => {
    render(<TaskWeekPanel {...props()} />); open()
    const undated = within(screen.getByRole('region', { name: 'Задачи без срока' }))
    expect(undated.getByText('Срок задачи не задан')).toBeTruthy()
    expect(undated.getByText('Срок задачи некорректен — проверьте в чек-листе')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Просроченные задачи' })).queryByText('invalid-date')).toBeNull()
  })

  it('uses the supplied checklist action for a row and the full-list control, with no task mutation', () => {
    const options = props()
    render(<TaskWeekPanel {...options} />); open()
    expect(options.onOpenChecklist).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /today.*07/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Открыть весь чек-лист' }))
    expect(options.onOpenChecklist).toHaveBeenCalledTimes(2)
    expect(items.find(item => item.id === 'today')?.done).toBe(false)
  })

  it('removes the clock and contents when collapsed and on unmount', () => {
    const view = render(<TaskWeekPanel {...props()} />); open()
    expect(vi.getTimerCount()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Скрыть недельный обзор' }))
    expect(screen.queryByText('today')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    open(); expect(vi.getTimerCount()).toBe(1)
    view.unmount(); expect(vi.getTimerCount()).toBe(0)
  })

  it('immediately removes old titles, counts and the clock when the current-response gate closes', () => {
    const options = props()
    const view = render(<TaskWeekPanel {...options} />); open()
    view.rerender(<TaskWeekPanel {...options} current={false} />)
    expect(screen.queryByText('old')).toBeNull()
    expect(screen.queryByText('Просроченные задачи: 2')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    view.rerender(<TaskWeekPanel {...options} tasks={[task('fresh', '2026-10-07')]} />)
    expect(screen.getByText('fresh')).toBeTruthy()
    expect(screen.queryByText('old')).toBeNull()
  })

  it('does not use a stale timezone or manufacture counts while wedding metadata is unavailable', () => {
    const view = render(<TaskWeekPanel {...props()} />); open()
    view.rerender(<TaskWeekPanel {...props()} calendarReady={false} />)
    expect(screen.getByRole('status').textContent).toBe('Календарь свадьбы пока недоступен')
    expect(screen.queryByText('today')).toBeNull()
    expect(screen.queryByText(/Просроченные задачи:/)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects an invalid server timezone visibly, without falling back to the device date', () => {
    render(<TaskWeekPanel {...props()} weddingTz="Not/AZone" />); open()
    expect(screen.getByRole('status').textContent).toBe('Календарь свадьбы пока недоступен')
    expect(screen.queryByText('today')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('distinguishes Sunday in Honolulu from Monday in Moscow at the same instant', () => {
    vi.setSystemTime(new Date('2026-10-05T01:00:00Z'))
    const options = { ...props(), tasks: [task('sunday-task', '2026-10-04')] }
    const view = render(<TaskWeekPanel {...options} weddingTz="Pacific/Honolulu" />); open()
    expect(screen.getByText(/28.09.2026 — 04.10.2026/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'До конца этой недели' })).getByText('sunday-task')).toBeTruthy()
    view.rerender(<TaskWeekPanel {...options} weddingTz="Europe/Moscow" />)
    expect(screen.getByText(/05.10.2026 — 11.10.2026/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Просроченные задачи' })).getByText('sunday-task')).toBeTruthy()
  })

  it('updates after midnight through the existing calendar timer', () => {
    vi.setSystemTime(new Date('2026-10-04T20:59:50Z'))
    render(<TaskWeekPanel {...props()} tasks={[task('sunday-task', '2026-10-04')]} />); open()
    expect(screen.getByText(/28.09.2026 — 04.10.2026/)).toBeTruthy()
    act(() => vi.advanceTimersByTime(30_000))
    expect(screen.getByText(/05.10.2026 — 11.10.2026/)).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Просроченные задачи' })).getByText('sunday-task')).toBeTruthy()
  })

  it('refreshes the calendar immediately after returning to the tab', () => {
    render(<TaskWeekPanel {...props()} />); open()
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(screen.getByText(/12.10.2026 — 18.10.2026/)).toBeTruthy()
  })

  it('translates the expanded empty overview RU → EN → RU without module-time labels', () => {
    const options = { ...props(), tasks: [] }
    const view = render(<TaskWeekPanel {...options} />); open()
    setI18nLang('en'); view.rerender(<TaskWeekPanel {...options} />)
    const region = screen.getByRole('region', { name: 'This week’s tasks' })
    expect(/[А-Яа-яЁё]/.test(region.textContent ?? '')).toBe(false)
    expect(screen.getByRole('button', { name: 'Hide weekly task overview' })).toBeTruthy()
    setI18nLang('ru'); view.rerender(<TaskWeekPanel {...options} />)
    expect(screen.getByRole('region', { name: 'Задачи этой недели' })).toBeTruthy()
  })

  it('renders a server title as text, not executable markup', () => {
    const title = '<img src=x onerror=alert(1)>'
    const view = render(<TaskWeekPanel {...props()} tasks={[task(title, '2026-10-07')]} />); open()
    expect(screen.getByText(title)).toBeTruthy()
    expect(view.container.querySelector('img')).toBeNull()
  })

  it('resets the expansion when the owning wedding key changes', () => {
    const view = render(<TaskWeekPanel key="w1" {...props()} />); open()
    view.rerender(<TaskWeekPanel key="w2" {...props()} tasks={[task('w2-task', '2026-10-07')]} />)
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('old')).toBeNull()
    expect(screen.queryByText('w2-task')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
