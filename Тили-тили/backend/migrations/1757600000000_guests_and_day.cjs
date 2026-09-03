/* Этап 5: гости, рассадка, логистика, меню, альбом.
 *
 * Переполнение автобуса и отельного блока закрыто ограничениями, а не кодом:
 * `CHECK taken BETWEEN 0 AND seats` плюс первичный ключ на паре (маршрут, гость).
 * Один голос за блюдо — первичный ключ по гостю, повтор превращается в UPSERT.
 */
exports.up = (pgm) => {
  pgm.createTable('tables', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    capacity: { type: 'integer', notNull: true, default: 8 },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.addConstraint('tables', 'tables_capacity_positive', 'CHECK (capacity > 0)')
  pgm.createIndex('tables', ['wedding_id', 'sort'])

  pgm.createTable('bus_routes', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    pickup: { type: 'text' },
    departs: { type: 'time' },
    seats: { type: 'integer', notNull: true },
    taken: { type: 'integer', notNull: true, default: 0 },
  })
  // Переполнение невозможно даже при ошибке в обработчике: транзакция
  // не закоммитится. Условие в UPDATE даёт понятный 409, CHECK — гарантию.
  pgm.addConstraint('bus_routes', 'bus_seats_positive', 'CHECK (seats > 0)')
  pgm.addConstraint('bus_routes', 'bus_taken_bounded', 'CHECK (taken >= 0 AND taken <= seats)')
  pgm.createIndex('bus_routes', 'wedding_id')

  pgm.createTable('hotel_blocks', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    rooms: { type: 'integer', notNull: true },
    booked: { type: 'integer', notNull: true, default: 0 },
    price: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    deadline: { type: 'date' },
    promo: { type: 'text' },
  })
  pgm.addConstraint('hotel_blocks', 'hotel_rooms_positive', 'CHECK (rooms > 0)')
  pgm.addConstraint('hotel_blocks', 'hotel_booked_bounded', 'CHECK (booked >= 0 AND booked <= rooms)')
  pgm.createIndex('hotel_blocks', 'wedding_id')

  pgm.createTable('menu_options', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    icon: { type: 'text' },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.createIndex('menu_options', ['wedding_id', 'sort'])

  pgm.createTable('guests', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    phone: { type: 'text' },
    rsvp: { type: 'text', notNull: true, default: 'pending' },
    plus_one: { type: 'boolean', notNull: true, default: false },
    group_name: { type: 'text' },
    diet: { type: 'text' },
    diet_note: { type: 'text' },
    transfer: { type: 'text' },
    table_id: { type: 'uuid', references: 'tables', onDelete: 'SET NULL' },
    menu_option_id: { type: 'uuid', references: 'menu_options', onDelete: 'SET NULL' },
    // Персональный токен гостя. Паре НЕ отдаётся никогда: иначе она откроет
    // гостевую страницу и увидит его резерв подарка (ERR-0019).
    rsvp_token: { type: 'text', notNull: true, unique: true },
    comment: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('guests', 'guests_rsvp_known', "CHECK (rsvp IN ('yes','no','pending'))")
  pgm.addConstraint(
    'guests',
    'guests_diet_known',
    "CHECK (diet IS NULL OR diet IN ('vegetarian','vegan','halal','kosher','gluten_free','other'))",
  )
  pgm.addConstraint('guests', 'guests_transfer_known', "CHECK (transfer IS NULL OR transfer IN ('need','own'))")
  pgm.createIndex('guests', ['wedding_id', 'rsvp'])
  pgm.createIndex('guests', 'table_id')

  // Одноразовый код: пара пересылает ссылку, гость меняет её на токен.
  pgm.createTable('guest_invite_codes', {
    code: { type: 'text', primaryKey: true },
    guest_id: { type: 'uuid', notNull: true, references: 'guests', onDelete: 'CASCADE' },
    issued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
  })
  pgm.createIndex('guest_invite_codes', 'guest_id', { where: 'used_at IS NULL' })

  // Гость записан в автобус не более одного раза — первичный ключ по паре.
  pgm.createTable('bus_bookings', {
    bus_id: { type: 'uuid', notNull: true, references: 'bus_routes', onDelete: 'CASCADE' },
    guest_id: { type: 'uuid', notNull: true, references: 'guests', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('bus_bookings', 'bus_bookings_pk', { primaryKey: ['bus_id', 'guest_id'] })
  pgm.createIndex('bus_bookings', 'guest_id')

  pgm.createTable('hotel_bookings', {
    hotel_id: { type: 'uuid', notNull: true, references: 'hotel_blocks', onDelete: 'CASCADE' },
    guest_id: { type: 'uuid', notNull: true, references: 'guests', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('hotel_bookings', 'hotel_bookings_pk', { primaryKey: ['hotel_id', 'guest_id'] })
  pgm.createIndex('hotel_bookings', 'guest_id')

  pgm.createTable('menu_polls', {
    wedding_id: { type: 'uuid', primaryKey: true, references: 'weddings', onDelete: 'CASCADE' },
    question: { type: 'text', notNull: true, default: 'Что будете на горячее?' },
    sent_at: { type: 'timestamptz' },
  })

  // Один голос на гостя: повтор — UPSERT, а не вторая строка.
  pgm.createTable('menu_votes', {
    guest_id: { type: 'uuid', primaryKey: true, references: 'guests', onDelete: 'CASCADE' },
    option_id: { type: 'uuid', notNull: true, references: 'menu_options', onDelete: 'CASCADE' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('menu_votes', 'option_id')

  pgm.createTable('album_photos', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    url: { type: 'text', notNull: true },
    approved: { type: 'boolean', notNull: true, default: false },
    uploaded_by: { type: 'uuid', references: 'guests', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('album_photos', ['wedding_id', 'approved'])

  pgm.createTable('timeline_shifts', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    minutes: { type: 'integer', notNull: true },
    actor_id: { type: 'uuid' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('timeline_shifts', 'wedding_id')

  // Массовые рассылки. Отправка появится вместе с очередью на этапе 7;
  // здесь фиксируется факт и работает дебаунс: повтор в течение 30 секунд
  // не создаёт вторую рассылку. Идемпотентность по ключу этого не даёт —
  // у второго нажатия ключ другой.
  pgm.createTable('broadcasts', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    action: { type: 'text', notNull: true },
    recipients: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('broadcasts', ['wedding_id', 'action', 'created_at'])

  pgm.addColumns('timeline_events', { outdoor: { type: 'boolean', notNull: true, default: false } })
}

exports.down = (pgm) => {
  pgm.dropColumns('timeline_events', ['outdoor'])
  pgm.dropTable('broadcasts')
  pgm.dropTable('timeline_shifts')
  pgm.dropTable('album_photos')
  pgm.dropTable('menu_votes')
  pgm.dropTable('menu_polls')
  pgm.dropTable('hotel_bookings')
  pgm.dropTable('bus_bookings')
  pgm.dropTable('guest_invite_codes')
  pgm.dropTable('guests')
  pgm.dropTable('menu_options')
  pgm.dropTable('hotel_blocks')
  pgm.dropTable('bus_routes')
  pgm.dropTable('tables')
}
