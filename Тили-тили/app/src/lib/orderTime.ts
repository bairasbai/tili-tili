/** Order instants use an explicit event/wedding zone. Never substitute the
 * viewer's zone or UTC when the location's zone is unknown. */
export interface OrderTimeCandidate { instant: string; offsetMinutes: number }
export type OrderTimeResult = { status: 'invalid' } | { status: 'missing_zone' } |
  { status: 'gap' } | { status: 'ambiguous'; candidates: OrderTimeCandidate[] } |
  { status: 'valid'; candidate: OrderTimeCandidate }

function formatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}
function fields(format: Intl.DateTimeFormat, instant: number): number[] {
  const parts = format.formatToParts(new Date(instant))
  return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(type => Number(parts.find(part => part.type === type)?.value))
}
function utc(fields: number[]): number {
  const value = new Date(0)
  value.setUTCFullYear(fields[0]!, fields[1]! - 1, fields[2]!)
  value.setUTCHours(fields[3]!, fields[4]!, fields[5] ?? 0, 0)
  return value.getTime()
}
export function formatOrderLocal(instant: string, zone: string | null): string | null {
  if (!zone || !Number.isFinite(Date.parse(instant))) return null
  try {
    const [year, month, day, hour, minute] = fields(formatter(zone), Date.parse(instant))
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  } catch { return null }
}
/** All matching instants are returned for a repeated autumn hour. The user
 * must select an occurrence; a spring gap is never silently normalized. */
export function parseOrderLocal(local: string, zone: string | null, offsetMinutes?: number): OrderTimeResult {
  if (!zone) return { status: 'missing_zone' }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!match) return { status: 'invalid' }
  const input = match.slice(1).map(Number), [year, month, day, hour, minute] = input
  const guess = utc([...input, 0]), probe = new Date(guess)
  if (year! < 1 || month! < 1 || month! > 12 || day! < 1 || hour! > 23 || minute! > 59 ||
    probe.getUTCFullYear() !== year || probe.getUTCMonth() + 1 !== month || probe.getUTCDate() !== day) return { status: 'invalid' }
  let format: Intl.DateTimeFormat
  try { format = formatter(zone) } catch { return { status: 'invalid' } }
  const offsets = new Set<number>()
  // The bounded interval includes both sides of a date/offset transition.
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = guess + hours * 3_600_000
    offsets.add((utc(fields(format, sample)) - sample) / 60_000)
  }
  const candidates: OrderTimeCandidate[] = []
  for (const offset of offsets) {
    const candidate = guess - offset * 60_000
    if (fields(format, candidate).slice(0, 5).every((value, index) => value === input[index])) {
      candidates.push({ instant: new Date(candidate).toISOString(), offsetMinutes: offset })
    }
  }
  candidates.sort((left, right) => left.instant.localeCompare(right.instant))
  if (!candidates.length) return { status: 'gap' }
  if (offsetMinutes !== undefined) {
    const selected = candidates.find(candidate => candidate.offsetMinutes === offsetMinutes)
    return selected ? { status: 'valid', candidate: selected } : { status: 'invalid' }
  }
  return candidates.length === 1 ? { status: 'valid', candidate: candidates[0]! } : { status: 'ambiguous', candidates }
}
