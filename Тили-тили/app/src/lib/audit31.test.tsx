// @vitest-environment jsdom
/*
 * Ревью второго раунда фиксов (REVIEW-FIX-R3): R3-01…R3-04. Каждый тест
 * здесь был красным на коде до фикса — цитаты красного в отчёте `FIX-FE-E.md`.
 *
 * Классы дыр:
 *  — после своего действия экран перечитывает данные, а кнопки при старых
 *    данных снова живые: «+15 мин» и «Подтвердить» плана Б рассылали
 *    команде второе критическое уведомление (R3-01), редакторы «весь список
 *    одним PUT» откатывали предыдущее нажатие или стирали список (R3-02);
 *  — «без входа» и «вошёл, свадьба ещё не пришла» выглядели одинаково (R3-03);
 *  — включение push при устанавливающемся воркере отвечало «не
 *    зарегистрирован» (R3-04).
 *
 * Проверяется то, что ушло на сервер и что видно на экране, а не то, что
 * нарисовал обработчик (приём из `audit25`/`audit30`).
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider, useStore } from './store'
import { enableDevicePush } from '@/lib/push'
import { SlotDetail, Timeline } from '@/pages/Wedding'
import { Deal } from '@/pages/Tools'
import { DayX } from '@/pages/Smart'
import { WishlistManage } from '@/pages/Wishlist'
import { Catering } from '@/pages/Logistics'

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

/**
 * Ответ, который придёт, когда тест его отпустит.
 *
 * Окно «свежий ответ в пути» держится ровно столько, сколько нужно: в нём
 * проверяем, что кнопки закрыты, а после `release` — что они открылись и
 * экран показывает пришедшее.
 */
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

/** Всё, что читают стор и экраны пары. */
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
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
const button = (label: string) => screen.getByText(label).closest('button')!
const disabled = (label: string) => button(label).hasAttribute('disabled')
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const puts = (calls: Call[], path: string) => calls.filter(c => c.method === 'PUT' && c.path === path)

/* ── R3-01: день X — кнопки закрыты, пока свежий ответ в пути ───────────── */

