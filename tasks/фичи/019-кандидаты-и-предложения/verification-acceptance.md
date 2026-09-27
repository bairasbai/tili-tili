# Проверка 019 / US3: принятие предложения → бронь

Дата поставки: 2026-09-28. Только feature-ветка; main и production не изменялись.

База: `c4d37c2995d2aeb28bd988cb5144af164ff9fb60`.
Дельта исходников: SHA-256 `8eb5e22ed77e18b794ba1e803376dae0a49c3b0a81096d03f54b667ea5806e20`.
[Общий gate: 2269 тестов, типы, линт и сборки](https://github.com/bairasbai/tili-tili/actions/runs/36344285636) (попытка 1).

## Реально выполнено

- Node 22; PostgreSQL 16 и Redis 7 в одноразовом CI-окружении; все миграции применены.
- `TEST_DATABASE_URL=postgres://tili:tili@127.0.0.1:5432/tili_test TEST_REDIS_URL=redis://127.0.0.1:6379 bash init.sh` — exit 0.
- Frontend: 78 passed (78) файлов; 1056 passed (1056) тестов.
- Backend: 106 passed (106) файлов; 1213 passed (1213) тестов.
- TypeScript, ESLint по всему дереву и обе production-сборки — exit 0.
- 42 новых проверки: 21 с реальной PostgreSQL и 21 экранная. Прежние offers019/shortlist019 сохранены и исправлены их фикстуры/барьеры.
- SHA-256 каждого из 41 изменённого файла проверен перед публикацией. Полный gate выполнен до запуска браузерных серверов.

## Браузер, без моков API

Playwright 1.57.0 / Chromium; viewport 390×844. Отдельная база `offers_test`, независимые сессии пары и двух подрядчиков.
- Two candidates added through vendor profile buttons
- One browser batch sends two real offer requests
- Independent vendor sessions reply with their own package and price
- Comparison accepts exactly one original offer and removes acceptance controls
- Reload + both API views preserve one booking, exact price and immutable package contents
- JavaScript page errors: 0. Проверены цена 7 500 000 копеек, один deal, закрытие обоих запросов и одинаковый неизменяемый состав в API пары и подрядчика.
- Актуальный браузерный артефакт `offer019-verification-final` в [этом запуске](https://github.com/bairasbai/tili-tili/actions/runs/36344929416): result.json, 01-compare.png, 02-booked.png; full-gate.log скопирован без изменений из предыдущего общего gate (SHA-256 `4e1497320fa6a255d30618eb1d8a8657b9f1590715bdc9f8d0dd3b23a78d0eef`).

## Инварианты и границы

Тесты покрывают дубли и конкурентное принятие, замену ответа, удаление пакета, истечение срока в разных поясах, stale-даты, занятую дату с откатом и повтором, роли, приватность, закрытие при переносе/отмене и сохранение принятого снимка после стирания подрядчика.
Локально также выполнен полный gate с PostgreSQL/Redis: frontend 1056 и backend 1213, exit 0. Локальный Chromium заблокирован политикой среды; политика не менялась, браузерная приёмка выполнена на обычном GitHub runner.
T032–T038 и T041 закрыты. T039 (полная обработка стирания/tombstone), T040 (экспорт) и T042 (финальная приёмка всего 019) остаются открытыми. Проверка сохранения принятого снимка не закрывает T039 целиком.
SMS, S3, юридическая приёмка, production deployment и реальная репетиция восстановления в этот прогон не входят.

## Уточнение браузерной приёмки

При просмотре первого скриншота обнаружено: URL менялся раньше DOM, поэтому прежнее ожидание могло нажать «Принять» ещё на экране слота. Тот скриншот не доказывал принятие из сравнения.
Тест усилен ожиданием заголовка «Сравнение» и таблицы; кнопки ищутся и нажимаются только внутри неё. [Повторная приёмка](https://github.com/bairasbai/tili-tili/actions/runs/36344929416) прошла все пять шагов, page errors = 0. SHA-256 исправленного сценария: `b69ca801b139c59515534b48d442a5167b35387db307d3f2b02fb3dedabc222e`.
Общий gate повторно не запускался: перед новым браузерным прогоном Git проверил, что относительно проверенного `c3af41dca5f28b64f9feeaf8b7ac44effe65ab26` изменён только Python-сценарий E2E; весь код приложения и 2269 тестов остался побайтово тем же. После приёмки обновлены только этот протокол и журнал. Итоговая ветка сохраняет один feature-коммит непосредственно над исходной базой.


## Финализация 019 · T039/T040/T042 · 2026-09-28 ✅

Итоговый проверочный SHA: `06f2e3b98449e6e7d621eda01cc3fcd9b8bf5021`.
GitHub Actions: https://github.com/bairasbai/tili-tili/actions/runs/36352817493

- targeted `accept019.test.ts`: **25/25**
- frontend: **78 файлов / 1056 тестов**
- backend: **106 файлов / 1217 тестов**
- TypeScript, полный ESLint, frontend/backend production build: **success**
- real Chromium T041: **5/5**, `errors=[]`
- browser steps: два кандидата → один batch request → две независимые vendor-сессии → сравнение → одно принятие → reload/API snapshot
- evidence artifact: `offer019-finalization-evidence`, id `10943425246`
- artifact SHA-256: `40ec4f0889c41d28f6e39d5b4c3993e3d03b726cf0b623e78d1775753ed63d00`

T039, T040, T041 и T042 закрыты. Этап 019 завершён; следующий roadmap stage — 020.
