// @vitest-environment jsdom
/*
 * Ревью старого кода, домены Д4/Д5 (каталог, карточка подрядчика, сравнение,
 * день X, план Б, «после свадьбы», кабинет подрядчика, калькулятор, вдохновение).
 *
 * Классы дыр, ради которых написан файл:
 *  — «null» буквами: сервер прячет рейтинг до третьего отзыва, а экраны
 *    ветвились по числу отзывов и печатали «★ null (2)» (D5-02);
 *  — первая страница выдаётся за весь каталог: «30 рядом» при 2008 анкетах,
 *    «рекомендованные» при sort=rating, дочитать нельзя (D5-05, D5-26а);
 *  — кнопка, которая молча не делает ничего: «Написать» без catch (D5-15);
 *  — суммы в сто раз меньше: рубли напечатаны как копейки (D5-06, D5-07);
 *  — тексты-обещания: «гости получили новую точку сбора», «тайминг пересобран»,
 *    «у водителя в приложении», «отзывы — только от пар», «по Тилю» (D4-07,
 *    D5-18, D5-24);
 *  — экран, который не обновляется: день X со снятым один раз «сейчас» (D4-13);
 *  — форма, которую сервер отвергнет: отзыв вне окна 14 дней (D4-26);
 *  — своё среднее вместо серверного рейтинга в кабинете (D5-17); подписи денег
 *    кабинета под новую семантику сервера (D5-08); hex вместо токенов и
 *    компонент внутри компонента (D5-27, D4-22).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { projectFile } from '@/test/projectFiles'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')

/** Ответ со своим кодом: отказ по правам, лимит частоты и прочие честные не-200. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } } })

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/*
 * Сеть по таблице плюс журнал вызовов (приём из `audit25.test.tsx`): ключ —
 * путь без `/api` и без строки запроса. Ответ может быть функцией от вызова —
 * так вторая страница отличается от первой по `cursor=` в адресе.
 */
function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = full.split('?')[0] ?? ''
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    calls.push({ method: init?.method ?? 'GET', path, url: full, body })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    const stored = routes[path]
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(calls[calls.length - 1]!) : stored
    if (reply === DOWN) return Promise.reject(new TypeError('Failed to fetch'))
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

/** Intl разделяет разряды неразрывным пробелом — приводим к обычному. */
const NARROW = String.fromCharCode(160, 8239)
const plain = (s: string) => s.replace(new RegExp('[' + NARROW + ']', 'g'), ' ')

/** Пара с одной свадьбой: вошли, свадьба и дата выбраны, онбординг пройден. */
const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-06-14'))
}

/** Подрядчик без свадьбы на устройстве: кабинет читает только свои пути. */
const vendorUser = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null }

const BASE: Routes = {
  '/weddings': [WEDDING],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/notifications': [],
  '/me/favorites': [],
  '/users/me': ME,
}

const CATS = [{ id: 'photo', title: 'Фотограф', icon: '📷' }]

const vendor = (over: Record<string, unknown> = {}) => ({
  id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false, hasVideo: false,
  priceFrom: { amount: 5_000_000, currency: 'RUB' }, rating: null as number | null, reviewsCount: 0,
  ...over,
})

