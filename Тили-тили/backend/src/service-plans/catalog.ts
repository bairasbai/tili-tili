import type { components } from '../contract/api.generated.js'

export type ServicePlan = components['schemas']['ServicePlan']

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= max

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function invalidCatalog(): never {
  throw new Error('SERVICE_PLANS_JSON: некорректный каталог тарифов')
}

function parsePlan(value: unknown): ServicePlan {
  if (!isRecord(value)) return invalidCatalog()
  const { id, audience, title, price, periodDays, limits, expiryTerms, refundTerms } = value
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)
    || (audience !== 'couple' && audience !== 'vendor')
    || !isText(title, 120) || !isRecord(price) || price.currency !== 'RUB' || !isPositiveInteger(price.amount)
    || !isPositiveInteger(periodDays)
    || !Array.isArray(limits) || limits.length < 1 || limits.length > 20 || !limits.every(item => isText(item, 240))
    || !isText(expiryTerms, 1000) || !isText(refundTerms, 1000)) return invalidCatalog()
  return { id, audience, title, price: { amount: price.amount, currency: 'RUB' }, periodDays, limits, expiryTerms, refundTerms }
}

export function parseServicePlans(raw: string | undefined): ServicePlan[] {
  if (!raw?.trim()) return []
  let data: unknown
  try { data = JSON.parse(raw) } catch { return invalidCatalog() }
  if (!Array.isArray(data) || data.length > 20) return invalidCatalog()
  const plans = data.map(parsePlan)
  if (new Set(plans.map(plan => plan.id)).size !== plans.length) return invalidCatalog()
  return plans
}
