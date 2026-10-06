import { describe, expect, it } from 'vitest'
import { orderTermsTargets, summarizeOrderTerms } from './weeklyOrderTerms'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const digest = 'a'.repeat(64)
function term(n = 1, sides: string[] = [], freshness = 'current') {
  return { id: id(n), version: String(n), sourceOrderVersion: '1', sourceFingerprint: digest, digest,
    snapshot: { private: 'DO_NOT_RETAIN' }, publishedBy: id(90), publishedSide: 'customer',
    publishedAt: '2026-10-06T09:00:00Z', freshness, acceptedByCaller: false,
    receipts: sides.map((party, i) => ({ id: id(100 + i), party, userId: id(200 + i), sessionId: id(300 + i), digest, acceptedAt: '2026-10-06T10:00:00Z' })) }
}
function view(sides: string[] = [], freshness = 'current') {
  const row = term(1, sides, freshness)
  return { revision: '1', proposedTermsId: row.id as string | null, agreedTermsId: sides.length === 2 ? row.id : null,
    history: [row], selected: row, readToken: 'DO_NOT_RETAIN_PROOF', acceptedByCaller: false }
}

describe('weekly terms metadata, no inferred approval', () => {
  it('distinguishes no published revision from agreement', () => {
    expect(summarizeOrderTerms({ revision: '0', proposedTermsId: null, agreedTermsId: null, history: [], selected: null, readToken: null })).toEqual({ state: 'unpublished', version: null, awaiting: [], previousAgreement: false })
  })
  it.each([
    [[], ['customer', 'performer']], [['customer'], ['performer']], [['performer'], ['customer']],
  ])('requires the actual missing side for %j', (receipts, awaiting) => {
    expect(summarizeOrderTerms(view(receipts))).toEqual({ state: 'waiting', version: '1', awaiting, previousAgreement: false })
  })
  it('requires pointer and matching receipts for current agreement', () => {
    expect(summarizeOrderTerms(view(['customer', 'performer']))).toEqual({ state: 'agreed', version: '1', awaiting: [], previousAgreement: false })
  })
  it.each(['stale', 'unavailable', 'invalid'])('does not call an agreed but %s revision current', freshness => {
    expect(summarizeOrderTerms(view(['customer', 'performer'], freshness)).state).toBe(freshness)
  })
  it('does not reuse two receipts from an earlier revision', () => {
    const v = view(['customer']); v.history.push(term(2, ['customer', 'performer'])); v.agreedTermsId = id(2)
    expect(summarizeOrderTerms(v)).toEqual({ state: 'waiting', version: '1', awaiting: ['performer'], previousAgreement: true })
  })
  it('does not confuse personal acceptance or publisher side with a party receipt', () => {
    const v = view(); v.acceptedByCaller = true; v.history[0].acceptedByCaller = true
    expect(summarizeOrderTerms(v).awaiting).toEqual(['customer', 'performer'])
  })
  it('drops private payload, read proof and actor identities without mutating input', () => {
    const v = view(['customer']); const before = JSON.stringify(v)
    const summary = JSON.stringify(summarizeOrderTerms(v))
    expect(summary).not.toContain('DO_NOT_RETAIN'); expect(summary).not.toContain(id(200))
    expect(JSON.stringify(v)).toBe(before)
  })
  it.each([null, [], {}, { revision: '0', proposedTermsId: null, agreedTermsId: null, history: null }])('rejects incomplete response %j, not empty agreement', value => {
    expect(() => summarizeOrderTerms(value)).toThrow()
  })
  it.each(['missing proposal', 'missing agreed history', 'agreement without receipts', 'receipts without agreement', 'wrong digest', 'duplicate party', 'duplicate terms', 'unknown freshness', 'unsafe id', 'missing pointer', 'invalid version'])('rejects inconsistent %s', kind => {
    const v = view(['customer', 'performer'])
    switch (kind) {
      case 'missing proposal': v.proposedTermsId = null; break
      case 'missing agreed history': v.agreedTermsId = id(99); break
      case 'agreement without receipts': v.history[0].receipts.pop(); break
      case 'receipts without agreement': v.agreedTermsId = null; break
      case 'wrong digest': v.history[0].receipts[0].digest = 'b'.repeat(64); break
      case 'duplicate party': v.history[0].receipts[1].party = 'customer'; break
      case 'duplicate terms': v.history.push(v.history[0]); break
      case 'unknown freshness': v.history[0].freshness = 'almost-current'; break
      case 'unsafe id': v.history[0].id = '../../other'; break
      case 'missing pointer': v.proposedTermsId = id(98); break
      case 'invalid version': v.history[0].version = '-1'; break
    }
    expect(() => summarizeOrderTerms(v)).toThrow()
  })
})

describe('current-slot order targets', () => {
  it('retains only active unique deal IDs and safe labels, not money or phones', () => {
    const row = { deal: { id: id(1), state: 'booked', externalName: '  Photographer  ', vendor: null, price: { amount: 999 }, externalPhone: 'PRIVATE_PHONE' } }
    const source = [row, row, { deal: null, prebooked: true }, { deal: { id: id(2), state: 'cancelled' } }, { deal: { id: id(3), state: 'done' } }]
    const before = JSON.stringify(source)
    expect(orderTermsTargets(source)).toEqual([{ dealId: id(1), label: 'Photographer', external: true }])
    expect(JSON.stringify(source)).toBe(before)
  })
  it('uses catalog names without inventing an external performer confirmation', () => {
    expect(orderTermsTargets([{ deal: { id: id(1), state: 'negotiating', vendor: { name: 'Vendor' } } }])).toEqual([{ dealId: id(1), label: 'Vendor', external: false }])
  })
  it('keeps unknown name unknown and never expands a prebooked mark into a deal', () => {
    expect(orderTermsTargets([{ prebooked: true, deal: null }, { deal: { id: id(1), state: 'candidate' } }])).toEqual([{ dealId: id(1), label: null, external: false }])
  })
  it.each([null, {}, [null], [{ deal: { id: '../../other', state: 'booked' } }], [{ deal: { id: id(1), state: 'unknown' } }]])('refuses a malformed source %j', value => {
    expect(() => orderTermsTargets(value)).toThrow()
  })
})