const DETAIL = {
  ...vendor(), about: 'Снимаем свадьбы', phone: null,
  gallery: [], packages: [{ name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' }, includes: [] }],
}

/** Всё, что читает карточка подрядчика `v1`. */
const detailRoutes = (detail: Record<string, unknown> = DETAIL): Routes => ({
  ...BASE,
  '/catalog/categories': CATS,
  '/catalog/vendors/v1': detail,
  '/catalog/vendors/v1/availability': { busyDates: [] },
  '/catalog/vendors/v1/reviews': { items: [] },
  '/catalog/vendors': { items: [] },
})

/* ── D5-02. Рейтинг спрятан до третьего отзыва — на экране не «null» ────── */

describe('рейтинг null при отзывах: слова, а не «null»', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('карточка в выдаче: «2 отзыва · оценка с третьего»', async () => {
    serve({ ...BASE, '/catalog/categories': CATS, '/catalog/vendors': { items: [vendor({ rating: null, reviewsCount: 2 })] } })
    const r = await open('/search/photo', 'Фотостудия Свет')
    const text = r.container.textContent ?? ''
    expect(text).not.toMatch(/null/)
    expect(text).toContain('2 отзыва · оценка с третьего')
    expect(text).not.toContain('Новый на платформе')
  })

  it('карточка в выдаче: рейтинг пришёл — звезда и число (контроль)', async () => {
    serve({ ...BASE, '/catalog/categories': CATS, '/catalog/vendors': { items: [vendor({ rating: 4.9, reviewsCount: 47 })] } })
    const r = await open('/search/photo', 'Фотостудия Свет')
    expect(r.container.textContent ?? '').toContain('★ 4.9 (47)')
  })

  it('анкета: «2 отзыва · оценка с третьего», без пустой звезды', async () => {
    serve(detailRoutes({ ...DETAIL, rating: null, reviewsCount: 2 }))
    const r = await open('/vendor/v1', 'Снимаем свадьбы')
    const text = r.container.textContent ?? ''
    expect(text).not.toMatch(/null/)
    expect(text).toContain('2 отзыва · оценка с третьего')
    expect(text).not.toContain('★  ·')
  })

  it('анкета: 21 отзыв склоняется (контроль)', async () => {
    serve(detailRoutes({ ...DETAIL, rating: 4.7, reviewsCount: 21 }))
    const r = await open('/vendor/v1', 'Снимаем свадьбы')
    expect(r.container.textContent ?? '').toContain('★ 4.7 · 21 отзыв')
    expect(r.container.textContent ?? '').not.toContain('21 отзывов')
  })

  it('сравнение: клетка рейтинга без «null»', async () => {
    const second = vendor({ id: 'v2', name: 'Второй фотограф', rating: 4.8, reviewsCount: 5 })
    serve({
      ...BASE,
      '/me/favorites': [vendor({ rating: null, reviewsCount: 2 }), second],
      '/catalog/categories': CATS,
      '/catalog/vendors/v1': { ...DETAIL, rating: null, reviewsCount: 2 },
      '/catalog/vendors/v2': { ...DETAIL, ...second, packages: [] },
    })
    const r = await open('/compare?cat=photo', 'Выберите двух или трёх подрядчиков из избранного')
    fireEvent.click(screen.getByLabelText('Фотостудия Свет'))
    fireEvent.click(screen.getByLabelText('Второй фотограф'))
    await waitFor(() => expect(screen.getAllByText('Фотостудия Свет').length).toBe(2))
    const text = r.container.textContent ?? ''
    expect(text).not.toMatch(/null/)
    expect(text).toContain('2 отзыва')
  })
})

/* ── D5-05. Список категории дочитывается по курсору, подзаголовок честный ── */

const page = (n: number, from: number) =>
  Array.from({ length: n }, (_, i) => vendor({ id: `v${from + i}`, name: `Анкета ${from + i}` }))

describe('список категории: «Показать ещё» по курсору', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const paged = (c: Call) => c.url.includes('cursor=c2')
    ? { items: page(5, 31), nextCursor: null }
    : { items: page(30, 1), nextCursor: 'c2' }

  it('первая страница не выдаётся за весь каталог; кнопка дочитывает по nextCursor', async () => {
    const calls = serve({ ...BASE, '/catalog/categories': CATS, '/catalog/vendors': paged })
    const r = await open('/search/photo', 'Анкета 30')
    let text = r.container.textContent ?? ''
    expect(text).not.toContain('30 рядом')
    expect(text).not.toContain('рекомендованные')
    expect(text).toContain('первые 30')
    /* Подпись сортировки — по фактическому параметру запроса. */
    expect(text).toContain('сортировка: по рейтингу')
    expect(calls.some(c => c.path === '/catalog/vendors' && c.url.includes('sort=rating'))).toBe(true)

    fireEvent.click(screen.getByText('Показать ещё'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Анкета 35'))
    expect(calls.some(c => c.path === '/catalog/vendors' && c.url.includes('cursor=c2'))).toBe(true)
    text = r.container.textContent ?? ''
    /* Все 35 на экране, курсора больше нет — теперь число честное. */
    expect(text).toContain('Анкета 1')
    expect(text).toContain('35 рядом')
    expect(screen.queryByText('Показать ещё')).toBeNull()
  })

  it('чип «до 100 тыс ₽» — сортировка подписана «сначала дешевле»', async () => {
    const calls = serve({ ...BASE, '/catalog/categories': CATS, '/catalog/vendors': paged })
    const r = await open('/search/photo', 'Анкета 30')
    fireEvent.click(screen.getByText('до 100 тыс ₽'))
    await waitFor(() => expect(calls.some(c => c.path === '/catalog/vendors' && c.url.includes('sort=price_asc'))).toBe(true))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('сортировка: сначала дешевле'))
    expect(r.container.textContent ?? '').not.toContain('рекомендованные')
  })

  it('без второй страницы — число рядом и никакой кнопки (контроль)', async () => {
    serve({ ...BASE, '/catalog/categories': CATS, '/catalog/vendors': { items: page(3, 1), nextCursor: null } })
    const r = await open('/search/photo', 'Анкета 3')
    expect(r.container.textContent ?? '').toContain('3 рядом')
    expect(screen.queryByText('Показать ещё')).toBeNull()
  })

  it('отказ на второй странице — словами под кнопкой, первая страница остаётся', async () => {
    serve({
      ...BASE, '/catalog/categories': CATS,
      '/catalog/vendors': (c: Call) => c.url.includes('cursor=') ? withStatus(429, 'rate_limited', 'Слишком часто — подождите минуту') : { items: page(30, 1), nextCursor: 'c2' },
    })
    const r = await open('/search/photo', 'Анкета 30')
    fireEvent.click(screen.getByText('Показать ещё'))
    expect(await screen.findByText('Слишком часто — подождите минуту')).toBeTruthy()
    expect(r.container.textContent ?? '').toContain('Анкета 30')
    expect(screen.getByText('Показать ещё')).toBeTruthy()
  })
})

/* ── D5-15, D5-18, D5-26а. Карточка подрядчика ───────────────────────────── */

describe('карточка подрядчика: «Написать» с ошибкой словами, отзывы по курсору, честная карточка проверки', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Написать»: отказ сервера показывается под кнопкой, а не глотается', async () => {
    serve({ ...detailRoutes(), '/chats/vendor/v1': withStatus(429, 'rate_limited', 'Слишком часто — подождите минуту') })
    await open('/vendor/v1', 'Снимаем свадьбы')
    fireEvent.click(screen.getByText('Написать'))
    expect(await screen.findByText('Слишком часто — подождите минуту')).toBeTruthy()
  })

  it('«Проверен» не обещает «отзывы только от пар» — гости тоже пишут', async () => {
    serve(detailRoutes({ ...DETAIL, verified: true }))
    const r = await open('/vendor/v1', 'Проверен «Тили-тили»')
    const text = r.container.textContent ?? ''
    expect(text).not.toContain('Отзывы — только от пар после реальной сделки')
    expect(text).toContain('Отзывы пар — только после сделки; отзывы гостей отмечены отдельно')
  })

  const review = (i: number) =>
    ({ id: `r${i}`, source: 'couple', authorName: `Пара ${i}`, rating: 5, text: 'Всё отлично', createdAt: '2026-05-01T10:00:00.000Z', reply: null })
  const reviewsPaged = (c: Call) => c.url.includes('cursor=r2')
    ? { items: [11, 12, 13].map(review), nextCursor: null }
    : { items: Array.from({ length: 10 }, (_, i) => review(i + 1)), nextCursor: 'r2' }

  it('«47 отзывов» не обрывается на десяти: «Показать ещё отзывы» дочитывает по курсору', async () => {
    const calls = serve({ ...detailRoutes({ ...DETAIL, rating: 4.9, reviewsCount: 13 }), '/catalog/vendors/v1/reviews': reviewsPaged })
    const r = await open('/vendor/v1', 'Пара 10')
    expect(r.container.textContent ?? '').not.toContain('Пара 13')
    fireEvent.click(screen.getByText('Показать ещё отзывы'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Пара 13'))
    expect(calls.some(c => c.path === '/catalog/vendors/v1/reviews' && c.url.includes('cursor=r2'))).toBe(true)
    expect(screen.queryByText('Показать ещё отзывы')).toBeNull()
  })
})

