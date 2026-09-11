// @vitest-environment jsdom
/*
 * Отмена свадьбы и жизнь приложения после неё (фича 003).
 *
 * Пять классов дыр, ради которых написан этот файл:
 *  — отмена чужой свадьбы: помощник и координатор состоят в проекте, но
 *    отменять его им нечем. Кнопка, показанная «на всякий случай», это
 *    предложение действия, права на которое сервер не давал;
 *  — необратимое одним нажатием: брони снимаются, даты уходят подрядчикам, и
 *    вернуть их нельзя. Первое нажатие обязано ничего не отправлять;
 *  — второе нажатие, которое оказалось исполнением: если отмену уже запросил
 *    партнёр, сервер исполнит её сразу, и человек должен прочитать об этом ДО
 *    нажатия, а не узнать по снятым броням (FR-002);
 *  — приложение, застрявшее на отменённой свадьбе: телефон помнит проект,
 *    которого больше нет, и каждый экран получает «не найдено» — своё после
 *    нажатия, чужое при следующем запуске (FR-004, FR-005);
 *  — «свадьба пропала» из-за упавшей сети: отказ `GET /weddings` не отличается
 *    от честного «у вас больше нет свадеб», если не различить их явно.
 *
 * Проверяется то, что ушло на сервер, и то, что осталось на устройстве, а не
 * то, что нарисовал обработчик.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { StoreProvider, useStore } from './store'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')
/* Ответ, которого ещё нет: запрос ушёл и висит. Так проверяется «до ответа». */
const PENDING = Symbol('pending')

/** Ответ со своим кодом: отказ по правам, «не найдено» и прочие честные не-200. */
const withStatus = (status: number, code: string, message: string) =>
  ({ __status: status, body: { error: { code, message } } })

function isStatus(v: unknown): v is { __status: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__status' in v
}

/*
 * Сеть по таблице плюс журнал вызовов (приём из `audit24.test.tsx`): ключ —
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

/** Слово, которым экран называет упавшую сеть. */
const SERVER_DOWN = 'Сервер недоступен'

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  /* Ждём слово, которым экран отчитывается о завершении запроса: до него
     искать содержимое рано, там честное «Загружаем…». */
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

/*
 * Отсутствие проверяется ожиданием, а не мгновенным взглядом.
 *
 * Ответ сервера доходит до экрана не в том же такте, в котором ушёл запрос:
 * «сейчас кнопки нет» ничего не доказывает, если данные о роли ещё в пути.
 * `findByText` ждёт секунду и отклоняется, только не дождавшись, — это и есть
 * утверждение «не появилось».
 */
const neverShows = async (text: string) => {
  await expect(screen.findByText(text)).rejects.toBeTruthy()
}

/** Пара с одной свадьбой: вошли, свадьба выбрана, онбординг пройден. */
const couple = () => {
  localStorage.clear()
  localStorage.setItem('tt_onboarded', '1')
  localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  /* Кэш даты — тот, по которому главная считает «дней до». Живёт ровно
     столько же, сколько идентификатор: после отмены он обязан уйти. */
  localStorage.setItem('tt_wedding_date', JSON.stringify('2027-11-06'))
}

/** Что помнит устройство: `null` и «ключа нет» для нас одно и то же. */
const rememberedWedding = (): string | null =>
  JSON.parse(localStorage.getItem('tt_wedding_id') ?? 'null') as string | null
const rememberedDate = (): string | null =>
  JSON.parse(localStorage.getItem('tt_wedding_date') ?? 'null') as string | null

const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', push: {}, quietHours: null }

const member = (id: string, role: string) =>
  ({ user: { id, name: id === 'u1' ? 'Аня' : 'Боря' }, role, joinedAt: '2026-01-01T00:00:00.000Z' })

/** Свадьба, как её отдаёт `GET /weddings/{id}`: роли — в `members`. */
const wedding = (over: Record<string, unknown> = {}) => ({
  id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14',
  city: { name: 'Уфа', region: 'Башкортостан' }, tz: 'Asia/Yekaterinburg',
  members: [member('u1', 'couple'), member('u2', 'couple')],
  ...over,
})

/* Всё, что читает экран настроек и стор при запуске. Свадьба подставляется. */
const settingsRoutes = (w: Record<string, unknown>): Routes => ({
  '/users/me': ME,
  '/users/me/sessions': [],
  '/weddings': [{ ...w, role: 'couple' }],
  '/weddings/w1': w,
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/notifications': [],
})

