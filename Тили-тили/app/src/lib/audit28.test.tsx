// @vitest-environment jsdom
/*
 * Ревью старого кода, фронт B: свадьба, гости, подарки, рассадка, логистика,
 * приглашения (находки D2-03/04/09/14/21, D2-02, D3-01/02/03/04/05/06/12/21/22/26).
 *
 * Общее у всех дыр одно: экран утверждал то, чего сервер не делал или не
 * говорил. Кнопка «Сгенерировать договор» меняла только экран; бюджет считал
 * категорию без своих статей; ноль выдавался за итог; гость при упавшей сети
 * сам стирал единственный ключ к своей странице; рассадка считала записи, а не
 * людей; редактор приглашений читал браузер, а не свадьбу; «Выдать ссылку»
 * молча перевыпускала уже открытую; логистика обещала очередь доставки гостям,
 * а подарки — перевод денег.
 *
 * Проверяется то, что ушло на сервер и что осталось на устройстве, а не то,
 * что нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { projectFile } from '@/test/projectFiles'
import App from '@/App'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')

/** Ответ со своим кодом: отказ, «не найдено», 5xx. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } } })

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/*
 * Сеть по таблице плюс журнал вызовов (приём из `audit25.test.tsx`): ключ —
 * путь без `/api` и без строки запроса. Незнакомый адрес получает 404.
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

const SERVER_DOWN = 'Сервер недоступен'

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

/** Секунда ожидания появления текста, которого быть не должно. */
const neverShows = async (text: string) => {
  await expect(screen.findByText(text)).rejects.toBeTruthy()
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

/** Пара: вошли, свадьба выбрана, онбординг пройден. */
const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg' }

/** Слот с забронированной сделкой. `over` — правки самой сделки. */
const bookedSlot = (over: Record<string, unknown> = {}, state = 'booked') => ({
  id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: state === 'done' || state === 'paid_deposit' ? 'paid' : 'booked',
  deal: { id: 'd1', state, vendor: { id: 'v1', name: 'Елена Фото' }, price: { amount: 4_500_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' }, ...over },
})

const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/notifications': [],
  '/me/favorites': [],
  ...over,
})

/* ── D3-01. Гость: сбой сети — не «ссылка погасла» ─────────────────────── */

describe('D3-01 приглашение гостя: сеть и 5xx не стирают токен', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('сеть упала — «Сервер недоступен» и «Повторить», токен на месте', async () => {
    const calls = serve({ '/rsvp/tok1': DOWN })
    const r = await open('/invite', SERVER_DOWN)
    expect(text(r)).not.toContain('Ссылка больше не действует')
    expect(screen.queryByText('Понятно')).toBeNull()
    fireEvent.click(screen.getByText('Повторить'))
    await waitFor(() => expect(calls.filter(c => c.path === '/rsvp/tok1').length).toBe(2))
    expect(localStorage.getItem('tt_guest_token')).toBe('tok1')
  })

  it('500 — то же самое: сервер, а не ссылка', async () => {
    serve({ '/rsvp/tok1': withStatus(500, 'internal', 'Внутренняя ошибка') })
    const r = await open('/invite', SERVER_DOWN)
    expect(text(r)).not.toContain('Ссылка больше не действует')
    expect(localStorage.getItem('tt_guest_token')).toBe('tok1')
  })

  it('410 — ссылка погасла: объяснение и «Понятно» стирает токен', async () => {
    serve({ '/rsvp/tok1': withStatus(410, 'gone', 'Ссылка уже использована') })
    await open('/invite', 'Ссылка больше не действует')
    fireEvent.click(screen.getByText('Понятно'))
    await waitFor(() => expect(localStorage.getItem('tt_guest_token')).toBeFalsy())
  })
})

/* ── D2-03. Мастер договора: за кнопкой запрос ──────────────────────────── */

