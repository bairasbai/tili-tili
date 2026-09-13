/**
 * Заметки команды свадьбы (фича 014, блокер №7 — решение владельца 2026-09-13).
 *
 * До этого заметки жили в `localStorage` одного телефона: второй партнёр их
 * не видел, смена устройства их теряла, а экран честно писал «хранятся
 * только на этом устройстве». Настройка живёт там, где живёт действие
 * (R-173) — заметка про торт нужна обоим, значит хранится у свадьбы.
 *
 * Автор — `SET NULL`: стёртый аккаунт уносит имя, но не идею; заметки
 * уходят вместе со свадьбой каскадом, как и всё её содержимое. Предел
 * длины — в ограничении, а не только в схеме тела (инвариант §5.11).
 */
exports.up = (pgm) => {
  pgm.createTable('notes', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    author_id: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    text: { type: 'text', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint('notes', 'notes_text_length', 'CHECK (length(text) BETWEEN 1 AND 2000)')
  // Читается одним способом: заметки свадьбы, свежие первыми.
  pgm.createIndex('notes', ['wedding_id', 'created_at'])
}

exports.down = (pgm) => {
  pgm.dropTable('notes')
}
