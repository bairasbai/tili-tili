# Права при повторе ответа подрядчика

13 октября 2026. Текущий этап WP00; полный WP00 и WP00–WP16 остаются открытыми. Александр разрешил реализацию и публикацию после проверок; production deployment не разрешён.

## Проблема и наблюдение

`POST /vendor/offer-requests/{requestId}/offers` проверял сессию и согласие перед обработчиком. При повторе сохранённого успешного запроса helper ожидал PostgreSQL, затем возвращал старый ответ без повторной проверки текущих прав.

Root воспроизвёл проблему на исходном обработчике: 12 тестов, 9 passed/3 failed/0 skipped. Три точных native-свидетельства подтверждают ожидание начального DELETE `idempotency_keys` под SHARE-блокировкой. После доказанного ожидания отдельная транзакция отзывала сессию, согласие либо помечала аккаунт удалённым; после COMMIT HTTP возвращал сохранённый201 вместо401/403/401. Положительные проверки обычного повторения, закрытого/принятого запроса, заполненной квоты, скрытой/заблокированной анкеты, чужого actor и изменённого тела/пути прошли. [Actual RED](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/replay-red-qualified.json).

## Изменение

В вызов `withIdempotency` добавлена проверка replay: `lockOrderPrincipal` удерживает пользователя, сессию и действующее согласие до конца транзакции; после ожидания проверяется актуальный JWT через `assertSeatingToken`. Повтор не запускает исходный writer, fanout или проверку бизнес-квоты заново. Сохранённая успешная квитанция не переписывается из-за отказа текущего доступа. [Обработчик](C:/Тили-тили/wp00-replay-access-20261013/Тили-тили/backend/src/routes/vendorCabinet.ts:406), [ветка replay](C:/Тили-тили/wp00-replay-access-20261013/Тили-тили/backend/src/deals/idempotency.ts:190).

Изменены только серверный обработчик, новый regression-набор и serial manifest. UI, API-схемы и миграции не менялись. Независимый рецензент подтвердил неизменность прежнего writer после исключения собственных строк фикса и проверил окончательный regression-набор.

Root выполнил итоговые целевые проверки: 13 passed, 0 failed, 0 skipped. Четыре native-свидетельства подтверждают реальное ожидание PostgreSQL; отдельное свидетельство подтверждает истечение настоящего подписанного JWT после начала ожидания. Точная очистка собственных UUID завершилась. JWT-сценарий добавлен после первоначального RED из 12 тестов. Типы backend и lint изменённых файлов прошли. [Actual GREEN](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/replay-green-qualified.json).

## Стенд и сохранность

Отдельное дерево `C:/Тили-тили/wp00-replay-access-20261013`, ветка `codex/wp00-replay-access-20261013`, исходный main373933e сверён одним разрешённым fetch. Чужие незакоммиченные изменения `wp03-continuation-20261010` не включены.

Новый собственный PostgreSQL16 на15432, database `tili_ecosystem_full_20260930_test`, physical ASCII data directory, role `codex_test`, control identity `7696198290725246844`; новый Redis56379/DB0. Перед CREATE проверены отсутствие целевой БД, PID/каталоги/роль/порт/peers и Redis PING/пустая DB0/реальный PID/каталог. Применены85 миграций; исходные fixtures пусты. Старые службы5432/6379 и retained-кластер не изменялись. [Стенд](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/service-owner-readback.json), [схема](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/schema-before-target.json).

При подготовке сохранены реальные отказы: зависший launching wrapper; повреждённый native Unicode data directory; Redis отказал Unicode-каталогу; lint обнаружил throw внутри finally. Условия исправлены без ослабления проверки принадлежности БД и без удаления старых доказательств. Cleanup теста ждёт завершения и транзакции, и HTTP даже при отказе барьера; исключения не подавляются. Все данные сценария синтетические, внешние провайдеры не вызываются.

## Открытая приёмка

Первый штатный прогон завершился с exit1: frontend2621/2621, backend3420 passed/2 failed из3422. Серверный lint и сборка не были достигнуты. Оба отказа связаны с общей очередью `deal_events`: изменение `notified_at` между снимками и оставшееся событие после прохода очереди. В проверке отзыва роли ожидаемый403 прошёл; отказ пришёл от полного снимка.

Внешняя переменная root-запуска `VITEST_MAX_WORKERS=4` переопределяет установленному Vitest `maxWorkers=1`, выставленный для `fileParallelism=false`. Actual resolver подтвердил serial4 с переменной и serial1 без неё. Отдельный повтор двух наборов прошёл150/150,0 skipped; повторный штатный full прошёл все8стадий/6043теста. Код и assertions не менялись; все801 runtime inputs совпали. Первый FAILED сохранён. [Неуспешный full](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/full-failed-qualified.json), [отдельный повтор](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/full-failure-isolated-execution.json), [actual resolver](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/vitest-maxworkers-effective.json).

Первый браузерный запуск подтвердил два случая на compiled-клиенте, собранном при унаследованном NODE_ENV=test:80 завершённых запросов. Независимый reviewer обнаружил React development notice и отсутствие регистрации worker. Этот результат сохранён с ограничением; для релевантной приёмки frontend отдельно пересобран с NODE_ENV=production на тех же801 источниках, backend bytes не менялись.

Повторный production-frontend сценарий принят независимо:2случая/176запросов=176ответов=176finished;168 ответов200+6ответов201+один401+один403=176. Реальная форма отправила первоначальный201 с пакетом и семью условиями. Browser fetch того же path/body/key вернул тот же JSON-снимок; изменение своего каталога не поменяло квитанцию, native ledger и перечитанный кабинет. Раздельный отзыв собственной сессии и синтетическое consent-only изменение получили401/403 без replay-header и закрытых данных. Две console errors относятся к этим ожидаемым отказам; page/external/capture errors0.

Зафиксированы два GET /sw.js. Каждый контекст содержит один cache с51статической записью и0API-записей; controlling worker отдельно не записан. Root просмотрел2оригинальных PNG. Own fixtures удалены, prior rows/audit/receipts сохранены, исчезнувших просроченных receipts0, private files удалены. API/Chromium завершились и порты освобождены. [Приёмка сценария](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/compiled-production-qualified.json). Это узкая приёмка replay; UI retry, полныйSC004, PWA/offline/update/install и весьWP00 остаются отдельными проверками.

- [x] Целевой GREEN окончательной версии: текущие principal rights, JWT-expiry, исторические replay и точная очистка.
- [x] Полный штатный gate: 2621 frontend + 3422 backend = 6043 теста, 0 пропусков; типы, lint, обе сборки прошли. Все 801 runtime input неизменны. [Итог](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/full-v2-qualified.json).
- [x] Сценарий production frontend/compiled backend и перечитывание через HTTP/БД с независимым actual review и own cleanup.
- [ ] Финальные документы, scoped commit/PR, CI итогового SHA/native evidence и ordinary merge с проверкой main.

Гейты и подробные logs/JSON: [GATES](C:/Тили-тили/.unlazy/wp00-replay-access-20261013/GATES.md). Прежний RED сохраняется FAILED; его нельзя превращать в GREEN либо в завершение полного WP00.
