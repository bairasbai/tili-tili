// @vitest-environment jsdom
/*
 * Фича 008 «Импорт гостей списком, заявка консьержу, деталь задачи» (контракт
 * v0.31.0, задание FE-008). Каждый тест здесь был красным на коде до фикса —
 * цитаты красного в отчёте `REPORT-FE.md`.
 *
 * Что закрывается:
 *  — гости: «Добавить списком» → панель с предпросмотром (имя · телефон ·
 *    «с +1»; пометки «уже в списке» по текущему списку, «телефон не
 *    распознан», «нет имени») → «Добавить N гостей» — один
 *    `POST …/guests/import` только с чистыми строками → список перечитан;
 *    итог «Добавлено N · пропущено M» — из ответа сервера, не из
 *    предпросмотра; отказ — словами сервера; без свадьбы — как у соседей (T1);
 *  — категория с пустой выдачей: «Оставить заявку консьержу» только
 *    вошедшему и только при `ready` и нуле анкет → форма (бюджет в рублях →
 *    `Money` в копейках, комментарий) → `POST /catalog/concierge` → «Заявка
 *    принята — свяжемся в течение суток»; 409 `concierge_pending` — словами
 *    сервера; второй раз не отправляется (T2);
 *  — чек-лист: тап по названию раскрывает строку (срок датой по-русски или
 *    «дата свадьбы не задана», период), «Переименовать» → `PATCH { title }`,
 *    «Удалить» → «Удалить?» → `DELETE` (только у своей задачи), галочка —
 *    `PATCH { done }` как была; ошибка — словами сервера под строкой (T3).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик (приём из `audit25`/`audit30`/`audit32`/`audit34`).
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { Checklist, Guests } from '@/pages/Wedding'
import { VendorList } from '@/pages/Search'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown; headers: Record<string, string> }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')

function isStatus(v: unknown): v is { __status: number; body: unknown; headers: Record<string, string> } {
  return typeof v === 'object' && v !== null && '__status' in v
}
function isLater(v: unknown): v is { __later: Promise<unknown> } {
  return typeof v === 'object' && v !== null && '__later' in v
}

/** Отказ сервера в формате контракта: код и текст. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } }, headers: {} })

/** Ответ, который придёт, когда тест его отпустит (окно «запрос в пути»). */
function gate() {
  let release!: (body: unknown) => void
  const promise = new Promise<unknown>(resolve => { release = resolve })
  return { reply: { __later: promise }, release }
}

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(status === 204 || status === 201 && body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
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
    if (isLater(reply)) return reply.__later.then(body => isStatus(body) ? json(body.body, body.__status, body.headers) : json(body))
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
const deletes = (calls: Call[], path: string) => calls.filter(c => c.method === 'DELETE' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))
const alerts = () => screen.queryAllByRole('alert').map(e => e.textContent).join(' | ')
const button = (name: string | RegExp) => screen.getByRole('button', { name })

/* ── T1: гости — «Добавить списком» ──────────────────────────────────────── */