describe('D2-03 мастер договора', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('без ?deal= кнопка недоступна и объяснено, почему', async () => {
    const calls = serve(base())
    const r = await open('/wedding/documents/new', 'Новый договор')
    fireEvent.click(screen.getByText('Далее'))
    const btn = screen.getByText('Сгенерировать договор ✨').closest('button')!
    expect(btn.disabled).toBe(true)
    expect(text(r)).toContain('Договор оформляется по сделке')
    fireEvent.click(btn)
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })

  it('409 not_booked — словами сервера, экран «Договор готов» не показывается', async () => {
    serve(base({
      '/weddings/w1/slots': [bookedSlot()],
      '/deals/d1/contract': withStatus(409, 'not_booked', 'Договор оформляется по забронированной сделке'),
    }))
    await open('/wedding/documents/new?deal=d1', 'Новый договор')
    fireEvent.click(screen.getByText('Далее'))
    fireEvent.change(screen.getByPlaceholderText('ФИО заказчика — как в паспорте'), { target: { value: 'Анна Иванова' } })
    fireEvent.click(screen.getByText('Сгенерировать договор ✨'))
    expect(await screen.findByText('Договор оформляется по забронированной сделке')).toBeTruthy()
    expect(screen.queryByText('Договор готов')).toBeNull()
  })
})

/* ── D2-04 / D2-09. Бюджет ─────────────────────────────────────────────── */

const budgetRoutes = (total: number, items: unknown[] = []) => base({
  '/weddings/w1/budget': {
    total: { amount: total, currency: 'RUB' },
    spent: { amount: 5_000_000, currency: 'RUB' },
    reserve: { amount: total / 10, currency: 'RUB' },
    categories: [{ id: 'other', title: 'Прочее', planned: { amount: total > 0 ? 7_900_000 : 0, currency: 'RUB' }, fromSlots: 0, color: '#D9A8A0', live: null, items }],
  },
})

describe('D2-04 бюджет: сумма категории включает свои статьи', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('статья 70 000 ₽ в «Прочее» даёт строке «70К», а не «0К», и подсказка считает от неё же', async () => {
    serve(budgetRoutes(100_000_000, [{ id: 'i1', title: 'Фейерверк', amount: { amount: 7_000_000, currency: 'RUB' }, categoryId: 'other', custom: true }]))
    const r = await open('/wedding/budget', 'Фейерверк')
    expect(text(r)).toContain('70К/')
    /* Отдельно стоящий «0К/» — ноль в строке категории; «70К/» его не содержит. */
    expect(text(r)).not.toMatch(/(^|\D)0К\//)
    /* Подсказка о лимите — от той же суммы: 70К из 79К это 89%, и она есть;
       от одних сделок было 0%, и подсказки не было вовсе. */
    expect(text(r)).toContain('89% лимита')
  })
})

describe('D2-09 бюджет без итога: «итог не задан» и ввод суммы', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('total 0 — нет «из 0 ₽», «0%» и лимитов «0К»; сумма уходит PATCH', async () => {
    const calls = serve(budgetRoutes(0))
    const r = await open('/wedding/budget', 'итог не задан')
    const shown = text(r).replace(/[\u00a0\u202f]/g, ' ')
    expect(shown).not.toContain('из 0 ₽')
    expect(shown).not.toContain('запланировано')
    expect(shown).not.toMatch(/(^|\D)0%/)
    expect(shown).not.toContain('/ 0К')

    fireEvent.change(screen.getByPlaceholderText('Общий бюджет, ₽'), { target: { value: '1 000 000' } })
    fireEvent.click(screen.getByText('Задать бюджет'))
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && c.path === '/weddings/w1')).toBe(true))
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/weddings/w1')!.body).toEqual({ budgetTotal: { amount: 100_000_000, currency: 'RUB' } })
  })
})

/* ── D2-14. Список документов ───────────────────────────────────────────── */

