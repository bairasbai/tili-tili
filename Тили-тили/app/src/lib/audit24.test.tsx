// @vitest-environment jsdom
/*
 * Очередь заявок на верификацию (фича 002): документы разбираются по одному,
 * с записью в журнал, и решение по документам не путается с решением по анкете.
 *
 * Пять классов дыр, ради которых написан этот файл:
 *  — панель, открытая посторонним: 403 обязан оставлять на экране слова
 *    отказа и НИ ОДНОЙ цифры — иначе очередь платформы утекает через вёрстку,
 *    которая «всё равно ничего не покажет»;
 *  — «Заявок нет» до ответа сервера: рядом с лежащим сервером это читается как
 *    «разбирать нечего», и документы стоят непроверенными (R-178);
 *  — отказ без причины: подрядчику нечего исправлять, а сервер такой запрос и
 *    не принимает — кнопка обязана быть неактивной, а не падать с 422 (R-176);
 *  — вторая новость об одном и том же: двое сотрудников открыли одну заявку, и
 *    опоздавший должен увидеть, что опоздал, а не «ошибку сервера»;
 *  — экран подрядчика, который молчит: галочки нет — и гадай, дошли документы
 *    или нет. Статус приходит с сервера и до ответа не показывается.
 *
 * Проверяется тело запроса и текст экрана, а не то, что нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')
/* Ответ, которого ещё нет: запрос ушёл и висит. Так проверяется «до ответа». */
const PENDING = Symbol('pending')

/** Ответ со своим кодом: отказ по правам, «не найдено» и прочие честные не-200. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } } })
const FORBIDDEN = withStatus(403, 'forbidden', 'Доступ закрыт')

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/*
 * Сеть по таблице плюс журнал вызовов (приём из `audit23.test.tsx`): ключ —
 * путь без `/api` и без строки запроса. Незнакомый адрес получает 404 — то,
 * чего экран не запрашивал в этом сценарии, не дорисуется из «удобного» ответа.
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
    /* Ответ может зависеть от метода: GET и POST одного пути — один ключ таблицы. */
    const reply = typeof stored === 'function' ? (stored as (c: Call) => unknown)(calls[calls.length - 1]!) : stored
    if (reply === DOWN) return Promise.reject(new TypeError('Failed to fetch'))
    if (reply === PENDING) return new Promise<Response>(() => {})
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

/** Слово, которым экран называет упавшую сеть, и общий отказ панели. */
const SERVER_DOWN = 'Сервер недоступен'
const DENIED = 'Раздел для сотрудников платформы'

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull())
  /* Ждём слово, которым экран отчитывается о завершении запроса: до него
     искать содержимое рано, там честное «Загружаем…». */
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

/** Все цифры экрана одной строкой: пусто — значит их и правда нет. */
const digits = (s: string) => s.replace(/\D+/g, '')

const staff = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'r1', vendorId: 'v1', vendorName: 'Фотостудия Свет', kind: 'ip',
  hasFile: true, createdAt: '2026-09-01T09:00:00.000Z',
  ...over,
})

const card = (over: Record<string, unknown> = {}) => ({
  id: 'r1', vendorId: 'v1', vendorName: 'Фотостудия Свет', vendorPublished: true,
  kind: 'ip', fileUrl: 'https://storage.example/doc.pdf', inn: '0276123456',
  status: 'pending', createdAt: '2026-09-01T09:00:00.000Z', checkedAt: null,
  ...over,
})

/* ── US1. Очередь: отказ, пустота и строка заявки ──────────────────────── */

describe('очередь заявок: посторонний не видит ни заявок, ни чисел', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('403 — слова отказа и ни одной цифры', async () => {
    serve({ '/admin/verifications': FORBIDDEN })
    const { container } = await open('/admin/verifications', DENIED)
    const text = container.textContent ?? ''
    expect(text).toContain(DENIED)
    expect(digits(text), 'на закрытом экране остались числа очереди').toBe('')
    /* Ни «Заявок нет», ни «Показать ещё»: раздел закрыт целиком. */
    expect(text).not.toContain('Заявок нет')
    expect(text).not.toContain('Показать ещё')
  })

  it('сервер лежит — «Сервер недоступен», а не «Заявок нет»', async () => {
    serve({ '/admin/verifications': DOWN })
    const { container } = await open('/admin/verifications', SERVER_DOWN)
    expect(container.textContent ?? '').not.toContain('Заявок нет')
  })
})

