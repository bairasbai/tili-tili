/**
 * Сколько у подрядчика отзывов ПАР — для порога показа рейтинга (фича 005, В4).
 *
 * Порог «три отзыва» (План §18.2) считал и гостевые: одна забронированная
 * сделка плюс три гостя той же свадьбы давали «5,0» в каталоге — накрутка
 * без единого правила нарушенного. Число открывается по отзывам пар
 * (подтверждённая сделка); гостевые остаются в среднем.
 *
 * Колонка, а не подзапрос: порог стоит в сортировке и фильтре каталога
 * (`SHOWN_RATING`, `ratingMin`), подзапрос там — на каждой строке выдачи.
 * Ведёт `recomputeRating` вместе с `rating` и `reviews_count`.
 */
exports.up = (pgm) => {
  pgm.addColumns('vendors', {
    couple_reviews_count: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.sql(`
    UPDATE vendors v SET couple_reviews_count = (
      SELECT count(*) FROM reviews r
       WHERE r.vendor_id = v.id AND r.source = 'couple' AND r.hidden_at IS NULL);
  `)
  pgm.createIndex('vendors', 'couple_reviews_count')
}

exports.down = (pgm) => {
  pgm.dropIndex('vendors', 'couple_reviews_count')
  pgm.dropColumns('vendors', ['couple_reviews_count'])
}
