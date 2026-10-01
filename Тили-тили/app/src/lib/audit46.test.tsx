// @vitest-environment jsdom
/*
 * Хвосты четырёх планов (сверка планов 2026-09-18) — фронт.
 *
 *  Ж1 «Пожаловаться на анкету» → `POST /complaints {vendor}`; «Жалоба принята».
 *  Ж2 «Открыть спор» на сделке → `POST /complaints {deal}`; на почту больше не ведёт.
 *  Ж3 «Пожаловаться на отзыв» в кабинете → `POST /complaints {review}`.
 *  Ж4 «Пожаловаться на собеседника» в чате — по последней реплике собеседника; в чате Тиля кнопки нет.
 *  У1 «Прочитать все» — один `POST /notifications/read-all`, без поштучных отметок.
 *  А1 «Одобрить все» в альбоме — один `PATCH /weddings/{id}/album`.
 *  К1 `/search` запрашивает категории с городом и показывает «N рядом» только при N > 0.
 *  П1 мастер анкеты: без прав на портфолио «Опубликовать» не шлёт publish; с галочкой — `mediaRights: true` в PUT.
 *  Э1 «Выгрузить мои данные» → `GET /users/me/export` и файл на устройстве.
 *  О1 день X без сервера — копия с телефона с меткой времени; без копии — прежнее «не загрузился».
 *  О2 копия снимается с живого ответа и стирается при смерти сессии.
 *  М1 `notificationRoute` знает `/after`, `/album`, `/catering`, `/home`.
 * Харнесс `serve` — из audit45.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { StoreProvider } from './store'
import { VendorProfileWizard } from '@/pages/VendorApp'
import { notificationRoute } from '@/lib/api/notifications'
import { OFFLINE_DAY_KEY, recallDay } from '@/lib/offlineDay'
import { offlineScope } from '@/lib/offlineAccess'
import { accessTokenForWs } from '@/lib/api/client'

vi.mock('@/lib/api/chats', async (orig) => ({
  ...await orig<object>(),
  openChatSocket: () => () => undefined,
}))

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })
const DOWN = withStatus(503, 'db_unavailable', 'База недоступна')

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', etag: '"1"' } })
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
const posts = (calls: Call[], path: string, method = 'POST') => calls.filter(c => c.method === method && c.path === path)

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
  localStorage.setItem('tt_city', JSON.stringify('Уфа'))
}
const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg', members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: { tasks: true, chats: true, deals: true, tips: true }, quietHours: { from: '22:00', to: '09:00' } }
const SLOT = (id: string, categoryId: string, label: string, deal: unknown = null) => ({ id, categoryId, label, deal, tileState: deal ? 'booked' : 'empty' })
const VENDOR = { id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false, priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, packages: [] }
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [SLOT('s-photo', 'photo', 'Фотограф')],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/users/me/sessions': [{ id: 'ses1', device: 'Этот телефон', current: true, createdAt: '2026-09-01T10:00:00.000Z' }],
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷', vendorsCount: 12 }, { id: 'florist', title: 'Флорист', icon: '🌸', vendorsCount: 0 }],
  '/catalog/vendors/v1': VENDOR,
  '/catalog/vendors': { items: [], nextCursor: null },
  '/catalog/vendors/v1/availability': { busyDates: [], holdDates: [] },
  '/catalog/vendors/v1/reviews': { items: [], nextCursor: null },
  '/complaints': (c: Call) => (c.method === 'POST' ? withStatus(201, '', '') : withStatus(405, 'x', 'x')),
  ...over,
})

/** Открыть шторку, выбрать причину, отправить; вернуть тело жалобы. */
async function complain(calls: Call[], opener: string, reason = 'Обман или вымогательство') {
  fireEvent.click(screen.getByText(opener))
  await waitFor(() => expect(screen.getByRole('dialog', { name: 'Пожаловаться' })).toBeTruthy(), { timeout: 4000 })
  expect(screen.getByText('Отправить жалобу').closest('button')!.hasAttribute('disabled'), 'без причины отправка открыта').toBe(true)
  fireEvent.click(screen.getByText(reason))
  fireEvent.change(screen.getByPlaceholderText('Что случилось — по желанию'), { target: { value: 'Просят перевод на карту' } })
  fireEvent.click(screen.getByText('Отправить жалобу'))
  await waitFor(() => expect(posts(calls, '/complaints')).toHaveLength(1), { timeout: 4000 })
  await waitFor(() => expect(screen.getByText('Жалоба принята')).toBeTruthy(), { timeout: 4000 })
  return posts(calls, '/complaints')[0]!.body as Record<string, unknown>
}

