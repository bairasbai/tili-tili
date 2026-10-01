# WP03 / T007: Registered Vendor Program UI

2026-09-30. Локальный этап, не весь T007/WP03. Production и GitHub не трогались.

## Реализация

- /vendor-app: отдельный переход «Программы свадеб», legacy «Учтено» не заменяется.
- /vendor-app/programs: реальные summaries/pending/count/version; штатный cursor,
  next/previous и refresh. Ошибка не считается пустым списком.
- /vendor-app/programs/:weddingId: отдельный GET snapshot; только разрешённые
  блоки от сервера, version/context/full starts/ends по фактической event zone,
  unknown явно/ISO без догадки. Duration/fixed/roles/dependencies/manual travel/
  buffer/outdoor сохранены, fractional minutes не округляются.
- Явный checkbox и команда ack; GET не подтверждает. Captured readToken и
  matching ETag/sourceVersion, один in-flight POST. Receipt только своей версии,
  настоящее acknowledgedAt, без клиентского времени/оптимистической галочки.
- Сеть/5xx допускают повтор того же proof/If-Match. HTTP4xx убирает private
  snapshot/checkbox; stale/expiry требует explicit reopen и новый checkbox.
  После reload серверная history остаётся; новая редакция не наследует ack.
- Offline unmount и expired-session event снимают reader/list из React tree.
  Reconnect заново читает API без старого proof. Snapshot/token не пишутся в
  localStorage/IndexedDB. Это не полноценный offline program reader T009 и
  не автоматическое обнаружение отзыва доступа без запроса/события.
- RU/EN; имена пользователей/событий из API не переводятся как интерфейс.
- Registered owner только; внешние guest-vendor actors/delegated team и
  обратная видимость подтверждения команде по-прежнему нужны.

## Проверки

- src/lib/vendorProgram.test.tsx:20 cases: read-only/captured metadata,
  exact POST/proof/version/receipt, network retry, stale/reopen, HTTP403/404/422,
  missing/mismatch ETag, unknown date/zone/end/duration, empty/acknowledged,
  mismatched response version, expired proof, offline/reconnect, single-flight,
  English, late response after route change, actual cursor encoding/navigation,
  failed list not empty. Это component fixtures, не реальные внешние службы.
- Существующий nomocks route inventory расширен двумя routes и forbidden-down
  assertions; guard на полноту маршрутов не ослаблен.
- full-program-ui.log:1164passed/2failed. Dictionary guard нашёл «Нет связи с
  сервером»/«мин» без EN, route inventory нашёл новые routes. Добавлены переводы
  и маршруты, включая actual no-server render для двух новых screens.
- Final C:/Тили-тили/.unlazy/wp03-shift-20260930/full-program-ui-final.log:
  init.sh exit0 на fresh tili_codex_programuifinal_20260930_test PostgreSQL/RedisDB13,
  85frontendfiles/1168tests,111backendfiles/1414tests, no skipped. Types/lint/
  builds/contracts passed. Frontend delta1168-1146=22:20component cases +2new
  routes в общем no-server sweep. Backend unchanged1414. После final app/backend
  code не менялся; subsequent edits только docs/external preview DB pointer.

External C:/Тили-тили/.unlazy/wp03-program-ui-20260930/:

- browser-evidence-programui1:12 checks, zero page_errors, initial actual UI run.
- browser-evidence-programui2/timeline-browser-result.json:14 checks,
  zero page_errors. Actual publication/book/full-list edit, dashboard->list->read,
  hidden service block excluded, GET not ack, checkbox + actual POST, reload with
  persisted receipt, actual owner edit/fresh pending/stale409/explicit reopen.
- Real POST committed then response intentionally lost by Playwright transport:
  retry returns same original receipt. No synthetic successful API response.
- Actual cancellation makes cached ack404 and removes private snapshot; list
  reload excludes wedding. Offline context really disconnected/reconnected;
  fresh unchecked read after reconnect. English real reload/labels.
- program320/390/1440, program-en390, stale390, revoked390 PNG reviewed:
  no observed overlaps; DOM horizontal-overflow assertions passed.
- Runner/API/Vite/Python terminal exit0; temporary private auth fixture removed.
  Programui1/2 databases disposable *_test, not production; do not reuse names.
  Physical phones, notification delivery or third-party providers not verified.

Scoped GATES server6/UI4: status/approve ALL MET10. Manual evidence reviewed,
not whole T007/WP03 acceptance. CRLF-aware diff --check exit0. Intentional preview
http://127.0.0.1:3000/vendor-app/programs, isolated programui2*_test DB/RedisNULL/
no worker/seeding, healthstatusok/UI200 and Win32commands/listeners checked.
Requires a test session for real program data, not SMS/login provider verification.

## Остаток Полного Объёма

T007 pair/team current acknowledgment view, external/делегированные actors;
T009 versioned offline/access cleanup. T006 individual event invitees/RSVP/
transfers, T008 event management, T010 whole-package verification, T011
feature commit/push/main. All source FR/SC/NFR/WP00–WP16 retained.
Этот отчёт не закрывает весь T007/WP03 и не заявляет local=GitHub.
