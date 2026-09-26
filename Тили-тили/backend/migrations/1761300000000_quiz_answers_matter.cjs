/**
 * Фича 018 «Ответы квиза влияют на свадьбу» (tasks/фичи/018-квиз-влияет).
 *
 * `weddings.format` и `weddings.planner` — коды ответов квиза «Какой формат?»
 * и «Кто планирует?». Пусто — «не указано»: вопрос пропущен или свадьба
 * заведена раньше. Бэкфилла нет — существующие свадьбы не меняются (решение
 * владельца). Допустимые коды держит CHECK, а не обработчик (CLAUDE.md §5
 * п. 11): код, записанный мимо API, упрётся в базу.
 *
 * `slots.prebooked_at` — «уже забронировано вне приложения» из квиза. Только
 * у слота без сделки: CHECK запрещает отметку рядом со сделкой, поэтому бронь
 * снимает её тем же UPDATE, что захватывает слот, — дверь брони, которая
 * забыла бы снять отметку, упадёт на ограничении, а не оставит слот и
 * забронированным, и «уже забронированным». Колонка новая и пустая —
 * нарушителей на действующей базе нет, проверка ставится сразу проверенной.
 *
 * Номер — после трёх миграций ветки 017 (1761000000000…1761200000000), чтобы
 * с ними не совпасть. Сольётся 017 первой — порядок номеров совпадёт с порядком
 * применения; позже — базе, где эта миграция уже накатана, миграции 017
 * понадобится `--check-order false` (CI каждый раз поднимает чистую базу).
 */
exports.up = (pgm) => {
  pgm.addColumns('weddings', {
    format: { type: 'text' },
    planner: { type: 'text' },
  })
  pgm.addConstraint(
    'weddings',
    'weddings_format_known',
    "CHECK (format IS NULL OR format IN ('classic','outdoor','intimate','two_day'))",
  )
  pgm.addConstraint('weddings', 'weddings_planner_known', "CHECK (planner IS NULL OR planner IN ('self','agency','coordinator'))")

  pgm.addColumns('slots', { prebooked_at: { type: 'timestamptz' } })
  pgm.addConstraint('slots', 'slots_prebooked_without_deal', 'CHECK (prebooked_at IS NULL OR deal_id IS NULL)')
}

exports.down = (pgm) => {
  pgm.dropConstraint('slots', 'slots_prebooked_without_deal')
  pgm.dropColumns('slots', ['prebooked_at'])
  pgm.dropConstraint('weddings', 'weddings_planner_known')
  pgm.dropConstraint('weddings', 'weddings_format_known')
  pgm.dropColumns('weddings', ['format', 'planner'])
}
