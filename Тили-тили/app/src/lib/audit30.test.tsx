// @vitest-environment jsdom
/*
 * Ревью фиксов фронта (REVIEW-FIX-FE): RF-01…RF-09. Каждый тест здесь был
 * красным на коде до фикса — цитаты красного в отчёте `FIX-FE-D.md`.
 *
 * Классы дыр:
 *  — память стора переживает выход: мозаика с телефонами подрядчиков без
 *    токена и без запросов (RF-01);
 *  — опрос через зависимости запроса стирает показанное на время ответа
 *    (RF-02), а «сейчас» в списке чатов снято один раз (RF-05);
 *  — «спрятал до ответа — не сказал, что ответа нет» (RF-03, RF-09);
 *  — кнопка чата — промис без catch: молча не делает ничего (RF-04);
 *  — перечитывание страницы гостя размонтирует её (RF-06);
 *  — выход ждёт `sw.ready`, которого не будет (RF-07);
 *  — проигравшая вкладка при `refresh_superseded` стирает живую пару (RF-08).
 *
 * Проверяется то, что ушло на сервер, что осталось на устройстве и что видно
 * на экране, а не то, что нарисовал обработчик (приём из `audit25`/`audit27`).
 */
import { render, cleanup, waitFor, fireEvent, screen, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StoreProvider } from './store'
import { signOutEverywhere } from '@/lib/api/auth'
import { api, ApiError } from '@/lib/api/client'
import { Settings } from '@/pages/Account'
import { Team } from '@/pages/Team'
import { Chats, Us } from '@/pages/Us'
import { SlotDetail } from '@/pages/Wedding'
import { Deal, InviteEditor } from '@/pages/Tools'
import { DayX } from '@/pages/Smart'
import Invite from '@/pages/Invite'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; url: string; body: unknown; headers: Record<string, string> }

/* Сеть падает на этом адресе: `TypeError` — то, что бросает настоящий fetch. */
const DOWN = Symbol('down')
/* Ответ, которого ещё нет: запрос ушёл и висит. На `abort` отвечает, как настоящий fetch. */
const PENDING = Symbol('pending')

/** Ответ со своим кодом и, при необходимости, заголовками. */
const withStatus = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  ({ __status: status, body: { error: { code, message } }, headers })

/** Ответ, который приходит через `ms` миллисекунд, — вкладка, у которой сервер медленнее. */
const delayed = (ms: number, body: unknown) => ({ __delay: ms, body })

