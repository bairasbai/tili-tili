# Передача сессии — 018-A/B payments clean integration

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.

## Актуальный порядок интеграции

- **017-A/B** — задачи и напоминания: слиты в `main` через PR #1 (`e2cb4e6e`).
- **018-Q** — ответы квиза влияют на свадьбу: исторически называлась «018», слита через PR #2 (`e413afd1`).
- **019** — shortlist / предложения / accept: clean PR #5 (`027d6c3e`) + hardening PR #11.
- **020** — семейные приглашения и отдельные персоны: слита через PR #12 (`3b2dbabd`).
- **018-A/B payments** — старая реализация находилась в divergent draft PR #3 и не была в main. Полезная дельта перенесена на текущий main в `integration/018-payments-clean-main-20260928`, PR #14.

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

## Приёмка PR #14

Перед merge обязательны:
- full CI frontend/backend;
- Payment schedule browser E2E: 14 сценариев;
- Task planning browser E2E (017 regression);
- Offers 019 browser E2E;
- migrations, TypeScript, ESLint, frontend/backend production builds.

Уже во время clean-переноса были подтверждены:
- backend payment suites: `paymentSchedule.test.ts` 52/52, `budgetControlsReceipts.test.ts` 40/40;
- frontend payment suites: `paymentSchedule.test.tsx` 26/26, `budgetControls.test.tsx` 23/23;
- 017 Task planning browser и 019 Offers browser проходили на clean payment branch до финальных docs-only commits.

Окончательные run IDs брать из последнего HEAD PR #14, а не из промежуточных прогонов.

## После merge

1. Проверить post-merge CI на точном SHA main.
2. Закрыть старый draft PR #3 как **superseded by PR #14**.
3. Не считать production deployment выполненным: SMS/S3/VAPID, юридические тексты, backup/restore и physical-device pilot остаются release gates.
