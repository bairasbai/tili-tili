import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import PaymentSchedule from '@/pages/PaymentSchedule'
import type { PaymentScheduleData } from './api/paymentSchedule'
import { setI18nLang } from './i18n'
vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: 'w1' }) }))
const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const stage = { id: 'i1', dealId: 'd1', title: 'Аванс', amount: money(400000), paid: money(0), allocated: money(0), remaining: money(400000), due: '2027-05-01', version: 3, status: 'pending' as const, overdue: false, cancelReason: null, cancelledAt: null, unknownAmountPayments: 0 }
let state: PaymentScheduleData
let status = 200, failSave = false, stale = false
let writes: { path: string; body: Record<string, unknown>; key: string | null }[]
let reads: string[]
let receipts: { id: string; filename: string; mimeType: string; sizeBytes: number; createdAt: string }[]
let release: (() => void) | null = null
let delayWrite = false
let uploadEnabled = true
/* Ответ на загрузку чека: ok — 201; network — обрыв без ответа; поле — 422 с причиной сервера. */
let receiptPost: 'ok' | 'network' | 'field' = 'ok'
let receiptDelete: 204 | 404 = 204
const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json' } })
function serve() {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api/, '')
    if (!init?.method || init.method === 'GET') {
      reads.push(path)
      if (path.endsWith('/payments/p1/receipts')) return json({ items: receipts, uploadEnabled })
      if (path.includes('/payments/p1/receipts/') && path.endsWith('/content')) return json({ filename: 'чек.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgo=' })
      return status === 200 ? json(state) : json({ error: { code: status === 403 ? 'forbidden' : 'db_unavailable', message: 'Нет доступа или сервер недоступен' } }, status)
    }
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    writes.push({ path, body, key: new Headers(init.headers).get('Idempotency-Key') })
    if (path.includes('/payments/p1/receipts/') && init.method === 'DELETE') {
      if (receiptDelete === 404) return json({ error: { code: 'not_found', message: 'Файл не найден' } }, 404)
      receipts = receipts.filter(x => !path.includes(x.id)); return new Response(null, { status: 204 })
    }
    if (path.endsWith('/payments/p1/receipts') && init.method === 'POST') {
      if (receiptPost === 'network') { receiptPost = 'ok'; throw new TypeError('Failed to fetch') }
      if (receiptPost === 'field') return json({ error: { code: 'validation_failed', message: 'Запрос не прошёл проверку', fields: { mimeType: 'Содержимое файла не соответствует указанному типу' } } }, 422)
      receipts.push({ id: 'r' + (receipts.length + 2), filename: String(body.filename), mimeType: String(body.mimeType), sizeBytes: 9, createdAt: '2027-01-01T12:00:00.000Z' }); return json(receipts.at(-1), 201)
    }
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
    summary: { committed: money(1000000), recorded: money(100000), remaining: money(900000), unallocated: money(100000), inactiveDealRecorded: money(0), unknownPrices: 0, unknownAmountPayments: 0, amountIncomplete: false },
    dueInWindow: money(400000), overdueRemaining: money(0), items: [{ ...stage }],
    deals: [{ id: 'd1', slotId: 's1', name: 'Фотограф', state: 'booked', price: money(1000000), recorded: money(100000), remaining: money(900000), planned: money(400000), unallocated: money(100000), needsReview: false, active: true, canPlan: true, unknownAmountPayments: 0 }],
    allInstallments: [{ id: 'i1', dealId: 'd1', title: 'Аванс', status: 'pending', remaining: money(400000), unknownAmountPayments: 0 }],
    payments: [{ id: 'p1', dealId: 'd1', kind: 'deposit', amount: money(100000), amountKnown: true, paymentMethod: 'other', visibility: 'private', paidOn: '2027-01-01', status: 'recorded', createdAt: '2027-01-01T12:00:00.000Z', installmentId: null, version: 2 }] }
  status = 200; failSave = false; stale = false; writes = []; reads = []; receipts = [{ id: 'r1', filename: 'аванс.pdf', mimeType: 'application/pdf', sizeBytes: 1200, createdAt: '2027-01-01T12:00:00.000Z' }]; delayWrite = false; release = null
  uploadEnabled = true; receiptPost = 'ok'; receiptDelete = 204; serve()
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
    fireEvent.click(within(card).getByRole('button', { name: 'Отметить оплату: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Сумма, ₽'), { target: { value: '100' } }); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path: '/weddings/w1/payment-schedule/i1/pay', body: { version: 3, amount: money(10000), amountKnown: true, paymentMethod: 'other', visibility: 'private', paidOn: '2027-01-01' } })
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
    expect(screen.queryByText('Цены активных сделок')).toBeNull()
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
  it('устаревшая версия: данные перечитаны, черновик остаётся, повтор — со свежей версией (ревью 018, F-05)', async () => {
    stale = true; open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Изменить: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Название этапа'), { target: { value: 'Мой черновик' } })
    // Пока пара правила, этап изменили на другом устройстве: сервер отдаст версию 4.
    state.items = [{ ...stage, version: 4 }]
    const readsBefore = reads.length
    fireEvent.submit(form)
    await screen.findByRole('alert'); expect((within(form).getByLabelText('Название этапа') as HTMLInputElement).value).toBe('Мой черновик')
    expect(writes[0].body.version).toBe(3)
    expect(screen.getByRole('alert').textContent).toContain('данные обновлены')
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore))
    // Прежде повтор снова уходил с версией 3 и получал 409 по кругу.
    stale = false; fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].body).toMatchObject({ version: 4, title: 'Мой черновик' })
  })
  it('отмена объясняет отсутствие возврата и отправляет только отмену', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отменить этап: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' }); expect(form.textContent).toContain('не возвращает деньги'); fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    // Пустая причина не уходит: в базе ей место — null, а не '' (ревью 018, F-13).
    expect(writes[0].body).toEqual({ version: 3, cancelled: true })
  })
  it('период проверяется до запроса и не прячет экран (ревью 018, F-02)', async () => {
    open(); const form = await screen.findByRole('form', { name: 'Период платежей' })
    const readsBefore = reads.length
    fireEvent.change(within(form).getByLabelText('С даты'), { target: { value: '2027-06-01' } })
    fireEvent.change(within(form).getByLabelText('По дату'), { target: { value: '2027-05-01' } }); fireEvent.submit(form)
    expect((await within(form).findByRole('alert')).textContent).toBe('Начало периода позже конца')
    fireEvent.change(within(form).getByLabelText('С даты'), { target: { value: '2027-01-01' } })
    fireEvent.change(within(form).getByLabelText('По дату'), { target: { value: '2028-01-02' } }); fireEvent.submit(form)
    expect(within(form).getByRole('alert').textContent).toBe('Выберите период не длиннее 366 дней')
    expect(reads.length).toBe(readsBefore)
    expect(screen.getByRole('form', { name: 'Период платежей' })).toBeTruthy()
  })
  it('отказ сервера по периоду оставляет выход — «Сбросить период» (ревью 018, F-02)', async () => {
    open(); const form = await screen.findByRole('form', { name: 'Период платежей' })
    status = 422
    fireEvent.change(within(form).getByLabelText('С даты'), { target: { value: '2027-02-01' } }); fireEvent.submit(form)
    const reset = await screen.findByRole('button', { name: 'Сбросить период' })
    status = 200; fireEvent.click(reset)
    await screen.findByRole('form', { name: 'Период платежей' })
    expect(reads.at(-1)).not.toContain('from=')
  })
  it('без изменений «Сохранить» выключен (ревью 018, F-11)', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Изменить: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    expect(within(form).getByRole('button', { name: 'Сохранить' }).hasAttribute('disabled')).toBe(true)
    fireEvent.change(within(form).getByLabelText('Название этапа'), { target: { value: 'Аванс фотографу' } })
    expect(within(form).getByRole('button', { name: 'Сохранить' }).hasAttribute('disabled')).toBe(false)
  })
  it('этап, закрытый оплатой сделки без привязки, — «покрыто», без оплаты (ревью 018, M-01)', async () => {
    state.items = [{ ...stage, status: 'covered', allocated: money(400000), remaining: money(0) }]
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    expect(card.textContent).toContain('Покрыто оплатами сделки')
    expect(card.textContent).toContain('Покрыто отметками без привязки')
    expect(within(card).getByRole('button', { name: 'Отметить оплату: Аванс' }).hasAttribute('disabled')).toBe(true)
  })
  it('история показывает фактическую calendar-date оплаты, а не createdAt', async () => {
    state.payments = [{ ...state.payments[0]!, paidOn: '2027-01-02', createdAt: '2027-01-01T21:30:00.000Z' }]
    open(); fireEvent.click(await screen.findByText(/История оплат/))
    expect(await screen.findByText(/2 января 2027/)).toBeTruthy()
  })

  it('cash/private использует общий endpoint и передаёт метод, видимость и дату', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отметить оплату: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Сумма, ₽'), { target: { value: '300' } })
    fireEvent.change(within(form).getByLabelText('Способ оплаты'), { target: { value: 'cash' } })
    fireEvent.change(within(form).getByLabelText('Дата фактической оплаты'), { target: { value: '2027-06-18' } })
    fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ path:'/weddings/w1/payment-schedule/i1/pay', body:{
      version:3,amount:money(30000),amountKnown:true,paymentMethod:'cash',visibility:'private',paidOn:'2027-06-18',
    }})
  })

  it('неизвестная сумма не отправляется как 0 и показывает предупреждение', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отметить оплату: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.click(within(form).getByLabelText('Сумма не сохранена'))
    expect(within(form).queryByLabelText('Сумма, ₽')).toBeNull()
    expect(within(form).getByRole('status').textContent).toContain('могут быть неполными')
    fireEvent.change(within(form).getByLabelText('Способ оплаты'), { target: { value: 'cash' } })
    fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toMatchObject({version:3,amountKnown:false,paymentMethod:'cash',visibility:'private',paidOn:'2027-01-01'})
    expect(writes[0].body).not.toHaveProperty('amount')
  })

  it('vendor visibility выбирается отдельным radio, не toggle', async () => {
    open(); const card = await screen.findByRole('region', { name: 'Аванс' })
    fireEvent.click(within(card).getByRole('button', { name: 'Отметить оплату: Аванс' }))
    const form = screen.getByRole('form', { name: 'Редактор платежа' })
    fireEvent.change(within(form).getByLabelText('Сумма, ₽'), { target: { value: '100' } })
    fireEvent.click(within(form).getByLabelText('Подрядчик этой сделки'))
    fireEvent.submit(form)
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toMatchObject({visibility:'vendor',amountKnown:true})
  })
  it('период и просрочки фильтруются сервером', async () => {
    open(); const form = await screen.findByRole('form', { name: 'Период платежей' })
    fireEvent.change(within(form).getByLabelText('С даты'), { target: { value: '2027-04-01' } })
    fireEvent.click(within(form).getByLabelText('Добавить просроченные')); fireEvent.submit(form)
    await waitFor(() => expect(reads.some(p => p.includes('from=2027-04-01') && p.includes('includeOverdue=false'))).toBe(true))
  })
  it('показывает приватные подтверждения и удаляет их через scoped API — со второго нажатия (ревью 018, BF-05)', async () => {
    open(); await openReceipts()
    fireEvent.click(await screen.findByRole('button', { name: 'Удалить: аванс.pdf' }))
    expect(writes.filter(x => x.path.includes('/receipts/'))).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Удалить? аванс.pdf' }))
    await waitFor(() => expect(writes.some(x => x.path === '/weddings/w1/payments/p1/receipts/r1')).toBe(true))
    await waitFor(() => expect(screen.queryByText('аванс.pdf')).toBeNull())
  })
  it('не отправляет неподдерживаемый тип подтверждения', async () => {
    open(); await openReceipts()
    choose(new File(['text'], 'note.txt', { type: 'text/plain' }))
    await screen.findByText('Разрешены PDF, JPEG, PNG и WebP')
    expect(writes.filter(x => x.path.endsWith('/receipts'))).toHaveLength(0)
  })
})