describe('R3-01: день X — «+15 мин» и план Б закрыты, пока свежие данные не пришли', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const CEREMONY = { id: 'e1', name: 'Церемония', startsAt: '2027-06-14T11:00:00.000Z' }
  const SHIFT = '/weddings/w1/timeline/shift'
  const ACTIVATE = '/weddings/w1/planb/activate'

  it('«+15 мин»: после POST кнопка закрыта до свежего GET /timeline, второй клик не даёт второго POST', async () => {
    let timelines = 0
    const fresh = gate()
    const calls = serve(base({
      '/weddings/w1/timeline': () => (++timelines === 1 ? [CEREMONY] : fresh.reply),
      '/weddings/w1/planb': { checklist: [], activatedAt: null },
      [SHIFT]: {},
    }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    await waitFor(() => expect(disabled('+15 мин всей программе')).toBe(false))

    fireEvent.click(button('+15 мин всей программе'))
    await waitFor(() => expect(posts(calls, SHIFT).length).toBe(1))
    /* POST прошёл, `GET /timeline` ушёл и висит: на экране прежние часы. */
    await waitFor(() => expect(timelines).toBe(2))
    await waitFor(() => expect(screen.queryByText('Двигаем…')).toBeNull())
    expect(disabled('+15 мин всей программе'), '«+15 мин» открыта при старом тайминге — второе касание сдвинет ещё на 15 и разошлёт команде второй push').toBe(true)

    fireEvent.click(button('+15 мин всей программе'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(posts(calls, SHIFT).length, 'второй POST /timeline/shift с новым ключом идемпотентности').toBe(1)

    /* Свежий тайминг пришёл — кнопка снова открыта, на экране то, что прислал сервер. */
    fresh.release([CEREMONY, { id: 'e2', name: 'Банкет', startsAt: '2027-06-14T13:00:00.000Z' }])
    await waitFor(() => expect(text(r)).toContain('Банкет'))
    await waitFor(() => expect(disabled('+15 мин всей программе')).toBe(false))
  })

  it('план Б: после «Подтвердить» кнопка закрыта и не в состоянии подтверждения, второй клик не даёт второго POST', async () => {
    let planbs = 0
    const fresh = gate()
    const calls = serve(base({
      '/weddings/w1/timeline': [CEREMONY],
      '/weddings/w1/planb': () => (++planbs === 1 ? { checklist: [], activatedAt: null } : fresh.reply),
      [ACTIVATE]: {},
    }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Активировать')).toBe(false))

    fireEvent.click(button('Активировать'))
    fireEvent.click(button('Подтвердить'))
    await waitFor(() => expect(posts(calls, ACTIVATE).length).toBe(1))
    await waitFor(() => expect(planbs).toBe(2))
    await waitFor(() => expect(screen.queryByText('Включаем…')).toBeNull())

    /* Ответ о плане Б ещё в пути: подтверждать нечего, а нажать нельзя. */
    expect(screen.queryByText('Подтвердить'), 'после активации кнопка осталась в состоянии «Подтвердить» — одно касание = вторая рассылка').toBeNull()
    const planB = screen.queryByText('Активировать')?.closest('button') ?? null
    expect(planB === null || planB.hasAttribute('disabled'), 'кнопка плана Б открыта при старом ответе «не включён»').toBe(true)
    if (planB) fireEvent.click(planB)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(posts(calls, ACTIVATE).length, 'второй POST /planb/activate').toBe(1)

    fresh.release({ checklist: [], activatedAt: '2027-06-14T08:00:00.000Z', scenario: 'rain' })
    await waitFor(() => expect(screen.getByText('Включён')).toBeTruthy())
    expect(screen.queryByText('Активировать')).toBeNull()
  })
})

/* ── R3-02: редакторы «весь список одним PUT» ───────────────────────────── */

const A = { id: 'a', name: 'Сборы', startsAt: '2027-06-14T06:00:00.000Z' }
const B = { id: 'b', name: 'Церемония', startsAt: '2027-06-14T08:00:00.000Z' }
const TIMELINE = '/weddings/w1/timeline'
const names = (c: Call) => (c.body as { name: string }[]).map(e => e.name)

describe('R3-02: тайминг — крестики и «Добавить» закрыты, пока список перечитывается; следующий PUT не откатывает предыдущий', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const addEvent = (name: string, from: string) => {
    fireEvent.change(screen.getByPlaceholderText('Событие (например, «Первый танец»)'), { target: { value: name } })
    fireEvent.change(screen.getByLabelText('Начало'), { target: { value: from } })
    fireEvent.click(screen.getByText('Добавить в тайминг'))
  }

  it('× у A → PUT [B] → пока свежий список в пути, × у B и «Добавить» закрыты, второго PUT нет; после ответа — открыты', async () => {
    let timelines = 0
    const fresh = gate()
    const calls = serve(base({
      [TIMELINE]: (c: Call) => (c.method === 'PUT' ? [B] : ++timelines === 1 ? [A, B] : fresh.reply),
    }))
    const r = renderAt('/wedding/timeline', <Route path="/wedding/timeline" element={<Timeline />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Править'))

    fireEvent.click(screen.getAllByLabelText('Убрать из тайминга')[0]!)
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(1))
    expect(names(puts(calls, TIMELINE)[0]!)).toEqual(['Церемония'])
    await waitFor(() => expect(timelines).toBe(2))
    await waitFor(() => expect(screen.queryByText('Сохраняем…')).toBeNull())

    /* Сервер принял [B], свежий список ещё едет, на экране всё ещё [A, B]. */
    const crosses = screen.getAllByLabelText('Убрать из тайминга')
    expect(crosses.length).toBe(2)
    expect(crosses[1]!.hasAttribute('disabled'), 'крестик у B открыт при старом списке — PUT [A] вернул бы убранный блок A').toBe(true)
    expect(disabled('Добавить в тайминг'), '«Добавить в тайминг» открыта при старом списке').toBe(true)
    fireEvent.click(crosses[1]!)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, TIMELINE).length, 'второй PUT со старого списка').toBe(1)

    fresh.release([B])
    await waitFor(() => expect(text(r)).not.toContain('Сборы'))
    await waitFor(() => expect(screen.getAllByLabelText('Убрать из тайминга')[0]!.hasAttribute('disabled')).toBe(false))
    expect(disabled('Добавить в тайминг')).toBe(false)
  })

  it('перечитывание после PUT сорвалось — следующий PUT строится из принятого сервером списка, а не из пустоты', async () => {
    let timelines = 0
    const calls = serve(base({
      [TIMELINE]: (c: Call) => (c.method === 'PUT' ? c.body : ++timelines === 1 ? [A, B] : DOWN),
    }))
    const r = renderAt('/wedding/timeline', <Route path="/wedding/timeline" element={<Timeline />} />)
    await waitFor(() => expect(text(r)).toContain('Церемония'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Править'))
    addEvent('Торт', '19:00')
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(1))
    expect(names(puts(calls, TIMELINE)[0]!)).toEqual(['Сборы', 'Церемония', 'Торт'])
    await waitFor(() => expect(timelines).toBe(2))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })

    /* Список на экране пропал вместе с отказом; сервер при этом держит [A, B, Торт]. */
    fireEvent.click(screen.getByText('Править'))
    addEvent('Танец', '20:00')
    await waitFor(() => expect(puts(calls, TIMELINE).length).toBe(2))
    expect(names(puts(calls, TIMELINE)[1]!), 'PUT из пустого экрана стёр бы весь тайминг').toEqual(['Сборы', 'Церемония', 'Торт', 'Танец'])
  })
})

const WISHLIST = '/weddings/w1/wishlist'
const ANTI = '/weddings/w1/anti-gifts'

describe('R3-02: анти-вишлист — «Добавить» и крестики закрыты, пока список перечитывается; Enter тоже', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const input = () => screen.getByPlaceholderText('Например: сервизы')
  const add = (value: string) => {
    fireEvent.change(input(), { target: { value } })
    fireEvent.click(screen.getByText('Добавить'))
  }

  it('добавили X → PUT [X] → пока свежий список в пути, кнопка закрыта и Enter не шлёт; после ответа Y уходит как [X, Y]', async () => {
    let wishlists = 0
    const fresh = gate()
    const calls = serve(base({
      [WISHLIST]: () => (++wishlists === 1 ? { gifts: [], funds: [], antiGifts: [] } : fresh.reply),
      [ANTI]: (c: Call) => c.body,
    }))
    const r = renderAt('/wedding/wishlist', <Route path="/wedding/wishlist" element={<WishlistManage />} />)
    await waitFor(() => expect(text(r)).toContain('Просим не дарить'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Добавить')).toBe(false))

    add('сервизы')
    await waitFor(() => expect(puts(calls, ANTI).length).toBe(1))
    expect(puts(calls, ANTI)[0]!.body).toEqual(['сервизы'])
    await waitFor(() => expect(wishlists).toBe(2))
    await waitFor(() => expect(disabled('Добавить'), '«Добавить» открыта при старом списке — второй PUT [Y] стёр бы X').toBe(true))
    fireEvent.change(input(), { target: { value: 'вазы' } })
    fireEvent.keyDown(input(), { key: 'Enter' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, ANTI).length, 'Enter отправил PUT в обход закрытой кнопки').toBe(1)

    fresh.release({ gifts: [], funds: [], antiGifts: ['сервизы'] })
    await waitFor(() => expect(text(r)).toContain('сервизы'))
    await waitFor(() => expect(disabled('Добавить')).toBe(false))
    expect(screen.getByLabelText('Удалить').hasAttribute('disabled')).toBe(false)
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(puts(calls, ANTI).length).toBe(2))
    expect(puts(calls, ANTI)[1]!.body).toEqual(['сервизы', 'вазы'])
  })

  it('перечитывание после PUT сорвалось — следующий PUT строится из принятого сервером списка', async () => {
    let wishlists = 0
    const calls = serve(base({
      [WISHLIST]: () => (++wishlists === 1 ? { gifts: [], funds: [], antiGifts: [] } : DOWN),
      [ANTI]: (c: Call) => c.body,
    }))
    const r = renderAt('/wedding/wishlist', <Route path="/wedding/wishlist" element={<WishlistManage />} />)
    await waitFor(() => expect(text(r)).toContain('Просим не дарить'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Добавить')).toBe(false))
    add('сервизы')
    await waitFor(() => expect(puts(calls, ANTI).length).toBe(1))
    await waitFor(() => expect(wishlists).toBe(2))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    await waitFor(() => expect(disabled('Добавить')).toBe(false))
    add('вазы')
    await waitFor(() => expect(puts(calls, ANTI).length).toBe(2))
    expect(puts(calls, ANTI)[1]!.body, 'PUT из пустого экрана стёр бы «сервизы»').toEqual(['сервизы', 'вазы'])
  })
})

const MENU = '/weddings/w1/menu-poll'
const POLL = { question: 'Что на горячее?', options: [{ id: 'o1', name: 'Мясо', votes: 2 }], expectedPortions: 3 }
const optionNames = (c: Call) => (c.body as { options: { name: string }[] }).options.map(o => o.name)

describe('R3-02: варианты меню — «Добавить» закрыта, пока опрос перечитывается; следующий PUT несёт все варианты', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const openForm = () => fireEvent.click(screen.getByText('Добавить вариант блюда'))
  const typeOption = (value: string) => fireEvent.change(screen.getByPlaceholderText('Название блюда'), { target: { value } })

  it('добавили «Рыба» → пока свежий опрос в пути, «Добавить» закрыта; после ответа «Суп» уходит вместе с «Мясо» и «Рыба»', async () => {
    let polls = 0
    const fresh = gate()
    const calls = serve(base({
      [MENU]: (c: Call) => (c.method === 'PUT' ? c.body : ++polls === 1 ? POLL : fresh.reply),
      '/weddings/w1/guests': [],
    }))
    const r = renderAt('/wedding/catering', <Route path="/wedding/catering" element={<Catering />} />)
    await waitFor(() => expect(text(r)).toContain('Мясо'), { timeout: 4000 })
    openForm()
    typeOption('Рыба')
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(puts(calls, MENU).length).toBe(1))
    expect(optionNames(puts(calls, MENU)[0]!)).toEqual(['Мясо', 'Рыба'])
    await waitFor(() => expect(polls).toBe(2))
    await waitFor(() => expect(screen.getByText('Добавить вариант блюда')).toBeTruthy())

    openForm()
    typeOption('Суп')
    expect(disabled('Добавить'), '«Добавить» открыта при старом опросе — PUT без «Рыба» удалил бы её вместе с голосами').toBe(true)
    fireEvent.click(screen.getByText('Добавить'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, MENU).length, 'второй PUT со старого опроса').toBe(1)

    fresh.release({ ...POLL, options: [...POLL.options, { id: 'o2', name: 'Рыба', votes: 0 }] })
    await waitFor(() => expect(text(r)).toContain('Рыба'))
    await waitFor(() => expect(disabled('Добавить')).toBe(false))
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(puts(calls, MENU).length).toBe(2))
    expect(optionNames(puts(calls, MENU)[1]!)).toEqual(['Мясо', 'Рыба', 'Суп'])
  })

  it('перечитывание после PUT сорвалось — следующий PUT несёт принятые сервером вопрос и варианты', async () => {
    let polls = 0
    const calls = serve(base({
      [MENU]: (c: Call) => (c.method === 'PUT' ? c.body : ++polls === 1 ? POLL : DOWN),
      '/weddings/w1/guests': [],
    }))
    const r = renderAt('/wedding/catering', <Route path="/wedding/catering" element={<Catering />} />)
    await waitFor(() => expect(text(r)).toContain('Мясо'), { timeout: 4000 })
    openForm()
    typeOption('Рыба')
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(puts(calls, MENU).length).toBe(1))
    await waitFor(() => expect(polls).toBe(2))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })

    openForm()
    typeOption('Суп')
    await waitFor(() => expect(disabled('Добавить')).toBe(false))
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(puts(calls, MENU).length).toBe(2))
    const second = puts(calls, MENU)[1]!.body as { question: string; options: { id?: string; name: string }[] }
    expect(second.options.map(o => o.name), 'PUT из пустого экрана стёр бы «Мясо» и «Рыба» вместе с голосами').toEqual(['Мясо', 'Рыба', 'Суп'])
    expect(second.question).toBe('Что на горячее?')
  })
})

