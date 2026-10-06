// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { Checklist } from '@/pages/Wedding'
import { StoreProvider } from './store'
import { saveTokens } from './api/client'
import { setI18nLang } from './i18n'
import type { components } from './api/schema'

const W = '20000000-0000-4000-8000-000000000001'
const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002'
const USER = '30000000-0000-4000-8000-000000000001'
let tasks: components['schemas']['Task'][]
let role: string, failure: string | null
let writes: { path: string; body: Record<string, unknown> }[]
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!, method = init?.method ?? 'GET'
    if (method !== 'GET') {
      const body = JSON.parse(String(init?.body ?? '{}')); writes.push({ path, body })
      if (failure) return json({ error: { code: 'task_dependencies_changed', message: failure } }, 409)
      const task = tasks.find(t => path === `/weddings/${W}/tasks/${t.id}`)
      if (!task) return json({ error: { message: 'Unexpected write' } }, 500)
      if (body.dependsOn) {
        task.dependencies = tasks.filter(t => body.dependsOn.includes(t.id)).map(t => ({ id: t.id!, title: t.title!, done: t.done! }))
        task.dependencyVersion = String(Number(task.dependencyVersion) + 1)
      }
      if ('done' in body) task.done = body.done
      if (body.dependencyOverride) task.dependencyOverride = { reason: body.dependencyOverride.reason, at: '2026-10-06T10:00:00Z' }
      return json(task)
    }
    const wedding = { id: W, title: 'Test wedding', date: '2027-06-14', tz: 'Europe/Moscow', role }
    if (path === '/weddings') return json([wedding])
    if (path === `/weddings/${W}`) return json(wedding)
    if (path === '/users/me') return json({ id: USER, name: 'Test participant' })
    if (path === `/weddings/${W}/members`) return json([{ user: { id: USER, name: 'Test participant' }, role }])
    if (path === `/weddings/${W}/tasks`) return json(tasks)
    return json([])
  }))
}
const open = () => render(<MemoryRouter><StoreProvider><Checklist /></StoreProvider></MemoryRouter>)
const menu = () => screen.getByRole('button', { name: /^Final menu/ })
beforeEach(() => {
  localStorage.clear(); setI18nLang('ru'); localStorage.setItem('tt_onboarded', '1')
  saveTokens({ accessToken: 'test-session-a', refreshToken: 'test-refresh-a' })
  localStorage.setItem('tt_wedding_id', JSON.stringify(W)); localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
  role = 'couple'; failure = null; writes = []
  const base = { period: '9', done: false, custom: true, due: null, dueMode: 'fixed' as const, assignee: null, dependencyOverride: null }
  tasks = [{ ...base, id: A, title: 'Guest replies', dependencies: [], dependencyVersion: '0' },
    { ...base, id: B, title: 'Final menu', dependencies: [{ id: A, title: 'Guest replies', done: false }], dependencyVersion: '1' }]
  serve()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru'); localStorage.clear() })

describe('FR005 checklist and real API client with controlled HTTP', () => {
  it('opens dependency explanation instead of silently completing a blocked task', async () => {
    open(); await screen.findByRole('button', { name: /^Final menu/ })
    fireEvent.click(within(menu().parentElement!).getByRole('button', { name: 'Отметить выполненной' }))
    expect(screen.getByRole('region', { name: 'Зависимости задачи' })).toBeTruthy()
    expect(screen.getByText('Сначала завершите:')).toBeTruthy(); expect(writes).toEqual([])
  })
  it('submits the explicit reason and exact blockers, then reloads the shared list', async () => {
    open(); await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByLabelText('Причина ручного решения')
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Confirmed with caterer' } })
    fireEvent.click(screen.getByText('Завершить с указанной причиной'))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ path: `/weddings/${W}/tasks/${B}`, body: { done: true, dependencyVersion: '1', dependencyOverride: { reason: 'Confirmed with caterer', prerequisiteIds: [A] } } })
    await screen.findByText(/Причина ручного завершения: Confirmed with caterer/)
    expect(tasks[1]!.done).toBe(true)
  })
  it('stores removal through PATCH, not just local checkbox state', async () => {
    open(); await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByText('Изменить зависимости'); fireEvent.click(screen.getByText('Изменить зависимости'))
    fireEvent.click(screen.getByLabelText('Guest replies')); fireEvent.click(screen.getByText('Сохранить зависимости'))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]!.body).toEqual({ dependsOn: [], dependencyVersion: '1' })
    await screen.findByText('Предпосылки не заданы')
  })
  it('keeps a failed decision visible and offers an explicit reload', async () => {
    failure = 'Зависимости изменились. Обновите задачи перед сохранением'
    open(); await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByLabelText('Причина ручного решения')
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Do not lose draft' } })
    fireEvent.click(screen.getByText('Завершить с указанной причиной'))
    await screen.findByRole('alert'); expect((screen.getByLabelText('Причина ручного решения') as HTMLTextAreaElement).value).toBe('Do not lose draft')
    expect(tasks[1]!.done).toBe(false); expect(screen.getByText('Обновить задачи и зависимости')).toBeTruthy()
  })
  it('does not offer manual completion or dependency mutation to a helper', async () => {
    role = 'helper'; open(); await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByText('Ручное завершение при незакрытых предпосылках подтверждает пара.')
    expect(screen.queryByLabelText('Причина ручного решения')).toBeNull(); expect(screen.queryByText('Изменить зависимости')).toBeNull()
  })
  it('clears the dependency decision draft on account/session change', async () => {
    open(); await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByLabelText('Причина ручного решения')
    fireEvent.change(screen.getByLabelText('Причина ручного решения'), { target: { value: 'Old session decision' } })
    saveTokens({ accessToken: 'test-session-b', refreshToken: 'test-refresh-b' })
    await waitFor(() => expect(screen.queryByDisplayValue('Old session decision')).toBeNull())
    expect(writes).toEqual([])
  })
  it('uses translated dependency actions in the English checklist', async () => {
    localStorage.setItem('tt_lang', 'en'); setI18nLang('en'); open()
    await screen.findByRole('button', { name: /^Final menu/ }); fireEvent.click(menu())
    await screen.findByLabelText('Reason for the manual decision')
    expect(screen.getByRole('button', { name: 'Complete with this reason' })).toBeTruthy()
  })
})
