// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider } from './store'
import { Timeline } from '@/pages/Wedding'

type Event = {
  id?: string; name: string; startsAt: string; endsAt?: string; forGuests: boolean;
  outdoor: boolean; timingMode: 'fixed' | 'flexible'; assigneeUserIds: string[];
  dealIds: string[]; dependsOn: { eventId: string; travelMinutes: number; bufferMinutes: number }[];
}
const event = (id: string, name: string): Event => ({
  id, name, startsAt: '2027-06-14T08:00:00.000Z', forGuests: true, outdoor: true,
  timingMode: 'fixed', assigneeUserIds: [], dealIds: [], dependsOn: [],
})
const path = '/weddings/w1/timeline'
const wedding = { id: 'w1', date: '2027-06-14', tz: 'Asia/Yekaterinburg', title: 'Тест' }
const response = (body: unknown, etag?: string, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}) },
})
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T
function server() {
  let events = [event('a', 'Сборы'), event('b', 'Церемония')]
  let version = 1
  let nextId = 0
  let failReads = false
  const writes: { events: Event[]; etag: string | null; status: number }[] = []
  const etag = () => `"timeline-${version}"`
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^\/api/, '').split('?')[0]
    const method = init?.method ?? 'GET'
    if (url === path) {
      if (method === 'GET') return failReads
        ? response({ error: { code: 'internal', message: 'Ошибка чтения' } }, undefined, 500)
        : response(copy(events), etag())
      if (method === 'PUT') {
        const expected = new Headers(init?.headers).get('if-match')
        const body = JSON.parse(String(init?.body)) as Event[]
        const status = expected === etag() ? 200 : 409
        writes.push({ events: copy(body), etag: expected, status })
        if (status === 409) return response({ error: { code: 'timeline_version_conflict', message: 'Конфликт версий' } }, etag(), status)
        events = body.map(e => ({ ...e, id: e.id ?? `new-${++nextId}` }))
        version += 1
        return response(copy(events), etag())
      }
    }
    if (url === `${path}/autogen`) return response({ events: copy(events), conflicts: [] }, etag())
    if (url === '/weddings') return response([{ ...wedding, role: 'couple' }])
    if (url === '/weddings/w1') return response(wedding)
    if (url === '/users/me') return response({ id: 'u1', name: 'Пара', isStaff: false, push: {} })
    if (url === '/me/favorites' || url === '/weddings/w1/slots' || url === '/weddings/w1/members') return response([])
    return response({ error: { code: 'not_found', message: 'Не найдено' } }, undefined, 404)
  }))
  return {
    writes, get events() { return events },
    failReads() { failReads = true },
    externalEdit() { events = events.map(e => ({ ...e, name: e.id === 'a' ? 'Правка партнёра' : e.name })); version += 1 },
  }
}
const mount = async () => {
  render(<MemoryRouter><StoreProvider><Timeline /></StoreProvider></MemoryRouter>)
  await screen.findByText('Церемония')
}
const add = async (name: string) => {
  if (screen.queryByText('Править')) fireEvent.click(screen.getByText('Править'))
  fireEvent.change(screen.getByPlaceholderText('Событие (например, «Первый танец»)'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Начало'), { target: { value: '19:00' } })
  await waitFor(() => expect((screen.getByText('Добавить в тайминг') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('Добавить в тайминг'))
}
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify(wedding.date))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('021: снимок данных не отделяется от своей версии', () => {
  it('повтор применения конфликтного автоплана не получает новую версию из GET', async () => {
    const s = server(); await mount()
    fireEvent.click(screen.getByText(/Собрать автоплан по команде/))
    await screen.findByText('Заменить тайминг')
    s.externalEdit()
    fireEvent.click(screen.getByText('Заменить тайминг'))
    await waitFor(() => expect(s.writes).toHaveLength(1))
    expect(s.writes[0]!.status).toBe(409)
    await screen.findByText('Правка партнёра')
    await waitFor(() => expect((screen.getByText('Заменить тайминг') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Заменить тайминг'))
    await waitFor(() => expect(s.writes).toHaveLength(2))
    expect(s.writes.map(w => w.etag)).toEqual(['"timeline-1"', '"timeline-1"'])
    expect(s.writes[1]!.status).toBe(409)
    expect(s.events[0]!.name).toBe('Правка партнёра')
  })

  it('правка после успешного добавления и отказа refetch сохраняет серверный ID', async () => {
    const s = server(); await mount(); s.failReads()
    await add('Торт')
    await waitFor(() => expect(s.writes).toHaveLength(1))
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    await add('Танец')
    await waitFor(() => expect(s.writes).toHaveLength(2))
    expect(s.writes[1]!.events.find(e => e.name === 'Торт')?.id).toBe('new-1')
  })

  it('изменение соседнего блока сохраняет outdoor и метаданные других событий', async () => {
    const s = server(); await mount()
    fireEvent.click(screen.getByText('Править'))
    fireEvent.click(screen.getAllByLabelText('Показывать гостям')[1]!)
    await waitFor(() => expect(s.writes).toHaveLength(1))
    expect(s.writes[0]!.events[1]).toMatchObject({ id: 'b', outdoor: true, timingMode: 'fixed', dependsOn: [] })
  })
})
