// @vitest-environment jsdom
/*
 * «Выйти со всех устройств» — именно со всех, включая это.
 *
 * `DELETE /users/me/sessions` на сервере гасит все ЧУЖИЕ сессии и намеренно
 * оставляет текущую: там это «выгнать постороннего, не выгоняя себя»
 * (`routes/users.ts:241`). Если фронт ограничивается им, кнопка врёт —
 * браузер забывает токен, а сессия на сервере продолжает жить.
 *
 * Проверено вживую до фикса: после нажатия в базе оставалась одна живая
 * сессия из одной. Этот тест падал бы на том поведении.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { StoreProvider } from './store'

const calls: string[] = []

vi.mock('@/lib/api/client', () => ({
  ApiError: class ApiError extends Error { kind = 'http'; status = 0; code = ''; get isDown() { return false } },
  saveTokens: () => { calls.push('saveTokens(null)') },
  isAuthorized: () => true,
  url: (tpl: string, p: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => p[k]),
  api: {
    get: async (path: string) => {
      calls.push(`GET ${path}`)
      if (path === '/users/me/sessions') {
        return [
          { id: 'other-1', device: 'Android', current: false },
          { id: 'this-one', device: 'Windows', current: true },
        ]
      }
      return undefined
    },
    delete: async (path: string) => { calls.push(`DELETE ${path}`) },
    post: async (path: string) => { calls.push(`POST ${path}`) },
    put: async () => undefined,
    patch: async () => undefined,
  },
}))

const { Settings } = await import('@/pages/Account')

beforeEach(() => { calls.length = 0; localStorage.clear() })
afterEach(cleanup)

describe('выход со всех устройств', () => {
  it('гасит чужие сессии и свою тоже', async () => {
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Выйти со всех устройств').closest('button')!)

    await waitFor(() => expect(calls).toContain('saveTokens(null)'))

    /* Порядок важен: сначала чужие одним запросом, потом список, чтобы найти
       свою, потом своя. Список нужен именно между ними — до него `current`
       неоткуда взять.
       Сверяем только вызовы про сессии: при запуске стор спрашивает ещё и
       `GET /weddings`, и привязывать проверку выхода к чужому вызову значит
       ломать её каждый раз, когда на старте появится что-то новое. */
    expect(calls.filter(c => c.includes('sessions') || c.startsWith('saveTokens'))).toEqual([
      'DELETE /users/me/sessions',
      'GET /users/me/sessions',
      'DELETE /users/me/sessions/this-one',
      'saveTokens(null)',
    ])
  })

  it('своя сессия гасится по идентификатору из списка, а не по догадке', async () => {
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Выйти со всех устройств').closest('button')!)

    await waitFor(() => expect(calls).toContain('saveTokens(null)'))
    /* Гасится ровно та, у которой current: true. Чужая — не трогается
       поштучно: её уже накрыл общий запрос. */
    expect(calls).toContain('DELETE /users/me/sessions/this-one')
    expect(calls).not.toContain('DELETE /users/me/sessions/other-1')
  })
})
