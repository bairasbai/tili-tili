// @vitest-environment jsdom
/*
 * Фича 018 «Ответы квиза влияют на свадьбу» (tasks/фичи/018-квиз-влияет) — фронт.
 *
 * Квиз:
 *  К1 последний шаг — «Как вас зовут?»: два обязательных поля, «Ваше имя» из профиля, подсказки
 *     «подставится из профиля» больше нет;
 *  К2 имя уходит в профиль (`PATCH /users/me`) ДО `POST /weddings` — если в профиле пусто или его
 *     изменили; не изменили — профиль не трогается; отказ PATCH — свадьба не заводится;
 *  К3 на сервер уходят коды, а не подписи: `format`, `planner`, `prebooked`; «Пока ничего» исключает
 *     остальные варианты; пропущенные вопросы не шлют ничего.
 * Плитка «Уже забронировано»:
 *  П1 главная: карточка слота с отметкой и два действия; счётчик «команда» считает её бронью;
 *  П2 «Нет, ещё ищем» — `DELETE …/prebooked`, мозаика перечитана;
 *  П3 помощник видит отметку, но не кнопки (их исход у него — только 403, R-270);
 *  П4 «Наш день»: подпись и сводка считают отметку бронью, подсказка «Пустой слот» её не называет;
 *  П5 «Добавить подрядчика» открывает форму своего подрядчика этого слота — и она шлёт `POST …/external`;
 *  П6 экран слота с отметкой — состояние словами и «Нет, ещё ищем»;
 *  П7 каталог: у категории с отметкой «✓ Есть».
 *
 * Проверяется то, что ушло на сервер, и то, что видно на экране (приём `audit32`).
 */
import { render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { SlotDetail, WeddingTeam } from '@/pages/Wedding'
import { SearchCategories } from '@/pages/Search'

type RouteMap = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}
const withStatus = (status: number, code: string, message: string) => ({ __status: status, body: { error: { code, message } } })

function serve(routes: RouteMap): Call[] {
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
    return Promise.resolve(json(reply, reply === undefined ? 204 : 200))
  }))
  return calls
}

const TOKENS = { accessToken: 'a', refreshToken: 'r' }
const signedIn = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify(TOKENS))
}

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
const button = (label: string | RegExp) => screen.getByRole('button', { name: label })

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/* ── квиз ─────────────────────────────────────────────────────────────── */

const click = (label: string) => fireEvent.click(screen.getByText(label))
const next = () => fireEvent.click(screen.getByText('Далее'))
const skip = () => fireEvent.click(screen.getByText('Пропустить вопрос'))

interface Walk { format?: string; planner?: string; booked?: string[]; dateDay?: string }
/** Квиз от даты до шага имён: по умолчанию «ещё не решили», но тесты отказа могут выбрать реальную дату; Уфа; остальные ответы — по `w`. */
function walkToNames(w: Walk = {}) {
  if (w.dateDay) {
    click('Выбрать день в календаре')
    const day = screen.getAllByRole('button').find(b => b.textContent === w.dateDay && !(b as HTMLButtonElement).disabled)
    expect(day, `день ${w.dateDay} должен быть доступен в календаре`).toBeTruthy()
    fireEvent.click(day!)
  } else {
    click('Ещё не решили')
  }
  next()
  click('Уфа'); next()
  skip() // гости
  skip() // бюджет
  if (w.format) { click(w.format); next() } else skip()
  skip() // стиль
  if (w.planner) { click(w.planner); next() } else skip()
  if (w.booked) { for (const b of w.booked) click(b); next() } else skip()
}

const ownInput = () => screen.getByPlaceholderText('Ваше имя') as HTMLInputElement
const partnerInput = () => screen.getByPlaceholderText('Имя партнёра') as HTMLInputElement
const createButton = () => screen.getByText('Создать мою свадьбу ✨').closest('button') as HTMLButtonElement
const type = (el: HTMLInputElement, value: string) => fireEvent.change(el, { target: { value } })

