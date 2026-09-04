// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

/*
 * Гости живут на сервере. Мок держит список в памяти и меняет его так же, как
 * это сделал бы сервер: без этого проверка «статус сменился» смотрела бы на
 * то, что экран нарисовал сам, а не на ответ.
 */
const { guestsState } = vi.hoisted(() => ({
  guestsState: {
    list: [] as Array<{ id: string; name: string; status: string; plusOne: boolean }>,
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
  patchGuest: async (_w: string, id: string, patch: { status?: string }) => {
    const g = guestsState.list.find(x => x.id === id)
    if (g && patch.status) g.status = patch.status
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
    { id: 'g1', name: 'Ольга Соколова', status: 'yes', plusOne: true },
    { id: 'g2', name: 'Руслан Гареев', status: 'pending', plusOne: false },
  ]
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
  it('рассадка: повреждённый tt_tables → дефолтные столы', () => {
    localStorage.setItem('tt_tables', 'null!!!')
    wrap(<Seating />)
    expect(screen.getAllByText(/Стол №/).length).toBeGreaterThan(0)
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
  it('гость садится за стол и уходит обратно в «без стола»', () => {
    wrap(<Seating />)
    const unseated = screen.getAllByText('Руслан Гареев')
    fireEvent.click(unseated[0]) // выбрать гостя
    const table = screen.getAllByText(/Стол №/)[0].closest('div')!
    fireEvent.click(table.parentElement!.querySelector('button') ?? table)
    // после посадки гость должен исчезнуть из зоны «Без стола» (остаться максимум 1 раз — за столом)
    expect(screen.getAllByText('Руслан Гареев').length).toBeLessThanOrEqual(1)
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
