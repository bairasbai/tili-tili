import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderPricePreview } from '@/components/OrderPricePreview'
import { previewOrderPriceChange } from './api/orders'
import type { PriceBreakdown } from './offerPriceComponents'

vi.mock('./api/orders', () => ({
  previewOrderPriceChange: vi.fn(),
  beginOrderAction: (assertMounted: () => void) => ({ assertCurrent: assertMounted, close: () => undefined }),
}))

const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const before: PriceBreakdown = {
  quotedPrice: money(100000), knownTotal: money(131263), unknownKinds: ['transfer'],
  components: [{ kind: 'overtime', status: 'separate', amount: money(31263),
    formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } }],
}

describe('предпросмотр изменения цены', () => {
  beforeEach(() => vi.mocked(previewOrderPriceChange).mockReset())
  afterEach(cleanup)

  it('отправляет количество, показывает разницу и сбрасывает расчёт при правке', async () => {
    vi.mocked(previewOrderPriceChange).mockResolvedValue({
      current: before,
      proposed: { ...before, knownTotal: money(118758),
        components: [{ kind: 'overtime', status: 'separate', amount: money(18758),
          formula: { unit: 'hour', quantity: '1.5', rate: money(12505) } }] },
      difference: money(-12505),
    })
    const { container } = render(<OrderPricePreview dealId="deal" breakdown={before} />)
    container.querySelector('details')!.open = true
    const input = screen.getByRole('textbox', { name: 'Новое количество для «Сверхурочные»' })
    const button = screen.getByRole('button', { name: 'Рассчитать разницу' })
    fireEvent.change(input, { target: { value: '1,5' } })
    fireEvent.click(button)
    expect(previewOrderPriceChange).toHaveBeenCalledWith('deal', {
      changes: [{ kind: 'overtime', quantity: '1.5' }],
    }, { assertCurrent: expect.any(Function) })
    await screen.findByText('−125,05 ₽')
    expect(screen.getByText('Неуточнённые доплаты могут увеличить итоговую сумму.')).not.toBeNull()
    fireEvent.change(input, { target: { value: '1,5001' } })
    expect(screen.queryByText('−125,05 ₽')).toBeNull()
    fireEvent.click(button)
    expect(screen.getByRole('alert').textContent).toMatch('Проверьте новое количество')
    expect(previewOrderPriceChange).toHaveBeenCalledTimes(1)
  })

  it('объясняет, почему для старой брони нельзя вычислить разницу', () => {
    const { container } = render(<OrderPricePreview dealId="old-deal" />)
    container.querySelector('details')!.open = true
    expect(screen.getByText('В принятом предложении нет расчётных доплат')).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Рассчитать разницу' })).toBeNull()
    expect(previewOrderPriceChange).not.toHaveBeenCalled()
  })
})
