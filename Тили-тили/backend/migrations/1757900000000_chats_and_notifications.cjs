/* Этап 7: чаты, уведомления, подписки на push, режим дня X.
 *
 * Чат дня X создаётся ВМЕСТЕ со свадьбой и до срока закрыт, а не появляется
 * в нужный момент из воздуха: гость и команда должны видеть в списке, что он
 * есть и когда откроется. Открытие — это снятие `opens_at`, а не создание.
 */
exports.up = (pgm) => {
  pgm.createTable('chats', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    // Заполнен только у kind='vendor'.
    vendor_id: { type: 'uuid', references: 'vendors', onDelete: 'CASCADE' },
    // Только у kind='day': до этого времени чат виден, но закрыт (423).
    opens_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('chats', 'chats_kind_known', "CHECK (kind IN ('vendor','team','day','tilly'))")
  // Подрядчик в чате обязателен ровно у своего вида чата: строка `vendor`
  // без подрядчика и `team` с подрядчиком одинаково бессмысленны.
  pgm.addConstraint(
    'chats',
    'chats_vendor_only_for_vendor_kind',
    "CHECK ((kind = 'vendor') = (vendor_id IS NOT NULL))",
  )
  pgm.addConstraint('chats', 'chats_opens_only_for_day', "CHECK (opens_at IS NULL OR kind = 'day')")
  // «Написать» нажимают дважды — второй раз должен открыть ТОТ ЖЕ чат.
  pgm.createIndex('chats', ['wedding_id', 'vendor_id'], { unique: true, where: "kind = 'vendor'" })
  // Командный чат, чат дня и Тиль у свадьбы по одному.
  pgm.createIndex('chats', ['wedding_id', 'kind'], { unique: true, where: "kind <> 'vendor'" })

  pgm.createTable('messages', {
    id: { type: 'uuid', primaryKey: true },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    // NULL — сообщение от самого приложения (ответ Тиль, системная запись).
    sender_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    text: { type: 'text', notNull: true },
    attachments: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('messages', ['chat_id', 'created_at'])

  /* Отметка «докуда дочитал» — на пользователя, а не на чат.
   *
   * В списке таблиц плана её нет, но `Chat.unread` из контракта без неё
   * посчитать нечем: «непрочитано» — это отношение между чатом и читателем,
   * и хранить его на чате значило бы, что прочитал один — прочитали все.
   */
  pgm.createTable('chat_reads', {
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    read_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('chat_reads', 'chat_reads_pk', { primaryKey: ['chat_id', 'user_id'] })

  pgm.createTable('notifications', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    kind: { type: 'text', notNull: true },
    title: { type: 'text', notNull: true },
    body: { type: 'text', notNull: true },
    link: { type: 'text' },
    /* Когда уведомление МОЖНО отправить push-ом. В приложении оно видно
     * сразу — тихие часы про звук на телефоне, а не про право знать.
     * Без этого поля «отложить до 09:00» было бы нечем отличить
     * от «выбросить»: и то и другое выглядит как «push не ушёл». */
    deliver_after: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    pushed_at: { type: 'timestamptz' },
    read_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'notifications',
    'notifications_kind_known',
    "CHECK (kind IN ('deal','chat','task','guest','system'))",
  )
  pgm.createIndex('notifications', ['user_id', 'read_at', 'created_at'])
  pgm.createIndex('notifications', ['deliver_after'], { where: 'pushed_at IS NULL' })

  pgm.createTable('push_subscriptions', {
    id: { type: 'uuid', primaryKey: true },
    user_id: { type: 'uuid', notNull: true, references: 'users', onDelete: 'CASCADE' },
    endpoint: { type: 'text', notNull: true, unique: true },
    keys: { type: 'jsonb', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('push_subscriptions', 'user_id')

  /* Режим дня X. План Б в моках — переключатель на экране /dayx, и здесь
   * ровно он: какой сценарий включён и когда. Новая точка сбора не хранится
   * нигде в продукте, поэтому и здесь её нет — выдумывать поле не за чем. */
  pgm.addColumns('weddings', {
    planb_scenario: { type: 'text' },
    planb_at: { type: 'timestamptz' },
  })

  /* Чаты заводит база, а не обработчик.
   *
   * Свадьба создаётся в одном месте, но дата меняется в двух (правка карточки
   * и перенос свадьбы), а сделка становится `booked` в трёх (правка сделки,
   * бронь слота, свой подрядчик). Помнить про чат в каждом — то же самое, что
   * вести счётчик мест руками: один путь однажды забудут (ERR-0040).
   */
  pgm.sql(`
    CREATE FUNCTION day_chat_opens_at(wedding weddings) RETURNS timestamptz AS $$
      SELECT CASE WHEN wedding.date IS NULL THEN NULL
                  ELSE ((wedding.date - INTERVAL '1 day') + TIME '09:00')
                       AT TIME ZONE COALESCE(wedding.tz, 'Europe/Moscow') END;
    $$ LANGUAGE sql STABLE;

    CREATE FUNCTION wedding_chats() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO chats (id, wedding_id, kind, opens_at)
        VALUES (gen_random_uuid(), NEW.id, 'day', day_chat_opens_at(NEW))
        ON CONFLICT DO NOTHING;
        INSERT INTO chats (id, wedding_id, kind)
        VALUES (gen_random_uuid(), NEW.id, 'tilly')
        ON CONFLICT DO NOTHING;
      ELSE
        -- Дату перенесли — чат дня X открывается накануне НОВОЙ даты.
        UPDATE chats SET opens_at = day_chat_opens_at(NEW)
         WHERE wedding_id = NEW.id AND kind = 'day';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER weddings_chats
      AFTER INSERT OR UPDATE OF date, tz ON weddings
      FOR EACH ROW EXECUTE FUNCTION wedding_chats();

    -- Командный чат появляется на ВТОРОЙ сделке в работе (План §8.5):
    -- с одним подрядчиком пара разговаривает в его чате, команда — это
    -- когда людей уже несколько.
    CREATE FUNCTION team_chat_on_second_deal() RETURNS trigger AS $$
    BEGIN
      IF NEW.state IN ('booked','paid_deposit','done')
         AND (SELECT count(*) FROM deals d
               WHERE d.wedding_id = NEW.wedding_id
                 AND d.state IN ('booked','paid_deposit','done')) >= 2 THEN
        INSERT INTO chats (id, wedding_id, kind)
        VALUES (gen_random_uuid(), NEW.wedding_id, 'team')
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER deals_team_chat
      AFTER INSERT OR UPDATE OF state ON deals
      FOR EACH ROW EXECUTE FUNCTION team_chat_on_second_deal();
  `)

  /* Свадьбам, заведённым до этой миграции, чаты нужны так же.
   * `opens_at` — 09:00 накануне по таймзоне пары; таймзона может быть
   * не указана, тогда московская: сервис работает в РФ. */
  pgm.sql(`
    INSERT INTO chats (id, wedding_id, kind, opens_at)
    SELECT gen_random_uuid(), w.id, 'day',
           CASE WHEN w.date IS NULL THEN NULL
                ELSE ((w.date - INTERVAL '1 day') + TIME '09:00')
                     AT TIME ZONE COALESCE(w.tz, 'Europe/Moscow') END
      FROM weddings w
    ON CONFLICT DO NOTHING;

    INSERT INTO chats (id, wedding_id, kind)
    SELECT gen_random_uuid(), w.id, 'tilly' FROM weddings w
    ON CONFLICT DO NOTHING;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS deals_team_chat ON deals;
    DROP FUNCTION IF EXISTS team_chat_on_second_deal;
    DROP TRIGGER IF EXISTS weddings_chats ON weddings;
    DROP FUNCTION IF EXISTS wedding_chats;
    DROP FUNCTION IF EXISTS day_chat_opens_at;
  `)
  pgm.dropColumns('weddings', ['planb_scenario', 'planb_at'])
  pgm.dropTable('push_subscriptions')
  pgm.dropTable('notifications')
  pgm.dropTable('chat_reads')
  pgm.dropTable('messages')
  pgm.dropTable('chats')
}
