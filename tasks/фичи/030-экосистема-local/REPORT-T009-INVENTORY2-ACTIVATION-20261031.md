# T009 inventory2: приёмка активации — 31 октября 2026

База: main `8b8fa295dd99c8f949e44e3d181913dfaf54551e` (PR81), fresh fetch в день работы.
Ветка `codex/wp04-t009-open-20261031`, W=`C:/Тили-тили/wp04-t009-open-20261031`,
E=`C:/Тили-тили/.unlazy/wp04-t009-open-20261031`. Контракт: `c-t009-inventory2-activation-contract.md`.
Production не затрагивался. Полный T009 (mixed/retry/ACL писателей дня вне инвентаря, lifting pending
guard) и 372/373/374 остаются OPEN.

## Результат

Приёмка активации inventory/2 прошла на текущем коде **без product-изменений**: публичная дверь
захвата уже корректно сохраняет /2-версии активированных источников. Product RED отсутствует;
единственные найденные расхождения — в моих исходных ожиданиях теста (конверт ошибки
`{error:{code,message}}`; опечатка ACL: одиночные двери отвечают чужим opaque 404 по
`locateSource`, а не 403; replay идемпотентности семантический, не побайтовый — порядок ключей JSON
при восстановлении сохранённого ответа не гарантирован). Все три — исправления оракула теста,
задокументированы здесь, продукт не менялся.

Новых файлов: `backend/test/dealDayScopeInventory2.test.ts` (5 кейсов), контракт, этот отчёт.

## Проверки (одноразовый PostgreSQL 15432, база tili_day_atomic_20261021_test, Node 24.21.0)

- Целевой набор: **5/5 PASS, 0 skip**, exit 0:
  - A2-01 — public book активирует /2; owner capture пишет ровно одну версию rev1
    (`owner_capture`, digest=SHA-256 канона, exact ключи `dayScopes`/`knownHolders`, 18 полей
    version + 4 поля head, holder-строка с fingerprint=SHA-256(snapshot::text), голова на версии).
  - A2-02 — повторный захват без изменения материала: no-op (`created=false`), версия одна;
    stale `expectedInventoryRevision` → 409 `legacy_inventory_version_conflict`, после перечтения
    захват успешен, новых версий нет.
  - A2-03 — тот же idempotency key + то же тело → 200 с семантически тем же ответом; тот же ключ
    с другим телом → 409 `idempotency_key_reused`; версия одна.
  - A2-04 — ACL: список владельца паре и чужому владельцу 403 `forbidden`; дверь capture им же —
    opaque 404 `not_found`; записей в версиях нет; holder-чтение пары 200.
  - A2-05 — отмена брони удаляет DATE; повторный захват → 409 `legacy_source_unavailable`; байты
    сохранённой /2-версии неизменны, голова остаётся на rev1.
- `tsc -p tsconfig.json --noEmit` — чисто. `eslint test/dealDayScopeInventory2.test.ts` — чисто.

## Границы

Полный backend gate (все файлы, preserving drill, C04/C05) и браузер этим этапом не выполнялись;
это поставка контракта и приёмочного набора на WIP-ветке, не PR и не merge. Уборка: синтетические
свадьбы/компании/аккаунты удалены в afterAll, набор сам проверяет отсутствие своих строк
(vendor_busy_dates, legacy_calendar_sources, deals). Одноразовый кластер 15432 остановлен после
прогонов; данные кластера сохранены в
`C:/Users/Bayra/AppData/Local/Temp/tili-t009-open-20261031-pg`.
