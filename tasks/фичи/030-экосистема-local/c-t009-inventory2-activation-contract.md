# T009 inventory2 — контракт приёмки активации (драйвер, rev 1, 2026-10-31)

Этап: приёмка активации inventory/2 — захват владельцем (`owner_capture`) источника, чей материал
перешёл на `legacy-calendar-inventory/2` после появления day-scope трека (PR77/78/79). База: main
`8b8fa295` (PR81), миграции ≤1763920000000 (94). Это НЕ 372/373/374: границы, adoption, manual и
перенос не затрагиваются; `state` источника остаётся `'unresolved'`, инвентарь не даёт прав на дату.

## Решения драйвера (технические, записать в JOURNAL)

- D1. **Никакой автоматической записи из чужих транзакций.** Подтверждается D4 контракта 370
  (`c380-inventory-contract.md`): писатели сделок в инвентарь не пишут, свежесть вычисляется digest'ом.
  Активация /2 = явный `owner_capture` поверх уже переключённого материала. `capture_kind` не
  расширяется (CHECK миграции 1763800000000: `('migration_backfill','owner_capture')`), новых миграций
  этап не требует, пока приёмка не докажет дефект.
- D2. Переключение материала на /2 уже произошло в схеме 89 (миграция 1763870000000):
  `legacy_calendar_current_inventory_material(source)` возвращает /2 с `dayScopes[]`, когда у источника
  есть day-scope группы/головы либо уже захваченная /2-версия. Писатели day-scope (PR77+) создают это
  условие штатно; тест I1 (`dealDayScopeAtomic.test.ts:918-971`) доказал переключение диспетчера и
  неизменность старых /1 байтов, но не захват /2 публичной дверью.
- D3. Публичная дверь — `POST /vendors/:vendorId/legacy-calendar/sources/:sourceId/capture`
  (`routes/legacyCalendar.ts:132`, обёртка `mutate` с идемпотентностью по ключу
  `user:route:key`, replay-гвардом сохранённого ответа и `assertSeatingToken`). Домен —
  `captureLegacyCalendarBoundsInventory` (`resources/legacy-calendar.ts:401`) поверх
  `legacy_calendar_append_version` (SQL). Этим этапом дверь не меняется.
- D4. Идемпотентность/retry: повторный захват без изменения материала — `created=false`, та же версия,
  ревизия не растёт (SQL `legacy_calendar_append_version`, ветка `current_canon=canon`). Повтор HTTP
  с тем же ключом и телом — сохранённый ответ; тот же ключ с другим телом — 409
  `idempotency_key_reused`; устаревший `expectedInventoryRevision` — 409
  `legacy_inventory_version_conflict`, после перечтения захват успешен.
- D5. ACL: список источников владельца для чужого актора — 403 `forbidden` (`OWNER_ONLY`); одиночные
  двери (`capture`, `proposals`, `accept`, `activate`) опрашивают непрозрачный локатор
  `locateSource` (`resources/legacy-calendar.ts:240`) и отвечают чужим 404 `not_found`, не раскрывая
  существование источника; доменный уровень при уже найденном источнике и чужом владельце — 403.
  Держатели (пара) читают свои источники через
  `GET /weddings/:weddingId/deals/:dealId/legacy-calendar`. Чужой `vendorId` в пути не подменяет
  владельца.
- D6. Исчезнувший DATE: после отмены брони строка `vendor_busy_dates` удаляется, источник `app_day`
  перестаёт быть `present`; повторный захват отказывает 409 `legacy_source_unavailable`, а старые
  версии (включая захваченную /2) остаются байт-в-байт неизменными.
- D7. Канон /2: SHA-256 считает SQL от `jsonb::text`; TS не сериализует и не хеширует (D5 контракта
  370). `legacy_calendar_version_holders.fingerprint` = SHA-256 `snapshot::text`. Точные ключи
  `dayScopes[]` и `knownHolders` фиксируются тестом по живому результату, а не копируются из ожидания.

## Приёмка

Поведенческий набор `backend/test/dealDayScopeInventory2.test.ts` на реальном публичном book через
HTTP и захвате через публичную дверь. Если текущий код не производит ожидаемую /2-версию — это
meaningful RED и этап получает минимальную реализацию; если проходит — зафиксировано как приёмка
активации без product-изменений. Полный T009 (mixed/retry/ACL писателей дня вне инвентаря, lifting
pending guard) и 372/373/374 остаются OPEN. Production запрещён.