function isStatus(v: unknown): v is { __status: number; body: unknown; headers: Record<string, string> } {
  return typeof v === 'object' && v !== null && '__status' in v
}
function isDelayed(v: unknown): v is { __delay: number; body: unknown } {
  return typeof v === 'object' && v !== null && '__delay' in v
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
    if (isDelayed(reply)) return new Promise<Response>(resolve => setTimeout(() => resolve(json(reply.body)), reply.__delay))
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
const storedTokens = () => JSON.parse(localStorage.getItem('tt_auth') ?? 'null') as typeof TOKENS | null

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg' }
const ME = { id: 'u1', name: 'Аня', phone: '+79990000000', isStaff: false, push: {}, quietHours: null }

/** Свой подрядчик в слоте: имя и телефон — то, что не должно пережить выход. */
const externalSlot = {
  id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'booked',
  deal: { id: 'd1', state: 'booked', externalName: 'Фото «Кадр»', externalPhone: '+79170000001', price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
}
/** Подрядчик из каталога: у него есть `vendorId`, и «Написать» идёт в `POST /chats/vendor/{id}`. */
const catalogSlot = {
  id: 's1', categoryId: 'photo', label: 'Фотограф', tileState: 'booked',
  deal: { id: 'd1', state: 'booked', vendor: { id: 'v1', name: 'Елена Фото' }, price: { amount: 4_500_000, currency: 'RUB' }, paid: { amount: 0, currency: 'RUB' } },
}

/** Всё, что читают стор и экраны пары; сессии — для выхода. */
const base = (over: Routes = {}): Routes => ({
  '/weddings': [{ ...WEDDING, role: 'couple' }],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/me/favorites': [],
  '/users/me': ME,
  '/users/me/referral': { code: 'ТИЛИ-АНЯ', invited: 0, earned: { amount: 0, currency: 'RUB' } },
  '/users/me/sessions': (c: Call) => (c.method === 'DELETE' ? withStatus(204, '', '') : [{ id: 'this-one', device: 'Windows', current: true }]),
  '/users/me/sessions/this-one': withStatus(204, '', ''),
  '/users/me/consent': withStatus(204, '', ''),
  ...over,
})

/** Кнопки перехода поверх экрана: тест ходит по адресам, как человек по «Назад». */
function NavProbe() {
  const nav = useNavigate()
  return (
    <div>
      <button onClick={() => nav('/us')}>ПРОБА: на /us</button>
      <button onClick={() => nav('/settings')}>ПРОБА: на /settings</button>
      <button onClick={() => nav('/wedding/slot/s1')}>ПРОБА: на слот</button>
    </div>
  )
}

function renderAt(initial: string, routes: React.ReactNode, probe = false) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <StoreProvider>
        {probe && <NavProbe />}
        <Routes>{routes}</Routes>
      </StoreProvider>
    </MemoryRouter>,
  )
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

/* ── RF-01: после выхода память стора пуста ─────────────────────────────── */

describe('RF-01: после выхода память стора не хранит свадьбу и мозаику', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const sessionRoutes = (
    <>
      <Route path="/wedding/slot/:id" element={<SlotDetail />} />
      <Route path="/us" element={<Us />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/auth" element={<p>ЭКРАН ВХОДА</p>} />
    </>
  )

  it('«Выйти из аккаунта» → /wedding/slot/s1 без имени и телефона подрядчика, хранилище пустое', async () => {
    serve(base({ '/weddings/w1/slots': [externalSlot] }))
    const r = renderAt('/wedding/slot/s1', sessionRoutes, true)
    await waitFor(() => expect(text(r)).toContain('+79170000001'), { timeout: 4000 })
    fireEvent.click(screen.getByText('ПРОБА: на /us'))
    await waitFor(() => expect(screen.getByText('Выйти из аккаунта')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Выйти из аккаунта'))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    expect(storedTokens()).toBeNull()

    /* «Назад» или адрес в строке: без токена и без единого запроса. */
    fireEvent.click(screen.getByText('ПРОБА: на слот'))
    await waitFor(() => expect(text(r)).not.toContain('ЭКРАН ВХОДА'))
    expect(text(r), 'имя подрядчика осталось в памяти после выхода').not.toContain('Фото «Кадр»')
    expect(text(r), 'телефон подрядчика остался в памяти после выхода').not.toContain('+79170000001')
    for (const k of ['tt_wedding_id', 'tt_wedding_date', 'tt_quiz', 'tt_onboarded', 'tt_fav']) {
      expect(localStorage.getItem(k), `${k} остался на устройстве после выхода`).toBeNull()
    }
  })

  it('отзыв согласия в настройках — тот же сброс', async () => {
    serve(base({ '/weddings/w1/slots': [externalSlot] }))
    const r = renderAt('/wedding/slot/s1', sessionRoutes, true)
    await waitFor(() => expect(text(r)).toContain('+79170000001'), { timeout: 4000 })
    fireEvent.click(screen.getByText('ПРОБА: на /settings'))
    await waitFor(() => expect(screen.getByText('Отозвать согласие на обработку данных')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Отозвать согласие на обработку данных'))
    fireEvent.click(screen.getByText('Подтвердить отзыв согласия'))
    await waitFor(() => expect(text(r)).toContain('ЭКРАН ВХОДА'), { timeout: 4000 })
    fireEvent.click(screen.getByText('ПРОБА: на слот'))
    await waitFor(() => expect(text(r)).not.toContain('ЭКРАН ВХОДА'))
    expect(text(r)).not.toContain('Фото «Кадр»')
    expect(text(r)).not.toContain('+79170000001')
    expect(localStorage.getItem('tt_wedding_id')).toBeNull()
  })
})

/* ── RF-02: минутный опрос дня X не стирает показанное ──────────────────── */

describe('RF-02: минутный опрос дня X не стирает тайминг и план Б', () => {
  beforeEach(() => {
    couple()
    /* Таймеры и часы поддельные, но идут в реальном темпе: `waitFor` и ответы
       сети работают как обычно, а минуту можно перемотать одним вызовом. */
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2027-06-14T12:00:00.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('через 60 с при зависшем ответе «СЕЙЧАС» и блок на месте, план Б «Включён»; «+15 мин» закрыта, пока свежий тайминг в пути', async () => {
    let timelines = 0
    let planbs = 0
    const events = [{ id: 'e1', name: 'Церемония', startsAt: '2027-06-14T11:00:00.000Z' }]
    serve(base({
      /* Первый ответ — тайминг, второй (опрос) висит: ровно в это окно экран решает, что показывать. */
      '/weddings/w1/timeline': () => (++timelines === 1 ? events : PENDING),
      '/weddings/w1/planb': () => (++planbs === 1 ? { checklist: [], activatedAt: '2027-06-14T08:00:00.000Z', scenario: 'rain' } : PENDING),
    }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('СЕЙЧАСЦеремония'), { timeout: 4000 })
    await waitFor(() => expect(screen.getByText('Включён')).toBeTruthy())

    await act(async () => { vi.advanceTimersByTime(60_000) })
    await waitFor(() => expect(timelines).toBe(2))
    expect(planbs).toBe(2)

    expect(text(r), 'карточка «СЕЙЧАС» пропала на время опроса').toContain('СЕЙЧАСЦеремония')
    expect(text(r)).not.toContain('Загружаем…')
    /* До ревью R3-01 здесь ждали открытую кнопку: опрос стирал тайминг и она
       выключалась по пустому списку. Теперь список на месте, а кнопка закрыта
       по другой причине — свежий тайминг в пути, и сдвиг по прежним часам
       ушёл бы вторым POST. Открывается она с ответом (`audit31`). */
    expect(screen.getByText('+15 мин всей программе').closest('button')!.hasAttribute('disabled'), '«+15 мин» открыта, пока свежий тайминг не пришёл').toBe(true)
    expect(screen.queryByText('Двигаем…'), 'опрос выдан за нажатие').toBeNull()
    expect(screen.queryByText('Активировать'), 'включённый план Б предложен к активации').toBeNull()
    expect(screen.getByText('Включён')).toBeTruthy()
  })
})

/* ── RF-03: команда — список свадеб не пришёл ───────────────────────────── */

const teamMember = (id: string, name: string, role: string) => ({ user: { id, name }, role, joinedAt: '2026-01-01T00:00:00.000Z' })
const teamRoutes = (over: Routes = {}): Routes => base({
  '/weddings/w1/members': [teamMember('u1', 'Аня', 'couple'), teamMember('u2', 'Мама', 'helper')],
  '/weddings/w1/invites': [],
  ...over,
})

describe('RF-03: экран команды говорит, что список свадеб не пришёл', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('/weddings упал: role=alert с причиной и «Повторить» вместо блока «Пригласить», участники на экране', async () => {
    const calls = serve(teamRoutes({ '/weddings': DOWN }))
    renderAt('/us/team', <Route path="/us/team" element={<Team />} />)
    await waitFor(() => expect(screen.getByText('Мама')).toBeTruthy(), { timeout: 4000 })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(screen.queryByText('Пригласить')).toBeNull()
    const before = calls.filter(c => c.path === '/weddings').length
    fireEvent.click(screen.getByText('Повторить'))
    await waitFor(() => expect(calls.filter(c => c.path === '/weddings').length).toBe(before + 1))
  })

  it('пока список едет — «Загружаем…» на месте блока, а не пустота', async () => {
    serve(teamRoutes({ '/weddings': PENDING }))
    renderAt('/us/team', <Route path="/us/team" element={<Team />} />)
    await waitFor(() => expect(screen.getByText('Мама')).toBeTruthy(), { timeout: 4000 })
    expect(screen.getByText('Загружаем…'), 'роль не пришла, а на экране ни слова').toBeTruthy()
    expect(screen.queryByText('Пригласить')).toBeNull()
  })
})

/* ── RF-04: кнопки чата — отказ словами под кнопкой ─────────────────────── */

const RATE_LIMITED = 'Слишком часто — подождите минуту'

describe('RF-04: «Написать» и чаты дня X — отказ сервера показан, а не проглочен', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('слот команды: 429 на POST /chats/vendor/v1 — текст под кнопкой', async () => {
    serve(base({ '/weddings/w1/slots': [catalogSlot], '/chats/vendor/v1': withStatus(429, 'rate_limited', RATE_LIMITED) }))
    renderAt('/wedding/slot/s1', <Route path="/wedding/slot/:id" element={<SlotDetail />} />)
    await waitFor(() => expect(screen.getByText('Написать')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Написать'))
    expect(await screen.findByText(RATE_LIMITED)).toBeTruthy()
  })

  it('слот команды: «Чат по сделке» — то же', async () => {
    serve(base({ '/weddings/w1/slots': [catalogSlot], '/chats/vendor/v1': withStatus(429, 'rate_limited', RATE_LIMITED) }))
    renderAt('/wedding/slot/s1', <Route path="/wedding/slot/:id" element={<SlotDetail />} />)
    await waitFor(() => expect(screen.getByText('Чат по сделке')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Чат по сделке'))
    expect(await screen.findByText(RATE_LIMITED)).toBeTruthy()
  })

  it('экран сделки: «Написать» с 429 — текст под кнопкой', async () => {
    serve(base({ '/weddings/w1/slots': [catalogSlot], '/deals/d1/events': [], '/chats/vendor/v1': withStatus(429, 'rate_limited', RATE_LIMITED) }))
    renderAt('/deal/d1', <Route path="/deal/:id" element={<Deal />} />)
    await waitFor(() => expect(screen.getByText('Написать')).toBeTruthy(), { timeout: 4000 })
    fireEvent.click(screen.getByText('Написать'))
    expect(await screen.findByText(RATE_LIMITED)).toBeTruthy()
  })

  it('день X: «Написать всей команде», «Чат дня X» и чип подрядчика — отказ словами у своей кнопки', async () => {
    serve(base({
      '/weddings/w1/slots': [catalogSlot],
      '/weddings/w1/timeline': [],
      '/weddings/w1/planb': { checklist: [], activatedAt: null },
      '/chats': withStatus(429, 'rate_limited', RATE_LIMITED),
      '/chats/vendor/v1': withStatus(429, 'rate_limited', 'Подрядчику сейчас не написать'),
    }))
    const r = renderAt('/dayx', <Route path="/dayx" element={<DayX />} />)
    await waitFor(() => expect(text(r)).toContain('Елена Фото'), { timeout: 4000 })

    fireEvent.click(screen.getByText('Написать всей команде'))
    expect(await screen.findByText(RATE_LIMITED)).toBeTruthy()
    /* Строка стоит под нижней кнопкой, а не у верхней карточки. */
    expect(screen.getByText(RATE_LIMITED).previousElementSibling?.textContent).toContain('Написать всей команде')

    fireEvent.click(screen.getByText('Чат дня X'))
    await waitFor(() => expect(screen.getAllByText(RATE_LIMITED).length).toBe(1))

    fireEvent.click(screen.getByText(/Елена Фото/))
    expect(await screen.findByText('Подрядчику сейчас не написать')).toBeTruthy()
  })
})

/* ── RF-05: список чатов — «Откроется …» сменяется сам ──────────────────── */

describe('RF-05: в списке чатов «Откроется …» сменяется репликой без перемонтирования', () => {
  beforeEach(() => {
    couple()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2027-06-14T08:59:50.000Z'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('чат дня X открывается через 10 с — после опроса в 30 с показана последняя реплика', async () => {
    serve(base({
      '/chats': [{ id: 'ch1', kind: 'day', title: 'Чат дня X', unread: 0, lastMessage: 'Мы на месте', openFrom: '2027-06-14T09:00:00.000Z' }],
    }))
    const r = renderAt('/us/chats', <Route path="/us/chats" element={<Chats />} />)
    await waitFor(() => expect(text(r)).toContain('Откроется'), { timeout: 4000 })
    expect(text(r)).not.toContain('Мы на месте')

    await act(async () => { vi.advanceTimersByTime(30_000) })
    await waitFor(() => expect(text(r)).toContain('Мы на месте'), { timeout: 4000 })
    expect(text(r), '«Откроется» держится после срока открытия').not.toContain('Откроется')
  })
})

/* ── RF-06: страница гостя не размонтируется при перечитывании ──────────── */

describe('RF-06: приглашение гостя после ответа остаётся на экране', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const PAGE = { guestName: 'Марина', status: 'pending', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, inviteText: 'Ждём вас', inviteThemeId: 0 } }

  it('после «Приду» при зависшем втором getRsvp имя гостя и блок RSVP на месте, заглушки нет', async () => {
    let gets = 0
    const calls = serve({
      '/rsvp/tok1': (c: Call) => (c.method === 'POST' ? { ok: true } : ++gets === 1 ? PAGE : PENDING),
      '/join/tok1/menu-vote': { question: '', options: [] },
      '/join/tok1/shuttle': { routes: [] },
      '/join/tok1/hotels': [],
    })
    const r = render(<MemoryRouter initialEntries={['/invite']}><Routes><Route path="/invite" element={<Invite />} /></Routes></MemoryRouter>)
    await waitFor(() => expect(text(r)).toContain('Марина'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Приду с радостью'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/rsvp/tok1')).toBe(true))
    await waitFor(() => expect(gets).toBe(2))

    expect(text(r), 'страница гостя размонтирована на время перечитывания').toContain('Марина')
    expect(text(r)).toContain('Вы придёте?')
    expect(text(r)).not.toContain('Открываем приглашение…')
    /* Ответ ушёл, свежая страница ещё не пришла — кнопки заняты, а не «живая» форма. */
    expect(screen.getByText('Отправляем…').closest('button')!.hasAttribute('disabled')).toBe(true)
  })
})

/* ── RF-07: регистрация без активного воркера — выход не ждёт sw.ready ──── */

describe('RF-07: service worker зарегистрирован, но не активен — выход не виснет', () => {
  beforeEach(() => { signedIn(); vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'BAbc123_-key') })
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); Reflect.deleteProperty(navigator, 'serviceWorker') })

  it('signOutEverywhere() завершается, сессии погашены, push не трогается', async () => {
    let subscriptionsAsked = 0
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        /* Установка сорвалась: `ready` не ответит никогда. */
        ready: new Promise(() => {}),
        getRegistration: async () => ({ active: null, pushManager: { getSubscription: async () => { subscriptionsAsked++; return null } } }),
      },
      configurable: true,
    })
    vi.stubGlobal('PushManager', function PushManager() { /* признак поддержки */ })
    vi.stubGlobal('Notification', { permission: 'default', requestPermission: async () => 'granted' })
    const calls = serve(base())

    const outcome = await Promise.race([
      signOutEverywhere().then(() => 'done'),
      new Promise<string>(resolve => setTimeout(() => resolve('hang'), 3000)),
    ])
    expect(outcome, 'выход завис на navigator.serviceWorker.ready').toBe('done')
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/users/me/sessions', '/users/me/sessions/this-one'])
    expect(subscriptionsAsked, 'подписку спросили у регистрации без активного воркера').toBe(0)
    expect(storedTokens()).toBeNull()
  })
})

