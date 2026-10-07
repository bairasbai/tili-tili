import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { VendorAnalytics, VendorDealCard } from '@/pages/VendorExtras'
import { VendorDeals } from '@/pages/VendorApp'
import { setI18nLang } from './i18n'

vi.mock('@/lib/store', () => ({ useStore: () => ({ weddingId: null }) }))
const money = (amount: number) => ({ amount, currency: 'RUB' })
const receipt = { id: 'r1', filename: 'чек.png', mimeType: 'image/png', sizeBytes: 8, createdAt: '2026-09-29T12:00:00Z' }
const payment = { id: 'p1', dealId: 'd1', kind: 'deposit', amount: money(250000), amountKnown: true,
  paymentMethod: 'cash', visibility: 'vendor', paidOn: '2026-09-29', status: 'recorded',
  createdAt: '2026-09-29T12:00:00Z', installmentId: null, version: 1, receipts: [receipt] }
let reads: string[]
let history: object[]
let incomplete: boolean
let historyStatus: number, receiptStatus: number
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
})
const dealPage = () => render(<MemoryRouter initialEntries={['/vendor-app/deals/d1']}>
  <Routes><Route path="/vendor-app/deals/:id" element={<VendorDealCard />} /></Routes>
</MemoryRouter>)

beforeEach(() => {
  setI18nLang('ru'); reads = []; incomplete = true; historyStatus = receiptStatus = 200
  history = [payment, { ...payment, id: 'p2', amount: null, amountKnown: false, paymentMethod: 'bank_transfer', receipts: [] }]
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).replace(/^\/api/, ''); reads.push(path)
    if (path.startsWith('/vendor/analytics')) return json({ period: 'season', revenue: money(0),
      revenueIncomplete: incomplete, revenueDeltaPct: 25, funnel: { views: 0, contacts: 0, leads: 0, deals: 1 } })
    if (path === '/vendor/deals') return json({ expected: money(750000), shortfall: money(0), amountIncomplete: incomplete,
      items: [{ id: 'd1', coupleName: 'Пара проверки', weddingDate: null, state: 'paid_deposit', price: money(1000000),
        paid: money(250000), unknownAmountPayments: incomplete ? 1 : 0 }] })
    if (path === '/deals/d1/events') return json([])
    if (path === '/vendor/deals/d1/payments') return historyStatus === 200 ? json(history)
      : json({ error: { code: 'db_unavailable', message: 'База недоступна' } }, historyStatus)
    if (path === '/vendor/deals/d1/payments/p1/receipts/r1/content') return receiptStatus === 200
      ? json({ filename: receipt.filename, mimeType: receipt.mimeType, contentBase64: 'iVBORw0KGgo=' })
      : json({ error: { code: 'not_found', message: 'Файл не найден' } }, receiptStatus)
    throw new Error('Unexpected API path: ' + path)
  }))
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe.each(['ru', 'en'] as const)('FR012: обозначения оплаты у подрядчика (%s)', lang => {
  const labels = [
    ['recorded', 'deposit', 'Оплата отмечена', 'Payment recorded'],
    ['confirmed', 'deposit', 'Оплата отмечена · проверка провайдером не установлена', 'Payment recorded · provider verification not established'],
    ['recorded', 'refund', 'Возврат отмечен', 'Refund recorded'],
    ['confirmed', 'refund', 'Возврат отмечен · проверка провайдером не установлена', 'Refund recorded · provider verification not established'],
    ['cancelled', 'deposit', 'Отметка отменена', 'Record cancelled'],
    ['cancelled', 'refund', 'Отметка отменена', 'Record cancelled'],
  ] as const
  it.each(labels)('различает %s/%s без выдуманной провайдерской проверки', async (status, kind, ru, en) => {
    setI18nLang(lang)
    history = [{ ...payment, status, kind, ...{ provider_ref: 'untrusted-legacy-reference' } }]
    dealPage()
    await screen.findByText(lang === 'ru' ? ru : en)
    expect(screen.queryByText('Оплата подтверждена')).toBeNull()
    expect(screen.queryByText('Payment confirmed')).toBeNull()
  })
  it('доступный документ явно отделён от проверки банковской операции', async () => {
    setI18nLang(lang); history = [payment]; dealPage()
    await screen.findByText(lang === 'ru' ? 'Приложенные документы' : 'Attached documents')
    expect(screen.getByText(lang === 'ru'
      ? 'Файл приложен пользователем. Приложение не сверяет его с банковской операцией.'
      : 'This file was attached by a user. The app does not match it to a bank transaction.')).toBeTruthy()
    expect(screen.getByRole('button', { name: lang === 'ru' ? 'Скачать чек.png' : 'Download чек.png' })).toBeTruthy()
  })
})

