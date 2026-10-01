import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderDraft } from './OrderDraft'
import type { OrderCatalog, WeddingOrder } from '@/lib/api/orders'
import { setI18nLang } from '@/lib/i18n'
import { saveTokens } from '@/lib/api/client'
import { getCategoryBrief } from '../../../backend/src/orders/catalog'

type Call = { path: string; method: string; body: Record<string, unknown> | null; headers: Headers }
type Reply = { body?: unknown; status?: number; down?: boolean }
type Part = WeddingOrder['parts'][number]
const order = (overrides: Partial<WeddingOrder> = {}): WeddingOrder => ({ dealId: 'd1', version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [], ...overrides })
const catalog = (overrides: Partial<OrderCatalog> = {}): OrderCatalog => ({ weddingId: 'w1', primarySlotId: 's1', actorRole: 'couple', draftEditable: true, timeZone: 'Europe/Moscow', assignmentTimeZones: [],
  eligiblePositions: [{ slotId: 's1', programEventId: null, isPrimary: true, label: 'Основная позиция' }],
  category: { categoryId: 'photo', label: 'Фотограф', autoAssign: false, suggestedKinds: ['timed_service', 'deliverable'], fields: [
    { key: 'photographer', label: 'Имя фотографа', type: 'string', group: 'core', maxLength: 200 },
    { key: 'helpers', label: 'Количество помощников', type: 'integer', group: 'optional', min: 0, max: 10 },
    { key: 'prints', label: 'Нужна печать', type: 'boolean', group: 'optional' },
    { key: 'shots', label: 'Важные кадры', type: 'string_array', group: 'optional', maxLength: 200, maxItems: 5 },
  ] }, executionKinds: ['timed_service', 'supply', 'rental', 'deliverable', 'appointment'], ...overrides })