/* ── D5-19. Сравнение: только ручной выбор, без первых трёх и календаря ─── */

describe('сравнение по категории', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('категория фильтрует избранное, а таблица содержит ровно отмеченных', async () => {
    const first = vendor({ id: 'v1', name: 'Первый' })
    const second = vendor({ id: 'v2', name: 'Второй' })
    const third = vendor({ id: 'v3', name: 'Третий' })
    const calls = serve({
      ...BASE,
      '/me/favorites': [first, second, third],
      '/catalog/categories': CATS,
      '/catalog/vendors/v1': { ...DETAIL, ...first },
      '/catalog/vendors/v3': { ...DETAIL, ...third },
    })
    const r = await open('/compare?cat=photo', 'Выберите двух или трёх подрядчиков из избранного')
    expect(screen.queryAllByText('Открыть анкету')).toHaveLength(0)
    fireEvent.click(screen.getByLabelText('Третий'))
    fireEvent.click(screen.getByLabelText('Первый'))
    await waitFor(() => expect(screen.getAllByText('Открыть анкету')).toHaveLength(2))
    expect(screen.getAllByText('Первый')).toHaveLength(2)
    expect(screen.getAllByText('Второй')).toHaveLength(1)
    expect(screen.getAllByText('Третий')).toHaveLength(2)
    expect(r.container.textContent ?? '').not.toContain('первые 3 в выдаче')
    expect(calls.some(c => c.path.endsWith('/availability'))).toBe(false)
  })
})

