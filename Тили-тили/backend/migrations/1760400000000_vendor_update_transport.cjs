/**
 * Вид обновления «транспорт» у карточки «обновления от пар» (фичи 006/014).
 *
 * Перевозчик — подрядчик, и когда пара заводит или меняет маршрут для гостей
 * по его сделке, он должен это увидеть в кабинете. Фича 006 писала такую
 * заметку под видом `guests`, потому что своего вида в ограничении не было,
 * а миграция — стоп-условие. Владелец согласился 2026-09-13: свой вид,
 * чтобы карточка могла назвать событие своим словом, а «гости» не смешивали
 * счётчик гостей с автобусом.
 */
exports.up = (pgm) => {
  pgm.dropConstraint('vendor_updates', 'vendor_updates_kind_known')
  pgm.addConstraint(
    'vendor_updates',
    'vendor_updates_kind_known',
    "CHECK (kind IN ('seating','menu','timeline','guests','transport'))",
  )
}

exports.down = (pgm) => {
  /* Строки нового вида откат не переживут. Перекрасить в `guests` нельзя:
   * частичный уникальный индекс (подрядчик, свадьба, вид) упёрся бы в уже
   * лежащую неподтверждённую заметку о гостях. Это производные уведомления,
   * не первичные данные — удаляются. */
  pgm.sql("delete from vendor_updates where kind = 'transport'")
  pgm.dropConstraint('vendor_updates', 'vendor_updates_kind_known')
  pgm.addConstraint(
    'vendor_updates',
    'vendor_updates_kind_known',
    "CHECK (kind IN ('seating','menu','timeline','guests'))",
  )
}
