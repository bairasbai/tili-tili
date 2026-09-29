# Передача сессии — исправления аудита 021

Обновлено 2026-09-30. Репозиторий `bairasbai/tili-tili`.

## Исходная версия

Исходный аудит: `cdd2f2f6bed9dec02472b566fc12f27ddcaf97f8`, merge PR #19. Перед публикацией main обновился до `ccd68fdcaa5a433c5892469ab5c4c552999901d7`: отдельное исправление той же утечки private sums. Ветка перебазирована на новый main; его три regressions и ERR-0337 сохранены. Код записи платежей совпал с main без дополнительной правки. В main уже есть 017-A/B, 018-Q, 018-A/B, 019, 020 с hardening и 021. Предыдущие handoff про «следующий этап 020/021» больше не являются текущим состоянием.

## Выполнено на fix/021-payment-privacy-vendor-ui

1. slot/pay больше не выставляет legacy_vendor_visible для private платежей. Vendor paid/expected/shortfall/revenue используют только visibility=vendor; старые private/finance_members записи с флагом тоже скрыты. Согласие не угадывается; применённые миграции не переписаны.
2. В карточке, списке и аналитике подрядчика предупреждены неизвестные суммы. Процент дохода null, если неполон текущий или предыдущий период. Недостающие поля vendor responses описаны в OpenAPI 0.52.1; generated types обновлены штатными генераторами.
3. Карточка читает vendor payment history и показывает дату, способ, сумму/неизвестность, статус. Подтверждения скачиваются через защищённый vendor-scoped endpoint; отказ и повтор отличаются от пустого ответа.

Регрессии: 4 новых backend cases и 8 UI cases. На исходном main 4 backend и 7 UI cases падают по ожидаемым причинам; unchanged complete-income case остаётся зелёным. audit33 теперь явно различает private full payment и vendor-visible full payment, без опоры на прежнюю утечку.

## Локальная проверка до rebase

- Frontend: TypeScript, 82 файла / 1097 тестов, ESLint и Vite production build — success.
- Backend: TypeScript, 109 файлов / 1272 теста, 15 skips без локального Redis, ESLint и production build — success. PostgreSQL 16, отдельная disposable database с UTF-8 locale, TZ=UTC как в CI.
- Все миграции на пустой базе — success. Новых миграций нет.
- Реальный Chromium + API, без HTTP mocks: 018 browser 14/14 и новый 021 browser 5/5, page_errors=[]. Проверены private slot payment, раскрытая история, точные байты скачанного чека, warnings в 3 vendor screens, чужой vendor 404; ширины 320/390/1280 без overflow.
- Новый 021 browser включён в existing Payment schedule browser E2E workflow; fixture credentials остаются вне репозитория/артефактов.
- Карты экранов/кнопок, feature doc, JOURNAL и ERRORS (0337–0339) обновлены.

Первый full local run выявил настройки стенда (C locale PostgreSQL и Australia/Melbourne TZ) и прежнее предположение audit33 о раскрытии private оплаты. Стенд приведён к условиям CI, privacy assertion усилен; итоговые прогоны зелёные.

## Проверка после rebase и публикация

- После rebase локально: backend TypeScript, 109 файлов / 1275 тестов + 15 skips без Redis, ESLint и production build — success.
- Исправления опубликованы в [PR #20](https://github.com/bairasbai/tili-tili/pull/20), code commit `9e053811e227ae840e653c9fd279a134e2a658cd`.
- [GitHub CI](https://github.com/bairasbai/tili-tili/actions/runs/36638051912) этого кода: frontend 82 файла / 1097 тестов; backend 109 файлов / 1290 тестов с PostgreSQL + Redis, без пропусков; типы, линт и production builds — success. Миграции и rehearsal 021 тоже success.
- [Payment schedule browser E2E](https://github.com/bairasbai/tili-tili/actions/runs/36638051890): 14 сценариев 018 и 5 сценариев 021, page_errors=[]. [Task planning](https://github.com/bairasbai/tili-tili/actions/runs/36638051905) и [Offers 019](https://github.com/bairasbai/tili-tili/actions/runs/36638052031) — success.

Следующий шаг: ревью и слияние PR #20 в main. Production deployment этим исправлением не подтверждён.
