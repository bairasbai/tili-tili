// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, useLocation } from 'react-router'
import { WeeklyOrderTerms } from '@/components/WeeklyOrderTerms'
import WeeklyAgenda from '@/pages/WeeklyAgenda'
import { readWeeklyOrderTerms } from './api/weeklyOrderTerms'
import { saveTokens } from './api/client'
import { setI18nLang } from './i18n'

// Actual components/session fencing/API client; controlled transport, not PostgreSQL evidence.
const selection = vi.hoisted(() => ({ weddingId: '00000000-0000-4000-8000-000000000001' }))
vi.mock('./store', () => ({ useStore: () => selection }))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = 'a'.repeat(64)
const token = (user = 'a', session = 's', exp = 2100000000) => ({ accessToken: `e30.${btoa(JSON.stringify({ sub: user, sid: session, exp }))}.signature`, refreshToken: 'TEST_ONLY_REFRESH' })
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }
function terms(sides: string[] = [], freshness = 'current') {
  const row = { id: id(90), version: '1', sourceOrderVersion: '1', sourceFingerprint: digest, digest, snapshot: { private: 'PRIVATE_SNAPSHOT' }, publishedBy: id(80), publishedSide: 'customer', publishedAt: '2026-10-06T09:00:00Z', freshness, acceptedByCaller: false,
    receipts: sides.map((party, i) => ({ id: id(100 + i), party, userId: id(200 + i), sessionId: id(300 + i), digest, acceptedAt: '2026-10-06T10:00:00Z' })) }
  return { revision: '1', proposedTermsId: row.id, agreedTermsId: sides.length === 2 ? row.id : null, history: [row], selected: row, readToken: 'PRIVATE_READ_PROOF', acceptedByCaller: false }
}
function slot(n: number) { return { id: id(n + 50), label: 'Photographer', prebooked: false, deal: { id: id(n), state: 'booked', vendor: null, externalName: `Order ${n}` } } }
let slots: unknown[], result: unknown, calls: { path: string; method: string }[], catalogWedding: string, catalogRole: string
let intercept: ((path: string) => Response | Promise<Response> | undefined) | null
let storageAtStart: string
function Location() { return <output data-testid="location">{useLocation().pathname}</output> }
function open(weddingId = id(1)) { return render(<MemoryRouter><WeeklyOrderTerms weddingId={weddingId} /><Location /></MemoryRouter>) }
function check() { fireEvent.click(screen.getByRole('button', { name: 'Проверить условия заказов' })) }
beforeEach(() => {
  localStorage.clear(); saveTokens(token()); setI18nLang('ru'); selection.weddingId = id(1)
  slots = [slot(11)]; result = terms(['customer']); calls = []; intercept = null; catalogWedding = id(1); catalogRole = 'couple'
  storageAtStart = JSON.stringify(localStorage)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://localhost').pathname.replace(/^\/api/, '')
    calls.push({ path, method: init?.method ?? 'GET' })
    const override = intercept?.(path); if (override !== undefined) return override
    if (path.endsWith('/slots')) return json(slots)
    if (path.endsWith('/order/catalog')) return json({ weddingId: catalogWedding, actorRole: catalogRole, draftEditable: true, category: { fields: [] } })
    if (path.endsWith('/order/terms')) return json(result)
    if (path === `/weddings/${id(1)}`) return json({ id: id(1), tz: 'Europe/Moscow' })
    if (path.endsWith('/tasks') || path.endsWith('/guests')) return json([])
    return json({ error: { message: 'Fixture path unavailable' } }, 503)
  }))
})
afterEach(() => { cleanup(); saveTokens(null); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('weekly terms via real typed HTTP client', () => {
  it('is integrated into the actual weekly screen without automatic order reads', async () => {
    render(<MemoryRouter><WeeklyAgenda /></MemoryRouter>)
    await screen.findByRole('heading', { name: 'Условия заказов' })
    expect(calls.some(c => c.path.endsWith('/slots') || c.path.includes('/order/'))).toBe(false)
  })
  it('is collapsed initially and checks an explicit current scope before reading terms', async () => {
    open(); expect(calls).toEqual([]); check()
    await screen.findByText('Ожидается подтверждение исполнителя')
    expect(calls.map(c => c.path)).toEqual([`/weddings/${id(1)}/slots`, `/deals/${id(11)}/order/catalog`, `/deals/${id(11)}/order/terms`])
    expect(calls.every(c => c.method === 'GET')).toBe(true)
    expect(screen.getByText('Внешний контакт не является подтверждением исполнителя в приложении.')).toBeTruthy()
    expect(JSON.stringify(localStorage)).toBe(storageAtStart)
    expect(document.body.textContent).not.toContain('PRIVATE_')
  })
  it('opens the existing deal route, not a new approval command', async () => {
    open(); check(); fireEvent.click(await screen.findByRole('link', { name: 'Открыть заказ для проверки условий' }))
    expect(screen.getByTestId('location').textContent).toBe(`/deal/${id(11)}`)
    expect(calls.every(c => c.method === 'GET')).toBe(true)
  })
  it.each([
    [[], 'current', 'Ожидается подтверждение пары и исполнителя'],
    [['performer'], 'current', 'Ожидается подтверждение пары'],
    [['customer', 'performer'], 'current', 'Текущая редакция согласована обеими сторонами'],
    [['customer', 'performer'], 'stale', 'Описание заказа изменилось — условия нужно обновить'],
  ])('shows actual party metadata %j/%s', async (sides, freshness, label) => {
    result = terms(sides, freshness); open(); check(); await screen.findByText(label)
  })
  it('treats an empty authoritative slot list separately from a read failure', async () => {
    slots = []; open(); check(); await screen.findByText('Активных сделок в текущих слотах нет.')
    expect(calls).toHaveLength(1)
  })
  it('does not describe a failed slot request as no orders', async () => {
    intercept = path => path.endsWith('/slots') ? json({ error: { message: 'No slots transport' } }, 503) : undefined
    open(); check(); await screen.findByRole('alert')
    expect(screen.queryByText('Активных сделок в текущих слотах нет.')).toBeNull()
  })
  it.each(['wrong wedding', 'vendor role', '403'])('refuses %s before a terms request and offers no false retry or deal link', async kind => {
    if (kind === 'wrong wedding') catalogWedding = id(2)
    if (kind === 'vendor role') catalogRole = 'vendor'
    if (kind === '403') intercept = path => path.endsWith('/order/catalog') ? json({ error: { message: 'Terms access denied' } }, 403) : undefined
    open(); check(); await screen.findByRole('alert')
    expect(calls.some(c => c.path.endsWith('/order/terms'))).toBe(false)
    expect(screen.queryByRole('link')).toBeNull(); expect(screen.queryByRole('button', { name: 'Обновить проверку условий' })).toBeNull()
  })
  it('keeps a failed order unknown while showing another checked order; explicit refresh removes stale statuses', async () => {
    slots = [slot(11), slot(12)]
    intercept = path => path === `/deals/${id(11)}/order/terms` ? json({ error: { message: 'Term transport down' } }, 503) : undefined
    open(); check(); await screen.findByText('Есть непроверенные заказы. Ошибка чтения не означает согласование.')
    expect(screen.getByText('Ожидается подтверждение исполнителя')).toBeTruthy()
    expect(screen.getAllByRole('link')).toHaveLength(1)
    let finish!: (r: Response) => void
    intercept = path => path.endsWith('/slots') ? new Promise(r => { finish = r }) : undefined
    fireEvent.click(screen.getByRole('button', { name: 'Обновить проверку условий' }))
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(screen.queryByText('Ожидается подтверждение исполнителя')).toBeNull()
    intercept = null
    await act(async () => finish(json(slots)))
    await waitFor(() => expect(screen.getAllByText('Ожидается подтверждение исполнителя')).toHaveLength(2))
  })
  it('does not call a malformed terms response agreement', async () => {
    result = {}; open(); check(); await screen.findByRole('alert')
    expect(screen.queryByText('Текущая редакция согласована обеими сторонами')).toBeNull()
  })
  it('bounds concurrent order reads and preserves server slot order', async () => {
    slots = Array.from({ length: 8 }, (_, i) => slot(11 + i))
    let inFlight = 0, maximum = 0
    intercept = asyncPath => {
      if (!asyncPath.endsWith('/order/catalog')) return undefined
      inFlight++; maximum = Math.max(maximum, inFlight)
      return new Promise(resolve => setTimeout(() => { inFlight--; resolve(json({ weddingId: id(1), actorRole: 'couple' })) }, 3))
    }
    const checked = await readWeeklyOrderTerms(id(1), () => undefined)
    expect(maximum).toBe(3); expect(checked.map(x => x.dealId)).toEqual(Array.from({ length: 8 }, (_, i) => id(11 + i)))
  })
  it.each(['unmount', 'logout', 'switch account', 'switch wedding'])('stops queued work and drops a delayed private result on %s', async transition => {
    slots = Array.from({ length: 5 }, (_, i) => slot(11 + i))
    const finish: ((r: Response) => void)[] = []
    intercept = path => path.endsWith('/order/catalog') ? new Promise(resolve => { finish.push(resolve) }) : undefined
    const view = open(); check(); await waitFor(() => expect(finish).toHaveLength(3))
    if (transition === 'unmount') view.unmount()
    if (transition === 'logout') act(() => saveTokens(null))
    if (transition === 'switch account') act(() => saveTokens(token('b', 't')))
    if (transition === 'switch wedding') view.rerender(<MemoryRouter><WeeklyOrderTerms weddingId={id(2)} /><Location /></MemoryRouter>)
    await act(async () => { for (const complete of finish) complete(json({ weddingId: id(1), actorRole: 'couple' })) })
    expect(calls).toHaveLength(4); expect(calls.some(c => c.path.endsWith('/order/terms'))).toBe(false)
    expect(screen.queryByText('Order 11')).toBeNull()
  })
  it('retains the reader during same-session renewal without new requests', async () => {
    open(); check(); await screen.findByText('Ожидается подтверждение исполнителя'); const count = calls.length
    act(() => saveTokens(token('a', 's', 2100000300)))
    expect(screen.getByText('Ожидается подтверждение исполнителя')).toBeTruthy(); expect(calls).toHaveLength(count)
  })
  it('translates statuses and warnings in English', async () => {
    setI18nLang('en'); open(); fireEvent.click(screen.getByRole('button', { name: 'Check order terms' }))
    await screen.findByText('Awaiting confirmation from the performer')
    const section = screen.getByRole('region', { name: 'Order terms' })
    expect(within(section).getByText('An external contact is not a performer confirmation in the app.')).toBeTruthy()
    expect(within(section).getByRole('link', { name: 'Open order to review terms' })).toBeTruthy()
  })
})
