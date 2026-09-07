// @vitest-environment jsdom
/*
 * Админка платформы (фича 001): панель показывает только то, что ответил
 * сервер, и делает ровно то, что написано на кнопках.
 *
 * Четыре класса дыр, ради которых написан этот файл:
 *  — панель, открытая посторонним: 403 обязан оставлять на экране слова
 *    отказа и НИ ОДНОЙ цифры, иначе чужие показатели платформы утекают через
 *    вёрстку, которая «всё равно ничего не покажет»;
 *  — числа без ответа сервера: «0 жалоб» и «0 ₽» рядом с «Сервер недоступен»
 *    читаются как «жалоб нет» и «оборота нет» (R-178);
 *  — кнопка, обещающая санкцию, которой сервер не применяет: «Заблокировать»
 *    у жалобы на сообщение — ложь на кнопке (R-176, план «Хранение»);
 *  — сохранение справочника: `PUT` заменяет словарь ЦЕЛИКОМ, поэтому запрос
 *    не должен уходить раньше подтверждения, а тело — собираться от всего
 *    прочитанного, а не от того, что человек успел тронуть.
 *
 * Проверяется тело запроса и текст экрана, а не то, что нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { fmt } from '@/lib/money'

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
 * Сеть по таблице (приём из audit17) плюс журнал вызовов (приём из audit18):
 * ключ — путь без `/api` и без строки запроса. Незнакомый адрес получает 404 —
 * то, чего экран не запрашивал в этом сценарии, не дорисуется из «удобного»
 * ответа.
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
    const reply = routes[path]
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
     искать числа рано, там честное «Загружаем…». */
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

const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

const CATEGORIES = [{ id: 'photo', title: 'Фотограф', icon: '📷' }, { id: 'host', title: 'Ведущий', icon: '🎤' }]

const QUEUE = {
  items: [{
    id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа',
    verified: true, hasVideo: false, publishedAt: '2026-09-01T09:00:00.000Z',
  }],
  nextCursor: null,
}

const VENDOR = {
  id: 'v1', name: 'Фотостудия Свет', categoryId: 'photo', city: 'Уфа', verified: false,
  about: 'Снимаем свадьбы',
  media: [{ kind: 'photo', url: 'a' }, { kind: 'photo', url: 'b' }, { kind: 'video', url: 'c' }],
  packages: [{ id: 'p1', name: 'Базовый', price: { amount: 5_000_000, currency: 'RUB' } }],
}

const METRICS = {
  users: 12, weddings: 3, vendorsPublished: 7, moderationQueue: 2,
  complaintsOpen: 0, complaintsOverdue: 0, deals: 5,
  gmv: { amount: 125_000_000, currency: 'RUB' },
  cities: [{ city: 'Уфа', vendors: 51, launchReady: true }, { city: 'Сибай', vendors: 4, launchReady: false }],
}

/* ── US1. Отказ, отказ сервера и решение по анкете ─────────────────────── */

describe('панель сотрудника: посторонний не видит ни данных, ни чисел', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('403 на /admin — слова отказа и ни одной цифры', async () => {
    serve({ '/admin/metrics': FORBIDDEN })
    const { container } = await open('/admin', DENIED)
    const text = container.textContent ?? ''
    expect(text).toContain(DENIED)
    expect(digits(text), 'на закрытом экране остались числа платформы').toBe('')
    /* Ни разделов, ни подписей панели: раздел закрыт целиком. */
    expect(text).not.toContain('Модерация анкет')
  })

  it('403 на /admin/moderation — тот же отказ и ни одной цифры', async () => {
    serve({ '/admin/moderation/vendors': FORBIDDEN, '/catalog/categories': FORBIDDEN })
    const { container } = await open('/admin/moderation', DENIED)
    const text = container.textContent ?? ''
    expect(digits(text)).toBe('')
    expect(text).not.toContain('Очередь пуста')
  })

  it('сервер лежит — «Сервер недоступен», прочерки и ни одного «0 ₽»', async () => {
    serve({ '/admin/metrics': DOWN })
    const { container } = await open('/admin', SERVER_DOWN)
    const text = container.textContent ?? ''
    expect(text).toContain('—')
    expect(text).not.toContain('0 ₽')
    expect(text).not.toContain('0Жалоб открыто')
  })
})

