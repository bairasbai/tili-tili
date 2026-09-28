# Feature / Stage 021 — тайминг и конкурентное редактирование

Старт: 2026-09-28  
Ветка: `feature/021-timeline-concurrency`  
Base: `main@a9f17aea32351e32b996c3b6246cee629b9ad98b`

## Цель

Сделать тайминг свадьбы устойчивым к редактированию и пригодным для последующих зависимостей между событиями без привязки клиентской логики к позиции элемента в массиве.

## Scope

1. Постоянный ID у каждого события тайминга.
2. Версия расписания и optimistic concurrency для конфликтующих изменений.
3. Безопасная миграция существующего тайминга с сохранением данных.
4. CRUD/перестановка событий по ID, а не по индексам.
5. Фиксированные и подвижные события.
6. Зависимости между событиями с защитой от циклов.
7. Исполнители/ответственные события.
8. Переезды/буферы между событиями.
9. UI конфликтов: stale update не должен молча перетирать более новую версию.
10. OpenAPI/generated contracts, документация и browser E2E.

## Инварианты

- ID события стабилен после reorder и изменения времени.
- Любая мутация расписания проверяет ожидаемую версию.
- При несовпадении версии сервер возвращает явный conflict и актуальное состояние/версию по контракту.
- Нельзя создать циклическую зависимость.
- Фиксированное событие не сдвигается автоматическим перерасчётом.
- Подвижные события могут пересчитываться только детерминированно и в пределах валидных зависимостей.
- Все операции изолированы по wedding scope и RBAC.
- 020 family/person semantics не откатываются.

## Порядок реализации

- [x] T001 — инвентаризация текущей модели/API/UI тайминга.
- [x] T002 — зафиксировать schema/API contract 021.
- [x] T003 — миграция: aggregate schedule version (stable ID уже существовал в схеме).
- [x] T004 — backend read/write сохраняет существующие event ID; shift/reschedule увеличивают aggregate version.
- [ ] T005 — optimistic concurrency + regression tests.
- [ ] T006 — generated OpenAPI contracts.
- [ ] T007 — frontend stable-ID state/update flow.
- [ ] T008 — conflict UX.
- [ ] T009 — fixed/flexible event semantics.
- [ ] T010 — dependency graph + cycle validation.
- [ ] T011 — assignees/resources and travel/buffer model.
- [ ] T012 — migration up/down/up.
- [ ] T013 — backend/frontend full suites, TS, ESLint, builds.
- [ ] T014 — browser E2E critical timeline scenarios.
- [ ] T015 — security/RBAC/wedding isolation audit.
- [ ] T016 — docs, acceptance report and merge-ready audit.

## Gate

Stage 021 не считается завершённым до зелёных migration up/down/up, OpenAPI drift check, backend/frontend suites, TypeScript, ESLint, production builds и browser E2E. `main` не менять до отдельного решения о merge.


## Progress · identity foundation

Commit foundation добавляет `timeline_version`, стабильное обновление существующих строк `timeline_events` и единый aggregate-lock между full PUT, Day-X shift и reschedule. GET/PUT уже отдают ETag версии, но обязательный `If-Match` включается только в T005 вместе с regression двух клиентов и frontend conflict UX.


## Implementation checkpoint · 2026-09-29

Код T005–T011 находится в draft PR #18 и проходит gate:

- optimistic concurrency: ETag / If-Match, 409 stale-write barrier;
- stable event IDs без delete/reinsert;
- fixed/flexible blocks;
- DAG dependencies с travelMinutes + bufferMinutes;
- structured assignees через wedding_members и активные deals;
- DB-level wedding isolation для event/member/deal relations;
- Day-X shift двигает только flexible и откатывается при нарушении dependency graph;
- frontend editor сохраняет полный rich snapshot и не повторяет stale PUT автоматически.

Эти пункты не считаются accepted до зелёных generated-contract, full CI, migration up/down/up и browser E2E.
