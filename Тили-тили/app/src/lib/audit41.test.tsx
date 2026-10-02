// @vitest-environment jsdom
/*
 * Фича 014 «Хвосты до прода» — фронт.
 *
 *  A1  анкета подрядчика вне шаблона мозаики: «Добавить в свадьбу» заводит слот
 *      (`POST /weddings/{id}/slots`) и бронирует в него; 409 `slot_exists` —
 *      бронь в названный сервером слот. Красный без фикса: надпись «категория не
 *      входит в мозаику», запроса нет.
 *  A4  настройки подрядчика — тихие часы и виды «сообщения»/«сделки».
 *  A5  настройки пары — «Выйти только с этого устройства».
 *  A6  заявка консьержу уходит с городом СВАДЬБЫ, а не города телефона.
 *  A7  раздел «День свадьбы» — гостю без ответа тоже; «не приду» — нет.
 *  A8  своя реплика в чате дня — по `mine` от сервера, не по имени.
 *  B1  заметки — с сервера: список, добавление, удаление, перенос заметок
 *      прежней версии с устройства одной кнопкой (по запросу на каждую).
 * Харнесс `serve` — из audit36: проверяется то, что ушло на сервер и что видно.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import Invite, { GuestDayChat } from '@/pages/Invite'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  ({ __status: status, body: { error: { code, message, ...(details ? { details } : {}) } } })

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = decodeURIComponent(full.split('?')[0] ?? '')
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    const call: Call = { method: init?.method ?? 'GET', path, url: full, body }
    calls.push(call)
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(call) : stored
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 60))

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const SLOT = (id: string, categoryId: string, label: string) => ({ id, categoryId, label, deal: null, tileState: 'empty' })
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [SLOT('s-photo', 'photo', 'Фотограф')],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/users/me/sessions': [{ id: 'ses1', device: 'Этот телефон', current: true, createdAt: '2026-09-01T10:00:00.000Z' }],
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }, { id: 'firework', title: 'Пиротехника', icon: '🎆' }],
  ...over,
})

describe('фича 014: заметки на сервере (B1)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const NOTES = '/weddings/w1/notes'
  const note = (id: string, text: string, authorName: string | null = 'Аня') => ({ id, text, authorName, createdAt: '2026-09-13T08:00:00.000Z' })

  it('список — с сервера (автор и дата), добавление — POST с текстом, удаление — DELETE; подпись про команду, а не про устройство', async () => {
    let list = [note('n1', 'Торт — трёхъярусный'), note('n2', 'Свечи заранее', null)]
    const calls = serve(base({
      [NOTES]: (c: Call) => {
        if (c.method === 'POST') { const n = note('n3', (c.body as { text: string }).text); list = [n, ...list]; return n }
        return list
      },
      '/weddings/w1/notes/n1': (c: Call) => { if (c.method === 'DELETE') list = list.filter(n => n.id !== 'n1'); return { __status: 204, body: null } },
    }))
    const r = await open('/notes', 'Торт — трёхъярусный')
    expect(gets(calls, NOTES).length).toBeGreaterThanOrEqual(1)
    expect(text(r)).toContain('Аня · ')
    expect(text(r), 'автор без имени — словами').toContain('без имени · ')
    expect(text(r)).toContain('Заметки видит вся команда свадьбы')
    expect(text(r)).not.toContain('хранятся только на этом устройстве')

    fireEvent.change(screen.getByPlaceholderText('Новая заметка…'), { target: { value: '  Флорист: пионы  ' } })
    fireEvent.click(screen.getByLabelText('Добавить'))
    await waitFor(() => expect(posts(calls, NOTES)).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, NOTES)[0]!.body).toEqual({ text: 'Флорист: пионы' })
    await waitFor(() => expect(text(r)).toContain('Флорист: пионы'), { timeout: 4000 })
    expect((screen.getByPlaceholderText('Новая заметка…') as HTMLInputElement).value, 'поле очищено после 201').toBe('')

    const card = screen.getByText('Торт — трёхъярусный').closest('.card-s')!
    fireEvent.click(card.querySelector('button[aria-label="Удалить"]')!)
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/weddings/w1/notes/n1')).toBe(true), { timeout: 4000 })
    await waitFor(() => expect(text(r)).not.toContain('Торт — трёхъярусный'), { timeout: 4000 })
  })

  it('заметки прежней версии с устройства переносятся одной кнопкой: по POST на каждую, старые первыми, хранилище очищено', async () => {
    localStorage.setItem('tt_notes', JSON.stringify([
      { id: 'a', icon: '📌', tile: 'x', text: 'Свежая заметка' },
      { id: 'b', icon: '📌', tile: 'x', text: 'Старая заметка' },
      { id: 'c', text: '   ' },
    ]))
    const calls = serve(base({ [NOTES]: (c: Call) => (c.method === 'POST' ? note('n9', (c.body as { text: string }).text) : []) }))
    const r = await open('/notes', 'заметки прежней версии')
    expect(text(r)).toContain('заметки прежней версии: 2')
    expect(posts(calls, NOTES), 'без нажатия ничего не уходит').toHaveLength(0)

    fireEvent.click(screen.getByText('Перенести на сервер'))
    await waitFor(() => expect(posts(calls, NOTES)).toHaveLength(2), { timeout: 4000 })
    expect(posts(calls, NOTES).map(c => (c.body as { text: string }).text), 'старые первыми — порядок сохраняется').toEqual(['Старая заметка', 'Свежая заметка'])
    await waitFor(() => expect(localStorage.getItem('tt_notes')).toBeNull(), { timeout: 4000 })
    await waitFor(() => expect(text(r)).not.toContain('заметки прежней версии'), { timeout: 4000 })
  })

  it('без свадьбы заметок нет — предложение завести её, запроса к серверу нет', async () => {
    localStorage.removeItem('tt_wedding_id')
    const calls = serve(base({ '/weddings': [] }))
    const r = await open('/notes', 'Заметки принадлежат свадьбе')
    expect(text(r)).toContain('Начать новую свадьбу')
    await settle()
    expect(calls.filter(c => c.path.endsWith('/notes'))).toHaveLength(0)
  })
})

describe('фича 014: настройки (A4, A5)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('у пары — «Выйти только с этого устройства» рядом с «со всех устройств»', async () => {
    serve(base())
    const r = await open('/settings', 'Выйти со всех устройств')
    expect(text(r)).toContain('Выйти только с этого устройства')
  })

  it('в кабинете подрядчика — тихие часы и виды «сообщения»/«сделки», без «дедлайнов задач»', async () => {
    serve(base({ '/vendor/profile': { id: 'v1', name: 'Салют' } }))
    const r = await open('/vendor-app/settings', 'Кабинет подрядчика')
    await waitFor(() => expect(text(r)).toContain('Тихие часы'), { timeout: 4000 })
    expect(text(r)).toContain('Push: сообщения')
    expect(text(r)).toContain('Push: сделки и оплаты')
    expect(text(r)).not.toContain('дедлайны задач')
  })
})

describe('фича 014: слот вне шаблона при брони (A1) и город консьержа (A6)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const VENDOR = {
    id: 'v-fw', name: 'Салют над Уфой', categoryId: 'firework', city: 'Уфа', verified: false, hasVideo: false,
    priceFrom: { amount: 3_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0,
    packages: [{ name: 'Малый салют', price: { amount: 3_000_000, currency: 'RUB' }, items: [] }],
  }
  const vendorRoutes = (over: Routes = {}): Routes => base({
    '/catalog/vendors/v-fw': VENDOR,
    // These A1 witnesses exercise the existing day-booking strategy. Unknown
    // policy now correctly refuses the write rather than guessing legacy.
    '/vendors/v-fw/booking-policy': { mode: 'legacy_day', revision: '0' },
    '/catalog/vendors': { items: [], nextCursor: null },
    '/catalog/vendors/v-fw/availability': { busyDates: [] },
    '/catalog/vendors/v-fw/reviews': { items: [], nextCursor: null },
    ...over,
  })

  it('«Добавить в свадьбу» у пиротехника: POST /slots {categoryId} → бронь в новый слот', async () => {
    const calls = serve(vendorRoutes({
      '/weddings/w1/slots': (c: Call) => (c.method === 'POST' ? { ...SLOT('s-fw', 'firework', 'Пиротехника') } : [SLOT('s-photo', 'photo', 'Фотограф')]),
      '/weddings/w1/slots/s-fw/book': SLOT('s-fw', 'firework', 'Пиротехника'),
    }))
    await open('/vendor/v-fw', 'Добавить в свадьбу')
    await waitFor(() => expect((screen.getByText('Добавить в свадьбу') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Добавить в свадьбу'))
    await waitFor(() => expect(posts(calls, '/weddings/w1/slots')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/weddings/w1/slots')[0]!.body).toEqual({ categoryId: 'firework' })
    await waitFor(() => expect(posts(calls, '/weddings/w1/slots/s-fw/book')).toHaveLength(1), { timeout: 4000 })
    expect((posts(calls, '/weddings/w1/slots/s-fw/book')[0]!.body as { vendorId: string }).vendorId).toBe('v-fw')
    expect(posts(calls, '/weddings/w1/slots/s-fw/book')[0]!.body).toEqual({ vendorId: 'v-fw', price: { amount: 3_000_000, currency: 'RUB' } })
    expect(gets(calls, '/vendors/v-fw/booking-policy').length).toBeGreaterThanOrEqual(2)
    await waitFor(() => expect(screen.getByText('✓ В моей свадьбе!')).toBeTruthy(), { timeout: 4000 })
  })

  it('409 slot_exists — бронь идёт в слот, названный сервером', async () => {
    const calls = serve(vendorRoutes({
      '/weddings/w1/slots': (c: Call) => (c.method === 'POST'
        ? withStatus(409, 'slot_exists', 'Слот этой категории уже есть', { slotId: 's-old' })
        : [SLOT('s-photo', 'photo', 'Фотограф')]),
      '/weddings/w1/slots/s-old/book': SLOT('s-old', 'firework', 'Пиротехника'),
    }))
    await open('/vendor/v-fw', 'Добавить в свадьбу')
    await waitFor(() => expect((screen.getByText('Добавить в свадьбу') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByText('Добавить в свадьбу'))
    await waitFor(() => expect(posts(calls, '/weddings/w1/slots/s-old/book')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/weddings/w1/slots')[0]!.body).toEqual({ categoryId: 'firework' })
    expect(posts(calls, '/weddings/w1/slots/s-old/book')[0]!.body).toEqual({ vendorId: 'v-fw', price: { amount: 3_000_000, currency: 'RUB' } })
    expect(gets(calls, '/vendors/v-fw/booking-policy').length).toBeGreaterThanOrEqual(2)
  })

  it('заявка консьержу несёт город свадьбы (Уфа), а не город устройства (Казань)', async () => {
    localStorage.setItem('tt_city', 'Казань')
    localStorage.setItem('tt_city_region', 'Татарстан')
    const calls = serve(base({
      '/catalog/vendors': { items: [], nextCursor: null },
      '/catalog/concierge': { id: 'c1', status: 'new' },
    }))
    await open('/search/firework', 'Оставить заявку консьержу')
    fireEvent.click(screen.getByText('Оставить заявку консьержу'))
    fireEvent.click(await screen.findByText('Отправить'))
    await waitFor(() => expect(posts(calls, '/catalog/concierge')).toHaveLength(1), { timeout: 4000 })
    expect((posts(calls, '/catalog/concierge')[0]!.body as { city?: string }).city).toBe('Уфа')
  })
})

describe('фича 014: гость — день свадьбы без ответа (A7) и своя реплика по mine (A8)', () => {
  const guest = () => { localStorage.clear(); localStorage.setItem('tt_guest_token', 'tok1') }
  const page = (status: string) => ({ guestName: 'Марина', status, wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } })
  const DAY = {
    date: '2027-06-14', tz: 'Asia/Yekaterinburg', venue: 'Усадьба', dressCode: null, dressNote: null,
    timeline: [{ id: 'e1', name: 'Церемония', startsAt: '2027-06-14T08:00:00.000Z', forGuests: true }],
    table: { name: 'У окна' }, bus: null, coordinator: null,
    chat: { open: true, opensAt: '2027-06-13T04:00:00.000Z', closesAt: '2027-06-15T18:59:59.000Z' },
  }
  const guestRoutes = (status: string, over: Routes = {}): Routes => ({
    '/rsvp/tok1': page(status),
    '/join/tok1/menu-vote': { question: '', options: [] },
    '/join/tok1/shuttle': { routes: [] },
    '/join/tok1/hotels': [],
    '/join/tok1/day': DAY,
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
  beforeEach(() => {
    guest()
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2027-06-13T12:00:00.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('гость без ответа накануне видит раздел «День свадьбы»; «не приду» — нет', async () => {
    const calls = serve(guestRoutes('pending'))
    const r = openGuest()
    await waitFor(() => expect(text(r)).toContain('Ваш стол:'), { timeout: 4000 })
    expect(gets(calls, '/join/tok1/day').length).toBeGreaterThanOrEqual(1)
    cleanup(); vi.unstubAllGlobals()
    const calls2 = serve(guestRoutes('no'))
    const r2 = openGuest()
    await waitFor(() => expect(text(r2)).toContain('Ждём вас'), { timeout: 4000 })
    await settle()
    expect(gets(calls2, '/join/tok1/day'), 'отказавшемуся программу не показываем и не запрашиваем').toHaveLength(0)
    expect(text(r2)).not.toContain('Ваш стол')
  })

  it('две Марины: своя реплика — та, что сервер пометил mine, а не всякая с тем же именем', async () => {
    serve(guestRoutes('yes', {
      '/join/tok1/day-chat/messages': {
        items: [
          { id: 'm2', senderId: null, text: 'А я в зале', sentAt: '2027-06-13T11:00:00.000Z', system: false, guestName: 'Марина', mine: false },
          { id: 'm1', senderId: null, text: 'Я у входа', sentAt: '2027-06-13T10:00:00.000Z', system: false, guestName: 'Марина', mine: true },
        ],
        nextCursor: null,
      },
    }))
    const r = openGuest('/invite/day-chat')
    await waitFor(() => expect(text(r)).toContain('А я в зале'), { timeout: 4000 })
    const own = screen.getByText(/Я у входа/).closest('div')!
    const other = screen.getByText(/А я в зале/).closest('div')!
    expect(own.className, 'своя — на градиенте').toContain('grad')
    expect(own.textContent, 'у своей нет подписи автора').not.toContain('Марина')
    expect(other.className, 'чужая тёзка — карточкой').toContain('card')
    expect(other.textContent).toContain('Марина')
  })
})