/* ── R3-02 (хвост): первая загрузка сорвалась — списка нет, писать нечего ── */

/*
 * Тот же класс, что R3-02, но с другого конца: список не пришёл ВООБЩЕ
 * (первый GET упал), принятой сервером копии тоже нет. Экран пуст не потому,
 * что тайминг пуст, а потому, что он его не знает (инвариант 13) — PUT из
 * одного нового элемента стёр бы на сервере всё. Кнопки записи закрыты.
 */
describe('R3-02 (хвост): первая загрузка списка сорвалась — запись закрыта, PUT не уходит', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('тайминг: GET упал → «Добавить в тайминг» закрыта, PUT нет', async () => {
    const calls = serve(base({ [TIMELINE]: DOWN }))
    renderAt('/wedding/timeline', <Route path="/wedding/timeline" element={<Timeline />} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Править'))
    fireEvent.change(screen.getByPlaceholderText('Событие (например, «Первый танец»)'), { target: { value: 'Торт' } })
    fireEvent.change(screen.getByLabelText('Начало'), { target: { value: '19:00' } })
    expect(disabled('Добавить в тайминг'), '«Добавить» открыта при неизвестном списке — PUT [Торт] стёр бы весь тайминг').toBe(true)
    fireEvent.click(screen.getByText('Добавить в тайминг'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, TIMELINE).length).toBe(0)
  })

  it('анти-вишлист: GET упал → «Добавить» закрыта и Enter не шлёт, PUT нет', async () => {
    const calls = serve(base({ [WISHLIST]: DOWN }))
    renderAt('/wishlist/manage', <Route path="/wishlist/manage" element={<WishlistManage />} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    const input = screen.getByPlaceholderText('Например: сервизы')
    fireEvent.change(input, { target: { value: 'сервизы' } })
    expect(disabled('Добавить'), '«Добавить» открыта при неизвестном списке — PUT [сервизы] стёр бы анти-вишлист').toBe(true)
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('Добавить'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, ANTI).length).toBe(0)
  })

  it('варианты меню: GET упал → «Добавить» закрыта, PUT нет', async () => {
    const calls = serve(base({ [MENU]: DOWN }))
    renderAt('/logistics/catering', <Route path="/logistics/catering" element={<Catering />} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Добавить вариант блюда'))
    fireEvent.change(screen.getByPlaceholderText('Название блюда'), { target: { value: 'Рыба' } })
    expect(disabled('Добавить'), '«Добавить» открыта при неизвестном опросе — PUT [Рыба] стёр бы варианты с голосами').toBe(true)
    fireEvent.click(screen.getByText('Добавить'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(puts(calls, MENU).length).toBe(0)
  })
})

/* ── R3-03: слот и сделка — «Войдите» только без входа ─────────────────── */

describe('R3-03: экраны слота и сделки различают «без входа», «список свадеб едет» и «свадьбы нет»', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const dealRoute = <Route path="/deal/:id" element={<Deal />} />
  const slotRoute = <Route path="/wedding/slot/:id" element={<SlotDetail />} />

  it('вошёл, свадьба на устройстве не записана, GET /weddings висит — «Загружаем…», а не «Войдите»', async () => {
    signedIn()
    serve(base({ '/weddings': PENDING }))
    const r = renderAt('/deal/d1', dealRoute)
    await waitFor(() => expect(text(r)).toContain('Загружаем…'), { timeout: 4000 })
    expect(text(r), 'вошедшему человеку предложено войти').not.toContain('Войдите, чтобы увидеть свою свадьбу')
  })

  it('то же на экране слота', async () => {
    signedIn()
    serve(base({ '/weddings': PENDING }))
    const r = renderAt('/wedding/slot/s1', slotRoute)
    await waitFor(() => expect(text(r)).toContain('Загружаем…'), { timeout: 4000 })
    expect(text(r)).not.toContain('Войдите, чтобы увидеть свою свадьбу')
  })

  it('вошёл, список свадеб пришёл пустым — «Свадьбы пока нет»', async () => {
    signedIn()
    serve(base({ '/weddings': [] }))
    const r = renderAt('/deal/d1', dealRoute)
    await waitFor(() => expect(text(r)).toContain('Свадьбы пока нет'), { timeout: 4000 })
    expect(text(r)).not.toContain('Войдите, чтобы увидеть свою свадьбу')
  })

  it('вошёл, список свадеб не пришёл — «Сервер недоступен», а не «Войдите» и не «свадьбы нет»', async () => {
    signedIn()
    serve(base({ '/weddings': DOWN }))
    const r = renderAt('/wedding/slot/s1', slotRoute)
    await waitFor(() => expect(text(r)).toContain('Сервер недоступен. Попробуйте позже'), { timeout: 4000 })
    expect(text(r)).not.toContain('Войдите, чтобы увидеть свою свадьбу')
    expect(text(r)).not.toContain('Свадьбы пока нет')
  })

  it('без входа — по-прежнему «Войдите» (контроль)', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    serve({})
    const r = renderAt('/deal/d1', dealRoute)
    await waitFor(() => expect(text(r)).toContain('Войдите, чтобы увидеть свою свадьбу'), { timeout: 4000 })
    expect(text(r)).not.toContain('Загружаем…')
  })
})

/* ── R3-03 (хвост): повторный вход после выхода — сверка заново ─────────── */

/*
 * Выход сбрасывает сверку в `idle`, а эффект сверки — один на запуск: после
 * повторного входа без свадьбы стор оставался в `idle` навсегда, и экраны
 * слота, сделки и главная обещали «Загружаем…» без запроса в пути (FIX-FE-E
 * §4 п. 3). Вход отдаёт стору принятый список — сверка закрывается им.
 */
function SessionProbe() {
  const store = useStore()
  return (
    <>
      <button onClick={() => { localStorage.removeItem('tt_auth'); store.forgetSession() }}>выйти</button>
      <button onClick={() => { localStorage.setItem('tt_auth', JSON.stringify(TOKENS)); store.adoptWeddings([]) }}>войти без свадьбы</button>
    </>
  )
}

describe('R3-03 (хвост): после выхода и повторного входа без свадьбы экран сделки говорит «Свадьбы пока нет», а не «Загружаем…»', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('выйти → войти (список пуст) → «Свадьбы пока нет»', async () => {
    couple()
    serve(base({ '/deals/d1': { __status: 404, body: { code: 'not_found', message: 'нет' }, headers: {} } }))
    const r = renderAt('/deal/d1', <Route path="/deal/:id" element={<><SessionProbe /><Deal /></>} />)
    await waitFor(() => expect(text(r)).not.toContain('Загружаем…'), { timeout: 4000 })
    fireEvent.click(screen.getByText('выйти'))
    await waitFor(() => expect(text(r)).toContain('Войдите, чтобы увидеть свою свадьбу'), { timeout: 4000 })
    fireEvent.click(screen.getByText('войти без свадьбы'))
    await waitFor(() => expect(text(r)).toContain('Свадьбы пока нет'), { timeout: 4000 })
    expect(text(r), 'вошёл заново, список принят пустым — а экран ждёт сверку, которой не будет').not.toContain('Загружаем…')
  })
})

