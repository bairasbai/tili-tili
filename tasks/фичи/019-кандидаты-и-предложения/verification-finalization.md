# Проверка 019 / финализация T039–T042

Дата: 2026-09-28. Статус: **✅ пройдено**. Main и production не изменялись.

## Проверенный код

- База второй фичи: `776d61fef00c05625f7382988baaded8604d9476` (завершённый US3).
- Финальный candidate кода и тестов: `58a5b56a00e325bb26e0ab701f4c18459855f85c`.
- Чистая feature-поставка содержит этот же прикладной код/тесты, документацию завершения и не содержит
  временный workflow `.github/workflows/verify-019-finalization.yml`.

## CI

[CI 36352964776](https://github.com/bairasbai/tili-tili/actions/runs/36352964776):

- frontend: 78/78 файлов, **1056/1056 тестов**;
- backend: 106/106 файлов, **1217/1217 тестов**;
- миграции PostgreSQL 16 — success;
- TypeScript frontend/backend — success;
- ESLint frontend/backend — success;
- production build frontend/backend — success.

[Verify 36352964812](https://github.com/bairasbai/tili-tili/actions/runs/36352964812):

- targeted T039/T040 — success;
- полный `bash init.sh` с PostgreSQL/Redis — success;
- browser T041 на финальном коде — success.

## Что доказано T039

- Открытый request при стирании vendor закрывается `vendor_erased`; vendor FK становится null.
- Непринятые offers удаляются; shortlist/request остаются обезличенной историей.
- Принятая сделка после terminal-state и hard erase сохраняет price/package title/includes, но не настоящее имя:
  performer = «Удалённый подрядчик».
- Один member роли couple может быть стёрт; свадьба переходит выжившему партнёру, история 019 сохраняется.
- Реальный путь: `DELETE /users/me` → 31 день → `cleanup`; stage9 проверяет восстановление до 31 дня
  настоящим OTP login.
- Privacy scan ищет UUID, phone, vendor name и уникальный unaccepted text как подстроку по всем text/json/jsonb
  колонкам, исключая только намеренный `audit_log`.
- Детерминированная PostgreSQL-гонка erase ↔ vendor reply завершается без deadlock; порядок request → parent сохранён.
- Transient `idempotency_keys` старше суток удаляется и общей уборкой, и прямой дверью `eraseUser`.

## Что доказано T040

- Couple export получает только её shortlist / offerRequests / offers.
- Vendor export получает только его vendorOfferRequests / vendorOffers.
- Helper получает пустые коммерческие коллекции.
- Другой vendor не видит requests/offers проверяемого подрядчика.

## Browser T041

Evidence artifact `offer019-finalization-evidence`, id `10942139253`,
digest `sha256:578e400f3cc106355efbcd8f3be1866ef2b2ff472a3a2444bb2e06f36f1cedd9`.

`result.json`:

1. Two candidates added through vendor profile buttons.
2. One browser batch sends two real offer requests.
3. Independent vendor sessions reply with their own package and price.
4. Comparison accepts exactly one original offer and removes acceptance controls.
5. Reload + both API views preserve one booking, exact price and immutable package contents.

Browser errors: **0**.

## Итог

T039, T040, T041 и T042 приняты. Этап **019 ✅ завершён полностью**. Следующий этап roadmap — 020.
