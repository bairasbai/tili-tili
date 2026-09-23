// @vitest-environment jsdom
/*
 * FL-02 · SB-01 (ERR-0272 / R-272, review-016) — внешняя ссылка на гостя-подрядчика
 * `/guest-vendor/{token}` не имела экрана: сервер отдаёт рабочий URL
 * (`backend/src/routes/slots.ts:534`, `POST …/external/invite`), карточка
 * «Пригласить в приложение» (`Wedding.tsx:327-337`) обещает подрядчику дату,
 * тайминг и чат — а `App.tsx` такого маршрута не знал, и `*` уводил его на
 * онбординг. Три операции контракта (`GET /guest-vendor/{token}`,
 * `GET/POST …/messages`) не имели вызова во фронте (R-265).
 *
 * Харнесс `serve`/`open`/`text`/`withStatus` — из audit48: полный `App`, без
 * входа (у гостя-подрядчика нет аккаунта — только токен в самой ссылке, как
 * у гостя дня X).
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'
import { projectFile } from '@/test/projectFiles'

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
    if (isStatus(reply)) return Promise.resolve(json(reply.body, reply.__status))
    return Promise.resolve(json(reply))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''
const posts = (calls: Call[], path: string) => calls.filter(c => c.method === 'POST' && c.path === path)
const gets = (calls: Call[], path: string) => calls.filter(c => c.method === 'GET' && c.path === path)

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const TIMELINE = [{ id: 'e1', name: 'Церемония', startsAt: '2027-06-14T12:00:00+05:00', forGuests: true }]
const SLOT = { id: 's-photo', categoryId: 'photo', label: 'Фотограф', deal: null, tileState: 'empty' as const }
const MESSAGES_INITIAL = {
  items: [{ id: 'm1', chatId: 'c1', senderId: null, text: 'Здравствуйте, ждём вас', sentAt: '2027-06-13T10:00:00.000Z', system: false, mine: false }],
  nextCursor: null,
}

describe('FL-02 · /guest-vendor/:token — кабинет гостя-подрядчика (SB-01, ERR-0272)', () => {
  it('T1 по ссылке — кабинет, не онбординг', async () => {
    const calls = serve({
      '/guest-vendor/tok1': { weddingDate: '2027-06-14', slot: SLOT, chatId: 'c1', holdHours: 72, timeline: TIMELINE },
      '/guest-vendor/tok1/messages': MESSAGES_INITIAL,
    })
    const r = await open('/guest-vendor/tok1', 'Церемония')
    /* Реальные строки онбординга (Onboarding.tsx:10,35) — не заголовок вкладки
       (тот `document.title`, никогда не текст DOM, ERR-0251 класс). */
    expect(text(r)).not.toContain('Пропустить')
    expect(text(r)).not.toContain('Все специалисты')
    /* Сообщение — из отдельного запроса чата (`GuestVendorChat`), он может
       прийти чуть позже основного «Церемония» — ждём отдельно. */
    await waitFor(() => expect(text(r)).toContain('Здравствуйте, ждём вас'), { timeout: 4000 })
    expect(r.container.querySelector('nav.glass-tab'), 'на этом маршруте нет нижней навигации').toBeNull()
    expect(gets(calls, '/guest-vendor/tok1').length).toBeGreaterThanOrEqual(1)
  })

  it('T2 написать паре: один POST, затем список сообщений перечитан', async () => {
    let msgGets = 0
    const calls = serve({
      '/guest-vendor/tok1': { weddingDate: '2027-06-14', slot: SLOT, chatId: 'c1', holdHours: 72, timeline: TIMELINE },
      '/guest-vendor/tok1/messages': (c: Call) => {
        if (c.method === 'POST') {
          return { id: 'm2', chatId: 'c1', senderId: null, text: (c.body as { text: string }).text, sentAt: '2027-06-13T11:00:00.000Z', system: false, mine: true }
        }
        msgGets++
        return MESSAGES_INITIAL
      },
    })
    await open('/guest-vendor/tok1', 'Церемония')
    const input = screen.getByPlaceholderText(/Сообщение/i)
    fireEvent.change(input, { target: { value: 'Уже еду, буду в 12' } })
    fireEvent.click(screen.getByLabelText('Отправить'))
    await waitFor(() => expect(posts(calls, '/guest-vendor/tok1/messages')).toHaveLength(1))
    expect(posts(calls, '/guest-vendor/tok1/messages')[0]!.body).toEqual({ text: 'Уже еду, буду в 12' })
    await waitFor(() => expect(msgGets).toBeGreaterThanOrEqual(2))
  })

  it('T3 ссылка истекла: полноэкранное сообщение и ничего больше', async () => {
    serve({ '/guest-vendor/tok2': withStatus(410, 'gone', 'Ссылка истекла или отозвана') })
    const r = await open('/guest-vendor/tok2', 'Ссылка истекла')
    expect(text(r)).not.toContain('Церемония')
    expect(r.container.querySelector('input')).toBeNull()
    expect(r.container.querySelector('button[aria-label="Отправить"]')).toBeNull()
  })

  it('T4 дата ещё не выбрана — словами, а не выдуманным числом (R-178)', async () => {
    serve({
      '/guest-vendor/tok3': { weddingDate: null, slot: { id: 's-mc', categoryId: 'host', label: 'Ведущий', deal: null, tileState: 'empty' }, chatId: 'c3', holdHours: 24, timeline: [] },
      '/guest-vendor/tok3/messages': { items: [], nextCursor: null },
    })
    const r = await open('/guest-vendor/tok3', 'Пара ещё не выбрала дату')
    expect(text(r)).not.toMatch(/\d{2}\.\d{2}\.\d{4}/)
  })

  it('T5 исходники: адреса контракта и маршрут прописаны', () => {
    expect(projectFile('src/lib/api/guestVendor.ts')).toContain('/guest-vendor/{token}')
    expect(projectFile('src/lib/api/guestVendor.ts')).toContain('/guest-vendor/{token}/messages')
    expect(projectFile('index.html')).toMatch(/SEGMENTS = \[[^\]]*'guest-vendor'/)
    expect(projectFile('src/App.tsx')).toContain('path="/guest-vendor/:token"')
  })
})