describe('T1: «Добавить списком» — предпросмотр, один POST …/guests/import, итог словами сервера', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const IMPORT = '/weddings/w1/guests/import'
  const MARK = { id: 'g1', name: 'Марк', status: 'pending', plusOne: false, phone: null, hasPhone: false }
  const created = (...names: string[]) => names.map((name, i) => ({ id: `n${i}`, name, status: 'pending', plusOne: false }))
  const openGuests = () => renderAt('/wedding/guests', <Route path="/wedding/guests" element={<Guests />} />)
  const openPanel = async (r: ReturnType<typeof renderAt>, settledText: string) => {
    await waitFor(() => expect(text(r)).toContain(settledText), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Добавить списком'))
    return screen.getByLabelText('Список гостей') as HTMLTextAreaElement
  }

  it('три строки → предпросмотр: имя · телефон · «с +1», «Марк» помечен «уже в списке»; «Добавить 2 гостей» → один POST с двумя строками → список перечитан, «Добавлено 2 · пропущено 0»', async () => {
    let guests: unknown[] = [MARK]
    const calls = serve(base({
      '/weddings/w1/guests': () => guests,
      [IMPORT]: () => { guests = [...guests, ...created('Анна Петрова', 'Ольга и Сергей')]; return { created: created('Анна Петрова', 'Ольга и Сергей'), skipped: [] } },
    }))
    const r = openGuests()
    const area = await openPanel(r, 'Марк')
    fireEvent.change(area, { target: { value: 'Анна Петрова, +79170001111, +1\nМарк\nОльга и Сергей' } })
    expect(text(r)).toContain('Анна Петрова · +79170001111 · с +1')
    expect(text(r)).toContain('уже в списке')
    expect(text(r), 'итог до ответа сервера').not.toContain('Добавлено')
    const btn = button('Добавить 2 гостей')
    expect(btn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(posts(calls, IMPORT).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, IMPORT)[0]!.body).toEqual({ guests: [
      { name: 'Анна Петрова', phone: '+79170001111', plusOne: true },
      { name: 'Ольга и Сергей' },
    ] })
    await waitFor(() => expect(text(r)).toContain('Добавлено 2 · пропущено 0'), { timeout: 4000 })
    await waitFor(() => expect(gets(calls, '/weddings/w1/guests').length).toBe(2), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Ольга и Сергей'), { timeout: 4000 })
    expect(posts(calls, IMPORT).length, 'второй импорт').toBe(1)
  })

  it('итог — из ответа сервера, не из предпросмотра: сервер пропустил двоих → «Добавлено 1 · пропущено 2», причины словами', async () => {
    const calls = serve(base({
      '/weddings/w1/guests': [],
      [IMPORT]: { created: created('Анна'), skipped: [{ index: 1, name: 'Денис', reason: 'duplicate' }, { index: 2, name: 'Ира', reason: 'invalid' }] },
    }))
    const r = openGuests()
    const area = await openPanel(r, 'Список пуст')
    fireEvent.change(area, { target: { value: 'Анна\nДенис\nИра, 8 917 000-11-22' } })
    fireEvent.click(button('Добавить 3 гостей'))
    await waitFor(() => expect(posts(calls, IMPORT).length).toBe(1), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Добавлено 1 · пропущено 2'), { timeout: 4000 })
    expect(text(r)).toContain('Денис — уже в списке')
    expect(text(r)).toContain('Ира — телефон не распознан')
  })

  it('строки с ошибками и дубликаты помечены и не уходят; N считает только чистые; при N = 0 кнопка закрыта', async () => {
    const calls = serve(base({ '/weddings/w1/guests': [MARK], [IMPORT]: { created: created('Ольга'), skipped: [] } }))
    const r = openGuests()
    const area = await openPanel(r, 'Марк')
    fireEvent.change(area, { target: { value: 'А\nАнна, 12345\nМарк' } })
    expect(text(r)).toContain('нет имени')
    expect(text(r)).toContain('телефон не распознан')
    expect(text(r)).toContain('уже в списке')
    expect(button('Добавить 0 гостей').hasAttribute('disabled'), 'кнопка открыта без единой чистой строки').toBe(true)
    fireEvent.change(area, { target: { value: 'А\nАнна, 12345\nМарк\nОльга' } })
    const btn = button('Добавить 1 гостя')
    expect(btn.hasAttribute('disabled')).toBe(false)
    fireEvent.click(btn)
    await waitFor(() => expect(posts(calls, IMPORT).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, IMPORT)[0]!.body, 'ушли строки с ошибками или дубликат').toEqual({ guests: [{ name: 'Ольга' }] })
  })

  it('кнопка закрыта на время запроса; отказ сервера — его текст role=alert, панель остаётся, итога нет', async () => {
    const g = gate()
    const calls = serve(base({ '/weddings/w1/guests': [], [IMPORT]: g.reply }))
    const r = openGuests()
    const area = await openPanel(r, 'Список пуст')
    fireEvent.change(area, { target: { value: 'Анна' } })
    fireEvent.click(button('Добавить 1 гостя'))
    await waitFor(() => expect(posts(calls, IMPORT).length).toBe(1), { timeout: 4000 })
    expect(button(/Добавляем|Добавить 1 гостя/).hasAttribute('disabled'), 'кнопка открыта, пока запрос в пути').toBe(true)
    g.release(withStatus(422, 'validation_failed', 'Запрос не прошёл проверку'))
    await waitFor(() => expect(alerts()).toContain('Запрос не прошёл проверку'), { timeout: 4000 })
    expect(screen.getByLabelText('Список гостей')).toBeTruthy()
    expect(text(r), 'итог без ответа 201').not.toContain('Добавлено')
  })

  it('без свадьбы — «Сначала создайте свадьбу — гости живут в ней», запроса нет', async () => {
    signedIn()
    const calls = serve({ '/weddings': [], '/me/favorites': [], '/users/me': ME })
    const r = openGuests()
    await waitFor(() => expect(text(r)).toContain('Список пуст'), { timeout: 4000 })
    fireEvent.click(screen.getByLabelText('Добавить списком'))
    fireEvent.change(screen.getByLabelText('Список гостей'), { target: { value: 'Анна' } })
    fireEvent.click(button('Добавить 1 гостя'))
    await settle()
    expect(text(r)).toContain('Сначала создайте свадьбу — гости живут в ней')
    expect(calls.filter(c => c.method === 'POST').length).toBe(0)
  })
})

/* ── T2: категория с пустой выдачей — заявка консьержу ───────────────────── */

describe('T2: пустая выдача → «Оставить заявку консьержу» → POST /catalog/concierge; 409 словами сервера; только вошедшему', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const CONCIERGE = '/catalog/concierge'
  const CATS = [{ id: 'photo', title: 'Фотограф', icon: '📷' }]
  const EMPTY = { items: [], nextCursor: null }
  const catalog = (over: Routes = {}) => base({ '/catalog/categories': CATS, '/catalog/vendors': EMPTY, ...over })
  const openList = () => renderAt('/search/photo', <Route path="/search/:catId" element={<VendorList />} />)
  const ASK = 'Оставить заявку консьержу'

  it('форма: 50000 ₽ → Money в копейках, комментарий → «Отправить» → POST; после — «Заявка принята — свяжемся в течение суток», формы и кнопки нет', async () => {
    const calls = serve(catalog({ [CONCIERGE]: { __status: 201, body: null, headers: {} } }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Под фильтр никто не подходит'), { timeout: 4000 })
    fireEvent.click(screen.getByText(ASK))
    fireEvent.change(screen.getByLabelText('Бюджет, ₽'), { target: { value: '50000' } })
    fireEvent.change(screen.getByLabelText('Комментарий'), { target: { value: 'Хочется репортаж, без постановки' } })
    fireEvent.click(button('Отправить'))
    await waitFor(() => expect(posts(calls, CONCIERGE).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, CONCIERGE)[0]!.body).toEqual({
      categoryId: 'photo',
      budget: { amount: 5_000_000, currency: 'RUB' },
      comment: 'Хочется репортаж, без постановки',
      city: 'Уфа',
    })
    await waitFor(() => expect(text(r)).toContain('Заявка принята — свяжемся в течение суток'), { timeout: 4000 })
    expect(screen.queryByText(ASK), 'кнопка после принятой заявки').toBeNull()
    expect(screen.queryByLabelText('Бюджет, ₽'), 'форма после принятой заявки').toBeNull()
    expect(posts(calls, CONCIERGE).length).toBe(1)
  })

  it('без бюджета и комментария — тело только с категорией и городом; кнопка закрыта на время запроса', async () => {
    const g = gate()
    const calls = serve(catalog({ [CONCIERGE]: g.reply }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain(ASK), { timeout: 4000 })
    fireEvent.click(screen.getByText(ASK))
    fireEvent.click(button('Отправить'))
    await waitFor(() => expect(posts(calls, CONCIERGE).length).toBe(1), { timeout: 4000 })
    expect(posts(calls, CONCIERGE)[0]!.body).toEqual({ categoryId: 'photo', city: 'Уфа' })
    expect(button(/Отправляем|Отправить/).hasAttribute('disabled'), 'кнопка открыта, пока запрос в пути').toBe(true)
    g.release({ __status: 201, body: null, headers: {} })
    await waitFor(() => expect(text(r)).toContain('Заявка принята'), { timeout: 4000 })
  })

  it('409 concierge_pending — текст сервера role=alert, форма остаётся, «принята» не говорим', async () => {
    serve(catalog({ [CONCIERGE]: withStatus(409, 'concierge_pending', 'Заявка по этой категории уже в работе — мы свяжемся в течение суток') }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain(ASK), { timeout: 4000 })
    fireEvent.click(screen.getByText(ASK))
    fireEvent.click(button('Отправить'))
    await waitFor(() => expect(alerts()).toContain('Заявка по этой категории уже в работе'), { timeout: 4000 })
    expect(screen.getByLabelText('Комментарий')).toBeTruthy()
    expect(text(r)).not.toContain('Заявка принята')
  })

  it('без входа кнопки нет; при непустой выдаче нет; при отказе сервера нет (контроль — зелёный и до фикса)', async () => {
    localStorage.clear(); localStorage.setItem('tt_onboarded', '1')
    serve(catalog({ '/weddings': [] }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Под фильтр никто не подходит'), { timeout: 4000 })
    expect(screen.queryByText(ASK), 'консьерж без входа').toBeNull()
    cleanup(); vi.unstubAllGlobals()
    couple()
    serve(catalog({ '/catalog/vendors': { items: [{ id: 'v1', name: 'Фото «Кадр»', categoryId: 'photo', city: 'Уфа', rating: null, reviewsCount: 0 }], nextCursor: null } }))
    const r2 = openList()
    await waitFor(() => expect(text(r2)).toContain('Фото «Кадр»'), { timeout: 4000 })
    expect(screen.queryByText(ASK), 'консьерж при живой выдаче').toBeNull()
    cleanup(); vi.unstubAllGlobals()
    serve(catalog({ '/catalog/vendors': DOWN }))
    const r3 = openList()
    await waitFor(() => expect(text(r3)).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(screen.queryByText(ASK), 'консьерж вместо ответа сервера').toBeNull()
  })
})

/* ── T3: чек-лист — деталь задачи ────────────────────────────────────────── */

describe('T3: тап по задаче раскрывает срок и период; «Переименовать» → PATCH title, «Удалить» → DELETE; галочка — как была', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const SYS = { id: 't1', title: 'Выбрать площадку', period: '9', done: false, custom: false, due: '2026-09-14' }
  const OWN = { id: 't2', title: 'Заказать торт', period: '9', done: false, custom: true, due: null }
  const T1 = '/weddings/w1/tasks/t1'
  const T2 = '/weddings/w1/tasks/t2'
  const openList = () => renderAt('/wedding/checklist', <Route path="/wedding/checklist" element={<Checklist />} />)
  /* Строка задачи — кнопка, чьё имя начинается с названия: карточка «Следующий
     шаг →» показывает то же название, и getByText нашёл бы два элемента. */
  const row = (title: string) => screen.getByRole('button', { name: new RegExp('^' + title) })

  it('тап по названию раскрывает строку: «Срок: 14 сентября 2026 г. · За 9 мес», запроса нет; галочка → PATCH { done: true }', async () => {
    const calls = serve(base({ '/weddings/w1/tasks': [SYS, OWN], [T1]: { ...SYS, done: true } }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Выбрать площадку'), { timeout: 4000 })
    expect(text(r), 'срок раскрыт до тапа').not.toContain('Срок:')
    fireEvent.click(row('Выбрать площадку'))
    expect(text(r)).toContain('Срок: 14 сентября 2026 г. · За 9 мес')
    await settle()
    expect(patches(calls, T1).length, 'тап по названию отметил задачу').toBe(0)
    fireEvent.click(screen.getAllByLabelText('Отметить выполненной')[0]!)
    await waitFor(() => expect(patches(calls, T1).length).toBe(1), { timeout: 4000 })
    expect(patches(calls, T1)[0]!.body).toEqual({ done: true })
  })

  it('у задачи без срока — «дата свадьбы не задана» словами, не пустота', async () => {
    serve(base({ '/weddings/w1/tasks': [OWN] }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Заказать торт'), { timeout: 4000 })
    fireEvent.click(row('Заказать торт'))
    expect(text(r)).toContain('Срок: дата свадьбы не задана')
  })

  it('«Переименовать» → поле с текущим названием → «Сохранить» → PATCH { title } → список перечитан', async () => {
    let reads = 0
    const calls = serve(base({ '/weddings/w1/tasks': () => { reads++; return [SYS] }, [T1]: { ...SYS, title: 'Выбрать площадку и дату' } }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Выбрать площадку'), { timeout: 4000 })
    fireEvent.click(row('Выбрать площадку'))
    fireEvent.click(screen.getByText('Переименовать'))
    const field = screen.getByLabelText('Название задачи') as HTMLInputElement
    expect(field.value).toBe('Выбрать площадку')
    fireEvent.change(field, { target: { value: 'Выбрать площадку и дату' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(patches(calls, T1).length).toBe(1), { timeout: 4000 })
    expect(patches(calls, T1)[0]!.body).toEqual({ title: 'Выбрать площадку и дату' })
    await waitFor(() => expect(reads).toBe(2), { timeout: 4000 })
  })

  it('«Удалить» → «Удалить?» → DELETE → список перечитан; до подтверждения запроса нет; у шаблонной задачи «Удалить» нет', async () => {
    let reads = 0
    const calls = serve(base({ '/weddings/w1/tasks': () => { reads++; return [SYS, OWN] }, [T2]: { __status: 204, body: null, headers: {} } }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Заказать торт'), { timeout: 4000 })
    fireEvent.click(row('Выбрать площадку'))
    expect(screen.queryByText('Удалить'), '«Удалить» у шаблонной задачи — сервер отвечает 409').toBeNull()
    expect(screen.getByText('Переименовать')).toBeTruthy()
    fireEvent.click(row('Заказать торт'))
    fireEvent.click(screen.getByText('Удалить'))
    await settle()
    expect(deletes(calls, T2).length, 'удалено без подтверждения').toBe(0)
    fireEvent.click(screen.getByText('Удалить?'))
    await waitFor(() => expect(deletes(calls, T2).length).toBe(1), { timeout: 4000 })
    await waitFor(() => expect(reads).toBe(2), { timeout: 4000 })
  })

  it('отказ сервера на переименовании — его текст role=alert под строкой, поле остаётся', async () => {
    serve(base({ '/weddings/w1/tasks': [SYS], [T1]: withStatus(422, 'validation_failed', 'Название слишком длинное') }))
    const r = openList()
    await waitFor(() => expect(text(r)).toContain('Выбрать площадку'), { timeout: 4000 })
    fireEvent.click(row('Выбрать площадку'))
    fireEvent.click(screen.getByText('Переименовать'))
    fireEvent.change(screen.getByLabelText('Название задачи'), { target: { value: 'Длинное' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(alerts()).toContain('Название слишком длинное'), { timeout: 4000 })
    expect(screen.getByLabelText('Название задачи')).toBeTruthy()
  })
})