describe('пустая очередь: «Заявок нет» — только утверждение сервера', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('до ответа сервера пустоты на экране нет', async () => {
    serve({ '/admin/verifications': PENDING })
    const { container } = await open('/admin/verifications', 'Загружаем…')
    expect(container.textContent ?? '', 'пустая очередь показана до ответа сервера').not.toContain('Заявок нет')
  })

  it('после пустого ответа — «Заявок нет»', async () => {
    serve({ '/admin/verifications': { items: [], nextCursor: null } })
    const { container } = await open('/admin/verifications', 'Заявок нет')
    expect(container.textContent ?? '').toContain('Заявок нет')
  })
})

describe('строка очереди говорит, что проверять', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('имя подрядчика, вид документа словами и дата подачи', async () => {
    serve({ '/admin/verifications': { items: [item()], nextCursor: null } })
    const { container } = await open('/admin/verifications', 'Фотостудия Свет')
    const text = container.textContent ?? ''
    /* Вид документа — словом, а не кодом контракта. */
    expect(text).toContain('ИП')
    expect(text).not.toContain('ip')
    expect(text).toContain('2026')
    /* Документ приложен — пометки об обратном нет. */
    expect(text).not.toContain('документ не приложен')
    /* Ни ссылки, ни ИНН: их отдаёт только карточка и только под журнал. */
    expect(text).not.toContain('0276123456')
  })

  it('заявка без документа помечена словами', async () => {
    serve({ '/admin/verifications': { items: [item({ hasFile: false })], nextCursor: null } })
    const { container } = await open('/admin/verifications', 'Фотостудия Свет')
    expect(container.textContent ?? '').toContain('документ не приложен')
  })

  it('вторая страница ложится под первой, а не вместо неё', async () => {
    const page1 = { items: [item()], nextCursor: 'c2' }
    const page2 = { items: [item({ id: 'r2', vendorId: 'v2', vendorName: 'Ведущий Марат' })], nextCursor: null }
    const calls = serve({ '/admin/verifications': (c: Call) => (c.url.includes('cursor=c2') ? page2 : page1) })
    const { container } = await open('/admin/verifications', 'Фотостудия Свет')
    expect(container.textContent ?? '').not.toContain('Ведущий Марат')

    fireEvent.click(screen.getByText('Показать ещё'))
    await waitFor(() => expect(container.textContent ?? '').toContain('Ведущий Марат'))
    /* Просмотренное глазами остаётся на экране: страницы копятся. */
    expect(container.textContent ?? '').toContain('Фотостудия Свет')
    expect(screen.queryByText('Показать ещё'), 'сервер сказал, что больше нет, а кнопка осталась').toBeNull()
    expect(
      calls.some(c => c.path === '/admin/verifications' && c.url.includes('cursor=c2')),
      'вторая страница запрошена без курсора — это снова первая',
    ).toBe(true)
  })
})

/* ── US1. Карточка: документ, решения, гонка ──────────────────────────── */

describe('карточка заявки: документ открывается отдельно от приложения', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('ссылка ведёт в хранилище и открывается в новой вкладке', async () => {
    serve({ '/admin/verifications/r1': card() })
    const { container } = await open('/admin/verifications/r1', 'Открыть документ')
    const link = screen.getByLabelText('Открыть документ в новой вкладке') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('https://storage.example/doc.pdf')
    expect(link.getAttribute('target'), 'документ открылся бы поверх панели').toBe('_blank')
    expect(link.getAttribute('rel') ?? '').toContain('noopener')
    const text = container.textContent ?? ''
    /* Карточка — единственное место, где ИНН выходит наружу. */
    expect(text).toContain('0276123456')
    expect(text).toContain('ИП')
    expect(text).toContain('2026')
  })

  it('документа нет — карточка говорит это словами, а ссылки нет', async () => {
    serve({ '/admin/verifications/r1': card({ fileUrl: null, inn: null }) })
    const { container } = await open('/admin/verifications/r1', 'Документ не приложен')
    expect(screen.queryByLabelText('Открыть документ в новой вкладке')).toBeNull()
    /* ИНН тоже может отсутствовать — и тогда это сказано, а не пустое место. */
    expect(container.textContent ?? '').toContain('ИНН не указан')
  })

  it('404 — «заявка не найдена» и ни одной кнопки решения', async () => {
    serve({ '/admin/verifications/r1': withStatus(404, 'not_found', 'Заявки нет') })
    const { container } = await open('/admin/verifications/r1', 'не найдена')
    expect(container.textContent ?? '').toContain('Заявка на верификацию не найдена')
    expect(screen.queryByText('Подтвердить документы')).toBeNull()
    expect(screen.queryByText('Отклонить документы')).toBeNull()
  })

  it('403 — отказ и ни одной цифры карточки', async () => {
    serve({ '/admin/verifications/r1': FORBIDDEN })
    const { container } = await open('/admin/verifications/r1', DENIED)
    const text = container.textContent ?? ''
    expect(digits(text), 'на закрытом экране остались ИНН и дата заявки').toBe('')
    expect(screen.queryByText('Подтвердить документы')).toBeNull()
  })
})

