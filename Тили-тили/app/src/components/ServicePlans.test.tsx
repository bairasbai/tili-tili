import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ServicePlans } from './ServicePlans'

const link = 'https://www.sberbank.com/sms/pbpn?requisiteNumber=79990000000'
const fakeJpeg = '/9gg/9k='

function openPlans(vendor: boolean, data: object) {
  const fetch = vi.fn().mockResolvedValue(Response.json(data))
  vi.stubGlobal('fetch', fetch)
  const { container } = render(<MemoryRouter>
    <ServicePlans vendor={vendor} targetId={null} assertOrigin={() => {}} />
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

describe('Temporary Sber QR on service plans', () => {
  it.each([false, true])('shows the configured link and JPEG for vendor=%s', async vendor => {
    const request = openPlans(vendor, { plans: [], manualTransfer: { url: link, qrJpegBase64: fakeJpeg } })
    const paymentLink = await screen.findByRole('link', { name: 'Открыть ссылку Сбера' })
    expect(paymentLink.getAttribute('href')).toBe(link)
    expect(paymentLink.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.getByRole('img', { name: 'QR для перевода в Сбере' }).getAttribute('src')).toBe('data:image/jpeg;base64,' + fakeJpeg)
    expect(screen.getByText('Перевод по этой ссылке не подтверждает заказ и не открывает доступ к тарифу автоматически.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Перейти к оплате' })).toBeNull()
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('hides the transfer block when disabled', async () => {
    openPlans(false, { plans: [] })
    await screen.findByText('Тарифы пока недоступны.')
    expect(screen.queryByRole('link', { name: 'Открыть ссылку Сбера' })).toBeNull()
  })
})
