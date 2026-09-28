# Передача сессии — 019 завершён и слит в main

Обновлено 2026-09-28.

## Текущее состояние

Репозиторий `bairasbai/tili-tili`.

- Этап 019: **T001–T042 завершены**.
- Проверенный application/test HEAD clean integration:
  `38a34e10f839bda9a9c5289287f5925b3b3a087f`.
- PR #5 слит в `main`: https://github.com/bairasbai/tili-tili/pull/5
- Merge commit: `027d6c3eb76e6a31c4ecd8b73c0376a910bd488d`.
- Production самим merge не выкладывался.
- После проверенного кодового SHA в clean-ветке были добавлены только документы закрытия 019;
  application/test code после `38a34e10` не менялся.

Старую линию `feature/019-complete-20260928` больше не использовать для интеграции: она расходилась с актуальным
`main` и содержала дельту отдельной 018-A/B payment-ветки. Канонический код 019 теперь находится в `main`
через merge PR #5.

## Что входит в 019

### US1 — кандидаты

- стабильный shortlist до трёх кандидатов на слот;
- сравнение конкретных пакетов вместо случайной выдачи;
- права couple/helper/coordinator и приватность подрядчиков;
- устойчивые entry id и tombstone после удаления/стирания подрядчика.

### US2 — запросы предложений

- batch-запрос отмеченным кандидатам;
- приватные ответы/отказы подрядчиков;
- версии предложений, квоты и idempotency;
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

## Проверка перед merge

### Standard CI

Run: https://github.com/bairasbai/tili-tili/actions/runs/36363006056

- frontend: **77 files / 1020 tests**;
- backend: **105 files / 1164 tests**;
- PostgreSQL/Redis, миграции, TypeScript, ESLint и production builds — success.

Первый clean CI выявил только три `no-explicit-any` в `backend/test/audit55.test.ts`.
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

## Scope merge

Clean delta 019 содержала миграцию `1761500000000_shortlist_offers.cjs`, 019 API/UI/tests/contract
и необходимые общие интеграционные точки. Отдельные payment-файлы 018-A/B
(`payment_schedule`, `budget_controls_receipts`) в PR #5 не входили.
Временный workflow ремонта generated schema был удалён до merge.

## Что делать дальше

Следующий продуктовый этап roadmap — **020: семейные приглашения и отдельные персоны**.

Перед началом 020:
1. Работать от актуального `main` после `027d6c3e`, а не от старых 019-веток.
2. Не переносить в 020 payment-дельту 018-A/B, если она отдельно не интегрирована.
3. Сначала обновить spec/plan/tasks этапа 020 относительно фактической схемы после 019.
4. Сохранять отдельный browser gate для затрагиваемых пользовательских сценариев.

Внешние production-gates (юридические тексты, SMS/S3/VAPID, test/production deployment,
эксплуатационный backup/restore и физические устройства) остаются отдельными и не считаются закрытыми этапом 019.
