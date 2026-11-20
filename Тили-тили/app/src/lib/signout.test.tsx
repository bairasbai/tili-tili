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
/* Что ответит сервер на `DELETE /users/me`: null — 204, строка — отказ с этим текстом. */
const flags = vi.hoisted(() => ({
  deleteAccountRefusal: null as string | null,
  beforeDeleteReply: null as Promise<void> | null,
}))

vi.mock('@/lib/api/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/client')>(),
  ApiError: class ApiError extends Error {
    kind: string; status: number; code: string
    constructor(kind: string, status: number, code: string, message: string) { super(message); this.kind = kind; this.status = status; this.code = code }
    get isDown() { return this.kind !== 'http' || this.status >= 500 }
  },
  saveTokens: () => { calls.push('saveTokens(null)') },
  onSessionExpired: () => () => {},
  SESSION_EXPIRED: 'Сессия истекла — войдите снова',
  isAuthorized: () => true,
  accessTokenForWs: () => null,
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
    delete: async (path: string) => {
      calls.push(`DELETE ${path}`)
      if ((path === '/users/me' || path === '/users/me/consent') && flags.beforeDeleteReply) await flags.beforeDeleteReply
      if (path === '/users/me' && flags.deleteAccountRefusal) {
        const { ApiError } = await import('@/lib/api/client')
        throw new ApiError('http', 409, 'active_deals', flags.deleteAccountRefusal)
      }
    },
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
    /* Экран сам показывает список устройств, поэтому один `GET
       /users/me/sessions` уходит ещё при открытии. Он к выходу отношения не
       имеет: ждём его и начинаем счёт заново, иначе проверка порядка
       сравнивала бы загрузку экрана с последовательностью выхода. */
    await waitFor(() => expect(calls).toContain('GET /users/me/sessions'))
    calls.length = 0

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

describe('удаление аккаунта', () => {
  /*
   * Сервер отвечает 409 `active_deals`, пока у человека живая сделка
   * (контракт обещал это с v0.2, реализовано 2026-09-06). До фикса `catch {}`
   * в обработчике глотал отказ молча: кнопка «Подтвердить удаление» не делала
   * ничего видимого, и человек не узнавал, что сначала надо закрыть сделки
   * (R-128). Этот тест падал бы на том коде: текста на экране не было.
   */
  afterEach(() => { flags.deleteAccountRefusal = null; flags.beforeDeleteReply = null })

  it.each(['delete', 'withdraw'] as const)('%s не запускает второе удаление с той же формы до ответа сервера', async action => {
    let finish!: () => void
    flags.beforeDeleteReply = new Promise(resolve => { finish = resolve })
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    fireEvent.click(screen.getByRole('button', { name: 'Отозвать согласие на обработку данных' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить аккаунт' }))
    const confirm = screen.getByRole('button', { name: 'Подтвердить удаление' }) as HTMLButtonElement
    const withdraw = screen.getByRole('button', { name: 'Подтвердить отзыв согласия' }) as HTMLButtonElement
    const first = action === 'delete' ? confirm : withdraw
    const second = action === 'delete' ? withdraw : confirm

    fireEvent.click(first)
    fireEvent.click(first)
    fireEvent.click(second)
    expect(calls.filter(call => call === 'DELETE /users/me' || call === 'DELETE /users/me/consent'))
      .toEqual([action === 'delete' ? 'DELETE /users/me' : 'DELETE /users/me/consent'])
    expect(confirm.disabled).toBe(true)
    expect(withdraw.disabled).toBe(true)

    finish()
    await waitFor(() => expect(calls).toContain('saveTokens(null)'))
  })

  it('отказ сервера показывается словами сервера, локальное не чистится', async () => {
    flags.deleteAccountRefusal = 'Сначала завершите или отмените сделки (1): Студия «Пион»'
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Удалить аккаунт').closest('button')!)
    fireEvent.click(screen.getByText('Подтвердить удаление').closest('button')!)

    await waitFor(() => expect(calls).toContain('DELETE /users/me'))
    expect(await screen.findByText('Сначала завершите или отмените сделки (1): Студия «Пион»')).toBeTruthy()
    expect(calls).not.toContain('saveTokens(null)')
    expect((screen.getByRole('button', { name: 'Удалить аккаунт' }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Отозвать согласие на обработку данных' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('при 204 локальное чистится', async () => {
    render(<MemoryRouter><StoreProvider><Settings /></StoreProvider></MemoryRouter>)
    fireEvent.click(screen.getByText('Удалить аккаунт').closest('button')!)
    fireEvent.click(screen.getByText('Подтвердить удаление').closest('button')!)
    await waitFor(() => expect(calls).toContain('saveTokens(null)'))
  })
})
