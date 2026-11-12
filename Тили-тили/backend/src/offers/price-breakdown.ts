import type { components } from '../contract/api.generated.js'
import { validationFailed } from '../errors.js'

type Schemas = components['schemas']
export type OfferPriceComponent = Schemas['OfferPriceComponent']
type Kind = OfferPriceComponent['kind']
export const OFFER_PRICE_COMPONENT_KINDS = [
  'delivery', 'setup', 'teardown', 'corkage', 'overtime', 'transfer', 'printing',
  'packaging', 'accessories', 'consumables', 'rehearsal', 'lighting', 'rental_extension',
] as const satisfies readonly Kind[]

const MAX_AMOUNT = BigInt(Number.MAX_SAFE_INTEGER)
const total = (base: bigint, lines: readonly OfferPriceComponent[]) =>
  lines.reduce((sum, line) => sum + BigInt(line.amount?.amount ?? 0), base)

export function normalizeOfferPriceComponents(base: number, input?: OfferPriceComponent[]): OfferPriceComponent[] {
  const lines = new Map<Kind, OfferPriceComponent>()
  for (const line of input ?? []) {
    if (lines.has(line.kind)) throw validationFailed({ priceComponents: 'Укажите каждую составляющую один раз' })
    if (line.amount !== null && line.status !== 'separate') {
      throw validationFailed({ priceComponents: 'Сумма указывается только для отдельной доплаты' })
    }
    lines.set(line.kind, line)
  }
  const ordered = OFFER_PRICE_COMPONENT_KINDS.flatMap(kind => {
    const line = lines.get(kind)
    return line ? [line] : []
  })
  if (total(BigInt(base), ordered) > MAX_AMOUNT) {
    throw validationFailed({ priceComponents: 'Известная сумма предложения превышает допустимую' })
  }
  return ordered
}

export interface OfferPricingRow {
  pricing_base?: string | number | null
  pricing_components?: OfferPriceComponent[] | null
}

export function offerPriceBreakdown(row: OfferPricingRow): Schemas['OfferPriceBreakdown'] | undefined {
  if (row.pricing_base == null || !row.pricing_components?.length) return undefined
  const base = BigInt(row.pricing_base)
  const components = row.pricing_components
  const byKind = new Map(components.map(line => [line.kind, line]))
  const unknownKinds = OFFER_PRICE_COMPONENT_KINDS.filter(kind => {
    const line = byKind.get(kind)
    return !line || line.status === 'unknown' || (line.status === 'separate' && line.amount === null)
  })
  return {
    quotedPrice: { amount: Number(base), currency: 'RUB' },
    knownTotal: { amount: Number(total(base, components)), currency: 'RUB' },
    components,
    unknownKinds,
  }
}
