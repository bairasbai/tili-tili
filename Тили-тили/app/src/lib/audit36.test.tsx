// @vitest-environment jsdom
/*
 * Фича 009 «Гостевой день X», фронт под контракт v0.32.0 (задание FE-009).
 * Каждый тест здесь был красным на коде до фикса — цитаты красного в отчёте
 * `scratchpad/f009/REPORT-FE.md`.
 *
 * Что закрывается:
 *  — раздел «День свадьбы» на `/invite`: с кануна по поясу МЕСТА (тот же
 *    момент, два пояса — два ответа), содержимое из `GET /join/{t}/day`,
 *    честные «пока не назначен» только по ответу, отказ словами с «Повторить»,
 *    «Открыть чат дня» / «откроется <дата по tz>» (T1);
 *  — чат дня гостя: лента по времени, имя гостя у его реплик, «Команда» у
 *    людей, свои — по `guestName`, отправка добавляет реплику из ответа, опрос
 *    раз в 30 с через `reload()` без «Загружаем…», 423 — словами сервера и без
 *    поля, 410 — «Ссылка недействительна», «Назад» — к приглашению (T2);
 *  — тайминг пары: галочка «Показывать гостям» у блока и в форме, `PUT` всего
 *    списка несёт `forGuests` у каждого блока, снятая — «скрыт от гостей» (T3);
 *  — чат пары: реплика с `guestName` — имя и «гость», не «Участник вышел» (T4).
 *
 * Проверяется то, что ушло на сервер и что видно на экране (приём из
 * `audit30`/`audit31`/`audit32`); харнесс `serve` — оттуда же.
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import Invite, { GuestDayChat } from '@/pages/Invite'
import { Timeline } from '@/pages/Wedding'
import { Chat } from '@/pages/Us'

/* Живой канал чата подменяется, как в audit27/audit32: настоящий WebSocket в
   jsdom тянулся бы к серверу и переподключался по таймеру. Остальное — настоящее. */
vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown; headers: Record<string, string> }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')
/* Ответ, которого ещё нет: запрос ушёл и висит. На `abort` отвечает, как настоящий fetch. */
const PENDING = Symbol('pending')

function isStatus(v: unknown): v is { __status: number; body: unknown; headers: Record<string, string> } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/** Отказ сервера в формате контракта: код и текст, при желании — `details`. */
const withStatus = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  ({ __status: status, body: { error: { code, message, ...(details ? { details } : {}) } }, headers: {} })

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body, headers }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    if (reply === DOWN) return Promise.reject(new TypeError('Failed to fetch'))
    if (reply === PENDING) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
      })
    }
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status, reply.headers))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const TOKENS = { accessToken: 'a', refreshToken: 'r' }
const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const guest = () => {
  localStorage.clear()
  localStorage.setItem('tt_guest_token', 'tok1')
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }

/** Всё, что читают стор и экраны пары. */
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': ME,
  ...over,
})

function renderAt(initial: string, routes: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        <Routes>{routes}</Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const puts = (calls: Call[], path: string) => calls.filter(c => c.method === 'PUT' && c.path === path)
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/* ── Гость: страница приглашения и чат дня ──────────────────────────────── */

/* Марина ответила «приду» — раздел дня и блоки трансфера показываются тем, кто придёт. */
const PAGE = { guestName: 'Марина', status: 'yes', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } }
const DAY_PATH = '/join/tok1/day'
const MSGS = '/join/tok1/day-chat/messages'
/* Уфа, UTC+5: церемония в 08:00Z — это 13:00 на площадке. */
const DAY = {
  date: '2027-06-14', tz: 'Asia/Yekaterinburg', venue: 'Усадьба «Липки»', dressCode: 'd2', dressNote: 'Без белого',
  timeline: [
    { id: 'e1', name: 'Церемония', location: 'Сад у пруда', startsAt: '2027-06-14T08:00:00.000Z', forGuests: true },
    { id: 'e2', name: 'Ужин', startsAt: '2027-06-14T13:30:00.000Z', forGuests: true },
  ],
  table: { name: 'У окна' },
  bus: { id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 20, taken: 3, carrier: 'Автобусы Уфы' },
  coordinator: { name: 'Мария', phone: '+79170000001' },
  chat: { open: true, opensAt: '2027-06-13T04:00:00.000Z', closesAt: '2027-06-15T18:59:59.000Z' },
}
const guestRoutes = (over: Routes = {}): Routes => ({
  '/rsvp/tok1': PAGE,
  '/join/tok1/menu-vote': { question: '', options: [] },
  '/join/tok1/shuttle': { routes: [] },
  '/join/tok1/hotels': [],
  [DAY_PATH]: DAY,
  ...over,
})
const openGuest = (initial = '/invite') => render(
  <MemoryRouter initialEntries={[initial]}>
    <Routes>
      <Route path="/invite" element={<Invite />} />
      <Route path="/invite/day-chat" element={<GuestDayChat />} />
    </Routes>
  </MemoryRouter>,
)

