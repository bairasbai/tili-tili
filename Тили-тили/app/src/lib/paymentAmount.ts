/** Точный ввод рублей для денежных полей 019: без округления binary float. */
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

/** Целые рубли для бюджетного ориентира запроса предложения; дробь и знак не принимаются. */
export function parseWholeRubles(input: string): number | null {
  const text = input.trim().replace(/[ \u00a0\u202f]/g, '')
  return /^\d{1,13}$/.test(text) ? Number(text) : null
}
