// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanB } from '@/pages/Smart'
import { planBPreviewFixture } from '@/test/planBPreviewFixture'
import { saveTokens } from './api/client'
import type { PlanBSettings, PlanBSettingsInput } from './api/weddingWrite'
import { StoreProvider } from './store'

const settings = '/weddings/w1/planb/scenarios/rain'
const preview = '/weddings/w1/planb/preview'
const activate = '/weddings/w1/planb/activate'
const open = () => render(<MemoryRouter><StoreProvider><PlanB /></StoreProvider></MemoryRouter>)
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name), { target: { value } })
const expand = async () => {
  await screen.findByRole('heading', { name: 'План Б' })
  click(/Дождь или непогода на выездной церемонии/)
}
const openEditor = async () => {
  await expand()
  fireEvent.click(await screen.findByRole('button', { name: 'Настроить сценарий' }))
  return screen.findByLabelText('Причина')
}
const session = (id: string) => saveTokens({
  accessToken: `e30.${btoa(JSON.stringify({ sub: id, sid: 'session-' + id }))}.test`, refreshToken: 'refresh-' + id,
})
const connection = (online: boolean) => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: online })
  window.dispatchEvent(new Event(online ? 'online' : 'offline'))
}

function serve(options: { allowed?: boolean; plan?: PlanBSettings; active?: boolean } = {}) {
  let plan = options.plan ?? null
  let conflict = false
  let applied = options.active === true
  const writes: PlanBSettingsInput[] = [], requests: { method: string; path: string }[] = []
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  })
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0]!
    const method = init?.method ?? 'GET'
    requests.push({ path, method })
    if (path === settings && method === 'GET') return reply({ plan })
    if (path === settings && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as PlanBSettingsInput
      writes.push(body)
      if (conflict) {
        conflict = false
        return reply({ error: { code: 'planb_scenario_changed', message: 'Сценарий изменился' } }, 409)
      }
      const { expectedRevision, ...fields } = body
      plan = { ...fields, revision: expectedRevision === 'revision-1' ? 'revision-2' : 'revision-1' }
      applied = false
      return reply({ plan })
    }
    if (path === preview) return reply(planBPreviewFixture({ currentScenario: options.active ? 'rain' : null,
      alreadyActive: applied, reserveAddress: plan?.reserveAddress ?? null }))
    if (path === activate) { applied = true; return reply({ activationId: 'active', scenario: 'rain', guestsAffected: 1 }) }
    if (path === '/weddings/w1/planb') return reply({ checklist: [], canActivate: options.allowed !== false,
      scenario: options.active ? 'rain' : null, activatedAt: options.active ? '2027-06-14T08:00:00Z' : null })
    if (path === '/weddings/w1/members') return reply([{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }])
    if (path === '/weddings') return reply([{ id: 'w1', title: 'Свадьба', date: '2027-06-14', role: options.allowed === false ? 'helper' : 'couple' }])
    return reply([])
  })
  vi.stubGlobal('fetch', fetcher)
  return { writes, requests, changeOnServer: (next: PlanBSettings) => { plan = next; conflict = true } }
}

const existing = {
  revision: 'revision-1', reason: 'Дождь', triggerCondition: 'Сильный дождь',
  reserveAddress: null, actions: [{ title: 'Встретить гостей', responsibleUserId: 'u1' }], contacts: [],
}

