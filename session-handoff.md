# Передача сессии — 018-A/B payments clean integration

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.

## Актуальный порядок интеграции

- **017-A/B** — задачи и напоминания: слиты в `main` через PR #1 (`e2cb4e6e`).
- **018-Q** — ответы квиза влияют на свадьбу: исторически называлась «018», слита через PR #2 (`e413afd1`).
- **019** — shortlist / предложения / accept: clean PR #5 (`027d6c3e`) + hardening PR #11.
- **020** — семейные приглашения и отдельные персоны: слита через PR #12 (`3b2dbabd`).
- **018-A/B payments** — clean PR #14 слит в `main`, merge `aee5e164`; старый divergent PR #3 закрыт как superseded.

Номер 018 больше нельзя трактовать без суффикса: **018-Q = quiz**, **018-A/B = payments**.

## 018-A/B payments — clean integration

Включено:
- payment schedule поверх существующих deals/payments;
- частичные отметки оплаты, link/unlink факта к этапу и CSV;
- reserve и category limits;
- private payment receipts;
- RBAC / privacy / idempotency / optimistic versions;
- UI `/wedding/payments` и controls на `/wedding/budget`.

Миграции:
- `1761310000000_payment_schedule.cjs`;
- `1761400000000_budget_controls_receipts.cjs`.

Контракт: **OpenAPI 0.51.0**. Он получен структурным merge payment-delta в текущий 0.50.0, а не заменой на старый контракт PR #3. Generated backend/frontend artifacts пересобраны штатными генераторами.

## Как интегрировано

Не сливать PR #3 и не переносить его branch целиком. Из него использована проверенная payment-цепочка `e7a27e4…6a106fd`, перенесённая через настоящий `git cherry-pick` на актуальный main.

При конфликтах сохранялась актуальная версия 019/020; платежная дельта затем объединялась вручную:
- `routes/slots.ts` — только payment-core, без отката booking-core 019;
- `Wedding.tsx` — только reserve/category-limit UI 018-B;
- OpenAPI/generated — clean 0.51.0;
- i18n — payment-only additions;
- audit guards — актуальные currency/version expectations.

## Приёмка PR #14 — завершена

Финальный SHA PR: `03f3024975c419e00465996dfbf7c3ff3d642f38`.
- CI `36384154690`: success — frontend 81/81 файлов, 1086/1086 тестов; backend 109/109 файлов, 1271/1271 тест;
- Payment schedule browser E2E `36384154654`: success — 14/14, `page_errors: []`;
- Task planning browser E2E `36384154650`: success;
- Offers 019 browser E2E `36384154662`: success;
- migrations, TypeScript, ESLint и production builds: success.

Merge commit: `aee5e164f49b29552fb4e0c8141fcc423f582f49`. Его tree SHA совпадает с проверенным head: `75bc9b93260fdfe524a6dc89d88a1ff412f35a1e`.

## После merge

1. Post-merge CI запущен на точном SHA `aee5e164f49b29552fb4e0c8141fcc423f582f49` (run `36384481686`).
2. Старый draft PR #3 закрыт как **superseded by PR #14**.
3. Не считать production deployment выполненным: SMS/S3/VAPID, юридические тексты, backup/restore и physical-device pilot остаются release gates.
