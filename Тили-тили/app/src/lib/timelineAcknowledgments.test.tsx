// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { TimelineAcknowledgments } from '@/components/TimelineAcknowledgments'
import type { components } from './api/schema'
import { setI18nLang } from './i18n'

type Summary = components['schemas']['TimelineAcknowledgments']
type Reply = { body?: unknown; status?: number; etag?: string | null; down?: boolean }
const state = (): Summary => ({ sourceVersion: '17', updatedAt: '2026-09-30T08:00:00Z', items: [
  { id: 'v1', kind: 'registered', name: 'Captured vendor', blockCount: 2, status: 'pending', acknowledgedAt: null, acknowledgedBy: null, previousAcknowledgment: null },
] })
function serve(reply: (path: string) => Reply | Promise<Reply>) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, ''); calls.push(path)
    const r = await reply(path)
    if (r.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.etag ? { etag: r.etag } : {}) } })
  }))
  return calls
}
const props = { weddingId: 'w1', timelineVersion: '"17"', refreshTimeline: vi.fn() }
function view() { return render(<MemoryRouter><TimelineAcknowledgments {...props} /></MemoryRouter>) }
const refresh = () => screen.getByRole('button', { name: 'Обновить программу и сводку' })
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru'); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true); props.refreshTimeline.mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('team acknowledgment coherent with displayed timeline', () => {
  const external = (): Summary => ({ ...state(), items: [{ ...state().items[0]!, kind: 'external', id: 'd1', name: 'Actual external service' }] })
  it('external current pending explicitly belongs to most recently issued link, no receipt/actor invented', async () => {
    serve(() => ({ body: external(), etag: '"17"' })); view(); await screen.findByText('Actual external service')
    expect(screen.getByText('По последней выданной ссылке')).toBeTruthy()
    expect(screen.getByText('Ожидается подтверждение этой версии')).toBeTruthy()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    expect(document.body.textContent).not.toContain('Подтвердил:')
  })
  it('external actual receipt names its link source, not a verified person or the service name as author', async () => {
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15.123Z' }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Эта версия подтверждена')
    expect(screen.getByText('Подтверждено по ссылке исполнителя')).toBeTruthy()
    expect(screen.getByText('По последней выданной ссылке')).toBeTruthy()
    expect(screen.getByText('2026-09-30T08:14:15.123Z').getAttribute('datetime')).toBe('2026-09-30T08:14:15.123Z')
    expect(document.body.textContent).not.toContain('Подтвердил:')
    expect(document.body.textContent).not.toContain('Неизвестно')
  })
  it('external old-link receipt same version is separate history while new link pending', async () => {
    const data = external(); data.items[0]!.previousAcknowledgment = { sourceVersion: '17', acknowledgedAt: '2026-09-30T07:00:00Z', acknowledgedBy: null }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Actual external service')
    fireEvent.click(screen.getByText('Предыдущее подтверждение'))
    expect(screen.getByText('Подтверждено по ссылке исполнителя')).toBeTruthy()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    expect(screen.getByText('Ожидается подтверждение этой версии')).toBeTruthy()
    expect(screen.getByText('2026-09-30T07:00:00Z')).toBeTruthy()
  })
  it('external unavailable has no active-link claim, preserves actual previous link receipt only', async () => {
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'unavailable', previousAcknowledgment: { sourceVersion: '16', acknowledgedAt: '2026-09-30T07:00:00Z', acknowledgedBy: null } }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Нет действующей ссылки для программы')
    expect(screen.queryByText('По последней выданной ссылке')).toBeNull()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    expect(screen.queryByText('Ожидается подтверждение этой версии')).toBeNull()
    expect(screen.getByText('Предыдущее подтверждение')).toBeTruthy()
  })
  it.each(['current', 'previous'])('external fabricated named %s actor is incomplete, never a green receipt', async field => {
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15Z' }
    if (field === 'current') data.items[0]!.acknowledgedBy = 'Invented link person'
    else data.items[0]!.previousAcknowledgment = { sourceVersion: '16', acknowledgedAt: '2026-09-30T07:00:00Z', acknowledgedBy: 'Invented link person' }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Сводка ознакомления неполная')
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    expect(document.body.textContent).not.toContain('Invented link person')
  })
  it('external refresh discards old green while latest-link result is pending', async () => {
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15Z' }
    let finish!: (r: Reply) => void, reads = 0
    serve(() => ++reads === 1 ? { body: data, etag: '"17"' } : new Promise(r => { finish = r }))
    view(); await screen.findByText('Эта версия подтверждена'); fireEvent.click(refresh())
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    await act(async () => { finish({ body: external(), etag: '"17"' }) }); await screen.findByText('Ожидается подтверждение этой версии')
    expect(screen.queryByText('Подтверждено по ссылке исполнителя')).toBeNull()
  })
  it('external offline removes receipt/history/source; reconnect does not preserve old green', async () => {
    let reads = 0
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15Z' }
    serve(() => ({ body: reads++ === 0 ? data : external(), etag: '"17"' })); view(); await screen.findByText('Эта версия подтверждена')
    fireEvent(window, new Event('offline')); await screen.findByText('Нет связи с сервером')
    expect(screen.queryByText('Actual external service')).toBeNull()
    fireEvent(window, new Event('online')); await screen.findByText('Ожидается подтверждение этой версии')
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
  })
  it('English external source/current-link and unavailable labels are translated', async () => {
    setI18nLang('en')
    const data = external(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15Z' }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Acknowledged through the contractor link')
    expect(screen.getByText('For the most recently issued link')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Подтверждено')
  })
  it('shows actual pending/count/name, GET only, no invented current receipt', async () => {
    const calls = serve(() => ({ body: state(), etag: '"17"' })); view()
    await screen.findByText('Captured vendor')
    expect(screen.getByText('Ожидается подтверждение этой версии')).toBeTruthy()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    expect(document.body.textContent).toContain('Блоков: 2')
    expect(calls).toEqual(['/weddings/w1/timeline/acknowledgments'])
  })
  it('shows real matching receipt actor/time and no local success clock', async () => {
    const data = state(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15.123Z', acknowledgedBy: 'Actual actor' }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Эта версия подтверждена')
    expect(document.body.textContent).toContain('Actual actor')
    expect(screen.getByText('2026-09-30T08:14:15.123Z').getAttribute('datetime')).toBe('2026-09-30T08:14:15.123Z')
  })
  it('a different server version hides green rows; refresh explicitly refreshes parent too', async () => {
    const data = state(); data.sourceVersion = '18'; data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15.123Z' }
    serve(() => ({ body: data, etag: '"18"' })); view(); await screen.findByText('Версия сводки отличается от программы')
    expect(screen.queryByText('Captured vendor')).toBeNull()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    fireEvent.click(refresh()); expect(props.refreshTimeline).toHaveBeenCalledTimes(1)
  })
  it.each([null, '"18"'])('missing/mismatched ETag %s is not current acknowledgment', async etag => {
    serve(() => ({ body: state(), etag })); view(); await screen.findByText('Версия сводки отличается от программы')
    expect(screen.queryByText('Captured vendor')).toBeNull()
  })
  it('a body revision inconsistent with its own ETag is not shown', async () => {
    serve(() => ({ body: { ...state(), sourceVersion: '18' }, etag: '"17"' })); view()
    await screen.findByText('Версия сводки отличается от программы')
    expect(screen.queryByText('Captured vendor')).toBeNull()
  })
  it('malformed older summary does not fabricate an empty state or crash', async () => {
    serve(() => ({ body: [], etag: '"17"' })); view(); await screen.findByText('Сводка ознакомления неполная')
    expect(screen.queryByText('Действующих исполнителей нет')).toBeNull()
  })
  it('acknowledged without an actual timestamp is incomplete, not green', async () => {
    const data = state(); data.items[0]!.status = 'acknowledged'
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Сводка ознакомления неполная')
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
  })
  it('previous receipt of even the same version is separate from current pending', async () => {
    const data = state(); data.items[0]!.previousAcknowledgment = { sourceVersion: '17', acknowledgedAt: '2026-09-30T07:00:00Z', acknowledgedBy: 'Previous actor' }
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Captured vendor')
    fireEvent.click(screen.getByText('Предыдущее подтверждение'))
    expect(document.body.textContent).toContain('Previous actor')
    expect(screen.getByText('Ожидается подтверждение этой версии')).toBeTruthy()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
  })
  it('external unsupported/unavailable/unassigned are distinct, never green or pending', async () => {
    const data = state(); data.items = ['not_supported', 'unavailable', 'unassigned'].map((status, i) => ({ ...data.items[0]!, id: `v${i}`, kind: i === 0 ? 'external' : 'registered', status: status as Summary['items'][number]['status'] }))
    serve(() => ({ body: data, etag: '"17"' })); view(); await screen.findByText('Внешнее ознакомление недоступно')
    expect(screen.getByText('Подрядчик не может открыть программу')).toBeTruthy()
    expect(screen.getByText('Назначенных блоков нет')).toBeTruthy()
    expect(screen.queryByText('Ожидается подтверждение этой версии')).toBeNull()
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
  })
  it('real empty response is empty, failed response is not empty and can retry', async () => {
    let reads = 0
    serve(() => ++reads === 1 ? { down: true } : { body: { ...state(), items: [] }, etag: '"17"' })
    view(); await screen.findByRole('alert')
    expect(screen.queryByText('Действующих исполнителей нет')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' })); await screen.findByText('Действующих исполнителей нет')
  })
  it('403 names the actual refusal without retry or private rows', async () => {
    serve(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'Раздел закрыт для вашей роли' } } })); view(); await screen.findByText('Раздел закрыт для вашей роли')
    expect(screen.queryByText('Captured vendor')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('refreshing hides old accepted rows while the next response is pending', async () => {
    const data = state(); data.items[0] = { ...data.items[0]!, status: 'acknowledged', acknowledgedAt: '2026-09-30T08:14:15.123Z' }
    let finish!: (r: Reply) => void, reads = 0
    serve(() => ++reads === 1 ? { body: data, etag: '"17"' } : new Promise(r => { finish = r }))
    view(); await screen.findByText('Эта версия подтверждена'); fireEvent.click(refresh())
    expect(screen.queryByText('Эта версия подтверждена')).toBeNull()
    await act(async () => { finish({ body: state(), etag: '"17"' }) })
    await screen.findByText('Ожидается подтверждение этой версии')
  })
  it('route/version change discards a late previous summary', async () => {
    let finish!: (r: Reply) => void
    serve(path => path.includes('/w1/') ? new Promise(r => { finish = r }) : { body: { ...state(), sourceVersion: '18', items: [{ ...state().items[0]!, name: 'New wedding vendor' }] }, etag: '"18"' })
    const v = view(); await waitFor(() => expect(finish).toBeTypeOf('function'))
    v.rerender(<MemoryRouter><TimelineAcknowledgments {...props} weddingId="w2" timelineVersion={'"18"'} /></MemoryRouter>)
    await screen.findByText('New wedding vendor')
    await act(async () => { finish({ body: state(), etag: '"17"' }) })
    expect(screen.queryByText('Captured vendor')).toBeNull()
  })
  it('offline removes stored rows; reconnection freshly reads without old green', async () => {
    const calls = serve(() => ({ body: state(), etag: '"17"' })); view(); await screen.findByText('Captured vendor')
    fireEvent(window, new Event('offline')); await screen.findByText('Нет связи с сервером')
    expect(screen.queryByText('Captured vendor')).toBeNull()
    fireEvent(window, new Event('online')); await screen.findByText('Captured vendor')
    expect(calls).toHaveLength(2)
  })
  it('failed refresh token triggers session-expired cleanup rather than retaining private names', async () => {
    let reads = 0
    serve(path => path === '/auth/refresh' || ++reads > 1 ? { status: 401, body: { error: { code: 'unauthorized', message: 'Expired' } } } : { body: state(), etag: '"17"' })
    view(); await screen.findByText('Captured vendor'); fireEvent.click(refresh()); await screen.findByText('Сессия истекла — войдите снова')
    expect(screen.queryByText('Captured vendor')).toBeNull()
    expect(localStorage.getItem('tt_auth')).toBeNull()
  })
  it('English translates summary states and commands, not server actor names', async () => {
    setI18nLang('en'); serve(() => ({ body: state(), etag: '"17"' })); view(); await screen.findByText('Captured vendor')
    expect(screen.getByText('Awaiting acknowledgment of this version')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Refresh schedule and acknowledgments' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('Ожидается')
  })
})
