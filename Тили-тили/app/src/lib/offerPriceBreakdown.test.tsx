import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { OfferPriceBreakdownView, OfferPriceEditor } from '@/components/OfferPriceBreakdown'
import { fmt, parsePaymentRubles } from './money'
import { normalizePriceComponentDraft, type PriceBreakdown } from './offerPriceComponents'
import { useState } from 'react'

describe('составляющие цены предложения', () => {
  it('различает точный ноль, неизвестную сумму и переполнение', () => {
    const result = normalizePriceComponentDraft(100000, {
      delivery: { status: 'separate', amount: '125,05' },
      printing: { status: 'separate', amount: '0' },
      packaging: { status: 'separate', amount: '' },
    })
    expect(result).toMatchObject({ ok: true, components: [
      { kind: 'delivery', amount: { amount: 12505 } }, { kind: 'printing', amount: { amount: 0 } },
      { kind: 'packaging', amount: null },
    ] })
    expect(parsePaymentRubles('0')).toBeNull()
    expect(normalizePriceComponentDraft(Number.MAX_SAFE_INTEGER, { delivery: { status: 'separate', amount: '0,01' } }).ok).toBe(false)
    expect(fmt(Number.MAX_SAFE_INTEGER).replace(/[\u00a0\u202f]/g, ' ')).toBe('90 071 992 547 409,91 ₽')
  })

  it('показывает видимую оговорку рядом с известной оценкой и сохраняет статус в редакторе', () => {
    const estimate: PriceBreakdown = {
      quotedPrice: { amount: 100000, currency: 'RUB' }, knownTotal: { amount: 112505, currency: 'RUB' },
      components: [{ kind: 'delivery', status: 'separate', amount: { amount: 12505, currency: 'RUB' } }],
      unknownKinds: ['transfer'],
    }
    function Fixture() {
      const [draft, setDraft] = useState<Parameters<typeof OfferPriceEditor>[0]['value']>({})
      return <><OfferPriceEditor value={draft} onChange={setDraft} /><OfferPriceBreakdownView breakdown={estimate} /></>
    }
    render(<Fixture />)
    expect(screen.getByText('Неуточнённые доплаты могут увеличить итоговую сумму.')).not.toBeNull()
    expect(screen.getByText(/1.125,05/)).not.toBeNull()
    const details = screen.getAllByText('Составляющие цены')[0]!.closest('details')!
    details.open = true
    fireEvent.change(screen.getByLabelText('Доставка'), { target: { value: 'separate' } })
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'Сумма доплаты за «Доставка», ₽' })
    fireEvent.change(input, { target: { value: '15,01' } })
    expect(input.value).toBe('15,01')
    fireEvent.change(screen.getByLabelText('Доставка'), { target: { value: 'included' } })
    expect(screen.queryByRole('textbox', { name: 'Сумма доплаты за «Доставка», ₽' })).toBeNull()
  })
})
