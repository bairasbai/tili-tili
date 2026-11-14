// @vitest-environment jsdom
/*
 * Фича 007 «Кабинет подрядчика: чаты, настройки, анкета глазами пары» (контракт
 * v0.30.1, задание FE-007). Каждый тест здесь был красным на коде до фикса —
 * цитаты красного в отчёте `REPORT-FE.md`.
 *
 * Что закрывается:
 *  — `/vendor-app/chats` и `/vendor-app/chats/:id` — те же `Chats`/`Chat` в
 *    режиме кабинета: заголовок «Чаты с парами», строки ведут в
 *    `/vendor-app/chats/{id}`, «назад» — в кабинет и в список, а не в разделы
 *    пары (T1);
 *  — нижняя навигация кабинета (`VendorTabBar`) на всех `/vendor-app*`, кроме
 *    переписки; бейдж непрочитанных — сумма `unread` из `GET /chats`; без
 *    ответа и при нуле бейджа нет (T2);
 *  — дашборд: карточка «Чаты с парами» — «N непрочитанных» только по ответу
 *    сервера, «Загружаем…» / ошибка + «Повторить»; строка «Настройки» (T3);
 *  — заявка: «Открыть чат» → `/vendor-app/chats/{chatId}` по `Lead.chatId`,
 *    без него кнопки нет; после ответа на заявку кнопка появляется из
 *    перечитанного списка (T4);
 *  — `/vendor-app/settings` — `Settings` в режиме подрядчика: без блоков
 *    свадьбы, со строкой «Посмотреть анкету глазами пары», «Выйти» гасит
 *    только свою сессию (T5);
 *  — `/vendor/:id` своей анкеты: плашка «не опубликована» / «заблокирована»,
 *    вместо «Написать» и «Добавить в свадьбу» — «Это ваша анкета» и
 *    «Редактировать»; чужая анкета не меняется (T6).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик (приём из `audit25`/`audit30`/`audit32`/`audit33`).
 */
