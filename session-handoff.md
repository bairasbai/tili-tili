# Передача сессии — 020 / семейные приглашения и отдельные персоны

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`, рабочая ветка
`test/020-finalize-20260928`. База этапа — завершённый 019
`da87f1fe9aab19342f68e4a58453a4b35decb943`. Main/production не менять.

## Границы

020 — текущий этап roadmap. 021 не начинать, пока 020 не прошёл финальные gates.
Старый `plusOne` остаётся только compatibility-входом; новая доменная модель:
одно `guest_party` приглашение содержит 1–10 отдельных `guests`.

## Реализовано

- DB migration `1761600000000_family_guest_parties.cjs`: `guest_parties`,
  `guests.party_id/party_position/is_placeholder`, перенос invite codes и hotel
  ownership на party, materialization legacy `plusOne=true`.
- RSVP/menu/table/bus — на person; hotel/gift/fund identity — на party/family token.
- Family API: создание `members[]`, добавление/переименование/удаление персоны,
  сохранение family token при удалении primary, максимум 10.
- Import поддерживает explicit `members[]`; legacy `plusOne` создаёт placeholder.
- Guest API отдаёт `partyId`, `partyPosition`, `partySize`, `isPrimary`,
  `isPlaceholder`; одна inviteUrl на семью.
- Гостевой экран: независимый RSVP, меню и автобус для каждого `guestId`;
  один family hotel и один общий gift reserve.
- Экран пары: создание семьи, отображение размера, добавление человека в
  существующую семью, отдельное удаление/статусы; кейтеринг считает person rows
  ровно один раз.
- Export и 31-day erase покрывают family structure без выдачи invite token.
- Контракт 0.50.0; generated artifacts перегенерированы коммитом
  `5b4432db5891ad5374a6cafe8c043e45c240a479`.

## Аудит продолжения

После восстановления 020 закрыты дополнительные расхождения:
ERR-0331 — primary-delete стирал party; ERR-0332 — import не принимал family
members; ERR-0333 — partySize терялся в serializer; ERR-0334 — кейтеринг
повторно прибавлял +1; ERR-0335 — T030 tests были вне suite и lint ловил
stale helper.

## Migration / browser acceptance

Workflow `.github/workflows/verify-020-family-browser.yml` работает с
одноразовой PostgreSQL `*_test` базой и real Fastify/Vite/Chromium. Перед
browser flow он выполняет migration rehearsal:

1. применить все миграции;
2. откатить только 020;
3. создать legacy guest с `plusOne=true`, RSVP, menu vote, bus, hotel,
   invite code и gift reserve;
4. снова применить 020;
5. проверить 2 person rows, 2 bus seats, 1 hotel room, общий party token/code
   и ту же gift identity.

Browser flow затем создаёт семью через UI пары, выдаёт одну ссылку, проходит
per-person RSVP/menu/bus, один hotel booking и один family gift reserve.

## Текущий статус задач

T001–T030 закрыты, включая T023 generated contract. Открыты только:

- T031 — зелёный browser E2E именно на финальном HEAD;
- T032 — полный PostgreSQL/Redis CI: frontend/backend types/tests/lint/build,
  contract-sync и migration rehearsal;
- T033 — финальный verification report, roadmap/handoff и отметка 020 ✅.

Не считать 020 завершённым до этих трёх пунктов. После зелёных gates обновить
`tasks/фичи/020-семейные-приглашения/verification-acceptance.md`, отметить
T031–T033, перевести roadmap 020 в ✅ и только затем формировать финальную
feature-ветку/merge-кандидат.

## Внешние release blockers

Как и после 019: юридические тексты, реальные SMS/S3/VAPID, production deployment,
эксплуатационный backup/restore drill и пилот на физических устройствах остаются
отдельными release gates. Они не являются доказательством или блокером завершения
самой product feature 020 в test-ветке.
