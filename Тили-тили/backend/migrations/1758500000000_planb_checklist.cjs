/* Чек-лист плана Б переезжает из браузера на сервер (§13.1).
 *
 * Отдельной сущности не нужно: это задачи со сроком «накануне». Но и
 * смешивать их с чек-листом по месяцам нельзя — это два разных экрана,
 * и «Powerbank и аптечка» в списке дел за полгода выглядит ошибкой.
 *
 * Поэтому вид задачи — колонка с ограничением, а не признак, выведенный
 * из значения `period`: разбирать смысл строки в каждом запросе значит
 * рано или поздно разобрать её по-разному в двух местах.
 */
exports.up = (pgm) => {
  pgm.addColumns('tasks', {
    kind: { type: 'text', notNull: true, default: 'checklist' },
  })
  pgm.addConstraint('tasks', 'tasks_kind_known', "CHECK (kind IN ('checklist','planb'))")
  pgm.createIndex('tasks', ['wedding_id', 'kind'])
}

exports.down = (pgm) => {
  pgm.dropIndex('tasks', ['wedding_id', 'kind'])
  pgm.dropConstraint('tasks', 'tasks_kind_known')
  pgm.dropColumns('tasks', ['kind'])
}
