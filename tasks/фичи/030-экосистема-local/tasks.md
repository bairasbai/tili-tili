# Задачи и реестр приёмки

## Продолжение 030/380 · Codex, 2026-10-03

Новое поручение владельца разрешает поэтапные commit/push/merge в main и оркестрацию агентами. Исторические запреты ниже относятся к исходной локальной поставке; production остаётся неразрешённым.

- [x] Сверен свежий remote Claude `de414fa`, сохранены исходные checkout и черновая ветка.
- [x] Независимым анализом и actual PostgreSQL воспроизведены/исправлены orphan rev0, неполные промежуточные holders, external NULL origin и raw cascade/manual deadlock; закреплены регрессиями. Текущая проверка: 65 + 6 = 71 (`vitest-codex380-reviewed-targeted.log`).
- [x] Репетиция380/drill18 прошла23 own migrations,128 SQL-отказов и18 CLI-отказов; source/manifest hashes сохранены в [отчёте](REPORT-INVENTORY-20261003.md).
- [x] После применения380 независимое ревью и actual PG воспроизвели потерю переназначенного дня. Forward381 сохранила прежние строки102 таблиц inventory/full DB и прошла68 inventory +6 audit53 =74 tests. Новые source/head имеют rev0 без снимков/согласий. Накат требует остановленных писателей.
- [x] Независимый read-only review381 и текущего preserving drill; подтверждённых дефектов новой миграции не найдено. Actual mixed manual/cascade гонки в обоих порядках затем прошли в drill20.
- [x] Финальный preserving drill20:24 миграции,128 SQL/19 CLI отказов. Полный init.sh:112/2105 front,146/3135 backend, без пропусков, типы/линт/сборки прошли;680 source hashes совпали. Источники в [отчёте](REPORT-INVENTORY-20261003.md).
- [ ] Отдельные fixture/feature commits, push, зелёный exact-head CI и merge в main. Terms68/68/order62/62 после узких fixture fixes; full codex381-ci-fixture failed order phone allocation, новый codex381-order-fixture active.7CI SUCCESS относятся к9cba47f, не следующему head.
- [ ] 371–374 и остальные WP/FR/SC/NFR/A/U: полный объём сохранён в [ведомости продолжения](../../wedding-platform-master-plan/CONTINUATION-AUDIT-20261003.md).

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
- [ ] T023 [US6] Atomic system checklist initialization unique system key without banning same user titles; real race and fail-mid-init; A13.
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
| A13 | T023 | Открыт |
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
