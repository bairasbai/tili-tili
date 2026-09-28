# 020 — verification / acceptance ✅

Дата: 2026-09-28  
Репозиторий: `bairasbai/tili-tili`  
Ветка: `test/020-finalize-20260928`  
Актуальный подтверждённый code/test SHA до документационного коммита: `28ed3859293fc83fb5d50705b92cad9812ad4210`  
Контракт: OpenAPI `0.50.0`

> T033 закрыт после повторного полного gate документационного commit `fd2680018badc5ac2aadd2b80d2c21d1d4a120be`: CI `36386064858` и browser/migration `36386064786` завершились SUCCESS.

## 1. Почему прежняя acceptance была устаревшей

Предыдущий файл ссылался на `a5a40f30…`, но рабочая ветка после handoff получила ещё изменения. Перед финализацией текущий tip был заново прочитан из GitHub и проверен по Actions. Между переданным владельцем `03e9b7b2…` и текущим code/test base появились:

- `d66b2f4546f9a6674c1eeac428e60dad3e86e81f` — materialized people считаются один раз;
- `06cca3f692e10dcbea7e67d8ee7fe3952a87046a` — table capacity считает person rows, не `plus_one`;
- `014e7a10326366a7f4e9ac49826f3554d5114721` — regression частичного family refusal;
- `28ed3859293fc83fb5d50705b92cad9812ad4210` — catering полностью отвязан от deprecated `plus_one`.

## 2. T001–T032 — повторная фактическая сверка

| Диапазон | Подтверждение |
|---|---|
| T001–T007 | Миграция `1761600000000_family_guest_parties.cjs` + live rehearsal: legacy `plusOne=true` → 2 person rows; menu=2, bus=2, hotel=1, inviteCode=1, gift reservation=1 |
| T008–T012 | Family API, единый token, create/add/remove/rename/import `members[]`; regressions `family020.test.ts` |
| T013–T016 | GET/POST family RSVP по `guestId`, независимые status/diet/transfer, legacy payload compatibility; отдельный regression partial refusal |
| T017–T022 | person-only table/menu/bus/catering/fairPrice; party-only hotel/gift identity/quota. Stale `plusOne` отдельно проверен для personCount и table capacity |
| T023 | OpenAPI 0.50.0. Последний отдельный generator run `36382068390` — success на `03e9b7b2…`; после него OpenAPI не менялся. Текущий CI: schemas 8/8, contract-sync 4/4 |
| T024–T027 | Frontend family UI + RU/EN; `family020Ui.test.ts` 3/3; карты экранов/кнопок актуализируются этим T033 commit |
| T028–T030 | DB regressions, concurrency last bus seat / hotel tabs / gift quota, export without token, 31-day cleanup; `family020.test.ts` 16/16 |
| T031 | Real Chromium flow на PostgreSQL + Fastify + Vite, без route mocks — run `36385058399` |
| T032 | Полный CI с PostgreSQL 16 + Redis 7, migrations, frontend/backend tests/types/lint/build — run `36385058391` |

## 3. Полный CI на текущем code/test base

GitHub Actions: **CI run `36385058391` — success**, head SHA `28ed3859293fc83fb5d50705b92cad9812ad4210`.

Frontend:
- 79/79 test files;
- **1059/1059 tests passed**;
- `family020Ui.test.ts` — 3/3;
- TypeScript, ESLint, Vite production build — success.

Backend:
- PostgreSQL 16 + Redis 7 live services;
- migrations — success;
- 107/107 test files;
- **1233/1233 tests passed**;
- `family020.test.ts` — **16/16**;
- `schemas.test.ts` — 8/8;
- `contract-sync.test.ts` — 4/4;
- TypeScript noEmit, ESLint, TypeScript build — success.

## 4. Generated contract

Отдельный workflow **Generate 020 final contract**: run `36382068390` — success, head SHA `03e9b7b2c80ef92ebf38218bbe3bf4867021c0ee`.

Он запускается только при изменении OpenAPI или самого generator workflow. Последующие четыре коммита не меняли OpenAPI/generated artifacts. Их актуальность подтверждена уже на `28ed3859…` тестами `schemas.test.ts` 8/8 и `contract-sync.test.ts` 4/4 в полном CI.

## 5. Legacy migration rehearsal + real browser

GitHub Actions: **Verify 020 family browser run `36385058399` — success**, head SHA `28ed3859293fc83fb5d50705b92cad9812ad4210`.

Migration rehearsal:
```json
{"ok":true,"people":2,"menuVotes":2,"busBookings":2,"hotelBookings":1,"inviteCodes":1,"giftReservations":1}
```

Real Chromium:
```json
{
  "steps": [
    "pair-created-two-person-family-through-ui",
    "one-family-invite-link-issued",
    "per-person-rsvp-saved",
    "two-menu-votes-two-bus-seats-one-family-room",
    "one-shared-family-gift-reservation"
  ],
  "pageErrors": [],
  "verified": {
    "familyMembers": 2,
    "inviteLinks": 1,
    "menuVotes": 2,
    "busSeats": 2,
    "hotelRooms": 1,
    "familyGiftReservations": 1
  }
}
```

Artifact:
- name: `family020-browser-evidence`;
- id: `10954420756`;
- size: 401683 bytes;
- digest: `sha256:1c9bc62a2a63235819c3ecbb8d03c268016946914f78a6071c1d0564abb8f7ae`.

## 6. Дополнительный финальный аудит

Подтверждено regression-тестами:
- family token не может изменить person другой party;
- удаление primary повышает следующего member без ротации token;
- stale `plus_one` не увеличивает personCount и table capacity;
- отказ одного member снимает только его bus booking;
- family hotel остаётся, пока есть хотя бы один RSVP=yes;
- две семьи на последний hotel room дают ровно 200/409;
- два members на последнее bus seat дают ровно 200/409;
- две вкладки перемещают family hotel к одному финальному room;
- parallel gift reserve не превышает общую party quota;
- export сохраняет party structure и не отдаёт invite token;
- 31-day cleanup удаляет party, people и family-owned rows.

Новый реальный дефект этого аудита: **ERR-0336** — capacity стола всё ещё использовала `sum(1 + plus_one)`; исправлено в `06cca3f…`.

## 7. Final documentation gate

Документационный SHA: `fd2680018badc5ac2aadd2b80d2c21d1d4a120be`.

GitHub Actions после обновления всех T033-документов:
- **CI `36386064858` — SUCCESS**, head SHA `fd2680018badc5ac2aadd2b80d2c21d1d4a120be`;
- **Verify 020 family browser `36386064786` — SUCCESS**, head SHA `fd2680018badc5ac2aadd2b80d2c21d1d4a120be`.

Тем самым проверено, что документационные изменения не сломали полный frontend/backend gate, миграции и реальный browser acceptance.

## Итог

T001–T033 закрыты. Этап **020 завершён ✅**.

Main/production в рамках 020 не изменялись. 021 в этой работе не начинался.