describe('решение по документам уходит на сервер целиком', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Отклонить документы» неактивна без причины и шлёт {action, reason}', async () => {
    const calls = serve({
      '/admin/verifications/r1': (c: Call) => (c.method === 'POST' ? { requestId: 'r1', action: 'reject' } : card()),
      '/admin/verifications': { items: [], nextCursor: null },
    })
    await open('/admin/verifications/r1', 'Отклонить документы')

    const reject = screen.getByText('Отклонить документы') as HTMLButtonElement
    expect(reject.disabled, 'отказ без причины подрядчику нечем исправить').toBe(true)
    fireEvent.click(reject)
    expect(calls.some(c => c.method === 'POST')).toBe(false)

    /* Пробелы причиной не считаются: сервер их тоже не примет. */
    fireEvent.change(screen.getByLabelText('Причина отказа по документам'), { target: { value: '   ' } })
    expect(reject.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Причина отказа по документам'), { target: { value: 'Скан нечитаемый' } })
    expect(reject.disabled).toBe(false)
    fireEvent.click(reject)

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/admin/verifications/r1')).toBe(true))
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ action: 'reject', reason: 'Скан нечитаемый' })
  })

  it('«Подтвердить документы» шлёт {action: approve} и возвращает в очередь', async () => {
    const calls = serve({
      '/admin/verifications/r1': (c: Call) => (c.method === 'POST' ? { requestId: 'r1', action: 'approve' } : card()),
      '/admin/verifications': { items: [], nextCursor: null },
    })
    const { container } = await open('/admin/verifications/r1', 'Подтвердить документы')
    fireEvent.click(screen.getByText('Подтвердить документы'))

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/admin/verifications/r1')).toBe(true))
    expect(calls.find(c => c.method === 'POST')!.body).toEqual({ action: 'approve' })
    /* Разобранная заявка не остаётся на экране: сотрудник возвращается в очередь. */
    await waitFor(() => expect(container.textContent ?? '').toContain('Заявок нет'))
  })

  it('второй сотрудник видит «уже разобрана» и возвращается в очередь', async () => {
    /* Решение по этой заявке уже принято: POST отвечает 409. Ответ задан явно —
       на заглушке «незнакомый адрес» тест проходил бы и в том случае, если бы
       решение ушло не по адресу заявки.
       Текст сервера нарочно другой: слова «уже разобрана» должен сказать сам
       экран, иначе тест зелен от пересказа чужого сообщения. */
    const calls = serve({
      '/admin/verifications/r1': (c: Call) => (c.method === 'POST'
        ? withStatus(409, 'verification_not_pending', 'состояние заявки не pending')
        : card()),
      '/admin/verifications': { items: [], nextCursor: null },
    })
    const { container } = await open('/admin/verifications/r1', 'Подтвердить документы')
    fireEvent.click(screen.getByText('Подтвердить документы'))

    await waitFor(() => expect(container.textContent ?? '').toContain('Заявка уже разобрана'))
    /* Карточки больше нет: решать по ней нечего, и сотрудник уже в очереди.
       Ждём именно ответ очереди: переход происходит раньше, чем она загрузится. */
    await waitFor(() => expect(container.textContent ?? '').toContain('Заявок нет'))
    expect(screen.queryByText('Подтвердить документы')).toBeNull()
    expect(
      calls.some(c => c.method === 'POST' && c.path === '/admin/verifications/r1'),
      'решение ушло не по адресу заявки',
    ).toBe(true)
  })
})

describe('анкета и документы — разные решения', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('анкета не опубликована — перехода к ней нет, а решение не задерживается', async () => {
    serve({ '/admin/verifications/r1': card({ vendorPublished: false }) })
    const { container } = await open('/admin/verifications/r1', 'Подтвердить документы')
    expect(screen.queryByText('Открыть анкету →'), 'переход ведёт на анкету вне каталога').toBeNull()
    expect(container.textContent ?? '').toContain('Анкета не опубликована — решение по документам это не задерживает')
    /* Решения на месте: документы от публикации не зависят. */
    expect(screen.getByText('Подтвердить документы')).toBeTruthy()
  })

  it('анкета в каталоге — переход к ней есть', async () => {
    serve({ '/admin/verifications/r1': card() })
    await open('/admin/verifications/r1', 'Подтвердить документы')
    expect(screen.getByText('Открыть анкету →')).toBeTruthy()
  })
})