describe('D2-14 документы: заголовок не обещает подписи', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('черновики с сервера стоят под «Черновики договоров», а не «Подписанные»', async () => {
    serve(base({ '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1, status: 'draft', pdfUrl: null, docxUrl: null }] }))
    const r = await open('/wedding/documents', 'Черновики договоров')
    expect(text(r)).not.toContain('Подписанные')
  })
})

/* ── D2-21 / D2-02. Сделка и слот: деньги и действия по роли и состоянию ── */

describe('D2-21 роль без денег: ни «0 ₽», ни денежных кнопок', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  /* Помощнику сервер не отдаёт `price` и `paid` вовсе (toDeal(seesMoney=false)). */
  const helperSlot = () => {
    const s = bookedSlot()
    const { price: _p, paid: _q, ...deal } = s.deal
    void _p; void _q
    return { ...s, deal }
  }

  it('экран сделки: суммы скрыты словами, кнопок оплаты/шага/отмены нет', async () => {
    serve(base({ '/weddings/w1/slots': [helperSlot()], '/deals/d1/events': [] }))
    const r = await open('/deal/d1', 'Что происходило')
    const shown = text(r).replace(/[\u00a0\u202f]/g, ' ')
    expect(shown).not.toContain('0 ₽')
    expect(screen.queryByText('✓ Отметить оплату')).toBeNull()
    expect(screen.queryByText('Отменить сделку')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Аванс внесён' })).toBeNull()
    expect(shown).toContain('видит только пара')
  })

  it('экран слота: «Отменить бронь» помощнику не показывается', async () => {
    serve(base({ '/weddings/w1/slots': [helperSlot()] }))
    await open('/wedding/slot/s1', 'Слот команды')
    await neverShows('Отменить бронь')
  })
})

describe('D2-02 выполненная сделка не отменяется с экрана', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('экран сделки в done: нет «Отменить сделку»', async () => {
    serve(base({ '/weddings/w1/slots': [bookedSlot({}, 'done')], '/deals/d1/events': [] }))
    await open('/deal/d1', 'Что происходило')
    await neverShows('Отменить сделку')
  })

  it('экран слота в done: нет «Отменить бронь»', async () => {
    serve(base({ '/weddings/w1/slots': [bookedSlot({}, 'done')] }))
    await open('/wedding/slot/s1', 'Слот команды')
    await neverShows('Отменить бронь')
  })
})

/* ── D3-03 / D3-12. Рассадка ───────────────────────────────────────────── */

describe('D3-03 рассадка считает людей, а не записи', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('гость с +1 занимает два места: «2/2», второго не сажает', async () => {
    const calls = serve(base({
      '/weddings/w1/guests': [
        { id: 'g1', name: 'Ольга и Денис', status: 'yes', plusOne: true, tableId: 'tb1' },
        { id: 'g2', name: 'Пётр', status: 'yes', plusOne: false, tableId: null },
      ],
      '/weddings/w1/tables': [{ id: 'tb1', name: 'Стол №1', capacity: 2 }],
    }))
    const r = await open('/wedding/seating', 'Стол №1')
    expect(text(r)).toContain('2/2')
    expect(text(r)).not.toContain('1/2')

    fireEvent.click(screen.getByText('Пётр'))
    fireEvent.click(screen.getByText('Стол №1'))
    await waitFor(() => expect(text(r)).toContain('Стол заполнен'))
    expect(calls.some(c => c.method === 'PATCH' && c.path === '/weddings/w1/guests/g2'), 'посадили за полный стол').toBe(false)
  })
})

describe('D3-12 рассадка без списка гостей', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('гости не пришли — нет «0/8» и «Пусто», есть слова об ошибке', async () => {
    serve(base({
      '/weddings/w1/guests': DOWN,
      '/weddings/w1/tables': [{ id: 'tb1', name: 'Стол №1', capacity: 8 }],
    }))
    const r = await open('/wedding/seating', SERVER_DOWN)
    expect(text(r)).not.toContain('0/8')
    expect(text(r)).not.toContain('Пусто')
  })
})

/* ── D3-04 / D3-26 / D3-05. Редактор приглашений ───────────────────────── */

