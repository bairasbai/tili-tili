# Задачи и реестр приёмки

## Продолжение 030/380 · Codex, 2026-10-03

Новое поручение владельца разрешает поэтапные commit/push/merge в main и оркестрацию агентами. Исторические запреты ниже относятся к исходной локальной поставке; production остаётся неразрешённым.

- [x] Сверен свежий remote Claude `de414fa`, сохранены исходные checkout и черновая ветка.
- [x] Независимым анализом и actual PostgreSQL воспроизведены/исправлены orphan rev0, неполные промежуточные holders, external NULL origin и raw cascade/manual deadlock; закреплены регрессиями. Текущая проверка: 65 + 6 = 71 (`vitest-codex380-reviewed-targeted.log`).
- [x] Репетиция380/drill18 прошла23 own migrations,128 SQL-отказов и18 CLI-отказов; source/manifest hashes сохранены в [отчёте](REPORT-INVENTORY-20261003.md).
- [x] После применения380 независимое ревью и actual PG воспроизвели потерю переназначенного дня. Forward381 сохранила прежние строки102 таблиц inventory/full DB и прошла68 inventory +6 audit53 =74 tests. Новые source/head имеют rev0 без снимков/согласий. Накат требует остановленных писателей.
- [x] Независимый read-only review381 и текущего preserving drill; подтверждённых дефектов новой миграции не найдено. Actual mixed manual/cascade гонки в обоих порядках затем прошли в drill20.
- [x] Финальный preserving drill20:24 миграции,128 SQL/19 CLI отказов. Полный init.sh:112/2105 front,146/3135 backend, без пропусков, типы/линт/сборки прошли;680 source hashes совпали. Источники в [отчёте](REPORT-INVENTORY-20261003.md).
- [x] Отдельные fixture/feature commits опубликованы черезPR36: d936458 full5240/no skips/680hashes,7CI SUCCESS; actual merge2ef67b5 fetched. Orchestrator отдельноPR35/a18695b.
- [ ] 371–374 и остальные WP/FR/SC/NFR/A/U: полный объём сохранён в [ведомости продолжения](../../wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md). WP10/A13 red17failed/11pass, после atomic/access fix28+audit6=34passed; fresh review завершён, current full5268passed/no skips/types/lint/build/681hashes. Current whole nginx PWA/6PNG accepted:9checks/10consumed waits/raw6 expected6 unexpected0;7failed runs retained. Nginx отдельно опубликован/7CI SUCCESS/merged PR37 (efb4f7e); A13 опубликован черезPR38/7CI SUCCESS/main0b099f0, T023 черезPR39/7CI SUCCESS/main03f41a0. Atomic profile local acceptance готова, отдельныеPR/CI/main pending; полныйA12 и прочиеWP обязательны.

Отметки приёмки ниже показывают фактическое состояние каждого пункта. Создание документов — подготовка, не реализация. База `9628d0b22711782dec121fa4596119e5fb7cce6a`. Основные [требования](spec.md), [план](plan.md). Commit/push/main правила: только отдельный локальный feature-коммит root-agent; GitHub, main и production не разрешены.

## S0 Изоляция и исходное состояние

- [x] T001 [US8] Root зафиксировать snapshot manifest, inherited WP03 и delta base; подтвердить отсутствие remote и разделение рабочих деревьев без правок другой сессии. Evidence: inherited snapshot9628d0b; baseline-manifest.json и isolation G1. Новый WP03 checkpoint другой сессии ещё не импортирован; это отдельная интеграция, без молчаливой замены.
- [ ] T002 [US8] Root назначить владельцев файлов/shared integration и isolated PostgreSQL/Redis/порты; проверить baseline без её dev/test нагрузки.
- [ ] T003 [US1–8] Root сверить source anchors, ERRORS и источники правды; внести новые правила спокойного UX в основные документы с прямой авторизацией владельца. Не считать документальное изменение completion A/U.

## S1 Режимы и доставка

- [ ] T004 [US1] Реализовать серверные режимы/default и optional Quiz/settings UI; повторный вход/смена режима; тесты U01/U03/U04/U05.
- [ ] T005 [US1] Принятое назначение координатора, отсутствие до acceptance, handoff/fallback без расширения прав; U02, dependency U15.
- [ ] T006 [US6] Разделить in-app storage и push selection, убрать blanket day-X обход quiet; concrete emergency setting/event и recipient prefs; U06/U10.
- [ ] T007 [US6] Transactional outbox/claim lease/attempt/failure/retry/expiry/provider status, test crash/response loss/dedup/access revoke; A14. Реальная доставка отдельным owner/provider gate.