/* ── R3-04: включение push при устанавливающемся воркере ───────────────── */

describe('R3-04: включение push, когда service worker зарегистрирован, но ещё ставится', () => {
  beforeEach(() => {
    signedIn()
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BAbc123_-key')
    vi.useFakeTimers()
    vi.stubGlobal('PushManager', function PushManager() { /* признак поддержки */ })
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' })
  })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, 'serviceWorker') })

  const subscription = {
    endpoint: 'https://push.example/abc',
    toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p256', auth: 'auth' } }),
    unsubscribe: async () => true,
  }
  const pushManager = { getSubscription: async () => null, subscribe: async () => subscription }
  const INSTALLING = 'Приложение ещё устанавливается — попробуйте через несколько секунд'

  it('воркер активируется через 100 мс — подписка проходит и уходит на сервер', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        ready: new Promise(resolve => setTimeout(() => resolve({ active: {}, pushManager }), 100)),
        getRegistration: async () => ({ active: null, installing: {}, pushManager }),
      },
      configurable: true,
    })
    const calls = serve(base({ '/users/me/push-subscriptions': {} }))
    const outcome = enableDevicePush().then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome, 'регистрация есть, воркер ставится — а ответ «не зарегистрирован»').toBe('ok')
    expect(posts(calls, '/users/me/push-subscriptions').length).toBe(1)
  })

  it('воркер так и не активировался — за 3 с ответ «ещё устанавливается», а не «не зарегистрирован»', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        ready: new Promise(() => {}),
        getRegistration: async () => ({ active: null, installing: {}, pushManager }),
      },
      configurable: true,
    })
    const calls = serve(base())
    const outcome = enableDevicePush().then(() => 'ok', (e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await outcome).toBe(INSTALLING)
    expect(posts(calls, '/users/me/push-subscriptions').length).toBe(0)
  })
})
