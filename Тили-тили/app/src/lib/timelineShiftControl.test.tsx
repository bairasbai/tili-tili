// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineShiftControl } from '@/components/TimelineShift'
import { shiftPreviewFixture } from '@/test/timelineShiftFixture'
import type { TimelineShiftPreview } from '@/lib/api/weddingWrite'
import { setI18nLang } from './i18n'

type Call = { path: string; method: string; body: unknown; headers: Headers }
type ResponseSpec = { status?: number; body?: unknown; etag?: string | null; down?: boolean }
const PREVIEW = '/weddings/w1/timeline/shift/preview'
const CONFIRM = '/weddings/w1/timeline/shift'
function serve(reply: (call: Call) => ResponseSpec | Promise<ResponseSpec>, eventsResponse?: ResponseSpec) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call)
    const spec = call.path.endsWith('/events') ? eventsResponse ?? { body: [{ id: 'event2', name: 'Второй день', date: '2027-06-15', timeZone: 'Europe/Moscow' }] } : await reply(call)
    if (spec.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(spec.body ?? {}), { status: spec.status ?? 200,
      headers: { 'content-type': 'application/json', ...(spec.etag ? { etag: spec.etag } : {}) } })
  }))
  return calls
}
const props = { weddingId: 'w1', date: '2027-06-14', timeZone: 'Asia/Yekaterinburg',
  blocks: [{ id: 'e1', name: 'Церемония' }, { id: 'e2', name: 'Фиксированный блок' }], disabled: false, onAccepted: vi.fn() }
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement
async function openPreview() {
  fireEvent.click(button('Сдвиг тайминга'))
  fireEvent.click(button('Предпросмотр сдвига'))
  await screen.findByText(/Версия программы: 1/)
}
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru'); props.onAccepted.mockClear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })

