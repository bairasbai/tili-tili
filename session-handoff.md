# Передача сессии — 019 слита в main

Обновлено 2026-09-28. Репозиторий `bairasbai/tili-tili`.

## Текущее состояние

- 017-A/B слиты через PR #1. Merge commit: `e2cb4e6ecd0ec3157ac0e6fc9eb285aba750e821`.
- 018 «ответы квиза влияют на свадьбу» слита через PR #2. Merge commit: `e413afd1cc164da1e1e40563275fce79ccee425b`.
- 019 «кандидаты и предложения» слита через **PR #5**. Merge commit и текущая база этой передачи: `027d6c3eb76e6a31c4ecd8b73c0376a910bd488d`.
- PR #5 собирался как clean integration непосредственно поверх актуального main; промежуточные 018-A/B payment changes и отдельный branding commit в него не переносились.

## Что закрыто в 019

T001–T042:
- shortlist до трёх кандидатов на слот;
- batch offer requests только кандидатам и приватные ответы подрядчика;
- квоты, idempotency и lock ordering;
- сравнение кандидатов и предложений;
- принятие предложения через единое booking-core;
- immutable snapshot согласованной цены, названия и состава пакета;
- закрытие остальных запросов при брони и обезличенные уведомления;
- stale/expired/superseded offers, перенос даты и отмена свадьбы;
- hard erase / tombstone;
- privacy export с изоляцией ролей;
- стабильные vendor package IDs (FR-006);
- реальный browser E2E.

Спека, план, задачи и доказательства: `tasks/фичи/019-кандидаты-и-предложения/`.

## Дополнительный аудит

После завершения 019 повторно проверены concurrency, idempotency, privacy/data-erasure и атомарность бронирования.

В `backend/test/accept019.test.ts` добавлен regression guard: если выбранный подрядчик становится недоступен внутри `bookVendor()` уже после `closeSlotRequests()`, вся транзакция обязана откатить:
- закрытие offer requests;
- уведомления остальным подрядчикам;
- создание deal;
- `accepted_at/deal_id` у offer.

Этот guard уже находится в слитом main.

## Контракт и миграции

Clean main после 019:
- OpenAPI: **0.45.0**;
- **138 путей / 183 операции / 78 схем**;
- миграция 019: `1761500000000_shortlist_offers.cjs`.

Порядок продуктовых миграций сохранён:
`176100` → `176110` → `176120` → `176130_quiz_answers_matter` → `176150_shortlist_offers`.

Payment-schedule / receipts / budget-controls из отдельной старой 018-A/B линии в clean 019 не входят.

## Принятые gates PR #5

На head `38a34e10f839bda9a9c5289287f5925b3b3a087f`:
- CI — success: frontend **77 файлов / 1020 тестов**, backend **105 файлов / 1164 теста**;
- миграции на чистой PostgreSQL — success;
- TypeScript, ESLint, frontend/backend production build — success;
- Offers 019 browser E2E — success;
- Task planning browser E2E (регрессия 017) — success.

Runs:
- CI: `36363006056`;
- Offers 019 browser E2E: `36363005956`;
- Task planning browser E2E: `36363005964`.

Дополнительный audit report: `tasks/фичи/019-кандидаты-и-предложения/verification-acceptance.md`.

## Не сливать повторно

PR #6 / `integration/019-audited-20260928` — дублирующая параллельная integration-ветка, появившаяся до того, как стало видно, что PR #5 уже слит. Её нельзя сливать поверх main; полезный audit regression и verification document уже присутствуют в PR #5/main.

## Следующий этап

Следующий roadmap stage — **020**. Перед началом/слиянием 020 использовать `027d6c3e` или более новый main как базу и не переносить старые ветки 019 целиком.

Production deployment не выполнен и не следует из успешного merge. Внешние release blockers (юридические тексты, SMS/S3, реальная репетиция восстановления, тестовый домен и др.) остаются отдельным треком.