## S2 Мероприятия и назначения

- [ ] T008 [US4] После WP03 checkpoint подключить canonical event identities/version; migration legacy main без предполагаемых приглашений второго дня; person-event participation/menu scopes; A08.
- [ ] T009 [US2/4] Несколько назначений одной категории, стабильные slot IDs и event/order parts; обновить offers/accept/book/cancel old flows; A03.
- [ ] T010 [US8] Проверить scoped invitation/RSVP/diet/guest token, чужую персону и event, конкурентные stale updates и migration preservation.

## S3 Занятость и ресурсы

- [ ] T011 [US3] Typed availability policies: личное время/назначенные сотрудники/комплекты/подтверждаемая поставка; unknown и legacy date locks; A01.
- [ ] T012 [US3] Intervals/setup/teardown/manual travel/capacity, source/freshness/import не снимает app booking; constraints/concurrent actual DB cases; A02/SC010.
- [x] 370 [US3] Технический инвентарь прежнего календаря — задел T011/T012, ни один A/U не закрывает: идентичность и ревизия строки дня, 4 таблицы (`legacy_calendar_sources/versions/version_holders/heads`), обнаружение триггерами БД, свежесть вычисляется, захват владельцем (`src/resources/legacy-source.ts`); без HTTP/OpenAPI/UI (D2). Миграция `1763800000000`; контракт драйвера c370 rev 1; тест `legacyCalendarSources.test.ts` 60/60.

## S4 Заказ, условия и исполнение

- [ ] T013 [US2] Composable typed order и versioned legacy terms reader: timed service/supply/rental/deliverable/appointment, сохранение финансового корня и snapshots.
- [ ] T014 [US2] Минимальные применимые brief fields/валидация/UI всех 35 категорий из spec; combinations/unknown/неприменимые разделы; coverage по category ID.
- [ ] T015 [US3] Реальные сотрудники и scoped duty/contact/resources, приглашение/acceptance/handoff; revoke waiting lock и UI cleanup; A18.
- [ ] T016 [US5] Versioned proposed/accepted terms и существенные изменения состава/цены/срока/замены; previous agreement отдельно; A05.
- [ ] T017 [US5] Actual authored facts/selected checkpoints, handover/receiver и deliverables/revisions/acceptance; A06/A07/U11/U12.
- [ ] T018 [US5] Совместимость с exact-content ack WP03: significant scoped change message, новая актуальность без наследования старого доказательства; U13.

## S5 План и ненавязчивый DayX

- [ ] T019 [US1] Применимость задач/обязанностей, priorities/reuse existing data; скрытие выкупа/аренды/второго дня при отсутствии; U14.
- [ ] T020 [US6] Scoped routing актуальному actor/role/duty/event, couple reserved decisions/escalation, coalescing only same operation type and assignment; U07/U08/U09.
- [ ] T021 [US6] Coordinator departure/backup/queued recipient recheck и fallback к паре, no forced historical resend; U15.
- [ ] T022 [US6] Concrete PlanB location/actions/owners/contacts/event + preview/confirm/dedup/manual alternative; A12.
- [x] T023 [US6] Atomic system checklist initialization unique system key without banning same user titles; real race and fail-mid-init; A13. [Actual local/native/PWA/CI/main evidence](REPORT-PLANB-SYSTEM-KEYS-20261003.md); PR38 atomic access, PR39 keys, fetched main03f41a0. Это не закрытие WP10 или внешних T040–042.
- [ ] T024 [US4/6] Scoped operational dietary update to kitchen responsible, actual receipt version and minimal sensitive data; A11.

## S6 Деньги, аренда, вещи

- [ ] T025 [US7] Count each financial obligation once across assignments/order parts/purchases; components/unknown amounts и действующий Money; A04.
- [ ] T026 [US7] Explicit actual refund/correction reason/source/history/idempotency; promised/received/disputed/partial totals; A16.
- [ ] T027 [US7] Cancelled wedding narrow settlement route/access, no guest/staff operational resurrection; A15.
- [ ] T028 [US7] Supply/rental/item lifecycle, delivery/receiver/return/deposit/dispute and handoff; A06 rental; SC005.

## S7 Логистика и завершение

