import { t } from './i18n'

export interface ContractPdfFacts { city: string; customer: string; passport: string; vendor: string; date: string; amount: string }

/** Plain data only: no DOM parsing, HTML interpolation, external URL or template execution. */
export function contractPdfBody(facts: ContractPdfFacts, generatedDate: string): string {
  const customer = facts.passport ? `${facts.customer}, ${facts.passport}` : facts.customer
  return [
    [facts.city.replace(/\s*·\s*$/, '').trim(), generatedDate].filter(Boolean).join(' · '),
    `${t('Заказчик:')} ${customer}`,
    `${t('Исполнитель:')} ${facts.vendor}`,
    `${t('1. Предмет договора: услуги на свадебное торжество ')}${facts.date}.`,
    `${t('2. Стоимость услуг: ')}${facts.amount}.`,
    t('3. Ответственность сторон и форс-мажор — по ГК РФ.'),
    t('4. Сформировано в приложении «Тили-тили» (tili-tili.ru).'),
  ].join('\n\n')
}

export function guestListPdfBody(guests: ReadonlyArray<{ name?: string | null; status?: string | null }>): string {
  return guests.map((guest, index) => `${index + 1}. ${guest.name ?? ''} — ${guest.status === 'yes' ? t('Придёт') : guest.status === 'no' ? t('Не придёт') : t('Ждём')}`).join('\n') || t('Пока пусто')
}

export function programPdfBody(events: ReadonlyArray<{ name: string; time: string; loc: string; who: string; details?: string[] }>, date: string): string {
  return [date, ...events.map(event => [event.time, event.name, event.loc, event.who, ...(event.details ?? [])].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n') || t('Тайминг пуст — добавьте событие или соберите автоплан по команде')
}
