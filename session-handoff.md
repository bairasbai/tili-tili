# 031 · PDF, приглашения и подтверждаемые действия Тиля · 4 ноября 2026

Текущая ветка `codex/oss-product-features-20261103`, база `3041d2cb4f972037f5cd426402b21a16b500be27`. Только локальная работа; main, push и production не разрешены. Предыдущий блок T009 ниже — история, его результаты не заменяют приёмку031.

PDF сохранены в `264f662`, приглашения — `503a51c`. Фото и защита HTTP-повтора исправлены дополнительно; Тиль и точный допуск95/96 ещё ожидают итоговых коммитов. Инструмент сводки обоих проектов — отдельный коммит Юлдаша `87c47369`; его принятая временная копия уже удалена с проверкой сохранности ветки и патча.

Постоянные результаты: `C:/Users/Bayra/Yuldash/test-results/oss-product-features-20261103`. `REPORT.md` пока IN_PROGRESS. Полный сайт:152файла/3115проверок PASS; сборки/типы/линтер проходят. Приглашения и Тиль проверены в браузере RU/EN × две темы, опубликованный гость открыт отдельно от аккаунта пары. Полный исторический native drill и новые95/96 PASS. Обязательные настоящие CI C04/C05 и остальные ограничения выпуска перечислены в `tasks/фичи/031-oss-product-tools/release-checks.md`.

Полный backend ещё выполняется. Четыре обнаруженных провала относятся к YAML-описанию API, неполному Chat и устройству новых тестов; причины исправлены, schemas/audit53 повторно38/38 PASS. Следом нужны разрешённые пользователем формальные G1/G2, целевой повтор затронутого списка чатов и source-допуска, свежая приёмка, коммиты/патчи/доказательства и уборка своих служб/копии. Не объявлять весь пакет готовым по этому промежуточному блоку.

## Историческая передача: T009 inventory2 · 31 октября 2026

W=`C:/Тили-тили/wp04-t009-open-20261031`; E=`C:/Тили-тили/.unlazy/wp04-t009-open-20261031`.
Ветка `codex/wp04-t009-open-20261031` от fresh main `8b8fa295` (PR81, fetch в день работы);
приёмочный коммит `843c5a9` запушен, remote сверен. Production запрещён и не затрагивался.
372/373/374 и полный T009 OPEN.

Доставлено этапом: контракт `c-t009-inventory2-activation-contract.md`, приёмочный набор
`backend/test/dealDayScopeInventory2.test.ts` (5 кейсов: активация /2 owner capture, no-op повтор
и 409-retry, идемпотентность ключа, ACL 403/404 + holder-чтение, исчезнувший DATE →
`legacy_source_unavailable` при неизменных /2 байтах), отчёт
`REPORT-T009-INVENTORY2-ACTIVATION-20261031.md`. Product-код не менялся: активация inventory/2
публичной дверью уже работает; все найденные расхождения были в исходных оракулах нового теста
(конверт `{error:{code}}`, opaque 404 одиночных дверей по `locateSource`, семантический
replay идемпотентности) и исправлены в тесте.

## Полный гейт этапа (логи E/gate-logs/)

- Parallel: **12/12 шардов, 100 файлов, 1584 passed / 15 skipped / 0 failed** (par-01…12).
- Serial: **80/80 файлов, 0 failed**. Мозаика батчей из-за лимита 300 с на вызов: монстры
  поодиночке (calendarLifecycle371 15/15 за 292 с; resourceCommitments 94/94; additionalEventMove
  23/23; calendarErasureC6 6/6), calendarScope371 и calendarBounds371 по -t батчам (23/23 и 46/46
  соответственно; все 43 ID bounds371 присутствуют в зелёных логах, сумма 46), ecosystemDelivery
  **43/43 только под настоящим node** (shim `node`=Kimi.exe в node-режиме не запускает дочерний
  node-pg-migrate: spawn по process.execPath стартует Electron). Остальное — batch-01…09.