describe('очередь модерации: карточка очереди говорит, что проверять', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('имя, категория словом, город, дата публикации и пометка «Верифицирован»', async () => {
    serve({ '/admin/moderation/vendors': QUEUE, '/catalog/categories': CATEGORIES })
    const { container } = await open('/admin/moderation', 'Фотостудия Свет')
    const text = container.textContent ?? ''
    /* Категория — подписью из справочника, а не кодом `photo`. */
    expect(text).toContain('Фотограф')
    expect(text).not.toContain('photo')
    expect(text).toContain('Уфа')
    expect(text).toContain('2026')
    expect(text).toContain('Верифицирован')
    expect(text).not.toContain('Очередь пуста')
  })
})

describe('решение по анкете уходит на сервер целиком', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Снять с публикации» неактивна без причины и шлёт {action, reason}', async () => {
    const calls = serve({
      '/catalog/vendors/v1': VENDOR,
      '/admin/moderation/vendors/v1': { vendorId: 'v1', action: 'reject' },
      '/admin/moderation/vendors': QUEUE,
      '/catalog/categories': CATEGORIES,
    })
    const { container } = await open('/admin/moderation/v1', 'Снять с публикации')
    /* Карточка каталога: то, что модератор и проверяет. */
    expect(container.textContent ?? '').toContain('Снимаем свадьбы')
    expect(container.textContent ?? '').toContain('2 фотографии')
    expect(container.textContent ?? '').toContain('1 ролик')
    expect(container.textContent ?? '').toContain(fmt(5_000_000))

    const reject = screen.getByText('Снять с публикации') as HTMLButtonElement
    expect(reject.disabled, 'снятие без причины подрядчику нечем исправить').toBe(true)
    fireEvent.click(reject)
    expect(calls.some(c => c.method === 'POST')).toBe(false)

    fireEvent.change(screen.getByLabelText('Причина снятия с публикации'), { target: { value: 'Чужие фотографии в портфолио' } })
    expect(reject.disabled).toBe(false)
    fireEvent.click(reject)

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/admin/moderation/vendors/v1')).toBe(true))
    expect(calls.find(c => c.method === 'POST' && c.path === '/admin/moderation/vendors/v1')!.body)
      .toEqual({ action: 'reject', reason: 'Чужие фотографии в портфолио' })
  })

  it('анкеты нет в каталоге — экран говорит это словами, а решения остаются', async () => {
    serve({ '/admin/moderation/vendors': QUEUE, '/catalog/categories': CATEGORIES })
    const { container } = await open('/admin/moderation/v1', 'Анкета недоступна в каталоге')
    const text = container.textContent ?? ''
    expect(text).toContain('Одобрить')
    expect(text).toContain('Отметить верифицированным')
    /* Загрузки документов нет — и экран об этом говорит, а не молчит (R-174). */
    expect(text).toContain('Документы сверяются вне приложения')
  })
})

describe('пункт «Админка» в меню «Мы» — только по ответу сервера', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('сотруднику пункт виден', async () => {
    serve({
      '/users/me': { id: 'u1', name: 'Аня', isStaff: true },
      '/users/me/referral': { code: 'ТИЛИ-КОД-1', invited: 0 },
    })
    const { container } = await open('/us', 'Админка')
    expect(container.textContent ?? '').toContain('Админка')
  })

  it('не сотруднику пункта нет', async () => {
    serve({
      '/users/me': { id: 'u1', name: 'Аня', isStaff: false },
      '/users/me/referral': { code: 'ТИЛИ-КОД-1', invited: 0 },
    })
    /* Ждём код рефералки: его запрос уходит перед профилем, значит признак
       сотрудника к этому моменту уже разобран. */
    const { container } = await open('/us', 'ТИЛИ-КОД-1')
    expect(container.textContent ?? '').toContain('Кабинет подрядчика')
    expect(container.textContent ?? '').not.toContain('Админка')
  })
})

/* ── US2. Жалобы: набор санкций, тело запроса, просрочка, повтор ───────── */

const complaint = (over: Partial<Record<string, unknown>>) => ({
  id: 'c1', targetKind: 'vendor', targetId: 'v1', category: 'fraud',
  text: 'Взял аванс и пропал', status: 'new', createdAt: iso(Date.now() - 2 * HOUR),
  ...over,
})

