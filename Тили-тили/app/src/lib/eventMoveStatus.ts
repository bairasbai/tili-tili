import type { EventMoveRootView } from './api/eventMoves'
import { t } from './i18n'

export function eventMoveStatus(status: EventMoveRootView['status']): string {
  return t(status === 'pending' ? 'Ожидает согласий' : status === 'applied' ? 'Перенос применён'
    : status === 'cancelled' ? 'Предложение переноса отменено' : 'Условия изменились — нужно новое предложение')
}
