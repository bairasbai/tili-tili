/** Metadata projections only: never retain frozen private payloads or read proofs. */
export type TermsSide = 'customer' | 'performer'
export type TermsSummary = {
  state: 'unpublished' | 'waiting' | 'agreed' | 'stale' | 'unavailable' | 'invalid'
  version: string | null
  awaiting: TermsSide[]
  previousAgreement: boolean
}
export type TermsTarget = { dealId: string; label: string | null; external: boolean }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const revision = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d{0,18})$/.test(v)
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Unconfirmed order metadata')
  return v as Record<string, unknown>
}

/** Only these observed catalog states belong in the active-order reader. */
export function isActiveOrderState(value: unknown): boolean {
  return typeof value === 'string' && ['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit'].includes(value)
}

export function orderTermsTargets(value: unknown): TermsTarget[] {
  if (!Array.isArray(value)) throw new Error('Unconfirmed slot list')
  const seen = new Set<string>(), targets: TermsTarget[] = []
  for (const valueSlot of value) {
    const slot = object(valueSlot)
    if (slot.deal == null) continue
    const deal = object(slot.deal)
    if (!uuid(deal.id) || !['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit', 'done', 'cancelled'].includes(String(deal.state))) throw new Error('Unconfirmed deal')
    if (deal.state === 'done' || deal.state === 'cancelled') continue
    const dealId = deal.id.toLowerCase()
    if (seen.has(dealId)) continue
    seen.add(dealId)
    const vendor = deal.vendor == null ? null : object(deal.vendor)
    const name = vendor?.name ?? deal.externalName
    if (name != null && typeof name !== 'string') throw new Error('Unconfirmed deal label')
    targets.push({ dealId, label: typeof name === 'string' && name.trim() ? name.trim() : null, external: deal.vendor === null })
  }
  return targets
}

/** Agreement uses both the server pointer and same-digest receipts, never a count alone. */
export function summarizeOrderTerms(value: unknown): TermsSummary {
  const view = object(value)
  if (!revision(view.revision) || !Array.isArray(view.history)) throw new Error('Unconfirmed terms history')
  for (const pointer of [view.proposedTermsId, view.agreedTermsId]) if (pointer !== null && !uuid(pointer)) throw new Error('Unconfirmed terms pointer')
  const history = new Map<string, { version: string; freshness: TermsSummary['state'] | 'current'; parties: Set<TermsSide> }>()
  for (const valueTerm of view.history) {
    const term = object(valueTerm)
    if (!uuid(term.id) || !revision(term.version) || term.version === '0' || typeof term.digest !== 'string' || !/^[0-9a-f]{64}$/.test(term.digest) || !['current', 'stale', 'unavailable', 'invalid'].includes(String(term.freshness)) || !Array.isArray(term.receipts)) throw new Error('Unconfirmed terms metadata')
    const parties = new Set<TermsSide>()
    for (const valueReceipt of term.receipts) {
      const receipt = object(valueReceipt)
      if ((receipt.party !== 'customer' && receipt.party !== 'performer') || parties.has(receipt.party) || receipt.digest !== term.digest) throw new Error('Unconfirmed terms receipt')
      parties.add(receipt.party)
    }
    const id = term.id.toLowerCase()
    if (history.has(id)) throw new Error('Repeated terms identity')
    history.set(id, { version: term.version, freshness: term.freshness as 'current' | 'stale' | 'unavailable' | 'invalid', parties })
  }
  const proposedId = typeof view.proposedTermsId === 'string' ? view.proposedTermsId.toLowerCase() : null
  const agreedId = typeof view.agreedTermsId === 'string' ? view.agreedTermsId.toLowerCase() : null
  for (const pointer of [proposedId, agreedId]) if (pointer !== null && !history.has(pointer)) throw new Error('Unknown terms pointer')
  if (agreedId && history.get(agreedId)!.parties.size !== 2) throw new Error('Unconfirmed agreement')
  if (proposedId === null) {
    if (history.size || agreedId) throw new Error('Missing proposed terms')
    return { state: 'unpublished', version: null, awaiting: [], previousAgreement: false }
  }
  const proposed = history.get(proposedId)!
  const awaiting = (['customer', 'performer'] as const).filter(side => !proposed.parties.has(side))
  if ((awaiting.length === 0) !== (agreedId === proposedId)) throw new Error('Inconsistent agreement pointer')
  return { state: proposed.freshness === 'current' ? (agreedId === proposedId ? 'agreed' : 'waiting') : proposed.freshness,
    version: proposed.version, awaiting, previousAgreement: agreedId !== null && agreedId !== proposedId }
}
