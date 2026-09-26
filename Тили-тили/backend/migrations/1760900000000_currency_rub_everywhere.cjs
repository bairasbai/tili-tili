/**
 * Ревью 016, хвост F2 (F-RL-2-03): `CHECK (currency = 'RUB')` на всех
 * денежных таблицах, не только на четырёх (`weddings`, `vendors`, `gifts`,
 * `funds`, миграции 1757200000000/1757400000000/1757800000000).
 *
 * Остальные девять таблиц со столбцом `currency` заводились с
 * `default: 'RUB'`, но без проверки в схеме: чужая валюта могла осесть
 * мимо API — прямым SQL, миграцией данных, админкой. Сам API уже пускает
 * только RUB (`enum: ['RUB']` в схемах тел — например `slots.ts`,
 * `deals.ts`, `budget.ts`), и на боевой базе нарушителей нет (0 строк с
 * валютой не RUB во всех девяти на момент разведки). Поэтому проверка
 * ставится сразу ПРОВЕРЕННОЙ, без `NOT VALID`: нарушающая строка (если она
 * где-то всё же есть) честно валит миграцию, а не остаётся незамеченной —
 * в отличие от `1760600000000_validate_checks.cjs`, откат назад тут не
 * специальный: `dropConstraint` возвращает ровно то, что было.
 */
const TABLES = [
  'referral_uses',
  'vendor_packages',
  'concierge_requests',
  'deals',
  'payments',
  'budget_items',
  'hotel_blocks',
  'gift_contributions',
  'fund_contributions',
]

exports.up = (pgm) => {
  for (const t of TABLES) {
    pgm.addConstraint(t, `${t}_currency_rub`, "CHECK (currency = 'RUB')")
  }
}

exports.down = (pgm) => {
  for (const t of TABLES) {
    pgm.dropConstraint(t, `${t}_currency_rub`)
  }
}
