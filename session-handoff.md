# Передача сессии — 020 готова к merge

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.

## Текущее состояние

- 017-A/B и 018 quiz уже в main.
- 019 слита через PR #5; последующие 019 hardening/docs находятся в актуальном main.
- 020 «семейные приглашения и отдельные персоны» завершена T001–T033 в clean integration `integration/020-clean-main-20260928`.
- Исходную `test/020-finalize-20260928` целиком не сливать: она построена на старой линии. Полезная дельта 020 перенесена и проверена отдельно.

## Что входит в 020

- `guest_party` отделена от конкретной персоны: одна семейная ссылка содержит 1–10 `guests`.
- Legacy `plusOne=true` мигрирует в отдельную companion-person; скрытый +1 больше не участвует в арифметике новых путей.
- RSVP, diet/menu, table и bus booking — по `guestId` конкретной персоны.
- Hotel booking и gift/fund identity — по family party/token: один номер и одна анонимная gift identity на приглашение.
- Создание/импорт поддерживают `members[]`; добавление, переименование и удаление человека не меняет family token, пока семья не пуста.
- Guest API отдаёт `partyId/partyPosition/partySize/isPrimary/isPlaceholder`; inviteUrl только одна на семью и только паре.
- Export/31-day erasure включают family structure без утечки invite token.
- UI пары и гостевой UI работают с именованными персонами; рассадка/кейтеринг считают person rows ровно один раз.

## Контракт и миграция

- OpenAPI: **0.50.0**.
- Generated backend/frontend contract artifacts синхронизированы штатными генераторами.
- Миграция: `1761600000000_family_guest_parties.cjs`.
- Rehearsal проверяет legacy round-trip: откат 020 → старый `plusOne` + menu/bus/hotel/invite/gift → повторное применение 020 → 2 person rows / 2 bus seats / 1 hotel room / тот же family token и gift identity.

## Финальные gates clean integration

Проверочный кодовый HEAD: `661d2ae98c2a6feb03da7553dcb2f1ad294ce73b`.

- Full CI: **success**, run `36365055384`.
  - frontend: **78 файлов / 1023 теста**;
  - backend: **106 файлов / 1178 тестов**;
  - PostgreSQL migrations, TypeScript, ESLint, frontend/backend production build — success.
- Family browser E2E: **success**, run `36365055383`.
  - artifact `10947465988`;
  - SHA-256 `a914dcd8854aa2a9645ce3f0a562df5f3feaf6a7371aef0fb9dbc044f8514a13`;
  - 2 персоны, 1 family invite link, 2 menu votes, 2 bus seats, 1 hotel room, 1 family gift reserve, page errors = 0.
- Независимая source-проверка после тех же test-harness fixes: CI `36364877609` success, browser `36364877628` success.

## Следующий обязательный шаг

Открыть PR `integration/020-clean-main-20260928 → main`. Актуальный main после clean-ветки получил только hardening 019 workflow/test/docs, поэтому обязательна PR-проверка merge-кандидата. После зелёного PR CI — merge, затем post-merge CI на main. Только после этого переходить к этапу 021.

Production deployment этим не подтверждается. Юридические тексты, реальные SMS/S3/VAPID, эксплуатационный backup/restore, тестовый домен и пилот на физических устройствах остаются отдельными release gates.
