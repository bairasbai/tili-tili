# Задачи: Транспорт — перевозчик как подрядчик

**Спека:** ./spec.md · **План:** ./plan.md (одобрен 2026-09-12, В1–В4) · **Статус:** сделано 2026-09-12
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`

Пути — от `Тили-тили/`. Каждая задача с кодом — с регрессионным тестом, красным без фикса. Коммит — явными путями.

## Фаза 1 — миграция и контракт

- [x] T001 `backend/migrations/1759900000000_bus_route_deal.cjs` — `bus_routes.deal_id` (FK deals, SET NULL), индекс; `down`/`up` проверены.
- [x] T002 Контракт v0.30.0: `BusRoute.dealId`/`carrier`, `PATCH …/logistics/buses/{busId}`, `busRoutes` у `GET /vendor/deals`,
      `notifiedGuests` снят; четыре генератора. Коммит `79eba2d`.

## Фаза 2 — бэкенд (US1, US2, US3)

- [x] T003 [US1] `backend/src/routes/day.ts`: `POST …/buses` принимает `dealId` (сделка этой свадьбы в слоте `transport`, живая —
      иначе 422 `not_transport` / 409 `deal_cancelled`); `GET` пары и гостя отдают `dealId` и `carrier`.
- [x] T004 [US1] `backend/src/routes/day.ts`: `PATCH …/buses/{busId}` под замком строки (`seats < taken` → 409 `bus_full`, `dealId: null`
      снимает перевозчика); заметка подрядчику из каталога при создании/правке (`vendor_updates`).
- [x] T005 [US2] `backend/src/routes/vendorCabinet.ts`: `busRoutes` у сделок — только счётчики.
- [x] T006 `backend/src/routes/dayx.ts`: `notifiedGuests` снят из ответов сдвига и плана Б.
- [x] T007 `backend/test/audit35.test.ts` — по одному на правило; тест на отсутствие имён/телефонов гостей в ответе кабинета.

## Фаза 3 — фронт (US1, US2, US3)

- [x] T008 [US1] `app/src/pages/Logistics.tsx`: подпись перевозчика, поле «Перевозчик» в форме (транспортные сделки из мозаики),
      «Изменить» → `PATCH`, `?deal=` предвыбирает перевозчика.
- [x] T009 [US1] `app/src/pages/Tools.tsx` (`DealView`, слот `transport`): блок «Маршруты для гостей», «Добавить маршрут для гостей».
- [x] T010 [US3] `app/src/pages/Invite.tsx` (`GuestShuttle`): «Автобус №1 · Автобусы Уфы».
- [x] T011 [US2] `app/src/pages/VendorApp.tsx`: «Маршрутов: N · записалось M из K» у транспортной сделки.
- [x] T012 `app/src/lib/api/weddingWrite.ts` (`patchBus`, `dealId` в `addBus`), словарь, тест `app/src/lib/audit33.test.tsx`.

## Фаза 4 — сверка и записи

- [x] T013 Полные прогоны обеих сторон, `init.sh`, живая проверка (сделка «Транспорт» → маршрут → гость видит перевозчика → кабинет).
- [x] T014 Карты (`feature-006`), `BACKEND-PLAN.md` (сделано), `Бизнес-логика` §12 транспорт, JOURNAL, todo, handoff, ERRORS при находках.

## Итог 2026-09-12

- Миграция `1759900000000_bus_route_deal.cjs` применена (`down`/`up` проверены); контракт v0.30.0 (120 путей, 161 операция, 57 схем).
- Бэкенд: `POST`/`PATCH …/logistics/buses` с `dealId` (422 `not_transport`, 409 `deal_cancelled`, 409 `bus_full`), `carrier` паре и гостю,
  `busRoutes` у сделок кабинета (только счётчики), заметка перевозчику, `detachBusRoutes` во всех дверях отмены (ERR-0249), `notifiedGuests` снят.
  Тесты `audit35` (10). Прогон: 69 · 810 | 10 (Redis).
- Фронт: «Перевозчик» в форме маршрута, «Изменить» → PATCH, `?deal=` из карточки сделки, блок «Маршруты для гостей», подпись перевозчика
  у гостя, «Маршрутов: N · записалось M из K» в кабинете. Тесты `audit33` (12). Прогон: 42 · 662; tsc/eslint 0; сборка чистая.
- Живая проверка: карточка сделки → «Добавить маршрут» → форма с перевозчиком → маршрут с подписью → гость видит `carrier` → карточка показывает маршрут.
- Хвосты (не блокируют): свой вид заметки «транспорт» в `vendor_updates.kind` (миграция + enum); привязка `candidate`/`negotiating`-сделок разрешена сервером.
