// @vitest-environment jsdom
/*
 * FL-8 · ERR-0278 / R-278 (review-016) — «нет id свадьбы» читалось как факт о
 * человеке: «После свадьбы» и «План Б» показывали нули и живую кнопку без
 * свадьбы, «Наша команда» звала вышедшего заводить свадьбу, уведомления
 * выводили роль подрядчика из `!weddingId`.
 *
 *  T1 «После свадьбы» без свадьбы — NO_WEDDING, без «0 гостей» и «0 кадров».
 *  T2 «План Б» без свадьбы, строка «Дождь…» раскрыта — без «0%», без живой
 *     «Активировать»; T2-control — то же со свадьбой и `activatedAt: null` —
 *     раскрытая строка «Активировать» показывает (fix round 1: T2 раньше не
 *     раскрывала строку и была зелёной независимо от гейта, см. FL-8.md §1
 *     «Fix round 1» / G5-S2, G6-S3-2).
 *  T3 День X без свадьбы — «red test decides» (см. FL-8.md §1).
 *  T4 «Наша команда» без входа — «Войдите», не «Сначала создайте свадьбу».
 *  T5 подрядчик со свадьбой — уведомление о сделке ведёт в кабинет подрядчика.
 *  T6 пара без свадьбы (ещё не пришли /weddings, проба анкеты — 404) —
 *     уведомление чата ведёт к паре.
 *  T7 подрядчик со свадьбой, проба анкеты ещё не ответила — клик не уводит
 *     на `/deal/{id}` пары раньше времени; ответ приходит — клик ведёт в
 *     кабинет (fix round 1: G5-S3-1 / G6-S3-1, `Account.tsx:442-443,516`).
 *  T8 проба анкеты отвечает 500, не 404 — клик никуда не ведёт: неизвестность
 *     не читается как «не подрядчик» (fix round 1, `Account.tsx:450` — CT-0
 *     на округлой цифре T5/T6/T7 не задела `throw e`, добавлен отдельно).
 *
 * T5/T6 кликают внутри `waitFor`, а не один раз сразу после рендера:
 * `vendorProbe` — отдельный запрос от списка уведомлений, и его ответ может
 * осесть позже кадра, где на экране уже видно «Сделка»/«Чат»; повторный клик
 * внутри `waitFor` безопасен — `markRead` идемпотентен, а `nav()` на тот же
 * адрес — тоже. T7 первую (отрицательную) проверку кликает один раз и ждёт
 * фиксированную паузу без повторного клика (см. комментарий у T7): react-
 * router переносит переход в `startTransition`, и он не виден в DOM сразу
 * после `fireEvent.click` ни с гейтом, ни без него — проверка сразу после
 * клика была бы пустой в обе стороны, а не только когда гейт держит.
 *
 * Харнесс `serve`/`open` — из audit48/audit49e; `serve` расширен (fix round 1)
 * — значение маршрута может быть функцией, возвращающей `Promise` (T7 держит
 * `/vendor/profile` подвешенным до явного `resolve`), старые записи (значение
 * или синхронная функция) читаются как раньше. `LocationProbe` (T5/T6/T7)
 * читает реальный маршрут после клика внутри того же `MemoryRouter`, где
 * живёт `<App/>`: конечные экраны уведомления (`/deal/:id`, `/us/chats/:id`,
 * `/vendor-app/chats/:id`, `/vendor-app/deals`) рисуют почти одинаковый
 * «не найдено»/«недоступен» текст без реальных данных — проверка по строке
 * с экрана была бы случайным совпадением, а не доказательством маршрута.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, it, expect, afterEach, vi } from 'vitest'
import App from '@/App'
import { t } from '@/lib/i18n'
import { NO_WEDDING } from '@/lib/api/useApi'

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

function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const toResponse = (reply: unknown) => isStatus(reply) ? json(reply.body, reply.__status) : json(reply)
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
    /* T7 (fix round 1) держит `/vendor/profile` в ожидании: маршрут отдаёт
       функцию, которая возвращает ещё не осевший `Promise` — раньше `reply`
       здесь мог быть только готовым значением. `Promise.resolve` пропускает
       обычное значение как есть и ждёт настоящий `Promise`, не меняя
       поведение T1–T6. */
    return Promise.resolve(reply).then(toResponse)
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

/** Невидимый зонд текущего маршрута: тот же `MemoryRouter`, что у `<App/>`. */
function LocationProbe() {
  const loc = useLocation()
  return <div data-testid="loc">{loc.pathname}</div>
}
const loc = (r: { container: HTMLElement }) => r.container.querySelector('[data-testid="loc"]')?.textContent ?? ''