/* ── US1. Кнопка отмены: кому она есть и во что обходится ──────────────── */

describe('отмена свадьбы: кнопка только у пары', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('помощнику кнопки нет вовсе', async () => {
    serve(settingsRoutes(wedding({ members: [member('u1', 'helper'), member('u2', 'couple')] })))
    await open('/settings', 'Выйти со всех устройств')
    await neverShows('Отменить свадьбу')
    /* И предупреждения о запросе партнёра тоже: чужая отмена — не его дело. */
    expect(screen.queryByText(/Партнёр уже запросил отмену/)).toBeNull()
  })

  it('до ответа сервера о роли кнопки нет', async () => {
    serve({ ...settingsRoutes(wedding()), '/weddings/w1': PENDING })
    await open('/settings', 'Выйти со всех устройств')
    await neverShows('Отменить свадьбу')
  })

  it('паре кнопка есть, и первое нажатие ничего не отправляет', async () => {
    const calls = serve({
      ...settingsRoutes(wedding()),
      '/weddings/w1/cancel': { state: 'confirmation_required', requestedBy: 'u1' },
    })
    await open('/settings', 'Отменить свадьбу')

    fireEvent.click(screen.getByText('Отменить свадьбу'))
    /* Первое нажатие — только предупреждение. Брони на месте. */
    expect(calls.some(c => c.method === 'POST'), 'отмена ушла с первого нажатия').toBe(false)
    expect(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам')).toBeTruthy()

    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/weddings/w1/cancel')).toBe(true))
  })
})

describe('первый запрос: ждём второго партнёра, свадьба живёт', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('ответ confirmation_required — срок 72 часа на экране, свадьба на устройстве', async () => {
    serve({
      ...settingsRoutes(wedding()),
      '/weddings/w1/cancel': { state: 'confirmation_required', requestedBy: 'u1' },
    })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    expect(await screen.findByText('Ждём подтверждения партнёра — запрос действует 72 часа')).toBeTruthy()
    /* Свадьба не отменена: ни забывать её, ни объявлять отменённой нельзя. */
    expect(rememberedWedding()).toBe('w1')
    expect(screen.queryByText('Свадьба отменена')).toBeNull()
  })

  it('запрос партнёра назван словами до всякого нажатия', async () => {
    serve(settingsRoutes(wedding({ cancelRequestedBy: 'u2', cancelRequestedAt: '2026-09-07T10:00:00.000Z' })))
    await open('/settings', 'Отменить свадьбу')
    /* Предупреждение стоит рядом с кнопкой, а не появляется после нажатия:
       нажатие здесь исполнит отмену, а не запросит её. */
    expect(screen.getByText('Партнёр уже запросил отмену — ваше нажатие исполнит её: брони снимутся, даты уйдут подрядчикам')).toBeTruthy()
  })

  it('свой же запрос предупреждением не считается', async () => {
    serve(settingsRoutes(wedding({ cancelRequestedBy: 'u1', cancelRequestedAt: '2026-09-07T10:00:00.000Z' })))
    await open('/settings', 'Отменить свадьбу')
    expect(screen.queryByText(/Партнёр уже запросил отмену/)).toBeNull()
  })
})