const quizRoutes = (me: Record<string, unknown>, over: RouteMap = {}): RouteMap => ({
  '/weddings': (c: Call) => (c.method === 'POST' ? { id: 'w-new', title: 'Алина ♥ Тимур' } : []),
  '/users/me': (c: Call) => (c.method === 'PATCH' ? { ...me, name: (c.body as { name?: string }).name } : me),
  '/me/favorites': [],
  ...over,
})
const quizScreen = () => renderAt('/quiz', <><Route path="/quiz" element={<Quiz />} /><Route path="/home" element={<p>ГЛАВНАЯ</p>} /></>)
const postOf = (calls: Call[]) => calls.find(c => c.method === 'POST' && c.path === '/weddings')
const patchIndex = (calls: Call[]) => calls.findIndex(c => c.method === 'PATCH' && c.path === '/users/me')
const postIndex = (calls: Call[]) => calls.findIndex(c => c.method === 'POST' && c.path === '/weddings')

describe('К1: последний шаг — «Как вас зовут?», два обязательных имени', () => {
  beforeEach(signedIn)

  it('«Ваше имя» предзаполнено из профиля, «Имя партнёра» пусто; без обоих кнопка закрыта; подсказки про профиль нет', async () => {
    serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    const r = quizScreen()
    walkToNames()
    expect(screen.getByRole('heading', { name: 'Как вас зовут?' })).toBeTruthy()
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    expect(partnerInput().value).toBe('')
    expect(text(r)).not.toMatch(/подставится из профиля/)
    expect(createButton().disabled, 'без имени партнёра свадьбу не создать').toBe(true)
    type(partnerInput(), 'Тимур')
    expect(createButton().disabled).toBe(false)
    type(ownInput(), '   ')
    expect(createButton().disabled, 'пустое своё имя — тоже нельзя').toBe(true)
  })

  it('пустой профиль — поле «Ваше имя» пусто, а не «undefined»', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: null }))
    quizScreen()
    walkToNames()
    await waitFor(() => expect(calls.some(c => c.method === 'GET' && c.path === '/users/me')).toBe(true), { timeout: 4000 })
    expect(ownInput().value).toBe('')
  })
})

describe('К2: имя уходит в профиль до создания свадьбы', () => {
  beforeEach(signedIn)

  it('профиль пуст: PATCH /users/me {name} раньше POST /weddings', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: '' }))
    const r = quizScreen()
    walkToNames()
    type(ownInput(), 'Алина')
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    const patch = calls[patchIndex(calls)]
    expect(patch?.body).toEqual({ name: 'Алина' })
    expect(patchIndex(calls)).toBeLessThan(postIndex(calls))
    expect((postOf(calls)!.body as { partnerName: string }).partnerName).toBe('Тимур')
  })

  it('имя в профиле не меняли — профиль не трогается', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    const r = quizScreen()
    walkToNames()
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    expect(patchIndex(calls)).toBe(-1)
    expect(postIndex(calls)).toBeGreaterThanOrEqual(0)
  })

  it('имя в профиле изменили — PATCH с новым именем раньше POST', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    const r = quizScreen()
    walkToNames()
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    type(ownInput(), 'Алина М.')
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    expect(calls[patchIndex(calls)]?.body).toEqual({ name: 'Алина М.' })
    expect(patchIndex(calls)).toBeLessThan(postIndex(calls))
  })

  it('профиль не сохранился — свадьба не заводится, причина на экране', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: '' }, {
      '/users/me': (c: Call) => (c.method === 'PATCH' ? withStatus(422, 'validation_failed', 'Запрос не прошёл проверку') : { id: 'u1', name: '' }),
    }))
    const r = quizScreen()
    walkToNames()
    type(ownInput(), 'Алина')
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('Запрос не прошёл проверку'), { timeout: 4000 })
    expect(patchIndex(calls)).toBeGreaterThanOrEqual(0)
    expect(postIndex(calls), 'свадьба с одним именем партнёра заводиться не должна').toBe(-1)
    expect(text(r)).not.toContain('ГЛАВНАЯ')
  })

  it('ошибка создания сохраняет черновик, но не завершает онбординг и не записывает дату свадьбы', async () => {
    localStorage.removeItem('tt_onboarded')
    const calls = serve(quizRoutes({ id: 'u1', name: 'Алина' }, {
      '/weddings': (c: Call) => (c.method === 'POST'
        ? withStatus(503, 'service_unavailable', 'Сервис недоступен')
        : []),
    }))
    const r = quizScreen()
    walkToNames({ format: 'Классика: ЗАГС + банкет', dateDay: '15' })
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())

    await waitFor(() => expect(text(r)).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(postIndex(calls)).toBeGreaterThanOrEqual(0)
    expect((postOf(calls)!.body as { date?: string }).date).toMatch(/^\d{4}-\d{2}-15$/)
    expect(localStorage.getItem('tt_onboarded')).toBeNull()
    expect(JSON.parse(localStorage.getItem('tt_quiz') ?? 'null')).toMatchObject({
      format: 'Классика: ЗАГС + банкет',
      date: expect.stringMatching(/^\d{4}-\d{2}-15$/),
    })
    expect(localStorage.getItem('tt_wedding_date')).toBeNull()
    expect(text(r)).not.toContain('ГЛАВНАЯ')
  })
})

