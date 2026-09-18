// @vitest-environment jsdom
/*
 * Фича 006 «Транспорт», экраны под контракт v0.30.0 (задание FE-006). Каждый
 * тест здесь был красным на коде до фикса — цитаты красного в отчёте
 * `REPORT-FE.md`.
 *
 * Что закрывается:
 *  — логистика: у маршрута подпись перевозчика (`BusRoute.carrier`), у маршрута
 *    без сделки — «без перевозчика»; в форме «Добавить автобус» — выбор
 *    перевозчика из транспортных сделок мозаики, `POST` уходит с `dealId`;
 *    «Изменить» → инлайн-форма → `PATCH …/buses/{busId}`, 409/422 — словами
 *    сервера под «Сохранить»; `?deal=` раскрывает форму с перевозчиком (T1);
 *  — карточка транспортной сделки: блок «Маршруты для гостей» из `GET …/buses`
 *    по `dealId`, «занято M из K», кнопка ведёт в логистику с `?deal=`;
 *    до ответа сервера — ничего, у других категорий блока нет (T2);
 *  — гость видит «Автобус №1 · Автобусы Уфы» — только имя (T3);
 *  — кабинет: «Маршрутов: N · записалось M из K» только при непустом
 *    `busRoutes` (T4).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик (приём из `audit25`/`audit30`/`audit32`).
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import Invite from '@/pages/Invite'
import { Deal } from '@/pages/Tools'
import { Logistics } from '@/pages/Logistics'
import { VendorDeals } from '@/pages/VendorApp'

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
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const patches = (calls: Call[], path: string) => calls.filter(c => c.method === 'PATCH' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const count = (s: string, needle: string) => s.split(needle).length - 1

/* Пока не понадобились: тот же набор помощников, что в audit32. */
void PENDING; void DOWN

