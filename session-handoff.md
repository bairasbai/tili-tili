# Передача: полный master plan WP00–WP16

Обновлено 2026-09-30. Цель активна: весь исходный scope, тесты/сценарии/документация каждого пакета, отдельный feature-коммит/push/main. Ни один новый WP пока не объявлен принятым. Этот checkpoint не заменяет полный объём.

## Решения владельца

- Полный объём WP00–WP16 подтверждён опросом.
- Провайдеры ещё не выбраны; цены, тарифные права, возвраты и политика хранения ещё не переданы. Владелец предоставит правила.
- Production не трогать. Публикация кода не означает deployment.
- Реальные интеграции, устройства и пилот не подменять моками/headless.

## Git и документы

Корень: C:/Тили-тили/Тили-тили_код_и_документация.
На старте чистая main совпадала с origin/main на ccd68fdcaa5a433c5892469ab5c4c552999901d7: guard без паузы, fetch origin main, divergence 0 0.
Рабочая ветка: feature/master-plan-delivery-20260930.

Пять документов скопированы из c2dea5a4a4e60152c5329ad9a161fc92ef274fd7 без старого кода ветки. README дополнен текущим разрешением; spec/plan/tasks/baseline сверены с источником.
Реестр: tasks/wedding-platform-master-plan/delivery.md.
WP03: tasks/фичи/021-тайминг/; это roadmap-тайминг, не платёжная privacy-021.

Подготовительные документы публикуются отдельным docs-коммитом рабочей ветки. Не путать публикацию плана с выпуском фичи. Commit/push проверять через git, не выводить из текста этого файла.

## Локальная реализация WP03, ещё не feature-коммит

- backend/src/routes/day.ts: постоянные ID, проверка tenant-scoped списка до изменений, нормализация UUID/отказ дублей, lock свадьбы, upsert прежних строк и удаление отсутствующих.
- backend/test/timeline021.test.ts: семь регрессий.
- Миграции, версии и изменения OpenAPI ещё НЕ реализованы.
- Старый snapshot всё ещё перезаписывает новый. Probe показал 200/200 для двух сессий с одним исходным снимком. T003 не выполнена; неполный WP03 не выпускать.

## Проверки

Логи: C:/Тили-тили/.unlazy/master-plan-20260930/.

- baseline.log: полный bash init.sh, 1089 frontend / 1286 backend, без skipped, типы/линт/сборки прошли; исходный main до WP03.
- negative.log: семь новых тестов упали до изменения ID.
- targeted.log: эти семь прошли после.
- final.log: полный gate после изменения ID, 1089 frontend / 1293 backend, без skipped, типы/линт/сборки прошли.
- wp00.log: offers019/shortlist019/accept019 — 50/50; расширенный FR-018 не доказан целиком.
- stale-save-probe.log: оставшийся дефект версии воспроизведён.
- Browser/device/offline приёмка нового WP03 НЕ выполнена.

## Окружение

Отдельный PostgreSQL 16 на 127.0.0.1:55432: C:/Тили-тили/.unlazy/sync-audit-20260930/pgdata.
База tili_codex_master_20260930_test, locale Russian_Russia.1251. Redis DB 13.
Основная база приложения не изменялась.
Временный PostgreSQL останавливается после checkpoint; проверить pg_ctl status.
verify.mjs setup повторно не выполнять: он отказывает при существующей базе. После запуска pg_ctl использовать targeted/final режимы.

## Следующий шаг

T003: версия, автор/время всех способов изменения, конфликт двух сессий и устаревшего PUT. Пути: day.ts PUT, wedding/reschedule.ts, dayx.ts shift, шаблон weddings.ts. Проверить единый порядок замков, FK/уведомления и отзыв доступа.
Затем dependencies/fixed/duration/participants/travel/buffer, scoped shift, ознакомление подрядчика, UI RU/EN/offline, миграции, полный gate и browser flow.
После полной приёмки WP03 — feature-коммит/push/main; затем остальные WP, внешние gates и WP16.
Goal complete не ставить до requirement-by-requirement audit.

Предыдущая синхронизация/privacy: JOURNAL, ERRORS ERR-0337 и C:/Тили-тили/.unlazy/sync-audit-20260930/. Backup прежнего main сохранён.
