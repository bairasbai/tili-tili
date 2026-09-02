// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { Guests } from '@/pages/Wedding'
import { Chat } from '@/pages/Us'
import { Seating } from '@/pages/Tools'

const wrap = (node: React.ReactNode, route = '/') =>
  render(<MemoryRouter initialEntries={[route]}><StoreProvider>{node}</StoreProvider></MemoryRouter>)

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('дыра: битый localStorage не роняет приложение', () => {
  it('гости: повреждённый tt_guests → дефолтный список', () => {
    localStorage.setItem('tt_guests', '{{{broken')
    wrap(<Guests />)
    expect(screen.getByText(/в списке/)).toBeTruthy()
  })
  it('рассадка: повреждённый tt_tables → дефолтные столы', () => {
    localStorage.setItem('tt_tables', 'null!!!')
    wrap(<Seating />)
    expect(screen.getAllByText(/Стол №/).length).toBeGreaterThan(0)
  })
})

describe('бизнес-логика: статусы гостей', () => {
  it('бейдж статуса циклит Придёт → Не придёт → Ждём и сохраняется', () => {
    wrap(<Guests />)
    const badges = screen.getAllByText('Придёт')
    fireEvent.click(badges[0])
    expect(screen.getAllByText('Не придёт').length).toBeGreaterThan(0)
    const saved = JSON.parse(localStorage.getItem('tt_guests')!)
    expect(saved.some((g: { status: string }) => g.status === 'no')).toBe(true)
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
