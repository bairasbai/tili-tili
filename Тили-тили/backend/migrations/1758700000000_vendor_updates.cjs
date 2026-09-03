/* «Обновления от пар» — карточка в кабинете подрядчика (§13.2).
 *
 * Документ требует прямо: изменения рассадки, опроса меню, тайминга и
 * гостевых счётчиков видны подрядчику, чья сделка забронирована, и он
 * подтверждает получение тапом. На экране кабинета карточка есть, на
 * сервере не было ничего — ни строки.
 *
 * Уведомление для этого не годится: оно уходит в общий список и тонет
 * среди «новое сообщение». Здесь нужен именно короткий список последних
 * изменений по своим свадьбам, который можно закрыть подтверждением.
 */
exports.up = (pgm) => {
  pgm.createTable('vendor_updates', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    text: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ack_at: { type: 'timestamptz' },
  })
  pgm.addConstraint(
    'vendor_updates',
    'vendor_updates_kind_known',
    "CHECK (kind IN ('seating','menu','timeline','guests'))",
  )
  // Читается всегда одинаково: неподтверждённые сверху, свои свадьбы.
  pgm.createIndex('vendor_updates', ['vendor_id', 'created_at'])

  /* Рассадку двигают мышью, и каждое движение — не новость. Одна строка
   * на вид изменения в пределах свадьбы, пока её не подтвердили: новая
   * правка обновляет текст, а не добавляет ещё одну строку. */
  pgm.createIndex('vendor_updates', ['vendor_id', 'wedding_id', 'kind'], {
    unique: true,
    where: 'ack_at IS NULL',
  })
}

exports.down = (pgm) => {
  pgm.dropTable('vendor_updates')
}