/* Ревью 018, 018-B: панель подтверждений оплаты. */
async function openReceipts() {
  const details = (await screen.findByText('Подтверждения оплаты')).closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  await screen.findByText('аванс.pdf')
}
const choose = (file: File) => fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [file] } })
const png = (name = 'чек.png', lastModified = 1) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], name, { type: 'image/png', lastModified })
const uploads = () => writes.filter(x => x.path === '/weddings/w1/payments/p1/receipts')
describe('018-B: подтверждения оплаты в интерфейсе (ревью 018)', () => {
  it('BF-03: список не грузится, пока панель закрыта; раскрытие — один запрос', async () => {
    open(); await screen.findByRole('region', { name: 'Аванс' })
    // Эффекты отрисовки истории — до конца: иначе проверка «запроса нет» прошла бы и при жадной загрузке.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(reads.filter(p => p.includes('/receipts'))).toEqual([])
    await openReceipts()
    expect(reads.filter(p => p.endsWith('/payments/p1/receipts'))).toHaveLength(1)
    expect(screen.getByText(/прикреплено/).textContent).toContain('1')
  })
  it('BB-01: загрузка выключена на сервере — поля файла нет, объяснение есть, удалить можно', async () => {
    uploadEnabled = false; open(); await openReceipts()
    expect(document.querySelector('input[type=file]')).toBeNull()
    screen.getByText(/Загрузка подтверждений пока не включена на сервере/)
    expect((screen.getByRole('button', { name: 'Удалить: аванс.pdf' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('BF-05: в свадьбе «только чтение» удалить и прикрепить нельзя, скачать можно', async () => {
    state.readOnly = true; open(); await openReceipts()
    expect((screen.getByRole('button', { name: 'Удалить: аванс.pdf' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Скачать: аванс.pdf' }) as HTMLButtonElement).disabled).toBe(false)
    expect((document.querySelector('input[type=file]') as HTMLInputElement).disabled).toBe(true)
  })
  it('BF-05: файла уже нет (404) — не ошибка, список перечитан', async () => {
    receiptDelete = 404; open(); await openReceipts()
    fireEvent.click(screen.getByRole('button', { name: 'Удалить: аванс.pdf' }))
    fireEvent.click(screen.getByRole('button', { name: 'Удалить? аванс.pdf' }))
    await waitFor(() => expect(reads.filter(p => p.endsWith('/payments/p1/receipts'))).toHaveLength(2))
    expect(screen.queryByRole('alert')).toBeNull()
  })
  it('BF-01: ключ — на попытку: после обрыва тот же файл идёт с тем же ключом, после успеха — с новым', async () => {
    receiptPost = 'network'; open(); await openReceipts()
    choose(png())
    await screen.findByRole('alert')
    choose(png())
    await waitFor(() => expect(uploads()).toHaveLength(2))
    expect(uploads()[1].key).toBe(uploads()[0].key)
    expect(uploads()[1].body).toEqual({ filename: 'чек.png', mimeType: 'image/png', contentBase64: 'iVBORw0KGgoA' })
    await screen.findByText('чек.png')
    choose(png())
    await waitFor(() => expect(uploads()).toHaveLength(3))
    expect(uploads()[2].key).not.toBe(uploads()[1].key)
  })
  it('BF-06: поле файла сбрасывается после выбора — тот же файл снова даёт событие', async () => {
    open(); await openReceipts()
    const input = document.querySelector('input[type=file]') as HTMLInputElement, cleared: string[] = []
    // jsdom шлёт change на каждый fireEvent; браузер — только при новом значении. Проверяем сам сброс.
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: (v: string) => { cleared.push(v) } })
    choose(png())
    await waitFor(() => expect(uploads()).toHaveLength(1))
    expect(cleared).toEqual([''])
  })
  it('BF-04: пустой файл, больше 512 КБ и имя длиннее 180 символов — отказ до запроса', async () => {
    open(); await openReceipts()
    choose(new File([], 'пусто.png', { type: 'image/png' }))
    await screen.findByText('Файл пустой — выберите другой')
    choose(new File([new Uint8Array(524289)], 'большой.png', { type: 'image/png' }))
    await screen.findByText('Файл должен быть не больше 512 КБ')
    choose(png('я'.repeat(181) + '.png'))
    await screen.findByText('Имя файла длиннее 180 символов — переименуйте файл')
    expect(uploads()).toHaveLength(0)
  })
  it('BF-04: отказ сервера по полю показывает его причину, а не общий текст', async () => {
    receiptPost = 'field'; open(); await openReceipts()
    choose(png())
    await screen.findByText('Содержимое файла не соответствует указанному типу')
  })
  it('BF-07: скачивание — ссылкой в документе, адрес не отзывается сразу после нажатия', async () => {
    const created: Blob[] = [], revoked: string[] = [], clicked: { download: string; connected: boolean }[] = []
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => { created.push(b); return 'blob:receipt' }, revokeObjectURL: (u: string) => { revoked.push(u) } }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicked.push({ download: this.download, connected: this.isConnected }) })
    try {
      open(); await openReceipts()
      fireEvent.click(screen.getByRole('button', { name: 'Скачать: аванс.pdf' }))
      await waitFor(() => expect(clicked).toEqual([{ download: 'чек.png', connected: true }]))
      expect(created[0]!.type).toBe('image/png')
      expect(revoked).toEqual([])
    } finally { click.mockRestore() }
  })
})
