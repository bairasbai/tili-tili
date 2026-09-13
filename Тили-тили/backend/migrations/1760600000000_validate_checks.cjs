/**
 * Две проверки фичи 005 — из `NOT VALID` в проверенные (блокер №26, решение
 * владельца 2026-09-13 «поправить и включить»).
 *
 * `bus_taken_bounded` и `complaints_resolution_by_target` ставились `NOT VALID`:
 * в дев-базе лежали тестовые строки старше правила (четыре маршрута «мест 1,
 * гость с +1» и две жалобы с санкцией не по цели). Строки поправлены перед
 * этой миграцией; на боевой базе таких строк нет. `VALIDATE` берёт короткую
 * блокировку и читает таблицу — на пустой или маленькой базе это мгновенно,
 * а нарушающая строка честно валит миграцию, а не остаётся незамеченной.
 */
exports.up = (pgm) => {
  pgm.sql('ALTER TABLE bus_routes VALIDATE CONSTRAINT bus_taken_bounded')
  pgm.sql('ALTER TABLE complaints VALIDATE CONSTRAINT complaints_resolution_by_target')
}

exports.down = () => {
  // Обратно в NOT VALID PostgreSQL не умеет; снимать проверки ради отката незачем — они верны.
}
