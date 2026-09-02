/* Этап 4: сделки, оплаты, бюджет, документы, свои подрядчики.
 *
 * Все гонки этого этапа сняты ограничениями, а не кодом (раздел 2.8 плана):
 *   — двойное бронирование даты закрывает PK (vendor_id, date);
 *   — один слот = одна сделка закрывает UNIQUE на slots.deal_id;
 *   — повторная оплата закрывается PK в idempotency_keys.
 * Обработчик только переводит ошибку ограничения в 409.
 */
exports.up = (pgm) => {
  pgm.createTable('deals', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    slot_id: { type: 'uuid', notNull: true, references: 'slots', onDelete: 'CASCADE' },
    // Либо подрядчик из каталога, либо свой — с именем и телефоном.
    vendor_id: { type: 'uuid', references: 'vendors' },
    external_name: { type: 'text' },
    external_phone: { type: 'text' },
    state: { type: 'text', notNull: true, default: 'candidate' },
    price: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    // Мягкая бронь — не отдельное состояние, а срок жизни `negotiating` (§18.3).
    negotiating_until: { type: 'timestamptz' },
    booked_at: { type: 'timestamptz' },
    done_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
    cancel_reason: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'deals',
    'deals_state_known',
    "CHECK (state IN ('candidate','contacted','negotiating','booked','paid_deposit','done','cancelled'))",
  )
  // Сделка без исполнителя бессмысленна: либо каталожный, либо свой.
  pgm.addConstraint('deals', 'deals_has_performer', 'CHECK (vendor_id IS NOT NULL OR external_name IS NOT NULL)')
  pgm.addConstraint('deals', 'deals_price_nonneg', 'CHECK (price IS NULL OR price >= 0)')
  pgm.createIndex('deals', ['wedding_id', 'state'])
  pgm.createIndex('deals', 'negotiating_until', { where: "state = 'negotiating'" })

  // Один слот — одна сделка. Уникальность, а не проверка в коде: два
  // одновременных «Забронировать» иначе повесили бы на слот две сделки.
  pgm.addColumns('slots', { deal_id: { type: 'uuid', references: 'deals' } })
  pgm.addConstraint('slots', 'slots_deal_unique', { unique: ['deal_id'] })

  // Занятость подрядчика теперь может приходить от сделки.
  pgm.addConstraint('vendor_busy_dates', 'vendor_busy_deal_fk', {
    foreignKeys: { columns: 'deal_id', references: 'deals', onDelete: 'SET NULL' },
  })

  pgm.createTable('deal_events', {
    id: { type: 'uuid', primaryKey: true },
    deal_id: { type: 'uuid', notNull: true, references: 'deals', onDelete: 'CASCADE' },
    from_state: { type: 'text' },
    to_state: { type: 'text', notNull: true },
    actor_id: { type: 'uuid' },
    note: { type: 'text' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('deal_events', ['deal_id', 'at'])

  pgm.createTable('payments', {
    id: { type: 'uuid', primaryKey: true },
    deal_id: { type: 'uuid', notNull: true, references: 'deals', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    amount: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    // Эквайринга в MVP нет (План §3.2): запись фиксирует факт, деньги ходят
    // между парой и подрядчиком напрямую.
    status: { type: 'text', notNull: true, default: 'recorded' },
    provider_ref: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('payments', 'payments_kind_known', "CHECK (kind IN ('deposit','balance','refund'))")
  pgm.addConstraint('payments', 'payments_status_known', "CHECK (status IN ('recorded','confirmed','cancelled'))")
  pgm.addConstraint('payments', 'payments_amount_positive', 'CHECK (amount > 0)')
  pgm.createIndex('payments', 'deal_id')

  // Только РУЧНЫЕ статьи. Суммы по сделкам считаются на лету: производное
  // значение, сохранённое в базу, расходится с источником на первой же правке
  // (§3.1, и ровно это уже случалось во фронте — ERR-0012).
  pgm.createTable('budget_items', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    category_id: { type: 'text', notNull: true },
    amount: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('budget_items', 'budget_items_amount_nonneg', 'CHECK (amount >= 0)')
  pgm.createIndex('budget_items', 'wedding_id')

  pgm.createTable('documents', {
    id: { type: 'uuid', primaryKey: true },
    deal_id: { type: 'uuid', notNull: true, references: 'deals', onDelete: 'CASCADE' },
    template_code: { type: 'text', notNull: true },
    version: { type: 'integer', notNull: true, default: 1 },
    fields: { type: 'jsonb', notNull: true, default: pgm.func("'{}'::jsonb") },
    file_url: { type: 'text' },
    docx_url: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'draft' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('documents', 'documents_status_known', "CHECK (status IN ('draft','sent','signed'))")
  pgm.createIndex('documents', 'deal_id')

  // Ссылка для своего подрядчика: 30 дней, привязана к слоту, отзывается
  // вместе с удалением своего подрядчика (§11).
  pgm.createTable('external_invites', {
    token: { type: 'text', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    slot_id: { type: 'uuid', notNull: true, references: 'slots', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    accepted_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
  })
  pgm.createIndex('external_invites', ['slot_id', 'revoked_at'])

  // Ключ повтора. Первый запрос пишет ключ в той же транзакции, что и эффект;
  // повтор возвращает сохранённый ответ, не повторяя действие.
  pgm.createTable('idempotency_keys', {
    key: { type: 'text', primaryKey: true },
    user_id: { type: 'uuid', references: 'users', onDelete: 'CASCADE' },
    route: { type: 'text', notNull: true },
    request_hash: { type: 'text', notNull: true },
    status: { type: 'integer' },
    body: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('idempotency_keys', 'created_at')

  // Отмена свадьбы требует подтверждения ОБОИХ партнёров: первый вызов
  // создаёт запрос, второй исполняет.
  pgm.addColumns('weddings', {
    cancel_requested_by: { type: 'uuid', references: 'users' },
    cancel_requested_at: { type: 'timestamptz' },
    cancelled_at: { type: 'timestamptz' },
  })
}

exports.down = (pgm) => {
  pgm.dropColumns('weddings', ['cancel_requested_by', 'cancel_requested_at', 'cancelled_at'])
  pgm.dropTable('idempotency_keys')
  pgm.dropTable('external_invites')
  pgm.dropTable('documents')
  pgm.dropTable('budget_items')
  pgm.dropTable('payments')
  pgm.dropTable('deal_events')
  pgm.dropConstraint('vendor_busy_dates', 'vendor_busy_deal_fk')
  pgm.dropConstraint('slots', 'slots_deal_unique')
  pgm.dropColumns('slots', ['deal_id'])
  pgm.dropTable('deals')
}
