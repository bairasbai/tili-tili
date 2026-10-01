// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VendorProgramReader, VendorPrograms } from '@/pages/VendorPrograms'
import GuestVendor from '@/pages/GuestVendor'
import { saveTokens } from './api/client'
import type { VendorProgram } from './api/vendor'
import { forgetOfflinePrograms, offlineScope, registeredProgramNamespace } from './offlineAccess'

const KEY = 'tt_program_offline'
const authenticate = (sid = 's1') => saveTokens({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid }))}.test`, refreshToken: sid })
function program(): VendorProgram {
  return { weddingId: 'w1', wedding: 'Captured couple', sourceVersion: '7', updatedAt: '2026-09-30T08:00:00Z', acknowledgedAt: null, requiresAcknowledgment: true, readToken: 'PRIVATE READ PROOF', expiresAt: new Date(Date.now() + 600000).toISOString(),
    blocks: [{ id: 'b1', name: 'Permitted saved ceremony', location: 'Own hall', startsAt: '2027-06-14T11:00:00Z', endsAt: '2027-06-14T11:30:00Z', durationMinutes: 30, fixed: true, travelMinutes: 10.5, bufferMinutes: 5.25, outdoor: true, roles: ['responsible'], dependsOn: [], event: { id: 'e1', name: 'Captured event', date: '2027-06-14', timeZone: 'Asia/Yekaterinburg', location: null } }] }
}
function serve() {
  let down = false
  let status = 200, ackStatus = 200
  let current = program()
  const calls: string[] = []
  const methods: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    calls.push(path)
    methods.push(init?.method ?? 'GET')
    if (down) throw new TypeError('Failed to fetch')
    const code = path.endsWith('/ack') ? ackStatus : path.endsWith('/timeline') || path === '/auth/refresh' ? status : 200
    if (code !== 200) return new Response(JSON.stringify({ error: { code: 'denied', message: 'Access removed' } }), { status: code, headers: { 'content-type': 'application/json' } })
    const body = path.endsWith('/timeline') ? current : path.endsWith('/ack') ? { sourceVersion: current.sourceVersion, acknowledgedAt: '2026-09-30T09:00:00Z' }
      : path.endsWith('/messages') ? { items: [], nextCursor: null }
      : { weddingDate: '2027-06-14', slot: { label: 'Own photo' }, timeline: [] }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', etag: `"${current.sourceVersion}"` } })
  }))
  return { calls, methods, status: (value: number) => { status = value }, ackStatus: (value: number) => { ackStatus = value }, replace: (p: VendorProgram) => { current = p },
    offline: () => { down = true; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false); fireEvent(window, new Event('offline')) },
    online: () => { down = false; vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); fireEvent(window, new Event('online')) } }
}
function OtherLink() { const nav = useNavigate(); return <button onClick={() => nav('/guest-vendor/OTHER-LINK')}>Other link</button> }
function open(kind: 'registered' | 'external' = 'registered') {
  return render(<MemoryRouter initialEntries={[kind === 'registered' ? '/vendor-app/programs/w1' : '/guest-vendor/PRIVATE-LINK-TOKEN']}><OtherLink /><Routes>
    <Route path="/vendor-app/programs/:weddingId" element={<VendorProgramReader />} />
    <Route path="/guest-vendor/:token" element={<GuestVendor />} />
  </Routes></MemoryRouter>)
}
beforeEach(() => { localStorage.clear(); authenticate(); vi.stubGlobal('crypto', webcrypto); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('contractor offline program lifecycle', () => {
  it('registered reader opts into a complete wrapped heading instead of ellipsis', async () => {
    serve(); open(); const heading = await screen.findByRole('heading', { name: 'Программа свадьбы' })
    expect(heading.className).toContain('break-words')
    expect(heading.className).not.toContain('truncate')
  })
  it.each(['registered', 'external'] as const)('%s keeps its permitted version read-only after actual offline event', async kind => {
    const control = serve(); open(kind)
    await screen.findByText('Permitted saved ceremony')
    control.offline()
    expect(screen.queryByText('Permitted saved ceremony')).not.toBeNull()
    await screen.findByText(/Актуальность и доступ не проверены/)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Подтвердить ознакомление' })).toBeNull()
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull())
    const raw = localStorage.getItem(KEY)!
    expect(raw).not.toContain('PRIVATE READ PROOF')
    expect(raw).not.toContain('PRIVATE-LINK-TOKEN')
    expect(raw).toContain('Asia/Yekaterinburg')
    expect(control.calls.some(path => path.endsWith('/ack'))).toBe(false)
  })
  it.each(['registered', 'external'] as const)('%s reopens its warm permitted copy without making an offline HTTP request', async kind => {
    const control = serve(); open(kind); await screen.findByText('Permitted saved ceremony')
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull())
    control.offline(); cleanup(); const calls = control.calls.length; open(kind)
    await screen.findByText('Permitted saved ceremony')
    expect(control.calls).toHaveLength(calls)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(document.body.textContent).toContain('16:00:00')
  })
  it.each(['registered', 'external'] as const)('%s reconnect reads a new version and resets the old checkbox without replay', async kind => {
    const control = serve(); open(kind); await screen.findByText('Permitted saved ceremony')
    fireEvent.click(screen.getByRole('checkbox')); control.offline()
    const next = program(); next.sourceVersion = '8'; next.readToken = 'NEW PRIVATE PROOF'; next.blocks[0]!.name = 'New actual version'
    control.replace(next); control.online()
    await screen.findByText('New actual version')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(screen.queryByText(/Актуальность и доступ не проверены/)).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(control.methods.filter(m => m === 'POST')).toHaveLength(0)
    await waitFor(() => expect(localStorage.getItem(KEY)).toContain('New actual version'))
    expect(localStorage.getItem(KEY)).not.toContain('NEW PRIVATE PROOF')
  })
  it.each(['registered', 'external'] as const)('%s proof expiry is not an invented offline access lease', async kind => {
    const control = serve(), expired = program(); expired.expiresAt = new Date(Date.now() - 1000).toISOString(); control.replace(expired)
    open(kind); await screen.findByText('Срок просмотра истёк — откройте программу заново')
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull())
    control.offline(); await screen.findByText('Permitted saved ceremony')
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText('Версия подтверждена')).toBeNull()
  })
  it.each(['registered', 'external'] as const)('%s stays read-only until the reconnect GET actually finishes', async kind => {
    const control = serve(); open(kind); await screen.findByText('Permitted saved ceremony')
    await waitFor(() => expect(localStorage.getItem(KEY)).not.toBeNull())
    control.offline()
    const original = vi.mocked(fetch).getMockImplementation()!
    let finish!: (response: Response) => void
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith('/timeline')
      ? new Promise<Response>(resolve => { finish = resolve }) : original(input, init)))
    control.online()
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(screen.getByText('Permitted saved ceremony')).toBeTruthy()
    expect(screen.getByText(/Актуальность и доступ не проверены/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    const next = program(); next.sourceVersion = '8'; next.readToken = 'NEW PENDING PROOF'; next.blocks[0]!.name = 'Finished fresh read'
    finish(new Response(JSON.stringify(next), { headers: { 'content-type': 'application/json', etag: '"8"' } }))
    await screen.findByText('Finished fresh read')
    expect(screen.queryByText(/Актуальность и доступ не проверены/)).toBeNull()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(control.methods.filter(m => m === 'POST')).toHaveLength(0)
  })
  it('a saved actual receipt is labelled as observed, not current server verification', async () => {
    const control = serve(), acknowledged = program(); acknowledged.acknowledgedAt = '2026-09-30T09:00:00Z'; acknowledged.requiresAcknowledgment = false; control.replace(acknowledged)
    open(); await screen.findByText('Permitted saved ceremony'); control.offline()
    await screen.findByText(/Подтверждено в сохранённом снимке/)
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByText(/^Версия подтверждена/)).toBeNull()
    expect(control.methods.filter(m => m === 'POST')).toHaveLength(0)
  })
  it('the offline registered list navigates only to previously read programs, not an empty server list', async () => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline(); cleanup()
    render(<MemoryRouter initialEntries={['/vendor-app/programs']}><Routes><Route path="/vendor-app/programs" element={<VendorPrograms />} /><Route path="/vendor-app/programs/:weddingId" element={<VendorProgramReader />} /></Routes></MemoryRouter>)
    await screen.findByRole('link', { name: /Captured couple/ })
    expect(screen.queryByText('Программ пока нет')).toBeNull()
    const calls = control.calls.length
    fireEvent.click(screen.getByRole('link', { name: /Captured couple/ })); await screen.findByText('Permitted saved ceremony')
    expect(control.calls).toHaveLength(calls)
  })
  it('a mounted registered session replacement hides and removes the old copy', async () => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline()
    authenticate('s2')
    await waitFor(() => expect(screen.queryByText('Permitted saved ceremony')).toBeNull())
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('another-tab auth replacement removes registered copies even before a fresh read', async () => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline()
    const oldValue = localStorage.getItem('tt_auth')!
    const nextValue = JSON.stringify({ accessToken: `e30.${btoa(JSON.stringify({ sub: 'u1', sid: 's2' }))}.test`, refreshToken: 's2' })
    localStorage.setItem('tt_auth', nextValue)
    fireEvent(window, new StorageEvent('storage', { key: 'tt_auth', oldValue, newValue: nextValue }))
    await waitFor(() => expect(screen.queryByText('Permitted saved ceremony')).toBeNull())
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it('another-tab refresh of the same session retains the snapshot', async () => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline()
    const oldValue = localStorage.getItem('tt_auth')!, nextValue = JSON.stringify({ ...JSON.parse(oldValue), refreshToken: 'rotated' })
    localStorage.setItem('tt_auth', nextValue)
    fireEvent(window, new StorageEvent('storage', { key: 'tt_auth', oldValue, newValue: nextValue }))
    expect(screen.getByText('Permitted saved ceremony')).toBeTruthy()
    expect(localStorage.getItem(KEY)).not.toBeNull()
  })
  it('an offline external route change cannot reuse another link snapshot', async () => {
    const control = serve(); open('external'); await screen.findByText('Permitted saved ceremony'); control.offline()
    fireEvent.click(screen.getByRole('button', { name: 'Other link' }))
    await screen.findByText('Сохранённой программы нет')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(localStorage.getItem(KEY)).not.toContain('PRIVATE-LINK-TOKEN')
  })
  it.each([403, 404, 410])('reconnect registered HTTP%s clears the old copy without pretending the server is unreachable', async status => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline(); control.status(status); control.online()
    await screen.findByText('Access removed')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(screen.queryByText(/Нет связи с сервером/)).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
  })
  it.each([409, 422, 429, 501])('reconnect HTTP%s is not an offline success or a proven revocation', async status => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); control.offline(); control.status(status); control.online()
    await screen.findByText('Access removed')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(screen.queryByText(/Актуальность и доступ не проверены/)).toBeNull()
    expect(localStorage.getItem(KEY)).not.toBeNull()
  })
  it('HTTP503 uses the saved read-only copy without preserving a review checkbox', async () => {
    const control = serve(); open(); await screen.findByText('Permitted saved ceremony'); fireEvent.click(screen.getByRole('checkbox'))
    control.offline(); control.status(503); control.online()
    await screen.findByText(/Актуальность и доступ не проверены/)
    expect(screen.getByText('Permitted saved ceremony')).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(control.methods.filter(m => m === 'POST')).toHaveLength(0)
  })
  it.each([403, 404, 410])('actual valid-session ACK HTTP%s closes the reader and removes the copy, with no silent GET', async status => {
    const control = serve(); control.ackStatus(status); open(); await screen.findByText('Permitted saved ceremony')
    fireEvent.click(screen.getByRole('checkbox')); fireEvent.click(screen.getByRole('button', { name: 'Подтвердить ознакомление' }))
    await screen.findByText('Access removed')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(control.calls.filter(p => p.endsWith('/timeline'))).toHaveLength(1)
  })
  it('cleanup while a GET is pending prevents its late response restoring cache or private display', async () => {
    serve(); let finish!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    vi.stubGlobal('fetch', fetcher); open()
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    const tokens = JSON.parse(localStorage.getItem('tt_auth')!)
    forgetOfflinePrograms({ namespace: registeredProgramNamespace(offlineScope(tokens.accessToken))! })
    finish(new Response(JSON.stringify(program()), { headers: { 'content-type': 'application/json', etag: '"7"' } }))
    await screen.findByText('Доступ и данные требуют нового чтения')
    expect(screen.queryByText('Permitted saved ceremony')).toBeNull()
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