/* Слот мозаики со сделкой: категория и состояние — параметры, остальное как у пары. */
const slotWith = (id: string, categoryId: string, label: string, dealId: string, name: string, state = 'booked') => ({
  id, categoryId, label, tileState: state === 'candidate' ? 'candidate' : 'booked',
  deal: { id: dealId, state, vendor: { id: `v-${id}`, name }, price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
})
const transport = (id: string, dealId: string, name: string, state = 'booked') => slotWith(id, 'transport', 'Транспорт', dealId, name, state)

const BUSES = '/weddings/w1/logistics/buses'
const BUS1 = '/weddings/w1/logistics/buses/b1'
const BUS = { id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 20, taken: 3 }

/* ── T1: логистика — перевозчик у маршрута, в форме и в PATCH ───────────── */

describe('T1: логистика — подпись перевозчика, выбор перевозчика в форме, «Изменить» → PATCH, ?deal= раскрывает форму', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const logistics = (over: Routes = {}) => base({ [BUSES]: [BUS], '/weddings/w1/logistics/hotels': [], ...over })
  const openLogistics = (search = '') => renderAt(`/wedding/logistics${search}`, <Route path="/wedding/logistics" element={<Logistics />} />)
  const alerts = () => screen.queryAllByRole('alert').map(e => e.textContent).join(' | ')

  it('у маршрута со сделкой — имя перевозчика; dealId: null — «без перевозчика»; без поля — ничего', async () => {
    serve(logistics({ [BUSES]: [
      { ...BUS, dealId: 'd-t1', carrier: 'Автобусы Уфы' },
      { ...BUS, id: 'b2', name: 'Автобус №2', dealId: null, carrier: null },
      { ...BUS, id: 'b3', name: 'Микроавтобус дяди' },
    ] }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Микроавтобус дяди'), { timeout: 4000 })
    expect(text(r), 'имя перевозчика из carrier не показано').toContain('Автобусы Уфы')
    expect(count(text(r), 'без перевозчика'), '«без перевозчика» — только у маршрута с dealId: null').toBe(1)
  })

  it('форма: «Перевозчик» — живые транспортные сделки мозаики, кандидат и фотограф не предлагаются; POST уходит с dealId', async () => {
    let reads = 0
    const calls = serve(logistics({
      '/weddings/w1/slots': [
        transport('s1', 'd-t1', 'Автобусы Уфы'),
        transport('s2', 'd-t2', 'Такси «Ветер»', 'candidate'),
        slotWith('s3', 'photo', 'Фотограф', 'd-p1', 'Фото «Кадр»'),
      ],
      [BUSES]: (c: Call) => { if (c.method === 'POST') return { ...BUS, id: 'b9', ...(c.body as object) }; reads++; return [BUS] },
    }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Добавить автобус'))
    const select = await screen.findByLabelText('Перевозчик', {}, { timeout: 4000 }) as HTMLSelectElement
    const listed = () => Array.from(select.options).map(o => o.textContent)
    await waitFor(() => expect(listed(), 'транспортная бронь не предложена').toContain('Автобусы Уфы'), { timeout: 4000 })
    const options = listed()
    expect(options, 'без перевозчика — тоже выбор').toContain('Без перевозчика')
    expect(options, 'кандидат предложен — сервер ответит 409/422').not.toContain('Такси «Ветер»')
    expect(options, 'сделка другой категории предложена — сервер ответит 422 not_transport').not.toContain('Фото «Кадр»')
    fireEvent.change(select, { target: { value: 'd-t1' } })
    fireEvent.change(screen.getByPlaceholderText('Название (Автобус №3)'), { target: { value: 'Автобус №2' } })
    /* Число мест — обязательно (ревью 015): без него — слова, а не молчаливые «20». */
    fireEvent.click(screen.getByText('Добавить автобус'))
    await waitFor(() => expect(text(r)).toContain('Укажите число мест в автобусе'), { timeout: 4000 })
    expect(posts(calls, BUSES).length).toBe(0)
    fireEvent.change(screen.getByLabelText('Мест'), { target: { value: '20' } })
    fireEvent.click(screen.getByText('Добавить автобус'))
    await waitFor(() => expect(posts(calls, BUSES).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, BUSES)[0]!.body).toEqual({ name: 'Автобус №2', seats: 20, dealId: 'd-t1' })
    await waitFor(() => expect(reads).toBe(2), { timeout: 4000 })
  })

  it('транспортных сделок нет — подсказка про слот «Транспорт», маршрут заводится без dealId', async () => {
    const calls = serve(logistics({
      '/weddings/w1/slots': [slotWith('s3', 'photo', 'Фотограф', 'd-p1', 'Фото «Кадр»')],
      [BUSES]: (c: Call) => (c.method === 'POST' ? { ...BUS, id: 'b9' } : [BUS]),
    }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Добавить автобус'))
    await waitFor(() => expect(text(r)).toContain('Перевозчик заводится в слоте «Транспорт» — маршрут можно завести и без него'), { timeout: 4000 })
    fireEvent.change(screen.getByPlaceholderText('Название (Автобус №3)'), { target: { value: 'Автобус №2' } })
    fireEvent.change(screen.getByLabelText('Мест'), { target: { value: '20' } })
    fireEvent.click(screen.getByText('Добавить автобус'))
    await waitFor(() => expect(posts(calls, BUSES).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, BUSES)[0]!.body).toEqual({ name: 'Автобус №2', seats: 20 })
  })

  it('«Изменить» → форма с текущими значениями → «Сохранить» → PATCH {name, from, time, seats, dealId: null}, после — маршруты перечитаны', async () => {
    let reads = 0
    const calls = serve(logistics({
      '/weddings/w1/slots': [transport('s1', 'd-t1', 'Автобусы Уфы')],
      [BUSES]: () => { reads++; return [{ ...BUS, dealId: 'd-t1', carrier: 'Автобусы Уфы' }] },
      [BUS1]: (c: Call) => ({ ...BUS, ...(c.body as object), carrier: null }),
    }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Изменить'))
    const name = await screen.findByLabelText('Название маршрута', {}, { timeout: 4000 }) as HTMLInputElement
    expect(name.value).toBe('Автобус №1')
    expect((screen.getByLabelText('Мест') as HTMLInputElement).value).toBe('20')
    expect((screen.getByLabelText('Перевозчик') as HTMLSelectElement).value, 'перевозчик маршрута не подставлен в форму').toBe('d-t1')
    fireEvent.change(screen.getByLabelText('Мест'), { target: { value: '10' } })
    fireEvent.change(screen.getByLabelText('Перевозчик'), { target: { value: '' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(patches(calls, BUS1).length).toBe(1), { timeout: 4000 })
    /* Снятый перевозчик уходит именно `null`: пропущенное поле сервер читает как «не трогать» (инвариант §5.3). */
    expect(patches(calls, BUS1)[0]!.body).toEqual({ name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 10, dealId: null })
    await waitFor(() => expect(reads).toBe(2), { timeout: 4000 })
    await waitFor(() => expect(screen.queryByLabelText('Название маршрута')).toBeNull(), { timeout: 4000 })
  })

  it('409 bus_full на «Сохранить» — текст сервера под кнопкой, форма остаётся', async () => {
    serve(logistics({ [BUS1]: withStatus(409, 'bus_full', 'Занято 3 персоны — меньше мест не поставить') }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Изменить'))
    fireEvent.change(await screen.findByLabelText('Мест', {}, { timeout: 4000 }), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(alerts()).toContain('Занято 3 персоны — меньше мест не поставить'), { timeout: 4000 })
    expect(screen.getByLabelText('Название маршрута'), 'форма закрылась, правка потеряна').toBeTruthy()
  })

  it('422 not_transport — тоже словами сервера', async () => {
    serve(logistics({ [BUS1]: withStatus(422, 'not_transport', 'Перевозчик заводится в слоте «Транспорт» — свяжите маршрут с транспортной сделкой') }))
    const r = openLogistics()
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Изменить'))
    fireEvent.click(await screen.findByText('Сохранить', {}, { timeout: 4000 }))
    await waitFor(() => expect(alerts()).toContain('свяжите маршрут с транспортной сделкой'), { timeout: 4000 })
  })

  it('?deal=d-t1 в адресе — форма раскрыта сразу, перевозчик предвыбран', async () => {
    serve(logistics({ '/weddings/w1/slots': [transport('s1', 'd-t1', 'Автобусы Уфы')] }))
    const r = openLogistics('?deal=d-t1')
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    const select = await screen.findByLabelText('Перевозчик', {}, { timeout: 4000 }) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('d-t1'), { timeout: 4000 })
    expect(screen.getByPlaceholderText('Название (Автобус №3)'), 'форма из карточки сделки не раскрыта').toBeTruthy()
  })
})

/* ── T2: карточка транспортной сделки — «Маршруты для гостей» ───────────── */

/** Куда увела кнопка: путь и строка запроса. */
function Probe() {
  const loc = useLocation()
  return <p>ЛОГИСТИКА {loc.search}</p>
}

describe('T2: карточка транспортной сделки — блок «Маршруты для гостей» по dealId, кнопка ведёт в логистику с ?deal=', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const dealRoutes = (id: string) => renderAt(`/deal/${id}`, <>
    <Route path="/deal/:id" element={<Deal />} />
    <Route path="/wedding/logistics" element={<Probe />} />
  </>)
  const deal = (over: Routes = {}) => base({
    '/weddings/w1/slots': [transport('s1', 'd-t1', 'Автобусы Уфы'), slotWith('s3', 'photo', 'Фотограф', 'd-p1', 'Фото «Кадр»')],
    '/deals/d-t1/events': [],
    '/deals/d-p1/events': [],
    ...over,
  })

  it('свои маршруты с «занято M из K», чужие и без сделки — нет; кнопка → /wedding/logistics?deal=d-t1', async () => {
    serve(deal({ [BUSES]: [
      { ...BUS, seats: 40, dealId: 'd-t1', carrier: 'Автобусы Уфы' },
      { ...BUS, id: 'b2', name: 'Микроавтобус дяди', dealId: null, carrier: null },
      { ...BUS, id: 'b3', name: 'Чужой маршрут', dealId: 'd-other', carrier: 'Другие' },
    ] }))
    const r = dealRoutes('d-t1')
    await waitFor(() => expect(text(r)).toContain('Маршруты для гостей'), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Автобус №1'), { timeout: 4000 })
    expect(text(r), 'занятые места из ответа не показаны').toContain('занято 3 из 40')
    expect(text(r), 'маршрут без сделки приписан перевозчику').not.toContain('Микроавтобус дяди')
    expect(text(r), 'маршрут другой сделки приписан этой').not.toContain('Чужой маршрут')
    fireEvent.click(screen.getByText('Добавить маршрут для гостей'))
    await waitFor(() => expect(text(r)).toContain('ЛОГИСТИКА ?deal=d-t1'), { timeout: 4000 })
  })

  it('до ответа сервера — ни списка, ни «пока нет»; после пустого ответа — «Маршрутов для гостей пока нет»', async () => {
    const g = gate()
    serve(deal({ [BUSES]: g.reply }))
    const r = dealRoutes('d-t1')
    await waitFor(() => expect(text(r)).toContain('Маршруты для гостей'), { timeout: 4000 })
    await settle()
    expect(text(r), 'ноль показан до ответа сервера').not.toContain('Маршрутов для гостей пока нет')
    g.release([])
    await waitFor(() => expect(text(r)).toContain('Маршрутов для гостей пока нет'), { timeout: 4000 })
  })

  it('у сделки другой категории блока нет и маршруты не запрашиваются', async () => {
    const calls = serve(deal({ [BUSES]: [BUS] }))
    const r = dealRoutes('d-p1')
    await waitFor(() => expect(text(r)).toContain('Фото «Кадр»'), { timeout: 4000 })
    await settle()
    expect(text(r)).not.toContain('Маршруты для гостей')
    expect(gets(calls, BUSES).length, 'маршруты запрошены у сделки, которой они не нужны').toBe(0)
  })
})

/* ── T3: гость — «Автобус №1 · Автобусы Уфы» ────────────────────────────── */

describe('T3: гость видит имя перевозчика у маршрута', () => {
  beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_guest_token', 'tok1') })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PAGE = { guestName: 'Марина', status: 'yes', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } }
  const openInvite = () => render(<MemoryRouter initialEntries={['/invite']}><Routes><Route path="/invite" element={<Invite />} /></Routes></MemoryRouter>)

  it('«Автобус №1 · Автобусы Уфы»; маршрут без перевозчика — как раньше, без приписок', async () => {
    serve({
      '/rsvp/tok1': PAGE,
      '/join/tok1/menu-vote': { question: '', options: [] },
      '/join/tok1/hotels': [],
      '/join/tok1/shuttle': { myBusId: null, routes: [
        { ...BUS, dealId: 'd-t1', carrier: 'Автобусы Уфы' },
        { ...BUS, id: 'b2', name: 'Автобус №2', dealId: null, carrier: null },
      ] },
    })
    const r = openInvite()
    await waitFor(() => expect(text(r)).toContain('Автобус №2'), { timeout: 4000 })
    expect(text(r), 'гость не видит, кто везёт').toContain('Автобус №1 · Автобусы Уфы')
    expect(text(r)).not.toContain('без перевозчика')
    expect(text(r), 'идентификатор сделки попал на экран гостя').not.toContain('d-t1')
  })
})

/* ── T4: кабинет — «Маршрутов: N · записалось M из K» ───────────────────── */

describe('T4: сделки кабинета — маршруты и записавшиеся только при непустом busRoutes', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PROFILE = { id: 'v1', name: 'Автобусы Уфы', city: 'Уфа', categoryId: 'transport', about: 'Возим гостей', phone: '+79990000001', published: true, verified: false, packages: [], gallery: [], rating: null, reviewsCount: 0 }
  const cabinet = (over: Routes = {}): Routes => ({
    '/vendor/profile': PROFILE, '/vendor/updates': [], '/vendor/leads': [], '/vendor/calendar': [], '/vendor/reviews': [],
    '/catalog/categories': [{ id: 'transport', title: 'Транспорт' }],
    '/weddings': [], '/me/favorites': [], '/users/me': ME,
    ...over,
  })
  const item = (id: string, over: Record<string, unknown> = {}) =>
    ({ id, coupleName: `Пара ${id}`, weddingDate: '2027-06-14', price: { amount: 5_000_000, currency: 'RUB' }, packageName: null, state: 'booked', holdUntil: null, ...over })

  it('два маршрута на 40 и 20 мест, записалось 3 — «Маршрутов: 2 · записалось 3 из 60»; пустой список и отсутствие поля — ничего', async () => {
    signedIn()
    serve(cabinet({ '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, items: [
      item('d1', { busRoutes: [{ id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 40, taken: 3 }, { id: 'b2', name: 'Автобус №2', from: null, time: null, seats: 20, taken: 0 }] }),
      item('d2', { busRoutes: [] }),
      item('d3'),
    ] } }))
    const r = renderAt('/vendor-app/deals', <Route path="/vendor-app/deals" element={<VendorDeals />} />)
    await waitFor(() => expect(text(r)).toContain('Пара d3'), { timeout: 4000 })
    expect(text(r), 'перевозчик не видит, сколько мест готовить').toContain('Маршрутов: 2 · записалось 3 из 60')
    expect(count(text(r), 'Маршрутов:'), 'строка выдумана у сделки без маршрутов').toBe(1)
  })
})
