/**
 * Отзыв гостя ключуется гостем, а не его ссылкой (фича 005, В1).
 *
 * Ключом был `guest_token` — токен ссылки-приглашения. Перевыпуск ссылки
 * (пара переслала гостю новую) выдавал гостю новую личность, и второй отзыв
 * тому же подрядчику проходил; обход переносил токен в отзывах при
 * перевыпуске (ERR-0234) — правило держал обработчик, а не база.
 *
 * `guest_id` — гость из списка; `ON DELETE SET NULL` — удалённый из списка
 * гость не уносит с собой отзыв подрядчика. `guest_token` остаётся:
 * у 77 старых отзывов в дев-базе гостя уже нет, и токен — единственное,
 * что связывает их с источником. Проверка `reviews_key_matches_source`
 * не меняется. Уникальность — только по гостю.
 */
exports.up = (pgm) => {
  pgm.addColumns('reviews', {
    guest_id: { type: 'uuid', references: 'guests', onDelete: 'SET NULL' },
  })
  pgm.sql(`
    UPDATE reviews r SET guest_id = g.id
      FROM guests g
     WHERE r.source = 'guest' AND r.guest_token = g.rsvp_token;
  `)
  pgm.createIndex('reviews', ['guest_id', 'vendor_id'], { unique: true, where: 'guest_id IS NOT NULL' })
  pgm.dropIndex('reviews', ['guest_token', 'vendor_id'], { unique: true, where: 'guest_token IS NOT NULL' })
  pgm.createIndex('reviews', 'guest_id', { where: 'guest_id IS NOT NULL' })
}

exports.down = (pgm) => {
  pgm.dropIndex('reviews', 'guest_id', { where: 'guest_id IS NOT NULL' })
  pgm.createIndex('reviews', ['guest_token', 'vendor_id'], { unique: true, where: 'guest_token IS NOT NULL' })
  pgm.dropIndex('reviews', ['guest_id', 'vendor_id'], { unique: true, where: 'guest_id IS NOT NULL' })
  pgm.dropColumns('reviews', ['guest_id'])
}
