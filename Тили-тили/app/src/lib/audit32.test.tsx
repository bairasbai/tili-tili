// @vitest-environment jsdom
/*
 * Фича 005, экраны под контракт v0.29.0 (задание FE-A). Каждый тест здесь был
 * красным на коде до фикса — цитаты красного в отчёте `REPORT-FE-A.md`.
 *
 * Что закрывается:
 *  — гость видит свою бронь отеля (`HotelBlock.mine`) и переносит её только
 *    с подтверждением, а не молчаливым тапом (T1);
 *  — пара видит комментарий гостя из RSVP и «телефон записан» там, где номер
 *    ей не отдаётся; «Напомнить не ответившим» — только паре (T2);
 *  — столы переименовываются и удаляются (`PATCH`/`DELETE …/tables/{id}`),
 *    409 `table_full` — словами сервера под кнопкой (T3);
 *  — мастер договора без `?deal=` предлагает выбрать сделку из мозаики (T4);
 *  — системная запись чата рисуется по `Message.system`, закрытый чат своего
 *    подрядчика — без поля ввода и с пометкой в списке (T5);
 *  — день X после «+15 мин» и плана Б называет, скольких гостей это касается
 *    (`guestsAffected`), и не читает `notifiedGuests` (T6);
 *  — кабинет: `blocked` — плашка и никакой кнопки публикации, `shortfall` —
 *    строка недоплаты, `packageName` на карточке сделки (T7);
 *  — настройки: список push-подписок с «это устройство», снятие всех; 429 на
 *    «Получить код» — таймер `Retry-After` и закрытая кнопка (T8);
 *  — квиз: 409 `wedding_exists` — текст и переход к своей свадьбе (T9);
 *  — рассылки: ответ 202 словами из `BroadcastResult` (T10).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик (приём из `audit25`/`audit30`/`audit31`).
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { LEGAL_TEXT_VERSION } from './legal'
import Invite from '@/pages/Invite'
import Quiz from '@/pages/Quiz'
import { GuestReviewForm } from '@/pages/Wishlist'
import { Guests } from '@/pages/Wedding'
import { ContractWizard, Deal, Seating } from '@/pages/Tools'
import { Chat, Chats } from '@/pages/Us'
import { Catering, Logistics } from '@/pages/Logistics'
import { DayX } from '@/pages/Smart'
import { VendorDashboard, VendorDeals, VendorProfileWizard } from '@/pages/VendorApp'
import { Auth, Settings } from '@/pages/Account'
import { shiftPreviewFixture } from '@/test/timelineShiftFixture'

/* Живой канал чата подменяется, как в audit27: настоящий WebSocket в jsdom
   тянулся бы к серверу и переподключался по таймеру. Остальное — настоящее. */
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
function isLater(v: unknown): v is { __later: Promise<unknown> } {
  return typeof v === 'object' && v !== null && '__later' in v
}

/** Отказ сервера в формате контракта: код и текст, при желании — заголовки и `details`. */
const withStatus = (status: number, code: string, message: string, headers: Record<string, string> = {}, details?: Record<string, unknown>) =>
  ({ __status: status, body: { error: { code, message, ...(details ? { details } : {}) } }, headers })

/** Ответ, который придёт, когда тест его отпустит (окно «свежий ответ в пути»). */
function gate() {
  let release!: (body: unknown) => void
  const promise = new Promise<unknown>(resolve => { release = resolve })
  return { reply: { __later: promise }, release }
}

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
    if (isLater(reply)) return reply.__later.then(body => json(body))
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status, reply.headers))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const TOKENS = { accessToken: 'a', refreshToken: 'r' }
const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
}
const couple = () => {
  signedIn()
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }

