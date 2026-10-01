// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Seating } from '@/pages/Tools'
import { api, reportConsentOutdated, saveTokens, url } from './api/client'
import { forgetOfflineSeating } from './offlineAccess'

const { currentWedding } = vi.hoisted(() => ({ currentWedding: { id: 'w1' } }))
vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: currentWedding.id }) }))
const KEY = 'tt_seating_offline'
function serve(allSeated = true) {
  let down = false
  let rejection = 0
  let role = 'couple'
  let hold: Promise<void> | null = null
  let completed = 0
  const writes: { path: string; body: unknown }[] = []
  const people = [
    { id: 'g1', name: 'Family Alice', partyId: 'p1', partySize: 2, partyPosition: 1, isPrimary: true, plusOne: true, status: 'yes', tableId: 't1', phone: '+79990000001', comment: 'PRIVATE COMMENT', dietNote: 'PRIVATE MEDICAL NOTE' },
    { id: 'g2', name: 'Family Bob', partyId: 'p1', partySize: 2, partyPosition: 2, isPrimary: false, plusOne: false, status: 'pending', tableId: allSeated ? 't1' : null },
  ]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, ''), method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (down) throw new TypeError('Failed to fetch')
    if (rejection) return new Response(JSON.stringify({ error: { code: 'seating_closed', message: 'Seating access refused' } }), { status: rejection, headers: { 'content-type': 'application/json' } })
    if (hold) await hold
    if (method === 'PATCH') { const p = people.find(p => path.endsWith('/' + p.id)); if (p) Object.assign(p, JSON.parse(String(init!.body))) }
    const localPeople = path.includes('/weddings/w2/') ? people.map(p => ({ ...p, id: 'w2-' + p.id, name: 'New wedding ' + p.name, tableId: p.tableId ? 'w2-' + p.tableId : null })) : people
    const tableId = path.includes('/weddings/w2/') ? 'w2-t1' : 't1'
    const body = path.endsWith('/guests') ? localPeople : path.endsWith('/tables') ? [{ id: tableId, name: 'Known table', capacity: 2, guestIds: localPeople.filter(p => p.tableId === tableId).map(p => p.id) }]
      : path.endsWith('/members') ? [{ user: { id: 'u1', name: 'Current member' }, role }] : {}
    completed++
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }))
  return { writes, people,
    completed: () => completed,
    reject: (status: number) => { rejection = status }, role: (value: string) => { role = value },
    hold: (promise: Promise<void> | null) => { hold = promise },
    down: () => { down = true },
    online: () => { down = false; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); fireEvent(window, new Event('online')) },
    offline: () => { down = true; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); fireEvent(window, new Event('offline')) } }
}
const open = () => render(<MemoryRouter><Seating /></MemoryRouter>)
beforeEach(() => {
  currentWedding.id = 'w1'
  localStorage.clear()
  saveTokens({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 's1' }))}.test`, refreshToken: 'r1' })
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('seating actual person-shaped DTO and offline lifecycle', () => {
  it('two explicit family persons occupy two seats, not three through compatibility plusOne', async () => {
    serve(); open(); await screen.findByText('Family Bob')
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.queryByText('+1')).toBeNull()
  })
  it('the second explicit person fits the remaining seat and only its identity is patched', async () => {
    const control = serve(false); open(); await screen.findByText('Family Bob')
    expect(screen.getByText('1/2')).toBeTruthy()
    fireEvent.click(screen.getByText('Family Bob')); fireEvent.click(screen.getByText('Known table'))
    await waitFor(() => expect(control.writes).toEqual([{ path: '/weddings/w1/guests/g2', body: { tableId: 't1' } }]))
    await screen.findByText('2/2')
  })
  it('offline immediately makes the permitted seating read-only and never sends a mutation', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob'); control.offline()
    await screen.findByText(/Актуальность и доступ не проверены/)
    expect(screen.getByText('Family Alice')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Переименовать стол' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
    expect(control.writes).toHaveLength(0)
  })
  it('a warm offline remount restores only the permitted minimal seating copy', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob')
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull())
    const stored = localStorage.getItem(KEY)!
    for (const privateValue of ['PRIVATE COMMENT', 'PRIVATE MEDICAL NOTE', '+79990000001', 'accessToken', 'refreshToken']) expect(stored).not.toContain(privateValue)
    control.offline(); cleanup(); open()
    await screen.findByText('Known table'); expect(screen.getByText('Family Alice')).toBeTruthy()
    expect(screen.getByText('2/2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
  })
  it('reconnection shows no editor until all fresh reads settle and discards the old selection', async () => {
    const control = serve(false); open(); await screen.findByText('Family Bob')
    fireEvent.click(screen.getByText('Family Bob')); control.offline()
    await screen.findByText(/Актуальность и доступ не проверены/)
    let release!: () => void
    control.hold(new Promise<void>(resolve => { release = resolve })); control.online()
    await screen.findByText('Загружаем…')
    expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
    release(); await screen.findByRole('button', { name: 'Добавить стол' })
    fireEvent.click(screen.getByText('Known table')); expect(control.writes).toHaveLength(0)
  })
  it('another session cannot restore or keep the previous session copy', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob'); control.offline()
    saveTokens({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 's2' }))}.test`, refreshToken: 'r2' })
    await screen.findByText('Сохранённой рассадки для этой сессии и свадьбы нет')
    expect(localStorage.getItem(KEY)).toBeNull(); expect(screen.queryByText('Family Alice')).toBeNull()
  })
  it('same-session token refresh retains the permitted copy', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob'); control.offline()
    saveTokens({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 's1', exp: 99999999 }))}.next`, refreshToken: 'r2' })
    await screen.findByText(/Актуальность и доступ не проверены/)
    expect(screen.getByText('Family Alice')).toBeTruthy(); expect(localStorage.getItem(KEY)).not.toBeNull()
  })
  it.each([403, 404, 410])('an actual refusal %s outside the route removes a warm copy', async status => {
    const control = serve(); open(); await screen.findByText('Family Bob'); cleanup()
    control.reject(status)
    await expect(api.get(url('/weddings/{weddingId}/tables', { weddingId: 'w1' }))).rejects.toMatchObject({ status })
    expect(localStorage.getItem(KEY)).toBeNull(); control.offline(); open()
    await screen.findByText('Сохранённой рассадки для этой сессии и свадьбы нет')
    expect(screen.queryByText('Family Alice')).toBeNull()
  })
  it('a known refusal while mounted cannot reopen live controls or repeat automatically', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob')
    control.reject(403)
    await expect(api.get(url('/weddings/{weddingId}/tables', { weddingId: 'w1' }))).rejects.toMatchObject({ status: 403 })
    await screen.findByText('Seating access refused')
    expect(screen.queryByText('Family Alice')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('consent revocation removes the copy and cannot show private guests offline', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob'); reportConsentOutdated(); control.offline()
    await screen.findByText('Сохранённой рассадки для этой сессии и свадьбы нет')
    expect(localStorage.getItem(KEY)).toBeNull(); expect(screen.queryByText('Family Alice')).toBeNull()
  })
  it('a cleanup during in-flight reads cannot resurrect a removed copy', async () => {
    const control = serve(); let release!: () => void
    control.hold(new Promise<void>(resolve => { release = resolve })); open()
    await screen.findByText('Загружаем…'); forgetOfflineSeating('w1'); release()
    await screen.findByText('Доступ изменился — перечитайте рассадку')
    expect(localStorage.getItem(KEY)).toBeNull(); expect(screen.queryByText('Family Alice')).toBeNull()
  })
  it('a vendor role is not a seating cache capability', async () => {
    const control = serve(); control.role('vendor'); open()
    await screen.findByText('Доступ к рассадке не подтверждён')
    expect(localStorage.getItem(KEY)).toBeNull(); expect(screen.queryByText('Family Alice')).toBeNull()
  })
  it('inconsistent independently read tables do not become a saved or editable plan', async () => {
    const control = serve(); control.people[0].tableId = 'other-table'; open()
    await screen.findByText('Гости и столы не согласованы — перечитайте рассадку')
    expect(localStorage.getItem(KEY)).toBeNull(); expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
  })
  it('network failure without an offline event shows the old copy, not a false empty plan', async () => {
    const control = serve(); open(); await screen.findByText('Family Bob'); cleanup(); control.down(); open()
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    expect(screen.getByText('Family Alice')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Добавить стол' })).toBeNull()
  })
  it('a delayed old wedding read cannot overwrite the new wedding copy after route switch', async () => {
    const control = serve(); let release!: () => void
    control.hold(new Promise<void>(resolve => { release = resolve })); const view = open()
    await screen.findByText('Загружаем…')
    control.hold(null); currentWedding.id = 'w2'
    view.rerender(<MemoryRouter><Seating /></MemoryRouter>)
    await screen.findByText('New wedding Family Alice')
    await waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!).weddingId).toBe('w2'))
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)) })
    await waitFor(() => expect(control.completed()).toBe(6))
    expect(JSON.parse(localStorage.getItem(KEY)!).weddingId).toBe('w2')
    expect(screen.getByText('New wedding Family Alice')).toBeTruthy()
  })
  it('unmounted reader cannot save a copy from an abandoned pending route', async () => {
    const control = serve(); let release!: () => void
    control.hold(new Promise<void>(resolve => { release = resolve })); open()
    await screen.findByText('Загружаем…'); cleanup()
    await act(async () => { release(); await new Promise(resolve => setTimeout(resolve, 0)) })
    await waitFor(() => expect(control.completed()).toBe(3))
    expect(localStorage.getItem(KEY)).toBeNull()
  })
})
