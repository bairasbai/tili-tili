// @vitest-environment jsdom
/*
 * Оверлеи должны быть диалогами, а не просто div поверх экрана:
 * без роли их не объявит скринридер, без Escape их нечем закрыть с клавиатуры
 * (приложение адаптивно и работает на десктопе от 900px).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { CityPicker } from '@/components/CityPicker'
import { Team } from '@/pages/Team'
import { Inspiration } from '@/pages/Discover'

const wrap = (node: React.ReactNode) =>
  render(<MemoryRouter><StoreProvider>{node}</StoreProvider></MemoryRouter>)

const escape = () => fireEvent.keyDown(window, { key: 'Escape' })

beforeEach(() => localStorage.clear())
afterEach(cleanup)

describe('выбор города', () => {
  it('объявлен диалогом и закрывается по Escape', () => {
    const onClose = vi.fn()
    wrap(<CityPicker onPick={() => {}} onClose={onClose} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Выбор города')
    escape()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('шторка приглашения в команду', () => {
  it('появляется как диалог и закрывается по Escape', () => {
    wrap(<Team />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getAllByText(/Помощник/)[0])
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Пригласить в команду')
    escape()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('разбор свадьбы во «Вдохновении»', () => {
  it('появляется как диалог и закрывается по Escape', () => {
    wrap(<Inspiration />)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getAllByText('Разбор бюджета')[0])
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Разбор свадьбы')
    escape()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
