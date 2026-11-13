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
import { act, render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react'
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
  /* Подсказка о лимите — с сервера (§3.14, сверка планов 2026-09-18): считается
     той же функцией, что бюджет (`wedding/tips.ts`, тест бэкенда audit47). */
  '/weddings/w1/tips': { items: items.length ? [{ kind: 'budget', title: '«Прочее» — 89 % лимита', body: 'Обещано 70 000 ₽ из 79 000 ₽ — зафиксируйте состав, пока укладываетесь', link: '/wedding/budget', categoryId: 'other' }] : [] },
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
    /* Подсказка о лимите — от той же суммы, теперь с сервера: 70К из 79К это 89 %,
       и она есть; от одних сделок было 0%, и подсказки не было вовсе. */
    expect(text(r)).toContain('89 % лимита')
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

  it('договоры с сервера показаны как редакции без заявления о подписи', async () => {
    serve(base({ '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1, status: 'draft', pdfUrl: null, docxUrl: null }] }))
    const r = await open('/wedding/documents', 'Редакции договоров')
    expect(text(r)).not.toContain('Подписанные')
  })

  it('строка договора называется по-русски, а не кодом шаблона сервера', async () => {
    /* Живая проверка после ревью: договор из мастера ложился в список строкой
       «photographer» — код шаблона вместо названия (ERR-0241). */
    serve(base({ '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1, status: 'draft', pdfUrl: null, docxUrl: null }] }))
    const r = await open('/wedding/documents', 'Редакции договоров')
    expect(text(r)).toContain('Договор с фотографом')
    expect(text(r)).not.toContain('photographer')
  })

  it('FR-053 подтверждает точную редакцию и показывает согласие из ответа сервера', async () => {
    const at = '2026-11-13T02:00:00.000Z'
    const terms = { city: 'Уфа', date: '2027-06-14', customerName: 'Пара проверки', performerName: 'Подрядчик проверки',
      price: { amount: 4200000, currency: 'RUB' } }
    const attachment = { uploadId: 'file1', attachedAt: at, authorSide: 'couple', authorName: null, canRemove: false }
    let coupleAt: string | null = null
    const calls = serve(base({
      '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1, status: 'draft' }],
      '/deals/d1/documents': () => ({ uploadEnabled: true, versions: [{ id: 'doc1', version: 1, templateCode: 'photographer',
        attachment, pendingUploadId: null, uploadInProgress: false, agreement: {
          proposedSide: 'couple', proposedAt: at, coupleAt, vendorAt: at, canAgree: coupleAt === null, canPropose: false, terms,
        } }] }),
      '/deals/d1/documents/doc1/agreement': () => {
        coupleAt = at
        return { proposedSide: 'couple', proposedAt: at, coupleAt, vendorAt: at }
      },
    }))
    await open('/wedding/documents', 'Редакции договоров')
    const details = screen.getByText('Редакции и согласование').parentElement as HTMLDetailsElement
    details.open = true
    fireEvent(details, new Event('toggle'))
    expect(await screen.findByText('Пара проверки')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Согласовать редакцию' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(calls.filter(call => call.method === 'POST')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Согласовать редакцию' }))
    await waitFor(() => expect(calls.filter(call => call.method === 'POST')).toEqual([expect.objectContaining({
      path: '/deals/d1/documents/doc1/agreement', body: { action: 'agree', attachmentId: 'file1' },
    })]))
    await waitFor(() => expect(screen.queryByText('Ожидается согласование')).toBeNull())
    expect(screen.queryByRole('button', { name: 'Убрать вложение' })).toBeNull()
  })

  it('FR-055 открывает историю сделки из конкретной редакции и возвращает к ней', async () => {
    const dealId = '00000000-0000-4000-8000-000000000101'
    const documentId = '00000000-0000-4000-8000-000000000201'
    const proposalId = '00000000-0000-4000-8000-000000000301'
    const path = `/deals/${dealId}`
    const calls = serve(base({
      '/weddings/w1/documents': [{ id: documentId, dealId, templateCode: 'photographer', version: 1 }],
      [`${path}/documents`]: { uploadEnabled: false, versions: [{ id: documentId, version: 1, templateCode: 'photographer',
        attachment: null, pendingUploadId: null, uploadInProgress: false }] },
      [`${path}/order`]: { dealId, version: '1' },
      [`${path}/order/catalog`]: { weddingId: '00000000-0000-4000-8000-000000000401', actorRole: 'couple', draftEditable: false, category: { fields: [] } },
      [`${path}/order/terms`]: { revision: '0', history: [], proposedTermsId: null, agreedTermsId: null,
        selected: null, acceptedByCaller: false, readToken: null },
      [`${path}/event-moves`]: [{ id: proposalId, status: 'applied' }],
      [`${path}/events`]: [{ id: 'event1', kind: 'state', fromState: 'booked', toState: 'cancelled',
        by: 'couple', note: null, at: '2026-11-13T03:00:00.000Z' }],
    }))
    const r = await open(`/wedding/documents?document=${documentId}`, 'Редакции договоров')
    fireEvent.click(await screen.findByRole('link', { name: 'История условий сделки' }))
    await waitFor(() => expect(text(r)).toContain('История условий доступна для просмотра'))
    expect(await screen.findByText('Сделка отменена')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Принять эту редакцию' })).toBeNull()
    expect(calls.some(call => call.path === `${path}/order/terms`)).toBe(true)
    expect(calls.some(call => call.path === `${path}/event-moves`)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Показать предложения переноса' }))
    await waitFor(() => expect(r.container.querySelector(`a[href="/deal/${dealId}/event-moves/${proposalId}"]`)).toBeTruthy())
    fireEvent.click(screen.getByRole('link', { name: 'Вернуться к редакциям договора' }))
    expect(await screen.findByRole('link', { name: 'История условий сделки' })).toBeTruthy()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it.each(['/deal', '/vendor-app/deals'])('SC-017/018 перепроверяет журнал и переносы в %s', async entry => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const dealId = '00000000-0000-4000-8000-000000000101'
    const path = `/deals/${dealId}`
    let access = true
    const calls = serve(base({
      [`${path}/events`]: () => access
        ? [{ id: 'e1', kind: 'price', by: 'couple', note: 'Прежняя цена сделки', at: '2026-11-13T03:00:00Z' }]
        : withStatus(403, 'forbidden', 'Доступ к журналу отозван'),
      [`${path}/event-moves`]: () => access
        ? [{ id: '00000000-0000-4000-8000-000000000301', status: 'applied' }]
        : withStatus(403, 'forbidden', 'Доступ к предложениям отозван'),
    }))
    try {
      await open(`${entry}/${dealId}/terms`, 'Прежняя цена сделки')
      fireEvent.click(screen.getByRole('button', { name: 'Показать предложения переноса' }))
      await screen.findByRole('link', { name: 'Перенос применён' })
      const journal = within(screen.getByRole('heading', { name: 'Что происходило' }).closest('section')!)
      const moves = within(screen.getByRole('heading', { name: 'Перенос мероприятия' }).closest('section')!)
      const hidden = () => {
        expect(journal.queryByText('Прежняя цена сделки')).toBeNull()
        expect(moves.queryByRole('link')).toBeNull()
        expect(journal.queryByText('Пока ничего не происходило')).toBeNull()
        expect(moves.queryByText('Предложений переноса пока нет')).toBeNull()
      }

      online.mockReturnValue(false)
      fireEvent(window, new Event('offline'))
      hidden()
      expect(journal.getByText('Нет связи с сервером')).toBeTruthy()
      expect(moves.getByText('Нет связи с сервером')).toBeTruthy()

      online.mockReturnValue(true)
      fireEvent(window, new Event('online'))
      hidden()
      await journal.findByText('Прежняя цена сделки')
      await moves.findByRole('link', { name: 'Перенос применён' })

      access = false
      fireEvent.focus(window)
      hidden()
      await journal.findByText('Доступ к журналу отозван')
      await moves.findByText('Доступ к предложениям отозван')
      expect(calls.filter(call => call.path === `${path}/events`)).toHaveLength(3)
      expect(calls.filter(call => call.path === `${path}/event-moves`)).toHaveLength(3)
      expect(calls.every(call => call.method === 'GET')).toBe(true)
    } finally {
      online.mockRestore()
    }
  })

  it('FR-053 из черновика открывает последнюю редакцию той же сделки с двумя согласиями', async () => {
    const at = '2026-11-13T02:00:00.000Z'
    const doc = (id: string, version: number, dealId = 'd1') => ({ id, version, dealId, templateCode: 'photographer', status: 'draft' })
    const documents = [doc('draft', 4), doc('partial', 3), doc('agreed', 2), doc('older', 1), doc('other', 5, 'd2')]
    const versions = documents.filter(item => item.dealId === 'd1').reverse().map(item => ({
      ...item, attachment: null, pendingUploadId: null, uploadInProgress: false,
      agreement: { proposedSide: 'couple', proposedAt: item.id === 'draft' ? null : at,
        coupleAt: item.id === 'draft' ? null : at, vendorAt: item.version < 3 ? at : null },
    }))
    const calls = serve(base({
      '/weddings/w1/documents': documents,
      '/deals/d1/documents': { archived: false, uploadEnabled: false, versions },
    }))
    await open('/wedding/documents?document=draft', 'Редакции договоров')
    const openApproved = await screen.findByRole('link', { name: 'Открыть согласованную редакцию №2' })
    expect(openApproved.getAttribute('href')).toBe('/wedding/documents?document=agreed')
    expect(screen.queryByText('Последняя редакция, согласованная обеими сторонами')).toBeNull()
    fireEvent.click(openApproved)
    expect(await screen.findByText('Последняя редакция, согласованная обеими сторонами')).toBeTruthy()
    expect(screen.queryByRole('link', { name: /Открыть согласованную редакцию/ })).toBeNull()
    expect(calls.every(call => call.method === 'GET')).toBe(true)
  })

  it('FR-055 оставляет отказ сервера видимым и возвращает в карточку подрядчика', async () => {
    const dealId = '00000000-0000-4000-8000-000000000101'
    const path = `/deals/${dealId}`
    const denied = withStatus(403, 'forbidden', 'Доступ к истории отозван')
    const calls = serve(base({
      [`${path}/order`]: denied,
      [`${path}/order/catalog`]: denied,
      [`${path}/order/terms`]: denied,
      [`${path}/event-moves`]: denied,
      [`${path}/events`]: denied,
    }))
    await open(`/vendor-app/deals/${dealId}/terms`, 'Доступ к истории отозван')
    expect(screen.queryByText('Пока ничего не происходило')).toBeNull()
    expect(screen.getByRole('link', { name: 'Вернуться к редакциям договора' }).getAttribute('href')).toBe(`/vendor-app/deals/${dealId}`)
    fireEvent.click(screen.getByRole('button', { name: 'Показать предложения переноса' }))
    await waitFor(() => expect(calls.some(call => call.path === `${path}/event-moves`)).toBe(true))
    expect(screen.queryByText('Предложений переноса пока нет')).toBeNull()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('SC-012 показывает согласованный PDF в архиве и скрывает действия редактирования', async () => {
    const at = '2026-11-13T02:00:00.000Z'
    const calls = serve(base({
      '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1 }],
      '/deals/d1/documents': { archived: true, uploadEnabled: false, versions: [{
        id: 'doc1', version: 1, templateCode: 'photographer', pendingUploadId: null, uploadInProgress: false,
        attachment: { uploadId: 'file1', attachedAt: at, authorSide: 'couple', canRemove: false },
        agreement: { proposedAt: at, coupleAt: at, vendorAt: at, canAgree: false, canPropose: false },
      }] },
    }))
    await open('/wedding/documents?document=doc1', 'Договор в архиве доступен только для просмотра')
    expect(screen.getByRole('button', { name: 'Скачать PDF' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Убрать вложение' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Согласовать редакцию' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'История условий сделки' })).toBeNull()
    expect(calls.filter(call => call.method !== 'GET')).toEqual([])
  })

  it('SC-017/018 скрывает редакцию без связи и показывает отказ после перепроверки', async () => {
    const status = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    let access = true
    const versions = { archived: true, uploadEnabled: false, versions: [{
      id: 'doc1', version: 1, templateCode: 'photographer',
      attachment: { uploadId: 'file1', attachedAt: '2026-11-13T02:00:00.000Z',
        authorSide: 'couple', authorName: 'Автор договора', canRemove: false },
    }] }
    const calls = serve(base({
      '/weddings/w1/documents': [{ id: 'doc1', dealId: 'd1', templateCode: 'photographer', version: 1 }],
      '/deals/d1/documents': () => access ? versions : withStatus(403, 'forbidden', 'Доступ к редакциям отозван'),
    }))
    try {
      await open('/wedding/documents?document=doc1', 'Автор договора')
      const download = screen.getByRole('button', { name: 'Скачать PDF' })
      status.mockReturnValue(false)
      fireEvent(window, new Event('offline'))
      expect(screen.queryByText(/Автор договора/)).toBeNull()
      expect(screen.getByText('Нет связи с сервером')).toBeTruthy()
      fireEvent.click(download)
      expect(calls.filter(call => call.path.endsWith('/content'))).toEqual([])

      status.mockReturnValue(true)
      fireEvent(window, new Event('online'))
      expect(await screen.findByText(/Автор договора/)).toBeTruthy()
      expect(calls.filter(call => call.path === '/deals/d1/documents')).toHaveLength(2)
      access = false
      fireEvent.focus(window)
      expect(screen.queryByRole('button', { name: 'Скачать PDF' })).toBeNull()
      await screen.findByText('Доступ к редакциям отозван')
      expect(screen.queryByText('Редакций договора пока нет')).toBeNull()
      expect(calls.filter(call => call.path === '/deals/d1/documents')).toHaveLength(3)
    } finally {
      status.mockRestore()
    }
  })

  it.each([
    ['/settings', '/archived-contracts', 'couple'],
    ['/vendor-app/deals', '/vendor-app/archived-contracts', 'vendor'],
  ] as const)('SC-012 открывает архив из %s без выбранной свадьбы', async (entry, archivePath, side) => {
    localStorage.removeItem('tt_wedding_id')
    const at = '2026-11-13T02:00:00.000Z'
    const before = '00000000-0000-4000-8000-000000000041'
    const calls = serve(base({
      '/vendor/deals': { items: [] },
      '/users/me/archived-contracts': ({ url }: Call) => url.includes('before=')
        ? { items: [], nextCursor: null, archiveRetentionDays: 173 }
        : { items: [{ dealId: before, weddingTitle: 'Свадьба в архиве', performerName: null, archivedAt: at, cleanupEligible: side === 'vendor' }],
          nextCursor: before, archiveRetentionDays: 173 },
      [`/deals/${before}/documents`]: { archived: true, uploadEnabled: false, versions: [{
        id: 'doc1', version: 1, templateCode: 'photographer', pendingUploadId: null, uploadInProgress: false,
        attachment: { uploadId: 'file1', attachedAt: at, authorSide: 'couple', canRemove: false },
      }] },
    }))
    await open(entry, 'Архив договоров')
    const link = screen.getByRole('link', { name: 'Архив договоров' })
    expect(link.getAttribute('href')).toBe(archivePath)
    fireEvent.click(link)
    expect(await screen.findByRole('heading', { name: 'Свадьба в архиве' })).toBeTruthy()
    expect(screen.getByText('Срок хранения архива — 173 дн.')).toBeTruthy()
    expect(Boolean(screen.queryByText('Срок хранения истёк. Архив может быть удалён при ближайшей очистке.'))).toBe(side === 'vendor')
    expect(calls.some(call => call.path === `/deals/${before}/documents`)).toBe(false)
    fireEvent.click(screen.getByText('Редакции и согласование'))
    expect(await screen.findByRole('button', { name: 'Скачать PDF' })).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Следующая страница' }))
    expect(await screen.findByText('В архиве нет доступных договоров')).toBeTruthy()
    expect(calls.filter(call => call.path === '/users/me/archived-contracts').map(call => call.url)).toEqual([
      `/users/me/archived-contracts?side=${side}`, `/users/me/archived-contracts?side=${side}&before=${before}`,
    ])
  })

  it.each([
    ['/archived-contracts', 'couple'],
    ['/vendor-app/archived-contracts', 'vendor'],
  ] as const)('SC-017/018 перепроверяет список архива (%s)', async (archivePath, side) => {
    const status = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const endpoint = '/users/me/archived-contracts'
    const empty = { items: [], nextCursor: null, archiveRetentionDays: 173 }
    let archive: unknown = { ...empty, nextCursor: 'd1', items: [{ dealId: 'd1', weddingTitle: 'Свадьба в архиве',
      performerName: 'Подрядчик из архива', archivedAt: '2026-11-13T02:00:00.000Z', cleanupEligible: false }] }
    const calls = serve(base({ [endpoint]: () => archive }))
    try {
      await open(archivePath, 'Свадьба в архиве')
      const title = () => screen.queryByRole('heading', { name: 'Свадьба в архиве' })
      expect(screen.getByText('Подрядчик из архива')).toBeTruthy()
      expect(screen.getByRole('link', { name: 'Следующая страница' })).toBeTruthy()

      status.mockReturnValue(false)
      fireEvent(window, new Event('offline'))
      expect(title()).toBeNull()
      expect(screen.queryByText('Подрядчик из архива')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Следующая страница' })).toBeNull()
      expect(screen.getByText('Нет связи с сервером').getAttribute('role')).toBe('status')
      expect(screen.queryByText('В архиве нет доступных договоров')).toBeNull()

      status.mockReturnValue(true)
      fireEvent(window, new Event('online'))
      expect(title()).toBeNull()
      expect(await screen.findByRole('heading', { name: 'Свадьба в архиве' })).toBeTruthy()

      archive = empty
      fireEvent.focus(window)
      expect(title()).toBeNull()
      expect(screen.queryByText('В архиве нет доступных договоров')).toBeNull()
      expect(await screen.findByText('В архиве нет доступных договоров')).toBeTruthy()

      archive = withStatus(403, 'forbidden', 'Доступ к архиву отозван')
      fireEvent.focus(window)
      expect(await screen.findByText('Доступ к архиву отозван')).toBeTruthy()
      expect(screen.queryByText('В архиве нет доступных договоров')).toBeNull()
      expect(calls.filter(call => call.path === endpoint).map(call => call.url)).toEqual(Array(4).fill(`${endpoint}?side=${side}`))
    } finally {
      status.mockRestore()
    }
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
    const calls = serve(base({ '/weddings/w1/slots': [helperSlot()], '/deals/d1/events': [] }))
    const r = await open('/deal/d1', 'Суммы и оплаты по сделке видит только пара.')
    const shown = text(r).replace(/[\u00a0\u202f]/g, ' ')
    expect(shown).not.toContain('0 ₽')
    expect(screen.queryByText('✓ Отметить оплату')).toBeNull()
    expect(screen.queryByText('Отменить сделку')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Аванс внесён' })).toBeNull()
    expect(shown).toContain('видит только пара')
    expect(shown).not.toContain('Что происходило')
    expect(calls.filter(c => c.path === '/deals/d1/events')).toEqual([])
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

  it('два явных человека семьи занимают два места: «2/2», третьего не сажает', async () => {
    const calls = serve(base({
      '/weddings/w1/guests': [
        { id: 'g1', name: 'Ольга', status: 'yes', plusOne: true, tableId: 'tb1', partyId: 'p1', partySize: 2, partyPosition: 1 },
        { id: 'g3', name: 'Денис', status: 'yes', plusOne: false, tableId: 'tb1', partyId: 'p1', partySize: 2, partyPosition: 2 },
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
    /* Фича 005: подпись называет оба числа `BroadcastResult` — «Команде ушло: N ·
       касается гостей: M» вместо «Команда уведомлена: N» (audit32, T10). */
    await waitFor(() => expect(text(r)).toContain('Команде ушло: 2'))
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
    /* Фича 005: та же подпись из двух чисел, что у точек сбора (audit32, T10). */
    await waitFor(() => expect(text(r)).toContain('Команде ушло'))
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

/* ── D3-18. Форма отзыва гостя получает состояние программы с сервера ──── */

describe('D3-18 отзыв гостя открывается по состоянию всей программы', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  /* Подменяем только часы: таймеры остаются настоящими, иначе `waitFor` не
     дождётся ни одного ответа. */
  const clock = (iso: string) => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(iso)) }

  const team = (tz: string, reviewsOpen: boolean) => ({
    '/gifts/tok1': { gifts: [], funds: [], antiGifts: [] },
    '/join/tok1/team': { weddingId: 'w1', weddingDate: '2027-06-14', tz, reviewsOpen,
      vendors: [{ vendorId: 'v1', name: 'Елена Фото', categoryId: 'photo' }] },
  })

  it('при отстающих часах форма открыта по ответу сервера', async () => {
    clock('2027-06-13T20:00:00.000Z')
    serve(team('Pacific/Kiritimati', true))
    const r = await open('/gifts', 'Как прошла свадьба?')
    expect(text(r)).toContain('Отправить отзыв гостя')
    expect(text(r)).not.toContain('Оценить команду можно после последнего мероприятия.')
  })

  it('при опережающих часах форма остаётся закрытой, пока сервер ждёт последнего события', async () => {
    clock('2027-06-18T05:00:00.000Z')
    serve(team('Pacific/Honolulu', false))
    const r = await open('/gifts', 'Как прошла свадьба?')
    expect(text(r)).toContain('Оценить команду можно после последнего мероприятия.')
    expect(text(r)).not.toContain('Отправить отзыв гостя')
  })

  it('после переноса закрывает форму, затем восстанавливает черновик на свежем разрешении', async () => {
    let allowed = true
    const calls = serve({
      ...team('UTC', true),
      '/join/tok1/team': () => team('UTC', allowed)['/join/tok1/team'],
      '/weddings/w1/guest-reviews': () => {
        allowed = false
        return withStatus(403, 'guest_review_not_open', 'Отзыв можно оставить после последнего мероприятия')
      },
    })
    await open('/gifts', 'Отправить отзыв гостя')
    fireEvent.click(screen.getByRole('button', { name: 'Елена Фото' }))
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    fireEvent.change(screen.getByPlaceholderText('Пара слов о впечатлениях (необязательно)'), { target: { value: 'Мой отзыв' } })
    fireEvent.click(screen.getByRole('button', { name: 'Отправить отзыв гостя' }))
    await screen.findByText('Оценить команду можно после последнего мероприятия.')
    expect(calls.filter(call => call.method === 'POST' && call.path === '/weddings/w1/guest-reviews')).toHaveLength(1)
    allowed = true
    act(() => window.dispatchEvent(new Event('focus')))
    expect(await screen.findByDisplayValue('Мой отзыв')).toBeTruthy()
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
    expect(csv).toContain('Name;Status;Family')
    expect(csv).toContain('Olga;Coming;yes')
    expect(csv).not.toContain('Имя')
    expect(csv).not.toContain(';да')
  })
})