/* ── RF-09: редактор приглашений — по роли ──────────────────────────────── */

describe('RF-09: редактор приглашений не паре — только чтение', () => {
  beforeEach(couple)
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  const guests = [
    { id: 'g1', name: 'Без ссылки', status: 'pending', plusOne: false, inviteUrl: null, inviteUrlUsed: false },
    { id: 'g2', name: 'Уже открыл', status: 'yes', plusOne: false, inviteUrl: null, inviteUrlUsed: true },
  ]
  const editorRoutes = (role: string): Routes => base({
    '/weddings': [{ ...WEDDING, role }],
    '/weddings/w1': { ...WEDDING, inviteText: 'Ждём вас на нашей свадьбе', inviteThemeId: 3 },
    '/weddings/w1/guests': guests,
  })

  it('помощнику: превью и гости есть, кнопок «Сохранить оформление», «Выдать ссылку», «Перевыпустить» нет, подпись «у пары»', async () => {
    serve(editorRoutes('helper'))
    const r = renderAt('/wedding/invites', <Route path="/wedding/invites" element={<InviteEditor />} />)
    await waitFor(() => expect(text(r)).toContain('Без ссылки'), { timeout: 4000 })
    await waitFor(() => expect(text(r)).toContain('Оформление и ссылки — у пары'), { timeout: 4000 })
    expect(screen.queryByText('Выдать ссылку'), '«Выдать ссылку» у помощника — 403 после нажатия').toBeNull()
    expect(screen.queryByText('Перевыпустить')).toBeNull()
    expect(screen.queryByText('Сохранить оформление')).toBeNull()
    expect(screen.queryByText('Сценарий приглашения')).toBeNull()
    expect(text(r)).toContain('Ждём вас на нашей свадьбе')
    expect(text(r)).toContain('Открыта ✓')
  })

  it('паре кнопки есть (контроль)', async () => {
    serve(editorRoutes('couple'))
    const r = renderAt('/wedding/invites', <Route path="/wedding/invites" element={<InviteEditor />} />)
    await waitFor(() => expect(text(r)).toContain('Без ссылки'), { timeout: 4000 })
    expect(await screen.findByText('Выдать ссылку')).toBeTruthy()
    expect(screen.getByText('Перевыпустить')).toBeTruthy()
    expect(screen.getByText('Сохранить оформление')).toBeTruthy()
    expect(screen.queryByText('Оформление и ссылки — у пары')).toBeNull()
  })

  it('список свадеб упал: причина и «Повторить» на месте редактора', async () => {
    serve({ ...editorRoutes('couple'), '/weddings': DOWN })
    const r = renderAt('/wedding/invites', <Route path="/wedding/invites" element={<InviteEditor />} />)
    await waitFor(() => expect(text(r)).toContain('Без ссылки'), { timeout: 4000 })
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Сервер недоступен'), { timeout: 4000 })
    expect(screen.getByText('Повторить')).toBeTruthy()
    expect(screen.queryByText('Выдать ссылку')).toBeNull()
  })
})

