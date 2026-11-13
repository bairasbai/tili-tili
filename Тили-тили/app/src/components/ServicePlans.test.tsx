// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { ServicePlans } from './ServicePlans'
import { api, ApiError } from '@/lib/api/client'
import type { components } from '@/lib/api/schema'

const plan = {
  id: 'test', audience: 'couple', title: 'Условия пары',
  price: { amount: 12500, currency: 'RUB' }, periodDays: 30, limits: ['Лимит из каталога'],
  expiryTerms: 'Чтение', refundTerms: 'Условия возврата из каталога',
} satisfies components['schemas']['ServicePlan']

function openCatalog(vendor = false) {
  render(<MemoryRouter><ServicePlans vendor={vendor} assertOrigin={() => {}} /></MemoryRouter>)
  fireEvent.click(screen.getByText('Тарифы сервиса'))
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it('hides previous terms offline and waits for a new response after reconnect', async () => {
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  let finish!: (value: { plans: typeof plan[] }) => void
  const pending = new Promise<{ plans: typeof plan[] }>(resolve => { finish = resolve })
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ plans: [plan] }).mockReturnValueOnce(pending)
  openCatalog()
  await screen.findByText(plan.title)

  online.mockReturnValue(false)
  fireEvent(window, new Event('offline'))
  expect(screen.queryByText(plan.title)).toBeNull()
  expect(screen.getByText('Нет связи с сервером')).toBeTruthy()
  expect(get).toHaveBeenCalledTimes(1)

  online.mockReturnValue(true)
  fireEvent(window, new Event('online'))
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  expect(screen.queryByText(plan.title)).toBeNull()
  expect(screen.queryByText('Тарифы пока недоступны.')).toBeNull()
  await act(async () => finish({ plans: [] }))
  await screen.findByText('Тарифы пока недоступны.')
})

it('shows the access refusal returned by the server', async () => {
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  const message = 'Подтвердите согласие на обработку данных'
  vi.spyOn(api, 'get').mockRejectedValue(new ApiError('http', 403, 'consent_required', message))
  openCatalog(true)
  await screen.findByText(message)
  expect(screen.queryByText('Тарифы пока недоступны.')).toBeNull()
})