async function open(route: string, settled: string, probe = false) {
  const r = render(
    <MemoryRouter initialEntries={[route]}>
      <App />
      {probe && <LocationProbe />}
    </MemoryRouter>,
  )
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

/* Вошедший без свадьбы: `tt_wedding_id` не пишем — стор дочитает пустой
   список `/weddings` и останется без свадьбы (а не «ещё грузится»). */
const signedInNoWedding = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

const VENDOR_PROFILE = {
  id: 'v1', name: 'Студия «Пион»', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
  priceFrom: { amount: 4_000_000, currency: 'RUB' }, rating: null, reviewsCount: 0, packages: [],
}

describe('FL-8 · ERR-0278 / R-278: отсутствие свадьбы — не факт о человеке', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('T1: «После свадьбы» без свадьбы — NO_WEDDING, без «0 гостей»/«0 кадров»', async () => {
    signedInNoWedding()
    serve({ '/weddings': [], '/chats': [] })
    const r = await open('/after', t('После свадьбы'))
    await waitFor(() => expect(text(r)).toContain(t(NO_WEDDING)), { timeout: 4000 })
    const statsGrid = r.container.querySelector('.grid.grid-cols-2')
    expect(statsGrid?.textContent ?? '').not.toMatch(/\d/)
  })

  it('T2: «План Б» без свадьбы, строка «Дождь…» раскрыта — без «0%», без живой «Активировать»', async () => {
    signedInNoWedding()
    serve({ '/weddings': [], '/chats': [] })
    const r = await open('/wedding/planb', t('План Б'))
    await waitFor(() => expect(text(r)).toContain(t(NO_WEDDING)), { timeout: 4000 })
    expect(text(r)).not.toContain('0%')
    /* Кнопка стоит внутри `open === i` (Smart.tsx:867) — строку нужно
       раскрыть, иначе `queryByText` не находит её ни при каком коде (fix
       round 1, G5-S2 / G6-S3-2: без этого клика T2 была зелёной и с
       выключенным гейтом `ready(q)` на Smart.tsx:876, и без него). */
    fireEvent.click(screen.getByText(t('Дождь или непогода на выездной церемонии')))
    expect(screen.queryByText('Активировать', { exact: false })).toBeNull()
  })

  it('T2-control: «План Б» со свадьбой, activatedAt: null, строка раскрыта — «Активировать» показана', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    serve({
      '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', role: 'couple' }],
      '/weddings/w1/planb': { checklist: [], activatedAt: null },
      '/chats': [],
    })
    const r = await open('/wedding/planb', t('План Б'))
    expect(text(r)).not.toContain(t(NO_WEDDING))
    /* Контроль T2: тот же клик той же строки, но с данными сервера — гейт
       `ready(q)` пропускает кнопку. Без этой пары T2 могла бы стать зелёной
       и от постоянно скрытой кнопки (fix round 1, G5-S2 / G6-S3-2). */
    fireEvent.click(screen.getByText(t('Дождь или непогода на выездной церемонии')))
    expect(screen.queryByText('Активировать', { exact: false })).not.toBeNull()
  })

  it('T3: День X без свадьбы — красный на HEAD, решает результат прогона', async () => {
    signedInNoWedding()
    serve({ '/weddings': [], '/chats': [] })
    const r = await open('/dayx', t('День X'))
    await waitFor(() => expect(text(r)).toContain(t(NO_WEDDING)), { timeout: 4000 })
    expect(text(r)).not.toContain(t('Тайминг пуст'))
  })

  it('T4: «Наша команда» без входа — «Войдите», не «Сначала создайте свадьбу»', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    serve({})
    const r = await open('/us/team', t('Наша команда'), true)
    expect(text(r)).toContain(t('Войдите, чтобы собрать команду'))
    expect(text(r)).not.toContain('Сначала создайте свадьбу')
    fireEvent.click(screen.getByRole('button', { name: t('Войти') }))
    await waitFor(() => expect(loc(r)).toBe('/auth'), { timeout: 4000 })
  })

  it('T5: подрядчик со свадьбой — уведомление о сделке ведёт в кабинет подрядчика, не паре', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    serve({
      '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', role: 'couple' }],
      '/vendor/profile': VENDOR_PROFILE,
      '/notifications': [{ id: 'n1', kind: 'deal', link: '/deal/d1', title: 'Сделка', body: 'Новый статус', createdAt: new Date().toISOString(), read: false }],
      '/chats': [],
    })
    const r = await open('/notifications', 'Сделка', true)
    /* Клик внутри `waitFor` (fix round 1, G5-S3-1): `/vendor/profile` — свой
       запрос, независимый от списка уведомлений, и по контракту (fix round 1)
       маршрут не строится, пока `ready(vendorProbe)` не станет true —
       единичный клик сразу после рендера мог обогнать пробу. Повтор клика
       безопасен — `markRead` идемпотентен. */
    await waitFor(() => {
      fireEvent.click(screen.getByText('Сделка'))
      expect(loc(r)).toBe('/vendor-app/deals')
    }, { timeout: 4000 })
  })

  it('T6: пара без свадьбы (ещё не пришли /weddings, проба анкеты — 404) — уведомление чата ведёт к паре, не в кабинет', async () => {
    signedInNoWedding()
    serve({
      /* «/weddings ещё не пришли» — здесь конкретно нет ответа `/weddings`
         (роут не задан, `serve` отвечает 404 не из routes-таблицы, а из
         собственного fallback) и `/vendor/profile` отвечает настоящим 404:
         оба случая одинаково оставляют `weddingId` не выставленным —
         переменную, которую и проверяет T6 (fix round 1, G5-S4-1 item 4 —
         комментарий раньше преувеличивал: «ещё не пришли» читалось как
         «зависли», а не «ответили конкретно 404»). */
      '/vendor/profile': withStatus(404, 'not_found', 'Анкета ещё не создана'),
      '/notifications': [{ id: 'n2', kind: 'chat', link: '/chats/c1', title: 'Чат', body: 'Новое сообщение', createdAt: new Date().toISOString(), read: false }],
      '/chats': [],
    })
    const r = await open('/notifications', 'Чат', true)
    await waitFor(() => {
      fireEvent.click(screen.getByText('Чат'))
      expect(loc(r)).toBe('/us/chats/c1')
    }, { timeout: 4000 })
  })

  it('T7: подрядчик со свадьбой, проба анкеты ещё не ответила — клик не ведёт на /deal раньше времени', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    let resolveProbe: (v: unknown) => void = () => undefined
    const pending = new Promise<unknown>(res => { resolveProbe = res })
    serve({
      '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', role: 'couple' }],
      '/vendor/profile': () => pending,
      '/notifications': [{ id: 'n3', kind: 'deal', link: '/deal/d2', title: 'Сделка', body: 'Новый статус', createdAt: new Date().toISOString(), read: false }],
      '/chats': [],
    })
    const r = await open('/notifications', 'Сделка', true)
    fireEvent.click(screen.getByText('Сделка'))
    /* `navigate()` react-router кладёт в `startTransition` — сразу после
       клика переход ещё не виден в DOM (эмпирически ~100–120 мс) даже без
       гейта, так что проверка сразу после `fireEvent.click` (без паузы)
       была бы пустой: она всегда застаёт старый маршрут, гейт стоит или
       нет. Пауза — не гонка: `pending` сам по себе никогда не осядет
       (осядет только по явному `resolveProbe` ниже), поэтому «не
       изменилось и через 600 мс» доказывает именно отсутствие перехода, а
       не то, что не хватило времени (fix round 1, G5-S3-1 / G6-S3-1: без
       гейта `ready(vendorProbe)` этот прогон показывает `/deal/d2` уже к
       120 мс — проверено правкой на месте перед тем, как писать тест). */
    await new Promise(res => setTimeout(res, 600))
    expect(loc(r)).toBe('/notifications')
    resolveProbe(VENDOR_PROFILE)
    await waitFor(() => {
      fireEvent.click(screen.getByText('Сделка'))
      expect(loc(r)).toBe('/vendor-app/deals')
    }, { timeout: 4000 })
  })

  it('T8: проба анкеты отвечает 500, не 404 — роль остаётся неизвестной, клик никуда не ведёт', async () => {
    /* TR-1 §7 FL-8 (c): только 404 читается как «не подрядчик». Раньше
       единый `.catch(() => null)` превращал в «не подрядчик» и 500/403/
       сеть — теперь их пропускает `throw e` (fix round 1, Account.tsx:450),
       и `ready(vendorProbe)` держит клик, а не подставляет ответ пары
       по умолчанию: неизвестность — не то же самое, что «не подрядчик». */
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    serve({
      '/weddings': [{ id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', role: 'couple' }],
      '/vendor/profile': withStatus(500, 'internal', 'Сервер недоступен'),
      '/notifications': [{ id: 'n4', kind: 'deal', link: '/deal/d3', title: 'Сделка', body: 'Новый статус', createdAt: new Date().toISOString(), read: false }],
      '/chats': [],
    })
    const r = await open('/notifications', 'Сделка', true)
    fireEvent.click(screen.getByText('Сделка'))
    await new Promise(res => setTimeout(res, 600))
    expect(loc(r)).toBe('/notifications')
  })
})