describe('D3-04 редактор приглашений читает свадьбу, а не браузер', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const withInvite = base({
    '/weddings/w1': { ...WEDDING, inviteText: 'Ждём вас на нашей свадьбе', inviteThemeId: 3 },
    '/weddings/w1/guests': [],
  })

  it('превью показывает текст и тему с сервера при пустом localStorage', async () => {
    serve(withInvite)
    const r = await open('/wedding/invites', 'Сценарий приглашения')
    await waitFor(() => expect(text(r)).toContain('Ждём вас на нашей свадьбе'))
    const editorial = screen.getByText('«Editorial»').closest('button')!
    expect(editorial.className).toContain('ring-2')
    const teatro = screen.getByText('«Театро»').closest('button')!
    expect(teatro.className).not.toContain('ring-2')
  })

  it('«Сохранить оформление» шлёт серверные текст и тему, а не умолчания', async () => {
    const calls = serve(withInvite)
    const r = await open('/wedding/invites', 'Сценарий приглашения')
    await waitFor(() => expect(text(r)).toContain('Ждём вас на нашей свадьбе'))
    fireEvent.click(screen.getByText('Сохранить оформление'))
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && c.path === '/weddings/w1')).toBe(true))
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/weddings/w1')!.body).toMatchObject({ inviteText: 'Ждём вас на нашей свадьбе', inviteThemeId: 3 })
  })

  it('D3-26: испорченный tt_invite_tpl и чужой номер темы не роняют редактор', async () => {
    localStorage.setItem('tt_invite_tpl', 'abc')
    serve(base({ '/weddings/w1': { ...WEDDING, inviteThemeId: 99 }, '/weddings/w1/guests': [] }))
    const r = await open('/wedding/invites', 'Сценарий приглашения')
    expect(text(r)).toContain('Именные ссылки')
  })
})

describe('D3-05 именные ссылки: выданная копируется, открытая перевыпускается с предупреждением', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const guests = [
    { id: 'g1', name: 'Уже открыл', status: 'yes', plusOne: false, inviteUrl: null, inviteUrlUsed: true },
    { id: 'g2', name: 'Ссылка выдана', status: 'pending', plusOne: false, inviteUrl: 'https://tili-tili.ru/i/ABCD', inviteUrlUsed: false },
    { id: 'g3', name: 'Без ссылки', status: 'pending', plusOne: false, inviteUrl: null, inviteUrlUsed: false },
  ]

  it('«Выдать ссылку» — только у гостя без ссылки; выданная — «Копировать» без запроса', async () => {
    const calls = serve(base({ '/weddings/w1/guests': guests }))
    await open('/wedding/invites', 'Без ссылки')
    expect(screen.getAllByText('Выдать ссылку').length).toBe(1)
    fireEvent.click(screen.getByText('Копировать'))
    expect(calls.some(c => c.method === 'POST')).toBe(false)
  })

  it('открытая ссылка: «Открыта ✓ · Перевыпустить», первое нажатие только предупреждает', async () => {
    const calls = serve(base({
      '/weddings/w1/guests': guests,
      '/weddings/w1/guests/g1/invite-link': { url: 'https://tili-tili.ru/i/NEW1', expiresAt: '2027-01-01T00:00:00.000Z' },
    }))
    const r = await open('/wedding/invites', 'Уже открыл')
    expect(text(r)).toContain('Открыта ✓')
    fireEvent.click(screen.getByText('Перевыпустить'))
    expect(calls.some(c => c.method === 'POST'), 'перевыпуск ушёл без подтверждения').toBe(false)
    fireEvent.click(screen.getByText('Точно перевыпустить? Гость потеряет ссылку и резерв подарка'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/weddings/w1/guests/g1/invite-link')).toBe(true))
  })
})

/* ── D3-06 / D3-22. Логистика и меню ───────────────────────────────────── */

const BUS = { id: 'b1', name: 'Автобус №1', from: 'Центр', time: '14:30', seats: 20, taken: 3 }

describe('D3-06 рассылки говорят правду: команда уведомлена, гостям не доставляется', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('точки сбора: после ответа — числа из ответа, без «очереди»', async () => {
    serve(base({
      '/weddings/w1/logistics/buses': [BUS],
      '/weddings/w1/logistics/hotels': [],
      '/weddings/w1/logistics/notify-pickup': { broadcastId: 'x', recipients: 3, notified: 2, debounced: false },
    }))
    const r = await open('/wedding/logistics', 'Автобус №1')
    expect(text(r)).not.toContain('Отправить гостям точки сбора')
    fireEvent.click(screen.getByText('Сообщить команде о точках сбора'))
    await waitFor(() => expect(text(r)).toContain('Команда уведомлена: 2'))
    expect(text(r)).toContain('гостям пока не доставляется')
    expect(text(r)).not.toContain('поставлены в очередь')
  })

  it('меню: «Напомнить» — команда уведомлена, а не «В очереди»', async () => {
    serve(base({
      '/weddings/w1/menu-poll': { question: 'Что на горячее?', options: [{ id: 'o1', name: 'Мясо', votes: 0 }], expectedPortions: 1 },
      '/weddings/w1/guests': [{ id: 'g1', name: 'Ольга', status: 'yes', plusOne: false }],
      '/weddings/w1/menu-poll/remind': { broadcastId: 'y', recipients: 1, notified: 1, debounced: false },
    }))
    const r = await open('/wedding/catering', 'Мясо')
    fireEvent.click(screen.getByText('Напомнить'))
    await waitFor(() => expect(text(r)).toContain('Команда уведомлена'))
    expect(text(r)).not.toContain('В очереди')
  })
})

