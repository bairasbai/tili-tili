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
/*
 * Чат тоже живёт на сервере. Мок повторяет его поведение: отправленное
 * сообщение появляется в истории с моим `senderId`, и НИКТО не отвечает.
 * Раньше экран сам дописывал ответ через 1,6 секунды — тест это и проверял.
 */
const { chatState } = vi.hoisted(() => ({
  chatState: {
    messages: [] as Array<{ id: string; chatId: string; senderId: string | null; text: string; sentAt: string }>,
    typingSent: 0,
  },
}))
vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  getChats: async () => [{ id: 'ch1', title: 'Фотостудия «Кадр»', kind: 'vendor', unread: 0, lastMessage: '' }],
  getMessages: async () => ({ items: chatState.messages.map(m => ({ ...m })), nextCursor: null }),
  sendMessage: async (chatId: string, text: string) => {
    const m = { id: `m${chatState.messages.length + 1}`, chatId, senderId: 'u1', text, sentAt: new Date().toISOString() }
    chatState.messages.push(m)
    return m
  },
  sendTyping: async () => { chatState.typingSent++ },
  openChatSocket: () => () => undefined,
}))
vi.mock('@/lib/api/auth', async (orig) => ({
  ...await orig<object>(),
  getMe: async () => ({ id: 'u1', name: 'Алина' }),
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
import { MemoryRouter, Route, Routes } from 'react-router'
import { StoreProvider } from './store'
import { Guests } from '@/pages/Wedding'
import { Chat } from '@/pages/Us'
import { Seating } from '@/pages/Tools'

const wrap = (node: React.ReactNode, route = '/') =>
  render(<MemoryRouter initialEntries={[route]}><StoreProvider>{node}</StoreProvider></MemoryRouter>)

/* Экран чата берёт идентификатор из адреса, поэтому и в тесте он должен
   приходить оттуда же: без маршрута `useParams` пуст, и проверялся бы чат
   «без адреса», которого в приложении не бывает. */
const wrapChat = (route: string) =>
  render(
    <MemoryRouter initialEntries={[route]}>
      <StoreProvider>
        <Routes><Route path="/us/chats/:id" element={<Chat />} /></Routes>
      </StoreProvider>
    </MemoryRouter>,
  )

beforeEach(() => {
  localStorage.clear()
  /* Экраны свадьбы спрашивают сервер только после входа и при известной
     свадьбе — иначе они честно показывают пусто. */
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  guestsState.down = false
  chatState.messages = []
  chatState.typingSent = 0
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
  it('сообщение уходит на сервер и возвращается из истории', async () => {
    wrapChat('/us/chats/ch1')
    const input = await screen.findByPlaceholderText(/Сообщение/i)
    fireEvent.change(input, { target: { value: 'Здравствуйте!' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    /* Проверяем ответ сервера, а не то, что экран нарисовал сам: сообщение
       появляется, потому что пришло в истории. */
    await waitFor(() => expect(chatState.messages.map(m => m.text)).toEqual(['Здравствуйте!']))
    await waitFor(() => expect(screen.getByText('Здравствуйте!')).toBeTruthy(), { timeout: 4000 })
  })

  it('никто не отвечает сам: фальшивого автоответа больше нет', async () => {
    vi.useFakeTimers()
    try {
      wrapChat('/us/chats/ch1')
      await act(async () => { await Promise.resolve() })
      const input = screen.getByPlaceholderText(/Сообщение/i)
      fireEvent.change(input, { target: { value: 'Здравствуйте!' } })
      fireEvent.keyDown(input, { key: 'Enter' })
      /* Прежний экран через 1,6 секунды дописывал «Отлично, принято! Отвечу
         подробно чуть позже сегодня 🙌» — человек считал, что ему ответили. */
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.queryByText(/Отлично, принято/)).toBeNull()
      expect(chatState.messages.every(m => m.senderId === 'u1')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('набор текста поднимает «печатает…» у собеседника, но не на каждую букву', async () => {
    wrapChat('/us/chats/ch1')
    const input = await screen.findByPlaceholderText(/Сообщение/i)
    fireEvent.change(input, { target: { value: 'З' } })
    fireEvent.change(input, { target: { value: 'Зд' } })
    fireEvent.change(input, { target: { value: 'Здр' } })
    await waitFor(() => expect(chatState.typingSent).toBe(1))
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

    /* Кнопка снятия со стола заблокирована, пока идёт запись: нажатие в этот
       момент не долетает. Ждём, пока экран освободится, иначе тест падает
       случайно — под нагрузкой окно записи шире. */
    await waitFor(() => expect((screen.getByText('Руслан Гареев').closest('button') as HTMLButtonElement).disabled).toBe(false))
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
