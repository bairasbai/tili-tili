import { t } from './i18n'
import type { SeatingRead } from './useSeating'

/** Export names and seat counts only; no contact, diet or guest-token fields. */
export function seatingPdfBody(data: SeatingRead): string {
  const guests = data.guests.filter(guest => guest.status !== 'no')
  const sections = data.tables.map((table, index) => {
    const seated = guests.filter(guest => guest.tableId === table.id)
    return `${table.name || `${t('Стол')} ${index + 1}`} · ${seated.length}/${table.capacity}\n${seated.map(guest => guest.name).join('\n') || t('Пока пусто')}`
  })
  const unseated = guests.filter(guest => !data.tables.some(table => table.id === guest.tableId))
  if (unseated.length) sections.push(`${t('Без места')}\n${unseated.map(guest => guest.name).join('\n')}`)
  return sections.join('\n\n') || t('Пока пусто')
}
