/**
 * Реплика гостя в чате дня X (фича 009, В1/В3).
 *
 * У гостя нет аккаунта — он приходит по ссылке-приглашению. До этого пустой
 * отправитель означал систему, Тиля или своего подрядчика; гость пишет в
 * общий чат дня («автобус от ЗАГСа задерживается» — видят все сразу, План
 * §13.1), и его реплика должна нести имя. Ключ — гость из списка; удалённый
 * из списка гость реплику не уносит (`SET NULL` — имя пропадает честно).
 *
 * Проверка «либо участник, либо гость, либо никто»: реплика с двумя авторами
 * бессмысленна и не должна появиться никаким путём.
 */
exports.up = (pgm) => {
  pgm.addColumns('messages', {
    guest_id: { type: 'uuid', references: 'guests', onDelete: 'SET NULL' },
  })
  pgm.addConstraint('messages', 'messages_one_author', 'CHECK (num_nonnulls(sender_id, guest_id) <= 1)')
}

exports.down = (pgm) => {
  pgm.dropConstraint('messages', 'messages_one_author')
  pgm.dropColumns('messages', ['guest_id'])
}
