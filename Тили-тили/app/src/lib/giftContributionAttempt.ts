import { newIdempotencyKey } from './api/client'

export interface GiftContributionAttempt {
  kind: 'gift' | 'fund'
  id: string
  amount: number
  key: string
}
// Session lifetime includes navigation and reload. This stores an unresolved
// promise only, never account credentials or permission to send a payment.
const storageKey = (token: string) => `tt_gift_contribution_v1:${encodeURIComponent(token)}`
export function readGiftContribution(token: string | null): GiftContributionAttempt | null {
  if (!token) return null
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey(token)) ?? 'null')
    if (!value || typeof value !== 'object') return null
    const a = value as Partial<GiftContributionAttempt>
    return (a.kind === 'gift' || a.kind === 'fund') && typeof a.id === 'string' && typeof a.key === 'string'
      && typeof a.amount === 'number' && Number.isSafeInteger(a.amount) && a.amount > 0
      ? { kind: a.kind, id: a.id, key: a.key, amount: a.amount } : null
  } catch { return null }
}
export function beginGiftContribution(token: string, kind: GiftContributionAttempt['kind'], id: string, amount: number) {
  const pending = readGiftContribution(token)
  if (pending) {
    if (pending.kind !== kind || pending.id !== id || pending.amount !== amount) throw new Error('Unresolved gift contribution')
    return pending
  }
  const attempt = { kind, id, amount, key: newIdempotencyKey() }
  // Persist BEFORE the request. Without storage, refuse a new mutation rather
  // than lose its identity on reload after an unknown server outcome.
  sessionStorage.setItem(storageKey(token), JSON.stringify(attempt))
  if (readGiftContribution(token)?.key !== attempt.key) throw new Error('Gift contribution identity could not be retained')
  return attempt
}
export function finishGiftContribution(token: string, key: string) {
  if (readGiftContribution(token)?.key === key) sessionStorage.removeItem(storageKey(token))
}
