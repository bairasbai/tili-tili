/** Parse decimal rubles exactly; never round a binary floating point amount. */
export function parsePaymentRubles(input: string): number | null {
  const text = input.trim().replace(/[ \u00a0\u202f]/g, '').replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match || text.length > 22) return null
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null
}

export function paymentRubles(minor: number): string {
  const whole = Math.floor(minor / 100)
  return `${whole}.${String(minor % 100).padStart(2, '0')}`
}

/**
 * Whole rubles for a budget category limit (invariant 7): digits and spaces only, 0 allowed.
 * «1500,50» and «-5000» are refused instead of turning into 150 050 ₽ and 5 000 ₽ (ревью 018, BF-09).
 */
export function parseWholeRubles(input: string): number | null {
  const text = input.trim().replace(/[ \u00a0\u202f]/g, '')
  return /^\d{1,13}$/.test(text) ? Number(text) : null
}

/**
 * Reserve percent → basis points: «12,5» → 1250. Strict: empty, a lone space or «0x10» is not a number,
 * where `Number()` gave 0 % and 16 % (ревью 018, BF-10). Up to 50 %, as on the server.
 */
export function parseReservePercent(input: string): number | null {
  const match = /^(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return bps <= 5000 ? bps : null
}