describe('К3: на сервер уходят коды, а не подписи', () => {
  beforeEach(signedIn)

  async function createWith(w: Walk) {
    const calls = serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    const r = quizScreen()
    walkToNames(w)
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    return postOf(calls)!.body as Record<string, unknown>
  }

  it('«Выездная церемония», «С помощью агентства», «Площадка» и «Ведущий» → outdoor, agency, [venue, host]; сырые ответы — как есть', async () => {
    const body = await createWith({ format: 'Выездная церемония', planner: 'С помощью агентства', booked: ['Площадка', 'Ведущий'] })
    expect(body).toMatchObject({ format: 'outdoor', planner: 'agency', prebooked: ['venue', 'host'] })
    expect(body.quizAnswers).toMatchObject({ format: 'Выездная церемония', planner: 'С помощью агентства', booked: ['Площадка', 'Ведущий'] })
  })

  it.each([
    ['Классика: ЗАГС + банкет', 'classic'],
    ['Выездная церемония', 'outdoor'],
    ['Камерная свадьба', 'intimate'],
    ['Банкет+ на 2 дня', 'two_day'],
  ])('формат «%s» → %s', async (label, code) => {
    expect((await createWith({ format: label })).format).toBe(code)
  })

  it.each([
    ['Сами', 'self'],
    ['С помощью агентства', 'agency'],
    ['Ищем координатора', 'coordinator'],
  ])('«кто планирует» «%s» → %s', async (label, code) => {
    expect((await createWith({ planner: label })).planner).toBe(code)
  })

  it('«Пока ничего» — пустой список', async () => {
    expect((await createWith({ booked: ['Пока ничего'] })).prebooked).toEqual([])
  })

  it('«Пока ничего» снимает выбранные варианты, а вариант снимает «Пока ничего»', async () => {
    serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    quizScreen()
    click('Ещё не решили'); next()
    click('Уфа'); next()
    for (let step = 0; step < 5; step++) skip()
    expect(screen.getByText('Что уже забронировано?')).toBeTruthy()
    const chosen = (label: string) => screen.getByText(label).closest('button')!.className.includes('ring-2')
    click('Площадка'); click('Фотограф')
    expect(chosen('Площадка') && chosen('Фотограф')).toBe(true)
    click('Пока ничего')
    expect([chosen('Пока ничего'), chosen('Площадка'), chosen('Фотограф')]).toEqual([true, false, false])
    click('Видеограф')
    expect([chosen('Пока ничего'), chosen('Видеограф')]).toEqual([false, true])
  })

  it('вопросы пропущены — полей нет вовсе, как у старого клиента', async () => {
    const body = await createWith({})
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('planner')
    expect(body).not.toHaveProperty('prebooked')
  })

  it('вариант выбрали, а потом «Пропустить вопрос» — ответа нет: коды не уходят (ревью PR, D-03)', async () => {
    const calls = serve(quizRoutes({ id: 'u1', name: 'Алина' }))
    const r = quizScreen()
    click('Ещё не решили'); next()
    click('Уфа'); next()
    skip() // гости
    skip() // бюджет
    click('Классика: ЗАГС + банкет'); skip()
    skip() // стиль
    click('С помощью агентства'); skip()
    click('Площадка'); skip()
    await waitFor(() => expect(ownInput().value).toBe('Алина'), { timeout: 4000 })
    type(partnerInput(), 'Тимур')
    fireEvent.click(createButton())
    await waitFor(() => expect(text(r)).toContain('ГЛАВНАЯ'), { timeout: 4000 })
    const body = postOf(calls)!.body as Record<string, unknown>
    expect(body).not.toHaveProperty('format')
    expect(body).not.toHaveProperty('planner')
    expect(body).not.toHaveProperty('prebooked')
  })
})

/* ── плитка «Уже забронировано» ───────────────────────────────────────── */

