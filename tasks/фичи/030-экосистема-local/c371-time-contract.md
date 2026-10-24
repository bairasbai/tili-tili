# 371-TIME — точные конечные границы, первый компонент371

База52f53f7 (PR79), 24.10.2026. Это ограниченная поставка чистого валидатора, **не завершение371/T009**, не включение finite availability. Полный нормативный объём остаётся в [finite-calendar-design](finite-calendar-design.md#L100) и [продолжении](../../wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md#L91). Foreign untracked `c382-bounds-contract.md` не принят и не переносится. Номер миграции не резервируется: DDL в этой поставке нет.

## Наблюдаемое поведение

Новый внутренний `src/resources/legacy-bounds-time.ts` принимает один недоверенный span и возвращает отдельное нормализованное значение либо422 `validation_failed`. Он не вызывается существующими писателями, не является доказательством согласия/свободы и не меняет БД, доступность, политику, DATE, деньги, API или UI. Прежние conservative boundaries сохраняются целиком. Подключение только вместе с общим371 gate; промежуточное включение запрещено.

Точные входные ключи: `spanMode`, `localStartsAt`, `localEndsAt`, `startsAt`, `endsAt`, `timeZone`, `coverage`. `spanMode` равен `explicit` либо `whole_local_day`. Покрытие содержит ровно `preparation`, `travel`, `handover`, `returns`, `remainingWork`, все пять — literal `true`. Простые объекты с обычным/null prototype; символы, accessors, лишние/пропущенные поля и массивы отвергаются без выполнения getter.

Local — `YYYY-MM-DDTHH:mm:ss[.S|.SS|.SSS]`; instant — та же форма с обязательным `Z` либо `±HH:mm`. Годы0001–9999, реальные григорианские даты, часы00–23/минуты00–59/секунды00–59. Никаких24:00, leap second, нормализации30февраля, пробелов, infinity, пропущенного offset, точности выше миллисекунд. Offset максимум23:59; `-00:00` отвергается как неизвестный offset. Результат UTC должен оставаться в0001–9999. Конец строго позже начала.

`timeZone` — непустое точное имя длиной≤100, поддерживаемое ICU runtime (IANA names/aliases и `UTC`); числовые offset-зоны отвергаются. Никаких trim/default/Moscow fallback. Для каждого **заданного** instant форматирование в указанной зоне должно дать точные все local-компоненты, включая миллисекунды. Валидатор не угадывает instant из wall time: при DST fold допустимы оба явно заданных соответствующих instant, при gap соответствующего instant нет.

`whole_local_day` дополнительно требует две местные полуночи ровно соседних календарных дат. Длительность UTC определяется указанными проверенными endpoints; нет прибавления24часов. Положительные независимые fixtures включают23/25часов Europe/Berlin и23.5/24.5часа Australia/Lord_Howe; missing-midnight Pacific/Apia отвергается. В режиме `explicit` допустим переход через полночь, несколько суток и fold с одинаковыми wall-часами при возрастающих instant.

Результат содержит те же `spanMode`/`timeZone`/coverage, local в `.SSS`, UTC `startsAt`/`endsAt` в `.SSSZ`, а также точные исходные `suppliedStartsAt`/`suppliedEndsAt`. Вход не мутируется; возвращённое coverage не ссылается на вход. Один span не утверждает полноту holder/group/staffing. Списки, сортировка, пересечения, финальный digest и SQL roundtrip — следующие компоненты.

## Приёмка этой поставки

1. Test-first: исполняемый baseline с тем же интерфейсом и проверкой структуры/конечных instant, затем meaningful RED на неверном wall-time/zone с положительным valid control. Отсутствующий import/route не считается RED; baseline нового модуля не выдаётся за старый product bug. Сохранить baseline, failed вывод и hashes вне W.
2. Проверить строгую форму/реальные даты/границы/precision/coverage/hostile objects, UTC/local roundtrip, DST fold/gap и реальные23/25/23.5/24.5часовые сутки. Ожидания UTC задаются literal независимо от алгоритма реализации; дополнительно проверить их Python zoneinfo runtime, не используя сам валидатор как oracle.
3. Независимое SOURCE review итоговых кода/тестов и ACTUAL review stdout/source hashes; скомпилированный helper выполняется отдельным Node smoke. Это не browser/API/native database proof — они остаются обязательны для полного371. Для неизменённых API/UI/DDL — diff/source boundary check, не искусственный запуск экранов.
4. Affected backend typecheck/full tests/lint/build и current-head CI; фронтенд не изменяется и повторно локально не аттестуется. Миграционного drill этой поставки нет, существующие миграции неизменны. Если полный локальный backend требует служб — только новая зарегистрированная disposable среда под Root; CI также должен пройти обязательные проверки.
5. Документы/отдельный commit/push/PR/current CI/обычный merge/проверка дерева; сохранить raw и источники вне W, проверить прежние FAILED/audit неизменными, убрать только свои процессы и временную копию.

## Следующая зависимая работа (OPEN)

Immutable proposals/holders/receipts/person scope/effect heads/events, purpose `calendar-bounds-read`, каждый distinct customer/performer и все holders, окончательные union locks/freshness, общий occupancy и cross-company identity/new-member guards, lifecycle и безопасные API/UI. Только их общая приёмка допускает изменение доступности. Затем372 adoption,373 manual и374 resource reschedule. TIME не закрывает эти требования и не разрешает владельцу утверждать неизвестное staffing или orphan consent.
