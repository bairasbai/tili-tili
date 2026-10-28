import { conflict, validationFailed } from '../errors.js'

/** Only named native business refusals cross the HTTP boundary. An unexpected
 * graph/CHECK/FK failure remains an integrity error, including at COMMIT. */
export function calendarNativeError(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error
  const native = error as { code?: string; constraint?: string }
  if (native.code === '23514') {
    switch (native.constraint) {
      case 'legacy_calendar_bounds_scope':
        return conflict('calendar_scope_incomplete', 'Нужна полная ограниченная область календарных обязательств')
      case 'legacy_calendar_bounds_scope_changed':
      case 'legacy_calendar_bounds_source_changed':
        return conflict('calendar_scope_changed', 'Состав или условия календарных обязательств изменились — обновите данные')
      case 'legacy_calendar_bounds_declaration':
        return validationFailed({ bounds: 'Границы и состав исполнителей должны полностью покрывать известные обязательства' })
      case 'legacy_calendar_bounds_not_agreed':
        return conflict('legacy_calendar_bounds_not_agreed', 'Нужно действующее подтверждение каждой стороны каждого обязательства')
      case 'unresolved_legacy_obligations':
        return conflict('unresolved_legacy_obligations', 'Сначала согласуйте границы всех прежних обязательств компании')
      case 'legacy_person_scope_unknown':
        return conflict('legacy_person_scope_unknown', 'Прежняя занятость человека или состав исполнителей не подтверждены полностью')
      case 'resource_booking_conflict':
        return conflict('resource_booking_conflict', 'Выбранный интервал пересекается с действующей занятостью')
      case 'resource_booking_required':
        return conflict('resource_booking_required', 'Для этой занятости нужен согласованный заказ с явными интервалами и ресурсами')
    }
  }
  return error
}

export function calendarNativeRefusal(error: unknown): never { throw calendarNativeError(error) }