describe('хвосты планов: жалобы (§18.2)', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('Ж1: «Пожаловаться на анкету» → POST /complaints {vendor}', async () => {
    const calls = serve(base())
    await open('/vendor/v1', 'Добавить в свадьбу')
    const body = await complain(calls, 'Пожаловаться на анкету')
    expect(body).toMatchObject({ targetKind: 'vendor', targetId: 'v1', category: 'fraud', text: 'Просят перевод на карту' })
  })

  it('Ж2: «Открыть спор» на сделке → POST /complaints {deal}; ссылки на почту поддержки нет', async () => {
    const deal = { id: 'd1', state: 'booked', vendor: { id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа' }, externalName: null, externalPhone: null, packageName: null, price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, paidAt: null, negotiatingUntil: null, bookedAt: '2026-09-01T10:00:00.000Z', doneAt: null, cancelledAt: null }
    const calls = serve(base({ '/weddings/w1/slots': [SLOT('s-photo', 'photo', 'Фотограф', deal)], '/deals/d1/events': [] }))
    const r = await open('/deal/d1', 'Защита сделки')
    expect(text(r)).not.toContain('Написать в поддержку')
    expect(text(r)).not.toContain('Эскроу')
    const body = await complain(calls, 'Открыть спор', 'Не пришёл или не выполнил')
    expect(body).toMatchObject({ targetKind: 'deal', targetId: 'd1', category: 'no_show' })
  })

  it('Ж3: кабинет — «Пожаловаться на отзыв» → POST /complaints {review}', async () => {
    localStorage.removeItem('tt_wedding_id')
    localStorage.removeItem('tt_wedding_date')
    const calls = serve(base({
      '/weddings': [],
      '/vendor/profile': { ...VENDOR, published: true, verified: false, gallery: [], about: '', phone: null },
      '/vendor/reviews': [{ id: 'r1', authorName: 'Марк', rating: 1, text: 'Чужие фото в анкете', source: 'couple', createdAt: '2026-09-01T10:00:00.000Z', reply: null }],
    }))
    await open('/vendor-app/reviews', 'Чужие фото в анкете')
    const body = await complain(calls, 'Пожаловаться на отзыв', 'Неприемлемое содержание')
    expect(body).toMatchObject({ targetKind: 'review', targetId: 'r1', category: 'content' })
  })

  it('Ж4: чат — жалоба по последней реплике собеседника; в чате Тиля кнопки нет', async () => {
    const chat = (id: string, kind: string, title: string) => ({ id, kind, title, unread: 0, lastMessage: null })
    const msgs = (items: unknown[]) => ({ items, nextCursor: null })
    const m = (id: string, senderId: string | null, text: string) => ({ id, senderId, text, sentAt: '2026-09-01T10:00:00.000Z', system: false })
    const calls = serve(base({
      '/chats': [chat('ch1', 'vendor', 'Фото «Пион»'), chat('ch2', 'tilly', 'Тиль — помощник')],
      '/chats/ch1/messages': msgs([m('m1', 'u1', 'Здравствуйте'), m('m2', 'v-user', 'Переведите на карту'), m('m3', 'u1', 'Нет')]),
      '/chats/ch2/messages': msgs([m('t1', null, 'Спрашивайте')]),
    }))
    await open('/us/chats/ch1', 'Переведите на карту')
    expect(screen.getByLabelText('Пожаловаться на собеседника')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Пожаловаться на собеседника'))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Пожаловаться' })).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Спам'))
    fireEvent.click(screen.getByText('Отправить жалобу'))
    await waitFor(() => expect(posts(calls, '/complaints')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/complaints')[0]!.body).toMatchObject({ targetKind: 'message', targetId: 'm2', category: 'spam' })
    cleanup(); vi.unstubAllGlobals(); couple()
    serve(base({
      '/chats': [chat('ch2', 'tilly', 'Тиль — помощник')],
      '/chats/ch2/messages': msgs([m('t1', null, 'Спрашивайте')]),
    }))
    await open('/us/chats/ch2', 'Спрашивайте')
    expect(screen.queryByLabelText('Пожаловаться на собеседника'), 'на Тиля жаловаться некому').toBeNull()
  })
})

describe('хвосты планов: массовые операции и счётчик', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('У1: «Прочитать все» — один POST /notifications/read-all, поштучных отметок нет', async () => {
    const n = (id: string) => ({ id, kind: 'system', title: `Новость ${id}`, body: 'текст', link: null, read: false, createdAt: '2026-09-01T10:00:00.000Z' })
    const calls = serve(base({
      '/notifications': [n('n1'), n('n2'), n('n3')],
      '/notifications/read-all': { marked: 3 },
    }))
    await open('/notifications', 'Новость n1')
    fireEvent.click(screen.getByText('Прочитать все'))
    await waitFor(() => expect(posts(calls, '/notifications/read-all')).toHaveLength(1), { timeout: 4000 })
    expect(calls.filter(c => c.method === 'POST' && /\/notifications\/n\d\/read$/.test(c.path))).toHaveLength(0)
  })

  it('А1: «Одобрить все» в альбоме — один PATCH /weddings/w1/album', async () => {
    const calls = serve(base({
      '/weddings/w1/album': (c: Call) => (c.method === 'PATCH' ? { updated: 2 } : [
        { id: 'p1', url: 'https://example.com/1.jpg', approved: false, createdAt: '2026-09-01T10:00:00.000Z' },
        { id: 'p2', url: 'https://example.com/2.jpg', approved: false, createdAt: '2026-09-01T10:00:00.000Z' },
      ]),
    }))
    await open('/wedding/album', 'на модерации')
    fireEvent.click(screen.getByText('Одобрить все'))
    await waitFor(() => expect(posts(calls, '/weddings/w1/album', 'PATCH')).toHaveLength(1), { timeout: 4000 })
    expect(posts(calls, '/weddings/w1/album', 'PATCH')[0]!.body).toEqual({ approved: true })
    expect(calls.filter(c => c.method === 'PATCH' && /\/album\/p\d$/.test(c.path))).toHaveLength(0)
  })

  it('К1: категории запрашиваются с городом; «N рядом» только при N > 0', async () => {
    const calls = serve(base())
    const r = await open('/search', 'Фотограф')
    const cats = calls.find(c => c.path === '/catalog/categories')!
    expect(cats.url).toContain('city=')
    expect(decodeURIComponent(cats.url)).toContain('Уфа')
    expect(text(r)).toContain('12 рядом')
    expect(text(r)).not.toContain('0 рядом')
  })
})