describe('T1: раздел «День свадьбы» на /invite — с кануна по поясу места, содержимое из GET /join/{t}/day', () => {
  beforeEach(() => {
    guest()
    /* 00:30 UTC 13 июня: в UTC+14 уже 13-е — канун наступил; в UTC−11 ещё
       12-е — нет. Пояс устройства — любой: два ответа обязаны различаться. */
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-13T00:30:00.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('тот же момент: UTC−11 — раздела нет, UTC+14 — раздел есть (канун считается по tz из ответа, не по устройству)', async () => {
    const calls = serve(guestRoutes({ [DAY_PATH]: { ...DAY, tz: 'Pacific/Pago_Pago' } }))
    const r = openGuest()
    await waitFor(() => expect(gets(calls, DAY_PATH).length).toBe(1), { timeout: 4000 })
    await settle()
    expect(text(r), 'раздел дня показан до кануна по поясу места').not.toContain('Ваш стол')
    expect(text(r)).not.toContain('Программа')
    cleanup(); vi.unstubAllGlobals()
    serve(guestRoutes({ [DAY_PATH]: { ...DAY, tz: 'Pacific/Kiritimati' } }))
    const r2 = openGuest()
    await waitFor(() => expect(text(r2)).toContain('Ваш стол:'), { timeout: 4000 })
    expect(text(r2)).toContain('У окна')
  })

  it('содержимое: программа в поясе места, стол, автобус с перевозчиком, координатор с tel:, дресс-код, маршрут, «Открыть чат дня»', async () => {
    serve(guestRoutes())
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('Ваш стол:'), { timeout: 4000 })
    expect(text(r), 'время блока не в поясе места (08:00Z в Уфе — 13:00)').toContain('13:00')
    expect(text(r)).toContain('Церемония')
    expect(text(r)).toContain('Сад у пруда')
    expect(text(r)).toContain('18:30')
    expect(text(r)).toContain('У окна')
    expect(text(r)).toContain('Автобус №1 · 14:30 · Автобусы Уфы')
    expect(text(r)).toContain('Координатор:')
    expect(text(r)).toContain('Мария')
    const call = r.container.querySelector('a[href="tel:+79170000001"]')
    expect(call, 'нет кнопки «Позвонить» с tel: координатора').not.toBeNull()
    expect(call!.textContent).toContain('Позвонить')
    expect(text(r)).toContain('Дресс-код:')
    expect(text(r)).toContain('Шалфей и сливки')
    expect(text(r)).toContain('Без белого')
    /* Именно ссылка раздела дня: карточка «Место» выше ведёт на карту по адресу из /rsvp. */
    const route = screen.getByText('Построить маршрут').closest('a')
    expect(route, 'нет ссылки «Построить маршрут»').not.toBeNull()
    expect(route!.getAttribute('href')).toBe(`https://yandex.ru/maps/?text=${encodeURIComponent('Усадьба «Липки», Уфа')}`)
    expect(screen.getByText('Открыть чат дня').closest('button')).not.toBeNull()
  })

  it('«Открыть чат дня» ведёт на экран чата гостя', async () => {
    serve(guestRoutes({ '/join/tok1/day-chat/messages': { items: [], nextCursor: null } }))
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('Открыть чат дня'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Открыть чат дня'))
    await waitFor(() => expect(text(r)).toContain('Чат дня свадьбы'), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Сообщений пока нет'), { timeout: 4000 })
  })

  it('честные пустоты: table/bus/coordinator null → «стол пока не назначен», «автобус не выбран», блока координатора нет; чат закрыт → «откроется 13 июня, 09:00» по tz', async () => {
    serve(guestRoutes({ [DAY_PATH]: { ...DAY, table: null, bus: null, coordinator: null, chat: { open: false, opensAt: '2027-06-13T04:00:00.000Z', closesAt: '2027-06-15T18:59:59.000Z' } } }))
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('стол пока не назначен'), { timeout: 4000 })
    expect(text(r)).toContain('автобус не выбран')
    expect(r.container.querySelector('a[href="#transfer"]'), 'нет ссылки на блок трансфера').not.toBeNull()
    expect(text(r)).not.toContain('Координатор')
    expect(text(r)).not.toContain('Позвонить')
    expect(text(r)).not.toContain('Открыть чат дня')
    expect(text(r)).toContain('Чат дня откроется')
    expect(text(r), 'срок открытия не в поясе места (04:00Z в Уфе — 09:00)').toContain('09:00')
    expect(text(r)).toContain('13 июня')
  })

  it('свадьба прошла (now за closesAt) — «Чат дня закрыт — свадьба прошла», а не «откроется»', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-16T12:00:00.000Z'))
    serve(guestRoutes({ [DAY_PATH]: { ...DAY, chat: { open: false, opensAt: '2027-06-13T04:00:00.000Z', closesAt: '2027-06-15T18:59:59.000Z' } } }))
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('Чат дня закрыт — свадьба прошла'), { timeout: 4000 })
    expect(text(r)).not.toContain('Чат дня откроется')
  })

  it('до ответа ничего не выдумано: /day висит — «Загружаем…», без «пока не назначен»; отказ — словами и «Повторить» → второй GET', async () => {
    const calls = serve(guestRoutes({ [DAY_PATH]: PENDING }))
    const r = openGuest()
    await waitFor(() => expect(gets(calls, DAY_PATH).length).toBe(1), { timeout: 4000 })
    await settle()
    expect(text(r)).toContain('Загружаем…')
    expect(text(r), '«стол пока не назначен» показан до ответа сервера').not.toContain('пока не назначен')
    expect(text(r)).not.toContain('автобус не выбран')
    cleanup(); vi.unstubAllGlobals()
    const calls2 = serve(guestRoutes({ [DAY_PATH]: DOWN }))
    const r2 = openGuest()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(text(r2)).toContain('День свадьбы')
    expect(text(r2)).not.toContain('пока не назначен')
    fireEvent.click(screen.getByText('Повторить'))
    await waitFor(() => expect(gets(calls2, DAY_PATH).length).toBe(2), { timeout: 4000 })
  })

  it('контроль: за три дня до свадьбы раздела нет и запроса нет — страница как раньше', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-10T12:00:00.000Z'))
    const calls = serve(guestRoutes())
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('Марина'), { timeout: 4000 })
    await settle()
    expect(gets(calls, DAY_PATH).length).toBe(0)
    expect(text(r)).not.toContain('Ваш стол')
  })
})

