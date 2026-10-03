# 030/380 — продолжение инвентаря прежнего календаря

Текущая поставка продолжает Claude `de414fa` поверх main `58349e0`. Номер этапа «370» исторический; фактическая миграция — `1763800000000_legacy_calendar_sources`. Полный объём WP00–WP16 сохраняется в [ведомости продолжения](../../wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md). Конечные интервалы, согласования, adoption, manual occupancy и перенос относятся к следующим 371–374.

## Реализованная граница

Стабильная идентичность DATE-строки и ревизия её указателя; discovery app/manual/orphan/root/negotiation; неизменяемая цепочка снимков и полный список держателей; вычисляемая свежесть; owner-only доменное чтение/захват с повторной проверкой области и принципала после ожиданий. Кодирование и digest выполняются SQL. Платформенный backfill не создаёт согласий или ресурсной брони. Существующие booking boundary, политика и TS-писатели сохранены. HTTP/OpenAPI/UI остаются в принятой границе следующего этапа ([D2](c380-inventory-contract.md)).

Независимый агент проанализировал текущие source/locks/cascades и предложил новые отрицательные проверки. Root воспроизвёл реальные отказы до исправления и прогнал исправленный код. Reviewer не запускал БД; runtime-выводы ниже получены root.

## Подтверждённые исправления

1. Первая версия вне цепочки при head0 и неполная промежуточная версия: обе принимались на COMMIT; deferred guard теперь проверяет ancestry до head0 return и holders каждой версии.
2. Внешняя сделка `vendor_id=NULL` могла создать app_root/live_negotiation другой компании: predicate теперь требует `ok IS TRUE`.
3. Raw DELETE свадьбы и manual busy одной DATE получили `40P01`: BEFORE DELETE закрепляет фактические компании deal-days в UUID-порядке до изменения дня. После исправления обе транзакции commit, день сохраняет UUID и становится orphan с увеличенной ревизией.
4. Два soft-deleted владельца исчезали из cleanup Set: fixture manifest хранит все созданные UUID; teardown проверяет отсутствие accounts/sessions/consents.
5. После применения380 найден живой день D2(W2), потерявший app_day при удалении старой W1. Forward381 восстанавливает новый app_day W2/голову rev0 и сохраняет прежние строки. Старые bytes/согласия не переносятся; busy W2 даёт55P03 и полный rollback. Обновлённый company union закрепляется до дня. Накат381 требует остановленных писателей.

Сценарии и ограничения находятся в [legacyCalendarSources.test.ts](../../../Тили-тили/backend/test/legacyCalendarSources.test.ts), T01–T12, и [репетиции](../../../Тили-тили/backend/scripts/ecosystem-migration-drill.mjs). Неуспехи не удалены и не объявлены успешной приёмкой.

## Наблюдаемые результаты

