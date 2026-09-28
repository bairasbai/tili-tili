# 020 — семейные приглашения и отдельные персоны

Источник: `tasks/product-improvements-roadmap.md`, этап 020.
База поставки: `da87f1fe9aab19342f68e4a58453a4b35decb943` (019 завершён).
Main не менять. Рабочая ветка — `test/020-finalize-20260928`; промежуточные исправления остаются в ней. Финализация в отдельный feature-коммит/ветку — только после T023/T031/T032/T033 и зелёных gate.

## Инварианты

1. **Приглашение ≠ человек.** Одна семейная ссылка (`guest_party`) может содержать 1..N персон (`guests`).
2. **RSVP, меню, стол и место в автобусе — на персону.** Каждый человек имеет собственный статус, блюдо, стол и автобусное место.
3. **Отель — на приглашение/семью.** Семья, живущая в одном номере, не превращается автоматически в два номера из-за двух персон.
4. **Подарки — на приглашение/семью.** Одна семейная ссылка — одна анонимная gift identity и одна квота резервов/взносов.
5. **Старый `plusOne` не теряется.** Каждая строка с `plus_one=true` мигрирует в две персоны одной семьи. После миграции `plus_one=false` у всех строк; новые пути не создают булевый +1.
6. **Счётчики считают ровно один источник.** Гости/кейтеринг = персоны; автобус = строки person-booking; отель = family-room booking; gift fairPrice делится на количество персон.
7. **Одна семейная ссылка.** Выдача/перевыпуск invite-link для любого члена семьи работает с одним party token и не создаёт вторую gift identity.
8. **Приватность прежняя.** Токен семьи паре не отдаётся; пара видит только одноразовую ссылку. Helper/coordinator не получают телефон/ссылку.

## Фаза 1 — схема и миграция

- [x] T001 Добавить DB-тесты миграции старого одиночного гостя и `plusOne=true`.
- [x] T002 Создать `guest_parties`: id, wedding_id, invite_token, contact_phone/label, created_at.
- [x] T003 Добавить `guests.party_id`, `party_position`, `is_placeholder`; backfill партиями.
- [x] T004 Мигрировать `plusOne=true` в отдельную companion-персону; сохранить RSVP/table/menu/transport semantics и обнулить `plus_one`.
- [x] T005 Перевести `guest_invite_codes` на party; старые коды остаются рабочими.
- [x] T006 Перевести hotel booking на party, сохранив один старый номер на прежнее приглашение.
- [x] T007 Проверить gift identity: существующий primary token становится party token, старые резервы/взносы остаются владельцу.

## Фаза 2 — backend family API

- [x] T008 `guestByToken` резолвит party и primary person, не отдельную случайную персону.
- [x] T009 GET списка гостей отдаёт `partyId`, `partySize`, `isPrimary`; inviteUrl один на семью.
- [x] T010 Создание семейного приглашения: 1..10 персон, один контакт, одна ссылка.
- [x] T011 Добавление/удаление/переименование персоны в семье без смены family token.
- [x] T012 Импорт поддерживает family rows и не создаёт скрытый `plusOne`.

## Фаза 3 — семейный RSVP

- [x] T013 GET `/rsvp/{token}` отдаёт всех персон семьи.
- [x] T014 POST RSVP принимает изменения по guestId; статусы/диета/трансфер независимы.
- [x] T015 Отказ одной персоны освобождает только её автобусное место; hotel booking семьи не удаляется, пока в семье остаётся хотя бы один `yes`.
- [x] T016 Старый одиночный payload остаётся совместимым на переходный период.

## Фаза 4 — ресурсы без двойного счёта

- [x] T017 Столы считают строки-персоны, без `1 + plus_one`.
- [x] T018 Автобусы: одна booking-строка = одно место, `persons=1`; выбор автобуса делается для конкретной персоны семьи.
- [x] T019 Меню: один голос на конкретную персону; напоминания считают непроголосовавших персон.
- [x] T020 Отели: одна family booking = один номер; GET/POST работают по party token без удвоения.
- [x] T021 Подарки/фонды: quota/idempotency/anonymity ключуются party token; одна семья не получает квоту на каждого члена.
- [x] T022 `fairPrice` делится на число персон и не считает семейное приглашение второй сущностью.

