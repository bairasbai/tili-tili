# Проверка 019 — clean integration / финальное закрытие

Дата: 2026-09-28.

Статус: **этап 019 завершён, проверен на clean integration и слит в `main` через PR #5**.
Production этим merge не выкладывался.

## Проверенный снимок и merge

- Репозиторий: `bairasbai/tili-tili`.
- База clean integration: `main` `e413afd1cc164da1e1e40563275fce79ccee425b`.
- Проверенный application/test HEAD: `38a34e10f839bda9a9c5289287f5925b3b3a087f`.
- PR #5: https://github.com/bairasbai/tili-tili/pull/5
- PR #5 merged 2026-09-28; merge commit:
  `027d6c3eb76e6a31c4ecd8b73c0376a910bd488d`.
- Старую загрязнённую линию `feature/019-complete-20260928` не использовать для дальнейшей интеграции:
  clean integration была собрана отдельно на актуальном `main` и исключила дельту отдельной 018-A/B payment-ветки.

## Что закрыто

### T039 — hard erase и приватность

Проверено на PostgreSQL без моков:

- hard erase подрядчика удаляет его идентификаторы, телефон, имя и непринятые тексты из рабочих таблиц;
- открытый request закрывается как `vendor_erased`, shortlist/request остаются обезличенными tombstone;
- непринятые offers удаляются;
- принятая deal сохраняет immutable коммерческий снимок (цена, название, состав), но не реальное имя стёртого подрядчика;
- один участник пары может быть стёрт при живом втором партнёре без потери обезличенной 019-истории;
- восстановление в 30-дневном окне проверяется реальным OTP API;
- отдельный детерминированный тест держит гонку reply ↔ erase и проверяет порядок блокировок без deadlock.

### T040 — export

`GET /users/me/export` включает:

- паре — её shortlist, offer requests и доступные offers;
- подрядчику — только собственные vendor offer requests / offers;
- helper и посторонний подрядчик не получают чужие 019-данные через export.

### T041 — browser E2E

Run **36363005956**:
https://github.com/bairasbai/tili-tili/actions/runs/36363005956

Результат — **5/5**, `errors=[]`:

1. два кандидата добавлены через карточки подрядчиков;
2. один batch создаёт два настоящих запроса;
3. две независимые vendor-сессии отвечают своими условиями и ценой;
4. сравнение принимает ровно одно исходное предложение и убирает повторное принятие;
5. reload и API обеих сторон сохраняют одну бронь, точную цену и immutable package contents.

Evidence: artifact `offers-browser-evidence`, ID **10945499781**,
SHA-256 `6547ab8c4fd7c03abb9dad683d55d838f39871b9ea10b257560ad4053ba362ad`.

## Полный CI clean integration

Run **36363006056**:
https://github.com/bairasbai/tili-tili/actions/runs/36363006056

- Frontend: **77 files / 1020 tests — passed**.
- Backend: **105 files / 1164 tests — passed**.
- PostgreSQL 16 и Redis 7 подняты в CI; миграции применены успешно.
- Frontend TypeScript, ESLint и production Vite build — success.
- Backend `tsc --noEmit`, ESLint и финальный TypeScript build — success.
- Первичный clean run выявил ровно три `no-explicit-any` в `backend/test/audit55.test.ts`;
  исправление `38a34e10` заменило их на `YamlSchema` без изменения application code, после чего CI зелёный.

## Общий browser regression

Run **36363005964**:
https://github.com/bairasbai/tili-tili/actions/runs/36363005964

Task planning browser E2E: **14/14**, `page_errors=[]`.

Evidence: artifact `task-planning-browser-evidence`, ID **10945469773**,
SHA-256 `9be1f45ea90650e1c569ace6bf01c72ce410e0fea51b26a0627f1573ae201c2b`.

## Scope-аудит merge

Перед merge сравнение clean integration с тогдашним `main` показывало 019-код, одну миграцию
`1761500000000_shortlist_offers.cjs`, 019-тесты/контракт/UI и необходимые общие точки интеграции.
Файлы отдельной payment-ветки 018-A/B (`payment_schedule`, `budget_controls_receipts` и её документы)
в clean delta не входили. Временный workflow ремонта generated schema был удалён из итогового дерева до merge.

## Итог

- [x] T001–T038
- [x] T039
- [x] T040
- [x] T041
- [x] T042
- [x] Clean integration в `main` через PR #5 / merge `027d6c3e`.
- **019 завершён полностью.**
- Следующий этап roadmap: **020 — семейные приглашения и отдельные персоны**.
