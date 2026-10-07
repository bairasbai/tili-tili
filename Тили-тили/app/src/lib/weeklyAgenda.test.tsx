// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'
import WeeklyAgenda from '@/pages/WeeklyAgenda'
import { saveTokens } from './api/client'
import { setI18nLang } from './i18n'

// Real UI, pure projections, session observer and typed HTTP client. Only transport and store selection are controlled.
const selection = vi.hoisted(() => ({ weddingId: 'w1' as string | null }))
vi.mock('./store', () => ({ useStore: () => selection }))
let calls: { path: string; method: string }[]
let denied: string | null
let failPayments: boolean
let guests: unknown[]
let tasks: unknown[]
let hold: ((path: string) => Promise<Response> | undefined) | null
let zone: string | null
const token = (user = 'a', session = 's', exp = 2100000000) => ({
  accessToken: `e30.${btoa(JSON.stringify({ sub: user, sid: session, exp }))}.signature`, refreshToken: `r-${user}-${session}`,
})
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function Location() { const location = useLocation(); return <output data-testid="location">{location.pathname + location.search}</output> }
function open() { return render(<MemoryRouter initialEntries={['/wedding/week']}><WeeklyAgenda /><Location /></MemoryRouter>) }
function paymentResponse(url: URL) {
  return { range: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), today: '2026-10-07', timeZone: 'Europe/Moscow', includeOverdue: true, includeCancelled: false },
    items: [{ id: 'p', title: 'Payment fixture', due: '2026-10-09', status: 'partial', cancelledAt: null,
      remaining: { amount: 123456, currency: 'RUB' }, unknownAmountPayments: 1 }] }
}
beforeEach(() => {
  localStorage.clear(); saveTokens(token()); setI18nLang('ru')
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
  selection.weddingId = 'w1'; calls = []; denied = null; failPayments = false; hold = null; zone = 'Europe/Moscow'
  tasks = [{ id: 't', title: 'Task fixture', done: false, due: '2026-10-09', assignee: { name: 'Responsible fixture' } }]
  guests = [{ id: 'g1', name: 'Guest fixture', status: 'pending', plusOne: true, partySize: 3 }]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost'), path = url.pathname.replace(/^\/api/, '')
    calls.push({ path: url.pathname + url.search, method: init?.method ?? 'GET' })
    const pending = hold?.(path); if (pending) return pending
    if (denied && path.endsWith(denied)) return json({ error: { message: 'Permission fixture denied' } }, 403)
    if (path.endsWith('/payment-schedule')) return failPayments ? json({ error: { message: 'Unavailable fixture' } }, 503) : json(paymentResponse(url))
    if (path.endsWith('/tasks')) return json(tasks)
    if (path.endsWith('/guests')) return json(guests)
    if (/^\/weddings\/w\d$/.test(path)) return json({ id: path.split('/').at(-1), tz: zone })
    return json({ error: { message: 'Unexpected path' } }, 404)
  }))
})
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals(); vi.useRealTimers(); setI18nLang('ru') })