- [ ] T029 [US4] Multiple person trips/directions/date/event, independent refusal/deadline/change; last seat concurrency; A09.
- [ ] T030 [US4] Rooms/occupants/stay dates/capacity/source confirmed-vs-assigned; legacy family room preserved without invented hotel confirmation; A10.
- [ ] T031 [US7] Last selected event/timezone lifecycle, unknown end and authorized explicit finish; UI/job same source, celebration end separate from obligations; A17.
- [ ] T032 [US7] Open outputs/rentals/refunds/settlement closure and export/archive/support scope retain history and explicit owner policy; SC012/015.

## S8 Локальная проверка и коммит

- [ ] T033 [US8] Принять dependency WP03 offline evidence и integration: version/principal/role/snapshot age, known denial/logout/account switch purge/reconnect, no critical offline false success; A19.
- [ ] T034 [US8] Root contract/business updates and штатная генерация; migration fresh/upgrade/repeat backfill/bad history/constraints/rollback or forward-fix и counts before/after для каждого этапа.
- [ ] T035 [US8] Каждому new read/write/file/export/realtime/jobs path negative roles/isolation/revocation-after-lock, idempotency/response loss/races/failure; SC017/018 и NFR001/002/010.
- [ ] T036 [US8] RU/EN, screen/button maps, 320/390/480 keyboard/focus/labels/loading/empty/offline/conflict browser scenarios с настоящими API; no false unknown-to-zero.
- [ ] T037 [US8] Full isolated `bash init.sh`, contract generators/types/lint/build/DB/Redis и all relevant browser evidence точного snapshot/SHA, skipped/failure register; повтор после прикладного изменения.
- [ ] T038 [US1] Role UX fixture normal host with 0 mandatory periodic reports, detailed couple mode same result; grouped changes/current message и distinct decisions; observation не human pilot evidence.
- [ ] T039 [US8] Root recheck only our delta vs inherited base, JOURNAL/ERRORS/handoff/source maps и A/U evidence; отдельный local commit без push/main/production, open limitations reported.

## S9 Внешние доказательства

- [ ] T040 [US8] Owner/provider configured real storage/channel capability/outage recovery и restore в отдельной среде с files+DB; не выводить delivered из accepted; A14 external/A20.
- [ ] T041 [US8] Physical iOS Safari/PWA и Android Chrome/desktop versions с poor network/revocation/reconnect; evidence A20/NFR005/012.
- [ ] T042 [US1/8] Human host/photo/couple/coordinator relevant pilot, record unnecessary actions/interruptions/help and fix blockers; U16/A20. Ненастроенный provider/непроведённый pilot остаётся открытым, не останавливая независимую локальную реализацию.

## Матрица доказательств

Статус меняется только после наблюдаемой проверки; задачи не отмечаются по наличию кода. `Открыт` означает отсутствие доказательства в этом документе, не доказательство отсутствия inherited реализации.

| Критерий | Задачи | Evidence / статус |
|---|---|---|
| A01 | T011/T012 | Открыт |
| A02 | T012/T015 | Открыт |
| A03 | T009 | Открыт |
| A04 | T025 | Открыт |
| A05 | T016 | Открыт |
| A06 | T017/T028 | Открыт |
| A07 | T017/T018 | Открыт |
| A08 | T008/T010 | Открыт |
| A09 | T029 | Открыт |
| A10 | T030 | Открыт |
| A11 | T024/T008 | Открыт |
| A12 | T022 | Открыт |
| A13 | T023 | Принят в границе T023: PR38/PR39, focus97/full5337/native17/PWA9, exact7 CI SUCCESS, fetched main03f41a0; отчёт T023. Полный WP10 и внешние T040–042 открыты. |
| A14 | T007/T040 | Открыт; provider отдельно |
| A15 | T027 | Открыт |
| A16 | T026 | Открыт |
| A17 | T031 | Открыт |
| A18 | T015/T035 | Открыт |
| A19 | T033 | Открыт; WP03 dependency |
| A20 | T040–042 | Открыт; реальные inputs нужны |
| U01 | T004 | Открыт |
| U02 | T005 | Открыт |
| U03 | T004/T038 | Открыт |
| U04 | T004/T006 | Открыт |
| U05 | T004/T015/T035 | Открыт |
| U06 | T006 | Открыт |
| U07 | T020 | Открыт |
| U08 | T020 | Открыт |
| U09 | T020/T038 | Открыт |
| U10 | T006 | Открыт |
| U11 | T017 | Открыт |
| U12 | T017/T038 | Открыт |
| U13 | T018 | Открыт; WP03 compatibility |
| U14 | T019 | Открыт |
| U15 | T021 | Открыт |
| U16 | T042 | Открыт; human pilot |