| Проверка | Результат и источник |
| --- | --- |
| Targeted380 | 65 inventory + 6 audit53 = 71 passed; без пропусков; `vitest-codex380-reviewed-targeted.log` |
| Текущий targeted381 | 68 inventory + 6 audit53 = 74 passed; без пропусков; `vitest-codex381-after-recovery.log`; meaningful red новых случаев:3 failed /71 passed, `vitest-codex381-before-recovery-pinned.log` |
| Raw cascade/manual | Actual lock witness, обе fulfilled, rejected=[]; тот же лог, `LEGACY_CALENDAR_RAW_CASCADE_MANUAL_RACE` |
| Final fresh drill20 | 24 own migrations through176381; чистый up/down/up, preserving populated370→380→381 upgrade/repeat, 18 SQL-отказов inventory, exact-file down380/381 refusal; `drill-codex381-drill20.log` |
| Вся SQL-матрица drill | 12 terms + 9 staff + 23 resources + 7 invitations + 17 plan + 30 commitments + 12 T012 + 18 inventory = 128 actual refusals; те же итоговые строки drill |
| CLI rollback | 16 прежних guard + 1 T012 + 1 inventory + 1 recovery = 19 actual CLI refusals с проверкой сохранения rows/journal/schema; drill20 |
| Mixed day/manual race | `manual-first` и `cascade-first`: actual PostgreSQL blockers, обе транзакции commit, day/pointer revision прежние, новая голова rev0; drill20 `RECOVERY_MANUAL_CASCADE_PG_WAIT` |
| Phone fixture | `vendorStaff.test.ts` 62/62 после атомарного bounded phone-conflict retry; role/security assertions сохранены; `vitest-codex381-staff-fixture.log` |
| Retained fullDB upgrade | Все прежние колонки/строки 98 таблиц сохранились по before/after SHA-256, verified principal/address/port; `.unlazy/codex-inventory-20261003/full-migration-{before,after}.json` |
| Forward381 inventory/full | Прежние строки102 таблиц сохранены (источники/головы могут только дополняться); identity/no-other-connections проверены; `inventory381-{before,after}.json`, `full381-{before,after}.json` в том же evidence каталоге |
| Generated contract | Повтор штатного gensync: TZ_GENSYNC_PASSED; git не показывает содержательных generated changes (первый raw-byte checker обнаружил CRLF/LF) |
| Полный init.sh | 112 файлов / 2105 тестов фронтенда и 146 файлов / 3135 тестов бэкенда; без пропусков; типы, полный линт и обе сборки прошли. `full-codex381-final.log`, exit=0, `TZ_FULL_PASSED` |
| Соответствие исходников | Все 680 файлов source/config/test/migrations совпали с manifest до полного прогона; `verify-evidence.mjs full` → `CODEX381_EVIDENCE_VERIFIED full` |
| CI/main | Публикация и удалённая проверка этого этапа пока не выполнены; отдельный PR35 относится к оркестратору |

Логи локальной приёмки: `C:/Тили-тили/.unlazy/tz-full-20261002/logs/`. Неуспехи: `vitest-codex380-before-guard.log`, `vitest-codex380-before-nullguard.log`, `vitest-codex380-before-cascade.log`. Первый drill17 относится к более ранней миграции и не заменяет окончательный drill18. Три прежние inventoryDB сохранены; база/история не удалялись. Полная БД обновлена нативным CLI только после review/regression/drill; этот файл миграции после применения туда неизменяем, последующие DDL-исправления требуют forward migration.

Первый полный прогон завершился `UNKNOWN: unknown error, read` при загрузке stage4.test.ts: фронт112/2105 и3107 остальных backend tests прошли, но весь прогон failed. Причину I/O я не могу подтвердить. Отдельный повтор stage4.test.ts дал25/25 (`vitest-codex380-stage4-read-retry.log`). Второй full381 дал3134passed/1failed: конфликт случайного телефона в fixture до проверки смены владельца, `users_phone_key`; он исправлен только в тестовом helper. Финальный полный прогон после исправления прошёл: 2105 + 3135 = 5240 тестов, типы, линт и обе сборки (`full-codex381-final.log`). Отдельный CI ещё требуется.

SHA-256 применённых миграций:380 `7b8257fb62e3ac8490a06aa15cb721f88a438a44d84d65df0c6296fba3ca1c33`;381 `f0c96680c13c6bc4fe7ea4a0434c4c7bd6c3670b818e2e5583981becc23cf9c6`. Final drill20 script `59136f3fa4588f1841958d00bd858cf2d1e97fa620c8bf6e93323b9ef15132fd`, migration manifest `0191bc4b55322171737280c8c402b287171a66283ea5f6d2b6e87f42d8786117`. Это хеши наблюдённого checkpoint, не утверждение о будущих изменениях или публикации. Drill19 сохранил own-fixture SQL42601 (зарезервированный alias `day`); после исправления на `day_id` выполнен новый чистый drill20, прежняя база не удалялась.

Новые HTTP/UI-сценарии этим этапом не введены. Доменная end-to-end проверка использует реальные зарегистрированные старые API/SQL/транзакции. Физические устройства, провайдеры, human pilot и production этим результатом не подтверждены.

Локальные коммиты: fixture `0d7eef4`, inventory corrections/recovery/drill/docs `a009b5b`. Main35 интегрирован `e8e0432` с сохранением обеих записей JOURNAL; повторная сверка всех680 исходников прошла. Непубликованный c382 остаётся отдельным локальным черновиком следующего этапа.
