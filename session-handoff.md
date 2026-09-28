# Передача сессии — 020 слита в main

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.

## Текущее состояние

- 017-A/B слиты через PR #1.
- 018 quiz слита через PR #2.
- 019 shortlist/offers слита через PR #5 и дополнительно усилена 019 workflow/test/docs в main.
- 020 «семейные приглашения и отдельные персоны» слита через **PR #12**.
- Merge commit 020: `3b2dbabd26701b33da372126fa33b2e4caad4b82`.
- Post-merge CI на этом exact SHA: run `36365783985` — success.

## Что закрыто в 020

T001–T033:
- одна семейная ссылка / `guest_party` на 1–10 отдельных персон;
- legacy `plusOne` материализуется в отдельную companion-person без двойного счёта;
- RSVP, diet/menu, table и bus — на конкретного `guestId`;
- hotel booking и gift/fund identity — на family party/token;
- один invite link на семью, без выдачи party token паре/helper/coordinator;
- создание/импорт `members[]`, добавление/переименование/удаление отдельной персоны;
- family token сохраняется при удалении primary, пока семья не пуста;
- person-based рассадка, кейтеринг, меню и автобус;
- один room booking и одна gift identity на приглашение;
- export/31-day erasure family structure без invite secret;
- RU/EN, карты экранов/кнопок, OpenAPI 0.50.0 и generated artifacts.

## Миграция

`1761600000000_family_guest_parties.cjs`.

Rehearsal проверен в реальном GitHub Actions: применить все миграции → откатить только 020 → создать legacy guest с `plusOne=true`, menu/bus/hotel/invite/gift состоянием → снова применить 020 → получить 2 person rows, 2 bus seats, 1 hotel room, общий family token/code и ту же gift identity.

## Принятые gates

Clean code head: `661d2ae98c2a6feb03da7553dcb2f1ad294ce73b`.

- Clean CI `36365055384` — success:
  - frontend 78 файлов / 1023 теста;
  - backend 106 файлов / 1178 тестов;
  - PostgreSQL migrations, TypeScript, ESLint, frontend/backend production builds — success.
- Family browser E2E `36365055383` — success:
  - 2 family members;
  - 1 invite link;
  - 2 menu votes;
  - 2 bus seats;
  - 1 hotel room;
  - 1 family gift reservation;
  - page errors = 0.
- Evidence artifact `10947465988`, SHA-256 `a914dcd8854aa2a9645ce3f0a562df5f3feaf6a7371aef0fb9dbc044f8514a13`.
- PR #12 merge-candidate gates:
  - CI `36365523795` — success;
  - Offers 019 browser `36365523816` — success;
  - Task planning browser `36365523769` — success.
- Post-merge CI on main `3b2dbabd…`: `36365783985` — success.

## Важная история интеграции

Старую `test/020-finalize-20260928` не сливали целиком: она была построена на прежней 019-линии. В `integration/020-clean-main-20260928` переносилась только дельта 020, затем контракт пересобирался на clean-базе. Это не вернуло старые 018-A/B payment changes или другие посторонние изменения.

Два финальных исправления были только test-harness corrections: Cyrillic locator в Playwright и ожидание CSV `Family` вместо legacy `+1`. Product behavior ими не менялся.

## Следующий этап

Следующий roadmap stage — **021**: постоянные ID событий и контроль версии расписания, затем зависимости/фиксированные блоки/исполнители/переезды.

Production deployment не выполнен. Юридические тексты, реальные SMS/S3/VAPID, эксплуатационный backup/restore, тестовый домен и пилот на физических устройствах остаются отдельными release gates.
