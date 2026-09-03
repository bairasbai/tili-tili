/* Две вещи, которых не хватало: правка цены сделки и избранные идеи.
 *
 * Цена. До сих пор изменить сумму можно было только отменив сделку —
 * а отмена освобождает дату в календаре подрядчика, и её успевает занять
 * другая пара. Правка пишется в тот же журнал, что и переходы состояний,
 * поэтому у записи появляется вид: рассылка по журналу иначе объявит
 * «сделка забронирована» на смену цены (`STATE_TITLE` берётся из `to_state`).
 *
 * Идеи. Лайки «Вдохновения» жили в localStorage: смена телефона — и
 * подборка пуста. Истории лежат во фронте (`STORIES` в Discover.tsx),
 * сервер хранит только их идентификаторы и не притворяется владельцем
 * каталога, которого у него нет.
 */
exports.up = (pgm) => {
  pgm.addColumns('deal_events', {
    kind: { type: 'text', notNull: true, default: 'state' },
  })
  pgm.addConstraint('deal_events', 'deal_events_kind_known', "CHECK (kind IN ('state','price'))")

  pgm.createTable('inspiration_likes', {
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    story_id: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  // Второй лайк той же истории — это не второй лайк.
  pgm.addConstraint('inspiration_likes', 'inspiration_likes_pkey', { primaryKey: ['user_id', 'story_id'] })
  pgm.addConstraint(
    'inspiration_likes',
    'inspiration_likes_story_sane',
    "CHECK (char_length(story_id) between 1 and 40)",
  )
}

exports.down = (pgm) => {
  pgm.dropTable('inspiration_likes')
  pgm.dropConstraint('deal_events', 'deal_events_kind_known')
  pgm.dropColumns('deal_events', ['kind'])
}
