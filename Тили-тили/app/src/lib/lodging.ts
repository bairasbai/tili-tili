import type { LodgingSource } from './api/lodging'
import { t } from './i18n'

export function lodgingSourceLabel(source: LodgingSource): string {
  switch (source) {
    case 'organizer': return t('Организатор')
    case 'guest': return t('Гость')
    case 'hotel': return t('Отель')
  }
}
