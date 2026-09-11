/**
 * Санкция по жалобе применима к её цели — теперь и по мнению базы (фича 005, В1).
 *
 * План §18.2: анкету можно понизить и заблокировать, отзыв — скрыть
 * (`block`), сообщение и сделку — только отклонить или предупредить.
 * Правило держал обработчик `admin.ts` (фича 001, «Ворота инвариантов» —
 * хвост владельцу). Две строки в дев-базе (жалоба на сообщение с `block`,
 * на отзыв с `downrank`) старше правила — потому `NOT VALID`: новые решения
 * проверяются, старые не трогаются; `VALIDATE CONSTRAINT` — после уборки.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE complaints ADD CONSTRAINT complaints_resolution_by_target CHECK (
      resolution IS NULL
      OR (target_kind = 'vendor' AND resolution IN ('dismiss', 'warn', 'downrank', 'block'))
      OR (target_kind = 'review' AND resolution IN ('dismiss', 'warn', 'block'))
      OR (target_kind IN ('message', 'deal') AND resolution IN ('dismiss', 'warn'))
    ) NOT VALID;
  `)
}

exports.down = (pgm) => {
  pgm.dropConstraint('complaints', 'complaints_resolution_by_target')
}