describe('жалобы: экран предлагает только то, что сервер применяет', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('набор кнопок зависит от цели жалобы', async () => {
    serve({
      '/admin/complaints': {
        items: [
          complaint({}),
          complaint({ id: 'c2', targetKind: 'review', targetId: 'r1', category: 'content', text: 'Мат в отзыве' }),
          complaint({ id: 'c3', targetKind: 'message', targetId: 'm1', category: 'spam', text: 'Реклама в переписке' }),
        ],
        nextCursor: null,
      },
    })
    const { container } = await open('/admin/complaints', 'Взял аванс и пропал')
    const text = container.textContent ?? ''

    /* Подрядчик — все четыре санкции. */
    expect(screen.getAllByText('Отклонить')).toHaveLength(3)
    expect(screen.getAllByText('Предупредить')).toHaveLength(3)
    expect(screen.getAllByText('Понизить в выдаче')).toHaveLength(1)
    expect(screen.getAllByText('Заблокировать')).toHaveLength(1)
    /* Отзыв — «скрыть», и это другое слово: скрывается текст, а не подрядчик. */
    expect(screen.getAllByText('Скрыть отзыв')).toHaveLength(1)
    /* Сообщение — только две, и экран объясняет почему. */
    expect(text).toContain('Иных санкций к сообщениям и сделкам сервер не применяет')
  })

  it('«Заблокировать» шлёт {action, note}', async () => {
    const calls = serve({
      '/admin/complaints': { items: [complaint({})], nextCursor: null },
      '/admin/complaints/c1': { complaintId: 'c1', action: 'block' },
    })
    await open('/admin/complaints', 'Взял аванс и пропал')
    fireEvent.change(screen.getByLabelText('Заметка сотрудника'), { target: { value: 'Третья жалоба за месяц' } })
    fireEvent.click(screen.getByText('Заблокировать'))

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/admin/complaints/c1')).toBe(true))
    expect(calls.find(c => c.method === 'POST' && c.path === '/admin/complaints/c1')!.body)
      .toEqual({ action: 'block', note: 'Третья жалоба за месяц' })
  })

  it('жалоба старше суток помечена «просрочено»', async () => {
    serve({ '/admin/complaints': { items: [complaint({ createdAt: iso(Date.now() - 30 * HOUR) })], nextCursor: null } })
    const { container } = await open('/admin/complaints', 'Взял аванс и пропал')
    expect(container.textContent ?? '').toContain('просрочено')
  })

  it('свежая жалоба пометки не получает (контроль)', async () => {
    serve({ '/admin/complaints': { items: [complaint({ createdAt: iso(Date.now() - 2 * HOUR) })], nextCursor: null } })
    const { container } = await open('/admin/complaints', 'Взял аванс и пропал')
    expect(container.textContent ?? '').not.toContain('просрочено')
  })

  it('второй модератор видит «уже разобрана», а не ошибку сервера', async () => {
    /* Решение по этой жалобе сервер уже принял: POST отвечает 404. */
    serve({ '/admin/complaints': { items: [complaint({})], nextCursor: null } })
    const { container } = await open('/admin/complaints', 'Взял аванс и пропал')
    fireEvent.click(screen.getByText('Отклонить'))
    await waitFor(() => expect(container.textContent ?? '').toContain('Жалоба уже разобрана'))
  })
})

/* ── US3. Дашборд ─────────────────────────────────────────────────────── */

describe('дашборд платформы: числа только с ответом сервера', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('до ответа — прочерки, ни одной цифры и ни одного «0 ₽»', async () => {
    serve({ '/admin/metrics': PENDING })
    const { container } = await open('/admin', 'Загружаем…')
    const text = container.textContent ?? ''
    expect(text).toContain('—')
    expect(digits(text), 'показатели платформы появились до ответа сервера').toBe('')
    expect(text).not.toContain('0 ₽')
  })

  it('после ответа — числа сервера, ноль как ноль, оборот рублями', async () => {
    serve({ '/admin/metrics': METRICS })
    const { container } = await open('/admin', 'Уфа')
    const text = container.textContent ?? ''
    expect(text).toContain('12Аккаунтов')
    expect(text).toContain('2Анкет в очереди')
    /* Ноль ПОСЛЕ ответа — это ноль, а не прочерк (R-178). */
    expect(text).toContain('0Жалоб открыто')
    expect(text).toContain('0Просрочено')
    expect(text).toContain(fmt(125_000_000))
    /* Города: готовность к запуску считает сервер, экран её только называет. */
    expect(text).toContain('51 анкета')
    expect(text).toContain('готов к запуску')
    expect(text).toContain('Сибай')
  })
})

/* ── US4. Категории и словарь синонимов ───────────────────────────────── */

