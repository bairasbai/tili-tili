/* Этап 8: лиды, отзывы, жалобы, верификация, признак сотрудника.
 *
 * Отзыв — это право, а не запись: его можно оставить только по завершённой
 * сделке и только один раз. Оба условия держатся ограничениями базы, а не
 * проверками в обработчике: «один отзыв на сделку» проверкой в коде
 * означает два отзыва при двух одновременных отправках.
 */
exports.up = (pgm) => {
  pgm.createTable('leads', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    message: { type: 'text' },
    state: { type: 'text', notNull: true, default: 'new' },
    hold_until: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('leads', 'leads_state_known', "CHECK (state IN ('new','replied','hold','declined','won'))")
  // Пара пишет подрядчику второй раз — это тот же лид, а не новый.
  pgm.createIndex('leads', ['vendor_id', 'wedding_id'], { unique: true })
  pgm.createIndex('leads', ['vendor_id', 'state'])

  pgm.createTable('reviews', {
    id: { type: 'uuid', primaryKey: true },
    vendor_id: { type: 'uuid', notNull: true, references: 'vendors', onDelete: 'CASCADE' },
    wedding_id: { type: 'uuid', references: 'weddings', onDelete: 'SET NULL' },
    // Заполнен у отзыва пары: он и есть доказательство завершённой сделки.
    deal_id: { type: 'uuid', references: 'deals', onDelete: 'SET NULL' },
    source: { type: 'text', notNull: true },
    // Токен гостя. Паре он не отдаётся никогда — как и в вишлисте (§9).
    guest_token: { type: 'text' },
    stars: { type: 'smallint', notNull: true },
    text: { type: 'text' },
    reply: { type: 'text' },
    replied_at: { type: 'timestamptz' },
    // Скрытый модератором отзыв в рейтинг не идёт и наружу не показывается.
    hidden_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    moderated_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('reviews', 'reviews_source_known', "CHECK (source IN ('couple','guest'))")
  pgm.addConstraint('reviews', 'reviews_stars_range', 'CHECK (stars BETWEEN 1 AND 5)')
  /* Отзыв пары — один на сделку, отзыв гостя — один на подрядчика.
   * Условие «источник соответствует ключу» тоже здесь: отзыв пары без
   * сделки и отзыв гостя без токена одинаково бессмысленны. */
  pgm.addConstraint(
    'reviews',
    'reviews_key_matches_source',
    "CHECK ((source = 'couple' AND deal_id IS NOT NULL AND guest_token IS NULL)" +
      " OR (source = 'guest' AND guest_token IS NOT NULL AND deal_id IS NULL))",
  )
  pgm.createIndex('reviews', 'deal_id', { unique: true, where: 'deal_id IS NOT NULL' })
  pgm.createIndex('reviews', ['guest_token', 'vendor_id'], { unique: true, where: 'guest_token IS NOT NULL' })
  pgm.createIndex('reviews', ['vendor_id', 'created_at'])

  pgm.createTable('complaints', {
    id: { type: 'uuid', primaryKey: true },
    reporter_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    target_kind: { type: 'text', notNull: true },
    target_id: { type: 'uuid', notNull: true },
    category: { type: 'text', notNull: true },
    text: { type: 'text' },
    status: { type: 'text', notNull: true, default: 'new' },
    resolution: { type: 'text' },
    note: { type: 'text' },
    resolved_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'complaints',
    'complaints_target_known',
    "CHECK (target_kind IN ('vendor','review','message','deal'))",
  )
  pgm.addConstraint(
    'complaints',
    'complaints_category_known',
    "CHECK (category IN ('fraud','content','no_show','spam'))",
  )
  pgm.addConstraint('complaints', 'complaints_status_known', "CHECK (status IN ('new','resolved'))")
  // Очередь модерации: сначала новые, внутри — по дате. SLA 24 часа.
  pgm.createIndex('complaints', ['status', 'created_at'])
  // Одна жалоба от человека на один объект: вторая — это не второй сигнал,
  // а второе нажатие.
  pgm.createIndex('complaints', ['reporter_id', 'target_kind', 'target_id'], {
    unique: true,
    where: 'reporter_id IS NOT NULL',
  })

  /* Таблица `vendor_verifications` заведена ещё на этапе 3 вместе с анкетой:
   * галочка «проверен» была нужна каталогу с самого начала. Здесь только
   * индекс под очередь модерации — она разбирает заявки по времени подачи. */
  pgm.createIndex('vendor_verifications', ['status', 'created_at'])

  /* Словарь синонимов категорий (План §19.2): «тамада» — это «ведущий»,
   * «сладкий стол» — «кондитер». Человек ищет тем словом, которым говорит,
   * а не тем, которым названа категория в справочнике. */
  pgm.createTable('category_synonyms', {
    word: { type: 'text', primaryKey: true },
    category_id: { type: 'text', notNull: true, references: 'categories', onDelete: 'CASCADE' },
  })
  pgm.createIndex('category_synonyms', 'category_id')

  /* Сотрудник платформы. Признак в базе и НЕТ пути, который его выдаёт:
   * эндпоинт «сделай меня админом» — это повышение прав в один запрос,
   * сколько его ни защищай. Ставится руками в базе при найме. */
  pgm.addColumns('users', { is_staff: { type: 'boolean', notNull: true, default: false } })

  /* Санкции по возрастанию (§18.2): предупреждение → понижение в выдаче →
   * блокировка. Понижение и блокировка видны каталогу, предупреждение —
   * только в журнале жалоб. */
  pgm.addColumns('vendors', {
    downranked_at: { type: 'timestamptz' },
    blocked_at: { type: 'timestamptz' },
    // Просмотры анкеты — первая ступень воронки в аналитике кабинета.
    views: { type: 'integer', notNull: true, default: 0 },
  })
}

exports.down = (pgm) => {
  pgm.dropColumns('vendors', ['downranked_at', 'blocked_at', 'views'])
  pgm.dropColumns('users', ['is_staff'])
  pgm.dropTable('category_synonyms')
  pgm.dropIndex('vendor_verifications', ['status', 'created_at'])
  pgm.dropTable('complaints')
  pgm.dropTable('reviews')
  pgm.dropTable('leads')
}
