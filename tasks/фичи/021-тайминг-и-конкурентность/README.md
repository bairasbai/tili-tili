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

- [ ] T001 — инвентаризация текущей модели/API/UI тайминга.
- [ ] T002 — зафиксировать schema/API contract 021.
- [ ] T003 — миграция: stable event IDs + schedule version.
- [ ] T004 — backend read/write по stable ID.
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
