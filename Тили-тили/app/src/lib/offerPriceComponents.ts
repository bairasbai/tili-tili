import type { components } from './api/schema'
import { key, t } from './i18n'
import { parsePaymentRubles, paymentRubles } from './money'

export type PriceComponent = components['schemas']['OfferPriceComponent']
export type PriceBreakdown = components['schemas']['OfferPriceBreakdown']
type Kind = PriceComponent['kind']
type Status = PriceComponent['status']
export type PriceComponentDraft = Partial<Record<Kind, { status: Status; amount: string }>>

export const PRICE_COMPONENT_LABELS = {
  delivery: key('Доставка'),
  setup: key('Монтаж'),
  teardown: key('Демонтаж'),
  corkage: key('Пробковый сбор'),
  overtime: key('Сверхурочные'),
  transfer: key('Трансфер'),
  printing: key('Печать'),
  packaging: key('Упаковка'),
  accessories: key('Аксессуары'),
  consumables: key('Расходники'),
  rehearsal: key('Репетиция'),
  lighting: key('Свет'),
  rental_extension: key('Продление аренды'),
} satisfies Record<Kind, string>
export const PRICE_COMPONENT_KINDS = Object.keys(PRICE_COMPONENT_LABELS) as Kind[]

export const PRICE_COMPONENT_STATUSES = {
  unknown: key('Не уточнено'),
  included: key('Включено в цену'),
  separate: key('Оплачивается отдельно'),
  not_required: key('Не требуется'),
} satisfies Record<Status, string>

export function priceComponentDraft(components: readonly PriceComponent[] = []): PriceComponentDraft {
  return Object.fromEntries(components.map(line => [line.kind, {
    status: line.status, amount: line.amount === null ? '' : paymentRubles(line.amount.amount),
  }]))
}

export function normalizePriceComponentDraft(base: number, draft: PriceComponentDraft):
  { ok: true; components: PriceComponent[] } | { ok: false; error: string } {
  const components: PriceComponent[] = []
  let knownTotal = BigInt(base)
  for (const kind of PRICE_COMPONENT_KINDS) {
    const line = draft[kind]
    if (!line) continue
    let amount: PriceComponent['amount'] = null
    if (line.status === 'separate' && line.amount.trim()) {
      const minor = parsePaymentRubles(line.amount, true)
      if (minor === null) return { ok: false, error: t('Проверьте сумму для «{item}»').replace('{item}', t(PRICE_COMPONENT_LABELS[kind])) }
      amount = { amount: minor, currency: 'RUB' }
      knownTotal += BigInt(minor)
    }
    components.push({ kind, status: line.status, amount })
  }
  if (knownTotal > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, error: t('Известная сумма предложения превышает допустимую') }
  return { ok: true, components }
}