/* ── D4-07. План Б — правда о том, что делает активация ───────────────────── */

const STRINGS = (src: string) => [...src.matchAll(/\bt\('((?:[^'\\]|\\.)*)'\)/g)].map(m => m[1]!)

describe('план Б говорит правду', () => {
  it('в строках Smart.tsx нет обещаний за код, которого нет', () => {
    const bad = ['пересобир', 'получили новую точку', 'получат новую точку', 'у водителя в приложении', 'Гости получают уведомление']
    const hits = STRINGS(projectFile('src/pages/Smart.tsx'))
      .flatMap(s => bad.filter(b => s.includes(b)).map(b => `«${b}» в «${s.slice(0, 60)}»`))
    expect(hits).toEqual([])
  })

  describe('экран после активации', () => {
    beforeEach(couple)
    afterEach(() => { cleanup(); vi.unstubAllGlobals() })

    it('сценарий зафиксирован, команда уведомлена — и ничего сверх этого', async () => {
      serve({ ...BASE, '/weddings/w1/planb': { checklist: [], activatedAt: '2027-06-14T08:00:00.000Z', scenario: 'rain' } })
      const r = await open('/wedding/planb', 'План «дождь» активирован')
      const text = r.container.textContent ?? ''
      expect(text).toContain('Сценарий зафиксирован, команде ушло уведомление')
      expect(text).not.toContain('пересобран')
      expect(text).not.toContain('гости получили')
    })
  })
})

/* ── D4-13. День X обновляется сам ───────────────────────────────────────── */

