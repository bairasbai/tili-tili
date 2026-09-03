/* Этап 6: вишлист, складчина, денежные фонды, «просим не дарить».
 *
 * Главное правило раздела 9 бизнес-логики — анонимность резерва. Пара видит
 * «занято», но не видит кем. Поэтому имя дарителя здесь не хранится вовсе:
 * в таблице лежит его гостевой токен, и ни один запрос пары эту колонку
 * не читает. Нечего отдать — нечего и утечь.
 */
exports.up = (pgm) => {
  pgm.createTable('gifts', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    // Значок из §9. Плитка (`tile`) не хранится: это цвет из палитры,
    // считается на клиенте по месту в списке — дизайн-токен, не данные.
    icon: { type: 'text' },
    descr: { type: 'text' },
    price: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    is_group: { type: 'boolean', notNull: true, default: false },
    // Производное значение: сумму ведёт триггер по строкам взносов.
    funded: { type: 'bigint', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('gifts', 'gifts_price_positive', 'CHECK (price > 0)')
  pgm.addConstraint('gifts', 'gifts_currency_rub', "CHECK (currency = 'RUB')")
  // Сложиться можно ровно до цены. Верхняя граница здесь, а не в обработчике:
  // взнос приходит из двух мест (складчина и уборка резерва), а правило одно.
  pgm.addConstraint('gifts', 'gifts_funded_bounded', 'CHECK (funded >= 0 AND funded <= price)')
  pgm.createIndex('gifts', 'wedding_id')

  /* Первичный ключ по gift_id — вторая строка физически невозможна.
   * Флаг `reserved = true` проверялся бы в обработчике, и два одновременных
   * запроса прошли бы оба: подарок подарен дважды, гости в неловкости. */
  pgm.createTable('gift_reservations', {
    gift_id: { type: 'uuid', primaryKey: true, references: 'gifts', onDelete: 'CASCADE' },
    guest_token: { type: 'text', notNull: true },
    reserved_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })

  pgm.createTable('gift_contributions', {
    id: { type: 'uuid', primaryKey: true },
    gift_id: { type: 'uuid', notNull: true, references: 'gifts', onDelete: 'CASCADE' },
    guest_token: { type: 'text', notNull: true },
    amount: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    idempotency_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('gift_contributions', 'gift_contributions_amount_positive', 'CHECK (amount > 0)')
  /* Ключ уникален В ПРЕДЕЛАХ ГОСТЯ, а не глобально. Глобальная уникальность
   * означала бы, что гость, выбравший ключ «1», закрывает этот ключ всем
   * остальным гостям всех свадеб — отказ в обслуживании из-за совпадения. */
  pgm.addConstraint('gift_contributions', 'gift_contributions_key_per_guest', {
    unique: ['guest_token', 'idempotency_key'],
  })
  pgm.createIndex('gift_contributions', 'gift_id')

  pgm.createTable('funds', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    icon: { type: 'text' },
    target: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    collected: { type: 'bigint', notNull: true, default: 0 },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('funds', 'funds_target_positive', 'CHECK (target > 0)')
  pgm.addConstraint('funds', 'funds_currency_rub', "CHECK (currency = 'RUB')")
  /* Верхней границы нет намеренно: цель — ориентир, а не касса. Подарок
   * закрывается на 100 %, потому что он один; фонд «на путешествие» перебор
   * не ломает, и отказывать гостю, который внёс больше, не за что. */
  pgm.addConstraint('funds', 'funds_collected_nonneg', 'CHECK (collected >= 0)')
  pgm.createIndex('funds', 'wedding_id')

  pgm.createTable('fund_contributions', {
    id: { type: 'uuid', primaryKey: true },
    fund_id: { type: 'uuid', notNull: true, references: 'funds', onDelete: 'CASCADE' },
    guest_token: { type: 'text', notNull: true },
    amount: { type: 'bigint', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'RUB' },
    idempotency_key: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('fund_contributions', 'fund_contributions_amount_positive', 'CHECK (amount > 0)')
  pgm.addConstraint('fund_contributions', 'fund_contributions_key_per_guest', {
    unique: ['guest_token', 'idempotency_key'],
  })
  pgm.createIndex('fund_contributions', 'fund_id')

  /* «Просим не дарить» — список строк, а не сущность: у пункта нет ни
   * состояния, ни истории. Ключ по тексту сам убирает повторы. */
  pgm.createTable('anti_gifts', {
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    text: { type: 'text', notNull: true },
  })
  pgm.addConstraint('anti_gifts', 'anti_gifts_pk', { primaryKey: ['wedding_id', 'text'] })

  /* Резерв держится на гостевом токене, а у токена нет внешнего ключа на
   * гостя: удалённый из списка человек оставлял бы подарок «занятым»
   * навсегда, и подарить его не смог бы уже никто. Уборка — триггером,
   * а не в обработчике: строка гостя исчезает и мимо кода (каскадом).
   *
   * То же при СМЕНЕ токена. Перевыпуск ссылки выдаёт гостю новую личность,
   * и старый резерв остался бы висеть на мёртвом токене: ни снять, ни
   * подарить. Одно правило на оба случая — токена не стало, резервов нет. */
  pgm.sql(`
    CREATE FUNCTION release_guest_reservations() RETURNS trigger AS $$
    BEGIN
      DELETE FROM gift_reservations r USING gifts g
       WHERE r.gift_id = g.id
         AND g.wedding_id = OLD.wedding_id
         AND r.guest_token = OLD.rsvp_token;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guests_release_reservations
      AFTER DELETE OR UPDATE OF rsvp_token ON guests
      FOR EACH ROW EXECUTE FUNCTION release_guest_reservations();
  `)

  /* Счётчики ведут триггеры, а не обработчики (ERR-0040). Строка взноса
   * может исчезнуть мимо кода — каскадом при удалении подарка, — и сумма
   * осталась бы висеть. Переполнение ловит CHECK и откатывает транзакцию;
   * обработчик переводит это в 409. */
  pgm.sql(`
    CREATE FUNCTION gift_funded_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE gifts SET funded = funded + NEW.amount WHERE id = NEW.gift_id;
        RETURN NEW;
      ELSE
        UPDATE gifts SET funded = funded - OLD.amount WHERE id = OLD.gift_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER gift_contributions_sum
      AFTER INSERT OR DELETE ON gift_contributions
      FOR EACH ROW EXECUTE FUNCTION gift_funded_counter();

    CREATE FUNCTION fund_collected_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE funds SET collected = collected + NEW.amount WHERE id = NEW.fund_id;
        RETURN NEW;
      ELSE
        UPDATE funds SET collected = collected - OLD.amount WHERE id = OLD.fund_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER fund_contributions_sum
      AFTER INSERT OR DELETE ON fund_contributions
      FOR EACH ROW EXECUTE FUNCTION fund_collected_counter();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS guests_release_reservations ON guests;
    DROP FUNCTION IF EXISTS release_guest_reservations;
    DROP TRIGGER IF EXISTS fund_contributions_sum ON fund_contributions;
    DROP FUNCTION IF EXISTS fund_collected_counter;
    DROP TRIGGER IF EXISTS gift_contributions_sum ON gift_contributions;
    DROP FUNCTION IF EXISTS gift_funded_counter;
  `)
  pgm.dropTable('anti_gifts')
  pgm.dropTable('fund_contributions')
  pgm.dropTable('funds')
  pgm.dropTable('gift_contributions')
  pgm.dropTable('gift_reservations')
  pgm.dropTable('gifts')
}
