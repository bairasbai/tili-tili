# T009 R1.2 · завершённая сделка без даты

Локальная приёмка R1.2 завершена. Доставка через commit/CI/обычный merge ещё впереди. Полный T009 открыт. Production не затрагивался.

Ветка `codex/wp04-t009-undated-terminal-20261019`, база и повторно fetched main `9b43a081c72a426fefd55ed5307c1e3c005e53d5`. E=`C:/Тили-тили/.unlazy/wp04-t009-undated-terminal-20261019`.

## Изменение и риск

Новая миграция `Тили-тили/backend/migrations/1763860000000_deal_day_scope_undated_terminal.cjs:4` заменяет три function bodies. Ветка `done_undated` (:30) хранит завершённую catalog/main привязку с NULL date/day, типизированным predecessor и точным прежним tuple. Исторический matcher (:66) допускает позднее изменение main date; dated `done_retained` сохраняет прежний DATE-pointer guard. В `src/deals/day-scope.ts:16` добавлен только union member. Public financial transitions, API writers, inventory2 и pending guard не менялись.

Down (:156) сначала берёт ACCESS EXCLUSIVE versions→heads с LOCAL lock_timeout5s, затем проверяет ANY done_undated history. При наличии истории, включая released head, откат отказывает23514/deal_day_scope_preserving_down. Дальнейшие изменения требуют сохраняющего forward. Старые87 миграций и literal3down definitions неизменны. Pre-done writer freshness требует будущих atomic writers и здесь не активирована.

## Проверки

- Frozen contract CBD28/source-reviewCC9FF5. Canonical67/49039/source-reviewA0A129. Final productSOURCE0B8CAD1D, P1/P2нет. Migration91633/reader804C; all87 applied raw-exact.
- Meaningful RED dedicated87/OID16384:3positive PASS+5expected-success отказов INSERT_VERSION/23514/deal_day_scope_shape;59filteredUNRUN. Четыре public main NULL-date done200 committed до append, atomicSQL вариант откатил root state. Q03E8F802/независимый ACTUAL655E808F.
- GREEN88:67PASS/0skip,46committed appends/41exactSQLrefusals/5real outerCOMMIT refusals/58publicdone200. Whole107:106nonAudit exact, audit6→12, все12observedretained. Q3DC31694/независимый E133DD8D. Это storage/API covered scenarios, не writer activation.
- Current88 admission:121PASS/0skip. Historical83/85/86/87 manifests сохранены; sealed88tail91633 и обязательные current88 leaves. Worker inverse: только CI87→88 и один bounded reversal, прежние10exact; local83 не менялся. ADMISSION88-GREEN-QUALIFICATION.json.
- Итоговый preserving28: helper0FC48F51/main65F18AA9,31own migrations/21guardedCLI, native0EOF2/noForce. Реальный writer27476 блокировал down waiter2784 на AX versions; actual55P03/lock timeout, затем writerCOMMIT. Populated87 up/down/up/repeat,3SQLrefusals с двумя outerCOMMIT,2actual23514historydowns inclreleasedhead. Q2E750658/независимый ACTUALE18EDF9D. Сохранность107rows/catalog/functionmetadata проверена выполненными frozen assertions; полные промежуточные107arrays отдельно не сохранены. Raw-row/WAL/sequence-counter equality не заявляется.
- Полный backend V3:3710PASS/163files/0fail/0skip/todo, types/tests/lint/build, все4native0EOF2/noForce. FULL-R1-2-V3-QUALIFICATION.json76FEC283;828source beforeA00A69/after01CF3E/current exact; новый backenddist272/CF581E21. Старые51 regression прошли в этом полном прогоне.
- Full DB OID16385 повторно использована без reset. FULL-V3-AUDIT-PRESERVATION.json98734D37: все12310 прежних literal audit rowstrings сохранены среди24621;88journal/107tables/6functions fullmetadata+bodies/locale exact, версии0/heads0/peers0, тот же sysid/data/postmaster. PostSQL native2/0EOF2.
- Frontend2983/141 из Q193C20E0 переиспользован явно по неизменным374inputs и91старому dist leaf. Нового frontend-прогона здесь нет.
- Compiled80:13+67=80PASS/2files/0skip, все5native0EOF2. Actual backenddist/imports/настоящий loopback HTTP,38+162requests. Freeze03CAE7D7; native run-compiled80-e2bf026f-bd37-426e-98ed-0314e1075fd1. COMPILED80-QUALIFICATION.json9698ED7E/source84E6/independentSOURCE4EC63085:whole107/106nonAudit literalexact, baseline12/final19, все19observedretained; nativeaudit12/19 exactID+semanticJSONvalues отдельно связаны с rawrows. IndependentACTUAL12EB5A107BE9826E07999CD143660722F75D8AEBB8180490C7FC03895FEFBF88 принят Root целиком; P1/P2 в scoped80 не выявлены.