describe('день X: «сейчас» и тайминг перечитываются раз в минуту', () => {
  beforeEach(() => {
    couple()
    /* Таймеры и часы поддельные, но идут в реальном темпе: `waitFor` и ответы
       сети работают как обычно, а минуту можно перемотать одним вызовом. */
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2027-06-14T12:00:00.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('через 60 с блок «СЕЙЧАС» переходит к следующему событию, тайминг спрошен заново', async () => {
    const events = [
      { id: 'e1', name: 'Сборы', startsAt: '2027-06-14T11:00:00.000Z' },
      { id: 'e2', name: 'Церемония', startsAt: '2027-06-14T12:00:30.000Z' },
    ]
    const calls = serve({ ...BASE, '/weddings/w1/timeline': events, '/weddings/w1/planb': { checklist: [], activatedAt: null } })
    const setSpy = vi.spyOn(globalThis, 'setInterval')
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const r = await open('/dayx', 'Церемония')
    expect(r.container.textContent ?? '').toContain('СЕЙЧАССборы')
    const before = calls.filter(c => c.path === '/weddings/w1/timeline').length

    await act(async () => { vi.advanceTimersByTime(60_000) })

    await waitFor(() => expect(r.container.textContent ?? '').toContain('СЕЙЧАСЦеремония'))
    expect(calls.filter(c => c.path === '/weddings/w1/timeline').length).toBeGreaterThan(before)

    /* Ушли с экрана — минутный интервал снят: закрытый день X не должен жить
       в памяти и дёргать сервер до конца сессии. Ищем именно его — по шагу в
       минуту — и ждём, что при размонтировании снимут ровно этот номер. */
    const minute = setSpy.mock.calls.findIndex(c => c[1] === 60_000)
    expect(minute).toBeGreaterThanOrEqual(0)
    const id: unknown = setSpy.mock.results[minute]!.value
    cleanup()
    expect(clearSpy).toHaveBeenCalledWith(id)
    const after = calls.filter(c => c.path === '/weddings/w1/timeline').length
    await act(async () => { vi.advanceTimersByTime(120_000) })
    expect(calls.filter(c => c.path === '/weddings/w1/timeline').length).toBe(after)
    setSpy.mockRestore()
    clearSpy.mockRestore()
  })
})

/* ── D4-26. Отзыв пары — только в окне 14 дней от завершения сделки ──────── */

describe('после свадьбы: форма отзыва только в окне 14 дней', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const doneSlot = (doneAt: string | null) => [{
    id: 's2', categoryId: 'photo', label: 'Фотограф', tileState: 'paid',
    deal: { id: 'd1', state: 'done', vendor: { id: 'v1', name: 'Фотостудия Свет' }, price: { amount: 5_000_000, currency: 'RUB' }, doneAt },
  }]
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
  const afterRoutes = (doneAt: string | null): Routes => ({
    ...BASE, '/weddings/w1/slots': doneSlot(doneAt),
    '/weddings/w1/guests': [], '/weddings/w1/album': [], '/weddings/w1/guest-reviews': [],
  })

  it('сделка завершена 40 дней назад — формы нет, окно названо закрытым', async () => {
    serve(afterRoutes(daysAgo(40)))
    const r = await open('/after', 'Оставить отзывы команде')
    fireEvent.click(screen.getByText('Оставить отзывы команде'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Фотостудия Свет'))
    expect(r.container.textContent ?? '').toContain('Окно для отзыва закрылось')
    expect(screen.queryByText('Отправить отзыв')).toBeNull()
  })

  it('сделка завершена 3 дня назад — форма есть и срок назван (контроль)', async () => {
    serve(afterRoutes(daysAgo(3)))
    const r = await open('/after', 'Оставить отзывы команде')
    fireEvent.click(screen.getByText('Оставить отзывы команде'))
    await waitFor(() => expect(screen.getByText('Отправить отзыв')).toBeTruthy())
    expect(r.container.textContent ?? '').toContain('Отзыв принимается до')
    expect(r.container.textContent ?? '').not.toContain('Окно для отзыва закрылось')
  })

  it('дата завершения не пришла — форма открыта, а срок не выдумывается', async () => {
    serve(afterRoutes(null))
    const r = await open('/after', 'Оставить отзывы команде')
    fireEvent.click(screen.getByText('Оставить отзывы команде'))
    await waitFor(() => expect(screen.getByText('Отправить отзыв')).toBeTruthy())
    expect(r.container.textContent ?? '').not.toContain('Отзыв принимается до')
    expect(r.container.textContent ?? '').not.toContain('Окно для отзыва закрылось')
  })
})

/* ── D4-22, D5-27. Чистота рендера и токены ──────────────────────────────── */

describe('токены и чистота рендера', () => {
  it('Smart.tsx: цвета только токенами, без hex', () => {
    expect(projectFile('src/pages/Smart.tsx')).not.toMatch(/#[0-9A-Fa-f]{6}\b/)
  })

  it('Smart.tsx: new Date() без аргумента — только в useState или в обработчике интервала', () => {
    const src = projectFile('src/pages/Smart.tsx')
    const bad: string[] = []
    for (const m of src.matchAll(/new Date\(\)/g)) {
      const before = src.slice(Math.max(0, m.index! - 40), m.index)
      if (!/useState\(\(\) =>\s*$/.test(before) && !/setNow\(\s*$/.test(before)) bad.push(before.trim())
    }
    expect(bad).toEqual([])
  })

  it('плитки категорий — токены палитры, не hex', () => {
    expect(projectFile('src/lib/categoryTiles.ts')).not.toMatch(/#[0-9A-Fa-f]{6}/)
  })

  it('CityPicker: строка списка объявлена на уровне модуля', () => {
    expect(projectFile('src/components/CityPicker.tsx')).toMatch(/^(function|const) Row\b/m)
  })
})

/* ── D5-06, D5-24. Калькулятор алкоголя ──────────────────────────────────── */

describe('калькулятор алкоголя', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('ориентир по бюджету — рубли на гостя, не копейки: 80 гостей → 60 000 ₽', async () => {
    serve(BASE)
    const r = await open('/tools/alcohol', 'Ориентир по бюджету')
    const text = plain(r.container.textContent ?? '')
    expect(text).toContain('60 000 ₽')
    expect(text).not.toContain('600 ₽')
  })

  it('нормы не приписаны Тилю: у координатора нет модели', async () => {
    serve(BASE)
    const r = await open('/tools/alcohol', 'Ориентир по бюджету')
    const text = r.container.textContent ?? ''
    expect(text).not.toContain('Тилю')
    expect(text).not.toContain('Тиля')
  })
})

/* ── D5-07. Вдохновение: бюджеты историй в рублях ────────────────────────── */

describe('вдохновение', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('бюджеты историй — «950 000 ₽», а не «9 500 ₽»', async () => {
    serve({ ...BASE, '/inspiration/likes': { storyIds: [] } })
    const r = await open('/inspiration', 'Дина и Руслан')
    const text = plain(r.container.textContent ?? '')
    expect(text).toContain('950 000 ₽')
    expect(text).toContain('1 800 000 ₽')
    expect(text).not.toContain('9 500 ₽')
  })

  it('разбор бюджета делит настоящую сумму', async () => {
    serve({ ...BASE, '/inspiration/likes': { storyIds: [] } })
    await open('/inspiration', 'Дина и Руслан')
    fireEvent.click(screen.getAllByText('Разбор бюджета')[0]!)
    await waitFor(() => expect(plain(document.body.textContent ?? '')).toContain('42% · 399 000 ₽'))
  })

  it('фильтр «до 700 тыс» оставляет истории до 700 тысяч рублей', async () => {
    serve({ ...BASE, '/inspiration/likes': { storyIds: [] } })
    const r = await open('/inspiration', 'Дина и Руслан')
    fireEvent.click(screen.getByText('до 700 тыс'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Найдено историй:2'))
    expect(r.container.textContent ?? '').toContain('Алсу и Марат')
    expect(r.container.textContent ?? '').not.toContain('Дина и Руслан')
  })
})

/* ── D5-17, D5-08. Кабинет подрядчика ────────────────────────────────────── */

const PROFILE = {
  id: 'v1', name: 'Фотостудия Свет', city: 'Уфа', categoryId: 'photo', about: 'Снимаем свадьбы', phone: '+79990000001',
  published: true, verified: false, packages: [], gallery: [], rating: null as number | null, reviewsCount: 1,
}
const GUEST_REVIEW = { id: 'r1', source: 'guest', authorName: 'Гость', rating: 5, text: 'Супер', createdAt: '2026-05-01T10:00:00.000Z', reply: null }

const cabinet = (profile: Record<string, unknown> = PROFILE): Routes => ({
  '/vendor/profile': profile, '/vendor/updates': [], '/vendor/leads': [], '/vendor/calendar': [],
  '/vendor/reviews': [GUEST_REVIEW],
  '/weddings': [], '/me/favorites': [], '/notifications': [],
})

describe('кабинет подрядчика: рейтинг — серверный', () => {
  beforeEach(vendorUser)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('дашборд: один гостевой отзыв 5★ и rating null — «—», а не «5»', async () => {
    serve(cabinet())
    const r = await open('/vendor-app', 'Заполненность анкеты')
    const text = r.container.textContent ?? ''
    expect(text).toContain('—оценка в каталоге')
    expect(text).not.toContain('5оценка')
    expect(text).not.toContain('средняя оценка')
  })

  it('дашборд: рейтинг пришёл — он и показан (контроль)', async () => {
    serve(cabinet({ ...PROFILE, rating: 4.7, reviewsCount: 12 }))
    const r = await open('/vendor-app', 'Заполненность анкеты')
    expect(r.container.textContent ?? '').toContain('4.7оценка в каталоге')
  })

  it('экран отзывов: своё среднее не считается — серверный «—»', async () => {
    serve(cabinet())
    const r = await open('/vendor-app/reviews', 'Отвечено на')
    expect(r.container.textContent ?? '').toContain('—оценка в каталоге')
  })
})

describe('кабинет подрядчика: подписи денег под семантику сервера', () => {
  beforeEach(vendorUser)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('сделки: «ожидается» объяснено как остаток к оплате', async () => {
    serve({ ...cabinet(), '/vendor/deals': { expected: { amount: 5_000_000, currency: 'RUB' }, items: [] } })
    const r = await open('/vendor-app/deals', 'ожидается по сделкам')
    expect(r.container.textContent ?? '').toContain('остаток к оплате')
  })

  it('аналитика: «доход» объяснён как поступившие платежи за период', async () => {
    serve({
      ...cabinet(),
      '/vendor/analytics': { period: 'season', revenue: { amount: 0, currency: 'RUB' }, revenueDeltaPct: null, funnel: { views: 0, contacts: 0, leads: 0, deals: 0 } },
    })
    const r = await open('/vendor-app/analytics', 'Доход')
    expect(r.container.textContent ?? '').toContain('поступившие платежи за период')
  })
})