## Фаза 5 — контракт и UI

- [x] T023 OpenAPI + generated schemas/types: GuestParty, GuestPerson, family RSVP/resources.
- [x] T024 Экран пары: создать семью, добавить/удалить персон, одна кнопка приглашения на семью.
- [x] T025 Гостевой экран: выбрать RSVP/меню/автобус для каждого человека; подарок остаётся общим для семьи.
- [x] T026 Рассадка показывает каждую персону отдельно; старой кнопки «+1» нет для новых данных.
- [x] T027 RU/EN и карты экранов/кнопок.

## Фаза 6 — приёмка

- [x] T028 DB regressions: old +1 migration, family invite, independent RSVP/menu/table/bus, one hotel room, one gift identity.
- [x] T029 Concurrency: два члена семьи на последнее место автобуса; две вкладки меняют family hotel; gift quota общая.
- [x] T030 Export/erasure: party/token/people корректно входят в выгрузку и 31-day cleanup.
- [x] T031 Browser E2E: пара создаёт семью из двух персон → одна ссылка → разный RSVP/menu → два места/один номер → один family gift reserve.
- [x] T032 Полный PostgreSQL/Redis gate, frontend/backend tests/types/lint/build.
- [x] T033 JOURNAL, ERRORS, business logic, handoff, roadmap; отметить 020 ✅ только после всех gate.

## Порядок

T001–T007 → T008–T016 → T017–T022 → T023–T027 → T028–T033.
021 не начинать до полного закрытия 020.

## Финал T033 · 2026-09-28 ✅

T001–T032 повторно подтверждены по коду и зелёным gate на code/test SHA `28ed3859293fc83fb5d50705b92cad9812ad4210`.

- CI `36385058391` — success: frontend 79 файлов / 1059 тестов; backend 107 файлов / 1233 теста; `family020.test.ts` 16/16; TypeScript, ESLint, production build, PostgreSQL/Redis migrations — success.
- В том же CI `schemas.test.ts` 8/8 и `contract-sync.test.ts` 4/4 — generated artifacts соответствуют OpenAPI 0.50.0.
- Последний отдельный generator run `36382068390` — success на `03e9b7b2c80ef92ebf38218bbe3bf4867021c0ee`. После него OpenAPI не менялся; четыре последующих коммита затронули только person-counting/regressions, а текущий contract-sync остаётся зелёным.
- Verify 020 family browser `36385058399` — success на `28ed3859…`: legacy rehearsal `down → seed → up → verify` и реальный Chromium без route mocks.
- Artifact `family020-browser-evidence` id `10954420756`, digest `sha256:1c9bc62a2a63235819c3ecbb8d03c268016946914f78a6071c1d0564abb8f7ae`.
- Финальный аудит после прежнего handoff закрыл stale `plusOne` в `personCount`/кейтеринге и вместимости столов; частичный family-RSVP закреплён отдельной регрессией.

Документационный commit `fd2680018badc5ac2aadd2b80d2c21d1d4a120be` прошёл повторный final gate: CI `36386064858` — success; Verify 020 family browser `36386064786` — success. T033 закрыт, этап **020 завершён ✅**. Этой T033-финализацией main/production не менялись; 021 в этой работе не начинался. Feature 020 уже была ранее слита в main отдельным Merge PR #12 (`3b2dbabd26701b33da372126fa33b2e4caad4b82`).


## Clean follow-up в main · 2026-09-28

PR #12 содержал основную 020, но финальный T033-аудит после него нашёл дополнительные hardening-исправления: materialized person counting, table capacity без deprecated `plusOne`, catering без чтения `plus_one` и regression частичного family-RSVP. Они переносятся отдельной clean follow-up веткой поверх актуального main; 018/019 повторно не сливаются, 021 не входит в этот перенос.
