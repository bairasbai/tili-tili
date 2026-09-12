/*
 * Фича 010 «Тиль на живой модели» — фронт.
 *
 * Шапка чата Тиля: «сегодня N из M» и признак «без ИИ» — только из `Chat.tilly`
 * ответа `GET /chats` (инвариант 13: раньше в шапке стояло выдуманное «42/50
 * сообщений сегодня», счётчика не существовало). У чатов без `tilly` (другие
 * виды, старый сервер) строки нет. Панель сотрудника: карточка «Тиль · модель»
 * из `AdminMetrics.llm` — до ответа прочерки без цифр, после — числа сервера.
 * Красный без фикса: на HEAD `Us.tsx` счётчика не рисовал, `Admin.tsx` карточки
 * не знал.
 */
import { render, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { Chat } from '@/pages/Us'
import App from '@/App'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; body: unknown }
const PENDING = Symbol('pending')

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    calls.push({ method: init?.method ?? 'GET', path, body })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const reply = routes[path]
    if (reply === PENDING) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    return Promise.resolve(json(reply))
  }))
  return calls
}

const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': ME,
  ...over,
})
const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const digits = (s: string) => s.replace(/\D+/g, '')

const MESSAGES = '/chats/tilly1/messages'
const msg = (n: number, senderId: string | null, body: string) =>
  ({ id: `m${n}`, chatId: 'tilly1', senderId, text: body, sentAt: `2026-09-12T10:00:0${n}.000Z`, system: false, guestName: null })
const tillyChat = (tilly: unknown) =>
  ({ id: 'tilly1', kind: 'tilly', title: 'Тиль — помощник', unread: 0, lastMessage: '', closed: false, openFrom: null, tilly })

const openChat = () => render(
  <MemoryRouter initialEntries={['/us/chats/tilly1']}>
    <StoreProvider>
      <Routes><Route path="/us/chats/:id" element={<Chat />} /></Routes>
    </StoreProvider>
  </MemoryRouter>,
)

describe('T1: шапка чата Тиля — счётчик суток и признак «без ИИ» только из Chat.tilly', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('live=true, usedToday 3 из 50 → «сегодня 3 из 50», без слов про отсутствие ИИ', async () => {
    serve(base({
      '/chats': [tillyChat({ live: true, usedToday: 3, limitPerDay: 50 })],
      [MESSAGES]: { items: [msg(2, null, 'Не забронированы DJ и транспорт.'), msg(1, 'u1', 'Что мы забыли?')], nextCursor: null },
    }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Не забронированы DJ и транспорт.'), { timeout: 4000 })
    await waitFor(() => expect(text(r), 'счётчика суток из Chat.tilly нет в шапке').toContain('сегодня 3 из 50'), { timeout: 4000 })
    expect(text(r)).not.toContain('без ИИ')
  })

  it('live=false → «без ИИ — ответы появятся, когда помощник заработает» рядом со счётчиком', async () => {
    serve(base({
      '/chats': [tillyChat({ live: false, usedToday: 0, limitPerDay: 50 })],
      [MESSAGES]: { items: [], nextCursor: null },
    }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('сегодня 0 из 50'), { timeout: 4000 })
    expect(text(r)).toContain('без ИИ — ответы появятся, когда помощник заработает')
  })

  it('контроль: чат без поля tilly (день X, старый сервер) — ни счётчика, ни «без ИИ»', async () => {
    serve(base({
      '/chats': [{ id: 'tilly1', kind: 'day', title: 'Чат дня X', unread: 0, lastMessage: '', closed: false, openFrom: null, tilly: null }],
      [MESSAGES]: { items: [msg(1, 'u1', 'Мы на месте')], nextCursor: null },
    }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    expect(text(r)).not.toContain('сегодня 0 из')
    expect(text(r)).not.toContain('без ИИ')
  })
})

const METRICS = {
  users: 12, weddings: 3, vendorsPublished: 7, moderationQueue: 2,
  verificationQueue: 4, complaintsOpen: 0, complaintsOverdue: 0, deals: 5,
  gmv: { amount: 125_000_000, currency: 'RUB' },
  cities: [{ city: 'Уфа', vendors: 51, launchReady: true }],
  llm: { since: '2026-08-13T20:00:00.000Z', calls: 17, answered: 15, inputTokens: 23456, outputTokens: 1890 },
}

async function openAdmin(settled: string) {
  const r = render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

describe('T2: панель сотрудника — карточка «Тиль · модель» из AdminMetrics.llm', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('после ответа — вызовы, ответы модели и токены числами сервера', async () => {
    serve({ '/admin/metrics': METRICS })
    const r = await openAdmin('Уфа')
    expect(text(r), 'карточки модели нет').toContain('Тиль · модель за последний месяц')
    expect(text(r)).toContain('17Вызовов')
    expect(text(r)).toContain('15Ответов модели')
    expect(text(r)).toContain(`${(23456).toLocaleString('ru-RU')}Токенов на вход`)
    expect(text(r)).toContain(`${(1890).toLocaleString('ru-RU')}Токенов на выход`)
  })

  it('до ответа — карточка с прочерками и без единой цифры (ноль ≠ неизвестно)', async () => {
    serve({ '/admin/metrics': PENDING })
    const r = await openAdmin('Загружаем…')
    expect(text(r)).toContain('Тиль · модель за последний месяц')
    expect(text(r)).toContain('Вызовов')
    expect(digits(text(r)), 'цифры появились до ответа сервера').toBe('')
  })
})
