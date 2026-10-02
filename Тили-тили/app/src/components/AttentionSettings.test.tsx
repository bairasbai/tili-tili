import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttentionSettings } from './AttentionSettings'
import type { WeddingAttention } from '@/lib/api/attention'
import { setI18nLang } from '@/lib/i18n'

type Call = { path: string; method: string; body: unknown; headers: Headers }
type Reply = { body?: unknown; status?: number; etag?: string | null; down?: boolean }
const team = [{ id: 'c1', name: 'Анна' }, { id: 'c2', name: 'Ольга' }]
function state(overrides: Partial<WeddingAttention> = {}): WeddingAttention {
  return { version: '1', mode: 'essential', effectiveMode: 'essential', coordinatorUserId: null, coordinatorState: 'not_selected', coordinator: null, ...overrides }
}
function read(value = state(), etag: string | null = `"${value.version}"`): Reply { return { body: value, etag } }
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
function deferred() {
  let resolve!: (reply: Reply) => void
  const promise = new Promise<Reply>(accept => { resolve = accept })
  return { promise, resolve }
}
const view = (weddingId = 'w1', coordinators = team) => <MemoryRouter><AttentionSettings weddingId={weddingId} coordinators={coordinators} /></MemoryRouter>
const radio = (label: string) => screen.getByRole('radio', { name: new RegExp(`^${label}`) }) as HTMLInputElement
const save = () => screen.getByRole('button', { name: 'Сохранить настройки' }) as HTMLButtonElement
const select = () => screen.getByRole('combobox', { name: 'Координатор для оперативных вопросов' }) as HTMLSelectElement
async function loaded() { await screen.findByRole('radio', { name: /^Только важное/ }) }
function choose(label: string) { fireEvent.click(radio(label)) }
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('optional truthful wedding attention settings', () => {
  it('shows no invented default before the versioned settings load', async () => {
    const pending = deferred(), calls = serve(() => pending.promise)
    render(view())
    expect(screen.getByText('Загружаем…')).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Сохранить настройки' })).toBeNull()
    await act(async () => pending.resolve(read()))
    await loaded()
    expect(radio('Только важное').checked).toBe(true)
    expect(save().disabled).toBe(true)
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(screen.getByText(/Выбор необязателен/)).toBeTruthy()
  })

  it('retries a failed read instead of displaying defaults as actual settings', async () => {
    let down = true
    const calls = serve(() => down ? { down: true } : read())
    render(view())
    await screen.findByRole('alert')
    expect(screen.queryByRole('radio')).toBeNull()
    down = false; fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await loaded()
    expect(calls).toHaveLength(2)
  })

  it('hides settings on read permission denial', async () => {
    serve(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'Настройки внимания меняет только пара' } } }))
    render(view())
    await screen.findByText('Настройки внимания меняет только пара')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Повторить' })).toBeNull()
  })

  it.each([null, '"2"'])('requires read ETag to match the actual version: %s', async etag => {
    serve(() => read(state(), etag)); render(view())
    await screen.findByRole('alert')
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('rejects inconsistent effective fallback data', async () => {
    serve(() => read(state({ mode: 'coordinator', effectiveMode: 'coordinator' })))
    render(view()); await screen.findByRole('alert')
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('saves only changed fields with captured If-Match and announces success after the response', async () => {
    const pending = deferred(), calls = serve(call => call.method === 'GET' ? read() : pending.promise)
    render(view()); await loaded(); choose('Подробный обзор')
    fireEvent.click(save())
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    const form = document.querySelector('form')!
    fireEvent.submit(form); fireEvent.submit(form) // Keyboard double-submit must not send another PATCH.
    fireEvent.click(radio('Через координатора'))
    expect(radio('Подробный обзор').checked).toBe(true)
    expect((form.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    const writes = calls.filter(call => call.method === 'PATCH')
    expect(writes).toHaveLength(1)
    expect(writes[0].body).toEqual({ mode: 'detailed' })
    expect(writes[0].headers.get('if-match')).toBe('"1"')
    await act(async () => pending.resolve({ body: state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' }) }))
    await screen.findByText('Настройки сохранены')
    expect(save().disabled).toBe(true)
  })

  it('choosing coordinator mode does not assign a person or grant permissions', async () => {
    const calls = serve(call => call.method === 'GET' ? read() : { body: state({ version: '2', mode: 'coordinator' }) })
    render(view()); await loaded(); choose('Через координатора'); fireEvent.click(save())
    await screen.findByText('Настройки сохранены')
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ mode: 'coordinator' })
    expect(select().value).toBe('')
    expect(screen.getByText('Координатор не выбран или недоступен. Сейчас действует «Только важное».')).toBeTruthy()
    expect(screen.getByText(/Дополнительные права не выдаются/)).toBeTruthy()
  })

  it('selects an accepted coordinator explicitly', async () => {
    const calls = serve(call => call.method === 'GET' ? read() : { body: state({ version: '2', mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] }) })
    render(view()); await loaded(); choose('Через координатора'); fireEvent.change(select(), { target: { value: 'c1' } }); fireEvent.click(save())
    await screen.findByText('Настройки сохранены')
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ mode: 'coordinator', coordinatorUserId: 'c1' })
    expect(select().value).toBe('c1')
  })

  it('shows unavailable fallback without the former name and explicitly clears selection', async () => {
    const unavailable = state({ mode: 'coordinator', coordinatorUserId: 'former', coordinatorState: 'unavailable' })
    const calls = serve(call => call.method === 'GET' ? read(unavailable) : { body: state({ version: '2', mode: 'coordinator' }) })
    render(view()); await loaded()
    expect(select().value).toBe('former')
    expect(screen.getByRole('option', { name: 'Выбранный координатор недоступен' })).toBeTruthy()
    expect(screen.getByText('Координатор не выбран или недоступен. Сейчас действует «Только важное».')).toBeTruthy()
    fireEvent.change(select(), { target: { value: '' } }); fireEvent.click(save())
    await screen.findByText('Настройки сохранены')
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ coordinatorUserId: null })
  })

  it('can change mode while keeping an unavailable stored choice without resubmitting it', async () => {
    const unavailable = state({ mode: 'coordinator', coordinatorUserId: 'former', coordinatorState: 'unavailable' })
    const calls = serve(call => call.method === 'GET' ? read(unavailable) : { body: { ...unavailable, version: '2', mode: 'essential' } })
    render(view()); await loaded(); choose('Только важное'); fireEvent.click(save())
    await screen.findByText('Настройки сохранены')
    expect(calls.find(call => call.method === 'PATCH')?.body).toEqual({ mode: 'essential' })
  })

  it('uses authoritative unavailable status even when the parent list still contains that person', async () => {
    serve(() => read(state({ mode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'unavailable' })))
    render(view()); await loaded()
    expect(select().value).toBe('c1')
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Выбранный координатор недоступен' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Ольга' })).toBeTruthy()
  })

  it('keeps the entered draft on 409 and explicitly saves against the refreshed version', async () => {
    const pendingRead = deferred()
    let reads = 0, writes = 0
    const calls = serve(call => {
      if (call.method === 'GET') return ++reads === 1 ? read() : pendingRead.promise
      if (++writes === 1) return { status: 409, body: { error: { code: 'attention_version_conflict', message: 'Настройки изменились — обновите их перед сохранением' } } }
      return { body: state({ version: '3', mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] }) }
    })
    render(view()); await loaded(); choose('Через координатора'); fireEvent.change(select(), { target: { value: 'c1' } }); fireEvent.click(save())
    await waitFor(() => expect(reads).toBe(2))
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    await act(async () => pendingRead.resolve(read(state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' }))))
    await screen.findByText('Настройки изменились. Ваш выбор сохранён в форме — проверьте его и сохраните снова.')
    expect(radio('Через координатора').checked).toBe(true)
    expect(select().value).toBe('c1')
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1)
    fireEvent.click(save()); await screen.findByText('Настройки сохранены')
    const writesMade = calls.filter(call => call.method === 'PATCH')
    expect(writesMade[1].headers.get('if-match')).toBe('"2"')
    expect(writesMade[1].body).toEqual({ mode: 'coordinator', coordinatorUserId: 'c1' })
  })

  it('blocks saving after failed conflict refresh, preserves draft and retries only the read', async () => {
    let reads = 0
    const calls = serve(call => call.method === 'GET'
      ? (++reads === 1 ? read() : reads === 2 ? { down: true } : read(state({ version: '2' })))
      : { status: 409, body: { error: { code: 'attention_version_conflict', message: 'Настройки изменились' } } })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByRole('button', { name: 'Обновить настройки' })
    await screen.findByRole('alert')
    expect(save().disabled).toBe(true)
    expect(radio('Подробный обзор').checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Обновить настройки' }))
    await screen.findByText('Настройки изменились. Ваш выбор сохранён в форме — проверьте его и сохраните снова.')
    expect(save().disabled).toBe(false)
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1)
  })

  it('rebases untouched coordinator after a partner change without silently clearing it', async () => {
    let reads = 0, writes = 0
    const partnerState = state({ version: '2', coordinatorUserId: 'c2', coordinatorState: 'active', coordinator: team[1] })
    const calls = serve(call => {
      if (call.method === 'GET') return read(++reads === 1 ? state() : partnerState)
      return ++writes === 1 ? { status: 409, body: { error: { code: 'attention_version_conflict', message: 'Настройки изменились' } } }
        : { body: { ...partnerState, version: '3', mode: 'detailed', effectiveMode: 'detailed' } }
    })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByText('Настройки изменились. Ваш выбор сохранён в форме — проверьте его и сохраните снова.')
    expect(select().value).toBe('c2')
    expect(radio('Подробный обзор').checked).toBe(true)
    fireEvent.click(save()); await screen.findByText('Настройки сохранены')
    expect(calls.filter(call => call.method === 'PATCH')[1].body).toEqual({ mode: 'detailed' })
  })

  it('rebases untouched mode after a partner change while preserving the entered coordinator', async () => {
    let reads = 0, writes = 0
    const partnerState = state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' })
    const calls = serve(call => {
      if (call.method === 'GET') return read(++reads === 1 ? state() : partnerState)
      return ++writes === 1 ? { status: 409, body: { error: { code: 'attention_version_conflict', message: 'Настройки изменились' } } }
        : { body: { ...partnerState, version: '3', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] } }
    })
    render(view()); await loaded(); fireEvent.change(select(), { target: { value: 'c1' } }); fireEvent.click(save())
    await screen.findByText('Настройки изменились. Ваш выбор сохранён в форме — проверьте его и сохраните снова.')
    expect(radio('Подробный обзор').checked).toBe(true)
    expect(select().value).toBe('c1')
    fireEvent.click(save()); await screen.findByText('Настройки сохранены')
    expect(calls.filter(call => call.method === 'PATCH')[1].body).toEqual({ coordinatorUserId: 'c1' })
  })

  it('does not claim success on a failed write and permits an explicit retry', async () => {
    let fail = true
    const calls = serve(call => call.method === 'GET' ? read() : fail ? { status: 503, body: { error: { code: 'down', message: 'Unavailable' } } } : { body: state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' }) })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save()); await screen.findByRole('alert')
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    expect(radio('Подробный обзор').checked).toBe(true)
    fail = false; fireEvent.click(save()); await screen.findByText('Настройки сохранены')
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(2)
  })

  it('rejects a successful HTTP response that does not confirm the submitted change', async () => {
    serve(() => read())
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByRole('alert')
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    expect(save().disabled).toBe(true)
    expect(radio('Подробный обзор').checked).toBe(true)
  })

  it('does not claim a changed setting is saved without a newer authoritative version', async () => {
    serve(call => call.method === 'GET' ? read() : { body: state({ mode: 'detailed', effectiveMode: 'detailed' }) })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByRole('alert')
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    expect(save().disabled).toBe(true)
  })

  it.each([403, 404, 410])('removes editor after write access is revoked: %s', async status => {
    serve(call => call.method === 'GET' ? read() : { status, body: { error: { code: 'denied', message: 'Настройки недоступны' } } })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByText('Настройки недоступны')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('invalidates a newly selected coordinator removed from the accepted list', async () => {
    const calls = serve(() => read()), rendered = render(view())
    await loaded(); fireEvent.change(select(), { target: { value: 'c1' } })
    rendered.rerender(view('w1', [])); await loaded()
    expect(select().value).toBe('')
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
    expect(save().disabled).toBe(true)
    expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(0)
    expect(calls.filter(call => call.method === 'GET')).toHaveLength(2)
  })

  it('revalidates a saved active coordinator after roster removal and masks the old name while unresolved', async () => {
    const pending = deferred()
    let reads = 0
    const active = state({ mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] })
    const calls = serve(() => ++reads === 1 ? read(active) : pending.promise)
    const rendered = render(view()); await loaded()
    expect(screen.getByRole('option', { name: 'Анна' })).toBeTruthy()
    rendered.rerender(view('w1', []))
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByText('Анна')).toBeNull()
    await act(async () => pending.resolve(read(state({ version: '2', mode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'unavailable' }))))
    await loaded()
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Выбранный координатор недоступен' })).toBeTruthy()
    expect(screen.getByText('Координатор не выбран или недоступен. Сейчас действует «Только важное».')).toBeTruthy()
    expect(calls).toHaveLength(2)
  })

  it('does not restore the former active coordinator when roster-triggered read fails', async () => {
    let reads = 0
    const active = state({ mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] })
    serve(() => ++reads === 1 ? read(active) : { down: true })
    const rendered = render(view()); await loaded(); rendered.rerender(view('w1', []))
    await screen.findByRole('alert')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
  })

  it('rejects an active identity outside the authoritative current roster even after a successful re-read', async () => {
    const active = state({ mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] })
    serve(() => read(active))
    const rendered = render(view()); await loaded(); rendered.rerender(view('w1', []))
    await screen.findByText('Настройки не подтверждены сервером — обновите их')
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('does not issue another read when only roster order changes', async () => {
    const calls = serve(() => read()), rendered = render(view()); await loaded()
    rendered.rerender(view('w1', [...team].reverse()))
    expect(calls).toHaveLength(1)
  })

  it('ignores a pending save from the previous roster after the coordinator is removed', async () => {
    const pending = deferred()
    let reads = 0
    const active = state({ coordinatorUserId: 'c1', coordinatorState: 'active', coordinator: team[0] })
    serve(call => call.method === 'PATCH' ? pending.promise : read(++reads === 1 ? active
      : state({ version: '2', coordinatorUserId: 'c1', coordinatorState: 'unavailable' })))
    const rendered = render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    rendered.rerender(view('w1', [])); await loaded()
    await act(async () => pending.resolve({ body: { ...active, version: '2', mode: 'detailed', effectiveMode: 'detailed' } }))
    expect(radio('Только важное').checked).toBe(true)
    expect(screen.queryByRole('option', { name: 'Анна' })).toBeNull()
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
  })

  it('ignores a late read from the previous wedding', async () => {
    const pending = deferred(), calls = serve(call => call.path.includes('/w1/') ? pending.promise : read())
    const rendered = render(view())
    rendered.rerender(view('w2', [])); await loaded()
    await act(async () => pending.resolve(read(state({ mode: 'coordinator', effectiveMode: 'coordinator', coordinatorUserId: 'old', coordinatorState: 'active', coordinator: { id: 'old', name: 'Чужой координатор' } }))))
    expect(screen.queryByText('Чужой координатор')).toBeNull()
    expect(radio('Только важное').checked).toBe(true)
    expect(calls.map(call => call.path)).toEqual(['/weddings/w1/attention', '/weddings/w2/attention'])
  })

  it('ignores a late save from the previous wedding', async () => {
    const pending = deferred()
    serve(call => call.method === 'PATCH' ? pending.promise : read())
    const rendered = render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    rendered.rerender(view('w2', [])); await loaded()
    await act(async () => pending.resolve({ body: state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' }) }))
    expect(radio('Только важное').checked).toBe(true)
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
  })

  it('does not resurrect settings after unmount or a failed session refresh', async () => {
    const pending = deferred()
    serve(call => call.method === 'GET' ? read() : pending.promise)
    const rendered = render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save()); rendered.unmount()
    await act(async () => pending.resolve({ body: state({ version: '2', mode: 'detailed', effectiveMode: 'detailed' }) }))
    expect(screen.queryByText('Настройки сохранены')).toBeNull()
    serve(call => call.method === 'GET' ? read() : { status: 401, body: { error: { code: 'unauthorized', message: 'Сессия истекла' } } })
    render(view()); await loaded(); choose('Подробный обзор'); fireEvent.click(save())
    await screen.findByText('Сессия истекла — войдите снова')
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('uses accessible field labels and flexible markup for a narrow 320px container', async () => {
    serve(() => read()); render(<div style={{ width: 320 }}>{view()}</div>); await loaded()
    const section = screen.getByRole('region', { name: 'Уведомления свадьбы' })
    expect(within(section).getAllByRole('radio')).toHaveLength(3)
    expect(within(section).getByRole('group', { name: 'Как получать обновления' })).toBeTruthy()
    expect(select().className).toContain('max-w-full')
    expect(section.className).toContain('min-w-0')
    expect(save().className).toContain('w-full')
    expect(document.querySelector('textarea')).toBeNull()
    expect(screen.getByText(/без дополнительных отчётов подрядчиков/)).toBeTruthy()
  })

  it('does not poll, automatically submit preferences or request periodic contractor reports', async () => {
    const calls = serve(() => read()); render(view()); await loaded()
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60_000) })
    expect(calls.map(call => call.method)).toEqual(['GET'])
    expect(save().disabled).toBe(true)
  })
})