describe('021: финансовые данные в кабинете подрядчика', () => {
  it('помечает неполный доход, включая нулевую известную сумму, и скрывает процент', async () => {
    render(<MemoryRouter><VendorAnalytics /></MemoryRouter>)
    await screen.findByText('Доход по известным суммам')
    expect(screen.getByText('Есть оплаты с неизвестной суммой')).toBeTruthy()
    expect(screen.getByText('Показаны только платежи, которыми пара поделилась с вами.')).toBeTruthy()
    expect(screen.queryByText('25%')).toBeNull()
  })

  it('сохраняет доход и процент при полных суммах', async () => {
    incomplete = false
    render(<MemoryRouter><VendorAnalytics /></MemoryRouter>)
    await screen.findByText('Доход')
    expect(screen.getByText('+25%')).toBeTruthy()
    expect(screen.queryByText('Есть оплаты с неизвестной суммой')).toBeNull()
  })

  it('предупреждает о неполноте итогов и конкретной сделки в списке', async () => {
    render(<MemoryRouter><VendorDeals /></MemoryRouter>)
    await screen.findByText('Пара проверки')
    expect(screen.getByText('Есть оплаты с неизвестной суммой. Итоги рассчитаны только по известным суммам.')).toBeTruthy()
    expect(screen.getByText('Есть оплаты с неизвестной суммой')).toBeTruthy()
  })

  it('читает историю своей сделки и показывает дату, способ, неизвестную сумму и отмену', async () => {
    history.push({ ...payment, id: 'p3', kind: 'refund', status: 'cancelled', paymentMethod: 'card', receipts: [] })
    dealPage()
    await screen.findByText('История платежей')
    await screen.findByText('Сумма не сохранена')
    expect(reads).toContain('/vendor/deals/d1/payments')
    expect(screen.getByText('Известные оплаты')).toBeTruthy()
    expect(screen.getByText('Числовой остаток их не учитывает.')).toBeTruthy()
    expect(screen.getByText(/29 сентября 2026.*Наличные/)).toBeTruthy()
    expect(screen.getByText(/Банковский перевод/)).toBeTruthy()
    expect(screen.getByText('Отметка отменена')).toBeTruthy()
    expect(screen.getByText('Возврат')).toBeTruthy()
  })

  it('скачивает подтверждение через vendor-scoped endpoint с данными файла сервера', async () => {
    const create = vi.fn<(blob: Blob) => string>(() => 'blob:vendor-receipt'), revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL { static createObjectURL = create; static revokeObjectURL = revoke })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('чек.png')
      expect(this.isConnected).toBe(true)
    })
    dealPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Скачать чек.png' }))
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
    expect(reads).toContain('/vendor/deals/d1/payments/p1/receipts/r1/content')
    expect(create.mock.calls[0][0]).toMatchObject({ type: 'image/png', size: 8 })
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:vendor-receipt'), { timeout: 2000 })
  })

  it('показывает отказ скачивания и позволяет повторить запрос', async () => {
    receiptStatus = 404
    dealPage()
    const button = await screen.findByRole('button', { name: 'Скачать чек.png' })
    fireEvent.click(button)
    await screen.findByText('Файл не найден')
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(reads.filter(x => x.endsWith('/receipts/r1/content'))).toHaveLength(2))
  })

  it('различает отказ истории и пустой ответ, повтор запрашивает свежие данные', async () => {
    historyStatus = 503; history = []
    dealPage()
    await screen.findByText('Сервер недоступен. Попробуйте позже')
    expect(screen.queryByText('Пара пока не поделилась платежами')).toBeNull()
    historyStatus = 200
    fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
    await screen.findByText('Пара пока не поделилась платежами')
    expect(reads.filter(x => x === '/vendor/deals/d1/payments')).toHaveLength(2)
  })

  it('переводит новые предупреждения и историю на английский', async () => {
    setI18nLang('en')
    dealPage()
    await screen.findByText('Payment history')
    await screen.findByText('Amount not stored')
    expect(screen.getByText('Known payments')).toBeTruthy()
    expect(screen.getByText('There are payments with an unknown amount')).toBeTruthy()
    expect(screen.getByText('Only payments the couple shared with you are shown.')).toBeTruthy()
  })
})