describe('weekly agenda through actual typed GET client', () => {
  it('shows separate dated sections and per-person replies using exact range filters, without writes', async () => {
    open(); await screen.findByText('Task fixture'); await screen.findByText('Payment fixture'); await screen.findByText('Guest fixture')
    expect(screen.getByTestId('week-range').textContent).toContain('05.10.2026 — 11.10.2026')
    expect(screen.getByText('Ответственный: Responsible fixture')).toBeTruthy()
    expect(screen.getByText(/Осталось по этапу:/).textContent).toMatch(/1\s234,56/)
    expect(screen.getByText('Есть отметки оплаты с неизвестной суммой.')).toBeTruthy()
    expect(screen.getByText('1 персона ждёт ответа')).toBeTruthy()
    const url = calls.find(c => c.path.includes('/payment-schedule'))!.path
    expect(url).toContain('from=2026-10-05'); expect(url).toContain('to=2026-10-11')
    expect(url).toContain('includeOverdue=true'); expect(url).toContain('includeCancelled=false')
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it.each([
    ['Task fixture', '/wedding/checklist?wedding=w1&task=t'], ['Payment fixture', '/wedding/payments'], ['Guest fixture', '/wedding/guests'],
  ])('navigates %s to the existing action screen %s', async (name, path) => {
    open(); fireEvent.click(await screen.findByText(name)); expect(screen.getByTestId('location').textContent).toBe(path)
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('isolates a payment failure, avoids false empty claims and retries only that source', async () => {
    failPayments = true; open(); await screen.findByText('Guest fixture'); await screen.findByText('Task fixture')
    const section = within(screen.getByRole('region', { name: 'Платежи этой недели' }))
    await waitFor(() => expect(section.getByRole('alert')).toBeTruthy())
    expect(section.queryByText('Открытых этапов оплаты до конца недели нет.')).toBeNull()
    const before = calls.length; failPayments = false; fireEvent.click(section.getByRole('button', { name: 'Повторить' }))
    await screen.findByText('Payment fixture'); expect(calls.slice(before).map(c => c.path)).toHaveLength(1)
  })
  it.each(['/tasks', '/payment-schedule', '/guests'])('403 in %s is a refusal, not an empty success or retry loop', async path => {
    denied = path; open(); await screen.findByText('Permission fixture denied')
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull()
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('does not show fabricated zero while a source is pending', async () => {
    let finish!: (r: Response) => void
    hold = path => path.endsWith('/guests') ? new Promise(r => { finish = r }) : undefined
    open(); await screen.findByText('Task fixture')
    const section = within(screen.getByRole('region', { name: 'Ожидаемые ответы гостей' }))
    expect(section.getByText('Загружаем…')).toBeTruthy(); expect(section.queryByText(/0 персон/)).toBeNull()
    await act(async () => finish(json(guests)))
    expect(section.getByText('Guest fixture')).toBeTruthy()
  })
  it('shows undated and invalid dates without putting next-week or completed tasks into this week', async () => {
    tasks = [{ id: 'n', title: 'No date', done: false, due: null }, { id: 'b', title: 'Bad date', done: false, due: '2026-02-30' },
      { id: 'f', title: 'Future date', done: false, due: '2026-10-12' }, { id: 'd', title: 'Done date', done: true, due: '2026-10-09' }]
    open(); await screen.findByText('No date'); expect(screen.getByText('Срок нужно уточнить')).toBeTruthy()
    expect(screen.getByText('Срок требует уточнения')).toBeTruthy(); expect(screen.queryByText('Future date')).toBeNull(); expect(screen.queryByText('Done date')).toBeNull()
  })
  it('refuses missing wedding timezone without requesting dated sources or inventing a date', async () => {
    zone = null; open(); await screen.findByRole('alert')
    expect(calls.map(c => c.path)).toEqual(['/api/weddings/w1'])
    expect(screen.queryByTestId('week-range')).toBeNull()
  })
  it.each(['no wedding', 'signed out'])('does not request private sources with %s', async condition => {
    if (condition === 'no wedding') selection.weddingId = null
    else saveTokens(null)
    open(); await screen.findByRole('button', { name: condition === 'no wedding' ? 'Завести свадьбу' : 'Войти' })
    expect(calls).toEqual([])
  })
  it('clears private data on logout and ignores late results', async () => {
    let finish!: (r: Response) => void
    hold = path => path.endsWith('/guests') ? new Promise(r => { finish = r }) : undefined
    open(); await screen.findByText('Task fixture')
    await act(async () => { saveTokens(null); finish(json(guests)) })
    await screen.findByRole('button', { name: 'Войти' })
    expect(screen.queryByText('Task fixture')).toBeNull(); expect(screen.queryByText('Guest fixture')).toBeNull(); expect(screen.queryByText('Payment fixture')).toBeNull()
  })
  it('keeps a reader on same-session token renewal without additional requests', async () => {
    open(); await screen.findByText('Guest fixture'); const before = calls.length
    act(() => saveTokens(token('a', 's', 2100000300)))
    expect(screen.getByText('Guest fixture')).toBeTruthy(); expect(calls).toHaveLength(before)
  })
  it('changes wedding without rendering an old late response', async () => {
    let finish!: (r: Response) => void
    hold = path => path === '/weddings/w1/guests' ? new Promise(r => { finish = r }) : undefined
    const view = open(); await screen.findByText('Task fixture')
    guests = [{ id: 'g2', name: 'New wedding person', status: 'pending' }]; selection.weddingId = 'w2'
    view.rerender(<MemoryRouter><WeeklyAgenda /><Location /></MemoryRouter>)
    await screen.findByText('New wedding person')
    await act(async () => finish(json([{ id: 'old', name: 'Old private person', status: 'pending' }])))
    expect(screen.queryByText('Old private person')).toBeNull()
  })
  it('refreshes all sources explicitly with no mutation', async () => {
    open(); await screen.findByText('Guest fixture'); const before = calls.length
    fireEvent.click(screen.getByRole('button', { name: 'Обновить сводку' })); await screen.findByText('Guest fixture')
    expect(calls.slice(before)).toHaveLength(4); expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('translates the whole agenda and uses English person counts', async () => {
    setI18nLang('en'); guests = Array.from({ length: 21 }, (_, i) => ({ id: `g${i}`, name: `Person ${i}`, status: 'pending' }))
    open(); await screen.findByText('21 people awaiting replies')
    expect(screen.getByRole('heading', { name: 'This week' })).toBeTruthy()
    expect(screen.getByText('These data do not specify a reply deadline. This list is not limited to the current week.')).toBeTruthy()
    expect(screen.queryByText('Срок нужно уточнить')).toBeNull()
  })
})


const prerequisiteId = '10000000-0000-4000-8000-000000000001'
function blockedTask() {
  return { id: 't', title: 'Task fixture', done: false, due: '2026-10-09', dependencyVersion: '1',
    dependencies: [{ id: prerequisiteId, title: 'Confirm menu inputs', done: false }] }
}

describe('weekly task dependencies', () => {
  it('opens the selected task and wedding instead of the default checklist period', async () => {
    tasks = [blockedTask()]
    open(); fireEvent.click(await screen.findByText('Task fixture'))
    expect(screen.getByTestId('location').textContent).toBe('/wedding/checklist?wedding=w1&task=t')
  })
  it('shows an unfinished prerequisite even when it has a later deadline', async () => {
    tasks = [blockedTask(), { id: prerequisiteId, title: 'Confirm menu inputs', done: false, due: '2026-10-12', dependencies: [], dependencyVersion: '0' }]
    open(); await screen.findByText('Task fixture')
    const link = await screen.findByRole('link', { name: 'Confirm menu inputs', exact: true })
    expect(link.getAttribute('href')).toBe(`/wedding/checklist?wedding=w1&task=${prerequisiteId}`)
    expect(screen.getByText('Сначала завершите:')).toBeTruthy()
    expect(screen.getAllByText('Confirm menu inputs')).toHaveLength(1)
    expect(calls.filter(c => c.path.endsWith('/tasks'))).toHaveLength(1)
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('does not call absent metadata an empty or satisfied dependency list', async () => {
    open(); await screen.findByText('Task fixture')
    expect(screen.getByText('Состояние предпосылок не подтверждено. Откройте задачу для проверки.')).toBeTruthy()
    expect(screen.queryByText('Все предпосылки выполнены')).toBeNull()
  })
  it('keeps the checklist section link bound to the selected wedding', async () => {
    open(); await screen.findByText('Task fixture')
    expect(screen.getByRole('link', { name: 'Открыть чек-лист' }).getAttribute('href')).toBe('/wedding/checklist?wedding=w1')
  })
})

describe('weekly prerequisite reading boundaries', () => {
  it('opens the prerequisite, with no nested links and no automatic writes', async () => {
    tasks = [blockedTask()]; open()
    const link = await screen.findByRole('link', { name: 'Confirm menu inputs', exact: true })
    expect(link.parentElement?.closest('a')).toBeNull()
    fireEvent.click(link)
    expect(screen.getByTestId('location').textContent).toBe(`/wedding/checklist?wedding=w1&task=${prerequisiteId}`)
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('shows satisfied prerequisites without exposing any audit reason', async () => {
    const task = blockedTask(); task.dependencies[0].done = true
    tasks = [{ ...task, dependencyOverride: { reason: 'private prior override', at: '2026-10-07T00:00:00Z' } }]
    open(); await screen.findByText('Все предпосылки выполнены')
    expect(screen.queryByText('private prior override')).toBeNull()
    expect(screen.queryByText('Confirm menu inputs')).toBeNull()
  })
  it('keeps task and other source data visible when one dependency response is malformed', async () => {
    tasks = [{ ...blockedTask(), dependencies: [{ id: '../private', title: 'Do not link this', done: false }] }]
    open(); await screen.findByText('Состояние предпосылок не подтверждено. Откройте задачу для проверки.')
    expect(screen.getByText('Task fixture')).toBeTruthy(); await screen.findByText('Payment fixture'); await screen.findByText('Guest fixture')
    expect(screen.queryByText('Do not link this')).toBeNull()
  })
  it('uses English wording and renders prerequisite titles as text, not markup', async () => {
    setI18nLang('en'); const task = blockedTask(); task.dependencies[0].title = '<img src=x onerror=alert(1)>'
    tasks = [task]; open(); await screen.findByText('Complete first:')
    expect(screen.getByRole('list', { name: 'Unfinished prerequisites' })).toBeTruthy()
    expect(screen.getByRole('link', { name: '<img src=x onerror=alert(1)>', exact: true }).querySelector('img')).toBeNull()
  })
  it('refreshes the prerequisite state without a separate dependency request', async () => {
    tasks = [blockedTask()]; open(); await screen.findByText('Confirm menu inputs')
    const before = calls.length; const next = blockedTask(); next.dependencies[0].done = true; tasks = [next]
    fireEvent.click(screen.getByRole('button', { name: 'Обновить сводку' }))
    await screen.findByText('Все предпосылки выполнены')
    expect(screen.queryByText('Confirm menu inputs')).toBeNull()
    expect(calls.slice(before).filter(c => c.path.endsWith('/tasks'))).toHaveLength(1)
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it('removes private prerequisite titles on logout', async () => {
    tasks = [blockedTask()]; open(); await screen.findByText('Confirm menu inputs')
    act(() => saveTokens(null)); await screen.findByRole('button', { name: 'Войти' })
    expect(screen.queryByText('Confirm menu inputs')).toBeNull()
  })
  it('does not restore a previous wedding prerequisite from a late response', async () => {
    let finish!: (r: Response) => void
    hold = path => path === '/weddings/w1/tasks' ? new Promise(r => { finish = r }) : undefined
    const view = open(); await screen.findByText('Guest fixture')
    selection.weddingId = 'w2'; tasks = [{ id: 'new-task', title: 'New wedding task', done: false, due: null, dependencies: [], dependencyVersion: '0' }]
    view.rerender(<MemoryRouter><WeeklyAgenda /><Location /></MemoryRouter>)
    await screen.findByText('New wedding task')
    await act(async () => finish(json([blockedTask()])))
    expect(screen.queryByText('Confirm menu inputs')).toBeNull()
    expect(screen.getByText('New wedding task').closest('a')?.getAttribute('href')).toBe('/wedding/checklist?wedding=w2&task=new-task')
  })
})
