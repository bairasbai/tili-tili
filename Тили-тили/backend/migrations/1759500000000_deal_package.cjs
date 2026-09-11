/**
 * Сделка помнит пакет, по которому бронировали (фича 005, В1).
 *
 * Бронь принимала `packageId`, проверяла его и забывала: цена уходила в
 * сделку, а «что именно продано» — нет. Кабинет и карточка сделки показывали
 * только сумму. `ON DELETE SET NULL` — подрядчик снял пакет с витрины, сделка
 * остаётся, название пакета в ней пропадает честно, а не ссылается в пустоту.
 */
exports.up = (pgm) => {
  pgm.addColumns('deals', {
    package_id: { type: 'uuid', references: 'vendor_packages', onDelete: 'SET NULL' },
  })
}

exports.down = (pgm) => {
  pgm.dropColumns('deals', ['package_id'])
}