const ADMIN_CATEGORIES = {
  categories: [
    { id: 'photo', title: 'Фотограф', icon: '📷', sort: 1 },
    { id: 'host', title: 'Ведущий', icon: '🎤', sort: 2 },
  ],
  synonyms: { тамада: 'host' },
}

describe('справочник категорий: словарь заменяется целиком и только по подтверждению', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('экран показывает то, что отдал сервер, а не пустые поля', async () => {
    serve({ '/admin/categories': ADMIN_CATEGORIES })
    await open('/admin/categories', 'Словарь синонимов')
    const titles = screen.getAllByLabelText('Название категории') as HTMLInputElement[]
    expect(titles.map(i => i.value)).toEqual(['Фотограф', 'Ведущий'])
    expect(screen.getByDisplayValue('тамада')).toBeTruthy()
    expect((screen.getByLabelText('Категория слова') as HTMLSelectElement).value).toBe('host')
  })

  it('до подтверждения запроса нет, Escape закрывает без запроса', async () => {
    const calls = serve({ '/admin/categories': ADMIN_CATEGORIES })
    await open('/admin/categories', 'Словарь синонимов')
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByText('Сохранить'))
    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    /* Число строк словаря названо: `PUT` заменит его целиком. */
    expect(dialog.textContent ?? '').toContain('1')
    /* Фокус на подтверждении: диалог, до которого не добраться с клавиатуры,
       на десктопе становится ловушкой (R-13). */
    expect(document.activeElement).toBe(within(dialog).getByText('Сохранить'))
    expect(calls.some(c => c.method === 'PUT'), 'запрос ушёл до подтверждения').toBe(false)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('подтверждение шлёт полное тело: все категории и весь словарь', async () => {
    const calls = serve({ '/admin/categories': ADMIN_CATEGORIES })
    await open('/admin/categories', 'Словарь синонимов')
    fireEvent.change(screen.getByDisplayValue('тамада'), { target: { value: 'Тамада' } })
    fireEvent.click(screen.getByText('Сохранить'))
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Сохранить'))

    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.path === '/admin/categories')).toBe(true))
    expect(calls.find(c => c.method === 'PUT')!.body).toEqual({
      categories: [
        { id: 'photo', title: 'Фотограф', icon: '📷', sort: 1 },
        { id: 'host', title: 'Ведущий', icon: '🎤', sort: 2 },
      ],
      /* Слово уходит в нижнем регистре: поиск не должен зависеть от того,
         с какой буквы его записал сотрудник. */
      synonyms: { тамада: 'host' },
    })
  })
})

/* ── US5. Карточка свадьбы по обращению ───────────────────────────────── */

describe('карточка свадьбы: без причины сервер не спрашивается', () => {
  beforeEach(staff)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('кнопка неактивна с короткой причиной, запрос уходит с reason в строке запроса', async () => {
    const calls = serve({
      '/admin/weddings/w9': {
        id: 'w9', title: 'Аня и Боря', date: '2027-06-14', city: 'Уфа',
        style: 'рустик', guestsPlanned: 40, createdAt: '2026-01-05T10:00:00.000Z',
      },
    })
    const { container } = await open('/admin/wedding', 'Открыть карточку')
    const button = screen.getByText('Открыть карточку') as HTMLButtonElement

    fireEvent.change(screen.getByLabelText('Идентификатор свадьбы'), { target: { value: 'w9' } })
    fireEvent.change(screen.getByLabelText('Зачем смотрим'), { target: { value: 'тик' } })
    expect(button.disabled, 'причина короче пяти знаков сервером не принимается').toBe(true)
    fireEvent.click(button)
    expect(calls.some(c => c.path === '/admin/weddings/w9')).toBe(false)

    fireEvent.change(screen.getByLabelText('Зачем смотрим'), { target: { value: 'обращение 118' } })
    expect(button.disabled).toBe(false)
    fireEvent.click(button)

    await waitFor(() => expect(calls.some(c => c.path === '/admin/weddings/w9')).toBe(true))
    const sent = calls.find(c => c.path === '/admin/weddings/w9')!
    expect(decodeURIComponent(sent.url)).toContain('reason=обращение 118')

    await waitFor(() => expect(container.textContent ?? '').toContain('Аня и Боря'))
    const text = container.textContent ?? ''
    expect(text).toContain('Уфа')
    expect(text).toContain('рустик')
    expect(text).toContain('40')
    /* Ни бюджета, ни гостей, ни переписки — карточка, а не свадьба целиком. */
    expect(text).toContain('Бюджет, список гостей и переписка поддержке не показываются.')
  })
})
