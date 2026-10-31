# T009 inventory2 · приёмка активации · 31 октября 2026

W=`C:/Тили-тили/wp04-t009-open-20261031`; E=`C:/Тили-тили/.unlazy/wp04-t009-open-20261031`.
Ветка `codex/wp04-t009-open-20261031` от fresh main `8b8fa295` (PR81, fetch в день работы).
Production запрещён и не затрагивался. 372/373/374 и полный T009 OPEN.

Доставлено этапом: контракт `c-t009-inventory2-activation-contract.md`, приёмочный набор
`backend/test/dealDayScopeInventory2.test.ts` (5 кейсов: активация /2 owner capture, no-op повтор
и 409-retry, идемпотентность ключа, ACL 403/404 + holder-чтение, исчезнувший DATE →
`legacy_source_unavailable` при неизменных /2 байтах), отчёт
`REPORT-T009-INVENTORY2-ACTIVATION-20261031.md`. Product-код не менялся: активация inventory/2
публичной дверью уже работает; все найденные расхождения были в исходных оракулах нового теста
(конверт `{error:{code}}`, opaque 404 одиночных дверей по `locateSource`, семантический
replay идемпотентности) и исправлены в тесте.

Проверки на итоговом source: целевой vitest **5/5 PASS, 0 skip**, exit 0 (одноразовый PG 15432,
`codex_test`/`tili_day_atomic_20261021_test`, 94 миграции; Node 24.21.0); `tsc --noEmit` чисто;
eslint нового файла чисто. Дымовой прогон существующего `dealDayScopeAtomic.test.ts` на этом
дереве: 119/119 PASS. Полный backend gate/drill/C04-C05 этим этапом не выполнялись — следующий шаг
перед PR. Браузер не запускался.

Окружение: pnpm 10.34.5 установлен глобально через npm; deps по `--frozen-lockfile
--node-linker=hoisted`. Одноразовый PG 15432 остановлен (pg_ctl fast), порт свободен, данные
кластера retained в `C:/Users/Bayra/AppData/Local/Temp/tili-t009-open-20261031-pg`. Чужие
службы (5432/6379) не трогались.

Незакоммиченного не остаётся после feature-коммита; ledger E/GATES.md. Следующий шаг: полный
backend gate в этом дереве → PR/CI/обычный merge по общему правилу публикации.
