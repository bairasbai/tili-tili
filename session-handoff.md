# Передача сессии — 019 завершён на clean integration

Обновлено 2026-09-28.

## Текущее состояние

Репозиторий `bairasbai/tili-tili`.

- Текущий `main` при сборке clean integration: `e413afd1cc164da1e1e40563275fce79ccee425b`.
- Этап 019: **T001–T042 завершены**.
- Чистая ветка: `integration/019-complete-clean-20260928`.
- Проверенный application/test HEAD: `38a34e10f839bda9a9c5289287f5925b3b3a087f`.
- Последующие коммиты закрытия 019 меняют только документацию.
- Draft PR для проверки/слияния: https://github.com/bairasbai/tili-tili/pull/5
- Production не менялся.

Старую линию `feature/019-complete-20260928` напрямую не сливать: она расходится с текущим `main`
и содержит чужую дельту отдельной 018-A/B payment-ветки. Для merge использовать только clean integration / PR #5.

## Что входит в 019

### US1 — кандидаты

- стабильный shortlist до трёх кандидатов на слот;
- сравнение конкретных пакетов вместо случайной выдачи;
- права couple/helper/coordinator и приватность подрядчиков;
- устойчивые entry id и tombstone после удаления/стирания подрядчика.

### US2 — запросы предложений

- batch-запрос отмеченным кандидатам;
- приватные ответы/отказы подрядчиков;
- версии предложений, квоты, idempotency;
- отображение ответа на месте, в карточке и сравнении.

### US3 — принятие и бронь

- идемпотентное принятие предложения через общее ядро брони;
- immutable snapshot цены, названия и состава;
- конкурентное принятие без второй брони;
- закрытие запросов при брони, переносе/первой дате и отмене.

### Privacy / export

- hard erase подрядчика и участника пары без утечки PII в рабочие таблицы;
- непринятые offers удаляются, request/shortlist обезличиваются;
- принятая сделка сохраняет коммерческие условия без личности удалённого подрядчика;
- export пары и подрядчика изолирован по ролям;
- детерминированная гонка reply ↔ erase закреплена тестом.

## Проверка clean integration

### Standard CI

Run: https://github.com/bairasbai/tili-tili/actions/runs/36363006056

- frontend: **77 files / 1020 tests**;
- backend: **105 files / 1164 tests**;
- PostgreSQL/Redis, миграции, TypeScript, ESLint и production builds — success.

Первый clean CI нашёл только три `no-explicit-any` в `backend/test/audit55.test.ts`.
Коммит `38a34e10` заменил их на `YamlSchema`; application code не менялся.

### Offers 019 browser E2E

Run: https://github.com/bairasbai/tili-tili/actions/runs/36363005956

- **5/5**, `errors=[]`;
- две независимые vendor-сессии;
- реальный API и PostgreSQL;
- принятие ровно одного исходного offer;
- reload сохраняет одну бронь, точную цену и immutable package contents.

Artifact `10945499781`,
SHA-256 `6547ab8c4fd7c03abb9dad683d55d838f39871b9ea10b257560ad4053ba362ad`.

### Общий browser regression

Run: https://github.com/bairasbai/tili-tili/actions/runs/36363005964

- Task planning browser E2E: **14/14**;
- `page_errors=[]`.

Artifact `10945469773`,
SHA-256 `9be1f45ea90650e1c569ace6bf01c72ce410e0fea51b26a0627f1573ae201c2b`.

Полный протокол: `tasks/фичи/019-кандидаты-и-предложения/verification-finalization.md`.

## Scope перед merge

Clean diff относительно `main` содержит 019-код, миграцию
`1761500000000_shortlist_offers.cjs`, 019 API/UI/tests/contract и необходимые общие интеграционные точки.
Отдельные payment-файлы 018-A/B (`payment_schedule`, `budget_controls_receipts`) не входят.
Временный workflow, которым ремонтировалась генерация схем, удалён из итогового дерева.

## Следующий шаг

1. Дождаться зелёных checks на финальном docs-only HEAD PR #5.
2. Убедиться, что после `38a34e10` нет изменений application/test code кроме документации.
3. После разрешённого merge слить **PR #5 в `main`**, не PR #4 и не старую feature-ветку.
4. Следующий продуктовый этап roadmap — **020: семейные приглашения и отдельные персоны**.

Внешние production-gates (юридические тексты, SMS/S3/VAPID, тестовый/production deployment,
эксплуатационный backup/restore и физические устройства) остаются отдельными и не считаются закрытыми 019.
