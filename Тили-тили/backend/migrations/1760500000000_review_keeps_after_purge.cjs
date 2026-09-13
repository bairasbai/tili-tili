/**
 * Отзыв пары переживает уборку свадьбы (фича 014, хвост 003 / ERR-0209).
 *
 * `reviews.deal_id` стоит `ON DELETE SET NULL`, а проверка
 * `reviews_key_matches_source` требовала у отзыва пары сделку — поэтому уборка
 * отменённой свадьбы и стирание аккаунта удаляли отзывы пары заранее, иначе
 * каскад падал на этой проверке. Отзыв — история подрядчика, а не свадьбы:
 * пара, которая была на площадке и оценила её, не перестаёт быть правдой от
 * того, что через полгода её аккаунт стёрт. Владелец согласился 2026-09-13.
 *
 * Проверка ослабляется до «у отзыва пары нет гостевого токена»: что отзыв
 * пары заведён ПО сделке, гарантирует обработчик (`POST /deals/{id}/review`
 * пишет `deal_id` и не принимает отзыв без сделки `done`), а один отзыв на
 * сделку держит частичный уникальный индекс по `deal_id` — он остаётся.
 * Ограничение «`deal_id` не пуст всегда» в базе выразить нельзя, если после
 * удаления сделки он пуст по замыслу.
 *
 * Обратная миграция вернула бы строгую проверку и упала бы на отзывах с уже
 * обнулённой сделкой — такие строки перед этим удаляются, как делала уборка.
 */
exports.up = (pgm) => {
  pgm.dropConstraint('reviews', 'reviews_key_matches_source')
  pgm.addConstraint(
    'reviews',
    'reviews_key_matches_source',
    "CHECK ((source = 'couple' AND guest_token IS NULL)" +
      " OR (source = 'guest' AND guest_token IS NOT NULL AND deal_id IS NULL))",
  )
}

exports.down = (pgm) => {
  pgm.sql("delete from reviews where source = 'couple' and deal_id is null")
  pgm.dropConstraint('reviews', 'reviews_key_matches_source')
  pgm.addConstraint(
    'reviews',
    'reviews_key_matches_source',
    "CHECK ((source = 'couple' AND deal_id IS NOT NULL AND guest_token IS NULL)" +
      " OR (source = 'guest' AND guest_token IS NOT NULL AND deal_id IS NULL))",
  )
}
