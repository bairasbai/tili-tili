import { key } from './i18n'
import type { PaymentRecord } from './api/paymentSchedule'

/** Учётный статус и файл не устанавливают проверку операции провайдером. */
export function paymentStatusLabel(payment: Pick<PaymentRecord, 'status' | 'kind'>) {
  if (payment.status === 'cancelled') return key('Отметка отменена')
  if (payment.status === 'confirmed') return payment.kind === 'refund'
    ? key('Возврат отмечен · проверка провайдером не установлена')
    : key('Оплата отмечена · проверка провайдером не установлена')
  return payment.kind === 'refund' ? key('Возврат отмечен') : key('Оплата отмечена')
}