describe('scoped timeline shift control', () => {
  it('shows the actual known ends on both sides, not only the starts', async () => {
    serve(() => ({ body: shiftPreviewFixture(), etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(screen.getByRole('dialog').textContent).toContain('16:30:00')
    expect(screen.getByRole('dialog').textContent).toContain('16:45:00')
  })
  const captured = (): TimelineShiftPreview => ({ ...shiftPreviewFixture({ guestsAffected: 1, affectedGuestIds: ['g1'] }),
    blockDetails: [{ id: 'e1', name: 'Captured ceremony', eventId: 'event2', eventName: 'Captured event', eventDate: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Hall', startsAt: '2027-06-14T11:00:00Z', endsAt: '2027-06-14T11:30:00Z' }],
    referenceDetails: [{ kind: 'member', id: 'm1', name: 'Captured helper', assignments: [{ blockId: 'e1', role: 'responsible' }] }],
    affectedGuests: [{ id: 'g1', name: 'Captured guest' }],
    affectedReferences: [{ kind: 'member', id: 'm1' }],
    movements: [{ blockId: 'e1', location: 'Hall', travelMinutes: 10, bufferMinutes: 5, beforeArrival: '2027-06-14T11:00:00Z', afterArrival: '2027-06-14T11:15:00Z' }],
  })
  it('displays captured full intervals in the actual block-event zone, not the scope zone', async () => {
    serve(() => ({ body: captured(), etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    const change = screen.getByRole('dialog')
    expect(change.textContent).toContain('Captured ceremony')
    expect(change.textContent).toContain('Captured event')
    expect(change.textContent).toContain('14.06.2027')
    expect(change.textContent).toContain('14:00:00')
    expect(change.textContent).toContain('14:30:00')
    expect(change.textContent).toContain('14:15:00')
    expect(change.textContent).toContain('14:45:00')
    expect(change.textContent).toContain('Europe/Moscow')
    expect(change.textContent).not.toContain('16:00:00')
  })
  it('keeps captured block and person labels when the parent refreshes', async () => {
    serve(() => ({ body: captured(), etag: '"1"' }))
    const view = render(<TimelineShiftControl {...props} />)
    await openPreview()
    view.rerender(<TimelineShiftControl {...props} blocks={[{ id: 'e1', name: 'New parent label' }]} timeZone="UTC" />)
    expect(within(screen.getByRole('dialog')).getAllByText('Captured ceremony').length).toBeGreaterThan(0)
    expect(screen.queryByText('New parent label')).toBeNull()
    expect(screen.getByText(/Captured helper/)).toBeTruthy()
    expect(screen.getByText(/Ответственный/)).toBeTruthy()
    expect(screen.getByText(/Captured guest/)).toBeTruthy()
    expect(screen.queryByText(/member · m1/)).toBeNull()
  })
  it('shows both manual planning block times alongside recorded travel and buffer counts', async () => {
    serve(() => ({ body: captured(), etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    const movement = screen.getByRole('dialog')
    expect(movement.textContent).toContain('14:00:00')
    expect(movement.textContent).toContain('14:15:00')
    expect(movement.textContent).toContain('Плановое начало до сдвига')
    expect(movement.textContent).not.toContain('Прибытие')
    expect(movement.textContent).toContain('Hall')
    expect(movement.textContent).toContain('10')
    expect(movement.textContent).toContain('5')
  })
  it('marks unknown end and event zone without a guessed duration or scope fallback', async () => {
    const data = captured()
    data.blockDetails[0]!.timeZone = null
    data.blocks[0]!.before.endsAt = null
    data.blocks[0]!.after.endsAt = null
    serve(() => ({ body: data, etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(screen.getByRole('dialog').textContent).toContain('Часовой пояс неизвестен')
    expect(screen.getByRole('dialog').textContent).toContain('Окончание неизвестно')
    expect(screen.getByRole('dialog').textContent).not.toContain('16:00:00')
  })
  it('refuses confirmation if an older API omits captured context rather than using parent names', async () => {
    const old: Partial<TimelineShiftPreview> = captured()
    delete old.blockDetails
    delete old.referenceDetails
    delete old.affectedGuests
    const calls = serve(() => ({ body: old, etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(screen.getByText('Контекст предпросмотра недоступен — повторите просмотр')).toBeTruthy()
    expect(button('Подтвердить сдвиг').disabled).toBe(true)
    fireEvent.click(button('Подтвердить сдвиг'))
    expect(calls.filter(c => c.path === CONFIRM)).toHaveLength(0)
    expect(screen.queryByText('Церемония', { exact: true })).toBeNull()
  })
  it('shows the unchanged conflict interval from the captured graph, not the parent list', async () => {
    const data = { ...captured(), canConfirm: false, previewToken: null,
      conflicts: [{ kind: 'participant_overlap', blockIds: ['e1', 'e2'] }],
      excluded: [{ id: 'e2', reason: 'fixed' }],
      blockDetails: [...captured().blockDetails, { id: 'e2', name: 'Captured fixed', eventId: 'event2', eventName: 'Captured event',
        eventDate: '2027-06-14', timeZone: 'Europe/Moscow', location: 'Hall', startsAt: '2027-06-14T11:20:00Z', endsAt: '2027-06-14T11:50:00Z' }],
    }
    serve(() => ({ body: data, etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    const conflict = screen.getAllByRole('alert').find(node => node.textContent?.includes('Участник занят одновременно'))!
    expect(conflict.textContent).toContain('14:20:00')
    expect(conflict.textContent).toContain('14:50:00')
    expect(conflict.textContent).toContain('14:15:00')
    expect(conflict.textContent).toContain('14:45:00')
    expect(conflict.textContent).toContain('Без сдвига')
    expect(conflict.textContent).toContain('Captured fixed')
    expect(button('Подтвердить сдвиг').disabled).toBe(true)
  })
  it('keeps unknown names unknown and renders hostile labels as text', async () => {
    const data = captured()
    data.referenceDetails[0]!.name = null
    data.affectedGuests[0]!.name = '<img src=x onerror=alert(1)>'
    serve(() => ({ body: data, etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(screen.getByText(/Имя не задано · m1/)).toBeTruthy()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull()
  })
  it('preserves calendar rollover and known milliseconds in English intervals', async () => {
    setI18nLang('en')
    const data = captured()
    data.scope = { kind: 'day', date: '2027-06-15', timeZone: 'Asia/Yekaterinburg' }
    data.blocks[0]!.before = { startsAt: '2027-06-14T20:45:12.125Z', endsAt: '2027-06-14T21:15:12.125Z' }
    data.blocks[0]!.after = { startsAt: '2027-06-14T21:00:12.125Z', endsAt: '2027-06-14T21:30:12.125Z' }
    serve(() => ({ body: data, etag: '"1"' }))
    render(<TimelineShiftControl {...props} date="2027-06-15" />)
    fireEvent.click(button('Timeline shift'))
    fireEvent.click(button('Preview shift'))
    await screen.findByText(/Schedule version: 1/)
    const change = screen.getByTestId('shift-block-e1')
    expect(change.textContent).toContain('14/06/2027 · 23:45:12.125')
    expect(change.textContent).toContain('15/06/2027 · 00:15:12.125')
    expect(change.textContent).toContain('15/06/2027 · 00:00:12.125')
    expect(change.textContent).toContain('15/06/2027 · 00:30:12.125')
    expect(change.textContent).toContain('Before shift')
    expect(change.textContent).toContain('After shift')
  })
  it('shows before/after, excluded blocks and consequences, and only posts confirmation on explicit consent', async () => {
    const calls = serve(c => c.path === PREVIEW ? { body: shiftPreviewFixture({ excluded: [{ id: 'e2', reason: 'fixed' }] }), etag: '"1"' }
      : { body: { minutes: 15, shiftedBlocks: 1, guestsAffected: 3 }, etag: '"2"' })
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(calls.find(c => c.path === PREVIEW)?.body).toEqual({ scope: { kind: 'day', date: '2027-06-14' }, minutes: 15 })
    expect(calls.filter(c => c.path === CONFIRM)).toHaveLength(0)
    expect(screen.getByText(/16:00:00/)).toBeTruthy()
    expect(screen.getByText(/16:15:00/)).toBeTruthy()
    expect(screen.getByText(/Фиксированный блок · Фиксированное начало/)).toBeTruthy()
    fireEvent.click(button('Подтвердить сдвиг'))
    await waitFor(() => expect(props.onAccepted).toHaveBeenCalledOnce())
    expect(calls.find(c => c.path === CONFIRM)?.headers.get('if-match')).toBe('"1"')
    expect(calls.find(c => c.path === CONFIRM)?.body).toEqual({ previewToken: 'signed-preview-fixture' })
    expect(screen.getByRole('status').textContent).toContain('касается гостей: 3')
    expect(button('Подтвердить сдвиг').disabled).toBe(true)
  })
  it('retries a transport failure with exactly the same confirmation token, version and idempotency key', async () => {
    let attempts = 0
    const calls = serve(c => c.path === PREVIEW ? { body: shiftPreviewFixture(), etag: '"1"' }
      : ++attempts === 1 ? { down: true } : { body: { shiftedBlocks: 1, guestsAffected: 15 }, etag: '"2"' })
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    fireEvent.click(button('Подтвердить сдвиг'))
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    expect(props.onAccepted).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
    expect(button('Подтвердить сдвиг').disabled).toBe(false)
    fireEvent.click(button('Подтвердить сдвиг'))
    await waitFor(() => expect(props.onAccepted).toHaveBeenCalledOnce())
    const posted = calls.filter(c => c.path === CONFIRM)
    expect(posted).toHaveLength(2)
    expect(posted[0]!.headers.get('idempotency-key')).toBeTruthy()
    expect(posted[1]!.headers.get('idempotency-key')).toBe(posted[0]!.headers.get('idempotency-key'))
    expect(posted[1]!.headers.get('if-match')).toBe(posted[0]!.headers.get('if-match'))
    expect(posted[1]!.body).toEqual(posted[0]!.body)
  })
  it('never rebases an existing preview on parent refresh, and a 409 requires a fresh preview', async () => {
    const calls = serve(c => c.path === PREVIEW ? { body: shiftPreviewFixture(), etag: '"1"' }
      : { status: 409, body: { error: { code: 'timeline_conflict', message: 'Программа изменилась' } } })
    const view = render(<TimelineShiftControl {...props} />)
    await openPreview()
    view.rerender(<TimelineShiftControl {...props} blocks={[{ id: 'e1', name: 'Обновлённое имя' }]} date="2027-06-15" />)
    fireEvent.click(button('Подтвердить сдвиг'))
    await screen.findByText('Программа изменилась')
    expect(calls.find(c => c.path === CONFIRM)?.headers.get('if-match')).toBe('"1"')
    expect(button('Подтвердить сдвиг').disabled).toBe(true)
    expect(props.onAccepted).not.toHaveBeenCalled()
    fireEvent.click(button('Предпросмотр сдвига'))
    await waitFor(() => expect(button('Подтвердить сдвиг').disabled).toBe(false))
    expect(calls.filter(c => c.path === PREVIEW)).toHaveLength(2)
  })
  it.each(['conflict', 'no-etag', 'empty'] as const)('cannot confirm a %s preview', async kind => {
    const calls = serve(() => ({ body: shiftPreviewFixture(kind === 'conflict' ? { canConfirm: false, previewToken: null, conflicts: [{ kind: 'unknown_duration', blockIds: ['e1'] }] }
      : kind === 'empty' ? { canConfirm: false, previewToken: null, blocks: [] } : {}), etag: kind === 'no-etag' ? null : '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    expect(button('Подтвердить сдвиг').disabled).toBe(true)
    fireEvent.click(button('Подтвердить сдвиг'))
    expect(calls.filter(c => c.path === CONFIRM)).toHaveLength(0)
    expect(props.onAccepted).not.toHaveBeenCalled()
  })
  it('selects the actual event, and changing inputs discards the previous confirmation', async () => {
    const calls = serve(() => ({ body: shiftPreviewFixture(), etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    await openPreview()
    fireEvent.change(screen.getByLabelText('Область сдвига'), { target: { value: 'event' } })
    await screen.findByRole('option', { name: 'Второй день' })
    expect(screen.queryByRole('button', { name: 'Подтвердить сдвиг' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Мероприятие'), { target: { value: 'event2' } })
    expect(screen.getByText('2027-06-15 · Europe/Moscow')).toBeTruthy()
    fireEvent.click(button('Предпросмотр сдвига'))
    await waitFor(() => expect(calls.filter(c => c.path === PREVIEW)).toHaveLength(2))
    expect(calls.filter(c => c.path === PREVIEW)[1]!.body).toEqual({ scope: { kind: 'event', eventId: 'event2' }, minutes: 15 })
  })
  it('keeps the dialog open while confirmation is pending and restores focus on close', async () => {
    let release!: (response: ResponseSpec) => void
    serve(c => c.path === PREVIEW ? { body: shiftPreviewFixture(), etag: '"1"' }
      : new Promise<ResponseSpec>(resolve => { release = resolve }))
    render(<TimelineShiftControl {...props} />)
    const trigger = button('Сдвиг тайминга')
    await openPreview()
    fireEvent.click(button('Подтвердить сдвиг'))
    await waitFor(() => expect(button('Закрыть').disabled).toBe(true))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    release({ body: { shiftedBlocks: 1, guestsAffected: 15 }, etag: '"2"' })
    await waitFor(() => expect(button('Закрыть').disabled).toBe(false))
    fireEvent.click(button('Закрыть'))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
  it('renders the English controls and does not send an invalid numeric shift', async () => {
    setI18nLang('en')
    const calls = serve(() => ({ body: shiftPreviewFixture(), etag: '"1"' }))
    render(<TimelineShiftControl {...props} />)
    fireEvent.click(button('Timeline shift'))
    fireEvent.change(screen.getByLabelText('Shift, min'), { target: { value: '0' } })
    expect(button('Preview shift').disabled).toBe(true)
    fireEvent.click(button('Preview shift'))
    expect(calls.filter(c => c.path === PREVIEW)).toHaveLength(0)
  })
  it('uses context that arrived before the first opening, without replacing an existing draft later', async () => {
    serve(() => ({ body: shiftPreviewFixture(), etag: '"1"' }))
    const view = render(<TimelineShiftControl {...props} date={null} timeZone={null} disabled />)
    view.rerender(<TimelineShiftControl {...props} />)
    fireEvent.click(button('Сдвиг тайминга'))
    expect((screen.getByLabelText('Дата') as HTMLInputElement).value).toBe('2027-06-14')
    fireEvent.change(screen.getByLabelText('Дата'), { target: { value: '2027-06-16' } })
    fireEvent.click(button('Закрыть'))
    view.rerender(<TimelineShiftControl {...props} date="2027-06-15" />)
    fireEvent.click(button('Сдвиг тайминга'))
    expect((screen.getByLabelText('Дата') as HTMLInputElement).value).toBe('2027-06-16')
  })
  it('shows the actual forbidden event-reader response rather than an empty event selector', async () => {
    const calls = serve(() => ({ body: shiftPreviewFixture(), etag: '"1"' }), { status: 403, body: { error: { code: 'forbidden', message: 'Мероприятия недоступны вашей роли' } } })
    render(<TimelineShiftControl {...props} />)
    fireEvent.click(button('Сдвиг тайминга'))
    fireEvent.change(screen.getByLabelText('Область сдвига'), { target: { value: 'event' } })
    await screen.findByText('Мероприятия недоступны вашей роли')
    expect((screen.getByLabelText('Мероприятие') as HTMLSelectElement).disabled).toBe(true)
    expect(button('Предпросмотр сдвига').disabled).toBe(true)
    expect(calls.filter(c => c.path === PREVIEW)).toHaveLength(0)
  })
})