describe('отмена исполнена: устройство забывает свадьбу сразу', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('ответ cancelled — «Свадьба отменена», tt_wedding_id пуст, кнопка ведёт в квиз', async () => {
    serve({
      ...settingsRoutes(wedding({ cancelRequestedBy: 'u2', cancelRequestedAt: '2026-09-07T10:00:00.000Z' })),
      '/weddings/w1/cancel': { state: 'cancelled', cancelledDeals: 2 },
    })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    expect(await screen.findByText('Свадьба отменена')).toBeTruthy()
    /* Иначе каждый экран до следующего запуска получит «не найдено». */
    await waitFor(() => expect(rememberedWedding()).toBeNull())
    /* И кэш даты — вместе с идентификатором: живая проверка показала главную
       с «424 дня до» свадьбы, которой больше нет. */
    await waitFor(() => expect(rememberedDate()).toBeNull())

    fireEvent.click(screen.getByText('Начать новую свадьбу'))
    expect(await screen.findByText('Когда ваша свадьба?')).toBeTruthy()
  })

  it('сервер отказал — его словами, а не «Сервер недоступен»', async () => {
    /* Роль могла смениться между загрузкой экрана и нажатием: сервер решает
       заново и объясняет отказ сам. Подменять его текст «сервер недоступен»
       значит выдавать отказ за поломку. */
    serve({
      ...settingsRoutes(wedding()),
      '/weddings/w1/cancel': withStatus(403, 'forbidden', 'Отменить свадьбу может только пара'),
    })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    expect(await screen.findByText('Отменить свадьбу может только пара')).toBeTruthy()
    expect(rememberedWedding()).toBe('w1')
  })

  it('сервер недоступен — причина под кнопкой, свадьба на месте', async () => {
    serve({ ...settingsRoutes(wedding()), '/weddings/w1/cancel': DOWN })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain(SERVER_DOWN))
    expect(rememberedWedding(), 'свадьба забыта после неудавшейся отмены').toBe('w1')
    expect(screen.queryByText('Свадьба отменена')).toBeNull()
  })

  /*
   * Неудача возвращает кнопку в исходное состояние.
   *
   * Взведённое «Подтвердить отмену» рядом с сообщением об отказе — это
   * необратимое действие, оставленное под пальцем: человек читает ошибку,
   * нажимает туда же «ещё раз» — и при следующем удачном ответе свадьбы нет,
   * а второго предупреждения он не видел. Шаг подтверждения одноразовый:
   * не сработало — начинаем с начала.
   */
  const rearmed = () => screen.queryByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам')

  it('сервер недоступен — кнопка снова «Отменить свадьбу», а не взведённая', async () => {
    serve({ ...settingsRoutes(wedding()), '/weddings/w1/cancel': DOWN })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    await waitFor(() => expect(screen.getByRole('alert').textContent ?? '').toContain(SERVER_DOWN))
    expect(rearmed(), 'подтверждение осталось взведённым после неудачи').toBeNull()
    expect(screen.getByText('Отменить свадьбу')).toBeTruthy()
  })

  it('403 — кнопка тоже разряжается, отказ остаётся на экране', async () => {
    serve({
      ...settingsRoutes(wedding()),
      '/weddings/w1/cancel': withStatus(403, 'forbidden', 'Отменить свадьбу может только пара'),
    })
    await open('/settings', 'Отменить свадьбу')
    fireEvent.click(screen.getByText('Отменить свадьбу'))
    fireEvent.click(screen.getByText('Подтвердить отмену — брони снимутся, даты уйдут подрядчикам'))

    expect(await screen.findByText('Отменить свадьбу может только пара')).toBeTruthy()
    expect(rearmed(), 'подтверждение осталось взведённым после отказа').toBeNull()
    expect(screen.getByText('Отменить свадьбу')).toBeTruthy()
  })
})

/* ── US2. Помнимая свадьба сверяется с сервером при запуске ────────────── */

function WeddingProbe() {
  const { weddingId } = useStore()
  return <span data-testid="wid">{weddingId ?? '—'}</span>
}

const mountStore = () => render(<MemoryRouter><StoreProvider><WeddingProbe /></StoreProvider></MemoryRouter>)

/** Идентификатор не тронут: секунда ожидания перемены, которой быть не должно. */
const staysAt = async (id: string) => {
  await expect(waitFor(() => expect(screen.getByTestId('wid').textContent).not.toBe(id))).rejects.toBeTruthy()
  expect(rememberedWedding()).toBe(id)
}

