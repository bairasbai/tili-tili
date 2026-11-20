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

function formulaAmount({ quantity, rate }: Schemas['OfferPriceFormula'], field = 'priceComponents'): OfferPriceComponent['amount'] {
  if (quantity === null || rate === null) return null
  const [whole = '0', fraction = ''] = quantity.split('.')
  const milliUnits = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0'))
  const minor = (BigInt(rate.amount) * milliUnits + 500n) / 1000n
  if (minor > MAX_AMOUNT) {
    throw validationFailed({ [field]: 'Расчётная доплата превышает допустимую сумму' })
  }
  return { amount: Number(minor), currency: 'RUB' }
}

export function normalizeOfferPriceComponents(base: number, input?: OfferPriceComponent[]): OfferPriceComponent[] {
  const lines = new Map<Kind, OfferPriceComponent>()
  for (const line of input ?? []) {
    if (lines.has(line.kind)) throw validationFailed({ priceComponents: 'Укажите каждую составляющую один раз' })
    if (line.amount !== null && line.status !== 'separate') {
      throw validationFailed({ priceComponents: 'Сумма указывается только для отдельной доплаты' })
    }
    if (line.formula) {
      if (line.status !== 'separate' || line.amount !== null) {
        throw validationFailed({ priceComponents: 'Для расчётной доплаты укажите количество и ставку без готовой суммы' })
      }
      lines.set(line.kind, { ...line, amount: formulaAmount(line.formula) })
    } else {
      lines.set(line.kind, line)
    }
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
  return buildBreakdown(BigInt(row.pricing_base), row.pricing_components)
}

function buildBreakdown(base: bigint, components: OfferPriceComponent[]): Schemas['OfferPriceBreakdown'] {
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

export function previewOfferPriceChange(current: Schemas['OfferPriceBreakdown'],
  changes: Schemas['OrderPriceChangeInput']['changes']): Schemas['OrderPriceChangePreview'] {
  const source = new Map(current.components.map(line => [line.kind, line]))
  const revised = new Map<Kind, OfferPriceComponent>()
  let comparable = true
  for (const { kind, quantity } of changes) {
    const line = source.get(kind)
    if (!line?.formula || revised.has(kind)) {
      throw validationFailed({ changes: 'Укажите каждую сохранённую расчётную позицию один раз' })
    }
    const formula = { ...line.formula, quantity }
    const amount = formulaAmount(formula, 'changes')
    comparable &&= line.amount !== null && amount !== null
    revised.set(kind, { ...line, formula, amount })
  }
  const components = current.components.map(line => revised.get(line.kind) ?? line)
  const base = BigInt(current.quotedPrice.amount)
  if (total(base, components) > MAX_AMOUNT) {
    throw validationFailed({ changes: 'Известная сумма предложения превышает допустимую' })
  }
  const proposed = buildBreakdown(base, components)
  return {
    current, proposed,
    difference: comparable ? { amount: proposed.knownTotal.amount - current.knownTotal.amount, currency: 'RUB' } : null,
  }
}
