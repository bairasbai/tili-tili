/* Отметки «уже сообщили» для задач раздела 5.
 *
 * Отдельная миграция, а не правка предыдущей: та уже накатана, и менять
 * её значит чинить руками каждую базу, где она прошла. Миграция правится
 * только до первого накатывания.
 */
exports.up = (pgm) => {
  /* Об открытии чата дня X сообщают ОДИН раз. Без отметки ежечасная задача
   * слала бы напоминание каждый час до самой свадьбы. */
  pgm.addColumns('chats', { opened_notified_at: { type: 'timestamptz' } })

  /* Напоминание за 12 часов до конца мягкой брони — тоже один раз.
   * Хранить его в `deal_events` не выйдет: там журнал переходов состояния,
   * а напоминание состояние не меняет. */
  pgm.addColumns('deals', { hold_reminded_at: { type: 'timestamptz' } })

  /* Еженедельный дайджест — один на человека на неделю (План §18.6:
   * «один push с задачами недели — не по одной»). Ключ по номеру недели
   * делает повтор задачи пустым: вторая строка просто не вставится. */
  pgm.createTable('digest_sent', {
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    /* ISO-неделя в виде `2027-24`: у декабрьских дней недели номер может
     * относиться к следующему году, и склеивать год с датой нельзя. */
    week: { type: 'text', notNull: true },
    sent_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('digest_sent', 'digest_sent_pk', { primaryKey: ['user_id', 'week'] })
}

exports.down = (pgm) => {
  pgm.dropTable('digest_sent')
  pgm.dropColumns('deals', ['hold_reminded_at'])
  pgm.dropColumns('chats', ['opened_notified_at'])
}
