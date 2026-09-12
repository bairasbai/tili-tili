/**
 * Учёт вызовов языковой модели Тилем (фича 010, В3).
 *
 * Одна строка на каждое обращение к модели — ответила она, отказал провайдер
 * или Тиль ответил заглушкой без вызова. Без этой таблицы дашборд не мог
 * назвать «стоимость LLM» иначе как нулём (RELEASE-BLOCKERS №23), а ноль
 * вместо «не знаем» — обещание за код (R-174). Токены — как их вернул
 * провайдер; стоимость в деньгах не хранится: цены у провайдеров и моделей
 * разные и меняются, умножение — дело владельца.
 *
 * Ссылка на реплику Тиля — `SET NULL`: переписку чистят вместе с чатом, а
 * расход уже понесён и остаётся в учёте до удаления свадьбы (каскад).
 */
exports.up = (pgm) => {
  pgm.createTable('tilly_usage', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    chat_id: { type: 'uuid', notNull: true, references: 'chats', onDelete: 'CASCADE' },
    message_id: { type: 'uuid', references: 'messages', onDelete: 'SET NULL' },
    provider: { type: 'text', notNull: true },
    model: { type: 'text', notNull: true },
    input_tokens: { type: 'integer', notNull: true, default: 0 },
    output_tokens: { type: 'integer', notNull: true, default: 0 },
    latency_ms: { type: 'integer', notNull: true },
    outcome: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('tilly_usage', 'tilly_usage_outcome', "CHECK (outcome in ('answered', 'failed', 'stub'))")
  pgm.createIndex('tilly_usage', 'created_at')
  pgm.createIndex('tilly_usage', ['wedding_id', 'created_at'])
}

exports.down = (pgm) => {
  pgm.dropTable('tilly_usage')
}