- Backend: `tsc --noEmit` ✓, `eslint .` ✓, `tsc` build ✓.
- Frontend под pinned **Node 22.23.4** (SHA-256 сверен с nodejs.org): **144/144 файла,
  3072/3072**, `tsc -b` ✓, eslint ✓, `vite build` ✓. Наблюдения окружения: под shim v24.21.0 —
  1 fail (ICU: «Yekaterinburg» вместо «Екатеринбург» в eventRsvp), под v25.9.0 — 10 fails
  (session/origin-fence тайминги); код под них не менялся.
- Preserving drill `scripts/ecosystem-migration-drill.mjs` под Node 22:
  **ECOSYSTEM_MIGRATION_DRILL_PASSED**, exit 0, 287.7 с (drill.log). Единственная правка скрипта
  этапа: +1 путь этого дерева в `localCheckout` (по паттерну прежних волн).
- C04/C05 локально **не гонялись**: local-профиль пинит admission 2026-10-03
  (backend `tili-orchestrate-publish-20261003`, fixedOID 616406, actualMain 03f41a0f) — в этом
  дереве невоспроизводимо по построению; обе линии покрываются CI-шагом «Isolated C04 C05 native
  feature admission» (github-ci профиль).

## Окружение гейта

- Одноразовый PG 16.15 на 127.0.0.1:15432, **fresh-кластер** создан в этот день
  (`initdb --locale=Russian_Russia.1251 -E UTF8 --auth=trust`); старый retained-кластер
  сохранён переименованием в `tili-calendar371-consents-20261025-pg.retained-before-20261031`
  (не удалять). postgres.exe не биндит ::1 (EACCES, причина не установлена) — слушает только
  IPv4; node биндит оба стека.
- Роль `codex_test` superuser, trust. Базы: `tili_ecosystem_full_20260930_test` (94 миграции),
  `tili_ecosystem_migration_drill12_20260930_test` (у неё `lc_messages='C'`, иначе drill падает
  на русских текстах ошибок pg). Изолированные базы ecosystemDelivery создаёт сам тест.
- Запуск PG переживающим вызовы способом: прямой `postgres -D … >> log 2>&1 &`; pg_ctl висит на
  трубах (ERRORS.md). Стоп: `pg_ctl -D <datadir> stop -m fast` с редиректом вывода в файл, затем
  проверка свободного 15432. Чужие службы (5432/6379) не трогались.
- Node: shim `node` — Kimi.exe (v24.21.0, ELECTRON_RUN_AS_NODE=1, process.execPath=Kimi.exe);
  настоящий node v25.9.0 (`C:\Program Files\nodejs\node.exe`); pinned portable **22.23.4** в
  `Temp\node22\node-v22.23.4-win-x64\node.exe`.
- Env тестов: `TILI_DISPOSABLE_PG_PORT=15432`,
  `DATABASE_URL=TEST_DATABASE_URL=postgres://codex_test@127.0.0.1:15432/tili_ecosystem_full_20260930_test`.
  psql — с `PGCLIENTENCODING=UTF8`.
- Несколько вызовов убиты по 295 с ПОСЛЕ завершения всех файлов шарда (serx-04/05,
  batch-05/06/08): пофайловые ✓ в логах, живых vitest после каждого килла нет (Get-CimInstance),
  PG жив.

## Состояние и следующий шаг

Незакоммиченное на момент записи: `backend/scripts/ecosystem-migration-drill.mjs` (+1 путь) и
untracked `backend/.ci/` (delivery-isolated артефакты, retained by design, в git не коммитились —
оставить untracked). Перед GitHub-вызовами — `node ~/.claude/hooks/github-api-guard.js --status`.

Следующий шаг: коммит документов и правки drill → push → сверка remote → `gh pr create`
(base main) → ждать CI итогового head (включая isolated C04/C05 lane) → обычный merge только
после зелёного CI по общему правилу публикации. Финал сессии: остановить PG (рецепт выше),
проверить порт 15432 свободен.
