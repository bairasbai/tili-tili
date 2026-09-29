# Задачи WP03

- [x] T001 Baseline с полной БД/Redis, исходное поведение FR-036, regression до фикса: baseline.log, negative.log и stale-save-probe.log в `.unlazy/master-plan-20260930/` внешнего workspace.
- [x] T002 Постоянные ID и tenant-scoped атомарное сохранение: локально 7/7 regression, полный gate 1089 frontend / 1293 backend. Feature-коммит ещё не опубликован; защита версии относится к T003.
- [ ] T003 Версия/автор/время всех путей изменения; конкурентный и устаревший PUT.
- [ ] T004 Миграционные проверки с данными и повтор backfill/rollback.
- [ ] T005 Длительности, зависимости, fixed, назначения, travel/buffer; циклы и чужие ID.
- [ ] T006 Scoped preview/confirm сдвига, конфликты и запрет изменения других дней/fixed/прошедших.
- [ ] T007 Версионное ознакомление подрядчика и отзыв доступа.
- [ ] T008 UI, RU/EN, конфликт/сеть/повтор/пусто; черновик и принятый список.
- [ ] T009 Offline снимок и очистка при изменении доступа.
- [ ] T010 Контрактные генераторы, полный init.sh без skipped и browser desktop/mobile.
- [ ] T011 Карты, JOURNAL, ERRORS, REPORT, feature-коммит/push/main на принятом SHA.