describe('Plan B scenario editor', () => {
  beforeEach(() => {
    localStorage.clear()
    session('u1')
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    connection(true)
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); connection(true) })

  it('saves the complete plan and reads it back without storing private fields locally', async () => {
    const { writes } = serve()
    open()
    await openEditor()
    fill('Причина', '  Гроза  ')
    fill('Когда включать', 'Гроза у площадки')
    fill('Резервный адрес или точка сбора', 'Зал 2')
    fill('Что сделать', 'Встретить гостей')
    fill('Ответственный', 'u1')
    click('Добавить действие')
    fireEvent.click(within(screen.getByRole('group', { name: 'Действие 2' })).getByRole('button', { name: 'Убрать действие' }))
    click('Добавить контакт')
    fill('К кому обратиться', 'Администратор')
    fill('Телефон или другой контакт', 'private@example.test')
    click('Сохранить сценарий')
    await screen.findByText('Сценарий сохранён.')
    expect(writes).toEqual([{ expectedRevision: null, reason: 'Гроза', triggerCondition: 'Гроза у площадки',
      reserveAddress: 'Зал 2', actions: [{ title: 'Встретить гостей', responsibleUserId: 'u1' }],
      contacts: [{ label: 'Администратор', value: 'private@example.test' }] }])
    click('Закрыть')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Настроить сценарий' }))
    click('Настроить сценарий')
    expect(await screen.findByDisplayValue('private@example.test')).toBeTruthy()
    expect(JSON.stringify(localStorage)).not.toContain('private@example.test')
  })

  it('preserves the draft on conflict and uses the latest revision only after explicit reload', async () => {
    const api = serve({ plan: existing })
    open()
    await openEditor()
    api.changeOnServer({ ...existing, revision: 'parallel-revision', reason: 'Правка координатора' })
    fill('Причина', 'Мой черновик')
    click('Сохранить сценарий')
    await screen.findByText(/Загрузка актуальной версии заменит/)
    expect(screen.getByDisplayValue('Мой черновик')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Сохранить сценарий' })).toHaveProperty('disabled', true)
    click('Загрузить актуальную версию')
    await screen.findByDisplayValue('Правка координатора')
    click('Сохранить сценарий')
    await screen.findByText('Сценарий сохранён.')
    expect(api.writes.map(write => write.expectedRevision)).toEqual(['revision-1', 'parallel-revision'])
    expect(api.writes[1]?.reserveAddress).toBeNull()
  })

  it('opens the active version read-only and requires a fresh confirmation after editing', async () => {
    const api = serve({ plan: existing, active: true })
    open()
    await expand()
    fireEvent.click(await screen.findByRole('button', { name: 'Проверить версию сценария' }))
    const snapshot = await screen.findByRole('region', { name: 'Предпросмотр Плана Б' })
    expect(within(snapshot).getByText(/Эта версия уже включена/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Подтвердить' })).toBeNull()
    click('Настроить сценарий')
    await screen.findByLabelText('Причина')
    fill('Резервный адрес или точка сбора', 'Новая точка')
    click('Сохранить сценарий')
    await screen.findByText('Сценарий сохранён.')
    click('Закрыть')
    click('Проверить версию сценария')
    await screen.findByText('Новая точка')
    expect(api.requests.filter(request => request.path === activate)).toHaveLength(0)
    click('Подтвердить')
    await waitFor(() => expect(api.requests.filter(request => request.path === activate)).toHaveLength(1))
  })

  it('does not request scenario data for a helper', async () => {
    const api = serve({ allowed: false })
    open()
    await expand()
    await waitFor(() => expect(api.requests.some(request => request.path === '/weddings/w1/planb')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Настроить сценарий' })).toBeNull()
    expect(api.requests.filter(request => request.path === settings)).toHaveLength(0)
  })

  it('closes private fields offline and on a session change', async () => {
    const api = serve({ plan: { ...existing, contacts: [{ label: 'Координатор', value: 'private@example.test' }] } })
    open()
    await openEditor()
    expect(screen.getByDisplayValue('private@example.test')).toBeTruthy()
    act(() => connection(false))
    expect(screen.queryByDisplayValue('private@example.test')).toBeNull()
    act(() => connection(true))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Настроить сценарий' })).toHaveProperty('disabled', false))
    expect(screen.queryByDisplayValue('private@example.test')).toBeNull()
    click('Настроить сценарий')
    await screen.findByDisplayValue('private@example.test')
    act(() => session('u2'))
    expect(screen.queryByDisplayValue('private@example.test')).toBeNull()
    expect(api.writes).toHaveLength(0)
  })
})