/* ── RF-08: две вкладки, один refresh ───────────────────────────────────── */

describe('RF-08: обмен refresh из двух вкладок', () => {
  beforeEach(signedIn)
  afterEach(() => { vi.unstubAllGlobals() })

  /** `/users/me`: по старому access — 401 с истёкшим токеном, по новому — профиль. */
  const meByToken = (c: Call) =>
    c.headers.authorization === 'Bearer a' ? withStatus(401, 'token_expired', 'Срок действия токена истёк') : { id: 'u1' }

  it('проигравшая вкладка при refresh_superseded ждёт пару соседки из хранилища, а не стирает его', async () => {
    let refreshes = 0
    const calls = serve({
      '/users/me': meByToken,
      /* Победившая вкладка получает пару с задержкой; проигравшей сервер отвечает сразу. */
      '/auth/refresh': () => (++refreshes === 1
        ? delayed(80, { accessToken: 'a2', refreshToken: 'r2' })
        : withStatus(401, 'refresh_superseded', 'Токен обновления уже обменян — возьмите новый из хранилища')),
    })
    /* Две вкладки — два экземпляра модуля с общим localStorage: у каждой свой `refreshing`. */
    vi.resetModules()
    const tabA = await import('@/lib/api/client')
    vi.resetModules()
    const tabB = await import('@/lib/api/client')

    const a = tabA.api.get('/users/me').catch((e: unknown) => e)
    const b = tabB.api.get('/users/me').catch((e: unknown) => e)
    const [resA, resB] = await Promise.all([a, b])

    expect(resB, 'вторая вкладка выброшена на вход: «сессия истекла»').not.toBeInstanceOf(Error)
    expect(resB).toEqual({ id: 'u1' })
    expect(resA).toEqual({ id: 'u1' })
    expect(storedTokens()).toEqual({ accessToken: 'a2', refreshToken: 'r2' })
    /* Обе вкладки повторили запрос по паре, которую положила победившая. */
    expect(calls.filter(c => c.path === '/users/me' && c.headers.authorization === 'Bearer a2').length).toBe(2)
    expect(refreshes).toBe(2)
  })

  it('пара под проигравшей так и не сменилась — вход кончился, хранилище пусто', async () => {
    serve({
      '/users/me': meByToken,
      '/auth/refresh': withStatus(401, 'refresh_superseded', 'Токен обновления уже обменян — возьмите новый из хранилища'),
    })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('session_expired')
    expect(storedTokens()).toBeNull()
  })

  it('403 на refresh — не конец входа: токены целы, наружу отказ сервера', async () => {
    serve({ '/users/me': meByToken, '/auth/refresh': withStatus(403, 'forbidden', 'Запрещено прокси') })
    const err = await api.get('/users/me').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code, 'токены стёрты по 403 не от приложения').not.toBe('session_expired')
    expect((err as ApiError).status).toBe(403)
    expect(storedTokens()).toEqual(TOKENS)
  })
})