Общее покрытие: A01…A20 = 20 критериев, U01…U16 = 16, всего 36 (20 + 16). Это размер реестра, не число выполненных улучшений. 42 задачи — номера T001…T042, не оценка времени. Приёмка 030 не подменяет все FR/SC/NFR WP00–WP16; WP11 и другие не относящиеся к этому delta работы сохраняют самостоятельные статусы.

## 2026-10-03 · Принят runtime atomic Plan B и nginx

Actual nginx PWA run 80f6aab9-4646-406a-b5f6-c7564ee2c86b / session50489: exit0, result/overall passed,9checks,10consumed capture waits. Две реальные сессии сохранили6IDs/done/title после reload; monthly checklist исключил Plan B; финальный SQL набор тот же. Page/console/HTTP/capture errors=[], raw6=proved expected6+unexpected0;3отмены имеют measured asset-alias proof, остальные exactURL proof. Parent независимо проверил route/build/document/finish witnesses. Source/build/nginx before/after совпали, fixture cleanup users/sessions/consents/tasks/weddings=0. Root просмотрел6PNG RU/EN320/390/480, documentWidth=viewport; горизонтальное clipping не обнаружено. Server task titles остаются RU в EN, fixed navigation на viewport позиции full-page PNG; полный перевод задач/physical devices/human pilot этим сценарием не заявлены.

