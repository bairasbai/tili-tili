import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import PaymentSchedule from '@/pages/PaymentSchedule'
import type { PaymentScheduleData } from './api/paymentSchedule'
import { setI18nLang } from './i18n'
vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: 'w1' }) }))
const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const stage = { id: 'i1', dealId: 'd1', title: 'Аванс', amount: money(400000), paid: money(0), remaining: money(400000), due: '2027-05-01', version: 3, status: 'pending' as const, overdue: false, cancelReason: null }
let state: PaymentScheduleData
let status = 200, failSave = false, stale = false
let writes: { path: string; body: Record<string, unknown>; key: string | null }[]
let reads: string[]
let release: (() => void) | null = null
let delayWrite = false
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    if (!init?.method || init.method === 'GET') {
      reads.push(path)
      return status === 200 ? json(state) : json({ error: { code: status === 403 ? 'forbidden' : 'db_unavailable', message: 'Нет доступа или сервер недоступен' } }, status)
    }
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
    writes.push({ path, body, key: new Headers(init.headers).get('Idempotency-Key') })
    if (delayWrite) await new Promise<void>(resolve => { release = resolve })
    if (stale) return json({ error: { code: 'stale_payment_plan', message: 'График изменился' } }, 409)
    if (failSave) return json({ error: { code: 'validation_failed', message: 'Сумма отклонена' } }, 422)
    if (path.endsWith('/payment-schedule') && init.method === 'POST') state.items.push({ ...stage, id: 'new', title: String(body.title) })
    return json(stage, path.endsWith('/payment-schedule') ? 201 : 200)
  }))
}
const open = () => render(<MemoryRouter><PaymentSchedule /></MemoryRouter>)
async function newForm() {
  await screen.findByRole('button', { name: 'Добавить этап' })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить этап' }))
  const form = screen.getByRole('form', { name: 'Редактор платежа' })
  fireEvent.change(within(form).getByLabelText('Название этапа'), { target: { value: 'Остаток фотографу' } })
  fireEvent.change(within(form).getByLabelText('Сумма, ₽'), { target: { value: '1 234,56' } })
  return form
}
beforeEach(() => {
  setI18nLang('ru'); localStorage.clear(); localStorage.setItem('tt_auth', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }))
  state = { range: { from: '2027-01-01', to: '2027-12-31', today: '2027-01-01', timeZone: 'Asia/Yekaterinburg', includeOverdue: true, includeCancelled: false }, readOnly: false,
    summary: { committed: money(1000000), recorded: money(100000), remaining: money(900000), unallocated: money(100000), inactiveDealRecorded: money(0), unknownPrices: 0 },
    dueInWindow: money(400000), items: [{ ...stage }],
    deals: [{ id: 'd1', slotId: 's1', name: 'Фотограф', state: 'booked', price: money(1000000), recorded: money(100000), remaining: money(900000), planned: money(400000), unallocated: money(100000), needsReview: false, active: true, canPlan: true }],
    allInstallments: [{ id: 'i1', dealId: 'd1', title: 'Аванс', status: 'pending', remaining: money(400000) }],
    payments: [{ id: 'p1', dealId: 'd1', kind: 'deposit', amount: money(100000), status: 'recorded', createdAt: '2027-01-01T12:00:00.000Z', installmentId: null, version: 2 }] }
  status = 200; failSave = false; stale = false; writes = []; reads = []; delayWrite = false; release = null; serve()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setI18nLang('ru') })
describe('018-A: график платежей в интерфейсе', () => {
  it('создаёт этап с точной суммой и ключом, без вызова оплаты', async () => {
    open(); const form = await newForm(); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/weddings/w1/payment-schedule', body: { dealId: 'd1', title: 'Остаток фотографу', amount: money(123456), due: '2027-01-01' } })
    expect(writes[0].key).toBeTruthy()
    await screen.findByText('Изменение сохранено')
  })
  it('частичная оплата несёт версию этапа и идёт только новым API', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отметить оплату' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Сумма, ₽'), { target: { value: '100' } }); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/weddings/w1/payment-schedule/i1/pay', body: { version: 3, amount: money(10000) } })
  })
  it('ошибка сохраняет черновик и повтор использует тот же ключ', async () => {
    failSave = true; open(); const form = await newForm(); fireEvent.submit(form)
    await screen.findByRole('alert')
    expect((within(form).getByLabelText('Название этапа') as HTMLInputElement).value).toBe('Остаток фотографу')
    fireEvent.submit(form); await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].key).toBe(writes[0].key)
  })
  it('двойное нажатие во время запроса не создаёт вторую запись', async () => {
    delayWrite = true; open(); const form = await newForm(); fireEvent.submit(form); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(within(form).getByRole('button', { name: 'Сохраняем…' }).hasAttribute('disabled')).toBe(true)
    release?.(); await screen.findByText('Изменение сохранено'); expect(writes).toHaveLength(1)
  })
  it('нет доступа — нет финансовых цифр, действий и выгрузки', async () => {
    status = 403; open(); await screen.findByText('Финансовый раздел доступен только паре')
    expect(screen.queryByText('Обязательства')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Добавить этап' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'История CSV' })).toBeNull()
  })
  it('ошибка чтения не изображает нули и пустую историю', async () => {
    status = 503; open(); await screen.findByRole('button', { name: 'Повторить' })
    expect(screen.queryByText('Нет этапов по выбранному фильтру')).toBeNull()
    expect(screen.queryByText('Отметок оплат пока нет')).toBeNull()
  })
  it('привязка использует прежний payment и не создаёт новый', async () => {
    open(); const row = await screen.findByRole('button', { name: 'Привязать оплату' }); fireEvent.click(row)
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Этап платежа'), { target: { value: 'i1' } }); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/weddings/w1/payments/p1/plan', body: { version: 2, installmentId: 'i1' } })
  })
  it('устаревший черновик не получает новую версию молча', async () => {
    stale = true; open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Изменить' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Название этапа'), { target: { value: 'Мой черновик' } }); fireEvent.submit(form)
    await screen.findByRole('alert'); expect((within(form).getByLabelText('Название этапа') as HTMLInputElement).value).toBe('Мой черновик')
    expect(writes[0].body.version).toBe(3)
    expect(screen.getByRole('alert').textContent).toContain('Черновик сохранён')
  })
  it('отмена объясняет отсутствие возврата и отправляет только отмену', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отменить этап' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' }); expect(form.textContent).toContain('не возвращает деньги'); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toEqual({ version: 3, cancelled: true, reason: '' })
  })
  it('период и просрочки фильтруются сервером', async () => {
    open(); const form = await screen.findByRole('form', { name: 'Период платежей' })
    fireEvent.change(within(form).getByLabelText('С даты'), { target: { value: '2027-04-01' } })
    fireEvent.click(within(form).getByLabelText('Добавить просроченные')); fireEvent.submit(form)
    await waitFor(() => expect(reads.some(p => p.includes('from=2027-04-01') && p.includes('includeOverdue=false'))).toBe(true))
  })
})
