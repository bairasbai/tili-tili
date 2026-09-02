/* Этап 2: свадьба, команда, приглашения, рефералы.
 *
 * Заодно заводятся `categories`, `slots`, `tasks`, `timeline_events`: создание
 * свадьбы обязано сразу выдать мозаику из 12 слотов, 12 системных задач
 * и шаблон тайминга (План, этап 2). Обработчики для них приходят на этапах
 * 4 и 5 — таблицы нужны раньше, потому что данные создаются здесь.
 */
const fs = require('node:fs')
const path = require('node:path')

exports.up = (pgm) => {
  /* ── справочник категорий ─────────────────────────────────────────── */
  pgm.createTable('categories', {
    id: { type: 'text', primaryKey: true },
    name: { type: 'text', notNull: true },
    icon: { type: 'text' },
    tile: { type: 'text' },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  const categoriesJson = fs.readFileSync(path.join(__dirname, 'data', 'categories.json'), 'utf8')
  if (categoriesJson.includes('$cats$')) throw new Error('сид содержит разделитель долларового литерала')
  pgm.sql(`
    INSERT INTO categories (id, name, icon, tile, sort)
    SELECT c->>'id', c->>'name', c->>'icon', c->>'tile', (ord - 1)::int
    FROM jsonb_array_elements($cats$${categoriesJson}$cats$::jsonb) WITH ORDINALITY AS x(c, ord)
  `)

  /* ── свадьба ──────────────────────────────────────────────────────── */
  pgm.createTable('weddings', {
    id: { type: 'uuid', primaryKey: true },
    owner_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    date: { type: 'date' },
    city_id: { type: 'integer', references: 'cities' },
    venue: { type: 'text' },
    style: { type: 'text' },
    guests_planned: { type: 'integer' },
    // Деньги — копейки плюс валюта рядом. Одна колонка без второй означает,
    // что через год суммы в евро придётся отличать от рублей по догадке.
    budget_total: { type: 'bigint' },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    tz: { type: 'text' },
    invite_theme_id: { type: 'smallint', notNull: true, default: 0 },
    invite_text: { type: 'text' },
    // Публичный код для /join/:code. Уникальность в БД, а не проверкой в коде.
    invite_code: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    archived_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('weddings', 'weddings_currency_rub', "CHECK (currency = 'RUB')")
  pgm.addConstraint('weddings', 'weddings_budget_nonneg', 'CHECK (budget_total IS NULL OR budget_total >= 0)')
  pgm.createIndex('weddings', 'date')
  pgm.createIndex('weddings', 'owner_id')

  /* ── команда ──────────────────────────────────────────────────────── */
  pgm.createTable('wedding_members', {
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    joined_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('wedding_members', 'wedding_members_pk', { primaryKey: ['wedding_id', 'user_id'] })
  pgm.addConstraint(
    'wedding_members',
    'wedding_members_role_known',
    "CHECK (role IN ('couple','helper','coordinator','vendor'))",
  )
  pgm.createIndex('wedding_members', 'user_id')

  /* ── приглашения в команду ────────────────────────────────────────── */
  pgm.createTable('invites', {
    code: { type: 'text', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    role: { type: 'text', notNull: true },
    label: { type: 'text' },
    created_by: { type: 'uuid', references: 'users' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    // Одноразовость держится условием `accepted_at IS NULL` в UPDATE, а не
    // проверкой «а принято ли уже»: два одновременных перехода по ссылке
    // иначе добавили бы в команду двоих.
    accepted_by: { type: 'uuid', references: 'users' },
    accepted_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('invites', 'invites_role_known', "CHECK (role IN ('couple','helper','coordinator','vendor'))")
  pgm.createIndex('invites', ['wedding_id', 'revoked_at'])

  /* ── рефералы ─────────────────────────────────────────────────────── */
  pgm.createTable('referrals', {
    code: { type: 'text', primaryKey: true },
    owner_id: { type: 'uuid', notNull: true, unique: true, references: 'users', onDelete: 'CASCADE' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createTable('referral_uses', {
    // Один код на аккаунт — гарантия уникальностью, а не проверкой в коде.
    invited_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    code: { type: 'text', notNull: true, references: 'referrals', onDelete: 'CASCADE' },
    applied_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    earned: { type: 'bigint', notNull: true, default: 0 },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
  })
  pgm.createIndex('referral_uses', 'code')

  /* ── мозаика, задачи, тайминг ─────────────────────────────────────── */
  pgm.createTable('slots', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    category_id: { type: 'text', notNull: true, references: 'categories' },
    label: { type: 'text', notNull: true },
    sort: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('slots', ['wedding_id', 'sort'])

  pgm.createTable('tasks', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    title: { type: 'text', notNull: true },
    period: { type: 'text' },
    due: { type: 'date' },
    source: { type: 'text', notNull: true, default: 'user' },
    sort: { type: 'integer', notNull: true, default: 0 },
    done_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('tasks', 'tasks_source_known', "CHECK (source IN ('system','user','ai'))")
  pgm.createIndex('tasks', ['wedding_id', 'done_at'])

  pgm.createTable('timeline_events', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    location: { type: 'text' },
    starts_at: { type: 'timestamptz' },
    ends_at: { type: 'timestamptz' },
    who: { type: 'text' },
    icon: { type: 'text' },
    sort: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.createIndex('timeline_events', ['wedding_id', 'sort'])
}

exports.down = (pgm) => {
  pgm.dropTable('timeline_events')
  pgm.dropTable('tasks')
  pgm.dropTable('slots')
  pgm.dropTable('referral_uses')
  pgm.dropTable('referrals')
  pgm.dropTable('invites')
  pgm.dropTable('wedding_members')
  pgm.dropTable('weddings')
  pgm.dropTable('categories')
}