Full5268/681-file f920...25423a1 повторно сверён после browser8; native52 baseline/candidate probes приняли E7 nginx. Источники и seven failed runs: [Plan B report](REPORT-PLANB-ATOMIC-20261003.md), [nginx report](REPORT-DEEP-LINK-ASSETS-20261003.md), ERR-0437–0443. Nginx отдельно опубликован в [PR37](https://github.com/bairasbai/tili-tili/pull/37), head affde66, exact7CI SUCCESS, actual merge efb4f7e5c89cdb1a1ec4626eefe5e826d8b404fd получен fetch; A13 отдельные commit/CI/main ещё pending. T023/A12/fullWP10/остальные WP и pending owner inputs сохраняются; goal active.


## 2026-10-03T18:27:32.048Z · A12 profile · local acceptance готова к отдельной публикации

Три product-файла, два независимых test suites и serial registry сохранены в точных проверенных bytes. Fresh final source review не нашёл material bounded blocker: [review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-PROFILE-FINAL-SOURCE-REVIEW.md). Actual PG/HTTP RED13=9failed+4passed → GREEN13passed; actual оба creator orders прошли отдельно на primary и штатном FULL target. Последний штатный full5350=2105frontend+3245backend/types/lint/build относится к685 inputs до supplement; два supplement cases проверены отдельно, все686 final inputs сохранены. Новый full5352 этим не заявляется.

Root принял actual browser V5 run892dcec9-a9d4-4f20-a121-2fc8d4cf7c23: child/parent passed,30consumed captures,12layout records,6 RU/EN320/390/480 PNG просмотрены. Два genuine same-client SQLSTATE22012/HTTP500 — UI и compound user+prefs — дали whole rollback. Все9 raw navigation cancellations и3 raw response.body protocol disposals получили independently recomputed exact chronology/replacement proof; unexpected errors0. Raw failures сохраняются. OID620849/own sixmutable cleanup0/audit[]/othersessions[]; source/build до/после/current равны. [Квалификация](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-profile-browser-v5-qualified-root-1.json). V2/V3/V4 failed runs не изменены. Физические устройства/provider этим не проверены.

Подготовлена только отдельная публикация atomic profile/default-prefs. OTP consumption, user restore/audit и выдача сессии не включены в эту короткую auth-default транзакцию; whole-login atomicity не утверждается. Публичный feature commit/push/PR/CI/main ещё pending. Ни этот prerequisite, ни прошлые A13/T023 не закрывают полный A12/WP10; fully accepted WP00–WP16 остаётся0/17. Private C04/C05 и UI candidates не включены вlive. Последний плановый отчёт18:15UTC/21:15МСК; следующий18:45UTC/21:45МСК.


## 2026-10-03T20:16:15.410Z · Плановый отчёт23:15МСК · adoptedC04/C05 · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Цель active; следующий отчёт20:45UTC/23:45МСК. За период включены exact24backend+4UI+UI22test+OpenAPI; generated4raw changes включают2typed semantic additions409 и2CRLF→LFonly. [Adoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-adoption-root-1.json). Native30RED18/12→GREEN30 иpostfixworker19GREEN приняты ранее, не являются wholeA12/WP acceptance.

Первый full frontend2127=2123PASS+4FAIL остановлен доbackend/lint/build. Ошибки lifecycle/browserSubscription, StorageEvent.storageArea и opaque same-session fixture подтверждены freshsource review; exact3fixturecorrections privateготовы, assertions/counts сохранены, adoption/rerun pending. [Failurelog](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/full-a12-c04-c05-full-1.log), [fixture review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C05-EXISTING-FIXTURE-SOURCE-REVIEW.md).

Отдельные backendwholetypes иwholelint actualexit0 (root tool chunks7a65d5/60fa84, emptyoutput), наcurrent717sourceF6B0F86BC650EF0D98EEFD76B0F56B4413039CDBDDADECD4D3913AA61F6DBB19. Fullbackendnative статус на момент записи: **ВЫПОЛНЯЕТСЯ:root tool session16163, completed execution artifact отсутствует; результата пока нет**. RootactualFULLtargetOID517419/native82/Redis12 attested; это existingdisposabletarget, не absent-only новая база. [Preflight](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-full-preflight-root-1.json).

Freshlive integrationreview не нашёл иного boundedmaterialblocker; R01exactserver409ENtranslation подготовлен и admittedsource-only. [Review](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-LIVE-INTEGRATION-REVIEW.md), [i18nproposal](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-server409-i18n-v1/SOURCE-DELTA.json). ActualnativePWA/API browser иportableCI implementation готовятся source-only отдельно; no completed runtime claimed.

Остаются actualfocused/full/build/browser/portablelocal+publicCI/отдельная поставка этого блока и первоначальные WP/FR/SC/NFR/A/U. Новые C01–C08 graph/staff/read/lease/erasure/retention сценарии не закрыты49native+22UI. Асинхронно запрошены отсутствующие M01fields/access/deletion иWP11products/prices/entitlements/provider; ответа пока нет, зависимые policy choices не приняты. Я не могу это подтвердить: provider/device/human acceptance и завершение любого полногоWP. [Отчёт блока](tasks/фичи/030-экосистема-local/REPORT-NOTICE-ADMISSION-20261003.md).


## 2026-10-03T20:45:28.387Z · Плановый отчёт23:45МСК · regression repair · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Цель active, следующий отчёт21:15UTC/00:15МСК 04октября. За период включены исправленные frontend fixtures и точный ENперевод реального server409. Actual focused4suites **105/105PASS**, первый focused104PASS/1fixturebrandFAIL сохранён. Это synthetic browser/HTTP evidence, не physical/provider proof. [Actual105](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-c05-ui-integration-2.log), [fixturebrand receipt](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-fixture-brand-fix-root-1.json), [ENadoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-server409-i18n-adoption-root-1.json).

Первый полный backend завершён: **3247=3211PASS+36FAIL**,7failedfiles. Это не полный успех. Две реальные ACLошибки404/403→409 подтверждены rawHTTP; изменение selectedvendorowner выявлено как source-risk, исходный тест остановился на SQLshape до HTTPassertion. Root отдельный wrapper не добавил GitshPATH,10restorecases statusnull; повтор через штатное окружение **10/10PASS**. Остальные SQLobserver/fault failures не объявлены исправленными до actual rerun. [Rawbackend](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-backend-regression-root-1.log), [actual restore](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-restore-env-1.log).

Fresh different-author V3source review принят: exact3backendfiles included 2026-10-03T20:41:52.702Z,717source digestF7B1B896CDE18447FC7CE4B428F7CBBA036418D692D1CC2CF8AF6CF4A6344FC2; native acceptance ещё UNRUN onV3. Whole backendtypes после adoption actualexit0. Exactlocks/quota/receipt/finalJWT suffix preserved byfullinverse; это source evidence, не native claim. [Freshreview](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-BOUNDARY-V3-SOURCE-REVIEW.md), [actualadoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v3-adoption-root-1.json). Private6backendtest adaptations сохраняют прежние HTTP/rollback/privacy oracles и добавляют nativePID/graph proofs; независимый review выполняется, liveadoption/runtime pending.

PortableCI source review выявил минимум2 ранних admissionblockers: missingdirectory иmissingjournalNames. FrozenV1 не принят; автору переданы для NEWversion, исправления/actualported49/publicCI ещё не подтверждены. Browser14 frozenauthored; root actual PythonAST PASS после execution sandbox escalation, но native/newtarget/source-rebind/browser14/layout6 ещё pending. [CIhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-portable-ci-v1/HANDOFF.md), [browserhandoff](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-browser-v1/HANDOFF.md).

Остались actual focused/full/build, portablelocal49 иpublicCI, PWA14/6layouts, независимая финальная приёмка и отдельная поставка блока. Весь исходный WP/FR/SC/NFR/A/U сохраняется, C01–C08/futuregraph/staff/read/lease/erasure/retention не закрыт boundedcases. M01/WP11questions pending, без принятия policy по истечению времени. Я не могу это подтвердить: physicalprovider/device/human acceptance и завершение любого полногоWP.


## 2026-10-03T21:21:15.835Z · Плановый отчёт00:15МСК04октября · boundary repair · полныхWP0/17

Полностью подтверждено **0/17 WP00–WP16**;17=16−0+1. Goal active, следующий отчёт21:45UTC/00:45МСК. Actual completefrontend **2127/2127PASS**,113files, source-before/afterequal717; separatewholefronttypes/lint actualexit0. Это frontend acceptance, не полный backend/build/browser/publicCI. [Qualifiedfront](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-ui-full-2-qualified-root-1.json), [types](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/tsc-app.log); lint tool2192f9 exit0, only BABELsize note.

Root six backendfixture corrections included20:57:40 withfreshreview/fullinverses/nochangedoracles. ActualV3 nativefocus **262=261PASS+1FAIL**, one new replacementchanged_owner response404 instead oforiginal409; originalbookprivate404 passed. Whole firstbackend3247=3211PASS+36FAIL retained, restore10/10 separately passed. V4exactonecallsite removesprivate404flag ONLYreplace, preservesbookflag/fullpins/ACL/quota/receipt/JWT. Freshdifferent-author11CPU/AST/lint/source review accepted thenroot included 2026-10-03T21:12:49.631Z,717source16F2BBAA848A62674351892B08DB7BEBA784F548F4C92FD0CFC6F4ED470C98BC; V4currentnative104status **actual104/104PASS,exit0**. [Raw262](/C:/Тили-тили/.unlazy/tz-full-20261002/logs/vitest-a12-c04-c05-backend-focus-2.log), [V4review](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v4-fresh-review-v1/REVIEW.md), [V4adoption](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-boundary-v4-adoption-root-1.json).

PortableCI V1 independentreview rejected4execution/uploadblocks+G02rawproofbinding gap. NEWV2 source correction41CPU/types/lint passed onactualreadtime115inputs (82migrations+seeddata2 admitted), finalcurrentV4rebind/freshreview/adoption/local49/publicCI pending. Hidden .ci artifactfiles requireinclude-hidden-files according to [official action README](https://raw.githubusercontent.com/actions/upload-artifact/v4/README.md); no artifactuploadruntime claimed. [CIreview](/C:/Тили-тили/.unlazy/codex-planb-20261003/A12-C04-C05-PORTABLE-CI-V1-SOURCE-REVIEW.md), [authorCPU](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c04-c05-portable-ci-v2/CPU-CHECK.1.json).

BrowserV1 independent source review foundB01 exactcase/origin classifier/parent omission; NEWV2 source correction and expandedstatic-tab observation+separatelytyped genuineAPIRequestContext capture prepared, finalcurrentrebind/freshreview/rootnative stillpending. No browser14/6layouts/provider/device acceptance claimed. [FreshB01review](/C:/Тили-тили/.unlazy/codex-planb-20261003/a12-c05-browser-fresh-review-v1/REVIEW.md).

Остались currentfull/backend/build, isolatednative49, nativePWA14/6layouts, publicCI/отдельная поставка этого блока и весь исходный WP/FR/SC/NFR/A/U. C01–C08futuregraph/staff/read/lease/erasure/retention иM01/WP11/provider/device/humanrequirements сохраняются. M01/WP11questions ответа пока нет; policy не принимается по истечению времени. Я не могу это подтвердить: завершение любого полногоWP или physicalprovider/device/humanacceptance.
