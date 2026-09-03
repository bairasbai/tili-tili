/* Матрица уведомлений плана §18.6: подрядчик и сводка по RSVP.
 *
 * Уведомление о смене статуса сделки нельзя повесить на обработчик: сделка
 * меняет состояние в четырёх местах (правка сделки, бронь слота, свой
 * подрядчик, истечение брони фоновой задачей). Зато КАЖДЫЙ переход уже
 * пишется в `deal_events` — значит, рассылать надо по журналу, а не по
 * коду перехода. Одна отметка вместо четырёх вызовов.
 */
exports.up = (pgm) => {
  pgm.addColumns('deal_events', { notified_at: { type: 'timestamptz' } })
  pgm.createIndex('deal_events', 'at', { where: 'notified_at IS NULL' })

  /* Когда гость ответил. Сводка по RSVP уходит паре раз в день (§18.6:
   * «сводка 1/день», а не письмо на каждый ответ), и без отметки времени
   * непонятно, о чём сводка. */
  pgm.addColumns('guests', { rsvp_at: { type: 'timestamptz' } })
}

exports.down = (pgm) => {
  pgm.dropColumns('guests', ['rsvp_at'])
  pgm.dropIndex('deal_events', 'at', { where: 'notified_at IS NULL' })
  pgm.dropColumns('deal_events', ['notified_at'])
}