describe('запуск приложения: помнимая свадьба сверяется со списком', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('помнимой свадьбы в списке нет — берётся своя из ответа сервера', async () => {
    /* Так выглядит отмена с другого устройства: `GET /weddings` отдаёт только
       живые проекты, и `w1` в ответе больше нет. */
    serve({
      '/weddings': [{ id: 'w9', title: 'Чужая', role: 'helper' }, { id: 'w2', title: 'Наша', role: 'couple' }],
      '/me/favorites': [],
    })
    mountStore()
    await waitFor(() => expect(screen.getByTestId('wid').textContent).toBe('w2'))
    expect(rememberedWedding()).toBe('w2')
  })

  it('свадеб у человека не осталось — устройство забывает свою', async () => {
    serve({ '/weddings': [], '/me/favorites': [] })
    mountStore()
    await waitFor(() => expect(screen.getByTestId('wid').textContent).toBe('—'))
    expect(rememberedWedding()).toBeNull()
    /* Отмена с другого устройства: этот телефон узнаёт о ней сверкой при
       запуске — и кэш даты уходит вместе с идентификатором. */
    await waitFor(() => expect(rememberedDate()).toBeNull())
  })

  it('помнимая свадьба в списке есть — идентификатор не трогается', async () => {
    /* Своих свадеб две, и первой в ответе идёт не та, что открыта на
       устройстве: сверка отвечает на вопрос «жива ли эта», а не «какую
       выбрать» — иначе запуск приложения переключал бы пару на чужой проект. */
    serve({
      '/weddings': [{ id: 'w9', title: 'Вторая', role: 'couple' }, { ...wedding(), role: 'couple' }],
      '/weddings/w1': wedding(), '/weddings/w1/slots': [], '/me/favorites': [],
    })
    mountStore()
    await staysAt('w1')
    /* Свадьба жива — дата на устройстве остаётся (её обновит сервер, а не сотрёт сверка). */
    expect(rememberedDate()).not.toBeNull()
  })

  it('сервер недоступен — свадьба остаётся, а не «пропадает»', async () => {
    serve({ '/weddings': DOWN, '/me/favorites': [] })
    mountStore()
    await staysAt('w1')
  })

  it('за запуск уходит ровно один запрос списка — даже когда свадьба сменилась', async () => {
    /* Смена идентификатора не должна тянуть за собой второй `GET /weddings`:
       список уже получен, а повторная сверка по устаревшему ответу стёрла бы
       свадьбу, созданную за это время квизом. */
    const calls = serve({
      '/weddings': [{ id: 'w2', title: 'Наша', role: 'couple' }],
      '/weddings/w2': wedding({ id: 'w2' }), '/weddings/w2/slots': [], '/me/favorites': [],
    })
    mountStore()
    await waitFor(() => expect(screen.getByTestId('wid').textContent).toBe('w2'))
    await staysAt('w2')
    expect(calls.filter(c => c.path === '/weddings').length).toBe(1)
  })
})

/* ── Главная без свадьбы: слова, а не нули ─────────────────────────────── */

/*
 * «0% готово · 0 гостей · 00 МЕС» на устройстве без свадьбы — не факты о
 * свадьбе, а её отсутствие (R-178). Пара после отмены и человек с новым
 * телефоном читают нули как «всё пропало». Экран обязан различать три
 * состояния: список свадеб ещё в пути, список не пришёл, список пришёл пустым.
 */
describe('главная без свадьбы: «свадьбы нет» словами, а не нулями', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  /** Вошли, онбординг пройден, свадьбы на устройстве нет. */
  const noWeddingDevice = () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  }
  const NO_WEDDING = 'Свадьбы пока нет'
  const zeros = (text: string) => {
    expect(text).not.toContain('0%')
    expect(text).not.toMatch(/(^|\D)0\s*гостей/)
    expect(text).not.toMatch(/00\s*МЕС/)
  }

  it('список пришёл пустым — «Свадьбы пока нет», кнопка ведёт в квиз, нулей нет', async () => {
    noWeddingDevice()
    serve({ '/weddings': [], '/me/favorites': [], '/notifications': [] })
    const r = await open('/home', NO_WEDDING)
    zeros(r.container.textContent ?? '')
    fireEvent.click(screen.getByText('Начать свадьбу'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('Когда ваша свадьба?'))
  })

  it('список ещё в пути — прочерки: ни нулей, ни «свадьбы нет»', async () => {
    noWeddingDevice()
    serve({ '/weddings': PENDING, '/me/favorites': [], '/notifications': [] })
    const r = await open('/home', 'Ваша свадьба')
    zeros(r.container.textContent ?? '')
    await neverShows(NO_WEDDING)
  })

  it('список не загрузился — «Сервер недоступен», а не «свадьбы нет» и не нули', async () => {
    noWeddingDevice()
    serve({ '/weddings': DOWN, '/me/favorites': [], '/notifications': [] })
    const r = await open('/home', SERVER_DOWN)
    zeros(r.container.textContent ?? '')
    await neverShows(NO_WEDDING)
  })

  it('без входа — «Войдите», кнопка ведёт на экран входа, нулей нет', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    serve({})
    const r = await open('/home', 'Войдите')
    zeros(r.container.textContent ?? '')
    await neverShows(NO_WEDDING)
    fireEvent.click(screen.getByText('Войти'))
    await waitFor(() => expect(r.container.textContent ?? '').toContain('С возвращением'))
  })
})
