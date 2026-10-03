# WP10/A13: атомарное первое чтение Plan B · 2026-10-03

Backend runtime, полный init.sh и локальный PWA-сценарий приняты. Отдельная поставка A13/exact-head CI/main ещё pending. Предшествующий nginx коммит affde66f88e897b1fa4a6ede6b5893e8a5cea688 опубликован в [PR37](https://github.com/bairasbai/tili-tili/pull/37), семь CI SUCCESS и ready подтверждены; actual main merge efb4f7e5c89cdb1a1ec4626eefe5e826d8b404fd подтверждён connector/fetch после сверки исходного явного пользовательского разрешения публиковать каждую фичу и вливать в main. Первая автоматическая проверка отказала до этой сверки; вопрос дополнительного подтверждения больше не требуется. Это atomic initialization/access часть T023; обязательный постоянный system key ещё не реализован и T023/A13 целиком не отмечаются выполненными.

## Поведение

Прежний [GET на main2ef67b5](https://github.com/bairasbai/tili-tili/blob/2ef67b5b9d78e70b9361deb6bc91335e45d841a7/Тили-тили/backend/src/routes/dayx.ts#L55) выполнял count и6INSERT отдельно через пул. Actual old-red воспроизвёл12rows при двух zero counts и2сохранившихся INSERT при отказе третьего.

[Новый GET](../../../Тили-тили/backend/src/routes/dayx.ts#L55) использует один Db.tx client. [lockPlanBReadAccess](../../../Тили-тили/backend/src/wedding/access.ts#L233) берёт wedding FOR UPDATE, затем проверяет текущие user/session/member/consent/archive и JWT после ожидания. Count всех PLANB rows, inserts и list выполняются в той же транзакции; JWT проверяется снова перед возвратом. Couple/helper/coordinator разрешены, vendor403/outsider404. Cancelled_at-only при archived_at=NULL допускает чтение; реальный [POST cancel](../../../Тили-тили/backend/src/routes/weddingLifecycle.ts#L178) выставляет оба поля и сохраняет404.

Непустой исторический набор сохраняется как есть: ID/title/done/source/sort/scenario/time, без guessed repair/dedupe. Unique title, DDL, новые API fields и POST activation этим slice не добавлены. Другие callers access helper сохраняют default lock behavior. Источники требований: [A13](spec.md#L46), [T023](tasks.md#L58).

## Actual тесты и source freshness

Root создал strict fresh tili_ecosystem_planb_20261003_test и применил штатные миграции through381. Тест сверяет URL/loopback15432/principal codex_test и actual DB identity; все fixtures synthetic.

| Проверка | Результат | Сохранённый источник |
|---|---|---|
| Actual old code |17failed/11passed из28;12duplicate rows;2committed partial rows|vitest-planb-red1.log|
| ACL/JWT после wait на old code |7first-open ACL cases+expiry вернули200;7existing-set cases не дождались required lock|Red PG witnesses; последний пункт не доказывает применённую authority mutation|
| Новый код |28PlanB+6audit=34passed/no skips|vitest-planb-green1.log|
| Реальные блокировки |19=1race+14ACL+2allowed roles+1cancel+1JWT|Green pg_blocking_pids witnesses|
| Fixture cleanup |users/sessions/consents/tasks/weddings:0 в red/green|PLANB_FIXTURE_CLEANUP|
| Types/линт/full |112files/2105frontend+147files/3163backend=5268passed/no skips;types/full lint/builds exit0|full-planb-full1.log/session23642|
| Freshness |681current file hashes совпали после full и browser8|verify-evidence.mjs full;digest f920126eedb6bbf8972f29e9b0f682a5a8cd21d3cb2558e1698f73d8a25423a1|

Логи: C:/Тили-тили/.unlazy/tz-full-20261002/logs/. Frozen [независимый тест](../../../Тили-тили/backend/test/planbInitialization.test.ts#L169) неизменен после red:SHA A1E8421C0B20944C0358B21D9E78A3BAE4D30A0F8E646B1312BB72D14284043A. Backend3163=прежние3135+28новых cases. Fresh REVIEW-IMPLEMENTATION.md в private codex-planb directory не нашёл подтверждённого defect в inspected A13 patch. Source hashes:dayx f0274345288debac07add08a7ca5379421a8bf1eba94f599cd5aa4cf76848afc;access8425c4ef245d67eca3ce9f09e14fdd84f237328cb26daea52e219f6397ad012c.

При подготовке коммита дополнительно проверены все 13 staged paths и четыре backend blob. Установленный core.autocrlf=true переводит CRLF в LF: byte-exact working hashes выше сохраняются; Git blob dayx=c7b88b830b56a5e80b746348c70c8a5fc27617a5912cdb48bc8b583e2e4cb6c5, access=270cda5ffe8f1a67b06a3cb680454ed5c71d461eaa71ce93645999471ebc4039, registry=1b1d3dcb42bae330e4870b69aeee1d429e821f6acd4abeb106629127d2d42f55. Для всех четырёх файлов staged bytes точно равны accepted working bytes после единственного CRLF→LF преобразования; test hash совпадает без преобразования. Источник: private A13-STAGED-EVIDENCE.json/verify-a13-stage.mjs. Начальная проверка с ошибочным требованием равенства raw working/index SHA отказала на dayx; расхождение проверено по bytes, а не объявлено совпадением. Изменений кода сверх нормализации нет.

## Whole PWA и история отказов

Actual nginx PWA run 80f6aab9-4646-406a-b5f6-c7564ee2c86b / session50489: exit0, result/overall passed,9checks,10consumed capture waits. Две реальные сессии сохранили6IDs/done/title после reload; monthly checklist исключил Plan B; финальный SQL набор тот же. Page/console/HTTP/capture errors=[], raw6=proved expected6+unexpected0;3отмены имеют measured asset-alias proof, остальные exactURL proof. Parent независимо проверил route/build/document/finish witnesses. Source/build/nginx before/after совпали, fixture cleanup users/sessions/consents/tasks/weddings=0. Root просмотрел6PNG RU/EN320/390/480, documentWidth=viewport; горизонтальное clipping не обнаружено. Server task titles остаются RU в EN, fixed navigation на viewport позиции full-page PNG; полный перевод задач/physical devices/human pilot этим сценарием не заявлены.

Actual artifacts:C:/Тили-тили/.unlazy/codex-planb-20261003/browser-80f6aab9-4646-406a-b5f6-c7564ee2c86b/. Source digest 820f00b0cca3756ab344b6ee31ce590672d274d740b96baba1980e0d3a76a95b, build digest b90c5049149736fcdde4b4d8541a58f4719567fb8805561a5aa87f74b51d4339; HEAD2ef67b5 с inspected uncommitted A13+nginx bytes. Отдельный [nginx report](REPORT-DEEP-LINK-ASSETS-20261003.md) показывает native52 probes; deploy config находится вне681-file full manifest.

| Сохранённый failed run | Наблюдаемый отказ |
|---|---|
|9dd673bf-2c47-4e32-b5d7-4ac32ae35b45|Old-document body capture;4Vite deep asset404;production nginx не проверен|
|acb6a5e3-865d-482f-a696-5a0f15de07d9|Initial predicate timeout;точный failed criterion не записан|
|dddf569e-8111-4633-8bea-15625eec779b|Wait timeout при последующем ready=true;точная причина неизвестна|
|d81b1360-bfc2-4e91-8b67-ed2ca442ed1b|Lookup раньше позднее записанного actual PATCH106/200/done=true|
|7f1b34c0-a1c1-4712-a013-dd21b8d62f2b|Monthly locator2matches плюс actual4CSS HTML/MIME errors|
|e88302f1-1024-42a6-b488-d208ebae8bc3|Все8functional checks;exactURL classifier отверг2JS aliases|
|f388d44d-2cc2-429f-9026-0d05b1f78b07|Все8functional checks;script-only classifier отверг1CSS alias|

Источники каждой строки:соответствующий private browser-UUID/result.json/overall.json/cleanup.json; ERR-0437–0443. Все failed artifacts и frozen harness snapshots сохранены. Новая current acceptance не переписывает прошлые outcomes. V9 reviewed126CPU checks поддерживают strict actual route/build/document proof; они не подменяют actual browser8.

## Обязательное продолжение

T023 persistent semantic system keys остаётся partial/unchecked. Private contract/test/implementation прошли source review,69cases лишь authored; actual schema/SQL/HTTP/native preserving/lifecycle/down/restore/full/PWA/CI ещё unrun. Historical NULL сохраняется без guessed backfill/title uniqueness. Provisional382 не зарезервирован до свежей проверки main.

A12 ещё требует конкретные место/действия/ответственных/контакты/адресатов,event,preview/confirm/dedup/manual alternative; private A12-DESIGN.md — подготовка. Полный WP00–WP16 и все FR/SC/NFR/A/U остаются в [ведомости](../../wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md). Synthetic SQL/JWT не является human consent или pilot. M01 manual fields/lifetime и WP11 owner inputs pending; молчание не approval. Goal продолжать после отдельной поставки этого slice.


## 2026-10-03 · A13 фактически поставлен, продолжается T023

A13: [PR38](https://github.com/bairasbai/tili-tili/pull/38), feature644fe299606147c05449c31173b26702ab6cf7db; все7 CI COMPLETED/SUCCESS сохранены в pr38-ci3.json. Connector подтвердил merged=true/main SHA0b099f0394cf25298fc239bcf03fc442c745fd53; root получил этот main через fetch/ff-only, ancestry644fe299 и прежние681 hashes проверены. Предыдущие pending checkpoints сохранены как хронология и этим результатом заменены для статуса A13. Источники: PR38 и C:/Тили-тили/.unlazy/codex-planb-20261003/pr38-ci3.json, pr38-merged.json, A13-STAGED-EVIDENCE.json.

T023 выполняется в отдельной ветке codex/wp10-planb-system-keys. Actual prior381 oldred:18failed/51filtered;10 DML реально приняты и изменили снимки,7 storage cases наблюдали42NULL keys. Одна ошибка ожидания не засчитана как semantic defect. Native primary up382 прошёл с сохранением OID581016 и всех81 старых journal rows. Первый unfiltered69:68passed/1failed; direct-blocker predicate не распознал фактическую цепь second→first→holder. Оригинальные oracle/source/logs сохранены, минимальная поправка теста проходит независимый разбор.

Native17 first run f4bfab9b-3fb7-4a46-a651-468b7679cfb6 failed на stage5: projection старой схемы включила3 metadata columns нового index. Первые4 gates выполнены, включая actual42723/whole rollback. Это не полный native acceptance. Оба созданных drill targets и все snapshots сохранены; cleanupErrors=[], ownedchildren0, fixture cleanup0 после этого раннего отказа не заявляется. Нужен исправленный reviewed runner на двух новых absent-only targets, full69/A13/full/PWA/review/featureCI/main. Подробности: REPORT-PLANB-SYSTEM-KEYS-20261003.md.

Полностью подтверждённых WP00–WP16 остаётся0/17; закрытие A13 не закрывает WP10. A12 и все прочие FR/SC/NFR/A/U, M01/WP11/provider/device/human inputs сохраняются. Goal active. Пользователь разрешил публикацию A13 и следующих проверенных фич WP00–WP16; production разрешения нет. По новому указанию создан thread heartbeat30 с отчётом каждые30мин: сделано/осталось/текущий этап/подтверждённое число полных WP.

## 2026-10-03 13:34 UTC · T023: локальные gates пройдены, CI extension pending

T023 на A13 main0b099f0394cf25298fc239bcf03fc442c745fd53 прошёл focus97, full5337 (2105 frontend +3232 backend), оба types/lint/build, native17 run56de1a33-cc31-45ec-8ae2-cb89b0cedda7 и PWA9 run18fe0dec-b4e2-4e08-96f5-acfc7d8a2cc2. Все683 raw source hashes до/после остались54dc5b374627bcc4f214c9c6cf56d9727b24938a40bc0e7f7979682daa650090. Подробные actual results, ограничения и сохранённые failed runs: [T023 report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PLANB-SYSTEM-KEYS-20261003.md).

Публикация ещё pending. Mandatory public CI migration drill допускает только381 и source-preflight отказывает на382; он требует отдельного reviewed extension с сохранением прежних recovery/SQL/down guards и actual нового native запуска. Actual GitHub CI этой фичи ещё не запускался. Полностью подтверждённых WP00–WP16 остаётся0/17, цель active; A12/прочие требования и M01/WP11/provider/device/human inputs сохраняются. Подготовка A12 schema обнаружила source gap transport FK deletion/rebind; исправление допуска схемы выполняется до DDL. Источники: T023 report и его exact artifact links, [A12 schema review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-SCHEMA-API-ADMISSION-REVIEW.md).

## 2026-10-03 14:08 UTC · T023 public CI migration drill пройден локально

Root принял independently reviewed public harness D86175…3BF2 и выполнил его полный native drill на новой exact drill21 базе: exit0/ECOSYSTEM_MIGRATION_DRILL_PASSED/TZ_DRILL_PASSED. Все25 own migrations through382,18 новых named SQL refusals, все19 прежних+2 новых CLI guards=21, actual holder18892/waiter18592/23514 и whole preservation подтверждены raw log. Source binding показывает только1/683 changed file (CI harness), остальные682 exact full5337/focus97/private17/PWA9 inputs неизменны; current digestc53243393d9d4c05263b269eead97baf79002ca118177bfdeaa56a34b429c3d0. Syntax/ESLint нового live script также прошли. Источники и ограничения: [T023 report](/C:/Тили-тили/tili-orchestrate-publish-20261003/tasks/фичи/030-экосистема-local/REPORT-PLANB-SYSTEM-KEYS-20261003.md), [actual native](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/drill-t023-ci-drill-v1.log), [source binding](/C:/Тили-тили/.unlazy/codex-planb-20261003/t023-ci-native-source-binding-1.json).

Commit/push/PR/GitHub CI/main пока pending. Fresh final integrated source review выполняется. A12 V2 transport design source-reviewed, original R01 устранён только на уровне проекта; root technical decisions не заменяют implementation/native/UI или M01 owner inputs. Full WP0/17, цель active; все WP/FR/SC/NFR/A/U и необходимые owner/provider/device/human gates сохранены.
