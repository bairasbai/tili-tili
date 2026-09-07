// @vitest-environment jsdom
/*
 * Аудит, блок 5: каждая кнопка делает то, что на ней написано (R-176).
 *
 * Три дыры, найденные инвентаризацией 337 элементов:
 *  — форма гостя не спрашивала еду и трансфер, хотя контракт их принимает с
 *    v0.24, — кейтеринг не узнавал об аллергиях никогда;
 *  — телефон гостя ввести было негде, и «Напомнить не ответившим» не имела
 *    ни одного адресата;
 *  — три тумблера «Вопросы в RSVP» в редакторе приглашений переключали
 *    состояние экрана и никуда не уходили.
 * Здесь проверяется тело запроса, которое уходит на сервер, — не то, что
 * нарисовал экран.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Routes = Record<string, unknown>
type Call = { method: string; path: string; body: unknown }

/* Сеть по таблице (как в audit17) плюс журнал запросов: проверяем, ЧТО ушло. */
function serve(routes: Routes): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '').split('?')[0] ?? ''
    const method = init?.method ?? 'GET'
    let body: unknown = null
    try { body = init?.body ? JSON.parse(String(init.body)) : null } catch { body = init?.body }
    calls.push({ method, path, body })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    return Promise.resolve(json(routes[path]))
  }))
  return calls
}

const WEDDING = { id: 'w1', title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' }, tz: 'Asia/Yekaterinburg', dressCode: 'd1' }
const COUPLE_OK: Routes = {
  '/weddings': [WEDDING],
  '/weddings/w1': WEDDING,
  '/weddings/w1/slots': [],
  '/weddings/w1/guests': [{ id: 'g1', name: 'Гость Первый', status: 'pending', plusOne: false, phone: null }],
  '/notifications': [],
  '/me/favorites': [],
}

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull())
  await waitFor(() => expect(r.container.textContent ?? '').toContain(settled), { timeout: 4000 })
  return r
}

describe('гость: еда и трансфер уходят на сервер вместе с ответом', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_guest_token', 'tok1')
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Приду с радостью» шлёт plusOne, diet и transfer, а страница показывает выбранное', async () => {
    const calls = serve({
      '/rsvp/tok1': { guestName: 'Марина', status: 'pending', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14', city: { name: 'Уфа' } } },
      '/join/tok1/menu-vote': { options: [] },
      '/join/tok1/shuttle': { routes: [] },
      '/join/tok1/hotels': [],
    })
    await open('/invite', 'Вы придёте?')
    fireEvent.click(screen.getByText('Открыть приглашение'))
    fireEvent.click(screen.getByText('С +1'))
    fireEvent.click(screen.getByText('Веганское'))
    fireEvent.click(screen.getByText('Нужен трансфер'))
    fireEvent.click(screen.getByText('Приду с радостью'))

    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/rsvp/tok1')).toBe(true))
    const sent = calls.find(c => c.method === 'POST' && c.path === '/rsvp/tok1')!.body as Record<string, unknown>
    expect(sent).toMatchObject({ status: 'yes', plusOne: true, diet: 'vegan', transfer: 'need' })
  })

  it('уже ответивший видит свой выбор с сервера и может его изменить', async () => {
    serve({
      '/rsvp/tok1': { guestName: 'Марина', status: 'yes', plusOne: true, diet: 'other', dietNote: 'орехи', transfer: 'own', wedding: { title: 'Аня ♥ Боря', date: '2027-06-14' } },
      '/join/tok1/menu-vote': { options: [] },
      '/join/tok1/shuttle': { routes: [] },
      '/join/tok1/hotels': [],
    })
    const { container } = await open('/invite', 'Ждём вас!')
    expect(container.textContent).toContain('С +1 · орехи · Доберусь сам(а)')
    fireEvent.click(screen.getByText('Изменить ответ'))
    /* Форма открывается с прежними значениями, а не пустой. */
    expect(screen.getByText('Приду с радостью')).toBeTruthy()
    expect(screen.getByDisplayValue('орехи')).toBeTruthy()
  })
})

describe('пара: телефон гостя вводится и уходит на сервер', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('«Добавить» шлёт телефон в E.164, «+ телефон для напоминания» — PATCH', async () => {
    const calls = serve(COUPLE_OK)
    await open('/wedding/guests', 'Гость Первый')
    fireEvent.click(screen.getByLabelText('Добавить гостя'))
    fireEvent.change(screen.getByPlaceholderText('Имя гостя или семьи'), { target: { value: 'Ирина' } })
    fireEvent.change(screen.getByPlaceholderText('Телефон — для SMS-напоминания (необязательно)'), { target: { value: '917 000-11-22' } })
    fireEvent.click(screen.getByText('Добавить'))
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/weddings/w1/guests')).toBe(true))
    expect(calls.find(c => c.method === 'POST' && c.path === '/weddings/w1/guests')!.body).toMatchObject({ name: 'Ирина', phone: '+79170001122' })

    fireEvent.click(screen.getByText('+ телефон для напоминания'))
    fireEvent.change(screen.getByLabelText('Телефон гостя'), { target: { value: '9170003344' } })
    fireEvent.click(screen.getByText('Сохранить'))
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH' && c.path === '/weddings/w1/guests/g1')).toBe(true))
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/weddings/w1/guests/g1')!.body).toEqual({ phone: '+79170003344' })
  })
})

describe('редактор приглашений и мастер договора не обещают того, чего нет', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
    localStorage.setItem('tt_wedding_id', JSON.stringify('w1'))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('тумблеров «Вопросы в RSVP» нет — есть объяснение, что спросит приглашение', async () => {
    serve(COUPLE_OK)
    const { container } = await open('/wedding/invites', 'Что спросит приглашение')
    expect(container.textContent).not.toContain('Вопросы в RSVP')
    expect(screen.queryByLabelText('Предпочтения по еде')).toBeNull()
  })

  it('«Договор готов» не обещает загрузку скана в сделку', async () => {
    serve(COUPLE_OK)
    const { container } = await open('/wedding/documents/new', 'Новый договор')
    fireEvent.click(screen.getByText('Далее'))
    fireEvent.click(screen.getByText('Сгенерировать договор ✨'))
    await waitFor(() => expect(container.textContent).toContain('Договор готов'))
    expect(container.textContent).not.toContain('загрузите скан')
    expect(container.textContent).toContain('загрузка сканов появится вместе с файловым хранилищем')
  })
})
