# 020 — verification / acceptance ✅

Дата: 2026-09-28  
Репозиторий: `bairasbai/tili-tili`  
Ветка: `test/020-finalize-20260928`  
Финальный проверенный code/test SHA: `a5a40f30f2fb19a4e5ebadc9e6d6b6e72ee256a8`  
Контракт: OpenAPI `0.50.0`

## 1. Generated contract

Финальная генерация: commit `5b4432db5891ad5374a6cafe8c043e45c240a479`.

Проверено общим CI:
- `contract-sync.test.ts` — 4/4;
- `schemas.test.ts` — 8/8;
- backend/frontend generated OpenAPI types содержат `partySize`, family `members[]` и схемы 020.

## 2. Полный CI

GitHub Actions: run `36364877609` — **success**.

Frontend:
- 79 test files;
- **1059/1059 tests passed**;
- TypeScript `tsc -b` — success;
- ESLint — success;
- Vite production build — success.

Backend:
- PostgreSQL 16 + Redis 7 — live services;
- migrations up — success;
- 107 test files;
- **1231/1231 tests passed**;
- `family020.test.ts` — 14/14;
- TypeScript noEmit — success;
- ESLint — success;
- TypeScript build — success.

## 3. Legacy migration rehearsal

В browser workflow перед UI-приёмкой выполнено:

1. применить все миграции;
2. откатить только 020;
3. создать legacy guest с `plusOne=true`, RSVP, menu vote, bus booking,
   hotel booking, invite code и gift reserve;
4. снова применить 020;
5. проверить результат.

Фактический результат:

```json
{"ok":true,"people":2,"menuVotes":2,"busBookings":2,"hotelBookings":1,"inviteCodes":1,"giftReservations":1}
```

Это подтверждает:
- legacy +1 → две реальные персоны;
- menu semantics → два person votes;
- bus → две строки по одному месту;
- hotel → один family room;
- invite code → одна family party;
- gift identity → один прежний family token.

## 4. Real Chromium acceptance

GitHub Actions: run `36364877628` — **success**.

Фактические шаги:

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
- artifact id: `10946996800`;
- size: 403911 bytes;
- SHA-256: `5debaeaae6e0b25f7f397af6787ad4537dfb26a56629f4932db0553a8d58ffa5`.

## 5. Privacy / concurrency / cleanup

Закреплено тестами 020:
- token одной семьи не отвечает за person другой party;
- last-room race создаёт ровно один family booking;
- gift quota/identity общая для family token;
- export сохраняет family structure, но не раскрывает invite token;
- 31-day cleanup удаляет family party, people и family-owned rows;
- удаление primary при живых secondary сохраняет party token и повышает следующую person до primary.

## Итог

T001–T033 — закрыты. Этап **020 завершён ✅**.

Main/production не менялись. Следующий roadmap-этап — **021**.