describe('хвосты планов: права на портфолио, выгрузка данных', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const vendorSignedIn = () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  }
  const PROFILE = { ...VENDOR, published: false, verified: false, gallery: [], about: 'Снимаем', phone: '+79990000001', mediaRights: false }

  it('П1: без галочки прав «Опубликовать» не шлёт publish; с галочкой — mediaRights: true в PUT и publish', async () => {
    vendorSignedIn()
    const calls = serve(base({
      '/weddings': [],
      '/vendor/profile': (c: Call) => (c.method === 'PUT' ? { ...PROFILE, ...(c.body as object) } : PROFILE),
      '/vendor/profile/publish': { status: 'moderation' },
    }))
    const r = render(<MemoryRouter initialEntries={['/vendor-app/profile']}><StoreProvider><Routes><Route path="/vendor-app/profile" element={<VendorProfileWizard />} /></Routes></StoreProvider></MemoryRouter>)
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    for (let k = 1; k < 5; k++) {
      fireEvent.click(screen.getByText('Далее'))
      await waitFor(() => expect(text(r)).toContain(`Шаг ${k + 1} из 5`), { timeout: 4000 })
    }
    const putsBefore = posts(calls, '/vendor/profile', 'PUT').length
    fireEvent.click(screen.getByText('Опубликовать анкету ✨'))
    await waitFor(() => expect(text(r)).toContain('Подтвердите права на фото и видео'), { timeout: 4000 })
    expect(posts(calls, '/vendor/profile/publish')).toHaveLength(0)
    expect(posts(calls, '/vendor/profile', 'PUT')).toHaveLength(putsBefore)
    fireEvent.click(screen.getByRole('checkbox', { name: /права на фото и видео/ }))
    fireEvent.click(screen.getByText('Опубликовать анкету ✨'))
    await waitFor(() => expect(posts(calls, '/vendor/profile/publish')).toHaveLength(1), { timeout: 4000 })
    const lastPut = posts(calls, '/vendor/profile', 'PUT').at(-1)!.body as Record<string, unknown>
    expect(lastPut.mediaRights).toBe(true)
  })

  it('П1b: подтверждённые права сервер помнит — галочка не спрашивается заново', async () => {
    vendorSignedIn()
    serve(base({ '/weddings': [], '/vendor/profile': { ...PROFILE, mediaRights: true } }))
    const r = render(<MemoryRouter initialEntries={['/vendor-app/profile']}><StoreProvider><Routes><Route path="/vendor-app/profile" element={<VendorProfileWizard />} /></Routes></StoreProvider></MemoryRouter>)
    await waitFor(() => expect(text(r)).toContain('Шаг 1 из 5'), { timeout: 4000 })
    for (let k = 1; k < 5; k++) {
      fireEvent.click(screen.getByText('Далее'))
      await waitFor(() => expect(text(r)).toContain(`Шаг ${k + 1} из 5`), { timeout: 4000 })
    }
    expect(screen.queryByRole('checkbox', { name: /права на фото и видео/ })).toBeNull()
  })

  it('Э1: «Выгрузить мои данные» → GET /users/me/export и файл на устройстве', async () => {
    couple()
    const calls = serve(base({
      '/users/me/export': { user: { id: 'u1' }, guests: [], deals: [] },
      '/users/me/push-subscriptions': [],
    }))
    const created: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (b: Blob) => { created.push(b.type); return 'blob:tili' },
      revokeObjectURL: () => undefined,
    }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    await open('/settings', 'Выгрузить мои данные')
    fireEvent.click(screen.getByText('Выгрузить мои данные'))
    await waitFor(() => expect(posts(calls, '/users/me/export', 'GET')).toHaveLength(1), { timeout: 4000 })
    await waitFor(() => expect(click).toHaveBeenCalled(), { timeout: 4000 })
    expect(created).toEqual(['application/json'])
    click.mockRestore()
  })
})