describe('D3-22 удаление маршрута с бронями — с подтверждением словами', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('taken 3 — первое нажатие не удаляет, второе удаляет', async () => {
    const calls = serve(base({ '/weddings/w1/logistics/buses': [BUS], '/weddings/w1/logistics/hotels': [], '/weddings/w1/logistics/buses/b1': {} }))
    await open('/wedding/logistics', 'Автобус №1')
    fireEvent.click(screen.getByLabelText('Удалить'))
    expect(calls.some(c => c.method === 'DELETE'), 'маршрут с гостями удалён без подтверждения').toBe(false)
    fireEvent.click(screen.getByText('Удалить маршрут? 3 гостя потеряют место'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/weddings/w1/logistics/buses/b1')).toBe(true))
  })

  it('taken 0 — удаляется сразу', async () => {
    const calls = serve(base({ '/weddings/w1/logistics/buses': [{ ...BUS, taken: 0 }], '/weddings/w1/logistics/hotels': [], '/weddings/w1/logistics/buses/b1': {} }))
    await open('/wedding/logistics', 'Автобус №1')
    fireEvent.click(screen.getByLabelText('Удалить'))
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.path === '/weddings/w1/logistics/buses/b1')).toBe(true))
  })
})

/* ── D3-02. Подарки: обещание, а не перевод ─────────────────────────────── */

describe('D3-02 фонды и складчина не обещают перевод денег', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('гость: «Обещаю внести», «Обещано», взнос уходит запросом', async () => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
    const calls = serve({
      '/gifts/tok1': {
        gifts: [{ id: 'gf1', name: 'Робот-пылесос', price: { amount: 1_000_000, currency: 'RUB' }, funded: { amount: 0, currency: 'RUB' }, group: true, reserved: false, mine: false }],
        funds: [{ id: 'f1', name: 'Медовый месяц', target: { amount: 5_000_000, currency: 'RUB' }, collected: { amount: 1_000_000, currency: 'RUB' } }],
        antiGifts: [],
      },
      '/join/tok1/team': { weddingId: 'w1', weddingDate: null, vendors: [] },
      '/gifts/tok1/funds/f1': { ok: true },
    })
    const r = await open('/gifts', 'Медовый месяц')
    expect(text(r)).not.toContain('Перевести на цель')
    expect(text(r)).not.toContain('перевод на цель')
    expect(text(r)).not.toContain('Собрано')
    expect(text(r)).toContain('Обещано')

    fireEvent.click(screen.getByText('Обещаю внести'))
    fireEvent.change(screen.getByPlaceholderText('Сумма, ₽'), { target: { value: '500' } })
    fireEvent.click(screen.getByText('Записать обещание'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/gifts/tok1/funds/f1')).toBe(true))
    expect(calls.find(c => c.method === 'POST' && c.path === '/gifts/tok1/funds/f1')!.body).toEqual({ amount: { amount: 50_000, currency: 'RUB' } })
  })

  it('пара: «обещано гостями», а не «собрано»', async () => {
    couple()
    serve(base({
      '/weddings/w1/wishlist': {
        gifts: [],
        funds: [{ id: 'f1', name: 'Медовый месяц', target: { amount: 5_000_000, currency: 'RUB' }, collected: { amount: 1_000_000, currency: 'RUB' } }],
        antiGifts: [],
      },
    }))
    const r = await open('/wedding/wishlist', 'Медовый месяц')
    expect(text(r)).not.toContain('Собрано')
    expect(text(r)).not.toContain('переводят на цель')
    expect(text(r)).toContain('Обещано гостями')
  })
})

