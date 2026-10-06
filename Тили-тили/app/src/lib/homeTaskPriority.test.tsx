// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import Home from '@/pages/Home'
import type { components } from './api/schema'
import { StoreProvider } from './store'
import { setI18nLang } from './i18n'

type Task = components['schemas']['Task']
const W = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', tz: 'Asia/Yekaterinburg', role: 'couple' }
let tasks: Task[]
let taskStatus: number
let pendingTasks: boolean
let writes: string[]

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>
}
function open() {
  return render(<MemoryRouter initialEntries={['/home']}>
    <StoreProvider><Home /><LocationProbe /></StoreProvider>
  </MemoryRouter>)
}
function preview() {
  return screen.getByRole('group', { name: 'Ближайшие дедлайны' })
}

beforeEach(() => {
  localStorage.clear()
  setI18nLang('ru')
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify(W.date))
  taskStatus = 200
  pendingTasks = false
  writes = []
  tasks = [
    { id: 'missing', title: 'Задача без срока', due: null, done: false },
    { id: 'invalid', title: 'Задача с ошибкой даты', due: '2027-02-30', done: false },
    { id: 'late', title: 'Поздняя задача', due: '2027-12-31', done: false },
    { id: 'closed', title: 'Закрытая задача', due: '2000-01-01', done: true },
    { id: 'early', title: 'Ранняя задача', due: '2027-03-10', done: false,
      assignee: { userId: 'u1', name: 'Аня' } },
    { id: 'same', title: 'Та же дата', due: '2027-03-10', done: false,
      assignee: { userId: 'u2', name: null } },
  ]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    const method = init?.method ?? 'GET'
    if (method !== 'GET') { writes.push(`${method} ${path}`); return json({}) }
    if (path === '/weddings') return json([W])
    if (path === '/weddings/w1') return json(W)
    if (path === '/users/me') return json({ id: 'u1', name: 'Аня' })
    if (path === '/weddings/w1/tasks') {
      if (pendingTasks) return new Promise<Response>(() => {})
      return taskStatus === 200 ? json(tasks) : json({ error: { message: 'Задачи недоступны' } }, taskStatus)
    }
    if (path === '/weddings/w1/budget') return json({ total: { amount: 100000 }, spent: { amount: 0 }, categories: [] })
    if (path === '/weddings/w1/tips') return json({ items: [] })
    return json([])
  }))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('WP09: Home deadline preview', () => {
  it('renders three ordered open tasks, a real assignee name and the reason', async () => {
    open()
    await screen.findByRole('button', { name: /^Ранняя задача/ })
    const block = within(preview())
    const rows = block.getAllByRole('button')
    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.querySelector('span')?.textContent))
      .toEqual(['Ранняя задача', 'Та же дата', 'Поздняя задача'])
    expect(within(rows[0]!).getByText('Ответственный: Аня')).toBeTruthy()
    expect(rows[0]!.querySelector('time')?.getAttribute('datetime')).toBe('2027-03-10')
    expect(rows[0]!.querySelector('time')?.textContent).toBe('10.03.2027')
    expect(within(rows[1]!).queryByText(/Ответственный:/)).toBeNull()
    expect(block.queryByText('Закрытая задача')).toBeNull()
    expect(block.queryByText('Задача без срока')).toBeNull()
    expect(block.getByText('Сначала задачи с известной датой, от ранней к поздней. Без точной даты — после них.')).toBeTruthy()
    expect(writes).toEqual([])
  })

  it('explains missing and invalid dates without guessing dates or names', async () => {
    tasks = [
      { id: 'missing', title: 'Без даты', due: null, period: '9', assignee: { userId: 'u2', name: '   ' } },
      { id: 'bad', title: 'Ошибка даты', due: '2027-02-30' },
      { id: 'known', title: 'Есть дата', due: '2027-05-01' },
    ]
    open()
    await screen.findByRole('button', { name: /^Есть дата/ })
    const rows = within(preview()).getAllByRole('button')
    expect(rows.map(row => row.querySelector('span')?.textContent)).toEqual(['Есть дата', 'Без даты', 'Ошибка даты'])
    expect(rows[1]!.textContent).toContain('Срок не задан · 9 мес')
    expect(rows[1]!.textContent).not.toContain('Ответственный:')
    expect(rows[2]!.textContent).toContain('Срок требует уточнения')
    expect(rows[2]!.textContent).not.toContain('2027-02-30')
    expect(rows[1]!.querySelector('time')).toBeNull()
    expect(rows[2]!.querySelector('time')).toBeNull()
  })

  it.each(['row', 'header'])('keeps %s navigation at the existing checklist route without writing', async source => {
    open()
    await screen.findByRole('button', { name: /^Ранняя задача/ })
    fireEvent.click(source === 'row'
      ? screen.getByRole('button', { name: /^Ранняя задача/ })
      : screen.getByRole('button', { name: 'Чек-лист →' }))
    expect(screen.getByTestId('location').textContent).toBe('/wedding/checklist')
    expect(writes).toEqual([])
  })

  it.each([
    [[], 'Чек-лист пуст — добавьте первую задачу'],
    [[{ id: 'done', title: 'Готово', done: true }], 'Все задачи закрыты ✓'],
  ] satisfies [Task[], string][])('preserves the ready empty/complete explanation', async (data, message) => {
    tasks = data
    open()
    expect(await within(preview()).findByText(message)).toBeTruthy()
    expect(within(preview()).queryAllByRole('button')).toHaveLength(0)
    expect(within(preview()).queryByText(/Сначала задачи/)).toBeNull()
  })

  it('does not present an unanswered request as an empty or ranked list', () => {
    pendingTasks = true
    open()
    const block = within(preview())
    expect(block.getByText('Загружаем…')).toBeTruthy()
    expect(block.queryAllByRole('button')).toHaveLength(0)
    expect(block.queryByText('Все задачи закрыты ✓')).toBeNull()
    expect(block.queryByText('Чек-лист пуст — добавьте первую задачу')).toBeNull()
    expect(block.queryByText(/Сначала задачи/)).toBeNull()
  })

  it('keeps an API failure distinct from an empty list', async () => {
    taskStatus = 503
    open()
    const block = within(preview())
    expect(await block.findByRole('button', { name: 'Повторить' })).toBeTruthy()
    expect(block.queryByRole('button', { name: /^Ранняя задача/ })).toBeNull()
    expect(block.queryByText('Чек-лист пуст — добавьте первую задачу')).toBeNull()
    expect(block.queryByText(/Сначала задачи/)).toBeNull()
  })

  it('keeps the existing forbidden explanation', async () => {
    taskStatus = 403
    open()
    const block = within(preview())
    expect(await block.findByText('Чек-лист ведёт пара — у вашей роли к нему доступа нет.')).toBeTruthy()
    expect(block.queryAllByRole('button')).toHaveLength(0)
    expect(block.queryByText('Чек-лист пуст — добавьте первую задачу')).toBeNull()
  })

  it('renders explanations in English without translating server task titles or names', async () => {
    localStorage.setItem('tt_lang', 'en')
    setI18nLang('en')
    tasks = [
      { id: 'known', title: 'Ранняя задача', due: '2027-03-10', assignee: { userId: 'u1', name: 'Аня' } },
      { id: 'missing', title: 'Без даты', due: null },
      { id: 'bad', title: 'Ошибка даты', due: '' },
    ]
    open()
    await screen.findByRole('button', { name: /^Ранняя задача/ })
    const block = within(screen.getByRole('group', { name: 'Upcoming deadlines' }))
    expect(block.getByText('Tasks with a known date come first, earliest to latest. Tasks without an exact date follow.')).toBeTruthy()
    expect(block.getByText(/Ordered by known due date/)).toBeTruthy()
    expect(block.getByText('No deadline')).toBeTruthy()
    expect(block.getByText('Due date needs clarification')).toBeTruthy()
    expect(block.getByText('Assignee: Аня')).toBeTruthy()
    expect(block.getByText('10.03.2027')).toBeTruthy()
  })
})
