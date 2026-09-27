# 020 — семейные приглашения и отдельные персоны

Дата старта: 2026-09-28. База: `da87f1fe9aab19342f68e4a58453a4b35decb943` (019 завершён ✅).

## Цель

Одна ссылка-приглашение представляет семью/компанию, внутри которой несколько **отдельных персон**.
Персона — единица RSVP, меню, рассадки и транспорта. Приглашение/семья — единица ссылки, отельной комнаты
и анонимного подарочного резерва. Старый `plusOne` полностью мигрируется в отдельную персону, чтобы ни один
подсистемный счётчик больше не умножал одну строку «на глаз».

## Инварианты

1. **Приглашение ≠ персона.** У одного приглашения 1..10 персон; один токен/одноразовая ссылка на приглашение.
2. **Персональные сущности:** RSVP, diet/dietNote, menu vote/menuOption, table, transfer, bus booking.
3. **Семейные сущности:** invite link/token, контактный телефон/комментарий, hotel booking (один номер на приглашение),
   gift reservation/contribution/fund contribution (одна анонимная семейная identity по токену).
4. Никакого `1 + plusOne` после миграции: person count = число персон со статусом `yes`.
5. Миграция сохраняет смысл старых данных:
   - каждый старый guest становится primary person своего invitation;
   - `plus_one=true` создаёт вторую companion person;
   - стол/RSVP/ограничения/transfer копируются companion, чтобы не потерять уже обещанные места/порции;
   - bus booking раскладывается на две person-booking по одному месту;
   - hotel booking остаётся одной комнатой на invitation;
   - прежний guest token становится токеном invitation, поэтому gift anonymity/reservations не ломаются.
6. Семья не может занять два номера одним токеном; каждая персона не может занять два автобуса/два меню-голоса/два места.
7. Любой personId из гостевого API обязан принадлежать invitation текущего guestToken; чужой personId = 404.
8. Старый single-person клиент остаётся совместимым на время миграции: legacy top-level RSVP поля отражают primary person.

## Фаза 1 — схема и red-first

- [ ] T001 Миграция `guest_parties`: invitation-level token/contact; `guests.party_id`, `is_primary`; перенос старых данных.
- [ ] T002 Миграция `plus_one=true` → отдельная companion person; убрать семантику double-person из seat/bus counters.
- [ ] T003 `hotel_bookings` перевести с `guest_id` на `party_id`, сохранить одну старую комнату на приглашение.
- [ ] T004 `guest_invite_codes` перевести на `party_id`; старые коды и токены продолжают работать.
- [ ] T005 DB-тест миграции: old single, old +1 с table/menu/bus/hotel/gift, no duplicates/no lost counters.

## Фаза 2 — backend contract/API

- [ ] T006 `guestByToken` возвращает party + primary; helper `personByGuestToken` валидирует ownership.
- [ ] T007 GET/POST RSVP: family page + batch/per-person answers; legacy primary fields сохранены.
- [ ] T008 Shuttle: bookings по personId; taken = фактическое число персон, без `persons=2`.
- [ ] T009 Menu: vote по personId; GET отдаёт выбор каждой персоны.
- [ ] T010 Seating/guest list: каждая персона отдельной строкой; personCount считает rows(status=yes).
- [ ] T011 Hotel: booking по party; один токен = максимум один блок/одна комната.
- [ ] T012 Gifts/funds: party token остаётся единственной anonymous identity; повтор по членам семьи не удваивает резерв.
- [ ] T013 Family-management API для пары: создать приглашение с массивом персон, добавить/удалить/переименовать person.
- [ ] T014 OpenAPI + generated schema/types синхронизированы.

## Фаза 3 — frontend

- [ ] T015 Экран списка гостей показывает семейные карточки и персон внутри; создание семейного приглашения.
- [ ] T016 Guest invite RSVP показывает всех персон семьи и сохраняет ответы отдельно.
- [ ] T017 Menu и shuttle на гостевой странице — выбор для каждой attending person.
- [ ] T018 Hotel/gifts остаются одним выбором на приглашение, без повторов на карточках персон.
- [ ] T019 RU/EN и карты экранов/кнопок обновлены.

## Фаза 4 — приёмка

- [ ] T020 Regression: single-person invite полностью совместим.
- [ ] T021 Regression: old plusOne migration даёт 2 персоны, 2 порции/места/seat, 1 hotel room, 1 gift identity.
- [ ] T022 Concurrency: два члена семьи не переполняют последний автобус/стол; ownership чужого personId закрыт.
- [ ] T023 Browser E2E: пара создаёт семейное приглашение из 2 персон → одна ссылка → оба RSVP → разные menu/bus → один hotel → один gift reserve.
- [ ] T024 Полный PostgreSQL/Redis gate, frontend/backend tests, types, lint, builds.
- [ ] T025 JOURNAL/ERRORS/business logic/handoff; roadmap 020 → ✅ только после T020–T024.

## Граница

020 не меняет модель wedding members/аккаунтов, не делает отдельные аккаунты гостям и не начинает 021.
