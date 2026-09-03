/* Чат исполнителей: координатор и забронированные подрядчики, без пары.
 *
 * Решение владельца 2026-09-03. Смысл рабочий: фотограф с декоратором
 * договариваются, во сколько ставить свет, и не грузят этим пару — за то
 * координатора и нанимают. Пара переписку не читает, но видит в списке
 * строку «Чат исполнителей — ведёт координатор»: скрытый чат, о котором
 * не сказали, становится скандалом ровно в тот день, когда о нём узнают.
 *
 * Заводится там же, где командный, — на второй брони. С одним подрядчиком
 * координировать некого.
 */
exports.up = (pgm) => {
  pgm.dropConstraint('chats', 'chats_kind_known')
  pgm.addConstraint(
    'chats',
    'chats_kind_known',
    "CHECK (kind IN ('vendor','team','day','tilly','external','crew'))",
  )

  /* Один чат исполнителей на свадьбу держит прежний уникальный индекс
   * `(wedding_id, kind) WHERE kind NOT IN ('vendor','external')` —
   * он покрывает любой новый одиночный вид, и трогать его не нужно. */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION team_chat_on_second_deal() RETURNS trigger AS $$
    BEGIN
      IF NEW.state IN ('booked','paid_deposit','done')
         AND (SELECT count(*) FROM deals d
               WHERE d.wedding_id = NEW.wedding_id
                 AND d.state IN ('booked','paid_deposit','done')) >= 2 THEN
        INSERT INTO chats (id, wedding_id, kind)
        VALUES (gen_random_uuid(), NEW.wedding_id, 'team'),
               (gen_random_uuid(), NEW.wedding_id, 'crew')
        ON CONFLICT DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `)

  // У кого командный чат уже есть — у того есть и вторая бронь.
  pgm.sql(`
    INSERT INTO chats (id, wedding_id, kind)
    SELECT gen_random_uuid(), c.wedding_id, 'crew' FROM chats c WHERE c.kind = 'team'
    ON CONFLICT DO NOTHING;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DELETE FROM chats WHERE kind = 'crew';

    CREATE OR REPLACE FUNCTION team_chat_on_second_deal() RETURNS trigger AS $$
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
  `)
  pgm.dropConstraint('chats', 'chats_kind_known')
  pgm.addConstraint('chats', 'chats_kind_known', "CHECK (kind IN ('vendor','team','day','tilly','external'))")
}
