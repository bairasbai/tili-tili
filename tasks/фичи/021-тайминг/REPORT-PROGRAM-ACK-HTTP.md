# WP03 / T007: Версия Разрешённой Программы — Сервер

2026-09-30. Локальный server foundation checkpoint, не весь T007/WP03. Последующий
registered UI/browser этап — REPORT-PROGRAM-UI.md; legacy «Учтено» не заменяет этот поток.
Production/remote операции не выполнялись, код не опубликован.

## Реализация

- GET /vendor/programs: штатная keyset pagination и current sourceVersion/
  blockCount/acknowledgedAt/requiresAcknowledgment. Ревокация между selection
  и locked read исключает запись; остальные errors не скрываются.
- GET /vendor/weddings/{weddingId}/timeline: только свои назначенные блоки
  booked/paid_deposit/done сделок. Права не выводятся из legacy who/forGuests.
  Только роли собственных назначений и зависимости между разрешёнными ID;
  нет чужих блоков/hidden dependency IDs/телефонов/денег/людей/private notes.
  Реальные event context/известные интервалы/явная duration/fixed/travel/buffer/
  outdoor. Unknown date/zone/end null; fractional planning сохраняется.
- ETag/sourceVersion/context из одного wedding-lock snapshot, no-store. GET
  не подтверждает. Без назначений readToken/expiresAt null и нет ожидания.
- Read proof: отдельные HS256 purpose key/type/audience, user/session/vendor/
  wedding/version/digest, TTL600s по actual DB clock_timestamp. Не доказательство
  человеческого прочтения каждой строки.
- POST /vendor/weddings/{weddingId}/timeline/ack: captured If-Match и readToken;
  wedding write lock, live account/session/ownership/deals/wedding recheck,
  exact version/expiry/binding/content digest. Same-version visible title change
  отвергает старый token без записи.
- Миграция1762200000000 хранит minimal program_snapshot/version/digest и реальные
  acknowledged_at/user/session, FK/checks/natural uniqueness. History+audit
  атомарны. Concurrent/retry сохраняют первое время/одну запись/один audit, без
  изменения programme version. Новая редакция или владелец не наследуют ack.
  Legacy updates/ack не закрывает это ожидание.
- program-access helper общий с legacy ack, прежний404 text сохранён. Новые
  маршруты пока только зарегистрированным владельцам анкет; guest links своих
  подрядчиков и delegated team не объявлены поддержанными, их права/сценарии
  остаются в полном master scope.
- Source API0.58.0:157paths/207operations/107schemas, штатные generators.
  На серверном checkpoint UI types сгенерированы; последующий reader — REPORT-PROGRAM-UI.md.

## Доказательства

C:/Тили-тили/.unlazy/wp03-shift-20260930/:

- vendor-before-program-ack.log:2new failed/30old passed из-за отсутствующих
  GET routes404. Witness отсутствующей функции, не старой утечки.
- vendor-program-ack-first.log:31passed/1failed: новый audit insert использовал
  несуществующий details вместо существующего diff; транзакция откатилась.
  Исправлена колонка. Это локальный тестовый отказ, не production incident.
- vendor-program-ack-security.log38passed; vendor-program-ack-current.log49passed
  после revocations/pagination/context/ownership. Позднее добавлен real DB
  audit-failure rollback test, включённый в full.
- full-program-ack-current.log: frontend1146passed, backend1413passed/1failed.
  G-c1 обнаружил acknowledgment_unavailable вне YAML. Добавлен explicit503,
  generators повторены, assertion не ослаблена.
- full-program-ack-contract-final.log:1146frontend/1413backend passed, один
  existing push queue test failed. Read-only queue-observation-result.json:
  479 pending due в старой events DB при worker limit200; точный выбор failed
  notice не captured, поэтому backlog — гипотеза, не доказанная причина.
  Push code/assertions не менялись, DB/log сохранены.
- full-program-ack-fresh.log: fresh ackfresh DB, init.sh exit0,84frontendfiles/
  1146tests,111backendfiles/1414tests, без skipped, types/lint/build/contract
  audits passed. Прирост server cases1414-1394=20; backend code после этого
  checkpoint не менялся. Frontend позднее добавлен отдельно, см. REPORT-PROGRAM-UI.

C:/Тили-тили/.unlazy/wp03-program-ack-20260930/:

- migration-v1-result.json8passed на fresh local*_test clone vendoraccess1,
  не production: up сохраняет hashes/counts всех прежних таблиц и не выдумывает
  old ack; runner repeat/no-op, empty down, actual SQL rollback после deliberate
  DB failure, down/up, insert rollback, digest/version/object constraints,
  protected populated down с сохранностью всей истории.
- migrationDrill JSON — synthetic DB history fixture, не actual read/GUI/доставка.
  DB v1 уже существует, повторять на том же имени нельзя.
- Browser/HTTP programack1:13 checks, zero page_errors; real projection/
  exact ack/edit/stale/retry/revocation HTTP и old cached dashboard404/reload.
  Evidence .unlazy/wp03-vendor-access-20260930/browser-evidence-programack1/.
  Этот сценарий сам по себе не новый UI; actual new UI clicks в REPORT-PROGRAM-UI.

## Остаток

Registered vendor UI реализован отдельно, доказательства — REPORT-PROGRAM-UI.md.
Нужны обратная видимость состояния команде, прочие разрешённые actors
(external/делегирование), offline/access cleanup. T006 event invitations/RSVP/
transfers, T008 event management, T009/T010/T011 и все WP00–WP16/SC/NFR не
сокращались. Неполный WP03 не выпускается.
