/* Этап 3: каталог подрядчиков, анкета, календарь занятости, избранное.
 *
 * Ключевые инварианты — в ограничениях, а не в обработчиках:
 *   — одна строка занятости на дату (гонка «две брони на один день»);
 *   — длительность видео ≤ 180 с;
 *   — один аккаунт — одна анкета.
 */
exports.up = (pgm) => {
  pgm.createTable('vendors', {
    id: { type: 'uuid', primaryKey: true },
    // Один аккаунт — одна анкета: мастер её создаёт и потом только правит.
    user_id: { type: 'uuid', notNull: true, unique: true, references: 'users', onDelete: 'CASCADE' },
    category_id: { type: 'text', notNull: true, references: 'categories' },
    city_id: { type: 'integer', references: 'cities' },
    name: { type: 'text', notNull: true },
    about: { type: 'text' },
    price_from: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    years: { type: 'integer' },
    photo_url: { type: 'text' },
    // Автопубликация: published_at ставится сразу, moderated_at — модератором
    // потом (План §19.2). Анкета живёт в выдаче с первой минуты.
    published_at: { type: 'timestamptz' },
    moderated_at: { type: 'timestamptz' },
    // Галочка «проверен». Сами документы лежат в vendor_verifications
    // и наружу не выходят никогда.
    verified_at: { type: 'timestamptz' },
    rating: { type: 'numeric(2,1)' },
    reviews_count: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('vendors', 'vendors_price_nonneg', 'CHECK (price_from IS NULL OR price_from >= 0)')
  pgm.addConstraint('vendors', 'vendors_rating_range', 'CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))')
  pgm.addConstraint('vendors', 'vendors_currency_rub', "CHECK (currency = 'RUB')")
  pgm.createIndex('vendors', ['category_id', 'city_id', 'published_at'])
  pgm.createIndex('vendors', 'reviews_count')

  pgm.createTable('vendor_packages', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    price: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    items: { type: 'jsonb', notNull: true, default: pgm.func("'[]'::jsonb") },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.createIndex('vendor_packages', ['vendor_id', 'sort'])

  pgm.createTable('vendor_media', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    url: { type: 'text', notNull: true },
    duration_s: { type: 'integer' },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.addConstraint('vendor_media', 'vendor_media_kind_known', "CHECK (kind IN ('photo','video'))")
  // Ограничение в БД, а не только проверка в обработчике: файл может попасть
  // сюда и другим путём — из миграции данных, из админки, из скрипта.
  pgm.addConstraint(
    'vendor_media',
    'vendor_media_video_le_180s',
    "CHECK (kind <> 'video' OR (duration_s IS NOT NULL AND duration_s > 0 AND duration_s <= 180))",
  )
  pgm.createIndex('vendor_media', ['vendor_id', 'sort'])

  pgm.createTable('vendor_busy_dates', {
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    date: { type: 'date', notNull: true },
    source: { type: 'text', notNull: true, default: 'manual' },
    // Ссылка на сделку появится вместе с таблицей deals на этапе 4;
    // внешний ключ добавляется там же.
    deal_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  // Первичный ключ по паре — это и есть защита от двух броней на один день:
  // вторая вставка не проходит, а не «проверяется и вставляется».
  pgm.addConstraint('vendor_busy_dates', 'vendor_busy_dates_pk', { primaryKey: ['vendor_id', 'date'] })
  pgm.addConstraint('vendor_busy_dates', 'vendor_busy_source_known', "CHECK (source IN ('manual','deal'))")

  pgm.createTable('favorites', {
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('favorites', 'favorites_pk', { primaryKey: ['user_id', 'vendor_id'] })

  pgm.createTable('vendor_verifications', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    // Скан паспорта или свидетельства. НИКОГДА не попадает ни в один ответ
    // каталога — наружу выходит только vendors.verified_at (план §6).
    file_url: { type: 'text' },
    inn: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'pending' },
    checked_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('vendor_verifications', 'vendor_verif_kind_known', "CHECK (kind IN ('passport','ip','company'))")
  pgm.addConstraint(
    'vendor_verifications',
    'vendor_verif_status_known',
    "CHECK (status IN ('pending','approved','rejected'))",
  )
  pgm.createIndex('vendor_verifications', ['vendor_id', 'status'])

  pgm.createTable('concierge_requests', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    category_id: { type: 'text', notNull: true, references: 'categories' },
    city_id: { type: 'integer', references: 'cities' },
    budget: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    comment: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'concierge_requests',
    'concierge_status_known',
    "CHECK (status IN ('new','in_progress','done','cancelled'))",
  )
  pgm.createIndex('concierge_requests', ['status', 'created_at'])
}

exports.down = (pgm) => {
  pgm.dropTable('concierge_requests')
  pgm.dropTable('vendor_verifications')
  pgm.dropTable('favorites')
  pgm.dropTable('vendor_busy_dates')
  pgm.dropTable('vendor_media')
  pgm.dropTable('vendor_packages')
  pgm.dropTable('vendors')
}