const assigned = { id: 'a1', slotId: 's1', programEventId: 'e1', version: '3', source: 'structured' as const, label: 'Церемония', cancelledAt: null }
const gallery: Part = { id: 'p1', kind: 'deliverable', version: '7', assignmentId: null, source: 'structured', title: 'Личная галерея', details: { items: ['100 фотографий'], dueAt: null, recipient: null, reviewProcess: null }, cancelledAt: null }
const events = [{ id: 'e1', name: 'Церемония', kind: 'ceremony', date: '2027-06-14', timeZone: 'Europe/Moscow', location: null, isMain: true }, { id: 'e2', name: 'Второй день', kind: 'second_day', date: '2027-06-15', timeZone: 'Asia/Yekaterinburg', location: null, isMain: false }]
const slots = [{ id: 's1', categoryId: 'photo', label: 'Основная позиция', prebooked: false }, { id: 's2', categoryId: 'photo', label: 'Работа второго дня', prebooked: false }, { id: 'foreign', categoryId: 'florist', label: 'Цветы', prebooked: false }]
function serve(reply: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = { path: String(input).replace(/^\/api/, ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, headers: new Headers(init?.headers) }
    calls.push(call); const answer = await reply(call)
    if (answer.down) throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
  return calls
}
function harness(current = order(), metadata = catalog(), handler?: (call: Call) => Reply | Promise<Reply>) {
  const state = { current, metadata }
  const calls = serve(call => {
    if (handler && call.method !== 'GET') return handler(call)
    if (call.path.endsWith('/catalog')) return { body: state.metadata }
    if (call.path === '/weddings/w1/events') return { body: events }
    if (call.path === '/weddings/w1/slots') return { body: slots }
    return { body: state.current }
  })
  return { state, calls }
}
function deferred() { let resolve!: (reply: Reply) => void; const promise = new Promise<Reply>(accept => { resolve = accept }); return { promise, resolve } }
const view = (dealId = 'd1') => <MemoryRouter><OrderDraft dealId={dealId} /></MemoryRouter>
async function open() { fireEvent.click(screen.getByText('Состав заказа')); await screen.findByText('Работы и результаты') }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }) }
function click(label: string) { fireEvent.click(screen.getByRole('button', { name: label })) }
const writes = (calls: Call[]) => calls.filter(call => call.method !== 'GET')
function writeAt(calls: Call[], index = 0): Call {
  const call = writes(calls)[index]
  if (!call) throw new Error(`Expected HTTP write at index ${index}`)
  return call
}
async function add(kind = 'deliverable') {
  click('Добавить работу или результат'); change('Вид работы', kind); change('Название работы', 'Новая работа')
}
const denied = (status = 403): Reply => ({ status, body: { error: { code: 'forbidden', message: 'Доступ закрыт' } } })
beforeEach(() => { localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' })); setI18nLang('ru') })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setI18nLang('ru') })

describe('optional private order draft through the real HTTP client', () => {
  it('does not fetch or assert work until the collapsed section is opened, and does not poll', async () => {
    const h = harness(); render(view()); await act(async () => {})
    expect(h.calls).toHaveLength(0); expect(screen.queryByText('Работы пока не описаны')).toBeNull()
    await open(); expect(h.calls.map(call => call.path).sort()).toEqual(['/deals/d1/order', '/deals/d1/order/catalog'])
    expect(screen.getByText(/Необязательный черновик/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Сохранить работу' })).toBeNull()
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)))
    expect(h.calls).toHaveLength(2)
  })

  it('shows loading and retries failed actual reads without presenting defaults', async () => {
    let down = true; const calls = serve(call => down ? { down: true } : { body: call.path.endsWith('/catalog') ? catalog() : order() })
    render(view()); fireEvent.click(screen.getByText('Состав заказа'))
    await screen.findByRole('alert'); expect(screen.queryByText('Работы пока не описаны')).toBeNull()
    down = false; click('Повторить'); await screen.findByText('Работы и результаты'); expect(calls).toHaveLength(4)
  })

  it.each([403, 404])('clears private UI when the opening read is denied with %s', async status => {
    serve(() => denied(status)); render(view()); fireEvent.click(screen.getByText('Состав заказа'))
    await screen.findByText('Доступ закрыт'); expect(screen.queryByLabelText('Имя фотографа')).toBeNull()
  })

  it('uses typed metadata with unknown distinct from zero and false and only a short core group', async () => {
    const h = harness(order({ brief: { categoryId: 'photo', values: { helpers: 0, prints: false } } })); render(view()); await open()
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Количество помощников') as HTMLInputElement).value).toBe('0')
    expect((screen.getByLabelText('Нужна печать') as HTMLSelectElement).value).toBe('false')
    expect(screen.getByLabelText('Количество помощников').closest('details')?.open).toBe(false)
    change('Имя фотографа', 'Мария'); change('Количество помощников', ''); change('Нужна печать', ''); change('Важные кадры', 'Общий кадр\nПервый танец')
    click('Сохранить пожелания'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '1', brief: { values: { photographer: 'Мария', helpers: null, prints: null, shots: ['Общий кадр', 'Первый танец'] } } })
  })

  it('rejects fractional and out-of-range metadata integers without an HTTP write', async () => {
    const h = harness(); render(view()); await open(); change('Количество помощников', '1.5'); click('Сохранить пожелания')
    fireEvent.submit(screen.getByLabelText('Количество помощников').closest('form')!)
    await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
    change('Количество помощников', '11'); click('Сохранить пожелания'); expect(writes(h.calls)).toHaveLength(0)
  })

  it('uses actual florist subtype fields instead of merging the base and duplicating shop/installation fields', async () => {
    const actual = JSON.parse(JSON.stringify(getCategoryBrief('florist'))) as OrderCatalog['category']
    const h = harness(order({ brief: { categoryId: 'florist', subtypeId: 'shop', values: { quantity: 12 } } }), catalog({ category: actual }))
    render(view()); await open()
    expect(screen.getAllByLabelText('Количество')).toHaveLength(1)
    expect(screen.queryByLabelText('Зоны оформления')).toBeNull()
    expect(screen.queryByLabelText('Время монтажа')).toBeNull()
    change('Вариант услуги', 'installation'); change('Согласованный эскиз', 'Арка у входа')
    expect(screen.getAllByLabelText('Количество')).toHaveLength(1)
    expect(screen.getByLabelText('Время монтажа')).toBeTruthy()
    click('Сохранить пожелания'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    const body = writeAt(h.calls, 0).body!
    const brief = body.brief as { subtypeId: string; values: Record<string, unknown> }
    expect(brief.subtypeId).toBe('installation'); expect(brief.values.design).toBe('Арка у входа')
    expect(Object.keys(brief.values).sort()).toEqual(getCategoryBrief('florist', 'installation')!.fields.map(field => field.key).sort())
    expect(screen.getByText('Мероприятия пока не назначены')).toBeTruthy()
  })

  it('uses actual child supervision fields without the entertainment program', async () => {
    const actual = JSON.parse(JSON.stringify(getCategoryBrief('nanny'))) as OrderCatalog['category']
    harness(order({ brief: { categoryId: 'nanny', subtypeId: 'supervision', values: {} } }), catalog({ category: actual }))
    render(view()); await open()
    expect(screen.getAllByLabelText('Количество детей')).toHaveLength(1)
    expect(screen.queryByLabelText('Программа развлечений')).toBeNull()
    change('Вариант услуги', 'entertainment')
    expect(screen.getAllByLabelText('Количество детей')).toHaveLength(1)
    expect(screen.getByLabelText('Программа развлечений')).toBeTruthy()
    expect(screen.queryByLabelText('Порядок передачи ребёнка взрослому')).toBeNull()
  })

  it('immediately destroys an open private draft on same-window logout without waiting for page navigation', async () => {
    harness(order({ parts: [gallery] })); render(view()); await open()
    expect(screen.getByText('Личная галерея')).toBeTruthy()
    act(() => saveTokens(null))
    expect(screen.queryByText('Личная галерея')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('Сессия истекла')
  })

  it('clears a saved brief explicitly with null and the current version', async () => {
    const h = harness(order({ version: '8', brief: { categoryId: 'photo', values: { photographer: 'Мария' } } })); render(view()); await open()
    click('Очистить пожелания'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '8', brief: null })
  })

  it.each(['timed_service', 'supply', 'rental', 'deliverable', 'appointment'])('composes %s with actual assignments and no finance/readiness fields', async kind => {
    const h = harness(order({ version: '9', assignments: [assigned] }), catalog({ assignmentTimeZones: [{ assignmentId: 'a1', programEventId: 'e1', timeZone: 'Europe/Moscow' }] })); render(view()); await open(); await add(kind)
    if (kind !== 'deliverable') change('Мероприятие для работы', 'a1')
    if (kind === 'supply' || kind === 'rental') { change('Количество', '2'); change('Единица измерения', 'комплекта') }
    click('Добавить в черновик'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    const body = writeAt(h.calls, 0).body!; expect(body).toMatchObject({ expectedVersion: '9', kind, title: 'Новая работа', assignmentId: kind === 'deliverable' ? null : 'a1' })
    expect(Object.keys(body).sort()).toEqual(['assignmentId', 'details', 'expectedVersion', 'kind', 'title'])
    if (kind === 'supply' || kind === 'rental') expect(body.details).toMatchObject({ quantity: 2, unit: 'комплекта' })
    expect(JSON.stringify(body)).not.toMatch(/price|accepted|ready|booked/)
  })

  it('blocks event work until an actual active assignment exists and never auto-assigns it', async () => {
    const h = harness(order({ assignments: [{ ...assigned, cancelledAt: '2026-09-30T12:00:00Z' }] })); render(view()); await open(); await add('supply')
    expect((screen.getByRole('button', { name: 'Добавить в черновик' }) as HTMLButtonElement).disabled).toBe(true)
    expect(within(screen.getByLabelText('Мероприятие для работы')).queryByRole('option', { name: 'Церемония' })).toBeNull()
    fireEvent.submit(screen.getByLabelText('Название работы').closest('form')!); expect(writes(h.calls)).toHaveLength(0)
  })

  it('uses current root and child versions, sends only edited part fields and preserves explicit null clearing', async () => {
    const h = harness(order({ version: '12', parts: [gallery] })); render(view()); await open(); click('Изменить работу'); change('Что передать', ''); click('Сохранить работу')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writeAt(h.calls, 0).path).toBe('/deals/d1/order/parts/p1')
    expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '12', expectedPartVersion: '7', details: { items: null } })
  })

  it('title-only editing preserves an existing instant with seconds and milliseconds without local-time normalization', async () => {
    const original = { ...gallery, details: { ...gallery.details, dueAt: '2027-07-01T09:10:37.123Z' } }
    const h = harness(order({ version: '12', parts: [original] })); render(view()); await open(); click('Изменить работу')
    expect((screen.getByLabelText('Срок передачи') as HTMLInputElement).value).toBe('2027-07-01T12:10')
    change('Название работы', 'Новое название'); click('Сохранить работу'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '12', expectedPartVersion: '7', title: 'Новое название' })
    expect(original.details.dueAt).toBe('2027-07-01T09:10:37.123Z')
  })

  it('cancels with captured root and child versions and renders cancellation history without edit controls', async () => {
    const h = harness(order({ version: '12', parts: [gallery, { ...gallery, id: 'old', title: 'Старый вариант', cancelledAt: '2026-09-30T12:00:00Z' }] })); render(view()); await open()
    expect(screen.getAllByRole('button', { name: 'Изменить работу' })).toHaveLength(1)
    click('Убрать работу из черновика'); await waitFor(() => expect(writes(h.calls)).toHaveLength(1))
    expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '12', expectedPartVersion: '7' })
    expect(writeAt(h.calls, 0).path).toBe('/deals/d1/order/parts/p1/cancel')
  })

  it('retains exact key and body after response loss, freezes input, and uses a new key for a later intention', async () => {
    let attempt = 0
    const h = harness(order(), catalog(), () => ++attempt === 1 ? { down: true } : { body: order({ version: '2', source: 'structured' }) })
    render(view()); await open(); change('Имя фотографа', 'Мария'); click('Сохранить пожелания')
    await screen.findByRole('button', { name: 'Проверить сохранение' })
    const field = screen.getByLabelText('Имя фотографа') as HTMLInputElement
    expect((field.closest('fieldset') as HTMLFieldSetElement).disabled).toBe(true)
    click('Проверить сохранение'); await screen.findByText('Черновик сохранён')
    const first = writeAt(h.calls), retry = writeAt(h.calls, 1); expect(first.body).toEqual(retry.body); expect(first.headers.get('idempotency-key')).toBe(retry.headers.get('idempotency-key'))
    change('Имя фотографа', 'Ольга'); click('Сохранить пожелания'); await waitFor(() => expect(writes(h.calls)).toHaveLength(3))
    expect(writeAt(h.calls, 2).headers.get('idempotency-key')).not.toBe(first.headers.get('idempotency-key'))
  })

  it('guards mouse and keyboard double submit and only announces success after an actual response', async () => {
    const pending = deferred(), h = harness(order(), catalog(), () => pending.promise); render(view()); await open(); change('Имя фотографа', 'Мария')
    click('Сохранить пожелания'); const form = screen.getByLabelText('Имя фотографа').closest('form')!
    fireEvent.submit(form); fireEvent.submit(form); expect(writes(h.calls)).toHaveLength(1); expect(screen.queryByText('Черновик сохранён')).toBeNull()
    await act(async () => pending.resolve({ body: order({ version: '2' }) })); await screen.findByText('Черновик сохранён')
  })

  it('retains an uncertain request through ordinary collapse and retries its identical key and body', async () => {
    let attempts = 0
    const h = harness(order(), catalog(), () => ++attempts === 1 ? { down: true } : { body: order({ version: '2' }) })
    render(view()); await open(); change('Имя фотографа', 'Мария'); click('Сохранить пожелания')
    await screen.findByRole('button', { name: 'Проверить сохранение' }); fireEvent.click(screen.getByText('Состав заказа'))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Проверить сохранение' })).toBeNull())
    fireEvent.click(screen.getByText('Состав заказа')); await screen.findByRole('button', { name: 'Проверить сохранение' }); click('Проверить сохранение')
    await screen.findByText('Черновик сохранён'); expect(writes(h.calls)).toHaveLength(2)
    expect(writeAt(h.calls, 1).body).toEqual(writeAt(h.calls, 0).body)
    expect(writeAt(h.calls, 1).headers.get('idempotency-key')).toBe(writeAt(h.calls, 0).headers.get('idempotency-key'))
  })

  it('saving another form preserves unsaved brief input and rebases only untouched values', async () => {
    const h = harness(order(), catalog(), () => { h.state.current = order({ version: '2', brief: { categoryId: 'photo', values: { helpers: 2 } }, parts: [gallery] }); return { body: h.state.current } })
    render(view()); await open(); change('Имя фотографа', 'Ещё не сохранено'); await add(); click('Добавить в черновик'); await screen.findByText('Черновик сохранён')
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('Ещё не сохранено')
    expect((screen.getByLabelText('Количество помощников') as HTMLInputElement).value).toBe('2')
    expect(screen.queryByLabelText('Название работы')).toBeNull()
  })

  it('does not repeat a confirmed write when the following current metadata read fails', async () => {
    let committed = false, readDown = false
    const calls = serve(call => {
      if (call.method !== 'GET') { committed = true; readDown = true; return { body: order({ version: '2' }) } }
      if (readDown) return { down: true }
      return { body: call.path.endsWith('/catalog') ? catalog() : order({ version: committed ? '2' : '1' }) }
    }); render(view()); await open(); change('Имя фотографа', 'Мария'); click('Сохранить пожелания'); await screen.findByRole('button', { name: 'Обновить заказ' })
    expect(screen.queryByRole('button', { name: 'Проверить сохранение' })).toBeNull(); expect(screen.queryByText('Черновик сохранён')).toBeNull()
    readDown = false; click('Обновить заказ'); await screen.findByText('Черновик сохранён'); expect(writes(calls)).toHaveLength(1)
  })

  it('an unconfirmed malformed success never announces saved or creates a new retry intention', async () => {
    const h = harness(order(), catalog(), () => ({ body: { status: 'ok' } })); render(view()); await open(); await add(); click('Добавить в черновик')
    await screen.findByRole('button', { name: 'Проверить сохранение' }); expect(screen.queryByText('Черновик сохранён')).toBeNull()
    click('Проверить сохранение'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2))
    expect(writeAt(h.calls, 1).body).toEqual(writeAt(h.calls, 0).body)
    expect(writeAt(h.calls, 1).headers.get('idempotency-key')).toBe(writeAt(h.calls, 0).headers.get('idempotency-key'))
  })

  it('replay may return an older saved body but the next intention uses the freshly read current version', async () => {
    let count = 0
    const h = harness(order(), catalog(), () => {
      if (++count === 1) { h.state.current = order({ version: '9' }); return { down: true } }
      return { body: order({ version: '2' }) }
    }); render(view()); await open(); change('Имя фотографа', 'Первый ввод'); click('Сохранить пожелания'); await screen.findByRole('button', { name: 'Проверить сохранение' })
    click('Проверить сохранение'); await screen.findByText('Черновик сохранён'); change('Имя фотографа', 'Следующий ввод'); click('Сохранить пожелания')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(3)); expect(writeAt(h.calls, 2).body?.expectedVersion).toBe('9')
  })

  it('refreshes conflict versions, preserves edited fields, rebases untouched fields and requires explicit review', async () => {
    let attempts = 0
    const h = harness(order({ brief: { categoryId: 'photo', values: { photographer: 'Анна', helpers: 1 } } }), catalog(), () => {
      if (++attempts === 1) { h.state.current = order({ version: '8', brief: { categoryId: 'photo', values: { photographer: 'Ирина', helpers: 3 } } }); return { status: 409, body: { error: { code: 'order_version_conflict', message: 'Заказ изменился' } } } }
      return { body: order({ version: '9' }) }
    }); render(view()); await open(); change('Имя фотографа', 'Мой выбор'); click('Сохранить пожелания')
    await screen.findByRole('button', { name: 'Проверил изменения, продолжить' })
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('Мой выбор')
    expect((screen.getByLabelText('Количество помощников') as HTMLInputElement).value).toBe('3')
    fireEvent.submit(screen.getByLabelText('Имя фотографа').closest('form')!); expect(writes(h.calls)).toHaveLength(1)
    click('Проверил изменения, продолжить'); click('Сохранить пожелания'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2))
    expect(writeAt(h.calls, 1).body).toMatchObject({ expectedVersion: '8', brief: { values: { photographer: 'Мой выбор', helpers: 3 } } })
    expect(writeAt(h.calls, 1).headers.get('idempotency-key')).not.toBe(writeAt(h.calls, 0).headers.get('idempotency-key'))
  })

  it('updates root AND child versions after conflict while retaining only entered part fields', async () => {
    const h = harness(order({ version: '12', parts: [gallery] }), catalog(), () => {
      h.state.current = order({ version: '20', parts: [{ ...gallery, version: '9', details: { ...gallery.details, recipient: 'Новый получатель' } }] })
      return { status: 409, body: { error: { code: 'order_part_version_conflict', message: 'Работа изменена' } } }
    }); render(view()); await open(); click('Изменить работу'); change('Название работы', 'Мой вариант'); click('Сохранить работу')
    await screen.findByRole('button', { name: 'Проверил изменения, продолжить' }); expect((screen.getByLabelText('Кто получает') as HTMLInputElement).value).toBe('Новый получатель')
    click('Проверил изменения, продолжить'); click('Сохранить работу'); await waitFor(() => expect(writes(h.calls)).toHaveLength(2))
    expect(writeAt(h.calls, 1).body).toEqual({ expectedVersion: '20', expectedPartVersion: '9', title: 'Мой вариант' })
  })

  it('keeps edited input blocked when conflict reread fails, then requires review after a successful fresh read', async () => {
    let conflicted = false, down = true
    const calls = serve(call => {
      if (call.method !== 'GET') { conflicted = true; return { status: 409, body: { error: { code: 'order_version_conflict', message: 'Заказ изменился' } } } }
      if (conflicted && down) return { down: true }
      return { body: call.path.endsWith('/catalog') ? catalog() : order({ version: conflicted ? '8' : '1' }) }
    }); render(view()); await open(); change('Имя фотографа', 'Мой ввод'); click('Сохранить пожелания'); await screen.findByRole('button', { name: 'Обновить заказ' })
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('Мой ввод'); fireEvent.submit(screen.getByLabelText('Имя фотографа').closest('form')!); expect(writes(calls)).toHaveLength(1)
    down = false; click('Обновить заказ'); await screen.findByRole('button', { name: 'Проверил изменения, продолжить' })
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('Мой ввод')
  })

  it('revoked conflict reread clears retained private inputs rather than offering review or retry', async () => {
    let conflicted = false
    serve(call => {
      if (call.method !== 'GET') { conflicted = true; return { status: 409, body: { error: { code: 'order_version_conflict', message: 'Заказ изменился' } } } }
      if (conflicted) return denied()
      return { body: call.path.endsWith('/catalog') ? catalog() : order({ parts: [gallery] }) }
    }); render(view()); await open(); change('Имя фотографа', 'Частный ввод'); click('Сохранить пожелания'); await screen.findByText('Доступ закрыт')
    expect(screen.queryByLabelText('Имя фотографа')).toBeNull(); expect(screen.queryByRole('button', { name: 'Обновить заказ' })).toBeNull()
  })

  it('vendor does not fetch wedding roster/events/slots or expose assignment administration', async () => {
    const h = harness(order({ assignments: [assigned], parts: [gallery] }), catalog({ actorRole: 'vendor', eligiblePositions: [] })); render(view()); await open()
    expect(screen.queryByRole('button', { name: 'Назначить на мероприятие' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Убрать назначение' })).toBeNull()
    await add(); expect(h.calls.every(call => call.path.startsWith('/deals/'))).toBe(true)
  })

  it('offers only actual eligible existing positions for the selected event, excluding active assignments and unrelated slots', async () => {
    const h = harness(order({ assignments: [assigned] }), catalog({ eligiblePositions: [
      { slotId: 's1', programEventId: null, isPrimary: true, label: 'Основная позиция' },
      { slotId: 's2', programEventId: 'e2', isPrimary: false, label: 'Работа второго дня' },
    ] })); render(view()); await open(); click('Назначить на мероприятие'); await screen.findByLabelText('Позиция заказа')
    change('Мероприятие', 'e1'); const select = screen.getByLabelText('Позиция заказа')
    expect(within(select).queryByRole('option', { name: 'Основная позиция' })).toBeNull(); expect(within(select).queryByRole('option', { name: 'Работа второго дня' })).toBeNull()
    change('Мероприятие', 'e2'); change('Позиция заказа', 's2'); change('Название назначения', 'Съёмка второго дня'); click('Сохранить назначение')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '1', slotId: 's2', programEventId: 'e2', label: 'Съёмка второго дня' })
    expect(h.calls.filter(call => call.method === 'GET').map(call => call.path)).toContain('/weddings/w1/slots')
    expect(writeAt(h.calls, 0).path).toBe('/deals/d1/order/assignments')
  })

  it('cancels an assignment using actual child version without cancelling the financial deal', async () => {
    const h = harness(order({ version: '10', assignments: [assigned] })); render(view()); await open(); click('Убрать назначение')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body).toEqual({ expectedVersion: '10', expectedAssignmentVersion: '3' })
    expect(writeAt(h.calls, 0).path).toBe('/deals/d1/order/assignments/a1/cancel')
  })

  it('invalidates a selected position removed by refreshed authoritative metadata without erasing the entered label', async () => {
    const h = harness(order(), catalog(), () => {
      h.state.current = order({ version: '2' }); h.state.metadata = catalog({ eligiblePositions: [] })
      return { status: 409, body: { error: { code: 'slot_taken', message: 'Позиция занята' } } }
    }); render(view()); await open(); click('Назначить на мероприятие'); await screen.findByLabelText('Позиция заказа')
    change('Мероприятие', 'e1'); change('Позиция заказа', 's1'); change('Название назначения', 'Мой ввод'); click('Сохранить назначение')
    await screen.findByRole('button', { name: 'Проверил изменения, продолжить' }); click('Проверил изменения, продолжить')
    expect((screen.getByLabelText('Название назначения') as HTMLInputElement).value).toBe('Мой ввод')
    expect((screen.getByRole('button', { name: 'Сохранить назначение' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByLabelText('Название назначения').closest('form')!); expect(writes(h.calls)).toHaveLength(1)
  })

  it('closed historical orders expose saved descriptions without active edit controls', async () => {
    harness(order({ parts: [gallery], assignments: [assigned] }), catalog({ draftEditable: false })); render(view()); await open()
    expect(screen.getByText(/Заказ закрыт для изменений/)).toBeTruthy(); expect(screen.getByText('100 фотографий')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Изменить работу' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Добавить работу или результат' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Назначить на мероприятие' })).toBeNull()
  })

  it('late reads from another deal cannot repopulate the new section', async () => {
    const old = deferred(); serve(call => call.path.includes('/d1/') ? old.promise : { body: call.path.endsWith('/catalog') ? catalog() : order({ dealId: 'd2' }) })
    const rendered = render(view()); fireEvent.click(screen.getByText('Состав заказа')); await waitFor(() => expect(screen.getByText('Загружаем…')).toBeTruthy())
    rendered.rerender(view('d2')); await open(); await act(async () => old.resolve({ body: order({ brief: { categoryId: 'photo', values: { photographer: 'Чужие данные' } } }) }))
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe(''); expect(screen.queryByText('Чужие данные')).toBeNull()
  })

  it('a late write response cannot reset or overwrite inputs for a different deal', async () => {
    const pending = deferred(), calls = serve(call => {
      if (call.method !== 'GET') return pending.promise
      return { body: call.path.endsWith('/catalog') ? catalog() : order({ dealId: call.path.includes('/d2/') ? 'd2' : 'd1' }) }
    }); const rendered = render(view()); await open(); change('Имя фотографа', 'Старый ввод'); click('Сохранить пожелания')
    rendered.rerender(view('d2')); await open(); change('Имя фотографа', 'Новый ввод')
    await act(async () => pending.resolve({ body: order({ version: '2' }) }))
    expect((screen.getByLabelText('Имя фотографа') as HTMLInputElement).value).toBe('Новый ввод'); expect(screen.queryByText('Черновик сохранён')).toBeNull()
    expect(calls.filter(call => call.method === 'GET' && call.path.includes('/d1/'))).toHaveLength(2)
  })

  it.each([403, 404])('revoked write with %s immediately wipes private drafts and disables replay', async status => {
    harness(order({ parts: [gallery] }), catalog(), () => denied(status)); render(view()); await open(); change('Имя фотографа', 'Частный ввод'); click('Сохранить пожелания')
    await screen.findByText('Доступ закрыт'); expect(screen.queryByLabelText('Имя фотографа')).toBeNull(); expect(screen.queryByText('Личная галерея')).toBeNull(); expect(screen.queryByRole('button', { name: 'Проверить сохранение' })).toBeNull()
  })

  it('session expiration wipes private draft even when a refresh fails', async () => {
    harness(order({ parts: [gallery] }), catalog(), () => denied(401)); render(view()); await open(); change('Имя фотографа', 'Частный ввод'); click('Сохранить пожелания')
    await screen.findByText('Сессия истекла — войдите снова'); expect(screen.queryByText('Личная галерея')).toBeNull(); expect(screen.queryByLabelText('Имя фотографа')).toBeNull()
  })

  it('a changed actual role on refresh wipes previous role drafts', async () => {
    const h = harness(order({ parts: [gallery] }), catalog(), () => { h.state.metadata = catalog({ actorRole: 'vendor', eligiblePositions: [] }); return { body: order({ version: '2' }) } })
    render(view()); await open(); change('Имя фотографа', 'Частный ввод'); click('Сохранить пожелания')
    await screen.findByText('Доступ к заказу изменился. Откройте раздел заново.'); expect(screen.queryByLabelText('Имя фотографа')).toBeNull(); expect(screen.queryByText('Черновик сохранён')).toBeNull()
  })

  it.each(['Europe/Moscow', 'Asia/Yekaterinburg'])('converts entered local time in actual assignment zone %s', async zone => {
    const h = harness(order({ assignments: [assigned] }), catalog({ timeZone: 'Pacific/Kiritimati', assignmentTimeZones: [{ assignmentId: 'a1', programEventId: 'e1', timeZone: zone }] })); render(view()); await open(); await add('appointment'); change('Мероприятие для работы', 'a1'); change('Начало', '2027-06-14T12:00'); click('Добавить в черновик')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body?.details).toMatchObject({ startsAt: zone === 'Europe/Moscow' ? '2027-06-14T09:00:00.000Z' : '2027-06-14T07:00:00.000Z' })
  })

  it('does not fall back to wedding/viewer zone when an actual assignment has no time zone', async () => {
    const h = harness(order({ assignments: [assigned] }), catalog({ timeZone: 'Europe/Moscow', assignmentTimeZones: [{ assignmentId: 'a1', programEventId: 'e1', timeZone: null }] })); render(view()); await open(); await add('appointment'); change('Мероприятие для работы', 'a1'); change('Начало', '2027-06-14T12:00'); click('Добавить в черновик')
    await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
    expect(screen.getAllByText(/Часовой пояс мероприятия не указан/).length).toBeGreaterThan(0)
  })

  it('uses explicit wedding zone for a result without an assignment', async () => {
    const h = harness(order(), catalog({ timeZone: 'Pacific/Kiritimati' })); render(view()); await open(); await add(); change('Срок передачи', '2027-06-14T12:00'); click('Добавить в черновик')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body?.details).toMatchObject({ dueAt: '2027-06-13T22:00:00.000Z' })
  })

  it('requires an explicit occurrence for Berlin autumn repeated hour and sends the selected instant', async () => {
    const h = harness(order(), catalog({ timeZone: 'Europe/Berlin' })); render(view()); await open(); await add(); change('Срок передачи', '2027-10-31T02:30'); click('Добавить в черновик')
    await screen.findByRole('alert'); expect(writes(h.calls)).toHaveLength(0)
    change('Это время встречается дважды. Выберите вариант.', '60'); click('Добавить в черновик')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body?.details).toMatchObject({ dueAt: '2027-10-31T01:30:00.000Z' })
  })

  it('rejects Berlin spring gap without normalization or an HTTP write', async () => {
    const h = harness(order(), catalog({ timeZone: 'Europe/Berlin' })); render(view()); await open(); await add(); change('Срок передачи', '2027-03-28T02:30')
    expect(screen.getByText(/Такого местного времени нет/)).toBeTruthy(); click('Добавить в черновик'); expect(writes(h.calls)).toHaveLength(0)
  })

  it('supports a half-hour repeated transition without assuming one-hour offsets', async () => {
    const h = harness(order(), catalog({ timeZone: 'Australia/Lord_Howe' })); render(view()); await open(); await add(); change('Срок передачи', '2027-04-04T01:45')
    const choice = screen.getByLabelText('Это время встречается дважды. Выберите вариант.')
    expect(within(choice).getByRole('option', { name: 'Второе наступление (+10:30)' })).toBeTruthy()
    change('Это время встречается дважды. Выберите вариант.', '630'); click('Добавить в черновик')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body?.details).toMatchObject({ dueAt: '2027-04-03T15:15:00.000Z' })
  })

  it('uses metadata date and choice fields and sends explicit zero and false rather than treating them as missing', async () => {
    const metadata = catalog(); metadata.category.fields.push({ key: 'meetingDate', label: 'Дата встречи', type: 'date', group: 'core' }, { key: 'style', label: 'Стиль', type: 'string', group: 'core', options: ['Репортаж', 'Портрет'] })
    const h = harness(order(), metadata); render(view()); await open(); change('Количество помощников', '0'); change('Нужна печать', 'false'); change('Дата встречи', '2027-06-14'); change('Стиль', 'Репортаж'); click('Сохранить пожелания')
    await waitFor(() => expect(writes(h.calls)).toHaveLength(1)); expect(writeAt(h.calls, 0).body).toMatchObject({ brief: { values: { helpers: 0, prints: false, meetingDate: '2027-06-14', style: 'Репортаж' } } })
  })

  it('has associated labels and wrapping/min-width markup suitable for 320/390px without raw JSON or ISO inputs', async () => {
    harness(); const rendered = render(view()); await open(); await add('rental')
    expect(rendered.container.querySelector('details')?.className).toContain('min-w-0')
    for (const input of rendered.container.querySelectorAll('input,select,textarea')) {
      expect(input.id).not.toBe(''); expect(rendered.container.querySelector(`label[for="${input.id}"]`)).toBeTruthy(); expect(input.className).toContain('min-w-0')
    }
    expect(screen.queryByLabelText(/JSON|ISO/)).toBeNull()
    // jsdom checks structure and keyboard controls, not physical mobile layout.
  })
})
