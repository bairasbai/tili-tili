/*
 * Фича 013 «Сделки для поддержки» — фронт (решение владельца: сделки да, переписка нет).
 * На карточке свадьбы — кнопка «Показать сделки»: до нажатия запроса к `/deals` нет
 * (каждое чтение чужих денег — своя строка журнала, и нажимает её сотрудник сам);
 * после — `GET /admin/weddings/{id}/deals?reason=…` с той же причиной и список:
 * слот, подрядчик по имени (свой — с пометкой), состояние словами, цена, оплачено,
 * последнее событие. Пусто — «Сделок у свадьбы нет». Красный без фикса: кнопки не было.
 */
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import App from '@/App'

type Call = { method: string; path: string; url: string }

function serve(routes: Record<string, unknown>): Call[] {
  const calls: Call[] = []
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const full = String(input).replace(/^\/api/, '')
    const path = full.split('?')[0] ?? ''
    calls.push({ method: init?.method ?? 'GET', path, url: full })
    if (!(path in routes)) return Promise.resolve(json({ error: { code: 'not_found', message: `нет ответа для ${path}` } }, 404))
    return Promise.resolve(json(routes[path]))
  }))
  return calls
}

const text = (r: { container: HTMLElement }) => r.container.textContent ?? ''

async function open(route: string, settled: string) {
  const r = render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>)
  await waitFor(() => expect(r.container.querySelector('[data-testid="route-loading"]')).toBeNull(), { timeout: 4000 })
  await waitFor(() => expect(text(r)).toContain(settled), { timeout: 4000 })
  return r
}

const CARD = { id: 'w9', title: 'Аня и Боря', date: '2027-06-14', city: 'Уфа', style: 'рустик', guestsPlanned: 40, createdAt: '2026-01-05T10:00:00.000Z' }
const DEALS = {
  items: [
    {
      id: 'd1', slotLabel: 'Фотограф', categoryId: 'photo', vendorName: 'Фотостудия Свет', externalName: null, state: 'booked',
      price: { amount: 5_000_000, currency: 'RUB' }, paid: { amount: 1_500_000, currency: 'RUB' }, bookedAt: '2026-09-01T10:00:00.000Z', cancelledAt: null,
      events: [
        { at: '2026-08-30T10:00:00.000Z', by: 'couple', fromState: null, toState: 'candidate', note: null },
        { at: '2026-09-01T10:00:00.000Z', by: 'vendor', fromState: 'negotiating', toState: 'booked', note: 'подтвердил дату' },
      ],
    },
    {
      id: 'd2', slotLabel: 'Флорист', categoryId: 'florist', vendorName: null, externalName: 'Флорист Анна', state: 'negotiating',
      price: null, paid: { amount: 0, currency: 'RUB' }, bookedAt: null, cancelledAt: null, events: [],
    },
  ],
}

async function openCard() {
  const calls = serve({ '/admin/weddings/w9': CARD, '/admin/weddings/w9/deals': DEALS })
  const r = await open('/admin/wedding', 'Открыть карточку')
  fireEvent.change(screen.getByLabelText('Идентификатор свадьбы'), { target: { value: 'w9' } })
  fireEvent.change(screen.getByLabelText('Зачем смотрим'), { target: { value: 'обращение 118: спор о предоплате' } })
  fireEvent.click(screen.getByText('Открыть карточку'))
  await waitFor(() => expect(text(r)).toContain('Аня и Боря'), { timeout: 4000 })
  return { r, calls }
}

describe('фича 013: сделки свадьбы для поддержки', () => {
  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('tt_onboarded', '1')
    localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  })
  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('карточка открыта — сделок ещё нет и запроса к /deals нет; «Показать сделки» → GET с той же причиной → список', async () => {
    const { r, calls } = await openCard()
    expect(text(r), 'подпись о закрытом').toContain('Список гостей и переписка поддержке не показываются')
    expect(calls.some(c => c.path === '/admin/weddings/w9/deals'), 'сделки грузятся только по кнопке').toBe(false)
    expect(text(r)).not.toContain('Фотостудия Свет')

    fireEvent.click(screen.getByText('Показать сделки'))
    await waitFor(() => expect(calls.some(c => c.path === '/admin/weddings/w9/deals')).toBe(true), { timeout: 4000 })
    const sent = calls.find(c => c.path === '/admin/weddings/w9/deals')!
    expect(decodeURIComponent(sent.url)).toContain('reason=обращение 118: спор о предоплате')

    await waitFor(() => expect(text(r)).toContain('Фотостудия Свет'), { timeout: 4000 })
    const t = text(r)
    expect(t).toContain('Сделки · 2')
    expect(t).toContain('Фотограф · Фотостудия Свет')
    expect(t).toContain('забронирован')
    expect(t).toContain('оплачено')
    expect(t).toContain('подрядчик → забронирован · подтвердил дату')
    expect(t).toContain('Флорист · Флорист Анна (свой подрядчик)')
    expect(t).toContain('мягкая бронь · цена не названа')
    expect(screen.queryByText('Показать сделки'), 'после ответа кнопка сменяется списком').toBeNull()
  })

  it('без сделок — «Сделок у свадьбы нет», не пустота', async () => {
    const calls = serve({ '/admin/weddings/w9': CARD, '/admin/weddings/w9/deals': { items: [] } })
    const r = await open('/admin/wedding', 'Открыть карточку')
    fireEvent.change(screen.getByLabelText('Идентификатор свадьбы'), { target: { value: 'w9' } })
    fireEvent.change(screen.getByLabelText('Зачем смотрим'), { target: { value: 'обращение 119' } })
    fireEvent.click(screen.getByText('Открыть карточку'))
    await waitFor(() => expect(text(r)).toContain('Аня и Боря'), { timeout: 4000 })
    fireEvent.click(screen.getByText('Показать сделки'))
    await waitFor(() => expect(text(r)).toContain('Сделок у свадьбы нет'), { timeout: 4000 })
    expect(calls.filter(c => c.path === '/admin/weddings/w9/deals')).toHaveLength(1)
  })
})
