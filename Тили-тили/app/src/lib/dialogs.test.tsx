// @vitest-environment jsdom
/*
 * Оверлеи должны быть диалогами, а не просто div поверх экрана:
 * без роли их не объявит скринридер, без Escape их нечем закрыть с клавиатуры
 * (приложение адаптивно и работает на десктопе от 900px).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'

/* Код приглашения выпускает сервер, поэтому шторка команды открывается после
   ответа, а не по нажатию. Здесь сервер подменён: проверяем роль и Escape,
   а не сеть. */
vi.mock('@/lib/api/client', () => ({
  ApiError: class ApiError extends Error { kind = 'http'; status = 0; code = ''; get isDown() { return false } },
  saveTokens: () => {},
  onSessionExpired: () => () => {},
  SESSION_EXPIRED: 'Сессия истекла — войдите снова',
  isAuthorized: () => true,
  url: (tpl: string, p: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => p[k]),
  api: {
    /* Блок «Пригласить» есть только у пары — роль приходит из `GET /weddings` (D1-25). */
    get: async (path: string) => (path === '/weddings' ? [{ id: '01a06c32-de69-7243-8ed8-066951a0e559', role: 'couple' }] : []),
    post: async () => ({ code: 'ТИЛИ-ДРУГ-1234', url: 'tili-tili.ru/join/ТИЛИ-ДРУГ-1234', role: 'helper' }),
    delete: async () => undefined,
    put: async () => undefined,
    patch: async () => undefined,
  },
}))
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'
import { CityPicker } from '@/components/CityPicker'
import { Team } from '@/pages/Team'
import { Inspiration } from '@/pages/Discover'

const wrap = (node: React.ReactNode) =>
  render(<MemoryRouter><StoreProvider>{node}</StoreProvider></MemoryRouter>)

const escape = () => fireEvent.keyDown(window, { key: 'Escape' })

beforeEach(() => {
  localStorage.clear()
  /* Приглашать можно только в существующую свадьбу — без неё кнопки ролей
     ничего не делают, и это правильное поведение, а не сбой теста. */
  localStorage.setItem('tt_wedding_id', JSON.stringify('01a06c32-de69-7243-8ed8-066951a0e559'))
})
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
  it('появляется как диалог и закрывается по Escape', async () => {
    wrap(<Team />)
    expect(screen.queryByRole('dialog')).toBeNull()
    /* Кнопки ролей появляются после ответа `GET /weddings` — приглашает только пара (D1-25). */
    fireEvent.click((await screen.findAllByText(/Помощник/))[0]!)
    /* Ждём ответа сервера: код выпускает он, и до ответа показывать нечего. */
    await waitFor(() => expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Пригласить в команду'))
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