/* ── D3-18. Форма отзыва гостя: «свадьба прошла» — по поясу свадьбы ─────── */

describe('D3-18 отзыв гостя открывается по дню свадьбы в её поясе, а не по UTC', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  /* Подменяем только часы: таймеры остаются настоящими, иначе `waitFor` не
     дождётся ни одного ответа. */
  const clock = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)) }

  const team = (tz: string) => ({
    '/gifts/tok1': { gifts: [], funds: [], antiGifts: [] },
    '/join/tok1/team': { weddingId: 'w1', weddingDate: '2027-06-14', tz, vendors: [{ vendorId: 'v1', name: 'Елена Фото', categoryId: 'photo' }] },
  })

  it('UTC+14: по Гринвичу ещё 14 июня, на свадьбе уже 15-е — форма есть', async () => {
    clock('2027-06-14T20:00:00.000Z')
    serve(team('Pacific/Kiritimati'))
    const r = await open('/gifts', 'Как прошла свадьба?')
    expect(text(r)).toContain('Отправить отзыв гостя')
    expect(text(r)).not.toContain('Оценить команду можно после дня свадьбы')
  })

  it('UTC−10: по Гринвичу уже 15 июня, на свадьбе ещё вечер 14-го — формы нет, сервер ответил бы 403', async () => {
    clock('2027-06-15T05:00:00.000Z')
    serve(team('Pacific/Honolulu'))
    const r = await open('/gifts', 'Как прошла свадьба?')
    expect(text(r)).toContain('Оценить команду можно после дня свадьбы')
    expect(text(r)).not.toContain('Отправить отзыв гостя')
  })
})

/* ── D3-20. Цвета — токенами ───────────────────────────────────────────── */

describe('D3-20 экраны свадьбы, подарков и инструментов без хардкода цветов', () => {
  it('в Wedding.tsx, Wishlist.tsx и Tools.tsx нет #rrggbb и rgba(…) — только var(--…)', () => {
    const hits: string[] = []
    for (const f of ['src/pages/Wedding.tsx', 'src/pages/Wishlist.tsx', 'src/pages/Tools.tsx']) {
      projectFile(f).split('\n').forEach((line, i) => {
        if (/#[0-9A-Fa-f]{6}\b|rgba?\(/.test(line)) hits.push(`${f}:${i + 1}`)
      })
    }
    expect(hits).toEqual([])
  })
})

/* ── D3-21. CSV гостей — через словарь ──────────────────────────────────── */

describe('D3-21 CSV гостей переводится целиком', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const readBlob = (b: Blob) => new Promise<string>((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(String(fr.result))
    fr.onerror = () => rej(fr.error)
    fr.readAsText(b)
  })

  it('в английском интерфейсе заголовок и «да/нет» английские', async () => {
    localStorage.setItem('tt_lang', 'en')
    let captured: Blob | null = null
    Object.defineProperty(URL, 'createObjectURL', { value: vi.fn((b: Blob) => { captured = b; return 'blob:x' }), configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true })
    serve(base({ '/weddings/w1/guests': [{ id: 'g1', name: 'Olga', status: 'yes', plusOne: true }] }))
    await open('/wedding/guests', 'Olga')
    fireEvent.click(screen.getByText('CSV list'))
    await waitFor(() => expect(captured).not.toBeNull())
    const csv = await readBlob(captured!)
    expect(csv).toContain('Name;Status;+1')
    expect(csv).toContain('Olga;Coming;yes')
    expect(csv).not.toContain('Имя')
    expect(csv).not.toContain(';да')
  })
})