import { act, render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import App from '@/App'
import { Chat, Chats } from '@/pages/Us'
import { VendorDashboard } from '@/pages/VendorApp'
import { VendorLead } from '@/pages/VendorExtras'
import { Settings } from '@/pages/Account'
import { VendorDetail } from '@/pages/Search'
import { currentMonth } from './utils'
import { formatWeddingDate, monthTitle } from './weddingDate'

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

/** Своя анкета подрядчика — опубликованная; кабинет читает её первой. */
const PROFILE = { id: 'v1', name: 'Фотостудия Свет', city: 'Уфа', categoryId: 'photo', about: 'Снимаем свадьбы', phone: '+79990000001', published: true, verified: false, packages: [], gallery: [], rating: null, reviewsCount: 0 }

/** Всё, что читают стор и экраны кабинета: подрядчик без свадьбы на устройстве. */
const cabinet = (over: Routes = {}): Routes => ({
  '/vendor/profile': PROFILE, '/vendor/updates': [], '/vendor/leads': [], '/vendor/calendar': [], '/vendor/calendar/external': [], '/vendor/reviews': [],
  '/vendor/deals': { expected: { amount: 0, currency: 'RUB' }, items: [] },
  '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
  '/chats': [],
  '/weddings': [], '/me/favorites': [], '/users/me': ME,
  '/users/me/sessions': [], '/users/me/push-subscriptions': [], '/notifications': [],
  ...over,
})

/** Чат подрядчика с парой: сервер подписывает его названием свадьбы. */
const chat = (id: string, title: string, unread: number, over: Record<string, unknown> = {}) =>
  ({ id, kind: 'vendor', title, unread, lastMessage: 'Здравствуйте!', ...over })
const VENDOR_CHATS = [chat('ch1', 'Аня ♥ Боря', 2), chat('ch2', 'Команда свадьбы · Оля ♥ Иван', 1, { kind: 'team' })]
const MSG = { id: 'm1', chatId: 'ch1', senderId: 'u2', text: 'Здравствуйте, свободны ли вы 14 июня?', sentAt: '2026-09-01T10:00:00.000Z' }

function renderAt(initial: string, routes: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        <Routes>{routes}</Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
}

/** Куда увела кнопка: метка и путь. */
function Probe({ label }: { label: string }) {
  const loc = useLocation()
  return <p>{label} {loc.pathname}</p>
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const deletes = (calls: Call[], path: string) => calls.filter(c => c.method === 'DELETE' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const alerts = () => screen.queryAllByRole('alert').map(e => e.textContent).join(' | ')

/* Пока не понадобились: тот же набор помощников, что в audit32/audit33. */
void PENDING; void base

/* ── T1: маршруты кабинета — Chats/Chat в режиме кабинета ─────────────────── */

describe('T1: /vendor-app/chats и /vendor-app/chats/:id — Chats/Chat в режиме кабинета', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('список: «Чаты с парами», подзаголовок про пары и команды, строки из GET /chats; тап → /vendor-app/chats/{id}', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS }))
    const r = renderAt('/vendor-app/chats', <>
      <Route path="/vendor-app/chats" element={<Chats home="/vendor-app" />} />
      <Route path="/vendor-app/chats/:id" element={<Probe label="ЧАТ" />} />
      <Route path="/us/chats/:id" element={<Probe label="ЧАТ ПАРЫ" />} />
    </>)
    await waitFor(() => expect(text(r)).toContain('Аня ♥ Боря'), { timeout: 4000 })
    expect(screen.getByRole('heading', { level: 1 }).textContent, 'заголовок пары в кабинете').toBe('Чаты с парами')
    expect(text(r), 'подзаголовок пары в кабинете').not.toContain('Подрядчики · команда · день X')
    expect(text(r)).toMatch(/[Пп]ары/)
    expect(text(r)).toMatch(/команд/)
    fireEvent.click(screen.getByText('Аня ♥ Боря'))
    await waitFor(() => expect(text(r)).toContain('ЧАТ /vendor-app/chats/ch1'), { timeout: 4000 })
  })

  it('список: «назад» без истории → /vendor-app, а не на главную пары', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS }))
    const r = renderAt('/vendor-app/chats', <>
      <Route path="/vendor-app/chats" element={<Chats home="/vendor-app" />} />
      <Route path="/vendor-app" element={<Probe label="КАБИНЕТ" />} />
      <Route path="/home" element={<Probe label="ГЛАВНАЯ" />} />
    </>)
    await waitFor(() => expect(text(r)).toContain('Аня ♥ Боря'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Назад'))
    await waitFor(() => expect(text(r)).toContain('КАБИНЕТ /vendor-app'), { timeout: 4000 })
  })

  it('переписка: «назад» → /vendor-app/chats, а не в чаты пары', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS, '/chats/ch1/messages': { items: [MSG], nextCursor: null } }))
    const r = renderAt('/vendor-app/chats/ch1', <>
      <Route path="/vendor-app/chats/:id" element={<Chat home="/vendor-app" />} />
      <Route path="/vendor-app/chats" element={<Probe label="СПИСОК" />} />
      <Route path="/us/chats" element={<Probe label="ЧАТЫ ПАРЫ" />} />
    </>)
    await waitFor(() => expect(text(r)).toContain(MSG.text), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Назад'))
    await waitFor(() => expect(text(r)).toContain('СПИСОК /vendor-app/chats'), { timeout: 4000 })
  })

  it('пара: /us/chats — «Чаты», строки ведут в /us/chats/{id} (контроль)', async () => {
    couple()
    serve(base({ '/chats': [chat('ch1', 'Фото «Кадр»', 0)] }))
    const r = renderAt('/us/chats', <>
      <Route path="/us/chats" element={<Chats />} />
      <Route path="/us/chats/:id" element={<Probe label="ЧАТ ПАРЫ" />} />
    </>)
    await waitFor(() => expect(text(r)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Чаты')
    expect(text(r)).toContain('Подрядчики · команда · день X')
    fireEvent.click(screen.getByText('Фото «Кадр»'))
    await waitFor(() => expect(text(r)).toContain('ЧАТ ПАРЫ /us/chats/ch1'), { timeout: 4000 })
  })
})

/* ── T2: навигация кабинета ───────────────────────────────────────────────── */

describe('T2: навигация кабинета — Кабинет · Сделки · Чаты · Настройки, бейдж непрочитанных из GET /chats', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  /** Приложение целиком: навигацию рисует оболочка, а не экран. */
  const openApp = async (route: string, settledText: string) => {
    const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
    await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain(settledText), { timeout: 4000 })
    return r
  }
  const bar = () => screen.getByLabelText('Навигация кабинета')

  it('на /vendor-app — четыре вкладки, у «Чатов» бейдж 3 (сумма unread); тап по «Настройки» → экран настроек с той же навигацией', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS }))
    const r = await openApp('/vendor-app', 'Заполненность анкеты')
    for (const label of ['Кабинет', 'Сделки', 'Чаты', 'Настройки']) expect(within(bar()).getByText(label)).toBeTruthy()
    expect(screen.queryByText('Главная'), 'вкладки пары в кабинете').toBeNull()
    /* Десктоп резервирует слева место под панель по классу оболочки. */
    expect(r.container.querySelector('.app-shell')?.className).not.toContain('no-tab')
    await waitFor(() => expect(within(bar()).getByText('3')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(within(bar()).getByText('Настройки'))
    await waitFor(() => expect(text(r)).toContain('Выйти со всех устройств'), { timeout: 4000 })
    expect(screen.getByLabelText('Навигация кабинета'), 'навигация пропала на настройках').toBeTruthy()
  })

  it('GET /chats упал — бейджа нет; ноль непрочитанных — бейджа нет; на сделках и в списке чатов навигация есть', async () => {
    serve(cabinet({ '/chats': DOWN }))
    await openApp('/vendor-app/deals', 'ожидается по сделкам')
    await settle()
    expect(bar().textContent, 'цифра в навигации без ответа сервера').not.toMatch(/\d/)
    cleanup(); vi.unstubAllGlobals()
    serve(cabinet({ '/chats': [chat('ch1', 'Аня ♥ Боря', 0)] }))
    const r = await openApp('/vendor-app/chats', 'Аня ♥ Боря')
    await settle()
    expect(bar().textContent, 'ноль показан бейджем').not.toMatch(/\d/)
    expect(text(r)).toContain('Чаты с парами')
  })

  it('в переписке /vendor-app/chats/:id навигации нет — как у пары', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS, '/chats/ch1/messages': { items: [MSG], nextCursor: null } }))
    const r = await openApp('/vendor-app/chats/ch1', MSG.text)
    expect(screen.queryByLabelText('Навигация кабинета')).toBeNull()
    expect(r.container.querySelector('.app-shell')?.className).toContain('no-tab')
  })
})