/* ── Хвосты фиксера FE-D (§4 отчёта): опрос чатов, свойства устройства, слот без входа ── */

describe('хвосты после RF: опрос чатов не стирает список, выход хранит тему, слот без входа зовёт войти', () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

  it('список чатов при опросе раз в 30 с не пустеет, пока свежий ответ в пути', async () => {
    couple()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let calls = 0
    serve(base({
      '/chats': () => (++calls === 1
        ? [{ id: 'ch1', kind: 'team', title: 'Команда свадьбы', unread: 0, lastMessage: 'Едем', openFrom: null }]
        : PENDING),
    }))
    const r = renderAt('/us/chats', <Route path="/us/chats" element={<Chats />} />)
    await waitFor(() => expect(text(r)).toContain('Команда свадьбы'), { timeout: 4000 })
    await act(async () => { vi.advanceTimersByTime(30_000) })
    /* Опрос через счётчик в зависимостях стирал данные и рисовал «Загружаем…»
       каждые полминуты (тот же класс, что RF-02). */
    expect(text(r), 'список чатов исчез на время опроса').toContain('Команда свадьбы')
    expect(text(r)).not.toContain('Загружаем…')
  })

  it('выход со всех устройств не стирает тему, язык и город устройства', async () => {
    couple()
    localStorage.setItem('tt_theme', 'dark')
    localStorage.setItem('tt_lang', 'en')
    localStorage.setItem('tt_city', 'Казань')
    serve(base())
    const { signOutEverywhere } = await import('./api/auth')
    await signOutEverywhere()
    expect(storedTokens()).toBeNull()
    expect(localStorage.getItem('tt_wedding_id')).toBeNull()
    // Свойства устройства — не данные человека (CLAUDE.md §5 п. 12): переживают выход.
    expect(localStorage.getItem('tt_theme')).toBe('dark')
    expect(localStorage.getItem('tt_lang')).toBe('en')
    expect(localStorage.getItem('tt_city')).toBe('Казань')
  })

  it('экран слота без входа — «Войдите», а не «Загружаем…» навсегда', async () => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
    serve({})
    const r = renderAt('/wedding/slot/s1', <Route path="/wedding/slot/:id" element={<SlotDetail />} />)
    await waitFor(() => expect(text(r)).toContain('Войдите, чтобы увидеть свою свадьбу'), { timeout: 4000 })
    expect(text(r)).not.toContain('Загружаем…')
  })
})