## Сохранённые отказы

FAILED26 остаётся FAILED: exit1/EOF2/helper224. Oracle искал RAISE text во всём выводе CLI, включая SQL echo. Исправлены actual Error parser и raw-before-assert; нельзя задним числом подтвердить недостигнутый writerCOMMIT или несохранённые inner Error26 fields. DB26/OID23858/schema88/versions4/heads3/audit0 со107таблицами сохранена. Повторы на новыхDB27/OID30308 и28/OID37739 оставили26/27 неизменными.

ПолныйV2 остаётся FAILED: tests3710PASS, но lint7errors, buildUNRUN. Oldhelper9494/mainC96E/streams/JSON04F7 сохранены; исправлены только stdout/no-console и cleanup-error structure, затем повторены lint/drill28/все4fullV3. Сохранены supervisorREFUSED/SOURCErejections, oldbeforeE77EA6UNQUALIFIED и binder9A0 SOURCE-rejection. FastNode--check0EOF2 без exe/CIM не назван qualifiedPASS. Все прежние FAILED/audits/data/шесть dirty-docs старогоworktree/publication сохранены.

## Ресурсы и доставка

Root штатно остановил свои PG14348/15432 и Redis19984/56379: run-normal-stop-80387b54-ca13-47ae-b548-3eaf69ad6625, native2/0EOF2/noForce, pg_ctl0/memurai-cli0. Exact PID/birth/exe/cmd/children/loopback и SQLreadonly/nootherclients проверены до stop. Данные не удалялись; browser не запускался.

FINAL-OWN-CLEANUP-PREDELIVERY A8E6496F:447known+30fallback/live0uncertain0, reusedPID не трогались. RESOURCES-R1-2-PREDELIVERY CD0648D6:15432/56379/53216/59562/59604free, old6dirtydocs/publicationE2F39exact. Независимый cleanupACTUAL7801CBC3. HTTP workers7468/28116 отсутствуют, оба explicitopen.port свободны: OS-v2FC8D0AA2. Первый неполный OS-v1 сохранён UNQUALIFIED, не заменял actual test result.

Scoped commit/push/PR, current final-head CI/native49 и source→commit→CI bindings, freshmain ordinarymerge/parents+tree и postmergeOS ещё pending. Итог доставки будет записан в E/PUBLICATION-R1-2-FINAL.json. Полный T009 остаётся OPEN: atomic writers/DATE holders/mixed/retry/ACL/inventory2 и отдельная приёмка активации впереди. Production запрещён.

21 октября: source828/dist272/fullrefgraph повторно exact после паузы (RESUME-SOURCE-20261021). Fresh OS53B4C7D4/resources90995986:447known+30fallback/live0uncertain0, все5checkedportsfree; старые6docs/publication неизменны. Полный backend независимый ACTUALF8F4B90B принят ранее; повторного runtime после документальных/FS-qualifier правок не заявляется.