const WEDDING = { id: 'w1', title: 'Алина ♥ Тимур', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg' }
const slot = (id: string, categoryId: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, categoryId, label, deal: null, tileState: 'empty', prebooked: false, ...extra })
const BOOKED_PHOTO = slot('s-photo', 'photo', 'Фотограф', {
  tileState: 'booked',
  deal: { id: 'd1', state: 'booked', vendor: { id: 'v1', name: 'Студия Свет' }, price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
})

/** Мозаика на сервере: площадка отмечена, фотограф забронирован, видеограф и DJ пусты. Снятие отметки меняет ответ. */
function weddingRoutes(role = 'couple') {
  let venueMarked = true
  const routes: RouteMap = {
    '/weddings': [{ ...WEDDING, role }],
    '/weddings/w1': WEDDING,
    '/weddings/w1/slots': () => [
      slot('s-venue', 'venue', 'Площадка', { prebooked: venueMarked }),
      BOOKED_PHOTO,
      slot('s-video', 'video', 'Видеограф'),
      slot('s-dj', 'dj', 'DJ'),
    ],
    '/weddings/w1/slots/s-venue/prebooked': (c: Call) => { if (c.method === 'DELETE') venueMarked = false; return undefined },
    '/weddings/w1/slots/s-venue/external': slot('s-venue', 'venue', 'Площадка', { tileState: 'booked', deal: { id: 'd2', state: 'booked', externalName: 'Усадьба', price: { amount: 30_000_000, currency: 'RUB' } } }),
    '/weddings/w1/budget': { total: { amount: 150_000_000, currency: 'RUB' }, spent: { amount: 0, currency: 'RUB' }, categories: [] },
    '/weddings/w1/tips': { items: [] },
    '/weddings/w1/tasks': [],
    '/weddings/w1/guests': [],
    '/notifications': [],
    '/me/favorites': [],
    '/users/me': { id: 'u1', name: 'Алина' },
  }
  return routes
}

const inWedding = () => {
  signedIn()
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}

const screens = (
  <>
    <Route path="/home" element={<Home />} />
    <Route path="/wedding" element={<WeddingTeam />} />
    <Route path="/wedding/slot/:id" element={<SlotDetail />} />
  </>
)
const prebookedCard = (label: string) => screen.getAllByTestId('prebooked-slot').find(el => el.textContent?.includes(label))

describe('П1–П3: главная — карточка «Уже забронировано»', () => {
  beforeEach(inWedding)

  it('карточка «Площадка — Уже забронировано» с двумя действиями; «команда» считает её бронью', async () => {
    serve(weddingRoutes())
    const r = renderAt('/home', screens)
    await waitFor(() => expect(screen.queryAllByTestId('prebooked-slot')).toHaveLength(1), { timeout: 4000 })
    const card = prebookedCard('Площадка')!
    expect(within(card).getByText('Уже забронировано')).toBeTruthy()
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Добавить подрядчика' })).toBeTruthy(), { timeout: 4000 })
    expect(within(card).getByRole('button', { name: 'Нет, ещё ищем' })).toBeTruthy()
    /* Фотограф забронирован, площадка — вне приложения: команда 2 из 4, а не 1 из 4. */
    expect(text(r)).toMatch(/2\/4\s*команда/)
    expect(text(r)).not.toContain('Пока никто не забронирован')
  })

  it('«Нет, ещё ищем» — DELETE …/prebooked, мозаика перечитана, карточки нет', async () => {
    const calls = serve(weddingRoutes())
    renderAt('/home', screens)
    await waitFor(() => expect(button('Нет, ещё ищем')).toBeTruthy(), { timeout: 4000 })
    const slotsBefore = calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/slots').length
    const tipsBefore = calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/tips').length
    fireEvent.click(button('Нет, ещё ищем'))
    await waitFor(() => expect(screen.queryAllByTestId('prebooked-slot')).toHaveLength(0), { timeout: 4000 })
    expect(calls.filter(c => c.method === 'DELETE' && c.path === '/weddings/w1/slots/s-venue/prebooked')).toHaveLength(1)
    expect(calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/slots').length).toBeGreaterThan(slotsBefore)
    /* Подсказки Тиля считают отметку бронью (FR-017): снята — перечитываем, иначе совет виден только после перезахода (D-09). */
    await waitFor(() => expect(calls.filter(c => c.method === 'GET' && c.path === '/weddings/w1/tips').length).toBeGreaterThan(tipsBefore), { timeout: 4000 })
  })

  it.each(['helper', 'coordinator'] as const)('%s видит отметку, но не кнопки: их исход у него — только 403', async (role) => {
    serve(weddingRoutes(role))
    renderAt('/home', screens)
    await waitFor(() => expect(screen.getByText('Отметку ведёт пара')).toBeTruthy(), { timeout: 4000 })
    const card = prebookedCard('Площадка')!
    expect(within(card).getByText('Уже забронировано')).toBeTruthy()
    expect(within(card).queryByRole('button')).toBeNull()
  })
})

describe('П4–П6: «Наш день» и экран слота', () => {
  beforeEach(inWedding)

  it('подпись и сводка считают отметку бронью; «Пустой слот» называет только пустые', async () => {
    serve(weddingRoutes())
    const r = renderAt('/wedding', screens)
    await waitFor(() => expect(text(r)).toContain('2 забронировано · 0 в работе · 2 пустых'), { timeout: 4000 })
    expect(text(r)).toMatch(/Команда собрана\s*2 из 4/)
    expect(text(r)).toContain('Пустой слот «Видеограф» и «DJ»')
    const card = prebookedCard('Площадка')!
    expect(within(card).getByText('Уже забронировано')).toBeTruthy()
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Нет, ещё ищем' })).toBeTruthy(), { timeout: 4000 })
  })

  it('«Добавить подрядчика» открывает форму своего подрядчика этого слота, и она шлёт POST …/external', async () => {
    const calls = serve(weddingRoutes())
    renderAt('/wedding', screens)
    await waitFor(() => expect(button('Добавить подрядчика')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(button('Добавить подрядчика'))
    const name = await screen.findByPlaceholderText('Имя / название (напр. Фотограф Ирек)', {}, { timeout: 4000 })
    /* ERR-0309: два поля в одной flex-строке без `min-w-0` раздували страницу до 449 px на экране 390 px
       (ширину меряет живой обход, `flow-onboard.cjs`; здесь — сторож класса). */
    for (const field of ['Цена, ₽', 'Телефон']) expect(screen.getByPlaceholderText(field).className).toContain('min-w-0')
    type(name as HTMLInputElement, 'Усадьба «Липы»')
    type(screen.getByPlaceholderText('Цена, ₽') as HTMLInputElement, '300000')
    type(screen.getByPlaceholderText('Телефон') as HTMLInputElement, '+79171234567')
    fireEvent.click(button('Добавить в команду'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/weddings/w1/slots/s-venue/external')).toBe(true), { timeout: 4000 })
    const post = calls.find(c => c.method === 'POST' && c.path === '/weddings/w1/slots/s-venue/external')!
    expect(post.body).toMatchObject({ vendorName: 'Усадьба «Липы»', price: { amount: 30_000_000, currency: 'RUB' }, phone: '+79171234567' })
  })

  it('экран слота с отметкой: состояние словами и «Нет, ещё ищем» → DELETE', async () => {
    const calls = serve(weddingRoutes())
    const r = renderAt('/wedding/slot/s-venue', screens)
    await waitFor(() => expect(text(r)).toContain('Уже забронировано'), { timeout: 4000 })
    expect(text(r)).not.toContain('Исполнитель не выбран')
    await waitFor(() => expect(button('Нет, ещё ищем')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(button('Нет, ещё ищем'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/weddings/w1/slots/s-venue/prebooked')).toBe(true), { timeout: 4000 })
    /* Снятая отметка — обычный пустой слот: каталог и свой подрядчик. */
    await waitFor(() => expect(text(r)).toContain('Исполнитель не выбран'), { timeout: 4000 })
  })
})

describe('П7: каталог', () => {
  beforeEach(inWedding)

  it('у категории с отметкой — «✓ Есть», как у забронированной', async () => {
    serve({
      ...weddingRoutes(),
      '/catalog/categories': [
        { id: 'venue', title: 'Площадка', icon: '🏛️' },
        { id: 'photo', title: 'Фотограф', icon: '📸' },
        { id: 'video', title: 'Видеооператор', icon: '🎥' },
      ],
    })
    const r = renderAt('/search', <Route path="/search" element={<SearchCategories />} />)
    await waitFor(() => expect(text(r)).toContain('Видеооператор'), { timeout: 4000 })
    await waitFor(() => expect(screen.getAllByText('✓ Есть')).toHaveLength(2), { timeout: 4000 })
    const venue = screen.getByText('Площадка').closest('button')!
    expect(within(venue).getByText('✓ Есть')).toBeTruthy()
  })
})
