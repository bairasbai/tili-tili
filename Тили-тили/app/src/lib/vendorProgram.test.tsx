// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorProgramReader, VendorPrograms } from '@/pages/VendorPrograms'
import { setI18nLang } from './i18n'
import type { VendorProgram } from './api/vendor'

type Call = { path: string; method: string; body: unknown; headers: Headers }
type Reply = { body?: unknown; status?: number; etag?: string | null; down?: boolean }
const READ = '/vendor/weddings/w1/timeline', ACK = `${READ}/ack`
function program(): VendorProgram {
  return { weddingId: 'w1', wedding: 'Captured couple', sourceVersion: '17', updatedAt: '2026-09-30T07:00:00Z', acknowledgedAt: null, requiresAcknowledgment: true, readToken: 'captured-token', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    blocks: [{ id: 'b1', name: 'Captured ceremony', location: null, startsAt: '2027-06-14T11:00:00.123Z', endsAt: '2027-06-14T11:30:00.123Z', durationMinutes: 30, fixed: true, travelMinutes: 10.5, bufferMinutes: 5.25, outdoor: true, roles: ['responsible'], dependsOn: [], event: { id: 'e1', name: 'Captured event', date: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Hall' } }] }
}
function serve(reply: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call)
    const r = await reply(call)
    if (r.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.etag ? { etag: r.etag } : {}) } })
  }))
  return calls
}
function viewReader() { return render(<MemoryRouter initialEntries={['/vendor-app/programs/w1']}><Routes><Route path="/vendor-app/programs/:weddingId" element={<VendorProgramReader />} /></Routes></MemoryRouter>) }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
async function checkAndAck() { await screen.findByText('Captured ceremony'); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button('Подтвердить ознакомление')) }
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru'); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('vendor permitted program reader', () => {
  it('GET is read-only; shows captured event zone, both exact ends, roles and fractional planning', async () => {
    const calls = serve(() => ({ body: program(), etag: '"17"' }))
    viewReader(); await screen.findByText('Captured ceremony')
    expect(document.body.textContent).toContain('14:00:00,123')
    expect(document.body.textContent).toContain('14:30:00,123')
    expect(document.body.textContent).toContain('Europe/Moscow')
    expect(document.body.textContent).toContain('10.5')
    expect(document.body.textContent).toContain('5.25')
    expect(document.body.textContent).toContain('Ответственный')
    expect(button('Подтвердить ознакомление').disabled).toBe(true)
    expect(calls.map(c => c.method)).toEqual(['GET'])
    expect(localStorage.getItem('captured-token')).toBeNull()
  })
  it('sends only the displayed proof and captured If-Match and shows the actual receipt', async () => {
    const calls = serve(c => c.method === 'GET' ? { body: program(), etag: '"17"' } : { body: { sourceVersion: '17', acknowledgedAt: '2026-09-30T08:00:00Z' } })
    viewReader(); await checkAndAck(); await screen.findByRole('status')
    const ack = calls.find(c => c.path === ACK)!
    expect(ack.body).toEqual({ readToken: 'captured-token' })
    expect(ack.headers.get('If-Match')).toBe('"17"')
    expect(screen.getByRole('status').textContent).toContain('2026-09-30T08:00:00Z')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('network retry sends the identical version/proof, with no silent GET', async () => {
    let posts = 0
    const calls = serve(c => c.method === 'GET' ? { body: program(), etag: '"17"' } : ++posts === 1 ? { down: true } : { body: { sourceVersion: '17', acknowledgedAt: 'receipt-time' } })
    viewReader(); await checkAndAck(); await screen.findByRole('alert')
    fireEvent.click(button('Повторить подтверждение')); await screen.findByRole('status')
    const writes = calls.filter(c => c.method === 'POST')
    expect(writes).toHaveLength(2)
    expect(writes.map(c => c.body)).toEqual([{ readToken: 'captured-token' }, { readToken: 'captured-token' }])
    expect(writes.map(c => c.headers.get('If-Match'))).toEqual(['"17"', '"17"'])
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(1)
  })
  it('stale confirmation clears the old snapshot; explicit reopen requires a new checkbox', async () => {
    let reads = 0
    const calls = serve(c => c.method === 'GET' ? { body: reads++ === 0 ? program() : { ...program(), sourceVersion: '18', readToken: 'fresh-token' }, etag: reads === 1 ? '"17"' : '"18"' } : { status: 409, body: { error: { code: 'timeline_version_conflict', message: 'stale' } } })
    viewReader(); await checkAndAck(); await screen.findByRole('alert')
    expect(screen.queryByText('Captured ceremony')).toBeNull()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(button('Открыть заново')); await screen.findByText('Captured ceremony')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(document.body.textContent).toContain('18')
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })
  it.each([403, 404, 422])('HTTP %s clears private captured data and proof', async status => {
    serve(c => c.method === 'GET' ? { body: program(), etag: '"17"' } : { status, body: { error: { code: 'denied', message: 'Access denied' } } })
    viewReader(); await checkAndAck(); await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('Captured')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it.each([null, '"18"'])('missing or mismatched ETag %s cannot confirm', async etag => {
    const calls = serve(() => ({ body: program(), etag }))
    viewReader(); await screen.findByText('Captured ceremony')
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(button('Подтвердить ознакомление'))
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
  it('unknown interval/zone/date remains unknown, never inherits the main event', async () => {
    const p = program(); p.blocks[0] = { ...p.blocks[0]!, endsAt: null, durationMinutes: null, event: { ...p.blocks[0]!.event, date: null, timeZone: null } }
    serve(() => ({ body: p, etag: '"17"' })); viewReader(); await screen.findByText('Captured ceremony')
    expect(document.body.textContent).toContain('Часовой пояс неизвестен')
    expect(document.body.textContent).toContain('2027-06-14T11:00:00.123Z')
    expect(document.body.textContent).toContain('Окончание неизвестно')
    expect(document.body.textContent).toContain('Длительность неизвестна')
    expect(document.body.textContent).not.toContain('14:30:00')
  })
  it('empty program and already acknowledged version do not offer a mutation', async () => {
    serve(() => ({ body: { ...program(), blocks: [], requiresAcknowledgment: false, readToken: null, expiresAt: null }, etag: '"17"' }))
    viewReader(); await screen.findByText('Назначенных блоков нет')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('receipt of a different version is not shown as success', async () => {
    serve(c => c.method === 'GET' ? { body: program(), etag: '"17"' } : { body: { sourceVersion: '18', acknowledgedAt: 'receipt' } })
    viewReader(); await checkAndAck(); await screen.findByRole('alert')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('Captured ceremony')).toBeNull()
  })
  it('expired read proof cannot be sent even after checking the box', async () => {
    const calls = serve(() => ({ body: { ...program(), expiresAt: new Date(Date.now() - 1000).toISOString() }, etag: '"17"' }))
    viewReader(); await screen.findByText('Срок просмотра истёк — откройте программу заново')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('Captured ceremony')).toBeNull()
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
  it('a previously acknowledged version shows its timestamp without a new checkbox', async () => {
    serve(() => ({ body: { ...program(), acknowledgedAt: '2026-09-30T08:00:00Z', requiresAcknowledgment: false }, etag: '"17"' }))
    viewReader(); await screen.findByRole('status')
    expect(screen.getByRole('status').textContent).toContain('2026-09-30T08:00:00Z')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('offline hides data; reconnect performs a fresh GET rather than replaying an old proof', async () => {
    const calls = serve(() => ({ body: program(), etag: '"17"' }))
    viewReader(); await screen.findByText('Captured ceremony')
    fireEvent(window, new Event('offline')); await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain('Captured')
    fireEvent(window, new Event('online')); await screen.findByText('Captured ceremony')
    expect(calls.filter(c => c.method === 'GET')).toHaveLength(2)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
  it('pending POST is single-flight even on a second click', async () => {
    let finish!: (r: Reply) => void
    const calls = serve(c => c.method === 'GET' ? { body: program(), etag: '"17"' } : new Promise(r => { finish = r }))
    viewReader(); await checkAndAck(); fireEvent.click(button('Секунду…'))
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1)
    finish({ body: { sourceVersion: '17', acknowledgedAt: 'receipt' } }); await screen.findByRole('status')
  })
  it('English covers reader and explicit confirmation', async () => {
    setI18nLang('en'); serve(() => ({ body: program(), etag: '"17"' })); viewReader(); await screen.findByText('Captured ceremony')
    expect(button('Acknowledge this version').disabled).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'I have reviewed this version of the schedule' })).toBeTruthy()
    expect(document.body.textContent).toContain('Schedule version:')
  })
  it('route change discards the previous request even if it completes late', async () => {
    let finish!: (r: Reply) => void
    serve(c => c.path === READ ? new Promise(r => { finish = r }) : { body: { ...program(), weddingId: 'w2', wedding: 'Other couple', blocks: [] }, etag: '"17"' })
    function Jump() { const nav = useNavigate(); return <><button onClick={() => nav('/vendor-app/programs/w2')}>Jump</button><VendorProgramReader /></> }
    render(<MemoryRouter initialEntries={['/vendor-app/programs/w1']}><Routes><Route path="/vendor-app/programs/:weddingId" element={<Jump />} /></Routes></MemoryRouter>)
    await waitFor(() => expect(finish).toBeTypeOf('function')); fireEvent.click(button('Jump')); await screen.findByText('Other couple')
    finish({ body: program(), etag: '"17"' }); await waitFor(() => expect(screen.queryByText('Captured couple')).toBeNull())
  })
})

describe('vendor program list', () => {
  it.each(['list', 'reader'])('%s GET403 displays the actual cause instead of a couple-only claim', async mode => {
    serve(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'Actual program refusal' } } }))
    if (mode === 'reader') viewReader()
    else render(<MemoryRouter><VendorPrograms /></MemoryRouter>)
    await screen.findByText('Actual program refusal')
    expect(document.body.textContent).not.toContain('Этот раздел ведёт пара')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('Программ пока нет')).toBeNull()
  })
  it('uses the actual next cursor, supports previous page and links to the captured wedding', async () => {
    const calls = serve(c => ({ body: { items: [{ weddingId: c.path.includes('?') ? 'w2' : 'w1', wedding: c.path.includes('?') ? 'Second couple' : 'First couple', sourceVersion: '17', updatedAt: null, blockCount: 1, requiresAcknowledgment: true, acknowledgedAt: null }], nextCursor: c.path.includes('?') ? null : 'a/b+cursor' } }))
    render(<MemoryRouter><VendorPrograms /></MemoryRouter>); await screen.findByText('First couple')
    expect(screen.getByRole('link', { name: /First couple/ }).getAttribute('href')).toBe('/vendor-app/programs/w1')
    fireEvent.click(button('Следующая страница')); await screen.findByText('Second couple')
    expect(calls[1]!.path).toBe('/vendor/programs?cursor=a%2Fb%2Bcursor')
    expect(button('Следующая страница').disabled).toBe(true)
    fireEvent.click(button('Предыдущая страница')); await screen.findByText('First couple')
  })
  it('a failed list request is not presented as an empty list', async () => {
    serve(() => ({ down: true })); render(<MemoryRouter><VendorPrograms /></MemoryRouter>); await screen.findByRole('alert')
    expect(screen.queryByText('Программ пока нет')).toBeNull()
  })
})
