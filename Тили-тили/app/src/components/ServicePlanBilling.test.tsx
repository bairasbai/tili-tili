import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServicePlans } from './ServicePlans'
import { ManualServiceReview } from './ManualServiceReview'

const link = 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000'
const fakeJpeg = '/9gg/9k='
const targetId = '8150f76a-1297-4edc-91da-a88f23d11125'
const orderId = '98b0f399-423f-42a0-9e9e-41bb01060d55'

function openPlans(vendor: boolean, data: object, order?: object, plans: object[] = []) {
  const fetch = vi.fn(async (input: string) => {
    if (input.endsWith('/users/me/service-plans')) return Response.json({ plans })
    if (input.includes('/report-transfer')) return Response.json(order)
    if (input.includes('/manual/')) return Response.json({ active: false, orders: order ? [order] : [] })
    return Response.json(data)
  })
  vi.stubGlobal('fetch', fetch)
  const { container } = render(<MemoryRouter>
    <ServicePlans vendor={vendor} targetId={targetId} assertOrigin={() => {}} />
  </MemoryRouter>)
  const details = container.querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  return fetch
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Manual payment review', () => {
  it.each([false, true])('confirms a delivered receipt with copy preference %s', async saveReceiptCopy => {
    const receipt = 'https://lknpd.nalog.ru/api/v1/receipt/123456789012/test-copy/print'
    const order = { id: orderId, code: 'wedding', amount: 29900, state: 'pending',
      manual: { saveReceiptCopy, submittedAt: '2026-11-20T10:00:00Z', receiptUrl: null } }
    let confirmed = false
    const fetch = vi.fn(async (...call: [input: string, options?: RequestInit]) => {
      if (call[0].endsWith('/confirm')) {
        confirmed = true
        return Response.json({ order: { ...order, state: 'paid' } })
      }
      const focused = new URL(call[0], 'https://example.invalid').searchParams.get('orderId')
      const projected = confirmed ? { ...order, state: 'paid' } : order
      return Response.json({ reviews: focused === orderId
        ? [{ order: projected, receiptEmail: 'buyer@example.invalid', receiptInn: null }] : [] })
    })
    vi.stubGlobal('fetch', fetch)
    render(<MemoryRouter initialEntries={['/admin/service-plans?manualOrder=' + orderId]}>
      <ManualServiceReview assertOrigin={() => {}} />
    </MemoryRouter>)
    const confirm = await screen.findByRole('button', { name: 'Подтвердить оплату и открыть доступ' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Полученная сумма в рублях'), { target: { value: '299' } })
    fireEvent.change(screen.getByLabelText('Номер операции в Сбере'), { target: { value: 'TEST123' } })
    fireEvent.change(screen.getByLabelText('Дата и время поступления по времени устройства'), {
      target: { value: '2026-11-20T12:00' },
    })
    const receiptInput = screen.queryByLabelText('Ссылка на выданный чек из «Моего налога»')
    if (saveReceiptCopy) {
      expect(receiptInput).not.toBeNull()
      fireEvent.change(receiptInput!, { target: { value: receipt } })
    } else {
      expect(receiptInput).toBeNull()
    }
    fireEvent.click(screen.getByRole('checkbox', { name: 'Чек выдан клиенту' }))
    fireEvent.click(confirm)
    await waitFor(() => expect(fetch.mock.calls.some(([input]) => input.endsWith('/confirm'))).toBe(true))
    const request = fetch.mock.calls.find(([input]) => input.endsWith('/confirm'))?.[1]
    expect(JSON.parse(String(request?.body))).toMatchObject({ amount: 29900, receiptDelivered: true })
    expect(JSON.parse(String(request?.body)).receiptUrl).toBe(saveReceiptCopy ? receipt : undefined)
    await screen.findByText(/Оплата подтверждена/)
  })
})

describe('Temporary Sber QR on service plans', () => {
  it.each([false, true])('shows the configured link and JPEG for vendor=%s', async vendor => {
    const code = vendor ? 'vendor_month' : 'wedding'
    openPlans(vendor, {
      plans: [{ code, price: { amount: 29900 }, checkoutAvailable: true }],
      manualCheckoutAvailable: true,
    }, { id: orderId, code, amount: 29900, state: 'pending',
      manual: { saveReceiptCopy: false, submittedAt: null, transfer: { url: link, qrJpegBase64: fakeJpeg } } })
    const paymentLink = await screen.findByRole('link', { name: 'Открыть ссылку Сбера' })
    expect(paymentLink.getAttribute('href')).toBe(link)
    expect(paymentLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('img', { name: 'QR для перевода в Сбере' }).getAttribute('src')).toBe('data:image/jpeg;base64,' + fakeJpeg)
    expect(screen.getByText(orderId, { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Я оплатил' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Перейти к оплате' })).toBeNull()
  })
  it('offers the receipt preference before showing the bank link', async () => {
    openPlans(false, {
      plans: [{ code: 'wedding', price: { amount: 29900 }, checkoutAvailable: true,
        checkoutTerms: { text: 'Чек будет отправлен на почту' } }],
      manualCheckoutAvailable: true,
    })
    const preference = await screen.findByRole('checkbox', { name: 'Сохранить копию чека в «Тили-тили»' })
    expect((preference as HTMLInputElement).checked).toBe(false)
    fireEvent.click(preference)
    expect((preference as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByRole('link', { name: 'Открыть ссылку Сбера' })).toBeNull()
  })
  it('hides the transfer block when disabled', async () => {
    openPlans(false, { plans: [] })
    await screen.findByText('Тарифы пока недоступны.')
    expect(screen.queryByRole('link', { name: 'Открыть ссылку Сбера' })).toBeNull()
  })
})

it.each([false, true])('preserves configured informational plans with checkout availability %s', async checkoutAvailable => {
  const informational = ['Условия первой свадьбы', 'Условия второй свадьбы'].map((title, index) => ({
    id: 'info-' + index, audience: 'couple', title, price: { amount: 12500, currency: 'RUB' },
    periodDays: 30, limits: ['Тестовый лимит'], expiryTerms: 'Чтение', refundTerms: 'Порядок возврата',
  }))
  openPlans(false, { plans: [{ code: 'wedding', price: { amount: 29900 }, checkoutAvailable }],
    manualCheckoutAvailable: checkoutAvailable }, undefined, informational)
  for (const plan of informational) await screen.findByRole('heading', { name: plan.title })
  expect(screen.getAllByText('Порядок возврата')).toHaveLength(2)
  if (checkoutAvailable) {
    expect(await screen.findByText('299 ₽')).toBeTruthy()
    expect(screen.queryByText('Оплата тарифов пока недоступна.')).toBeNull()
  } else {
    expect(screen.getByText('Оплата тарифов пока недоступна.')).toBeTruthy()
    expect(screen.queryByText('299 ₽')).toBeNull()
  }
})

it('keeps a pending manual order accessible while its commercial offer is unavailable', async () => {
  openPlans(false, { plans: [{ code: 'wedding', price: { amount: 29900 }, checkoutAvailable: false }] },
    { id: orderId, code: 'wedding', amount: 29900, state: 'pending',
    manual: { saveReceiptCopy: true, submittedAt: '2026-11-20T10:00:00Z' } })
  expect(await screen.findByText('Проверяем перевод')).toBeTruthy()
  expect(screen.queryByRole('checkbox', { name: 'Сохранить копию чека в «Тили-тили»' })).toBeNull()
})
