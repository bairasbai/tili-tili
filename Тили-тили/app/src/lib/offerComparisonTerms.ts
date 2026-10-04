import type { components } from './api/schema'
import { key } from './i18n'

export type OfferComparisonTerms = components['schemas']['OfferComparisonTerms']
export const OFFER_COMPARISON_FIELDS = [
  { name: 'hours', label: key('Часы и охват услуги') },
  { name: 'team', label: key('Команда в предложении') },
  { name: 'result', label: key('Результат услуги') },
  { name: 'delivery', label: key('Срок сдачи результата') },
  { name: 'extras', label: key('Дополнительные расходы') },
  { name: 'cancellation', label: key('Условия отмены') },
  { name: 'reschedule', label: key('Условия переноса') },
] as const
export type ComparisonField = typeof OFFER_COMPARISON_FIELDS[number]['name']
export type ComparisonTermsDraft = Record<ComparisonField, string>

export function comparisonTermsDraft(terms?: OfferComparisonTerms): ComparisonTermsDraft {
  return {
    hours: terms?.hours ?? '', team: terms?.team ?? '', result: terms?.result ?? '',
    delivery: terms?.delivery ?? '', extras: terms?.extras ?? '',
    cancellation: terms?.cancellation ?? '', reschedule: terms?.reschedule ?? '',
  }
}

type DraftResult = { ok: true; terms: OfferComparisonTerms }
  | { ok: false; field: ComparisonField; message: string }

/** Validate quoted text before trimming; never infer conditions from other fields. */
export function normalizeComparisonTerms(draft: ComparisonTermsDraft): DraftResult {
  const terms: NonNullable<OfferComparisonTerms> = {
    hours: null, team: null, result: null, delivery: null, extras: null, cancellation: null, reschedule: null,
  }
  for (const { name } of OFFER_COMPARISON_FIELDS) {
    const value = draft[name]
    if (Array.from(value).length > 2000) {
      return { ok: false, field: name, message: key('Условие не должно превышать 2000 символов') }
    }
    for (let at = 0; at < value.length; at += 1) {
      const code = value.charCodeAt(at)
      if (code === 0 || (code >= 0xdc00 && code <= 0xdfff)) {
        return { ok: false, field: name, message: key('Условие содержит недопустимые символы') }
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(at + 1)
        if (!(next >= 0xdc00 && next <= 0xdfff)) {
          return { ok: false, field: name, message: key('Условие содержит недопустимые символы') }
        }
        at += 1
      }
    }
    terms[name] = value.trim() || null
  }
  return { ok: true, terms: Object.values(terms).some(value => value !== null) ? terms : null }
}
