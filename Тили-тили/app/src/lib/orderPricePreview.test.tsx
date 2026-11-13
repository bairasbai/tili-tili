import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrderPricePreview } from '@/components/OrderPricePreview'
import { getOrder, previewOrderPriceChange, publishOrderPriceAmendment } from './api/orders'
import { ApiError } from './api/client'
import type { PriceBreakdown } from './offerPriceComponents'

vi.mock('./api/orders', () => ({
  previewOrderPriceChange: vi.fn(),
  publishOrderPriceAmendment: vi.fn(),
  getOrder: vi.fn(),
  beginOrderAction: (assertMounted: () => void) => ({ assertCurrent: assertMounted, close: () => undefined }),
}))

const money = (amount: number) => ({ amount, currency: 'RUB' as const })
const before: PriceBreakdown = {
  quotedPrice: money(100000), knownTotal: money(131263), unknownKinds: ['transfer'],
  components: [{ kind: 'overtime', status: 'separate', amount: money(31263),
    formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } }],
}

describe('предпросмотр изменения цены', () => {
  beforeEach(() => { vi.mocked(previewOrderPriceChange).mockReset(); vi.mocked(publishOrderPriceAmendment).mockReset(); vi.mocked(getOrder).mockReset() })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })

  it('SC-017/018 скрывает прежнюю цену и заново проверяет права без автоматического расчёта', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    const onPublished = vi.fn()
    const quote = { current: before, proposed: before, difference: money(100),
      amendment: { agreementId: 'agreement', orderVersion: '1', termsRevision: '1', currentPrice: money(100000), proposedPrice: money(100100) } }
    vi.mocked(previewOrderPriceChange).mockResolvedValue(quote)
    vi.mocked(getOrder).mockResolvedValue({ dealId: 'deal', version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [] })
    render(<OrderPricePreview dealId="deal" breakdown={before} onPublished={onPublished} />)
    fireEvent.click(screen.getByText('Предпросмотр изменения цены'))
    const inputName = 'Новое количество для «Сверхурочные»'
    fireEvent.change(screen.getByRole('textbox', { name: inputName }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать разницу' }))
    const propose = await screen.findByRole('button', { name: 'Предложить новую цену' })
    online.mockReturnValue(false)
    fireEvent(window, new Event('offline'))
    expect(screen.getByText('Нет связи с сервером')).toBeTruthy()
    expect(screen.queryByText('Предлагаемая цена договора')).toBeNull()
    fireEvent.click(propose)
    expect(publishOrderPriceAmendment).not.toHaveBeenCalled()
    online.mockReturnValue(true)
    fireEvent(window, new Event('online'))
    await screen.findByRole('button', { name: 'Рассчитать разницу' })
    expect(screen.getByRole('textbox', { name: inputName })).toHaveProperty('value', '3')
    expect(screen.queryByRole('button', { name: 'Предложить новую цену' })).toBeNull()
    expect(previewOrderPriceChange).toHaveBeenCalledTimes(1)
    vi.mocked(getOrder).mockRejectedValue(new ApiError('http', 404, 'not_found', 'Заказ не найден'))
    await act(async () => fireEvent.focus(window))
    expect(await screen.findByText('Заказ не найден')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: inputName })).toBeNull()
  })

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

  it('после потери ответа вручную повторяет те же данные и ключ и открывает сохранённую редакцию', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
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
    vi.mocked(getOrder).mockResolvedValue({ dealId: 'deal', version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [] })
    vi.mocked(publishOrderPriceAmendment).mockRejectedValueOnce(new ApiError('network', 0, 'network', 'Нет связи')).mockResolvedValueOnce({
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
    await screen.findByRole('button', { name: 'Проверить результат запроса' })
    expect(screen.queryByRole('button', { name: 'Предложить новую цену' })).toBeNull()
    expect(screen.getByRole('textbox').closest('fieldset')).toHaveProperty('disabled', true)
    expect(publishOrderPriceAmendment).toHaveBeenCalledWith('deal', {
      expectedAgreementId: agreementId, expectedOrderVersion: '1', expectedTermsRevision: '1', expectedAmount: 87495,
      changes: [{ kind: 'overtime', quantity: '1.5' }],
    }, expect.any(String), { assertCurrent: expect.any(Function) })
    online.mockReturnValue(false)
    fireEvent(window, new Event('offline'))
    expect(screen.queryByRole('button', { name: 'Проверить результат запроса' })).toBeNull()
    online.mockReturnValue(true)
    fireEvent(window, new Event('online'))
    const retry = await screen.findByRole('button', { name: 'Проверить результат запроса' })
    expect(getOrder).toHaveBeenCalledTimes(1)
    expect(publishOrderPriceAmendment).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    await screen.findByRole('link', { name: 'Финансовая поправка опубликована. Откройте условия для согласования.' })
    expect(vi.mocked(publishOrderPriceAmendment).mock.calls[1]?.slice(0, 3))
      .toEqual(vi.mocked(publishOrderPriceAmendment).mock.calls[0]?.slice(0, 3))
    expect(onPublished).toHaveBeenCalledWith(proposedId)
  })

  it('скрывает черновик после неудачной проверки и возвращает его после явного повтора', async () => {
    vi.mocked(getOrder)
      .mockRejectedValueOnce(new ApiError('http', 503, 'unavailable', 'Временно недоступно'))
      .mockResolvedValueOnce({ dealId: 'deal', version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [] })
    render(<OrderPricePreview dealId="deal" breakdown={before} />)
    fireEvent.click(screen.getByText('Предпросмотр изменения цены'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '3' } })
    await act(async () => fireEvent.focus(window))
    const retry = await screen.findByRole('button', { name: 'Повторить' })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(retry)
    expect(await screen.findByRole('textbox')).toHaveProperty('value', '3')
    expect(previewOrderPriceChange).not.toHaveBeenCalled()
  })

  it('отбрасывает запоздалый расчёт после начала новой проверки доступа', async () => {
    let resolvePreview!: (value: Awaited<ReturnType<typeof previewOrderPriceChange>>) => void
    let resolveOrder!: (value: Awaited<ReturnType<typeof getOrder>>) => void
    vi.mocked(previewOrderPriceChange).mockReturnValue(new Promise(resolve => { resolvePreview = resolve }))
    vi.mocked(getOrder).mockReturnValue(new Promise(resolve => { resolveOrder = resolve }))
    render(<OrderPricePreview dealId="deal" breakdown={before} />)
    fireEvent.click(screen.getByText('Предпросмотр изменения цены'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Рассчитать разницу' }))
    fireEvent.focus(window)
    expect(screen.getByText('Проверяем доступ к заказу…')).toBeTruthy()
    expect(getOrder).not.toHaveBeenCalled()
    await act(async () => resolvePreview({ current: before, proposed: before, difference: money(100) }))
    await waitFor(() => expect(getOrder).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Известная оценка с изменениями')).toBeNull()
    await act(async () => resolveOrder({ dealId: 'deal', version: '1', schemaVersion: 1, source: 'legacy', brief: null, assignments: [], parts: [] }))
    expect(screen.getByRole('textbox')).toHaveProperty('value', '3')
    expect(screen.queryByText('Известная оценка с изменениями')).toBeNull()
  })
})
