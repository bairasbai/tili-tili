export interface ClockBlock {
  startsAt?: string | null
  endsAt?: string | null
  eventId?: string | null
}

export function instant(value?: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null
  const result = Date.parse(value)
  return Number.isFinite(result) ? result : null
}

export function timelineNow<T extends ClockBlock>(blocks: readonly T[], now: Date) {
  const time = now.getTime()
  const ordered = blocks.map(block => ({ block, start: instant(block.startsAt), end: instant(block.endsAt) }))
    .filter(row => row.start !== null)
    .sort((a, b) => a.start! - b.start!)
  return {
    active: ordered.filter(row => row.end !== null && row.end > row.start! && row.start! <= time && time < row.end).map(row => row.block),
    next: ordered.find(row => row.start! > time)?.block,
    ended: blocks.length > 0 && blocks.every(block => {
      const start = instant(block.startsAt)
      const end = instant(block.endsAt)
      return start !== null && end !== null && end > start && end <= time
    }),
  }
}

/** Unknown event context must not inherit the main wedding's clock. */
export function programZone(block: ClockBlock, contexts: readonly { id: string; timeZone: string | null }[], weddingZone?: string | null) {
  return block.eventId ? contexts.find(event => event.id === block.eventId)?.timeZone ?? null : weddingZone ?? null
}

export function programTime(value: string | null | undefined, zone: string | null, language: string): string | null {
  const time = instant(value)
  if (time === null || !zone) return null
  try {
    const locale = language === 'en' ? 'en-GB' : 'ru-RU'
    const date = new Date(time)
    const options = { timeZone: zone }
    return `${date.toLocaleDateString(locale, options)} · ${date.toLocaleTimeString(locale, { ...options, hour: '2-digit', minute: '2-digit' })}`
  } catch {
    return null
  }
}
