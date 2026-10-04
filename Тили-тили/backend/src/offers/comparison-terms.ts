import { validationFailed } from '../errors.js'

export const COMPARISON_TERM_FIELDS = ['hours', 'team', 'result', 'delivery', 'extras', 'cancellation', 'reschedule'] as const
export type OfferComparisonTerms = Record<(typeof COMPARISON_TERM_FIELDS)[number], string | null>

/** Canonical literal quote text only; missing facts never become commercial promises. */
export function normalizeComparisonTerms(input: unknown): OfferComparisonTerms | null {
  if (input == null) return null
  const refuse = (field: string): never => {
    throw validationFailed({ [field]: 'Укажите текст условия до 2000 символов или оставьте поле пустым' })
  }
  if (typeof input !== 'object' || Array.isArray(input)) return refuse('comparisonTerms')
  const raw = input as Record<string, unknown>
  if (Object.keys(raw).some(key => !(COMPARISON_TERM_FIELDS as readonly string[]).includes(key))) return refuse('comparisonTerms')
  const terms = {} as OfferComparisonTerms
  for (const field of COMPARISON_TERM_FIELDS) {
    const value = raw[field]
    if (value == null) { terms[field] = null; continue }
    if (typeof value !== 'string' || Array.from(value).length > 2000 || value.includes(String.fromCharCode(0)) || /[\uD800-\uDFFF]/u.test(value)) return refuse('comparisonTerms.' + field)
    terms[field] = value.trim() || null
  }
  return COMPARISON_TERM_FIELDS.some(field => terms[field] !== null) ? terms : null
}