/* ── T3: дашборд — карточка «Чаты с парами», строка «Настройки» ───────────── */

describe('T3: дашборд — карточка «Чаты с парами» по ответу GET /chats и строка «Настройки»', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const openDash = () => renderAt('/vendor-app', <>
    <Route path="/vendor-app" element={<VendorDashboard />} />
    <Route path="/vendor-app/chats" element={<Probe label="ЧАТЫ" />} />
    <Route path="/vendor-app/settings" element={<Probe label="НАСТРОЙКИ" />} />
  </>)
  /** Текст карточки чатов: заголовок и строка состояния под ним. */
  const card = () => screen.getByText('Чаты с парами').closest('button')!.textContent ?? ''

  it('«3 непрочитанных» — сумма unread; карточка между «Обновления от пар» и «Отзывы»; тап → /vendor-app/chats', async () => {
    serve(cabinet({ '/chats': VENDOR_CHATS }))
    const r = openDash()
    await waitFor(() => expect(text(r)).toContain('3 непрочитанных'), { timeout: 4000 })
    const s = text(r)
    expect(s.indexOf('Обновления от пар'), 'карточка стоит выше обновлений').toBeLessThan(s.indexOf('Чаты с парами'))
    expect(s.indexOf('Чаты с парами'), 'карточка стоит ниже отзывов').toBeLessThan(s.indexOf('Отзывы'))
    fireEvent.click(screen.getByText('Чаты с парами'))
    await waitFor(() => expect(text(r)).toContain('ЧАТЫ /vendor-app/chats'), { timeout: 4000 })
  })

  it('до ответа — «Загружаем…», не ноль; пустой список → «новых сообщений нет»', async () => {
    const g = gate()
    serve(cabinet({ '/chats': g.reply }))
    const r = openDash()
    await waitFor(() => expect(text(r)).toContain('Чаты с парами'), { timeout: 4000 })
    expect(card()).toContain('Загружаем…')
    expect(card(), 'ноль до ответа сервера').not.toContain('новых сообщений нет')
    expect(card()).not.toContain('непрочитанн')
    g.release([])
    await waitFor(() => expect(card()).toContain('новых сообщений нет'), { timeout: 4000 })
    expect(card()).not.toContain('Загружаем…')
  })

  it('сеть упала — текст ошибки под заголовком и «Повторить» перечитывает GET /chats', async () => {
    let reads = 0
    const calls = serve(cabinet({ '/chats': () => { reads++; return reads === 1 ? DOWN : VENDOR_CHATS } }))
    const r = openDash()
    await waitFor(() => expect(text(r)).toContain('Чаты с парами'), { timeout: 4000 })
    await waitFor(() => expect(card()).toContain('Сервер недоступен. Попробуйте позже'), { timeout: 4000 })
    expect(card()).not.toContain('непрочитанн')
    expect(card()).not.toContain('новых сообщений нет')
    fireEvent.click(screen.getByText('Повторить'))
    await waitFor(() => expect(card()).toContain('3 непрочитанных'), { timeout: 4000 })
    expect(gets(calls, '/chats').length).toBe(2)
  })

  it('строка «Настройки» → /vendor-app/settings', async () => {
    serve(cabinet())
    const r = openDash()
    await waitFor(() => expect(text(r)).toContain('Заполненность анкеты'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Настройки'))
    await waitFor(() => expect(text(r)).toContain('НАСТРОЙКИ /vendor-app/settings'), { timeout: 4000 })
  })

  it('календарь показывает неизвестный день и отличает ручную отметку от двух видов брони', async () => {
    const month = currentMonth()
    const date = (day: string) => `${month}-${day}`
    const calendar = [
      { date: date('05'), status: 'busy', source: 'manual', markedAt: `${date('01')}T10:00:00.000Z` },
      { date: date('06'), status: 'busy', source: 'deal' },
      { date: date('07'), status: 'hold' },
    ]
    const calls = serve(cabinet({
      '/vendor/calendar': () => calendar,
      '/vendor/calendar/busy': () => {
        calendar.shift()
        return withStatus(204, '', '')
      },
    }))
    openDash()
    const block = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const day = (n: string, label: string) => block.getByRole('button', { name: `${formatWeddingDate(date(n))} · ${label}` }) as HTMLButtonElement
    const manual = await block.findByRole('button', { name: `${formatWeddingDate(date('05'))} · Занято вручную · Снять отметку занятости` }) as HTMLButtonElement
    expect(manual.title).toContain('Отметка от')
    expect(day('06', 'Занято сделкой').disabled).toBe(true)
    expect(day('07', 'Предварительная бронь').disabled).toBe(true)
    expect(day('08', 'Доступность неизвестна · Отметить занятость').disabled).toBe(false)
    expect(block.getByText('Календарь проверен').querySelector('time')?.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    fireEvent.click(manual)
    await block.findByRole('button', { name: `${formatWeddingDate(date('05'))} · Доступность неизвестна · Отметить занятость` })
    expect(calls.filter(c => c.method === 'POST' && c.path === '/vendor/calendar/busy').map(c => c.body))
      .toEqual([{ dates: [date('05')], status: 'free' }])
  })

  it('календарь закрывает действия на время перечитывания и ждёт свежий ответ после восстановления сети', async () => {
    const month = currentMonth()
    const g = gate()
    let reply: unknown = []
    const calls = serve(cabinet({ '/vendor/calendar': () => reply }))
    openDash()
    const block = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const label = `${formatWeddingDate(`${month}-05`)} · Доступность неизвестна · Отметить занятость`
    const day = await block.findByRole('button', { name: label }) as HTMLButtonElement
    expect(day.disabled).toBe(false)
    day.focus()

    reply = g.reply
    fireEvent(window, new Event('focus'))
    await block.findByText('Обновляем…')
    expect(day.getAttribute('aria-disabled')).toBe('true')
    expect(document.activeElement).toBe(day)
    fireEvent.click(day)
    expect(calls.filter(c => c.path === '/vendor/calendar/busy')).toEqual([])

    fireEvent(window, new Event('offline'))
    expect(block.queryByRole('button', { name: label })).toBeNull()
    expect(block.getByText('Календарь недоступен без сети')).toBeTruthy()
    const reads = gets(calls, '/vendor/calendar').length
    fireEvent(window, new Event('online'))
    await waitFor(() => expect(gets(calls, '/vendor/calendar')).toHaveLength(reads + 1))
    expect(block.queryByRole('button', { name: label })).toBeNull()
    g.release([])
    expect((await block.findByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('объявляет месяц после перехода с сохранением фокуса на кнопке', async () => {
    serve(cabinet({ '/vendor/calendar': [] }))
    openDash()
    const block = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const status = block.getByText(monthTitle(currentMonth()))
    expect(status.getAttribute('role')).toBe('status')
    const next = block.getByRole('button', { name: 'Следующий месяц' })
    next.focus()
    fireEvent.click(next)
    expect(status.textContent).not.toBe(monthTitle(currentMonth()))
    expect(document.activeElement).toBe(next)
  })

  it('владелец подтверждает выбранную дату отдельно от ручной занятости', async () => {
    const date = `${currentMonth()}-05`
    const held = `${currentMonth()}-06`
    let confirmed = false
    const calls = serve(cabinet({
      '/vendor/calendar': () => [
        { date: held, status: 'hold' },
        ...(confirmed ? [{ date, status: 'free', source: 'manual', markedAt: `${date}T10:00:00.000Z` }] : []),
      ],
      '/vendor/calendar/availability': () => {
        confirmed = true
        return withStatus(204, '', '')
      },
    }))
    openDash()
    const select = await screen.findByRole('combobox', { name: 'Свободная дата' })
    const button = screen.getByRole('button', { name: 'Подтвердить на 24 часа' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(within(select).queryByRole('option', { name: formatWeddingDate(held) })).toBeNull()
    fireEvent.change(select, { target: { value: date } })
    fireEvent.click(button)
    await screen.findByRole('button', { name: `${formatWeddingDate(date)} · Свободно по отметке · Отметить занятость` })
    expect(calls.filter(c => c.path.startsWith('/vendor/calendar/') && c.method !== 'GET').map(c => [c.method, c.path, c.body]))
      .toEqual([['PUT', '/vendor/calendar/availability', { dates: [date] }]])
  })

  it('открытый календарь перечитывает свободную дату при истечении отметки', async () => {
    vi.useFakeTimers()
    try {
      const date = `${currentMonth()}-05`
      const markedAt = new Date(Date.now() - 24 * 60 * 60_000 + 1_000).toISOString()
      let reads = 0
      serve(cabinet({ '/vendor/calendar': () => ++reads === 1 ? [{ date, status: 'free', source: 'manual', markedAt }] : [] }))
      openDash()
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('button', { name: `${formatWeddingDate(date)} · Свободно по отметке · Отметить занятость` })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('button', { name: `${formatWeddingDate(date)} · Доступность неизвестна · Отметить занятость` })).toBeTruthy()
      expect(reads).toBe(2)
    } finally { vi.useRealTimers() }
  })

  it('внешний заказ появляется в календаре и снимается отдельной операцией', async () => {
    const start = `${currentMonth()}-05`, end = `${currentMonth()}-06`
    let saved = false
    const calls = serve(cabinet({
      '/vendor/calendar': () => saved ? [{ date: start, status: 'busy', source: 'external' }] : [],
      '/vendor/calendar/external': (call: Call) => {
        if (call.method === 'POST') { saved = true; return { count: 1 } }
        if (call.method === 'DELETE') { saved = false; return withStatus(204, '', '') }
        return saved ? [{ start, end }] : []
      },
    }))
    openDash()
    const section = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const details = (await section.findByText('Внешняя занятость')).closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    fireEvent.change(await section.findByLabelText('Часовой пояс внешнего календаря'), { target: { value: 'Europe/Moscow' } })
    fireEvent.change(section.getByLabelText('Начало внешнего заказа'), { target: { value: start } })
    fireEvent.change(section.getByLabelText('Первый день после заказа'), { target: { value: end } })
    fireEvent.click(section.getByRole('button', { name: 'Добавить внешний заказ' }))
    const busy = await section.findByRole('button', { name: `${formatWeddingDate(start)} · Занято внешним заказом` }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    fireEvent.click(await section.findByRole('button', { name: /Убрать внешний заказ/ }))
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
    const confirm = section.getByRole('button', { name: /Подтвердить удаление интервала/ })
    confirm.focus()
    fireEvent.click(confirm)
    await section.findByRole('button', { name: `${formatWeddingDate(start)} · Доступность неизвестна · Отметить занятость` })
    expect(document.activeElement).toBe(section.getByRole('region', { name: 'Внешняя занятость' }))
    expect(calls.filter(c => c.path === '/vendor/calendar/external' && c.method !== 'GET').map(c => [c.method, c.url, c.body])).toEqual([
      ['POST', '/vendor/calendar/external', { periods: [{ start, end }], timeZone: 'Europe/Moscow' }],
      ['DELETE', `/vendor/calendar/external?start=${start}&end=${end}`, null],
    ])
  })

  it('импорт ICS передаёт файл и зону, затем показывает источник занятости', async () => {
    const date = `${currentMonth()}-08`
    const body = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR'
    let imported = false
    const calls = serve(cabinet({
      '/vendor/calendar': () => imported ? [{ date, status: 'busy', source: 'ics' }] : [],
      '/vendor/calendar/import': () => { imported = true; return { count: 1 } },
    }))
    openDash()
    const section = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const details = (await section.findByText('Внешняя занятость')).closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    const file = new File([body], 'calendar.ics', { type: 'text/calendar' })
    Object.defineProperty(file, 'text', { value: async () => body })
    fireEvent.change(await section.findByLabelText('Файл календаря ICS'), { target: { files: [file] } })
    fireEvent.change(section.getByLabelText('Часовой пояс внешнего календаря'), { target: { value: 'Europe/Moscow' } })
    fireEvent.click(section.getByRole('button', { name: 'Импортировать ICS' }))
    await section.findByRole('button', { name: `${formatWeddingDate(date)} · Занято по ICS` })
    expect(calls.filter(c => c.path === '/vendor/calendar/import').map(c => [c.method, c.body])).toEqual([
      ['PUT', { calendar: body, timeZone: 'Europe/Moscow' }],
    ])
  })

  it('перечитывает внешний календарь при возврате и скрывает интервалы и действия при отказе', async () => {
    const start = `${currentMonth()}-11`, end = `${currentMonth()}-13`
    const path = '/vendor/calendar/external'
    const pending = gate()
    let reply: unknown = [{ start, end }]
    const calls = serve(cabinet({ [path]: () => reply }))
    openDash()
    const section = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const details = (await section.findByText('Внешняя занятость', { selector: 'summary' })).closest('details')!
    details.open = true
    fireEvent(details, new Event('toggle'))
    await section.findByRole('button', { name: /Убрать внешний заказ/ })

    reply = pending.reply
    fireEvent.focus(window)
    await waitFor(() => expect(gets(calls, path)).toHaveLength(2))
    expect(section.queryByRole('button', { name: /Убрать внешний заказ/ })).toBeNull()
    expect(section.getByRole('button', { name: 'Импортировать ICS' }).getAttribute('aria-disabled')).toBe('true')
    pending.release([{ start, end }])
    await section.findByRole('button', { name: /Убрать внешний заказ/ })

    reply = withStatus(403, 'forbidden', 'Внешняя занятость недоступна')
    fireEvent.focus(window)
    await section.findByText('Внешняя занятость недоступна')
    expect(section.queryByRole('button', { name: /Убрать внешний заказ/ })).toBeNull()
    expect(section.queryByRole('button', { name: 'Импортировать ICS' })).toBeNull()
  })

  it('скачивает ICS за выбранный месяц через авторизованный запрос', async () => {
    const calls = serve(cabinet({ '/vendor/calendar/export': [] }))
    const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
    const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')
    const create = vi.fn(() => 'blob:test-calendar'), revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke })
    const downloads: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    try {
      openDash()
      fireEvent.click(await screen.findByRole('button', { name: 'Скачать занятость в ICS' }))
      await waitFor(() => expect(downloads).toEqual([`availability-${currentMonth()}.ics`]))
      expect(create).toHaveBeenCalledOnce()
      const request = gets(calls, '/vendor/calendar/export')
      expect(request).toHaveLength(1)
      expect(request[0]).toMatchObject({ url: `/vendor/calendar/export?month=${currentMonth()}`, headers: { authorization: 'Bearer a' } })
      await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:test-calendar'), { timeout: 3000 })
    } finally {
      click.mockRestore()
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
      else Reflect.deleteProperty(URL, 'createObjectURL')
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
      else Reflect.deleteProperty(URL, 'revokeObjectURL')
    }
  })

  it('в режиме ресурсов показывает бронь и неизвестные дни без кнопок ручной занятости', async () => {
    const date = `${currentMonth()}-08`
    serve(cabinet({
      '/vendor/profile': { ...PROFILE, bookingMode: 'resources' },
      '/vendor/calendar': [{ date, status: 'busy', source: 'resource', markedAt: `${date}T01:00:00Z` }],
    }))
    openDash()
    const section = within(await screen.findByRole('region', { name: 'Календарь занятости' }))
    const busy = await section.findByRole('button', { name: `${formatWeddingDate(date)} · Есть бронь ресурсов (UTC)` }) as HTMLButtonElement
    const unknown = section.getByRole('button', { name: `${formatWeddingDate(`${currentMonth()}-09`)} · Доступность неизвестна` }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect(unknown.disabled).toBe(true)
  })
})

/* ── T4: заявка — «Открыть чат» по Lead.chatId ────────────────────────────── */

describe('T4: заявка — «Открыть чат» ведёт в чат заявки по Lead.chatId', () => {
  beforeEach(signedIn)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const lead = (over: Record<string, unknown> = {}) =>
    ({ id: 'l1', coupleName: 'Аня ♥ Боря', weddingDate: '2027-06-14', city: 'Уфа', message: 'Свободны ли вы 14 июня?', status: 'new', holdUntil: null, chatId: 'ch1', ...over })
  const openLead = () => renderAt('/vendor-app/leads/l1', <>
    <Route path="/vendor-app/leads/:id" element={<VendorLead />} />
    <Route path="/vendor-app/chats/:id" element={<Probe label="ЧАТ" />} />
  </>)

  it('chatId есть — «Открыть чат» ведёт в /vendor-app/chats/ch1 переходом, без единого запроса', async () => {
    const calls = serve(cabinet({ '/vendor/leads': [lead()] }))
    const r = openLead()
    await waitFor(() => expect(text(r)).toContain('Свободны ли вы 14 июня?'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Открыть чат'))
    await waitFor(() => expect(text(r)).toContain('ЧАТ /vendor-app/chats/ch1'), { timeout: 4000 })
    expect(calls.filter(c => c.method !== 'GET').length, 'переход в существующий чат ушёл запросом').toBe(0)
  })

  it('chatId: null — кнопки нет; после ответа на заявку список перечитан и «Открыть чат» появляется', async () => {
    let replied = false
    const calls = serve(cabinet({
      '/vendor/leads': () => [lead({ chatId: replied ? 'ch1' : null, status: replied ? 'replied' : 'new' })],
      '/vendor/leads/l1': () => { replied = true; return lead({ chatId: 'ch1', status: 'replied' }) },
    }))
    const r = openLead()
    await waitFor(() => expect(text(r)).toContain('Свободны ли вы 14 июня?'), { timeout: 4000 })
    expect(screen.queryByText('Открыть чат'), 'кнопка без chatId — переход в никуда').toBeNull()
    fireEvent.click(screen.getByText('Спасибо за интерес! Предлагаю созвониться — когда удобно?'))
    await waitFor(() => expect(posts(calls, '/vendor/leads/l1').length).toBe(1), { timeout: 4000 })
    await waitFor(() => expect(screen.getByText('Открыть чат')).toBeTruthy(), { timeout: 4000 })
  })
})

/* ── T5: настройки подрядчика ─────────────────────────────────────────────── */

describe('T5: /vendor-app/settings — Settings в режиме подрядчика', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const SESSIONS = [
    { id: 'other-1', device: 'Android', current: false, createdAt: '2026-09-01T10:00:00.000Z' },
    { id: 'this-one', device: 'Windows', current: true, createdAt: '2026-09-10T10:00:00.000Z' },
  ]
  const settingsRoutes = (over: Routes = {}): Routes => cabinet({ '/users/me/sessions': SESSIONS, ...over })
  const openSettings = (routes: Routes, vendor = true) => {
    const calls = serve(routes)
    const r = renderAt(vendor ? '/vendor-app/settings' : '/settings', <>
      <Route path="/vendor-app/settings" element={<Settings vendor />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/vendor-app" element={<Probe label="КАБИНЕТ" />} />
      <Route path="/vendor/:id" element={<Probe label="АНКЕТА" />} />
      <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
    </>)
    return { ...r, calls }
  }
  /* Подрядчик может быть и парой: на устройстве помнится свадьба, где он —
     пара. Настройки кабинета блоков свадьбы всё равно не показывают. */
  const withWedding: Routes = {
    '/weddings': [{ ...WEDDING, role: 'couple' }],
    '/weddings/w1': { ...WEDDING, members: [{ user: { id: 'u1', name: 'Аня' }, role: 'couple' }] },
    '/weddings/w1/slots': [],
  }

  it('тема, язык, push, сессии, «Выйти», «Выйти со всех устройств», «Удалить аккаунт» — есть; города и отмены свадьбы нет даже при помнимой свадьбе', async () => {
    couple()
    const { container } = openSettings(settingsRoutes(withWedding))
    await waitFor(() => expect(text({ container })).toContain('Windows'), { timeout: 4000 })
    await settle()
    const s = text({ container })
    expect(s).toMatch(/тема/)
    expect(s).toContain('Язык интерфейса')
    expect(s).toContain('Push на этом устройстве')
    expect(s).toContain('Android')
    expect(screen.getByText('Выйти').closest('button')).toBeTruthy()
    expect(s).toContain('Выйти со всех устройств')
    expect(s).toContain('Удалить аккаунт')
    expect(s, 'город свадьбы в настройках подрядчика').not.toContain('Город свадьбы')
    expect(s, 'отмена свадьбы в настройках подрядчика').not.toContain('Отменить свадьбу')
    expect(s, 'дедлайны задач — виды уведомлений пары').not.toContain('Уведомления: дедлайны задач')
  })

  it('«Посмотреть анкету глазами пары» → /vendor/{id} из GET /vendor/profile; без анкеты (404) строки нет', async () => {
    signedIn()
    const r1 = openSettings(settingsRoutes())
    await waitFor(() => expect(screen.getByText('Посмотреть анкету глазами пары')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Посмотреть анкету глазами пары'))
    await waitFor(() => expect(text(r1)).toContain('АНКЕТА /vendor/v1'), { timeout: 4000 })
    cleanup(); vi.unstubAllGlobals()
    const r2 = openSettings(settingsRoutes({ '/vendor/profile': withStatus(404, 'not_found', 'Анкета не найдена') }))
    await waitFor(() => expect(text(r2)).toContain('Windows'), { timeout: 4000 })
    await settle()
    expect(screen.queryByText('Посмотреть анкету глазами пары'), 'ссылка на анкету, которой нет').toBeNull()
    expect(text(r2), '404 на своей анкете — состояние, а не ошибка экрана').not.toContain('Анкета не найдена')
  })

  it('«Выйти» гасит только свою сессию: DELETE /users/me/sessions/{своя}, без DELETE всех; токены сняты, экран входа', async () => {
    signedIn()
    const { calls, container } = openSettings(settingsRoutes({ '/users/me/sessions/this-one': { __status: 204, body: null, headers: {} } }))
    await waitFor(() => expect(text({ container })).toContain('Windows'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Выйти'))
    await waitFor(() => expect(deletes(calls, '/users/me/sessions/this-one').length).toBe(1), { timeout: 4000 })
    expect(deletes(calls, '/users/me/sessions').length, '«Выйти» выгнал и другие устройства').toBe(0)
    await waitFor(() => expect(text({ container })).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    expect(localStorage.getItem('tt_auth')).toBeNull()
  })

  it('«Назад» → /vendor-app; 409 active_deals на удаление — словами сервера', async () => {
    signedIn()
    const { container } = openSettings(settingsRoutes({
      '/users/me': (c: Call) => (c.method === 'DELETE' ? withStatus(409, 'active_deals', 'Сначала завершите или отмените сделки (2)') : ME),
    }))
    await waitFor(() => expect(screen.getByText('Удалить аккаунт')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Удалить аккаунт'))
    fireEvent.click(screen.getByText('Подтвердить удаление'))
    expect(await screen.findByText('Сначала завершите или отмените сделки (2)')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Назад'))
    await waitFor(() => expect(text({ container })).toContain('КАБИНЕТ /vendor-app'), { timeout: 4000 })
  })

  it('пара на /settings: «Город свадьбы» и «Отменить свадьбу» на месте, строки про анкету нет (контроль)', async () => {
    couple()
    const { container } = openSettings(settingsRoutes(withWedding), false)
    await waitFor(() => expect(text({ container })).toContain('Отменить свадьбу'), { timeout: 4000 })
    expect(text({ container })).toContain('Город свадьбы')
    expect(screen.queryByText('Посмотреть анкету глазами пары')).toBeNull()
  })
})

/* ── T6: своя анкета глазами пары ─────────────────────────────────────────── */

describe('T6: /vendor/:id своей анкеты — плашка и «Это ваша анкета», чужая анкета не меняется', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const DETAIL = {
    id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
    priceFrom: { amount: 5_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, about: 'Снимаем свадьбы', phone: null,
    gallery: [], packages: [{ name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: [] }],
  }
  /** Всё, что читает карточка подрядчика `v1`; своя анкета кабинета — отдельным ответом. */
  const detailRoutes = (detail: Record<string, unknown>, over: Routes = {}): Routes => ({
    '/catalog/categories': [{ id: 'photo', title: 'Фотограф', icon: '📷' }],
    '/catalog/vendors/v1': detail,
    '/catalog/vendors/v1/availability': { busyDates: [] },
    '/catalog/vendors/v1/reviews': { items: [] },
    '/catalog/vendors': { items: [] },
    '/weddings': [], '/me/favorites': [], '/users/me': ME,
    ...over,
  })
  const openDetail = () => renderAt('/vendor/v1', <>
    <Route path="/vendor/:id" element={<VendorDetail />} />
    <Route path="/vendor-app/profile" element={<Probe label="МАСТЕР" />} />
  </>)

  it('published: false — плашка role=alert; «Написать» и «Добавить в свадьбу» скрыты; «Редактировать» → /vendor-app/profile', async () => {
    signedIn()
    serve(detailRoutes({ ...DETAIL, published: false, blocked: false, phone: '+79990000001' }, { '/vendor/profile': PROFILE }))
    const r = openDetail()
    await waitFor(() => expect(text(r)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await waitFor(() => expect(alerts()).toContain('Анкета не опубликована — пары её пока не видят'), { timeout: 4000 })
    expect(screen.queryByText('Написать'), 'подрядчику предложено написать самому себе').toBeNull()
    expect(screen.queryByText('Добавить в свадьбу'), 'подрядчику предложено забронировать самого себя').toBeNull()
    expect(text(r)).toContain('Это ваша анкета')
    fireEvent.click(screen.getByText('Редактировать'))
    await waitFor(() => expect(text(r)).toContain('МАСТЕР /vendor-app/profile'), { timeout: 4000 })
  })

  it('blocked — «Анкета заблокирована модератором», не «не опубликована»', async () => {
    signedIn()
    serve(detailRoutes({ ...DETAIL, published: true, blocked: true }, { '/vendor/profile': PROFILE }))
    const r = openDetail()
    await waitFor(() => expect(text(r)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await waitFor(() => expect(alerts()).toContain('Анкета заблокирована модератором'), { timeout: 4000 })
    expect(alerts()).not.toContain('не опубликована')
    expect(screen.queryByText('Написать')).toBeNull()
  })

  it('опубликованная своя: серверные published/blocked определяют владельца без пробы кабинета', async () => {
    signedIn()
    const calls = serve(detailRoutes({ ...DETAIL, published: true, blocked: false }, { '/vendor/profile': withStatus(500, 'internal', 'Кабинет недоступен') }))
    const r = openDetail()
    await waitFor(() => expect(text(r)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Это ваша анкета'), { timeout: 4000 })
    expect(alerts(), 'плашка у опубликованной анкеты').toBe('')
    expect(screen.queryByText('Написать')).toBeNull()
    expect(screen.queryByText('Добавить в свадьбу')).toBeNull()
    expect(calls.filter(c => c.path === '/vendor/profile')).toHaveLength(0)
  })

  it('чужая анкета: «Написать» и «Добавить в свадьбу» на месте, плашки и «Это ваша анкета» нет (контроль)', async () => {
    couple()
    serve(detailRoutes(DETAIL, { ...base(), '/vendor/profile': { ...PROFILE, id: 'v-other' } }))
    const r = openDetail()
    await waitFor(() => expect(text(r)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await settle()
    expect(screen.getByText('Написать')).toBeTruthy()
    expect(screen.getByText('Добавить в свадьбу')).toBeTruthy()
    expect(alerts()).toBe('')
    expect(text(r)).not.toContain('Это ваша анкета')
    cleanup(); vi.unstubAllGlobals()
    /* Пара без анкеты подрядчика: каталог не обращается к кабинету. */
    const calls = serve(detailRoutes(DETAIL, { ...base(), '/vendor/profile': withStatus(404, 'not_found', 'Анкета не найдена') }))
    const r2 = openDetail()
    await waitFor(() => expect(text(r2)).toContain('Снимаем свадьбы'), { timeout: 4000 })
    await settle()
    expect(screen.getByText('Написать')).toBeTruthy()
    expect(text(r2)).not.toContain('Анкета не найдена')
    expect(text(r2)).not.toContain('Это ваша анкета')
    expect(calls.filter(c => c.path === '/vendor/profile')).toHaveLength(0)
  })
})
