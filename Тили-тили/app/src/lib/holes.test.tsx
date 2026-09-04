// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/*
 * Гости живут на сервере. Мок держит список в памяти и меняет его так же, как
 * это сделал бы сервер: без этого проверка «статус сменился» смотрела бы на
 * то, что экран нарисовал сам, а не на ответ.
 */
const { guestsState } = vi.hoisted(() => ({
  guestsState: {
    list: [] as Array<{ id: string; name: string; status: string; plusOne: boolean; tableId?: string | null }>,
    tables: [] as Array<{ id: string; name: string; capacity: number }>,
    down: false,
  },
}))
vi.mock('@/lib/api/weddingData', async (orig) => ({
  ...await orig<object>(),
  getGuests: async () => {
    if (guestsState.down) throw new Error('сеть недоступна')
    return guestsState.list.map(g => ({ ...g }))
  },
}))
vi.mock('@/lib/api/weddingWrite', async (orig) => ({
  ...await orig<object>(),
  getTables: async () => guestsState.tables.map(tb => ({ ...tb })),
  patchGuest: async (_w: string, id: string, patch: { status?: string; tableId?: string | null }) => {
    const g = guestsState.list.find(x => x.id === id)
    if (!g) return
    if (patch.status) g.status = patch.status
    /* `tableId` приходит и как `null` — «снять со стола». Проверяем наличие
       ключа, а не истинность значения: `if (patch.tableId)` не отличил бы
       снятие от «поле не прислали». */
    if ('tableId' in patch) g.tableId = patch.tableId ?? null
  },
}))
import { render, screen, fireEvent, act, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { Guests } from '@/pages/Wedding'
import { Chat } from '@/pages/Us'
import { Seating } from '@/pages/Tools'

const wrap = (node: React.ReactNode, route = '/') =>
  render(<MemoryRouter initialEntries={[route]}><StoreProvider>{node}</StoreProvider></MemoryRouter>)

beforeEach(() => {
  localStorage.clear()
  /* Экраны свадьбы спрашивают сервер только после входа и при известной
     свадьбе — иначе они честно показывают пусто. */
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  guestsState.down = false
  guestsState.list = [
    { id: 'g1', name: 'Ольга Соколова', status: 'yes', plusOne: true, tableId: null },
    { id: 'g2', name: 'Руслан Гареев', status: 'pending', plusOne: false, tableId: null },
  ]
  guestsState.tables = [{ id: 'tb1', name: 'Стол №1', capacity: 8 }]
})
afterEach(cleanup)

describe('дыра: битый localStorage не роняет приложение', () => {
  it('гости: сервер молчит → экран говорит об этом, а не показывает чужих', async () => {
    /* Раньше список гостей при пустом ответе подменялся моком из lib/data.ts:
       человек видел «Ольгу и Дениса» как своих гостей. */
    guestsState.down = true
    wrap(<Guests />)
    await waitFor(() => expect(screen.getByText(/Сервер недоступен|Что-то пошло не так/)).toBeTruthy())
    expect(screen.queryByText('Ольга Соколова')).toBeNull()
  })
  it('рассадка: столов ещё нет → экран говорит об этом, а не рисует четыре', async () => {
    /* Раньше четыре стола существовали всегда: они брались из `tt_tables_count`
       со значением по умолчанию, и пара видела зал, которого не заводила. */
    guestsState.tables = []
    wrap(<Seating />)
    await waitFor(() => expect(screen.getByText(/Столов пока нет/)).toBeTruthy())
  })
})

describe('бизнес-логика: статусы гостей', () => {
  it('бейдж статуса циклит Придёт → Не придёт и уезжает на сервер', async () => {
    wrap(<Guests />)
    const badge = await screen.findByText('Придёт')
    fireEvent.click(badge)
    /* Проверяем ответ сервера, а не то, что экран нарисовал сам: статус
       общий на пару, и раньше он оставался в `tt_guests` на одном телефоне. */
    await waitFor(() => expect(screen.getAllByText('Не придёт').length).toBeGreaterThan(0))
    expect(guestsState.list.find(g => g.id === 'g1')?.status).toBe('no')
  })
})

describe('бизнес-логика: чат', () => {
  it('отправка: сообщение своё (справа), затем typing и автоответ', async () => {
    vi.useFakeTimers()
    wrap(<Chat />, '/us/chats/ch1')
    const input = screen.getByPlaceholderText(/Сообщение/i)
    fireEvent.change(input, { target: { value: 'Здравствуйте!' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('Здравствуйте!')).toBeTruthy()
    await act(async () => { vi.advanceTimersByTime(1700) })
    expect(screen.getByText(/Отлично, принято/)).toBeTruthy()
    vi.useRealTimers()
  })
})

describe('бизнес-логика: рассадка', () => {
  it('гость садится за стол и уходит обратно в «без стола»', async () => {
    wrap(<Seating />)
    const guest = await screen.findByText('Руслан Гареев')
    fireEvent.click(guest) // выбрать гостя
    fireEvent.click(screen.getByText('Стол №1').closest('div')!.parentElement!)
    /* Место гостя — поле на сервере, а не карта в браузере: проверяем ответ,
       а не то, что экран нарисовал сам. */
    await waitFor(() => expect(guestsState.list.find(g => g.id === 'g2')?.tableId).toBe('tb1'))
    // и он больше не числится среди нерассаженных — иначе был бы в двух местах
    await waitFor(() => expect(screen.getAllByText('Руслан Гареев').length).toBe(1))

    fireEvent.click(screen.getByText('Руслан Гареев'))
    await waitFor(() => expect(guestsState.list.find(g => g.id === 'g2')?.tableId).toBeNull())
  })
})

describe('дыра: ErrorBoundary', () => {
  it('падение дочернего экрана показывает дружелюбный экран', async () => {
    const { ErrorBoundary } = await import('@/components/ErrorBoundary')
    const Boom = () => { throw new Error('boom') }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorBoundary><Boom /></ErrorBoundary>)
    expect(screen.getByText('Что-то пошло не так')).toBeTruthy()
    spy.mockRestore()
  })
})
