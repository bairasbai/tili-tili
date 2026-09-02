/* Этап 1: пользователи, сессии, согласия, коды из SMS, настройки, аудит, города.
 *
 * Инварианты живут здесь, а не в обработчиках (План §1): один телефон — один
 * аккаунт, один refresh — одна сессия, запись аудита не переписывается.
 */
const fs = require('node:fs')
const path = require('node:path')

exports.up = (pgm) => {
  // Триграммы — для автокомплита городов подстрокой («сиб» → Сибай).
  pgm.createExtension('pg_trgm', { ifNotExists: true })

  /* ── пользователи ─────────────────────────────────────────────────── */
  pgm.createTable('users', {
    id: { type: 'uuid', primaryKey: true },
    // E.164. Уникальность на уровне БД, а не проверкой в коде: два
    // одновременных подтверждения кода иначе заведут два аккаунта на номер.
    phone: { type: 'text', notNull: true, unique: true },
    email: { type: 'citext', unique: true },
    name: { type: 'text' },
    lang: { type: 'char(2)', notNull: true, default: 'ru' },
    tz: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // Мягкое удаление на 30 дней (План §19.1); кроном — окончательное.
    deleted_at: { type: 'timestamptz' },
  })
  pgm.addConstraint('users', 'users_phone_e164', "CHECK (phone ~ '^\\+[1-9][0-9]{7,14}$')")
  pgm.addConstraint('users', 'users_lang_known', "CHECK (lang IN ('ru','en'))")
  pgm.createIndex('users', 'deleted_at', { where: 'deleted_at IS NOT NULL' })

  /* ── сессии ───────────────────────────────────────────────────────── */
  pgm.createTable('sessions', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    // Хранится хеш, а не сам refresh: утечка таблицы не даёт войти.
    refresh_hash: { type: 'text', notNull: true, unique: true },
    device: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    last_used_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    revoked_at: { type: 'timestamptz' },
  })
  pgm.createIndex('sessions', ['user_id', 'revoked_at'])

  /* ── согласия на обработку ПДн ────────────────────────────────────── */
  pgm.createTable('consents', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    policy_version: { type: 'text', notNull: true },
    given_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ip: { type: 'inet' },
    withdrawn_at: { type: 'timestamptz' },
  })
  pgm.createIndex('consents', ['user_id', 'withdrawn_at'])

  /* ── коды из SMS ──────────────────────────────────────────────────── */
  pgm.createTable('otp_codes', {
    id: { type: 'uuid', primaryKey: true },
    phone: { type: 'text', notNull: true },
    // Хеш с серверным секретом. Четыре цифры — это 10 000 вариантов:
    // без секрета утечка таблицы вскрывается перебором за секунду.
    code_hash: { type: 'text', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
    attempts: { type: 'integer', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    consumed_at: { type: 'timestamptz' },
    ip: { type: 'inet' },
  })
  pgm.createIndex('otp_codes', ['phone', 'created_at'])
  // Больше пяти попыток ввода — код мёртв. Ограничение в БД, потому что
  // счётчик в памяти обнуляется при перезапуске, а перебор — нет.
  pgm.addConstraint('otp_codes', 'otp_attempts_bounded', 'CHECK (attempts >= 0 AND attempts <= 5)')

  /* ── настройки уведомлений ────────────────────────────────────────── */
  pgm.createTable('notification_prefs', {
    user_id: { type: 'uuid', primaryKey: true, references: 'users', onDelete: 'CASCADE' },
    tasks: { type: 'boolean', notNull: true, default: true },
    chats: { type: 'boolean', notNull: true, default: true },
    deals: { type: 'boolean', notNull: true, default: true },
    tips: { type: 'boolean', notNull: true, default: true },
    quiet_from: { type: 'time', notNull: true, default: '22:00' },
    quiet_to: { type: 'time', notNull: true, default: '09:00' },
  })

  /* ── журнал действий ──────────────────────────────────────────────── */
  pgm.createTable('audit_log', {
    id: { type: 'bigserial', primaryKey: true },
    actor_id: { type: 'uuid' },
    action: { type: 'text', notNull: true },
    entity: { type: 'text' },
    entity_id: { type: 'uuid' },
    diff: { type: 'jsonb' },
    at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('audit_log', ['entity', 'entity_id'])
  // Журнал только дописывается. Отзыв прав у роли приложения — правильный
  // способ, но он делается при развёртывании; триггер работает и в разработке,
  // и когда приложение по ошибке подключилось владельцем базы.
  pgm.sql(`
    CREATE FUNCTION audit_log_append_only() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'audit_log только дописывается: % запрещён', TG_OP;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER audit_log_no_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
  `)

  /* ── города ───────────────────────────────────────────────────────── */
  pgm.createTable('cities', {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'text', notNull: true },
    region: { type: 'text', notNull: true },
    district: { type: 'text' },
    big: { type: 'boolean', notNull: true, default: false },
    lat: { type: 'double precision' },
    lon: { type: 'double precision' },
    population: { type: 'integer' },
  })
  // Нормализованное имя — вычисляемая колонка, а не забота обработчика:
  // «Белорецк» ищется и по «белорецк», и по «белорeцк» с ё.
  pgm.sql(`
    ALTER TABLE cities
      ADD COLUMN name_norm text
      GENERATED ALWAYS AS (lower(replace(name, 'ё', 'е'))) STORED
  `)
  // Два индекса на одну колонку — это два разных вопроса: «начинается с» и
  // «содержит». Один префиксный индекс на подстроку не работает.
  pgm.sql('CREATE INDEX cities_name_norm_prefix ON cities (name_norm text_pattern_ops)')
  pgm.sql('CREATE INDEX cities_name_norm_trgm ON cities USING gin (name_norm gin_trgm_ops)')
  pgm.createIndex('cities', ['lat', 'lon'], { where: 'lat IS NOT NULL' })

  // Сид одним запросом из JSON. pgm.sql принимает только строку, поэтому
  // данные вставляются долларовым литералом — экранировать кавычки в русских
  // названиях не нужно, а `$cities$` в них не встречается.
  const file = path.join(__dirname, 'data', 'cities.json')
  const json = fs.readFileSync(file, 'utf8')
  if (json.includes('$cities$')) throw new Error('сид содержит разделитель долларового литерала')
  pgm.sql(`
    INSERT INTO cities (id, name, region, district, big, lat, lon)
    SELECT (c->>'id')::int, c->>'name', c->>'region', c->>'district',
           (c->>'big')::boolean, (c->>'lat')::float8, (c->>'lon')::float8
    FROM jsonb_array_elements($cities$${json}$cities$::jsonb) AS c
  `)
}

exports.down = (pgm) => {
  pgm.dropTable('cities')
  pgm.sql('DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log')
  pgm.sql('DROP FUNCTION IF EXISTS audit_log_append_only()')
  pgm.dropTable('audit_log')
  pgm.dropTable('notification_prefs')
  pgm.dropTable('otp_codes')
  pgm.dropTable('consents')
  pgm.dropTable('sessions')
  pgm.dropTable('users')
  pgm.dropExtension('pg_trgm', { ifExists: true })
}
