/**
 * Чат своего подрядчика привязывается к СДЕЛКЕ, а не к слоту (фича 005, В1).
 *
 * Слот переживает подрядчика: пара убрала флориста А и позвала Б — слот тот
 * же, а чат по слоту один, и Б получал всю переписку с А (реплики, телефон,
 * цены — ПДн третьего лица, ERR-0219). Обход фильтровал историю по дате
 * текущей сделки; дата — не ключ, и правило жило в обработчике, а не в базе
 * (CLAUDE.md §5 п. 11). Теперь у каждой сделки свой чат: уникальный индекс
 * по `deal_id` не даёт второму подрядчику попасть в переписку первого.
 *
 * `slot_id` остаётся: по нему список чатов пары находит слот, а сделка
 * его и так знает. Уникальность по слоту снимается — прежний подрядчик
 * остаётся у пары закрытым чатом рядом с новым.
 *
 * Заполнение существующих строк: чат слота уходит его текущей (или, если
 * все отменены, последней) своей сделке; прежним сделкам того же слота
 * заводятся свои чаты, и их реплики переезжают туда по времени сделки.
 * Внешние чаты без единой своей сделки в слоте кодом недостижимы (чат
 * заводится вместе со сделкой) и сообщений не имеют — удаляются.
 */
exports.up = (pgm) => {
  pgm.addColumns('chats', {
    deal_id: { type: 'uuid', references: 'deals', onDelete: 'CASCADE' },
  })

  // Второй чат на слот запрещал старый индекс — снимается до заполнения.
  pgm.dropIndex('chats', ['wedding_id', 'slot_id'], { unique: true, where: "kind = 'external'" })

  pgm.sql(`
    -- Текущая своя сделка слота, иначе последняя.
    UPDATE chats c SET deal_id = (
      SELECT d.id FROM deals d
       WHERE d.slot_id = c.slot_id AND d.external_name IS NOT NULL
       ORDER BY (d.state <> 'cancelled') DESC, d.created_at DESC
       LIMIT 1)
     WHERE c.kind = 'external';

    -- Прежним своим сделкам того же слота — по своему чату.
    INSERT INTO chats (id, wedding_id, kind, slot_id, deal_id)
    SELECT gen_random_uuid(), d.wedding_id, 'external', d.slot_id, d.id
      FROM deals d
     WHERE d.external_name IS NOT NULL AND d.slot_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM chats c WHERE c.kind = 'external' AND c.slot_id = d.slot_id)
       AND NOT EXISTS (SELECT 1 FROM chats c WHERE c.kind = 'external' AND c.deal_id = d.id);

    -- Реплика принадлежит сделке, которая была текущей в момент её отправки:
    -- своей сделке слота, в чьё окно [создана; создана следующая) она попала.
    -- Окна считаются один раз (коррелированный вариант шёл минутами).
    WITH spans AS (
      SELECT d.id AS deal_id, d.slot_id, d.created_at AS from_at,
             lead(d.created_at) OVER (PARTITION BY d.slot_id ORDER BY d.created_at) AS to_at
        FROM deals d WHERE d.external_name IS NOT NULL AND d.slot_id IS NOT NULL
    ), moves AS (
      SELECT m.id AS message_id, t.id AS chat_id
        FROM messages m
        JOIN chats src ON src.id = m.chat_id AND src.kind = 'external'
        JOIN spans s ON s.slot_id = src.slot_id
                    AND m.created_at >= s.from_at AND (s.to_at IS NULL OR m.created_at < s.to_at)
        JOIN chats t ON t.kind = 'external' AND t.deal_id = s.deal_id
       WHERE t.id <> m.chat_id
    )
    UPDATE messages m SET chat_id = moves.chat_id FROM moves WHERE m.id = moves.message_id;

    DELETE FROM chats WHERE kind = 'external' AND deal_id IS NULL;
  `)

  pgm.addConstraint('chats', 'chats_deal_only_for_external', "CHECK ((kind = 'external') = (deal_id IS NOT NULL))")
  pgm.createIndex('chats', ['deal_id'], { unique: true, where: "kind = 'external'" })
}

exports.down = (pgm) => {
  /* Обратно — один чат на слот: остаётся чат текущей (или последней) сделки,
   * реплики остальных переезжают в него, лишние чаты удаляются. */
  pgm.sql(`
    WITH keep AS (
      SELECT DISTINCT ON (c.slot_id) c.slot_id, c.id
        FROM chats c JOIN deals d ON d.id = c.deal_id
       WHERE c.kind = 'external'
       ORDER BY c.slot_id, (d.state <> 'cancelled') DESC, d.created_at DESC
    )
    UPDATE messages m SET chat_id = k.id
      FROM chats c JOIN keep k ON k.slot_id = c.slot_id
     WHERE m.chat_id = c.id AND c.kind = 'external' AND c.id <> k.id;

    DELETE FROM chats c
     WHERE c.kind = 'external'
       AND c.id <> (
         SELECT c3.id FROM chats c3 JOIN deals d3 ON d3.id = c3.deal_id
          WHERE c3.kind = 'external' AND c3.slot_id = c.slot_id
          ORDER BY (d3.state <> 'cancelled') DESC, d3.created_at DESC LIMIT 1);
  `)
  pgm.createIndex('chats', ['wedding_id', 'slot_id'], { unique: true, where: "kind = 'external'" })
  pgm.dropIndex('chats', ['deal_id'], { unique: true, where: "kind = 'external'" })
  pgm.dropConstraint('chats', 'chats_deal_only_for_external')
  pgm.dropColumns('chats', ['deal_id'])
}
