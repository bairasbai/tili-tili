// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GuestVendor from '@/pages/GuestVendor'
import { setI18nLang } from './i18n'
import type { VendorProgram } from './api/vendor'
import { CONSENT_OUTDATED_KEY, onSessionExpired } from './api/client'

type Call = { path: string; method: string; body: unknown; headers: Headers }
type Reply = { body?: unknown; status?: number; etag?: string | null; down?: boolean }
const LINK = '/guest-vendor/link1', READ = `${LINK}/timeline`, ACK = `${READ}/ack`, CHAT = `${LINK}/messages`
function program(): VendorProgram {
  return { weddingId: 'w1', wedding: 'Permitted couple', sourceVersion: '17', updatedAt: '2026-09-30T07:00:00Z', acknowledgedAt: null, requiresAcknowledgment: true, readToken: 'external-proof', expiresAt: new Date(Date.now() + 600_000).toISOString(),
    blocks: [{ id: 'b1', name: 'Permitted ceremony', location: null, startsAt: '2027-06-14T11:00:00.123Z', endsAt: '2027-06-14T11:30:00.123Z', durationMinutes: 30, fixed: true, travelMinutes: 10.5, bufferMinutes: 5.25, outdoor: true, roles: ['responsible'], dependsOn: [], event: { id: 'e1', name: 'Actual event', date: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Hall' } }] }
}
const cabinet = { weddingDate: '2027-06-14', slot: { id: 's1', label: 'Photographer' }, holdHours: 72,
  timeline: [{ id: 'legacy', name: 'Legacy clock must not be rendered', startsAt: '2027-06-14T11:00:00Z' }] }
const receipt = { sourceVersion: '17', acknowledgedAt: '2026-09-30T08:00:00Z' }
function serve(reply: (call: Call) => Reply | Promise<Reply> = () => ({ body: program(), etag: '"17"' })) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call)
    const r = call.path === LINK ? { body: cabinet } : call.path === CHAT && call.method === 'GET' ? { body: { items: [], nextCursor: null } } : await reply(call)
    if (r.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.etag ? { etag: r.etag } : {}) } })
  }))
  return calls
}
function view() { return render(<MemoryRouter initialEntries={[LINK]}><Routes><Route path="/guest-vendor/:token" element={<GuestVendor />} /></Routes></MemoryRouter>) }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
async function ack() { await screen.findByText('Permitted ceremony'); fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(button('Подтвердить ознакомление')) }
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'unrelated-account', refreshToken: 'unrelated-refresh' })); setI18nLang('ru'); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('external link actual API client and program UI', () => {
  it('GET never acknowledges; account bearer is not sent; exact event interval replaces legacy browser clock', async () => {
    const calls = serve(); view(); await screen.findByText('Permitted ceremony')
    expect(document.body.textContent).toContain('14:00:00,123')
    expect(document.body.textContent).toContain('14:30:00,123')
    expect(document.body.textContent).toContain('Europe/Moscow')
    expect(document.body.textContent).toContain('10.5')
    expect(document.body.textContent).not.toContain('Legacy clock')
    expect(calls.map(c => c.method)).toEqual(['GET', 'GET', 'GET'])
    expect(calls.every(c => !c.headers.has('authorization'))).toBe(true)
    expect(button('Подтвердить ознакомление').disabled).toBe(true)
    expect(JSON.stringify(localStorage)).not.toContain('external-proof')
    expect(JSON.stringify(sessionStorage)).not.toContain('external-proof')
  })
  it('explicit checkbox posts displayed proof/If-Match through the link route, then actual receipt', async () => {
    const calls = serve(c => c.path === ACK ? { body: receipt } : { body: program(), etag: '"17"' })
    view(); await ack(); await screen.findByRole('status')
    const write = calls.find(c => c.method === 'POST')!
    expect(write.path).toBe(ACK); expect(write.body).toEqual({ readToken: 'external-proof' })
    expect(write.headers.get('If-Match')).toBe('"17"'); expect(write.headers.has('authorization')).toBe(false)
    expect(screen.getByRole('status').textContent).toContain(receipt.acknowledgedAt)
    expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it.each(['network', '503'])('%s retry sends the identical captured proof without a new GET or fake receipt', async failure => {
    let writes = 0
    const calls = serve(c => c.path === ACK ? ++writes === 1 ? failure === 'network' ? { down: true } : { status: 503 } : { body: receipt } : { body: program(), etag: '"17"' })
    view(); await ack(); await screen.findByRole('alert'); expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(button('Повторить подтверждение')); await screen.findByRole('status')
    const posted = calls.filter(c => c.path === ACK)
    expect(posted).toHaveLength(2); expect(posted.map(c => c.body)).toEqual([{ readToken: 'external-proof' }, { readToken: 'external-proof' }])
    expect(posted.map(c => c.headers.get('If-Match'))).toEqual(['"17"', '"17"'])
    expect(calls.filter(c => c.path === READ)).toHaveLength(1)
  })
  it('stale POST hides old version; reopen reads the new version and resets checkbox', async () => {
    let reads = 0
    serve(c => c.path === ACK ? { status: 409, body: { error: { code: 'timeline_version_conflict', message: 'stale' } } } : { body: reads++ === 0 ? program() : { ...program(), sourceVersion: '18', readToken: 'new-proof' }, etag: reads === 1 ? '"17"' : '"18"' })
    view(); await ack(); await screen.findByRole('alert')
    expect(screen.queryByText('Permitted ceremony')).toBeNull(); expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(button('Открыть заново')); await screen.findByText('Permitted ceremony')
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(document.body.textContent).toContain('Версия программы: 18')
  })
  it.each([401, 403, 404, 410])('POST %s removes the whole cabinet, including chat and slot', async status => {
    serve(c => c.path === ACK ? { status, body: { error: { code: 'gone', message: 'Actual link refusal' } } } : { body: program(), etag: '"17"' })
    view(); await ack(); await screen.findByRole('alert')
    expect(screen.queryByText('Photographer')).toBeNull(); expect(screen.queryByText('Permitted ceremony')).toBeNull()
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('anonymous 401 does not refresh or erase the unrelated account', async () => {
    const expired = vi.fn(), unsubscribe = onSessionExpired(expired)
    try {
      const calls = serve(() => ({ status: 401, body: { error: { code: 'link_refused', message: 'Actual link refusal' } } }))
      view(); await screen.findByText('Actual link refusal')
      expect(calls.some(c => c.path === '/auth/refresh')).toBe(false)
      expect(localStorage.getItem('tt_auth')).toContain('unrelated-account'); expect(expired).not.toHaveBeenCalled()
    } finally { unsubscribe() }
  })
  it('anonymous consent-like refusal does not mutate account consent gate', async () => {
    serve(() => ({ status: 403, body: { error: { code: 'consent_outdated', message: 'Actual link refusal' } } }))
    view(); await screen.findByText('Actual link refusal'); expect(localStorage.getItem(CONSENT_OUTDATED_KEY)).toBeNull()
  })
  it('historical unbound link reports the actual need for a new link, not pending or empty', async () => {
    serve(() => ({ status: 409, body: { error: { code: 'program_link_unbound', message: 'Request a new program link' } } }))
    view(); await screen.findByText('Request a new program link')
    expect(screen.queryByRole('checkbox')).toBeNull(); expect(screen.queryByText('Назначенных блоков нет')).toBeNull()
    expect(screen.queryByText('Legacy clock must not be rendered')).toBeNull()
  })
  it.each([null, '"18"'])('missing/mismatched ETag %s disables confirmation', async etag => {
    const calls = serve(() => ({ body: program(), etag })); view(); await screen.findByText('Permitted ceremony')
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(button('Подтвердить ознакомление')); expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })
  it('expired proof hides the program, not a false receipt', async () => {
    serve(() => ({ body: { ...program(), expiresAt: new Date(Date.now() - 1000).toISOString() }, etag: '"17"' }))
    view(); await screen.findByText('Срок просмотра истёк — откройте программу заново')
    expect(screen.queryByText('Permitted ceremony')).toBeNull(); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('offline retains only the read-only permitted snapshot, removes chat/draft; reconnect performs new reads without replay', async () => {
    const calls = serve(); view(); await screen.findByText('Permitted ceremony')
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.change(screen.getByPlaceholderText('Сообщение…'), { target: { value: 'private draft' } })
    fireEvent(window, new Event('offline')); await screen.findByText('Нет связи с сервером')
    expect(screen.getByText('Permitted ceremony')).toBeTruthy()
    expect(screen.getByText(/Актуальность и доступ не проверены/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подтвердить ознакомление' })).toBeNull()
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull()
    fireEvent(window, new Event('online')); await screen.findByText('Permitted ceremony')
    await screen.findByRole('checkbox')
    expect(calls.filter(c => c.path === READ)).toHaveLength(2); expect(calls.filter(c => c.method === 'POST')).toHaveLength(0)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect((await screen.findByPlaceholderText('Сообщение…') as HTMLInputElement).value).toBe('')
  })
  it('late acknowledgment after offline cannot restore old receipt on reconnect', async () => {
    let finish!: (r: Reply) => void
    serve(c => c.path === ACK ? new Promise(r => { finish = r }) : { body: program(), etag: '"17"' })
    view(); await ack(); await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent(window, new Event('offline')); fireEvent(window, new Event('online')); await screen.findByText('Permitted ceremony')
    await screen.findByRole('checkbox')
    finish({ body: receipt }); await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
  it('pending confirmation stays single-flight', async () => {
    let finish!: (r: Reply) => void
    const calls = serve(c => c.path === ACK ? new Promise(r => { finish = r }) : { body: program(), etag: '"17"' })
    view(); await ack(); fireEvent.click(button('Секунду…')); expect(calls.filter(c => c.path === ACK)).toHaveLength(1)
    finish({ body: receipt }); await screen.findByRole('status')
  })
  it('already acknowledged and empty programs have no confirmation action', async () => {
    serve(() => ({ body: { ...program(), blocks: [], requiresAcknowledgment: false, readToken: null, expiresAt: null }, etag: '"17"' }))
    view(); await screen.findByText('Назначенных блоков нет'); expect(screen.queryByRole('checkbox')).toBeNull()
  })
  it('wrong response version is never shown as acknowledged', async () => {
    serve(c => c.path === ACK ? { body: { ...receipt, sourceVersion: '18' } } : { body: program(), etag: '"17"' })
    view(); await ack(); await screen.findByRole('alert'); expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText('Permitted ceremony')).toBeNull()
  })
  it('chat POST revocation removes program and composer too', async () => {
    serve(c => c.path === CHAT ? { status: 410, body: { error: { code: 'gone', message: 'gone' } } } : { body: program(), etag: '"17"' })
    view(); await screen.findByText('Permitted ceremony')
    fireEvent.change(screen.getByPlaceholderText('Сообщение…'), { target: { value: 'hello' } }); fireEvent.click(button('Отправить'))
    await screen.findByText('Ссылка истекла или отозвана'); expect(screen.queryByText('Permitted ceremony')).toBeNull()
    expect(screen.queryByPlaceholderText('Сообщение…')).toBeNull()
  })
  it('English explicit review uses translated controls', async () => {
    setI18nLang('en'); serve(); view(); await screen.findByText('Permitted ceremony')
    expect(button('Acknowledge this version').disabled).toBe(true)
    expect(screen.getByRole('checkbox', { name: 'I have reviewed this version of the schedule' })).toBeTruthy()
  })
  it('route replacement cannot show a late program from the previous link', async () => {
    let finish!: (r: Reply) => void
    serve(c => c.path === READ ? new Promise(r => { finish = r }) : c.path === '/guest-vendor/link2' ? { body: cabinet } : c.path.endsWith('/messages') ? { body: { items: [], nextCursor: null } } : { body: { ...program(), wedding: 'Other couple', blocks: [], requiresAcknowledgment: false }, etag: '"17"' })
    function Jump() { const nav = useNavigate(); return <><button onClick={() => nav('/guest-vendor/link2')}>Jump</button><GuestVendor /></> }
    render(<MemoryRouter initialEntries={[LINK]}><Routes><Route path="/guest-vendor/:token" element={<Jump />} /></Routes></MemoryRouter>)
    await waitFor(() => expect(finish).toBeTypeOf('function')); fireEvent.click(button('Jump')); await screen.findByText('Other couple')
    finish({ body: program(), etag: '"17"' }); await waitFor(() => expect(screen.queryByText('Permitted ceremony')).toBeNull())
  })
})