/* ── US2. Экран подрядчика: три статуса и молчание до ответа ───────────── */

const PROFILE = { id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false }

const vendorRoutes = (verification: unknown, profile: unknown = PROFILE) => ({
  '/vendor/profile': profile,
  '/vendor/verification': verification,
})

describe('кабинет подрядчика: статус заявки приходит с сервера', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('заявка на проверке — дата подачи словами, выбора «Кто вы» нет', async () => {
    serve(vendorRoutes({ status: 'pending', kind: 'ip', submittedAt: '2026-09-01T09:00:00.000Z', checkedAt: null }))
    const { container } = await open('/vendor-app/verification', 'Заявка на проверке с')
    const text = container.textContent ?? ''
    expect(text).toContain('2026')
    /* Выбирать вид документа поздно: заявка уже в очереди. */
    expect(text).not.toContain('Кто вы')
    expect(text).not.toContain('Загрузка документов пока не подключена')
  })

  it('документы не подтверждены — дата решения и переход в уведомления', async () => {
    serve(vendorRoutes({ status: 'rejected', kind: 'ip', submittedAt: '2026-09-01T09:00:00.000Z', checkedAt: '2026-09-05T10:00:00.000Z' }))
    const { container } = await open('/vendor-app/verification', 'Документы не подтверждены')
    const text = container.textContent ?? ''
    expect(text).toContain('Причина — в уведомлениях.')
    expect(screen.getByText('Открыть уведомления')).toBeTruthy()
    expect(text).not.toContain('Вы проверены')
  })

  it('документы подтверждены — «Вы проверены», даже если галочки в анкете ещё нет', async () => {
    serve(vendorRoutes({ status: 'approved', kind: 'ip', submittedAt: '2026-09-01T09:00:00.000Z', checkedAt: '2026-09-05T10:00:00.000Z' }))
    const { container } = await open('/vendor-app/verification', 'Вы проверены')
    expect(container.textContent ?? '').not.toContain('Кто вы')
  })

  it('без ответа о заявке — ни одного статуса на экране', async () => {
    serve(vendorRoutes(PENDING))
    const { container } = await open('/vendor-app/verification', 'Кто вы')
    const text = container.textContent ?? ''
    expect(text, 'статус заявки показан до ответа сервера').not.toContain('Заявка на проверке с')
    expect(text).not.toContain('Документы не подтверждены')
    expect(text).not.toContain('Вы проверены')
  })

  it('заявок не подавали — текущий экран без статусов', async () => {
    serve(vendorRoutes({ status: 'none', kind: null, submittedAt: null, checkedAt: null }))
    const { container } = await open('/vendor-app/verification', 'Кто вы')
    const text = container.textContent ?? ''
    expect(text).not.toContain('Заявка на проверке с')
    expect(text).not.toContain('Документы не подтверждены')
  })
})

/* ── US3. Дашборд: показатель очереди заявок ──────────────────────────── */

const METRICS = {
  users: 12, weddings: 3, vendorsPublished: 7, moderationQueue: 2,
  verificationQueue: 4, complaintsOpen: 0, complaintsOverdue: 0, deals: 5,
  gmv: { amount: 125_000_000, currency: 'RUB' },
  cities: [{ city: 'Уфа', vendors: 51, launchReady: true }],
}

describe('дашборд: заявки на верификацию считает сервер', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('до ответа — прочерк и ни одной цифры', async () => {
    serve({ '/admin/metrics': PENDING })
    const { container } = await open('/admin', 'Загружаем…')
    const text = container.textContent ?? ''
    expect(text).toContain('Заявок на верификацию')
    expect(text).toContain('—')
    expect(digits(text), 'показатели платформы появились до ответа сервера').toBe('')
  })

  it('после ответа — число сервера и вход в очередь', async () => {
    serve({ '/admin/metrics': METRICS })
    const { container } = await open('/admin', 'Уфа')
    expect(container.textContent ?? '').toContain('4Заявок на верификацию')
    /* Раздел панели ведёт в очередь: иначе заявки лежат незамеченными. */
    expect(screen.getByText('Заявки на проверку документов: подтвердить или отклонить с причиной')).toBeTruthy()
  })

  it('раздел «Верификация» открывает очередь', async () => {
    const calls = serve({ '/admin/metrics': METRICS, '/admin/verifications': { items: [], nextCursor: null } })
    const { container } = await open('/admin', 'Уфа')
    fireEvent.click(screen.getByText('Заявки на проверку документов: подтвердить или отклонить с причиной'))
    await waitFor(() => expect(container.textContent ?? '').toContain('Заявок нет'))
    expect(calls.some(c => c.path === '/admin/verifications')).toBe(true)
  })
})
