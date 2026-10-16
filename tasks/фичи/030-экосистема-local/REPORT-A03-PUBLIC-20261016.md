# A03 · публичные ресурсные заказы двух мероприятий · 16 октября 2026

Локальный сценарий A03 прошёл: два разных мероприятия одной категории, отдельные позиции/заказы/назначения, согласование пары и компании, обе брони; штатная отмена первой сохранила вторую. Исправлена привязка старого действия заказа к исходной сессии. Полный T009 (включая legacy offer/day flows), остальные A/U/SC и целые WP не закрыты. Production не выполнялся.

Источник требования: [spec A03](spec.md), [T009, строка34](tasks.md). Дерево `wp04-a03-public-20261016`, ветка `codex/wp04-a03-public-20261016`, свежий main `457cc3363f836354f5fb4c51241e01d1d016ed78` повторно fetched перед публикацией (511af6). Старое дерево с семью локальными документами сохранено.

## Исправление

После исходного401 старый запрос мог обновить токен уже выбранного аккаунта B и повторить намерение аккаунта A. Это ошибка клиентского контекста; обход серверной авторизации не установлен. `app/src/lib/api/orders.ts:27` создаёт guard исходной session/wedding/lifetime; четыре Order-компонента передают его в чтения, запись, внутренний retry и перечитывание. Та же проверка проходит через `Tools.tsx:186 → store.tsx:531 → slots.ts:91` при отмене. Тела, версии, readToken и ключи повторов сохранены; штатный refresh той же сессии работает. Общий client, backend, контракт и зависимости не менялись.

Отдельная SOURCE-граница enabled DOM до создания reader закрыта переносом только lifecycle OrderEditor в useLayoutEffect. Исходный full получил writes=[] в существующем cancel-тесте; точный момент reader=null в том прогоне не инструментирован. Assertion, timeout и retry теста не ослаблялись.

## Проверки итогового кода

E=`C:/Тили-тили/.unlazy/wp04-a03-public-20261016`.

- Meaningful RED реального client: `product-red-5f934f1b…` —4 cross-session FAIL/4 same-session PASS; cancel RED `product-cancel-red-7a779b60…` —1 FAIL/1 PASS/8 явно filtered. EPERM/0 tests и matcher failures не считаются RED.
- Авторский GREEN379/379/0skip; после layout-правки Root target116/116/0skip (56Draft+60SessionFence). Новые60 проверяют held401, same-session exact body/key/readToken, unmount/deal/wedding/observed ABA, late body/refresh, private selectors и настоящий Tools/store/slots.
- Итоговый frontend: **2751/2751,133 файла,0skip**, типы/линт/production build PASS; текущие backend types/build PASS. Все6 стадий exit0/обаEOF: `checks-99f3bb0f-f9b3-4c9a-8476-c46de03a4031/result.json`.
- 804 source inputs закреплены до полного прогона и неизменны; compiled91FE/270BE. Прежний backend full3468 не запускался заново: backend/shared byte-exact прежнему проверенному набору. Это не новый local full backend.
- Независимые SOURCE V1–V4; итоговый V4 SHA `CA7E745369DF61B57B13D402BCD01B0879B4DA5ED75C466642E9F9E3A2964C53`. Current CPU:23Node+11Python/syntaxAST PASS и10 извлечённых continuation controls (2positive/8negative).

## Фактический UI/HTTP/SQL

Итог: `E/a03-e25902d0-6cc4-42a4-b0f3-76b47563c67f/result.json`, outer `browser-3a9fe567-4cc2-4ef4-9eea-38292392f30e` exit0/обаEOF. **389API** входят в **892/892 завершённых браузерных запросов**, 23 UI-записи; console/page/external/capture errors=0. Три контекста: пара, второй участник пары, компания. Все13 оригинальных PNG просмотрены Root; их bytes/SHA проверены.

Через UI созданы два second_day события, отдельные florist slot/deal/assignment/part. Компания сохранила планы количества2/4 для Москвы/Новосибирска,10:00–11:00, с буферами30/40/10/20мин. Пара опубликовала условия; обе стороны отдельно прочитали и приняли одну редакцию каждого заказа; оба заказа забронированы. Второй участник пары видел обе брони и сохранённую вторую после отмены первой.

`native-before-cancel.json`/`native-after-cancel.json` и full105 snapshots: второй объект целиком raw-exact (ledger, terms,2receipts, revisions, allocations, deal/history/audit, parts, assignments, plans, money). Первый released/rev2, slot.deal_id=null, allocation quantity2 released reason=deal_cancelled. Ресурс **3legacy+2+4=9 → 3+4=7**; legacy3 неизменен. Программа, timeline, acknowledgments, leads, primary slot сохранены. Payments/installments/corrections/day holds не создавались, цены неизвестны/null.

Браузер не проверял смену аккаунта или свадьбы: эти границы покрыты real-client тестами. Service workers блокированы; это не приёмка PWA/offline, физических устройств или внешних провайдеров.

## Сохранность и уборка

Новая disposable DB `tili_a03_public_20261016_test`, OID31993, создана из pinned clean dump. Защищённые working/archive/allocations/pristine verifier и их metadata/data/sequences сравнивались до/после; exact. Verifier оставался закрыт для подключений. После scoped fixture cleanup **104 nonAudit таблицы exact**, предыдущие20 audit rows raw-exact и20 новых сохранены: итог40. Для повторов полные105 таблиц сравнивались с hash-bound предыдущим cleanup; аудит не удалялся.

`stand-cleanup.json` и `final-processes-121b62d1…`: PostgreSQL штатно остановлен; проверены222 уникальных записанныхPID, remaining0/listeners0/active profiles0. Десять записей о повторном использовании относятся к шести новым процессам:11404,19112,19980,24916,32424,38644; их новая дата рождения подтверждена, они не завершались. Владелец задачи не установлен (exe:conhost/cmd, Python в окружении Yuldash/системном Python, Java Android Studio); это не оставленные собственные процессы. Семь собственных портов свободны:15432/58928/58929/62106/62108/62788/62789. Кластер/новая DB и аудит сохранены на диске. `preservation-a1107916…` подтвердил803 старых source inputs и123 старых evidence files exact, initial snapshot/original checker неизменны.

[Root qualification](C:/Тили-тили/.unlazy/wp04-a03-public-20261016/root-qualification.json) повторно проверяет native oracle, HTTP bytes/SHA, PNG, источники/сборки, lifecycle, baseline/audit, защищённые базы и ОС. Независимый ACTUAL: **PASS_ACTUAL_A03_RESOURCES_ONLY**, `E/INDEPENDENT-ACTUAL-REVIEW.md`, SHA `14EA0A374A6A79A9B4DC6A79F82A4D9C6EB5F86E9096BADF14C0DBD229CBD3D8`. Визуальный просмотр13PNG выполнен Root отдельно; reviewer проверял hashes/bytes и raw evidence.

Сохранённые отказы: source-only1159b3 (7 CRLF/LF checkout differences, исходные байты обеих версий сохранены); full checks-7609b9b2 (2750/2751); A03-4706325a (SQL alias, до fixtures/browser); A03-9485184b и A03-fb4bcf5f (UI oracle/незавершённые чтения). Они остаются FAILED. Итоговый successful run отдельный; guard сети, lifecycle и audit cleanup не ослаблялись.

Разрешённая публикация и CI фактического SHA фиксируются отдельно в `E/PUBLICATION.json`; это не выкладка на сервер. Следующий продуктовый шаг — оставшиеся legacy/offer/day и смешанные пути T009, с сохранением границ A03 ресурсного сценария.