describe('T2: чат дня глазами гостя — лента, имена, отправка, опрос, 423/410, «Назад»', () => {
  beforeEach(guest)
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  const msg = (n: number, body: string, over: Record<string, unknown> = {}) =>
    ({ id: `m${n}`, chatId: 'ch1', senderId: null, text: body, attachmentUrl: null, sentAt: `2027-06-14T10:00:0${n}.000Z`, system: false, guestName: null, ...over })
  /* Сервер отдаёт свежие первыми. */
  const ITEMS = [
    msg(4, 'Тайминг сдвинут на 15 минут', { system: true }),
    msg(3, 'Автобус задерживается', { guestName: 'Ольга' }),
    msg(2, 'Еду', { guestName: 'Марина' }),
    msg(1, 'Мы на месте', { senderId: 'u1' }),
  ]
  const openChat = () => openGuest('/invite/day-chat')

  it('лента по времени; у реплики гостя — его имя, у человека — «Команда», своя (guestName = моё имя) — справа, системная — по признаку', async () => {
    serve(guestRoutes({ [MSGS]: { items: ITEMS, nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    const s = text(r)
    expect(s.indexOf('Мы на месте'), 'порядок не хронологический').toBeLessThan(s.indexOf('Еду'))
    expect(s.indexOf('Еду')).toBeLessThan(s.indexOf('Автобус задерживается'))
    expect(s.indexOf('Автобус задерживается')).toBeLessThan(s.indexOf('Тайминг сдвинут'))
    expect(screen.getByText('Ольга'), 'имени гостя у его реплики нет').toBeTruthy()
    expect(screen.getByText('Команда')).toBeTruthy()
    expect(s).toContain('⚠ Тайминг сдвинут')
    expect(s).not.toContain('Участник вышел')
    /* Своя реплика — по имени из GET /rsvp/{t}: у гостя нет идентификатора. */
    await waitFor(() => expect(screen.getByText('Еду').parentElement!.className).toContain('justify-end'), { timeout: 4000 })
    expect(screen.getByText('Автобус задерживается').parentElement!.className).toContain('justify-start')
  })

  it('«Отправить» → POST {text}; реплика из ответа появляется в ленте, поле очищено', async () => {
    const calls = serve(guestRoutes({
      [MSGS]: (c: Call) => (c.method === 'POST' ? msg(9, (c.body as { text: string }).text, { guestName: 'Марина' }) : { items: ITEMS, nextCursor: null }),
    }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    const input = screen.getByPlaceholderText('Сообщение…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Уже подъезжаем' } })
    fireEvent.click(screen.getByLabelText('Отправить'))
    await waitFor(() => expect(posts(calls, MSGS).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, MSGS)[0]!.body).toEqual({ text: 'Уже подъезжаем' })
    await waitFor(() => expect(text(r)).toContain('Уже подъезжаем'), { timeout: 4000 })
    expect(input.value).toBe('')
  })

  it('опрос раз в 30 с — второй GET, лента на месте, «Загружаем…» не мигает', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const calls = serve(guestRoutes({ [MSGS]: { items: ITEMS, nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    expect(gets(calls, MSGS).length).toBe(1)
    await act(async () => { vi.advanceTimersByTime(30_000) })
    await waitFor(() => expect(gets(calls, MSGS).length).toBe(2), { timeout: 4000 })
    expect(text(r), 'опрос стёр ленту').toContain('Мы на месте')
    expect(text(r)).not.toContain('Загружаем…')
  })

  it('423 на чтение — текст сервера, поля ввода нет', async () => {
    serve(guestRoutes({ [MSGS]: withStatus(423, 'chat_closed_for_guests', 'Чат дня откроется 2027-06-13T04:00:00.000Z — накануне свадьбы в 09:00', { opensAt: '2027-06-13T04:00:00.000Z', closesAt: null }) }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('накануне свадьбы в 09:00'), { timeout: 4000 })
    expect(screen.queryByPlaceholderText('Сообщение…'), 'поле ввода открыто при закрытом окне').toBeNull()
    expect(text(r)).not.toContain('Сервер недоступен')
  })

  it('423 на отправку — текст сервера, поле закрывается', async () => {
    serve(guestRoutes({
      [MSGS]: (c: Call) => (c.method === 'POST' ? withStatus(423, 'chat_closed_for_guests', 'Чат дня закрыт — свадьба прошла') : { items: ITEMS, nextCursor: null }),
    }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText('Сообщение…'), { target: { value: 'Ещё еду' } })
    fireEvent.click(screen.getByLabelText('Отправить'))
    await waitFor(() => expect(text(r)).toContain('Чат дня закрыт — свадьба прошла'), { timeout: 4000 })
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull()
    expect(text(r)).toContain('Мы на месте')
  })

  it('410 — «Ссылка недействительна», без поля ввода', async () => {
    serve(guestRoutes({
      [MSGS]: withStatus(410, 'gone', 'Ссылка недействительна: отозвана или истекла — попросите пару прислать новую'),
      '/rsvp/tok1': withStatus(410, 'gone', 'Ссылка недействительна: отозвана или истекла — попросите пару прислать новую'),
    }))
    const r = openChat()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Ссылка недействительна'), { timeout: 4000 })
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull()
    expect(text(r)).not.toContain('Сервер ответил 410')
  })

  it('«Назад» — к приглашению', async () => {
    serve(guestRoutes({ [MSGS]: { items: ITEMS, nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Назад'))
    await waitFor(() => expect(text(r)).toContain('Открыть приглашение'), { timeout: 4000 })
    expect(text(r)).not.toContain('Чат дня свадьбы')
  })
})

/* ── Пара: тайминг и чат ─────────────────────────────────────────────────── */

const TIMELINE = '/weddings/w1/timeline'
const A = { id: 'a', name: 'Сборы', startsAt: '2027-06-14T06:00:00.000Z', forGuests: true }
const B = { id: 'b', name: 'Церемония', startsAt: '2027-06-14T08:00:00.000Z', forGuests: true }
const flags = (c: Call) => (c.body as { forGuests?: boolean }[]).map(e => e.forGuests)

describe('T3: тайминг пары — «Показывать гостям» у блока и в форме; PUT несёт forGuests у каждого блока', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const openTimeline = () => renderAt('/wedding/timeline', <Route path="/wedding/timeline" element={<Timeline />} />)
  const addEvent = (name: string, from: string) => {
    fireEvent.change(screen.getByPlaceholderText('Событие (например, «Первый танец»)'), { target: { value: name } })
    fireEvent.change(screen.getByLabelText('Начало'), { target: { value: from } })
    fireEvent.click(screen.getByText('Добавить в тайминг'))
  }

  it('снять галочку у «Сборов» → PUT всего списка: forGuests false у A и true у B', async () => {
    const calls = serve(base({ [TIMELINE]: (c: Call) => (c.method === 'PUT' ? c.body : [A, B]) }))
    const r = openTimeline()
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Править'))
    /* Первая галочка — в форме нового блока, дальше — по блоку. */
    const boxes = screen.getAllByLabelText('Показывать гостям') as HTMLInputElement[]
    expect(boxes.length, 'галочек «Показывать гостям» не столько, сколько блоков плюс форма').toBe(3)
    expect(boxes[1]!.checked).toBe(true)
    fireEvent.click(boxes[1]!)
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(1), { timeout: 4000 })
    expect(flags(puts(calls, TIMELINE)[0]!), 'PUT не несёт forGuests у каждого блока').toEqual([false, true])
    expect((puts(calls, TIMELINE)[0]!.body as { name: string }[]).map(e => e.name)).toEqual(['Сборы', 'Церемония'])
  })

  it('форма: галочка включена по умолчанию — новый блок с forGuests: true; снятая — false', async () => {
    const calls = serve(base({ [TIMELINE]: (c: Call) => (c.method === 'PUT' ? c.body : [A, B]) }))
    const r = openTimeline()
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Править'))
    const form = screen.getAllByLabelText('Показывать гостям')[0] as HTMLInputElement
    expect(form.checked, 'галочка нового блока по умолчанию снята').toBe(true)
    addEvent('Торт', '19:00')
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(1), { timeout: 4000 })
    expect(flags(puts(calls, TIMELINE)[0]!)).toEqual([true, true, true])

    await waitFor(() => expect(screen.queryByText('Сохраняем…')).toBeNull())
    fireEvent.click(screen.getByText('Править'))
    fireEvent.click(screen.getAllByLabelText('Показывать гостям')[0]!)
    addEvent('Монтаж арки', '07:00')
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(2), { timeout: 4000 })
    const last = (puts(calls, TIMELINE)[1]!.body as { name: string; forGuests: boolean }[]).at(-1)!
    expect(last.name).toBe('Монтаж арки')
    expect(last.forGuests, 'снятая галочка не дошла до PUT').toBe(false)
  })

  it('блок с forGuests: false подписан «скрыт от гостей», с true — нет', async () => {
    serve(base({ [TIMELINE]: [{ ...A, forGuests: false }, B] }))
    const r = openTimeline()
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    expect(text(r), 'скрытый от гостей блок не помечен').toContain('скрыт от гостей')
    expect(screen.getAllByText('скрыт от гостей').length).toBe(1)
    expect(screen.getByText('скрыт от гостей').closest('.card-s')!.textContent).toContain('Сборы')
  })

  it('ответ без forGuests (старый сервер/фикстуры) — крестик у A → PUT [B] с forGuests: true, а не без поля', async () => {
    const calls = serve(base({ [TIMELINE]: (c: Call) => (c.method === 'PUT' ? c.body : [{ id: 'a', name: 'Сборы', startsAt: A.startsAt }, { id: 'b', name: 'Церемония', startsAt: B.startsAt }]) }))
    const r = openTimeline()
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    expect(text(r)).not.toContain('скрыт от гостей')
    fireEvent.click(screen.getByText('Править'))
    fireEvent.click(screen.getAllByLabelText('Убрать из тайминга')[0]!)
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(1), { timeout: 4000 })
    expect(flags(puts(calls, TIMELINE)[0]!), 'блок ушёл без forGuests — сервер вернул бы его к умолчанию').toEqual([true])
  })
})

describe('T4: чат пары — реплика гостя с именем и пометкой «гость», не «Участник вышел» и не система', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const msg = (n: number, senderId: string | null, body: string, over: Record<string, unknown> = {}) =>
    ({ id: `m${n}`, chatId: 'ch1', senderId, text: body, sentAt: `2027-06-14T10:00:0${n}.000Z`, ...over })
  const MESSAGES = '/chats/ch1/messages'

  it('guestName: «Марина» → имя и «гость» на пузыре; «Участник вышел» и ⚠ нет', async () => {
    serve(base({
      '/chats': [{ id: 'ch1', kind: 'day', title: 'Чат дня X', unread: 0, lastMessage: '' }],
      [MESSAGES]: { items: [msg(2, null, 'Автобус задерживается', { guestName: 'Марина' }), msg(1, 'u1', 'Мы на месте')], nextCursor: null },
    }))
    const r = renderAt('/us/chats/ch1', <Route path="/us/chats/:id" element={<Chat />} />)
    await waitFor(() => expect(text(r)).toContain('Автобус задерживается'), { timeout: 4000 })
    expect(text(r), 'имени гостя у его реплики нет').toContain('Марина')
    expect(text(r)).toContain('гость')
    expect(screen.queryByText('Участник вышел'), 'реплика гостя нарисована репликой ушедшего участника').toBeNull()
    expect(text(r)).not.toContain('⚠')
  })

  it('контроль: без guestName и без автора — по-прежнему «Участник вышел»', async () => {
    serve(base({
      '/chats': [{ id: 'ch1', kind: 'day', title: 'Чат дня X', unread: 0, lastMessage: '' }],
      [MESSAGES]: { items: [msg(2, null, 'Заеду за тортом'), msg(1, 'u1', 'Мы на месте')], nextCursor: null },
    }))
    const r = renderAt('/us/chats/ch1', <Route path="/us/chats/:id" element={<Chat />} />)
    await waitFor(() => expect(text(r)).toContain('Заеду за тортом'), { timeout: 4000 })
    expect(screen.getByText('Участник вышел')).toBeTruthy()
    expect(text(r)).not.toContain('гость')
  })
})
