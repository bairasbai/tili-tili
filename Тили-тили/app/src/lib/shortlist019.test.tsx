// @vitest-environment jsdom
/*
 * T020 / T015–T019 — экранные приёмки короткого списка.
 * Реальные страницы, StoreProvider, Router и API client; сеть строго задана
 * таблицей ниже. Неизвестный маршрут отвечает 404 и остаётся в журнале.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreProvider } from '@/lib/store'
import { VendorDetail } from '@/pages/Search'
import { WeddingTeam, SlotDetail } from '@/pages/Wedding'
import { Compare } from '@/pages/Smart'

type Reply = unknown | { __status: number; body: unknown }
type Call = { method: string; path: string; url: string; body: unknown }
type RouteTable = Record<string, Reply | ((call: Call) => Reply | Promise<Reply>)>

const WEDDING = {
  id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14',
  city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg',
  members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }],
}
const SLOT = { id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'empty', deal: null }
const VENDOR = {
  id: 'v1', name: 'Анна Фотограф', categoryId: 'photo', city: 'Уфа',
  priceFrom: { amount: 120000, currency: 'RUB' }, rating: 4.9, reviewsCount: 7,
  photoUrl: null, verified: true, hasVideo: false, about: 'Снимаю свадьбы',
  packages: [{ id: 'p1', name: 'День целиком', price: { amount: 250000, currency: 'RUB' }, includes: ['8 часов', 'Готовые фото'] }],
  gallery: [], media: [],
}

function entry(id: string, vendorId: string, name: string, position: number, occupancy: 'free' | 'held' | 'busy' | null, patch: Record<string, unknown> = {}) {
  const vendor = vendorId ? {
    id: vendorId, name, categoryId: 'photo', city: 'Уфа',
    priceFrom: { amount: 100000 + position * 10000, currency: 'RUB' },
    rating: position === 1 ? 4.8 : null, reviewsCount: position === 1 ? 5 : 2,
    photoUrl: null, verified: true, hasVideo: false,
    packages: [{ id: `pkg-${id}`, name: `Пакет ${name}`, price: position === 2 ? null : { amount: 200000 + position * 10000, currency: 'RUB' }, includes: [`Состав ${name}`] }],
  } : null
  return { id, slotId: 's1', position, createdAt: '2026-09-27T10:00:00.000Z', available: vendor ? true : null, occupancy, vendor, ...patch }
}

const E1 = entry('e1', 'v1', 'Анна Фотограф', 1, 'free')
const E2 = entry('e2', 'v2', 'Борис Фото', 2, 'held')
const E3 = entry('e3', 'v3', 'Вера Фото', 3, 'busy')
const NO_OCCUPANCY = entry('e4', 'v4', 'Глеб Фото', 2, null)

const withStatus = (status: number, body: unknown): Reply => ({ __status: status, body })
const isStatus = (reply: unknown): reply is { __status: number; body: unknown } =>
  typeof reply === 'object' && reply !== null && '__status' in reply && typeof reply.__status === 'number'
const jsonResponse = (body: unknown, status = 200) => new Response(
  status === 204 ? null : JSON.stringify(body),
  { status, headers: { 'content-type': 'application/json' } },
)

function serve(routes: RouteTable) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(url.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, url, body }
    calls.push(call)
    const route = routes[`${call.method} ${path}`] ?? routes[path]
    if (route === undefined) {
      return Promise.resolve(jsonResponse({ error: { code: 'not_found', message: `UNEXPECTED ${call.method} ${path}` } }, 404))
    }
    const result = typeof route === 'function' ? (route as (c: Call) => Reply | Promise<Reply>)(call) : route
    return Promise.resolve(result).then(reply => {
      if (reply instanceof Response) return reply
      if (isStatus(reply))
        return jsonResponse(reply.body, reply.__status)
      return jsonResponse(reply)
    })
  }))
  return calls
}

function baseRoutes(overrides: RouteTable = {}): RouteTable {
  return {
    '/weddings': [{ ...WEDDING, role: 'couple' }],
    '/weddings/w1': WEDDING,
    '/weddings/w1/slots': [SLOT],
    '/weddings/w1/budget': { total: { amount: 0, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, categories: [] },
    '/weddings/w1/tips': { items: [] },
    '/me/favorites': [],
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    '/catalog/vendors/v1': VENDOR,
    '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
    '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
    '/catalog/vendors': { items: [], nextCursor: null },
    '/vendor/profile': withStatus(404, { error: { code: 'not_found', message: 'Анкета не найдена' } }),
    '/weddings/w1/slots/s1/shortlist': [],
    ...overrides,
  }
}

function signedIn() {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}

function mount(route: string, routes: RouteTable) {
  const calls = serve(baseRoutes(routes))
  const view = render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        <Routes>
          <Route path="/vendor/:id" element={<VendorDetail />} />
          <Route path="/wedding" element={<WeddingTeam />} />
          <Route path="/wedding/slot/:id" element={<SlotDetail />} />
          <Route path="/compare" element={<Compare />} />
        </Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
  return { ...view, calls }
}

const text = (view: { container: HTMLElement }) => view.container.textContent ?? ''
const shortlistPath = '/weddings/w1/slots/s1/shortlist'

beforeEach(signedIn)
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('shortlist019 · кандидаты и сравнение', () => {
  it('T1: до ответа список неизвестен («—»), после ответа — кандидаты и все выбраны', async () => {
    let resolveList!: (response: Response) => void
    const held = new Promise<Response>(resolve => { resolveList = resolve })
    const view = mount('/wedding/slot/s1', {
      [`GET ${shortlistPath}`]: () => held,
    })
    const region = await screen.findByRole('region', { name: 'Кандидаты' })
    await waitFor(() => expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(true))
    expect(within(region).getByText('—')).toBeTruthy()
    expect(within(region).queryByText('0 / 3')).toBeNull()
    expect(within(region).queryByText(/Анна Фотограф/)).toBeNull()

    resolveList(jsonResponse([E1, E2]))
    expect(await within(region).findByText('2 / 3')).toBeTruthy()
    expect((within(region).getByRole('checkbox', { name: 'Сравнить кандидата Анна Фотограф' }) as HTMLInputElement).checked).toBe(true)
    expect((within(region).getByRole('checkbox', { name: 'Сравнить кандидата Борис Фото' }) as HTMLInputElement).checked).toBe(true)
  })

  it('T2: URL e3,e1 показывает ровно эти колонки в серверном порядке; своя дата free, пакеты и отзывы честные', async () => {
    const view = mount('/compare?slot=s1&entries=e3,e1', {
      [shortlistPath]: [E3, E2, E1],
    })
    const table = await screen.findByRole('table')
    await waitFor(() => expect(text(view)).toContain('Состав Анна Фотограф'))
    const headers = within(table).getAllByRole('columnheader').map(th => th.textContent ?? '')
    expect(headers[0]).toBe('')
    expect(headers.slice(1).map(header => header.replace('📷', ''))).toEqual(['Анна Фотограф', 'Вера Фото'])
    expect(text(view)).not.toContain('Борис Фото')
    expect(text(view)).toContain('Свободен')
    expect(text(view)).toContain('Занят на вашу дату')
    expect(text(view)).toContain('Пакет Анна Фотограф')
    expect(text(view)).toContain('Состав Анна Фотограф')
    expect(text(view)).toContain('★ 4.8')
    expect(text(view)).toContain('5 отзывов')
    const availability = within(table).getByRole('row', { name: /Свободен на вашу дату/ })
    expect(within(availability).getAllByText('Свободен')).toHaveLength(1)
    expect(view.calls.some(c => c.path === '/catalog/vendors/v1/availability')).toBe(false)
  })

  it('T3: из анкеты «В кандидаты» → «Уже в кандидатах» → место → таблица не более чем за 4 клика', async () => {
    const current = [E2, E3]
    const newEntry = entry('e4', 'v1', 'Анна Фотограф', 1, 'free')
    const view = mount('/vendor/v1', {
      [shortlistPath]: () => current,
      [`PUT /weddings/w1/shortlist/v1`]: () => {
        current.push(newEntry)
        return newEntry
      },
    })
    await screen.findByRole('button', { name: 'В кандидаты' })
    let clicks = 0
    const click = (button: HTMLElement) => { clicks += 1; fireEvent.click(button) }
    click(screen.getByRole('button', { name: 'В кандидаты' }))
    await screen.findByRole('button', { name: '✓ Уже в кандидатах' })
    click(screen.getByRole('button', { name: '✓ Уже в кандидатах' }))
    const compare = await screen.findByRole('button', { name: 'Сравнить (3)' })
    expect((screen.getByRole('checkbox', { name: 'Сравнить кандидата Анна Фотограф' }) as HTMLInputElement).checked).toBe(true)
    click(compare)
    await screen.findByRole('table')
    expect(clicks).toBeLessThanOrEqual(4)
    expect(view.calls.filter(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1')).toHaveLength(1)
  })

  it('T4: shortlist_full открывает явный выбор; повторный PUT атомарно заменяет entryId', async () => {
    const existing = [
      entry('f1', 'v2', 'Борис Фото', 1, 'held'),
      entry('f2', 'v3', 'Вера Фото', 2, 'busy'),
      entry('f3', 'v4', 'Дина Фото', 3, 'free'),
    ]
    const added = entry('f4', 'v1', 'Анна Фотограф', 1, 'free')
    let putCount = 0
    const view = mount('/vendor/v1', {
      [shortlistPath]: () => existing,
      [`PUT /weddings/w1/shortlist/v1`]: (call: Call) => {
        putCount += 1
        if (putCount === 1) {
          expect(call.body).toEqual({})
          return withStatus(409, { error: { code: 'shortlist_full', message: 'В кандидатах уже три подрядчика', details: { shortlist: existing } } })
        }
        expect(call.body).toEqual({ replaceEntryId: 'f1' })
        existing.splice(existing.findIndex(e => e.id === 'f1'), 1)
        existing.push(added)
        return added
      },
    })
    await waitFor(() => expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: 'В кандидаты' }))
    await waitFor(() => expect(view.calls.some(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1')).toBe(true))
    await waitFor(() => expect(screen.queryByRole('dialog') || screen.queryByRole('alert')).not.toBeNull())
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Место заполнено')).toBeTruthy()
    expect(dialog.textContent).toContain('Анна Фотограф')
    expect(view.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    fireEvent.click(within(dialog).getByRole('button', { name: /Борис Фото/ }))
    await screen.findByRole('button', { name: '✓ Уже в кандидатах' })
    const mutations = view.calls.filter(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1' || c.method === 'DELETE')
    expect(mutations.map(c => [c.method, c.path, c.body])).toEqual([
      ['PUT', '/weddings/w1/shortlist/v1', {}],
      ['PUT', '/weddings/w1/shortlist/v1', { replaceEntryId: 'f1' }],
    ])
    expect(existing.map(candidate => candidate.id)).toEqual(['f2', 'f3', 'f4'])
  })

  it('T5: сравнение различает held, busy и неизвестную занятость; пакет без цены не превращается в ноль', async () => {
    const view = mount('/compare?slot=s1&entries=e1,e2,e3', {
      [shortlistPath]: [E1, E2, E3],
    })
    await screen.findByRole('table')
    expect(text(view)).toContain('Идут переговоры с другой парой')
    expect(text(view)).toContain('Занят на вашу дату')
    expect(text(view)).toContain('цена не названа')
    expect(within(screen.getByRole('table')).queryByText('0 ₽', { exact: true })).toBeNull()

    cleanup()
    signedIn()
    const unknown = mount('/compare?slot=s1&entries=e1,e4', { [shortlistPath]: [E1, NO_OCCUPANCY] })
    await screen.findByRole('table')
    const availabilityRow = within(screen.getByRole('table')).getByRole('row', { name: /Свободен на вашу дату/ })
    expect(within(availabilityRow).getAllByText('—')).toHaveLength(1)
    expect(text(unknown)).not.toContain('Занят на вашу дату')
  })

  it('T6: профиль без цены пишет «цена не названа»; помощнику сообщает про незаведённое место', async () => {
    const noPrice = { ...VENDOR, packages: [{ id: 'p0', name: 'По запросу', price: null, includes: ['Обсудим состав'] }] }
    const helperRoutes: RouteTable = {
      '/weddings': [{ ...WEDDING, role: 'helper' }],
      '/weddings/w1/slots': [],
      '/catalog/vendors/v1': noPrice,
    }
    const view = mount('/vendor/v1', helperRoutes)
    expect(await screen.findByText('цена не названа')).toBeTruthy()
    expect(text(view)).toContain('Сначала пара должна добавить это место в свадьбу')
    expect(screen.queryByRole('button', { name: 'В кандидаты' })).toBeNull()
  })

  it('T7: координатор видит кандидата и может открыть место, но не добавляет и не удаляет', async () => {
    const view = mount('/vendor/v1', {
      '/weddings': [{ ...WEDDING, role: 'coordinator' }],
      [shortlistPath]: [E1],
    })
    const already = await screen.findByRole('button', { name: '✓ Уже в кандидатах' })
    fireEvent.click(already)
    await screen.findByRole('region', { name: 'Кандидаты' })
    expect(screen.queryByRole('button', { name: 'В кандидаты' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Убрать кандидата/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Забронировать кандидата/ })).toBeNull()
    expect(view.calls.some(c => c.method === 'PUT' || c.method === 'DELETE')).toBe(false)
  })

  it('T8: старое deal-state на мозаике по-прежнему «Не связывались», не shortlist-статус', async () => {
    const candidateDealSlot = { ...SLOT, tileState: 'candidate', deal: { id: 'd-candidate', state: 'candidate', externalName: null, price: null, paid: { amount: 0, currency: 'RUB' } } }
    const view = mount('/wedding', { '/weddings/w1/slots': [candidateDealSlot] })
    const tile = await screen.findByRole('button', { name: /Фотограф/ })
    expect(within(tile).getByText('Не связывались')).toBeTruthy()
    expect(tile.textContent).not.toContain('Кандидаты')
    expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(false)
  })

  it('T9: недоступная анкета и tombstone названы честно; tombstone удаляется по entryId', async () => {
    const hidden = entry('h1', 'v-hidden', 'Скрытая анкета', 1, null, { available: false })
    const tombstone = entry('t1', '', 'Удалённая анкета', 2, null, { available: null, vendor: null })
    const current = [hidden, tombstone]
    const view = mount('/wedding/slot/s1', {
      [shortlistPath]: () => current,
      [`DELETE ${shortlistPath}/t1`]: () => {
        current.splice(current.findIndex(candidate => candidate.id === 't1'), 1)
        return withStatus(204, null)
      },
    })
    const region = await screen.findByRole('region', { name: 'Кандидаты' })
    expect(await within(region).findByText(/1\. Скрытая анкета/)).toBeTruthy()
    expect(within(region).getAllByText('Анкета недоступна')).toHaveLength(1)
    expect(within(region).getByRole('button', { name: 'Убрать кандидата 2: Анкета недоступна' })).toBeTruthy()
    expect(within(region).queryByRole('checkbox')).toBeNull()
    fireEvent.click(within(region).getByRole('button', { name: /Убрать кандидата 2: Анкета недоступна/ }))
    await waitFor(() => expect(view.calls.some(c => c.method === 'DELETE' && c.path === `${shortlistPath}/t1`)).toBe(true))
    await waitFor(() => expect(within(region).queryByText('2. Анкета недоступна')).toBeNull())
    expect(view.calls.find(c => c.method === 'DELETE')?.path).toBe(`${shortlistPath}/t1`)
    expect(within(region).getAllByText('Анкета недоступна')).toHaveLength(1)
  })

  it('T10: stale exact compare URL не подставляет другие записи и возвращает на место', async () => {
    const view = mount('/compare?slot=s1&entries=stale-entry,e1', {
      [shortlistPath]: [E1, E2, E3],
    })
    expect(await screen.findByText('Выбранные кандидаты изменились — отметьте их снова на месте в команде')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(text(view)).not.toContain('Борис Фото')
    fireEvent.click(screen.getByRole('button', { name: 'Открыть место в команде' }))
    expect(await screen.findByRole('region', { name: 'Кандидаты' })).toBeTruthy()
    expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(true)
  })

  it('T11: stale replaceEntryId никого не удаляет и обновляет chooser свежей тройкой', async () => {
    const existing = [
      entry('f1', 'v2', 'Борис Фото', 1, 'held'),
      entry('f2', 'v3', 'Вера Фото', 2, 'busy'),
      entry('f3', 'v4', 'Дина Фото', 3, 'free'),
    ]
    const fresh = [existing[0]!, existing[2]!, entry('f5', 'v5', 'Глеб Фото', 2, 'free')]
    let putCount = 0
    const view = mount('/vendor/v1', {
      [shortlistPath]: () => existing,
      [`PUT /weddings/w1/shortlist/v1`]: (call: Call) => {
        putCount += 1
        if (putCount === 1) {
          expect(call.body).toEqual({})
          return withStatus(409, { error: { code: 'shortlist_full', message: 'В кандидатах уже три подрядчика', details: { shortlist: existing } } })
        }
        expect(call.body).toEqual({ replaceEntryId: 'f2' })
        return withStatus(409, { error: { code: 'shortlist_full', message: 'Кандидаты изменились', details: { shortlist: fresh } } })
      },
    })
    await waitFor(() => expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: 'В кандидаты' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Вера Фото/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Кандидаты изменились')
    const updatedDialog = screen.getByRole('dialog')
    expect(within(updatedDialog).getByText('Место заполнено')).toBeTruthy()
    expect(within(updatedDialog).getByRole('button', { name: /Борис Фото/ })).toBeTruthy()
    expect(within(updatedDialog).getByRole('button', { name: /Дина Фото/ })).toBeTruthy()
    expect(within(updatedDialog).getByRole('button', { name: /Глеб Фото/ })).toBeTruthy()
    expect(within(updatedDialog).queryByRole('button', { name: /Вера Фото/ })).toBeNull()
    await waitFor(() => expect(view.calls.filter(c => c.method === 'GET' && c.path === shortlistPath).length).toBeGreaterThanOrEqual(2))
    expect(view.calls.filter(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1').map(c => c.body)).toEqual([{}, { replaceEntryId: 'f2' }])
    expect(view.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(existing.map(candidate => candidate.id)).toEqual(['f1', 'f2', 'f3'])
  })

  it('T12: помощник в заведённом месте может добавить и убрать кандидата', async () => {
    const current: ReturnType<typeof entry>[] = []
    const added = entry('h2', 'v1', 'Анна Фотограф', 1, 'free')
    const view = mount('/vendor/v1', {
      '/weddings': [{ ...WEDDING, role: 'helper' }],
      [shortlistPath]: () => current,
      [`PUT /weddings/w1/shortlist/v1`]: () => {
        current.push(added)
        return added
      },
      [`DELETE ${shortlistPath}/h2`]: () => {
        current.splice(current.findIndex(candidate => candidate.id === 'h2'), 1)
        return withStatus(204, null)
      },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'В кандидаты' }))
    fireEvent.click(await screen.findByRole('button', { name: '✓ Уже в кандидатах' }))
    const region = await screen.findByRole('region', { name: 'Кандидаты' })
    fireEvent.click(within(region).getByRole('button', { name: /Убрать кандидата 1: Анна Фотограф/ }))
    await waitFor(() => expect(view.calls.some(c => c.method === 'DELETE' && c.path === `${shortlistPath}/h2`)).toBe(true))
    expect(await within(region).findByText('Кандидатов пока нет — добавьте их из каталога')).toBeTruthy()
    expect(view.calls.some(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1')).toBe(true)
  })

  it('T13: при гонке атомарный replace PUT проходит одним запросом и без DELETE', async () => {
    const existing = [
      entry('r1', 'v2', 'Борис Фото', 1, 'held'),
      entry('r2', 'v3', 'Вера Фото', 2, 'busy'),
      entry('r3', 'v4', 'Дина Фото', 3, 'free'),
    ]
    const added = entry('r4', 'v1', 'Анна Фотограф', 1, 'free')
    let putCount = 0
    const view = mount('/vendor/v1', {
      [shortlistPath]: () => existing,
      [`PUT /weddings/w1/shortlist/v1`]: (call: Call) => {
        putCount += 1
        if (putCount === 1) {
          expect(call.body).toEqual({})
          return withStatus(409, { error: { code: 'shortlist_full', message: 'В кандидатах уже три подрядчика', details: { shortlist: existing } } })
        }
        expect(call.body).toEqual({ replaceEntryId: 'r1' })
        existing.splice(existing.findIndex(candidate => candidate.id === 'r1'), 1)
        existing.push(added)
        return added
      },
    })
    await waitFor(() => expect(view.calls.some(c => c.method === 'GET' && c.path === shortlistPath)).toBe(true))
    fireEvent.click(await screen.findByRole('button', { name: 'В кандидаты' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Борис Фото/ }))
    await screen.findByRole('button', { name: '✓ Уже в кандидатах' })
    const puts = view.calls.filter(c => c.method === 'PUT' && c.path === '/weddings/w1/shortlist/v1')
    expect(puts).toHaveLength(2)
    expect(puts.map(c => c.body)).toEqual([{}, { replaceEntryId: 'r1' }])
    expect(view.calls.filter(c => c.method === 'DELETE')).toHaveLength(0)
    expect(existing.map(candidate => candidate.id)).toEqual(['r2', 'r3', 'r4'])
  })

  it('T14: без сессии открытый slot compare просит войти вместо вечной загрузки', async () => {
    localStorage.removeItem('tt_auth')
    const view = mount('/compare?slot=s1&entries=e1,e2', {})
    expect(await screen.findByText('Войдите, чтобы увидеть свою свадьбу')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Войти' })).toBeTruthy()
    expect(text(view)).not.toContain('Загружаем…')
  })

  it('T15: слот, автоматически созданный при PUT, становится ссылкой только после refreshSlots', async () => {
    let releaseSlots!: (response: Response) => void
    const refreshedSlots = new Promise<Response>(resolve => { releaseSlots = resolve })
    let slotReads = 0
    const created = entry('auto1', 'v1', 'Анна Фотограф', 1, null, { slotId: 's-auto' })
    const view = mount('/vendor/v1', {
      '/weddings/w1/slots': () => {
        slotReads += 1
        return slotReads === 1 ? [] : refreshedSlots
      },
      '/weddings/w1/slots/s-auto/shortlist': [created],
      [`PUT /weddings/w1/shortlist/v1`]: created,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'В кандидаты' }))
    expect((await screen.findByRole('status')).textContent).toContain('Добавлено — обновляем место…')
    expect(screen.queryByRole('button', { name: '✓ Уже в кандидатах' })).toBeNull()
    await waitFor(() => expect(view.calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/slots').length).toBeGreaterThanOrEqual(2))
    releaseSlots(jsonResponse([{ id: 's-auto', categoryId: 'photo', label: 'Фотограф', tileState: 'empty', deal: null }]))
    fireEvent.click(await screen.findByRole('button', { name: '✓ Уже в кандидатах' }))
    expect(await screen.findByRole('region', { name: 'Кандидаты' })).toBeTruthy()
  })

  it('T16: замена текущей брони — два клика до cancel + book; busy-кандидат CTA не получает', async () => {
    const bookedSlot = {
      ...SLOT,
      tileState: 'booked',
      deal: {
        id: 'deal-v1', state: 'booked',
        vendor: { id: 'v1', name: 'Анна Фотограф' },
        price: { amount: 250000, currency: 'RUB' },
        paid: { amount: 0, currency: 'RUB' },
      },
    }
    const v2 = { ...VENDOR, id: 'v2', name: 'Борис Фото' }
    const freeEntry = entry('replace-free', 'v2', 'Борис Фото', 1, 'free')
    const busyEntry = entry('replace-busy', 'v3', 'Вера Фото', 2, 'busy')
    let serverSlot: unknown = bookedSlot
    const view = mount('/wedding/slot/s1', {
      '/weddings/w1/slots': () => [serverSlot],
      [shortlistPath]: [freeEntry, busyEntry],
      'POST /weddings/w1/slots/s1/cancel': () => {
        serverSlot = { ...bookedSlot, tileState: 'empty', deal: null }
        return withStatus(204, null)
      },
      'POST /weddings/w1/slots/s1/book': (call: Call) => {
        expect(call.body).toEqual({ vendorId: 'v2', price: { amount: 250000, currency: 'RUB' }, packageId: 'p1' })
        serverSlot = { ...bookedSlot, tileState: 'booked', deal: { ...bookedSlot.deal, id: 'deal-v2', vendor: { id: 'v2', name: 'Борис Фото' } } }
        return withStatus(201, { id: 'deal-v2', state: 'booked' })
      },
      '/catalog/vendors/v2': v2,
      '/catalog/vendors/v2/availability': { busyDates: [], holdDates: [] },
      '/catalog/vendors/v2/reviews': { items: [], nextCursor: null },
    })

    const region = await screen.findByRole('region', { name: 'Кандидаты' })
    const replace = await within(region).findByRole('button', { name: 'Заменить исполнителя на Борис Фото' })
    expect(within(region).queryByRole('button', { name: 'Заменить исполнителя на Вера Фото' })).toBeNull()
    let humanClicks = 0
    humanClicks += 1
    fireEvent.click(replace)
    expect(await screen.findByText('Пакеты и цены')).toBeTruthy()
    expect(view.calls.filter(c => c.method === 'POST')).toHaveLength(0)
    const replaceButton = await screen.findByRole('button', { name: 'Заменить в свадьбе' })
    humanClicks += 1
    fireEvent.click(replaceButton)
    expect((await screen.findByRole('status')).textContent).toContain('Подрядчик заменён в свадьбе')
    expect(humanClicks).toBe(2)
    await waitFor(() => expect(view.calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/slots')).toHaveLength(2))
    expect(serverSlot).toMatchObject({ tileState: 'booked', deal: { vendor: { id: 'v2' } } })
    const mutations = view.calls.filter(c => c.method === 'POST' && /^\/weddings\/w1\/slots\/s1\/(cancel|book)$/.test(c.path))
    expect(mutations.map(c => [c.method, c.path, c.body])).toEqual([
      ['POST', '/weddings/w1/slots/s1/cancel', {}],
      ['POST', '/weddings/w1/slots/s1/book', { vendorId: 'v2', price: { amount: 250000, currency: 'RUB' }, packageId: 'p1' }],
    ])
  })

  it('T17: если новая бронь не проходит после отмены, анкета честно сообщает о потерянной старой брони', async () => {
    const bookedSlot = {
      ...SLOT,
      tileState: 'booked',
      deal: { id: 'deal-v1', state: 'booked', vendor: { id: 'v1', name: 'Анна Фотограф' }, price: { amount: 250000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
    }
    const v2 = { ...VENDOR, id: 'v2', name: 'Борис Фото' }
    let serverSlot: unknown = bookedSlot
    const view = mount('/vendor/v2?replaceSlot=s1', {
      '/weddings/w1/slots': () => [serverSlot],
      [shortlistPath]: [entry('replace-free', 'v2', 'Борис Фото', 1, 'free')],
      'POST /weddings/w1/slots/s1/cancel': () => {
        serverSlot = { ...bookedSlot, tileState: 'empty', deal: null }
        return withStatus(204, null)
      },
      'POST /weddings/w1/slots/s1/book': withStatus(409, { error: { code: 'slot_taken', message: 'На эту дату уже есть бронь' } }),
      '/catalog/vendors/v2': v2,
      '/catalog/vendors/v2/availability': { busyDates: [], holdDates: [] },
      '/catalog/vendors/v2/reviews': { items: [], nextCursor: null },
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Заменить в свадьбе' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Старая бронь уже отменена, но новую подтвердить не удалось')
    expect(alert.textContent).toContain('На эту дату уже есть бронь')
    expect(view.calls.filter(c => c.method === 'POST').map(c => c.path)).toEqual([
      '/weddings/w1/slots/s1/cancel',
      '/weddings/w1/slots/s1/book',
    ])
    await waitFor(() => expect(view.calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/slots')).toHaveLength(2))
    expect(serverSlot).toMatchObject({ tileState: 'empty', deal: null })
    expect(screen.getByRole('alert').textContent).toContain('Старая бронь уже отменена')
  })

  it('T18: replaceSlot ждёт слоты и роль пары; при роли helper не открывает обычное добавление', async () => {
    let releaseSlots!: (response: Response) => void
    const slotsPending = new Promise<Response>(resolve => { releaseSlots = resolve })
    let slotReads = 0
    const bookedSlot = {
      ...SLOT,
      tileState: 'booked',
      deal: { id: 'deal-v1', state: 'booked', vendor: { id: 'v1', name: 'Анна Фотограф' }, price: { amount: 250000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
    }
    const view = mount('/vendor/v2?replaceSlot=s1', {
      '/weddings': [{ ...WEDDING, role: 'helper' }],
      '/weddings/w1/slots': () => {
        slotReads += 1
        return slotReads === 1 ? slotsPending : [bookedSlot]
      },
      [shortlistPath]: [entry('replace-free', 'v2', 'Борис Фото', 1, 'free')],
      '/catalog/vendors/v2': { ...VENDOR, id: 'v2', name: 'Борис Фото' },
      '/catalog/vendors/v2/availability': { busyDates: [], holdDates: [] },
      '/catalog/vendors/v2/reviews': { items: [], nextCursor: null },
    })
    await screen.findByText('Пакеты и цены')
    expect(screen.queryByRole('button', { name: 'Добавить в свадьбу' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'В кандидаты' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Заменить в свадьбе' })).toBeNull()
    releaseSlots(jsonResponse([bookedSlot]))
    expect(await screen.findByText('Замену брони может подтвердить только пара')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Добавить в свадьбу' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'В кандидаты' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Заменить в свадьбе' })).toBeNull()
    expect(view.calls.some(c => c.method === 'POST' || c.method === 'PUT')).toBe(false)
  })
})
