import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderPricePreview } from '@/components/OrderPricePreview'
import { previewOrderPriceChange, publishOrderPriceAmendment } from './api/orders'
import type { PriceBreakdown } from './offerPriceComponents'

vi.mock('./api/orders', () => ({
  previewOrderPriceChange: vi.fn(),
  publishOrderPriceAmendment: vi.fn(),
  beginOrderAction: (assertMounted: () => void) => ({ assertCurrent: assertMounted, close: () => undefined }),
}))

const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const before: PriceBreakdown = {
  quotedPrice: money(100000), knownTotal: money(131263), unknownKinds: ['transfer'],
  components: [{ kind: 'overtime', status: 'separate', amount: money(31263),
    formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } }],
}

describe('предпросмотр изменения цены', () => {
  beforeEach(() => { vi.mocked(previewOrderPriceChange).mockReset(); vi.mocked(publishOrderPriceAmendment).mockReset() })
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

  it('публикует показанную цену по точным версиям договора и открывает редакцию', async () => {
    const onPublished = vi.fn()
    const agreementId = '87da359b-a3bb-4dfa-a2fb-e907bf016419'
    const proposedId = '704ff2fb-f982-4b9b-96bc-99a0925ab8f9'
    const selected = {
      id: proposedId, version: '2', sourceOrderVersion: '1', sourceFingerprint: 'a'.repeat(64), digest: 'a'.repeat(64),
      snapshot: {}, publishedBy: null, publishedSide: 'performer' as const, publishedAt: '2026-11-12T12:00:00Z',
      freshness: 'current' as const, receipts: [], acceptedByCaller: false,
    }
    vi.mocked(previewOrderPriceChange).mockResolvedValue({
      current: before, proposed: { ...before, knownTotal: money(118758) }, difference: money(-12505),
      amendment: { agreementId, orderVersion: '1', termsRevision: '1', currentPrice: money(100000), proposedPrice: money(87495) },
    })
    vi.mocked(publishOrderPriceAmendment).mockResolvedValue({
      revision: '2', proposedTermsId: proposedId, agreedTermsId: agreementId,
      history: [selected], selected, readToken: null, acceptedByCaller: false,
    })
    const { container } = render(<OrderPricePreview dealId="deal" breakdown={before} onPublished={onPublished} />)
    container.querySelector('details')!.open = true
    fireEvent.change(screen.getByRole('textbox', { name: 'Новое количество для «Сверхурочные»' }), { target: { value: '1,5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать разницу' }))
    const publish = await screen.findByRole('button', { name: 'Предложить новую цену' })
    expect(screen.getByText('Предлагаемая цена договора')).not.toBeNull()
    fireEvent.click(publish)
    await screen.findByRole('link', { name: 'Финансовая поправка опубликована. Откройте условия для согласования.' })
    expect(publishOrderPriceAmendment).toHaveBeenCalledWith('deal', {
      expectedAgreementId: agreementId, expectedOrderVersion: '1', expectedTermsRevision: '1', expectedAmount: 87495,
      changes: [{ kind: 'overtime', quantity: '1.5' }],
    }, expect.any(String), { assertCurrent: expect.any(Function) })
    expect(onPublished).toHaveBeenCalledWith(proposedId)
  })
})