/** Всё, что читают стор и экраны пары. `role` — своя роль в свадьбе. */
const base = (over: Routes = {}, role = 'couple'): Routes => ({
  '/weddings': [{ ...WEDDING, role }],
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
const button = (label: string) => screen.getByText(label).closest('button')!
const disabled = (label: string) => button(label).hasAttribute('disabled')
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const patches = (calls: Call[], path: string) => calls.filter(c => c.method === 'PATCH' && c.path === path)
const deletes = (calls: Call[], path: string) => calls.filter(c => c.method === 'DELETE' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

/* Пока не понадобились: тот же набор помощников, что в audit31. */
void gate; void PENDING; void gets; void DOWN

/* ── T6: день X — «касается N гостей» из `guestsAffected` ─────────────────── */

describe('T6: после «+15 мин» и плана Б экран называет, скольких гостей это касается, и не читает notifiedGuests', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const CEREMONY = { id: 'e1', name: 'Церемония', startsAt: '2027-06-14T11:00:00.000Z' }
  const dayx = (over: Routes) => base({
    '/weddings/w1/timeline': [CEREMONY],
    '/weddings/w1/planb': { checklist: [], activatedAt: null },
    '/weddings/w1/events': [],
    '/weddings/w1/timeline/shift/preview': { __status: 200, body: shiftPreviewFixture(), headers: { etag: '"1"' } },
    ...over,
  })

  it('«+15 мин»: {guestsAffected: 15, notifiedGuests: 0} → «касается гостей: 15 — сообщите им сами»', async () => {
    serve(dayx({ '/weddings/w1/timeline/shift': { minutes: 15, shiftedBlocks: 1, guestsAffected: 15, notifiedGuests: 0 } }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Сдвиг тайминга')).toBe(false))
    fireEvent.click(button('Сдвиг тайминга'))
    fireEvent.click(button('Предпросмотр сдвига'))
    await waitFor(() => expect(disabled('Подтвердить сдвиг')).toBe(false))
    fireEvent.click(button('Подтвердить сдвиг'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('касается гостей: 15'), { timeout: 4000 })
    expect(screen.getByRole('status').textContent).toContain('сообщите им сами')
    expect(screen.getByRole('dialog').textContent, 'ноль из устаревшего notifiedGuests попал на экран').not.toContain('гостей: 0')
  })

  it('план Б: ответ с guestsAffected: 3 → строка про трёх гостей', async () => {
    serve(dayx({ '/weddings/w1/planb/activate': { scenario: 'rain', guestsAffected: 3, notifiedGuests: 0 } }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Активировать')).toBe(false))
    fireEvent.click(button('Активировать'))
    fireEvent.click(button('Подтвердить'))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('касается гостей: 3'), { timeout: 4000 })
  })

  it('сервер числа не назвал (только notifiedGuests: 0) — строки нет: ноль ≠ неизвестно', async () => {
    serve(dayx({ '/weddings/w1/timeline/shift': { minutes: 15, shiftedBlocks: 1, notifiedGuests: 0 } }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Сдвиг тайминга')).toBe(false))
    fireEvent.click(button('Сдвиг тайминга'))
    fireEvent.click(button('Предпросмотр сдвига'))
    await waitFor(() => expect(disabled('Подтвердить сдвиг')).toBe(false))
    fireEvent.click(button('Подтвердить сдвиг'))
    await waitFor(() => expect(screen.queryByText('Двигаем…')).toBeNull(), { timeout: 4000 })
    await settle()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('dialog').textContent).not.toContain('undefined')
  })
})

/* ── T10: рассылки — ответ 202 словами из `BroadcastResult` ─────────────── */

describe('T10: «Разослать точки сбора» и «Напомнить» показывают, скольким из команды ушло и скольких гостей касается', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const BUS = { id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 20, taken: 3 }

  it('точки сбора: 202 {notified: 2, recipients: 7} → «Команде ушло: 2 · касается гостей: 7»', async () => {
    serve(base({
      '/weddings/w1/logistics/buses': [BUS],
      '/weddings/w1/logistics/hotels': [],
      '/weddings/w1/logistics/notify-pickup': { __status: 202, body: { broadcastId: 'x', recipients: 7, notified: 2, debounced: false }, headers: {} },
    }))
    const r = renderAt('/wedding/logistics', <Route path="/wedding/logistics" element={<Logistics />} />)
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Сообщить команде о точках сбора'))
    await waitFor(() => expect(text(r)).toContain('Команде ушло: 2'), { timeout: 4000 })
    expect(text(r), 'экран не назвал, скольких гостей касается рассылка').toContain('касается гостей: 7')
    expect(text(r)).toContain('гостям пока не доставляется')
  })

  it('точки сбора: debounced → «уже сообщали», чисел нет', async () => {
    serve(base({
      '/weddings/w1/logistics/buses': [BUS],
      '/weddings/w1/logistics/hotels': [],
      '/weddings/w1/logistics/notify-pickup': { __status: 202, body: { broadcastId: 'x', recipients: 7, notified: 0, debounced: true }, headers: {} },
    }))
    const r = renderAt('/wedding/logistics', <Route path="/wedding/logistics" element={<Logistics />} />)
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Сообщить команде о точках сбора'))
    await waitFor(() => expect(text(r)).toContain('Команде уже сообщали'), { timeout: 4000 })
    expect(text(r)).not.toContain('Команде ушло')
  })

  it('меню: «Напомнить» — те же два числа из 202', async () => {
    serve(base({
      '/weddings/w1/menu-poll': { question: 'Что на горячее?', options: [{ id: 'o1', name: 'Мясо', votes: 0 }], expectedPortions: 1 },
      '/weddings/w1/guests': [{ id: 'g1', name: 'Ольга', status: 'yes', plusOne: false }],
      '/weddings/w1/menu-poll/remind': { __status: 202, body: { broadcastId: 'y', recipients: 4, notified: 1, debounced: false }, headers: {} },
    }))
    const r = renderAt('/wedding/catering', <Route path="/wedding/catering" element={<Catering />} />)
    await waitFor(() => expect(text(r)).toContain('Мясо'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Напомнить'))
    await waitFor(() => expect(text(r)).toContain('Команде ушло: 1'), { timeout: 4000 })
    expect(text(r)).toContain('касается гостей: 4')
  })
})

/* ── T1: гость — своя бронь отеля и «свадьба прошла» по поясу свадьбы ───── */

describe('T1: гость видит свою бронь отеля и переносит её только с подтверждением', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_guest_token', 'tok1') })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PAGE = { guestName: 'Марина', status: 'yes', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } }
  const HOTELS = '/join/tok1/hotels'
  const guestRoutes = (hotels: unknown): Routes => ({
    '/rsvp/tok1': PAGE,
    '/join/tok1/menu-vote': { question: '', options: [] },
    '/join/tok1/shuttle': { routes: [] },
    [HOTELS]: hotels,
  })
  const H1 = { id: 'h1', name: 'Отель «Башкирия»', rooms: 10, booked: 3, mine: true }
  const H2 = { id: 'h2', name: 'Гостиница «Агидель»', rooms: 5, booked: 0 }
  const openInvite = () => render(<MemoryRouter initialEntries={['/invite']}><Routes><Route path="/invite" element={<Invite />} /></Routes></MemoryRouter>)

  it('свой блок подписан «Вы здесь»; тап по другому — «Перенести бронь?», POST только после второго тапа', async () => {
    const calls = serve(guestRoutes([H1, H2]))
    const r = openInvite()
    await waitFor(() => expect(text(r)).toContain('Агидель'), { timeout: 4000 })
    expect(text(r), 'гость не видит своей брони').toContain('Вы здесь')
    fireEvent.click(screen.getByText('Гостиница «Агидель»'))
    await settle()
    expect(posts(calls, HOTELS).length, 'бронь перенесена молча, без подтверждения').toBe(0)
    expect(text(r)).toContain('Перенести бронь?')
    fireEvent.click(screen.getByText('Перенести бронь?'))
    await waitFor(() => expect(posts(calls, HOTELS).length).toBe(1))
    expect(posts(calls, HOTELS)[0]!.body).toEqual({ hotelId: 'h2' })
  })

  it('своей брони нет — первый тап занимает номер сразу (контроль)', async () => {
    const calls = serve(guestRoutes([{ ...H1, mine: false }, H2]))
    const r = openInvite()
    await waitFor(() => expect(text(r)).toContain('Агидель'), { timeout: 4000 })
    expect(text(r)).not.toContain('Вы здесь')
    fireEvent.click(screen.getByText('Гостиница «Агидель»'))
    await waitFor(() => expect(posts(calls, HOTELS).length).toBe(1))
    expect(text(r)).not.toContain('Перенести бронь?')
  })
})

describe('T1: «свадьба прошла» для отзыва гостя считается по поясу свадьбы из GET /join/{t}/team', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
    /* 00:30 UTC 15 июня: в UTC+14 уже 15-е (день прошёл), в UTC−11 ещё 14-е.
       Пояс устройства — любой: два ответа обязаны различаться. */
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-15T00:30:00.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const TEAM = { weddingId: 'w1', weddingDate: '2027-06-14', vendors: [{ vendorId: 'v1', name: 'Фото «Кадр»', categoryId: 'photo' }] }
  const openForm = () => render(<MemoryRouter><GuestReviewForm /></MemoryRouter>)

  it('UTC+14 — день прошёл, форма есть; UTC−11 — ещё нет, «после дня свадьбы» (сертификация D3-18)', async () => {
    serve({ '/join/tok1/team': { ...TEAM, tz: 'Pacific/Kiritimati' } })
    const r = openForm()
    await waitFor(() => expect(text(r)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(text(r)).toContain('Отправить отзыв гостя')
    cleanup(); vi.unstubAllGlobals()
    serve({ '/join/tok1/team': { ...TEAM, tz: 'Pacific/Pago_Pago' } })
    const r2 = openForm()
    await waitFor(() => expect(text(r2)).toContain('после дня свадьбы'), { timeout: 4000 })
    expect(text(r2), 'форма отзыва открыта до дня свадьбы по поясу свадьбы').not.toContain('Отправить отзыв гостя')
  })
})

/* ── T2: пара — комментарий гостя, «телефон записан», «Напомнить» только паре ── */

describe('T2: пара видит комментарий гостя и «телефон записан»; «Напомнить не ответившим» — только паре', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const OLGA = { id: 'g1', name: 'Ольга', status: 'yes', plusOne: false, comment: 'Будем с тортом!', phone: '+79170000001', hasPhone: true }
  const DENIS = { id: 'g2', name: 'Денис', status: 'pending', plusOne: false, phone: null, hasPhone: false }
  const openGuests = () => renderAt('/wedding/guests', <Route path="/wedding/guests" element={<Guests />} />)

  it('комментарий из RSVP — в строке гостя, как написал; без комментария строки нет', async () => {
    serve(base({ '/weddings/w1/guests': [OLGA, DENIS] }))
    const r = openGuests()
    await waitFor(() => expect(text(r)).toContain('Денис'), { timeout: 4000 })
    expect(text(r), 'комментарий гостя не показан паре').toContain('«Будем с тортом!»')
    expect(text(r)).not.toContain('«»')
  })

  it('помощник: номера в ответе нет, hasPhone — «телефон записан» без цифр и без поля; кнопки «Напомнить» нет', async () => {
    serve(base({ '/weddings/w1/guests': [{ id: 'g1', name: 'Ольга', status: 'yes', plusOne: false, hasPhone: true }, { id: 'g2', name: 'Денис', status: 'pending', plusOne: false, hasPhone: false }] }, 'helper'))
    const r = openGuests()
    await waitFor(() => expect(text(r)).toContain('Денис'), { timeout: 4000 })
    expect(text(r), 'факт «телефон записан» не показан').toContain('телефон записан')
    expect(text(r)).toContain('+ телефон для напоминания')
    await waitFor(() => expect(text(r)).not.toContain('Загружаем…'), { timeout: 4000 })
    expect(screen.queryByText('Напомнить не ответившим'), 'кнопка с заведомым 403 показана помощнику').toBeNull()
  })

  it('пара: кнопка «Напомнить не ответившим» есть (контроль)', async () => {
    serve(base({ '/weddings/w1/guests': [DENIS] }))
    const r = openGuests()
    await waitFor(() => expect(text(r)).toContain('Денис'), { timeout: 4000 })
    await waitFor(() => expect(screen.getByText('Напомнить не ответившим')).toBeTruthy(), { timeout: 4000 })
  })
})

/* ── T3: столы — PATCH / DELETE, 409 table_full словами сервера ──────────── */

describe('T3: столы переименовываются и удаляются через PATCH/DELETE; 409 table_full — словами сервера под кнопкой', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const TABLE = { id: 't1', name: 'Стол №1', capacity: 8 }
  const T1 = '/weddings/w1/tables/t1'
  const seating = (over: Routes = {}) => base({
    '/weddings/w1/guests': [{ id: 'g1', name: 'Ольга', status: 'yes', plusOne: false, tableId: 't1' }],
    '/weddings/w1/tables': [TABLE],
    ...over,
  })
  const openSeating = () => renderAt('/wedding/seating', <Route path="/wedding/seating" element={<Seating />} />)
  const alerts = () => screen.queryAllByRole('alert').map(e => e.textContent).join(' | ')

  it('переименовать: ✎ → имя → «Сохранить» → PATCH {name, capacity}, после — столы перечитаны', async () => {
    let tables = 0
    const calls = serve(seating({ '/weddings/w1/tables': () => { tables++; return [TABLE] }, [T1]: { ...TABLE, name: 'Родители' } }))
    const r = openSeating()
    await waitFor(() => expect(text(r)).toContain('Стол №1'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Переименовать стол'))
    fireEvent.change(screen.getByLabelText('Название стола'), { target: { value: 'Родители' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(patches(calls, T1).length).toBe(1))
    expect(patches(calls, T1)[0]!.body).toEqual({ name: 'Родители', capacity: 8 })
    await waitFor(() => expect(tables).toBe(2))
  })

  it('удалить: × → «Удалить?» → DELETE; до подтверждения запроса нет', async () => {
    const calls = serve(seating({ [T1]: { __status: 204, body: null, headers: {} } }))
    const r = openSeating()
    await waitFor(() => expect(text(r)).toContain('Стол №1'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Удалить стол'))
    await settle()
    expect(deletes(calls, T1).length, 'стол удалён без подтверждения').toBe(0)
    fireEvent.click(screen.getByText('Удалить?'))
    await waitFor(() => expect(deletes(calls, T1).length).toBe(1))
  })

  it('409 table_full на вместимость — текст сервера под «Сохранить», форма остаётся', async () => {
    serve(seating({ [T1]: withStatus(409, 'table_full', 'За столом уже сидят 6 человек — меньше нельзя') }))
    const r = openSeating()
    await waitFor(() => expect(text(r)).toContain('Стол №1'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Переименовать стол'))
    fireEvent.change(screen.getByLabelText('Мест за столом'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(alerts()).toContain('За столом уже сидят 6 человек'), { timeout: 4000 })
    expect(screen.getByLabelText('Название стола')).toBeTruthy()
  })
})

/* ── T4: мастер договора без ?deal= — выбор сделки из мозаики ───────────── */

const bookedSlot = (id: string, dealId: string, name: string, state = 'booked') => ({
  id, categoryId: 'photo', label: 'Фотограф', tileState: 'booked',
  deal: { id: dealId, state, vendor: { id: `v-${id}`, name }, price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
})

describe('T4: мастер договора без ?deal= предлагает выбрать сделку из мозаики', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const openWizard = () => renderAt('/wedding/documents/new', <Route path="/wedding/documents/new" element={<ContractWizard />} />)

  it('две забронированные — две кнопки, кандидат не предлагается; выбор подставляет исполнителя', async () => {
    serve(base({ '/weddings/w1/slots': [
      bookedSlot('s1', 'd1', 'Фото «Кадр»'),
      bookedSlot('s2', 'd2', 'Видео «Свет»', 'paid_deposit'),
      { id: 's3', categoryId: 'venue', label: 'Площадка', tileState: 'candidate', deal: { id: 'd3', state: 'candidate', vendor: { id: 'v3', name: 'Усадьба «Липки»' } } },
    ] }))
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(text(r)).toContain('Видео «Свет»')
    expect(text(r), 'кандидат предложен для договора — сервер ответит 409 not_booked').not.toContain('Усадьба «Липки»')
    expect(text(r)).not.toContain('откройте мастер кнопкой «Договор»')
    fireEvent.click(screen.getByText('Фото «Кадр»'))
    await waitFor(() => expect(screen.queryByText('Видео «Свет»')).toBeNull())
    fireEvent.click(screen.getByText('Далее'))
    await waitFor(() => expect((screen.getByPlaceholderText('ФИО или название исполнителя') as HTMLInputElement).value).toBe('Фото «Кадр»'))
  })

  it('забронированных нет — честный текст, а не «недоступно»', async () => {
    serve(base({ '/weddings/w1/slots': [] }))
    const r = openWizard()
    await waitFor(() => expect(text(r)).toContain('Забронированных сделок пока нет'), { timeout: 4000 })
    expect(text(r)).not.toContain('откройте мастер кнопкой «Договор»')
  })
})

/* ── T5: чаты — Message.system, закрытый чат своего подрядчика ──────────── */

describe('T5: системная запись — по Message.system; закрытый чат своего подрядчика — без поля ввода и с пометкой в списке', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const msg = (n: number, senderId: string | null, text: string, over: Record<string, unknown> = {}) =>
    ({ id: `m${n}`, chatId: 'ch1', senderId, text, sentAt: `2026-09-01T10:00:0${n}.000Z`, ...over })
  const chat = (over: Record<string, unknown> = {}) => ({ id: 'ch1', kind: 'external', title: 'Фото «Кадр»', unread: 0, lastMessage: '', ...over })
  const openChat = () => renderAt('/us/chats/ch1', <Route path="/us/chats/:id" element={<Chat />} />)
  const MESSAGES = '/chats/ch1/messages'

  it('system: true у любого текста — системная запись, а не «Участник вышел»', async () => {
    serve(base({ '/chats': [chat({ kind: 'team', title: 'Команда свадьбы' })], [MESSAGES]: { items: [msg(2, null, 'Тайминг сдвинут на 15 минут', { system: true }), msg(1, 'u1', 'реплика 1')], nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Тайминг сдвинут на 15 минут'), { timeout: 4000 })
    expect(screen.queryByText('Участник вышел'), 'системная запись нарисована репликой ушедшего участника').toBeNull()
    expect(text(r)).toContain('⚠ Тайминг сдвинут')
  })

  it('без system и без автора — реплика ушедшего участника (контроль)', async () => {
    serve(base({ '/chats': [chat({ kind: 'team', title: 'Команда свадьбы' })], [MESSAGES]: { items: [msg(2, null, 'Заеду за тортом в 12'), msg(1, 'u1', 'реплика 1')], nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Заеду за тортом в 12'), { timeout: 4000 })
    expect(screen.getByText('Участник вышел')).toBeTruthy()
    expect(text(r)).not.toContain('⚠')
  })

  it('closed: true — подпись «подрядчик убран», поля ввода нет', async () => {
    serve(base({ '/chats': [chat({ closed: true })], [MESSAGES]: { items: [msg(1, 'u1', 'Договорились')], nextCursor: null } }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Договорились'), { timeout: 4000 })
    expect(text(r), 'закрытый чат не назван закрытым').toContain('Подрядчик убран')
    expect(screen.queryByPlaceholderText('Сообщение…'), 'поле ввода открыто в закрытом чате — первое слово получит 409').toBeNull()
  })

  it('в списке чатов закрытый помечен «закрыт», открытый — нет', async () => {
    serve(base({ '/chats': [chat({ closed: true }), chat({ id: 'ch2', kind: 'team', title: 'Команда свадьбы' })] }))
    const r = renderAt('/us/chats', <Route path="/us/chats" element={<Chats />} />)
    await waitFor(() => expect(text(r)).toContain('Команда свадьбы'), { timeout: 4000 })
    expect(screen.getAllByText('закрыт')).toHaveLength(1)
    expect(screen.getByText('закрыт').closest('button')!.textContent).toContain('Фото «Кадр»')
  })

  it('список не знает о закрытии, а сервер ответил 409 chat_closed — текст сервера (контроль)', async () => {
    serve(base({ '/chats': [chat()], [MESSAGES]: (c: Call) => (c.method === 'POST' ? withStatus(409, 'chat_closed', 'Сделка отменена — писать некому') : { items: [msg(1, 'u1', 'Договорились')], nextCursor: null }) }))
    const r = openChat()
    await waitFor(() => expect(text(r)).toContain('Договорились'), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText('Сообщение…'), { target: { value: 'Привет' } })
    fireEvent.click(screen.getByLabelText('Отправить'))
    await waitFor(() => expect(text(r)).toContain('Сделка отменена — писать некому'), { timeout: 4000 })
  })
})

/* ── T7: кабинет — blocked, shortfall, packageName ──────────────────────── */

describe('T7: кабинет подрядчика — blocked без кнопки публикации, shortfall строкой, packageName на карточке сделки', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PROFILE = { id: 'v1', name: 'Фотостудия Свет', city: 'Уфа', categoryId: 'photo', about: 'Снимаем свадьбы', phone: '+79990000001', published: false, verified: false, packages: [], gallery: [], rating: null, reviewsCount: 0 }
  const cabinet = (profile: Record<string, unknown> = PROFILE, over: Routes = {}): Routes => ({
    '/vendor/profile': profile, '/vendor/updates': [], '/vendor/leads': [], '/vendor/calendar': [], '/vendor/reviews': [],
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф' }],
    '/weddings': [], '/me/favorites': [], '/users/me': ME,
    ...over,
  })

  it('дашборд: blocked — плашка «заблокирована модератором», а не «не опубликована»', async () => {
    signedIn()
    serve(cabinet({ ...PROFILE, blocked: true }))
    const r = renderAt('/vendor-app', <Route path="/vendor-app" element={<VendorDashboard />} />)
    await waitFor(() => expect(text(r)).toContain('Заполненность анкеты'), { timeout: 4000 })
    expect(text(r), 'блокировка не названа').toContain('Анкета заблокирована модератором')
    expect(text(r)).not.toContain('Анкета не опубликована')
  })

  it('мастер, шаг 5: blocked — кнопки «Опубликовать» нет, «Сохранить изменения» не шлёт publish', async () => {
    signedIn()
    const calls = serve(cabinet({ ...PROFILE, blocked: true }, { '/vendor/profile/publish': withStatus(409, 'vendor_blocked', 'Анкета заблокирована') }))
    const r = renderAt('/vendor-app/profile', <Route path="/vendor-app/profile" element={<VendorProfileWizard />} />)
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    for (let k = 1; k < 5; k++) {
      fireEvent.click(screen.getByText('Далее'))
      await waitFor(() => expect(text(r)).toContain(`Шаг ${k + 1} из 5`), { timeout: 4000 })
    }
    expect(screen.queryByText('Опубликовать анкету ✨'), 'кнопка публикации у заблокированной анкеты — заведомый 409').toBeNull()
    expect(text(r)).toContain('Анкета заблокирована модератором')
    fireEvent.click(screen.getByText('Сохранить изменения'))
    await waitFor(() => expect(text(r)).toContain('Изменения сохранены'), { timeout: 4000 })
    expect(posts(calls, '/vendor/profile/publish').length).toBe(0)
    expect(text(r)).toContain('остаётся заблокированной')
  })

  it('сделки: shortfall в ответе — строка «недоплата по завершённым»; без поля строки нет', async () => {
    signedIn()
    serve(cabinet(PROFILE, { '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, shortfall: { amount: 1_500_000, currency: 'RUB' }, items: [] } }))
    const r = renderAt('/vendor-app/deals', <Route path="/vendor-app/deals" element={<VendorDeals />} />)
    await waitFor(() => expect(text(r)).toContain('ожидается по сделкам'), { timeout: 4000 })
    expect(text(r), 'недоплата не показана').toContain('недоплата по завершённым')
    expect(text(r)).toMatch(/15\D000 ₽/)
    cleanup(); vi.unstubAllGlobals()
    serve(cabinet(PROFILE, { '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, items: [] } }))
    const r2 = renderAt('/vendor-app/deals', <Route path="/vendor-app/deals" element={<VendorDeals />} />)
    await waitFor(() => expect(text(r2)).toContain('ожидается по сделкам'), { timeout: 4000 })
    expect(text(r2), 'без поля shortfall строка выдумана').not.toContain('недоплата по завершённым')
  })

  it('сделки кабинета: packageName у строки — «Пакет: …»; без него строки нет', async () => {
    signedIn()
    const deal = (id: string, packageName: string | null) => ({ id, coupleName: 'Аня ♥ Боря', weddingDate: '2027-06-14', price: { amount: 5_000_000, currency: 'RUB' }, packageName, state: 'booked', holdUntil: null })
    serve(cabinet(PROFILE, { '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, items: [deal('d1', 'Полный день'), deal('d2', null)] } }))
    const r = renderAt('/vendor-app/deals', <Route path="/vendor-app/deals" element={<VendorDeals />} />)
    await waitFor(() => expect(text(r)).toContain('ожидается по сделкам'), { timeout: 4000 })
    expect(text(r), 'пакет проданной брони не показан подрядчику').toContain('Пакет: Полный день')
    expect((text(r).match(/Пакет:/g) ?? []).length, 'у сделки без пакета строка выдумана').toBe(1)
  })

  it('карточка сделки пары: packageName показан; без него строки «Пакет:» нет', async () => {
    couple()
    const slot = bookedSlot('s1', 'd1', 'Фото «Кадр»')
    serve(base({ '/weddings/w1/slots': [{ ...slot, deal: { ...slot.deal, packageName: 'Полный день' } }] }))
    const r = renderAt('/deal/d1', <Route path="/deal/:id" element={<Deal />} />)
    await waitFor(() => expect(text(r)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(text(r), 'пакет из брони не показан').toContain('Пакет: Полный день')
    cleanup(); vi.unstubAllGlobals()
    serve(base({ '/weddings/w1/slots': [{ ...slot, deal: { ...slot.deal, packageName: null } }] }))
    const r2 = renderAt('/deal/d1', <Route path="/deal/:id" element={<Deal />} />)
    await waitFor(() => expect(text(r2)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(text(r2)).not.toContain('Пакет:')
  })
})

/* ── T8: настройки — push-подписки с сервера; 429 на «Получить код» ─────── */

describe('T8: настройки — список push-подписок из GET с «это устройство» и «снять на всех»; 429 на «Получить код» — таймер Retry-After', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PUSH = '/users/me/push-subscriptions'
  const SUBS = [
    { id: 's1', endpointHost: 'fcm.googleapis.com', createdAt: '2026-09-01T10:00:00.000Z', mine: true },
    { id: 's2', endpointHost: 'web.push.apple.com', createdAt: '2026-08-20T08:00:00.000Z', mine: false },
  ]

  it('список: хост и «это устройство»; «Снять на всех» → после подтверждения DELETE без endpoint, список перечитан', async () => {
    couple()
    let subs: unknown[] = SUBS
    const calls = serve(base({
      '/users/me/sessions': [],
      [PUSH]: (c: Call) => { if (c.method === 'DELETE') { subs = []; return { __status: 204, body: null, headers: {} } } return subs },
    }))
    const r = renderAt('/settings', <Route path="/settings" element={<Settings />} />)
    await waitFor(() => expect(text(r)).toContain('fcm.googleapis.com'), { timeout: 4000 })
    expect(text(r)).toContain('web.push.apple.com')
    expect(text(r), 'своя подписка не отмечена').toContain('это устройство')
    fireEvent.click(screen.getByText('Снять push на всех устройствах'))
    await settle()
    expect(deletes(calls, PUSH).length, 'снято без подтверждения').toBe(0)
    fireEvent.click(screen.getByText('Снять на всех устройствах?'))
    await waitFor(() => expect(deletes(calls, PUSH).length).toBe(1))
    expect(deletes(calls, PUSH)[0]!.url, 'DELETE с endpoint снял бы одну подписку, а не все').not.toContain('endpoint=')
    await waitFor(() => expect(text(r)).toContain('Push не включён ни на одном устройстве'), { timeout: 4000 })
  })

  it('429 на «Получить код»: текст сервера, кнопка закрыта и показывает срок из Retry-After', async () => {
    localStorage.clear(); sessionStorage.clear()
    serve({
      '/legal/policy': { policyVersion: LEGAL_TEXT_VERSION },
      '/auth/otp': withStatus(429, 'too_many_requests', 'Слишком часто — подождите', { 'retry-after': '120' }),
    })
    const r = renderAt('/auth', <Route path="/auth" element={<Auth />} />)
    const consentBox = () => screen.getByRole('checkbox', { name: /обработку персональных данных/ })
    await waitFor(() => expect(consentBox().hasAttribute('disabled')).toBe(false), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText('917 123-45-67'), { target: { value: '9171234567' } })
    fireEvent.click(consentBox())
    fireEvent.click(screen.getByRole('checkbox', { name: 'Мне есть 18 лет' }))
    fireEvent.click(button('Получить код'))
    await waitFor(() => expect(text(r)).toContain('Слишком часто — подождите'), { timeout: 4000 })
    expect(text(r), 'срок из Retry-After не показан на «Получить код»').toMatch(/Получить код · [12]:\d\d/)
    expect(screen.getByText(/Получить код · [12]:\d\d/).closest('button')!.hasAttribute('disabled'), 'кнопка открыта — повтор уйдёт в тот же 429').toBe(true)
  })
})

/* ── T9: квиз — 409 wedding_exists открывает свою свадьбу ───────────────── */

/** Квиз от первого шага до «Создать мою свадьбу»: дата «ещё не решили», Уфа, первый вариант везде, оба имени (фича 018). */
function walkQuiz() {
  fireEvent.click(screen.getByText('Ещё не решили'))
  fireEvent.click(screen.getByText('Далее'))
  fireEvent.click(screen.getByText('Уфа'))
  fireEvent.click(screen.getByText('Далее'))
  for (let step = 0; step < 7; step++) {
    const partner = screen.queryByPlaceholderText('Имя партнёра')
    if (partner) {
      fireEvent.change(screen.getByPlaceholderText('Ваше имя'), { target: { value: 'Аня' } })
      fireEvent.change(partner, { target: { value: 'Тимур' } })
    }
    else fireEvent.click(screen.getAllByRole('button').filter(b => b.className.includes('card-s'))[0]!)
    fireEvent.click(screen.queryByText('Далее') ?? screen.getByText('Создать мою свадьбу ✨'))
  }
}

describe('T9: квиз — 409 wedding_exists: текст и переход к своей свадьбе по details.weddingId', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const quizRoutes = <><Route path="/quiz" element={<Quiz />} /><Route path="/home" element={<p>ГЛАВНАЯ</p>} /></>

  it('«Создать мою свадьбу» → 409 → weddingId из details записан, список свадеб перечитан, экран — главная', async () => {
    /* Телефон свадьбы не помнит, и GET /weddings до отказа её не показывает:
       так выглядит свадьба, заведённая партнёром с другого устройства. */
    let exists = false
    const calls = serve({
      '/weddings': (c: Call) => {
        if (c.method === 'POST') { exists = true; return withStatus(409, 'wedding_exists', 'Живая свадьба уже есть', {}, { weddingId: 'w-old' }) }
        return exists ? [{ ...WEDDING, id: 'w-old', role: 'couple' }] : []
      },
      '/weddings/w-old': { ...WEDDING, id: 'w-old' },
      '/weddings/w-old/slots': [],
      '/me/favorites': [],
      '/users/me': ME,
    })
    const r = renderAt('/quiz', quizRoutes)
    await waitFor(() => expect(text(r)).toContain('Когда ваша свадьба?'), { timeout: 4000 })
    walkQuiz()
    await waitFor(() => expect(posts(calls, '/weddings').length).toBe(1), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    expect(localStorage.getItem('tt_wedding_id'), 'свадьба из details.weddingId не записана').toBe(JSON.stringify('w-old'))
    expect(gets(calls, '/weddings').length, 'список свадеб после 409 не перечитан').toBeGreaterThanOrEqual(2)
  })

  it('409 без details — текст сервера, квиз остаётся (контроль)', async () => {
    serve({
      '/weddings': (c: Call) => (c.method === 'POST' ? withStatus(409, 'wedding_exists', 'Живая свадьба уже есть') : []),
      '/me/favorites': [], '/users/me': ME,
    })
    const r = renderAt('/quiz', quizRoutes)
    await waitFor(() => expect(text(r)).toContain('Когда ваша свадьба?'), { timeout: 4000 })
    walkQuiz()
    await waitFor(() => expect(text(r)).toContain('Живая свадьба уже есть'), { timeout: 4000 })
    expect(text(r)).not.toContain('ГЛАВНАЯ')
    /* Стор пишет снятое значение строкой «null», а не удаляет ключ (инвариант 3). */
    expect(JSON.parse(localStorage.getItem('tt_wedding_id') ?? 'null')).toBeNull()
  })
})
