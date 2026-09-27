// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { StoreProvider } from './store'
import { Budget, Checklist, Guests } from '@/pages/Wedding'
import { setI18nLang } from './i18n'
import { notificationRoute } from './api/notifications'

const W = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', tz: 'Asia/Yekaterinburg', role: 'couple' }
const ME = { id: 'u1', name: 'Аня' }
const TEAM = [{ user: ME, role: 'couple' }, { user: { id: 'u2', name: 'Боря' }, role: 'helper' }]
type Task = { reminderDaysBefore?: number | null; reminderTime?: string; id: string; title: string; period: string; done: boolean; custom: boolean; due: string | null; dueMode: 'fixed' | 'relative'; assignee: { userId: string; name: string } | null }
let tasks: Task[]
let writes: { path: string; body: Record<string, unknown> }[]
let failSave = false
let failMembers = false
let failMe = false
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    const method = init?.method ?? 'GET'
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      writes.push({ path, body })
      if (failSave) return json({ error: { code: 'validation_failed', message: 'Изменение отклонено сервером' } }, 422)
      if (path === '/weddings/w1/tasks') {
        const t: Task = { id: 'created', title: String(body.title), period: String(body.period), done: false, custom: true,
          reminderDaysBefore: body.reminderDaysBefore as number | null ?? null, reminderTime: String(body.reminderTime ?? '09:00'),
          due: body.due as string | null ?? null, dueMode: body.dueMode as 'fixed' | 'relative' ?? 'relative',
          assignee: body.assigneeId ? { userId: String(body.assigneeId), name: body.assigneeId === 'u1' ? 'Аня' : 'Боря' } : null }
        tasks.push(t); return json(t, 201)
      }
      const task = tasks.find(t => path.endsWith('/' + t.id))
      if (task) {
        Object.assign(task, body)
        if ('assigneeId' in body) task.assignee = body.assigneeId ? { userId: String(body.assigneeId), name: body.assigneeId === 'u1' ? 'Аня' : 'Боря' } : null
        return json(task)
      }
      return json({})
    }
    if (path === '/weddings') return json([W])
    if (path === '/weddings/w1') return json(W)
    if (path === '/users/me') return failMe ? json({ error: { message: 'Профиль недоступен' } }, 503) : json(ME)
    if (path === '/weddings/w1/members') return failMembers ? json({ error: { message: 'Команда недоступна' } }, 503) : json(TEAM)
    if (path === '/weddings/w1/tasks') return json(tasks)
    if (path === '/weddings/w1/budget') return json({ total: { amount: 100000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, reserve: { amount: 10000 }, categories: [{ id: 'other', title: 'Прочее', planned: { amount: 100000 }, items: [] }] })
    if (path === '/weddings/w1/tips') return json({ items: [] })
    return json([])
  }))
}
const open = (element: React.ReactNode = <Checklist />) => render(<MemoryRouter><StoreProvider>{element}</StoreProvider></MemoryRouter>)
const clickTask = (title: string) => fireEvent.click(screen.getByRole('button', { name: new RegExp('^' + title) }))
beforeEach(() => {
  localStorage.clear(); setI18nLang('ru')
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify(W.date))
  tasks = [
    { id: 't1', title: 'Выбрать площадку', period: '9', done: false, custom: false, due: '2026-09-14', dueMode: 'relative', assignee: { userId: 'u1', name: 'Аня' } },
    { id: 't2', title: 'Заказать торт', period: '1', done: false, custom: true, due: null, dueMode: 'fixed', assignee: { userId: 'u1', name: 'Аня' } },
    { id: 't3', title: 'Купить открытки', period: '9', done: false, custom: true, due: null, dueMode: 'fixed', assignee: null },
  ]
  writes = []; failSave = false; failMembers = false; failMe = false; serve()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('017: планирование задач через интерфейс и API', () => {
  it('создаёт задачу с выбранным ответственным и фиксированной датой', async () => {
    open()
    await screen.findByRole('button', { name: /^Выбрать площадку/ })
    fireEvent.click(screen.getByRole('button', { name: '+ Задача' }))
    const form = screen.getByRole('group', { name: 'Новая задача' })
    fireEvent.change(within(form).getByPlaceholderText('Новая задача…'), { target: { value: 'Отправить меню' } })
    fireEvent.change(within(form).getByLabelText('Ответственный'), { target: { value: 'u2' } })
    fireEvent.change(within(form).getByLabelText('Дата выполнения'), { target: { value: '2027-05-05' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Добавить' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/weddings/w1/tasks', body: { title: 'Отправить меню', assigneeId: 'u2', due: '2027-05-05', dueMode: 'fixed' } })
    await screen.findByRole('button', { name: /^Отправить меню/ })
  })
  it('фильтр Мои задачи видит задачи всех периодов и исключает неназначенные', async () => {
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ })
    fireEvent.click(screen.getByRole('button', { name: 'Мои задачи' }))
    await screen.findByRole('button', { name: /^Заказать торт/ })
    expect(screen.queryByRole('button', { name: /^Купить открытки/ })).toBeNull()
  })
  it('ошибка профиля не выдается за отсутствие своих задач', async () => {
    failMe = true; open()
    await screen.findByRole('button', { name: /^Выбрать площадку/ })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Мои задачи' }).hasAttribute('disabled')).toBe(true))
    expect(screen.queryByText('У вас пока нет назначенных задач')).toBeNull()
  })
  it('сохраняет назначение и срок одним PATCH; явное снятие — null', async () => {
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    fireEvent.change(within(editor).getByLabelText('Ответственный'), { target: { value: '' } })
    fireEvent.change(within(editor).getByLabelText('Дата выполнения'), { target: { value: '' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить планирование' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toEqual({ assigneeId: null, due: null, dueMode: 'fixed' })
  })
  it('при отказе сервера не теряет введённую дату и не сообщает успех', async () => {
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    fireEvent.change(within(editor).getByLabelText('Дата выполнения'), { target: { value: '2027-04-01' } })
    failSave = true
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить планирование' }))
    await screen.findByText('Изменение отклонено сервером')
    expect((within(editor).getByLabelText('Дата выполнения') as HTMLInputElement).value).toBe('2027-04-01')
  })
  it('команда недоступна — нельзя случайно стереть ответственного', async () => {
    failMembers = true; open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    expect(within(editor).getByLabelText('Ответственный').hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(editor).getByLabelText('Дата выполнения'), { target: { value: '2027-04-01' } })
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить планирование' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).not.toHaveProperty('assigneeId')
  })
  it('поля задач не появляются в бюджете и гостях', async () => {
    const b = open(<Budget />)
    await screen.findByText('Добавить расход')
    fireEvent.click(screen.getByText('Добавить расход'))
    expect(b.container.querySelector('input[type=date]')).toBeNull()
    expect(screen.queryByLabelText('Ответственный')).toBeNull()
    cleanup()
    const g = open(<Guests />)
    await waitFor(() => expect(g.container.textContent).toContain('Гости'))
    expect(screen.queryByLabelText('Ответственный')).toBeNull()
  })
})


describe('017-B: reminder controls and notification navigation', () => {
  it('creates a reminder through the same save, preserving zero and custom time', async () => {
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ })
    fireEvent.click(screen.getByRole('button', { name: '+ Задача' }))
    const form = screen.getByRole('group', { name: 'Новая задача' })
    fireEvent.change(within(form).getByPlaceholderText('Новая задача…'), { target: { value: 'Передать меню' } })
    fireEvent.change(within(form).getByLabelText('Ответственный'), { target: { value: 'u2' } })
    fireEvent.change(within(form).getByLabelText('Дата выполнения'), { target: { value: '2027-05-05' } })
    fireEvent.click(within(form).getByLabelText('Напомнить ответственному'))
    fireEvent.change(within(form).getByLabelText('За сколько дней до срока'), { target: { value: '0' } })
    fireEvent.change(within(form).getByLabelText('Время напоминания'), { target: { value: '11:30' } })
    expect(writes).toHaveLength(0)
    fireEvent.click(within(form).getByRole('button', { name: 'Добавить' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toMatchObject({ reminderDaysBefore: 0, reminderTime: '11:30', assigneeId: 'u2' })
  })
  it('shows the saved reminder and can disable it without clearing the assignee', async () => {
    tasks[0]!.reminderDaysBefore = 3; tasks[0]!.reminderTime = '11:30'
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    expect((within(editor).getByLabelText('Время напоминания') as HTMLInputElement).value).toBe('11:30')
    fireEvent.click(within(editor).getByLabelText('Напомнить ответственному'))
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить планирование' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toMatchObject({ reminderDaysBefore: null, assigneeId: 'u1' })
  })
  it('removing the assignee also turns off an enabled reminder', async () => {
    tasks[0]!.reminderDaysBefore = 1
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    fireEvent.change(within(editor).getByLabelText('Ответственный'), { target: { value: '' } })
    expect((within(editor).getByLabelText('Напомнить ответственному') as HTMLInputElement).checked).toBe(false)
    fireEvent.click(within(editor).getByRole('button', { name: 'Сохранить планирование' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toMatchObject({ reminderDaysBefore: null, assigneeId: null })
  })
  it('an empty reminder time is not silently replaced by a default', async () => {
    tasks[0]!.reminderDaysBefore = 1
    open(); await screen.findByRole('button', { name: /^Выбрать площадку/ }); clickTask('Выбрать площадку')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    const editor = screen.getByRole('group', { name: 'Планирование задачи' })
    fireEvent.change(within(editor).getByLabelText('Время напоминания'), { target: { value: '' } })
    expect(within(editor).getByRole('button', { name: 'Сохранить планирование' }).hasAttribute('disabled')).toBe(true)
    expect(writes).toHaveLength(0)
  })
  it('cannot enable a reminder for an unassigned task', async () => {
    open(); await screen.findByRole('button', { name: /^Купить открытки/ }); clickTask('Купить открытки')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    expect(screen.getByLabelText('Напомнить ответственному').hasAttribute('disabled')).toBe(true)
  })
  it('a deep link opens the target task even in a different period', async () => {
    render(<MemoryRouter initialEntries={['/wedding/checklist?task=t2']}><StoreProvider><Checklist /></StoreProvider></MemoryRouter>)
    await screen.findByRole('button', { name: 'Ответственный и срок' })
    expect(screen.getByRole('button', { name: /^Заказать торт/ }).getAttribute('aria-expanded')).toBe('true')
  })
  it('a second notification link replaces the open task without remounting the router', async () => {
    function NotificationLinks() {
      const navigate = useNavigate()
      return <>
        <button onClick={() => void navigate('/wedding/checklist?task=t2')}>Open next notification</button>
        <Checklist />
      </>
    }
    render(<MemoryRouter initialEntries={['/wedding/checklist?task=t1']}><StoreProvider><NotificationLinks /></StoreProvider></MemoryRouter>)
    await screen.findByRole('button', { name: 'Ответственный и срок' })
    expect(screen.getByRole('button', { name: /^Выбрать площадку/ }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Open next notification' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^Заказать торт/ }).getAttribute('aria-expanded')).toBe('true'))
    expect(screen.getByRole('button', { name: /^Выбрать площадку/ }).getAttribute('aria-expanded')).toBe('false')
  })
  it('reopening a notification after a full remount preserves the target task and reminder', async () => {
    tasks[1]!.reminderDaysBefore = 0; tasks[1]!.reminderTime = '11:30'; tasks[1]!.due = '2027-05-05'
    const route = '/wedding/checklist?task=t2'
    const visit = () => render(<MemoryRouter initialEntries={[route]}><StoreProvider><Checklist /></StoreProvider></MemoryRouter>)
    const first = visit()
    await screen.findByRole('button', { name: 'Ответственный и срок' })
    first.unmount()
    visit()
    await screen.findByRole('button', { name: 'Ответственный и срок' })
    expect(screen.getByRole('button', { name: /^Заказать торт/ }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Ответственный и срок' }))
    expect((screen.getByLabelText('Время напоминания') as HTMLInputElement).value).toBe('11:30')
    expect((screen.getByLabelText('За сколько дней до срока') as HTMLSelectElement).value).toBe('0')
  })
  it('only accepts the exact internal task link shape, including the target wedding', () => {
    const link = '/wedding/checklist?task=00000000-0000-4000-8000-000000000001&wedding=00000000-0000-4000-8000-000000000002'
    expect(notificationRoute(link)).toBe(link)
    expect(notificationRoute('https://example.com'+link)).toBeNull()
    expect(notificationRoute(link+'&next=https://example.com')).toBeNull()
  })
})
