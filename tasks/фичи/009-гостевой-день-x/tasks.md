# Задачи: Гостевой день X

**Спека:** ./spec.md · **План:** ./plan.md (одобрен 2026-09-12, В1–В3)
**Формат:** `- [ ] T001 [P] [US1] описание в путь/к/файлу`

Пути — от `Тили-тили/`. Каждая задача с кодом — с регрессионным тестом, красным без фикса. Коммит — явными путями.

## Фаза 1 — миграции и контракт

- [x] T001 `backend/migrations/1760000000000_timeline_for_guests.cjs`, `1760100000000_message_guest.cjs` (CHECK «один автор»); `down`/`up` проверены.
- [x] T002 Контракт v0.32.0: `GET /join/{guestToken}/day`, `GET`/`POST /join/{guestToken}/day-chat/messages` (423 вне окна),
      `TimelineEvent.forGuests`, `Message.guestName`; генераторы. Коммит `a988b89`.

## Фаза 2 — бэкенд (US1, US2, US3)

- [x] T003 [US2] `backend/src/routes/day.ts`: `PUT …/timeline` принимает `forGuests`; все ответы с `TimelineEvent` отдают его.
- [x] T004 [US1] `backend/src/routes/day.ts`: `GET /join/{t}/day` — программа (только `for_guests`), стол, автобус с перевозчиком,
      координатор (имя, телефон), окно чата; 410 у мёртвой ссылки.
- [x] T005 [US3] `backend/src/routes/day.ts`, `chats.ts`: чат дня гостя (`GET`/`POST`, 423 вне окна с `details.opensAt`), `guestName` у реплик,
      `system` только без обоих авторов; `slots.ts` — `forGuests`/`guestName` в своих DTO.
- [x] T006 `backend/test/audit38.test.ts` (7, 6 красных на HEAD). Коммит `7806fc3`.

## Фаза 3 — фронт (US1, US2, US3)

- [ ] T007 [US1] `app/src/pages/Invite.tsx`: раздел «День свадьбы» с кануна по поясу места — программа, стол, автобус, координатор
      («Позвонить»), дресс-код, «Построить маршрут», «Открыть чат дня» / «откроется <дата>».
- [ ] T008 [US3] экран чата дня гостя: лента, поле, опрос 30 с через `reload()`, 423/410 словами сервера.
- [ ] T009 [US2] `app/src/pages/Wedding.tsx` (`Timeline`): «Показывать гостям» у блока и в форме; `PUT` несёт `forGuests`.
- [ ] T010 [US3] `app/src/pages/Us.tsx` (`Chat`): реплика гостя — имя и пометка «гость».
- [ ] T011 Словарь, тест `app/src/lib/audit36.test.tsx`, смежные тесты.

## Фаза 4 — сверка и записи

- [ ] T012 Полные прогоны, `init.sh`, живая проверка (гость с кануна: раздел, чат; пара: галочка, реплика гостя в чате дня).
- [ ] T013 Карты (`feature-009`), План §20.1 (№59/60 → «да»), `BACKEND-PLAN.md` (схема), JOURNAL, todo, handoff, ERRORS при находках.
