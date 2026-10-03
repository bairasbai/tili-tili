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
