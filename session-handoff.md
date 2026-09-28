# Передача сессии — 020 завершён ✅

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.
Рабочая/принятая ветка этапа: `test/020-finalize-20260928`.
База этапа — завершённый 019 `da87f1fe9aab19342f68e4a58453a4b35decb943`.
Main/production этой работой не менялись.

## Что закрыто

020 «Семейные приглашения и отдельные персоны» закрыт полностью: T001–T033.

Доменная модель:
- одно `guest_party` приглашение содержит 1–10 отдельных `guests`;
- RSVP/menu/table/bus принадлежат конкретной персоне;
- hotel/gift/fund identity принадлежат семье/party;
- старый `plusOne` — только compatibility-вход и materialization placeholder-персоны, не скрытый счётчик.

Ключевые свойства:
- legacy `plusOne=true` мигрирует в две person rows без потери RSVP/menu/table/bus semantics;
- старый guest token становится общим party token;
- invite code переводится на party;
- один старый hotel booking остаётся одним семейным номером;
- gift identity сохраняется на том же token;
- создание и импорт принимают `members[]`;
- добавление/удаление/переименование персоны не меняет family token;
- при удалении primary следующий человек становится primary;
- `Guest` отдаёт `partyId/partyPosition/partySize/isPrimary/isPlaceholder`;
- family token не может изменить человека другой party;
- menu/shuttle адресуют `guestId`;
- hotel уникален по `hotel_id + party_id`;
- fairPrice/кейтринг/рассадка считают person rows ровно один раз;
- export включает структуру семьи, но не invite token;
- 31-day cleanup каскадно стирает party/person-owned данные.

## Контракт

OpenAPI: `0.50.0`.
Generated backend/frontend artifacts синхронизированы коммитом
`5b4432db5891ad5374a6cafe8c043e45c240a479`.
Финальный проверенный code/test SHA:
`a5a40f30f2fb19a4e5ebadc9e6d6b6e72ee256a8`.

## Финальная приёмка

### CI
GitHub Actions run `36364877609`:
- frontend: 79 test files, **1059/1059** tests;
- backend: 107 test files, **1231/1231** tests;
- frontend/backend typecheck — success;
- ESLint — success;
- frontend production build — success;
- backend TypeScript build — success;
- PostgreSQL 16 + Redis 7 подняты в CI;
- migrations up — success;
- `contract-sync.test.ts` и `schemas.test.ts` — success.

### Migration rehearsal + real browser
GitHub Actions run `36364877628`:
- fresh migrations — success;
- rollback только 020 → legacy seed → повторный up → verify — success;
- verification: people=2, menuVotes=2, busBookings=2, hotelBookings=1,
  inviteCodes=1, giftReservations=1;
- real Chromium steps:
  1. пара создаёт двух человек через UI;
  2. выдаётся одна family invite-link;
  3. независимый RSVP сохраняется по двум guestId;
  4. два menu votes + два bus seats + один hotel room;
  5. один общий family gift reserve;
- `pageErrors=[]`;
- artifact `family020-browser-evidence`: id `10946996800`,
  SHA-256 `5debaeaae6e0b25f7f397af6787ad4537dfb26a56629f4932db0553a8d58ffa5`.

Подробный отчёт:
`tasks/фичи/020-семейные-приглашения/verification-acceptance.md`.

## Исправления, найденные при финальном аудите

ERR-0331 — primary-delete стирал всю party.
ERR-0332 — bulk import не принимал explicit family members.
ERR-0333 — рассчитанный partySize не сериализовался.
ERR-0334 — сводка кейтеринга повторно прибавляла +1.
ERR-0335 — два T030-теста лежали вне suite, затем lint поймал stale helper.
Дополнительно финальный gate обновил устаревшее ожидание CSV `+1` → `Family`
и browser locator person-resource card; production business logic этим последним
исправлением не ослаблялась.

## Следующий этап

Следующий этап roadmap — **021**: постоянные ID событий и контроль версии расписания.
Не начинать 022 до полного закрытия 021.

Внешние release blockers остаются прежними: юридические тексты, реальные SMS/S3/VAPID,
production deployment, эксплуатационный backup/restore drill и пилот на физических устройствах.
Они не отменяют факт завершения product feature 020 в feature/test поставке.
