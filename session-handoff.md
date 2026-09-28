# Передача сессии — 020 / T033 финализация

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.
Рабочая ветка: `test/020-finalize-20260928`.
В этой работе **не менять main** и **не начинать 021**.

## Текущее фактическое состояние

Code/test base перед документационным коммитом T033:
`28ed3859293fc83fb5d50705b92cad9812ad4210`
(`refactor(020): detach catering from plusOne`).

После переданного владельцем HEAD `03e9b7b2…` ветка получила ещё четыре коммита:

1. `d66b2f4546f9a6674c1eeac428e60dad3e86e81f` — `personCount` считает materialized person rows один раз.
2. `06cca3f692e10dcbea7e67d8ee7fe3952a87046a` — capacity стола считает `count(*)`, а не `sum(1 + plus_one)`.
3. `014e7a10326366a7f4e9ac49826f3554d5114721` — regression частичного family-RSVP: отказ одного освобождает только его автобусное место, hotel остаётся пока есть attending member.
4. `28ed3859293fc83fb5d50705b92cad9812ad4210` — кейтеринг больше даже не читает deprecated `plus_one`.

## Что подтверждено по T001–T032

- `guest_parties`, explicit person rows, legacy plusOne migration и compatibility — в миграции `1761600000000_family_guest_parties.cjs` и live migration rehearsal.
- Family API / import / add-remove-rename / один family token — backend + `family020.test.ts`.
- Family RSVP по `guestId`, независимые RSVP/diet/transfer — backend regressions.
- Menu/table/bus — на person; hotel/gift — на party; `fairPrice`/catering/table capacity не используют `1 + plusOne`.
- Export/31-day erasure, privacy и cross-party isolation — regressions.
- Concurrency: last bus seat, family hotel tabs, shared gift quota — regressions.
- OpenAPI 0.50.0 и generated contracts — contract-sync/schemas.
- Frontend family UI RU/EN — общий frontend gate и `family020Ui.test.ts`.
- Real browser E2E — PostgreSQL + Fastify + Vite + Chromium, без route mocks.

## Последние зелёные gates на code/test base

### CI — run 36385058391 — SUCCESS
SHA: `28ed3859293fc83fb5d50705b92cad9812ad4210`.

- frontend: 79 test files, 1059/1059 tests;
- backend: 107 test files, 1233/1233 tests;
- `family020.test.ts`: 16/16;
- `schemas.test.ts`: 8/8;
- `contract-sync.test.ts`: 4/4;
- TypeScript, ESLint, frontend production build, backend build — success;
- PostgreSQL 16 + Redis 7 и migrations — success.

### Verify 020 family browser — run 36385058399 — SUCCESS
SHA: `28ed3859293fc83fb5d50705b92cad9812ad4210`.

Migration rehearsal:
`{"ok":true,"people":2,"menuVotes":2,"busBookings":2,"hotelBookings":1,"inviteCodes":1,"giftReservations":1}`.

Chromium:
- pair-created-two-person-family-through-ui;
- one-family-invite-link-issued;
- per-person-rsvp-saved;
- two-menu-votes-two-bus-seats-one-family-room;
- one-shared-family-gift-reservation;
- `pageErrors=[]`.

Artifact: `family020-browser-evidence`, id `10954420756`,
digest `sha256:1c9bc62a2a63235819c3ecbb8d03c268016946914f78a6071c1d0564abb8f7ae`.

### Generated contract
Последний отдельный `Generate 020 final contract`: run `36382068390`, SUCCESS,
SHA `03e9b7b2c80ef92ebf38218bbe3bf4867021c0ee`.
После него OpenAPI не менялся. Текущий CI на `28ed3859…` повторно подтверждает
`schemas.test.ts` и `contract-sync.test.ts`, поэтому generated artifacts не stale.

## T033

Этот handoff входит в документационную часть T033. До повторного полного gate на самом документационном коммите:
- T033 оставлять `[ ]`;
- roadmap 020 не помечать ✅;
- 021 не начинать.

Новая реальная ошибка финального аудита записана как ERR-0336: вместимость стола после materialization всё ещё использовала deprecated `plus_one`.