describe('хвосты планов: офлайн день X (План §3.1)', () => {
  beforeEach(() => {
    couple()
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 'ses1' }))}.test`, refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const EVENT = { id: 'e1', name: 'Выездная церемония', startsAt: '2027-06-14T09:00:00.000Z', endsAt: null, eventId: null, location: 'Терраса' }
  const SNAPSHOT = { schema: 2, scope: { userId: 'u1', sessionId: 'ses1' }, role: 'couple', etag: '"1"', weddingDate: WEDDING.date, weddingTimeZone: WEDDING.tz, events: [], weddingId: 'w1', savedAt: '2027-06-14T04:30:00.000Z', timeline: [EVENT], planBActivatedAt: null, team: [{ id: 's-photo', label: 'Фотограф', vendor: 'Студия «Пион»', vendorId: 'v1', phone: '+79990000001' }] }

  it('О1: сервер не ответил, копия есть — тайминг и команда с телефона, с меткой времени', async () => {
    localStorage.setItem(OFFLINE_DAY_KEY, JSON.stringify(SNAPSHOT))
    serve(base({ '/weddings/w1/timeline': DOWN, '/weddings/w1/events': DOWN, '/weddings/w1/planb': DOWN, '/weddings/w1/slots': DOWN }))
    const r = await open('/dayx', 'Версия снимка')
    expect(text(r)).toContain('Выездная церемония')
    expect(text(r)).toContain('Студия «Пион»')
    expect(text(r)).toContain('+79990000001')
    expect(text(r)).not.toContain('Тайминг не загрузился')
  })

  it('О1b: копии нет — прежнее честное «Тайминг не загрузился»', async () => {
    serve(base({ '/weddings/w1/timeline': DOWN }))
    const r = await open('/dayx', 'Тайминг не загрузился')
    expect(text(r)).not.toContain('показана копия')
  })

  it('О2: живой ответ пишет копию; чужая свадьба в копии не читается', async () => {
    serve(base({ '/weddings/w1/timeline': [EVENT], '/weddings/w1/events': [], '/weddings/w1/planb': { checklist: [], activatedAt: null } }))
    await open('/dayx', 'Выездная церемония')
    await waitFor(() => expect(recallDay('w1', offlineScope(accessTokenForWs()))?.timeline[0]?.name).toBe('Выездная церемония'), { timeout: 4000 })
    expect(recallDay('w2', offlineScope(accessTokenForWs()))).toBeNull()
    expect(JSON.parse(localStorage.getItem(OFFLINE_DAY_KEY)!).savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('М1: уведомления фоновых задач ведут на свои экраны', () => {
    expect(notificationRoute('/after')).toBe('/after')
    expect(notificationRoute('/album')).toBe('/wedding/album')
    expect(notificationRoute('/catering')).toBe('/wedding/catering')
    expect(notificationRoute('/home')).toBe('/home')
    expect(notificationRoute('/after', { vendor: true })).toBeNull()
  })
})
