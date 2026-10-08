# Реализация полного ТЗ

## Текущая поставка WP03/T006 · 8 октября 2026

FR015 [PR55](https://github.com/bairasbai/tili-tili/pull/55) merged в main c283b7ae1b1d1e5ee894fb9bf9c49a095a81be43, CI7/native49/all8 gates; [publication](C:/Тили-тили/.unlazy/wp12-fr015-20261008/PUBLICATION.json). В текущем checkout реализованы персональные последствия сдвига выбранного события, native279/UI126 прошли. После реального браузерного обнаружения weak ETag через nginx gzip API location сохраняет strong ETag; actual target GREEN подтверждён. Current27B локально принят: fresh full-v3/5697/all8 и compiled browser6/42/84/14rootviews/273finished/0unexpected errors/ownedcleanup; final commit/CI/merge ещё требуются; [отчёт](../фичи/021-тайминг/REPORT-SHIFT-GUESTS-20261008.md). Сценарий, T006 целиком и WP03 не объявлены закрытыми. Полных WP0/17,17=16−0+1. Следующая независимая часть T009 main guest-day offline + transactional live read. Production не разрешён. Старые текущие заголовки ниже — исторические checkpoints.

## Текущая Работа 022 · 2026-10-01

CRUD UI опубликован и влит PR25: head47f7cdb/main04a8355/all7CI SUCCESS,
local/fetched main clean/source569match. Первый022 REPORT.md и внешний
.unlazy/wp04-events-ui-20261001/PUBLICATION-CONFIRMED.md сохраняют этот этап.
Ниже старые pending-публикации исторические, включая уже merged PR24.
Продолжение: [022: персональный состав приглашённых](../фичи/022-мероприятия/REPORT-INVITATIONS.md).
Дополнительные event/person invitations, приватный family projection и реальный
выбор персон в UI; main legacy RSVP сохраняется/явно подписан. Отдельные
RSVP/deadline/late request/organizer provenance и весь WP04 ещё не приняты.
Владелец утвердил единый deadline события до конца календарного дня по его
часовому поясу; неизвестный пояс не заменять умолчанием. Опрос основной даты
не отвечен, `/us` сохраняется. Все WP00–WP16/FR/SC/NFR и provider/product
ограничения сохраняются. Новый fresh full1452frontend/1762backend/no skips/
init0; actual preview invitationsfinal3:9checks/zeroerrors/all10PNG inspected,
source574match. Источник REPORT-INVITATIONS.md. На границе этого коммита
публикация следующая, не объявлена; последующий actual push/CI/main/local sync
подтверждает отдельный .unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md
и attached PR. После публикации следующий шаг T012: отдельный event RSVP.

## Current Verified Checkpoint · 2026-10-01

PR21 published and merged after7GitHub checksSUCCESS, main f9ccfa1 at verified
local/fetched0/0 boundary. Details PUBLICATION-20261001.md; no production.
Then guest/table GET access corrected on a separate feature branch, not wholeWP:
before39:34fail/5pass; after2 focused219pass plus audit53guard5pass. Fresh full
1393frontend/1718backend/init0, actual production guest9/seating14/zeroerrors/
all16PNG inspected/source564hashmatch. REPORT-GUEST-READ-ACCESS.md.
Read code subsequently merged through PR22/green CI, main ce3bc97 at0/0 boundary.
Then reminder pre-dispatch current access/atomic claim+recipient transaction and
own-stamp reset fixed:15before13fail/2pass, focused292pass. Fresh full1393front/
1733back/no skips/types/lint/build/init0; actual production reminderui3 eight
checks/zeroerrors/all4PNG inspected, source565match. REPORT-REMINDER-CLAIM.md
retains failed smooth-scroll browser witness and real-provider limitations.
Reminder claim published through PR23/green CI, main9cf734f verified0/0/clean.
Continued failed-counter UI: corrected8before2:3fail/5pass, actual HTTP failed1
not displayed before; RU/EN Not sent and role=status after focused56pass/type/
lint0. Fresh full resultfull1:1401front/1733back/no skips/types/wholelint/build/
init0; actual production resultafter1:10checks/zeroerrors/all7PNG inspected
RUEN320/390/1440/nav geometry/source566hashmatch. Maps/report updated, scoped
result publication pending. REPORT-REMINDER-RESULT.md.
Owner withdrawal survey pending;
event/RSVP/transfers/delegation and all FR/SC/NFR/WP obligations unchanged.

## Решения владельца · 2026-09-30

- Подтверждён весь объём WP00–WP16, не только P1. Исходные FR-001–073, SC-001–018 и NFR-001–012 не сокращаются.
- Каждый пакет проходит серверные/миграционные проверки, UI, браузерные сценарии, документацию, отдельный feature-коммит, push и интеграцию в main. Незавершённый пакет не отмечается готовым.
- Провайдеры файлов, уведомлений и оплаты подписки ещё не выбраны. Адаптер и тестовый отказ не доказывают реальную доставку, хранение или оплату.
- Владелец предоставит правила тарифов и хранения данных. Цены, платные права, сроки удаления и возвраты не назначаются разработчиком.
- Production пока не трогать. Push и слияние кода не означают deployment.
- Код не может доказать отсутствие всех возможных багов и уязвимостей. Приёмка опирается на покрытие требований, отрицательные проверки, гонки и реальные сценарии.

Источник решений: ответы владельца на опрос в этой задаче 2026-09-30.

## Основание

Исходные spec.md/plan.md/baseline.md/tasks.md сохранены без изменения из Git-коммита
`c2dea5a4a4e60152c5329ad9a161fc92ef274fd7`, ветка
`docs/wedding-platform-master-plan-20260928`. README содержит ранее добавленный
8-line delivery header, не byte-identical source. Код этой ветки не переносился.
Старый baseline и незакрытые чекбоксы tasks.md являются историческим состоянием
плана, не измерением текущего main.

На старте текущая main: `ccd68fdcaa5a433c5892469ab5c4c552999901d7`.
`git fetch origin main` и `git rev-list --left-right --count HEAD...origin/main`
дали `0 0`; рабочее дерево было чистым. Guard: паузы нет.

## Пакеты и доказательства

«В работе» и «есть старый код» не равны приёмке полного FR-покрытия.

| Пакет | Состояние | Следующее доказательство |
|---|---|---|
| WP00 | Сверка интегрированного baseline | Полный gate и SC-004; аудит расширенных условий FR-018 |
| WP01 | Не принят | Файлы, каналы, restore, очистка offline, физические устройства |
| WP02 | Есть основная 020; полное покрытие не принято | FR-027–034, SC-006/007; зависимые мероприятия и фото |
| WP03 | В работе | Постоянные ID, версии, зависимости, fixed, scope сдвига, ознакомление, offline |
| WP04 | Не принят | Мероприятия и персональная видимость/RSVP |
| WP05 | Не принят | Источник календаря, ICS, пересечения ресурсов |
| WP06 | Не принят | Бриф, команда, сдача, отзыв доступа и организатор |
| WP07 | Не принят | Версии документов, изменения условий, политика данных |
| WP08 | Не принят | Preview/confirm Тиля, серверные права и версии |
| WP09 | Не принят | Применимость задач, недельные приоритеты, согласование, делегирование |
| WP10 | Не принят | Конкретный план Б, адресаты, реальные статусы каналов |
| WP11 | Не принят | Утверждённые тарифы, выбранный провайдер, проверенный webhook |
| WP12 | Не принят | Компоненты цены, сценарии, возвраты и исключение двойного учёта |
| WP13 | Не принят | Покупки, аренда, залоги и наборы вещей |
| WP14 | Не принят | Пассажиры, дедлайны, гостиницы и делегирование |
| WP15 | Не принят | Завершение, поддержка, альбом, модерация, жизненный цикл данных |
| WP16 | Не принят | Все SC/NFR, нагрузка, restore, физические устройства и пилот |

## Текущие наблюдения

- Свежий baseline на `ccd68fd`: `bash init.sh` прошёл с отдельными PostgreSQL/Redis, exit 0. Frontend 81 файл / 1089 тестов, backend 109 файлов / 1286 тестов; пропусков нет, типы/линт/сборки прошли. Источник: `C:/Тили-тили/.unlazy/master-plan-20260930/baseline.log`. Это подтверждение исходного кода, не будущих изменений.

- Исходный `backend/src/routes/day.ts` на `ccd68fd`: PUT удалял все строки и создавал новые UUID; присланный id игнорировался. Постоянные ID и защита версии впоследствии реализованы локально, не feature-коммитом; актуальные доказательства — [REPORT](../фичи/021-тайминг/REPORT.md).
- `backend/src/routes/dayx.ts` теперь регистрирует scoped HTTP routes: выбранный day/event, preview и exact-version confirm; прежняя wedding-wide команда больше не выполняется. Полная приёмка FR-038/039 ещё не объявлена: human-readable consequences и event invitees/transfers остаются; [REPORT-SHIFT-HTTP](../фичи/021-тайминг/REPORT-SHIFT-HTTP.md).
- `tasks/product-improvements-roadmap.md`: номер 021 означает тайминг; `docs/FEATURE-021-PAYMENT-PRIVACY.md` обозначает отдельную уже слитую работу с платежами. Названия и WP-ID должны различать эти работы; платежная 021 не закрывает WP03.

## Следующий шаг

T006: canonical reader/HTTP preview/confirm и captured human-readable consequences/полные интервалы подключены локально. Следующий этап T007 точное ознакомление и отзыв доступа; связи invitees/transfers, event management и T009 versioned offline остаются. Текущие доказательства и ограничения — REPORT-EFFECTS.md в папке WP03.
Продолжить остальные задачи WP03 по `../фичи/021-тайминг/`.
Остальные пакеты и внешние gates остаются частью активной программы; этот шаг
не заменяет полный объём.

## Промежуточная проверка WP03

- `negative.log`: семь новых regression-тестов упали до изменения сервера.
- `targeted.log`: те же семь проходят после локальной правки ID.
- `final.log`: весь init.sh с БД/Redis прошёл, exit 0. Frontend 81 файл / 1089 тестов, backend 110 файлов / 1293 теста; skipped нет, типы/линт/сборки прошли.
- `wp00.log`: offers019, shortlist019 и accept019 прошли, 50/50. Это не проверка всех расширенных условий нового FR-018.
- `stale-save-probe.log`: две записи из одного исходного снимка получили 200; сохранился текст второй устаревшей сессии. ID уже сохраняется, защиты версии ещё нет. Probe доказывает оставшийся дефект, а не является положительным тестом приёмки.
- Все логи: `C:/Тили-тили/.unlazy/master-plan-20260930/`.
- На этом историческом ID-only этапе browser/версии ещё не проверялись. Последующий этап версий — ниже; весь пакет WP03 не закончен.

## Локальный этап версии и доступа WP03

Версия, автор/время и защита stale PUT реализованы во всех найденных путях изменения блоков. Пять version-регрессий упали до реализации. Дополнительно воспроизведена и исправлена запись удалённым участником после ожидания замка (200 до исправления, 404 после). UI показывает metadata и сохраняет ввод/предпросмотр при отказе, не повторяет и не перебазирует запись автоматически. Контракт v0.53.0 сгенерирован штатно.

Текущие targeted: backend 50/50 и frontend 52/52; migration drill — семь проверок; browser — восемь проверок с настоящими API/UI, две сессии, метаданные и ширины 320/390/1440. Полный gate после metadata: 1100 frontend / 1308 backend, без skipped, все типы/линт/сборки прошли, exit 0 (`full-metadata-final.log`). Логи: `C:/Тили-тили/.unlazy/wp03-versions-20260930/`; подробности и оставшиеся требования — [REPORT](../фичи/021-тайминг/REPORT.md).

На конце этапа версии зависимости/fixed ещё не были реализованы. Их последующая проверка описана ниже. Полный WP03 всё ещё не принят; production не трогали.

## Локальный Этап Планирования WP03

T005 добавляет длительность, fixed, manual travel/buffer, зависимости и структурированные назначения (команда/персоны гостей/забронированные сделки). Есть DB constraints, проверка циклов/конкуренции, очистка назначений с инвалидированием версии, редактор RU/EN и сохранение planning через прежние действия/автоплан. Текущий backend subset 38/38, frontend subset до последнего regression 61/61, исторический drill шесть проверок и bad-history drill семь, browser девять с настоящими API/UI. Финальный full gate: 1110 frontend / 1324 backend без skipped, все типы/линт/сборки прошли, exit 0; [REPORT-PLANNING](../фичи/021-тайминг/REPORT-PLANNING.md).

Рабочий код незакоммичен/не опубликован. Scoped preview/confirm, конфликты затронутых блоков/участников/перемещений, ознакомление точной версии, offline, остальные WP и внешние gates не заменены этим этапом.

## T006: Промежуточный Расчёт И Первая Дата

Исправлен источник первой даты: origin хранится у постоянного ID вместо lookup текущего sort/формата. Новые regression tests подтверждают second-day offset после удаления/перестановки/переименования, отсутствие выдуманных часов historical/custom строк и сохранность fixed/manual/unknown duration. Реальный API/БД subset 41/41, migration drill шесть проверок. Pure scoped calculator прошёл 21 unit scenario: days/events, исключения, dependencies/resources/manual travel/buffer и явные конфликты неизвестного времени. Он пока не подключён к HTTP/UI; реальная модель мероприятий/изоляция и подтверждение обязательны, T006 не отмечен выполненным. Детальные evidence/границы — [REPORT-SHIFT-CORE](../фичи/021-тайминг/REPORT-SHIFT-CORE.md).

## T006: Реальная Связь Мероприятий

Миграция 1762100000000 назначает истории одно main без деления по названию, сохраняет прежние date/tz/venue/blocks/planning/origin/metadata; composite FK защищает принадлежность. Event API использует общий If-Match/версию и повторную проверку доступа после lock. Main reschedule не двигает independent blocks; eventId сохраняется сервером и клиентским full-list draft. Legacy guest day не раскрывает независимые мероприятия до индивидуальных приглашений WP04. Контракт 0.55.0 сгенерирован штатно.

Доказательства: 55 real DB server tests (включая POST race 201/409 и пять access-wait вариантов); два новых migration drill 7/8; final init.sh 1112 frontend / 1362 backend без skipped, типы/линт/сборки прошли; восемь настоящих editor/API browser checks, page_errors пуст. Источники/границы — [REPORT-EVENT-MODEL](../фичи/021-тайминг/REPORT-EVENT-MODEL.md). UI управления мероприятиями/индивидуальные приглашения, canonical reader, scoped shift preview/confirm/coordinator resolution, T007–T011 и все WP ещё обязательны. Незавершённый WP03 не опубликован, production не затронут.

## T006: Scoped HTTP / UI

Подключён выбранный day/event preview/confirm с реальным контекстом БД,
canonical same-vendor resource, actual-clock recheck, подписью user/session/
wedding/version/digest и атомарными адресными notices/ledger/idempotency receipt.
Старый endpoint не разрешает сдвиг по minutes без preview. /dayx Dialog показывает
исключения/конфликты и требует явного подтверждения; refresh не перебазирует
captured ETag, network retry сохраняет logical key. Координатор разрешает
конфликт редактором, не override. [REPORT-SHIFT-HTTP](../фичи/021-тайминг/REPORT-SHIFT-HTTP.md)
содержит логи, числа и текущие финальные повторы.

T006 не закрыт: human-readable effects/интервалы, event invitations/RSVP/transfers;
T007–T011 и все остальные пакеты/SC/NFR остаются. Публикации/production не было.

## T008: Основной DayX, Интервалы / Timezone

Исправлены найденные ended/unknown LIVE, потерянные parallel blocks, sort-based
next и browser timezone. Actual event context применяется только при равных
ETag timeline/events; mismatch требует явного refresh. Full interval dates,
unknown context ISO и старый offline без LIVE. Локальный final init.sh:
1137 frontend / 1381 backend, skipped нет, типы/линт/сборки; 15 real Chromium/API
checks, no page errors, 320/390/1440 и parallel clock boundary. Источник и границы:
[REPORT-DAYX](../фичи/021-тайминг/REPORT-DAYX.md).

Это не весь T008/WP03 и не физические устройства/полноценный offline lifecycle.
T006 последствия/preview-интервалы/event invitees/transfers, T007 ack, остальные
UI/SC/NFR/пакеты остаются. Feature delivery ещё не было; production не затронут.

## T006–T008: Captured Последствия Сдвига

API 0.57.0 получает минимальные имена/назначения/RSVP guests и реальные
контексты блоков под wedding lock. DTO входит в signed digest: изменение имени
без revision не допускает старое подтверждение. UI не подставляет новые имена
из parent refresh; показывает полные до/после интервалы, after/unchanged конфликт,
неизвестные данные и manual planning times, не реальное прибытие транспорта.
Текущий init.sh 1146/1385 без skipped, типы/линт/сборки; browser effects2
18 passed, page_errors пуст, screenshots 320/390/1440/conflict просмотрены.
Источник: [REPORT-EFFECTS](../фичи/021-тайминг/REPORT-EFFECTS.md).

Это не индивидуальные event invitations/RSVP, не связанные реальные transfers,
не доставка push/SMS и не весь WP03. T007/T009/SC/NFR и все пакеты обязательны.
Код локальный незакоммиченный, публикации/production операций не было.

## T007: Prerequisite Отзыва Доступа

GET/ack старых vendor updates теперь требуют current committed booking того же
vendor/wedding, live account/session/ownership и active wedding. Ack под wedding
lock перечитывает доступ после ожидания; отмена одной из нескольких брони не
снимает другую, повтор сохраняет ack_at. Три negative DB/API witnesses;
девять новых regressions, current init.sh1146/1394 без skipped, типы/линт/сборки;
девять real Chromium/API checks, cached card отказ/real reload removal.
Источник: [REPORT-VENDOR-ACCESS](../фичи/021-тайминг/REPORT-VENDOR-ACCESS.md).

Это не versioned program acknowledgment FR-038: reader/ack/UI/новое ожидание
при редакции и offline cleanup всё ещё нужны. T007/WP03 не закрыты, production
не затронут, прикладной код не опубликован.

## T007: Registered Program Reader И Exact-Version Ack

Сервер0.58.0: разрешённые assigned blocks, signed version/content/user/session
proof, durable actor/snapshot/history, новая pending после редакции; server
checkpoint full1146/1414,20new API cases,migration8 — REPORT-PROGRAM-ACK-HTTP.
Registered list/reader/checkbox/ack UI, captured full intervals/context, RU/EN,
stale/refusal/expiry/network retry и offline unmount реализованы. Actual browser
programui2:14checks,zero page_errors, screenshots reviewed; new UI clicks,
real version revision/cancellation и committed response loss/retry originalreceipt.
Источник: [REPORT-PROGRAM-UI](../фичи/021-тайминг/REPORT-PROGRAM-UI.md).

Final init.sh1168frontend/1414backend no skipped/types/lint/build/contracts на
fresh programuifinal*_test DB. Delta22frontend=20component+2nomocks routes.

На этом checkpoint ещё требовался pair/team state (следующий этап ниже).
Это не весь T007/WP03: external/delegated actors, T009 full
offline lifecycle и remaining event invitees/transfers/management/SC/NFR нужны.
Полный WP00–WP16 и feature commit/push/main сохраняются; stage publication нет.

## T007: Состояние Для Пары И Команды

API0.59.0 shared projection/digest, exact current version/content/liveowner и
actual actor/time; prior receipt отдельно. Team rights/liveafterlock, current
states вместо выдуманной зелёной галочки; external assigned пока not_supported,
не completion внешнего потока. UI same main timeline/summaryETag/bodyVersion,
explicitrefresh/refusal/offline/privacy и RU/EN.68API subset(18new),62UI subset,
current final init1187/1432 no skipped/types/lint/build/contracts, fresh DB.
Actual Chromium teamack2:16passed/no page_errors, six region screenshots and
viewport320 reviewed; mobile bounds above fixed navigation after scrolling and
refresh hit target verified. Scoped team ledger status/approve ALL MET5, не WP03.
Источник: [REPORT-TEAM-ACK](../фичи/021-тайминг/REPORT-TEAM-ACK.md).
External/delegated actors/T009/events/SC/NFR/whole WP00–WP16 обязательны;
неполный WP03 не принят/не опубликован, production не затронут.

## T007: External Program Server Protocol

API0.60.0 issued link/deal binding/identity, shared assigned-only reader, separate
purpose exact version/content read proof, actual server receipt/history/audit.
Old links have no guessed historical deal binding; new invite required. Legacy
full timeline/who bypass reproduced then filtered. Full1187/1460 no skipped/
types/lint/build/contracts on fresh externalverify DB+Redis13,28new cases,
migration13 and actual Chromium/HTTP8checks, two legacy UI screenshots reviewed.
Earlier Redis suite failure retained, cause not confirmed; isolated10 and new
full pass don't retroactively fix/reclassify that failure.
Источник: [REPORT-EXTERNAL-PROGRAM-HTTP](../фичи/021-тайминг/REPORT-EXTERNAL-PROGRAM-HTTP.md).
External checkbox/event-timezone reader/team receipt not connected yet. They,
delegated actors, full offline/events/SC/NFR/all WP00–WP16 remain required.
No partial feature release, no GitHub/production operations.

## T007: External Program UI

Anonymous /guest-vendor/:token shared captured program reader and checkbox now
connected: actual event-zone/full interval instead of legacy browser-local clock,
explicit exact-version acknowledgment, original-proof retry and server receipt.
Offline clears program/chat/draft/check; reconnect fresh, no queued acknowledgment.
Program/chat access refusal clears entire cabinet. auth:false isolates unrelated
account tokens/refresh/consent. Historical unbound not false pending or fallback.
Full1210frontend/1460backend no skipped/types/lint/build/contracts,23new UI cases;
actual Chromium externalui2 UI14/zero errors/seven screenshots reviewed.
Источник: [REPORT-EXTERNAL-PROGRAM-UI](../фичи/021-тайминг/REPORT-EXTERNAL-PROGRAM-UI.md).
Team external receipt/history/current-link status was next at this checkpoint, not_supported
still visible. Full legacy server lifecycle/delegated/offline/events/SC/NFR and
all WP00-WP16/feature commit/push/main remain mandatory; production untouched.

## T007: External Team Current-Link Receipt

Explicit current_program_invite_id captured atomically at actual new issuance,
not guessed from timestamps/UUIDs/history. Authorized team gets exact current
link/deal/version/content receipt or pending; expired/revoked/unknown link
unavailable, old live link never green fallback. Anonymous link source and
separate receipt history, no fabricated verified-person name. SQL retains full
timestamp precision for latest history; actual clock checked after all waits.
API0.61.0. Full1219frontend/1483backend/no skipped/types/lint/build/contracts,
23new API/9new frontend cases, migration14. Actual Chromium externalteam2:
17checks/zero errors/eight region PNG plus viewport320 reviewed; real UI receipt,
new link/edit/controlled local expiry/offline/RUEN/cancel/member removal.
Источник: [REPORT-EXTERNAL-TEAM-ACK](../фичи/021-тайминг/REPORT-EXTERNAL-TEAM-ACK.md).
This is not completed T007/T008/WP03/all WP. Full legacy rights-after-wait,
delegated company actors, events/RSVP/transfers/management/offline/SC/NFR and
feature commit/push/main still required. No GitHub/production/provider operations.
Parallel audit coordination does not waive any original requirement:
[границы](COORDINATION-20260930.md). Next legacy external cabinet/chat lifecycle.

## T007: Legacy External Cabinet And Chat Live Rights

All three old doors now same actual issued-bound/live wedding/invite/slot/
external deal inside one transaction. Late actual expiry after SQL waits,
atomic lazychat/accepted/message and postcommit realtime/notify. Historical
unbound409 requires new issue, no unsafe inferred access to replacement deal.
No-store GET; actual post-wait timestamps, accepted_at not program receipt.
Before-fix3failed/119pass proves cancelled-deal bypass; final targeted160pass,
41new API cases incl27actual waits. API0.62.0, final fresh migrated PG/Redis
full1219frontend/1524backend no skipped/types/lint/build/contracts. Chromium
externallegacy2:11checks/zeroerrors/eightPNG viewed. Controlled SQL lifecycle
fixtures explicit, no public command/natural30day/device/provider claim.
Source: [REPORT-EXTERNAL-LEGACY-ACCESS](../фичи/021-тайминг/REPORT-EXTERNAL-LEGACY-ACCESS.md).
Full T009 offline/access cleanup, company delegation/event participation
integration, remaining management/transfers/SC/NFR/all WP and feature delivery
remain open. No production/GitHub operations; app still uncommitted/unpushed.

## T009: Versioned DayX Offline Lifecycle

Session-bound schema2 minimal program snapshot, same-version event contexts,
captured zones/date/contacts/PlanB and device timestamp. Untrusted namespace is
not identity verification; role from actual members. Read-only/no LIVE/critical
commands/chat offline; final read refusals/consent/session/member role/cancel
cleanup, no late response restoration/no reconnect replay. Shared status/contact
geometry corrected; known404 not called a network failure.
Full run found actual issuer201 before COMMIT/after SQL rollback; two real PG
witnesses and after-commit response fix, API0.62.0 unchanged. Targeted160front/
173back; current fresh migrated full1269front/1526back/no skipped/types/lint/build/
contracts/initexit0. Chromium offlineday8:13checks/zeroerrors/eightPNG inspected,
actual warm service-worker hard reload and public member removal/session switch.
Source: [REPORT-OFFLINE-DAY](../фичи/021-тайминг/REPORT-OFFLINE-DAY.md).
T009 not complete: remaining registered/external/delegated offline readers,
cold critical routes/seating and all SC/NFR still mandatory. WP03/all WP00-WP16
and separate accepted feature commit/push/main remain open; no production/provider
or GitHub operations. Parallel API0.63 proposal is not integrated or accepted
here, no YAML/source overwrites. Source inventory101 hashes for agreed integration
excludes secrets/env/dependencies/build/docs, not a completed feature commit.

## T009: Registered And External Offline Programs

2026-10-01 acceptance of stage started2026-09-30. Minimal schema1 captured
program/version/context/timestamp; registered session and SHA256 external link
namespaces are not authorization. No raw proof/link/chat/finance. Read-only
offline list/reader, pending reconnect GET stays read-only, historical observed
receipt, no checkbox/chat/POST replay. Known refusal event precedes shared
cache generation cleanup, no silent re-GET or late restoration. Scope-specific
read/ACK/legacy/session/consent/cancel cleanup and320 complete wrapped title.
Focused163pass; final fresh migrated contractorfinal3/Redis13 full1328frontend/
1526backend/no skips/types/lint/build/contracts/initexit0. Real production
Chromium offlineprogram3:15checks/zeroerrors/all12PNG inspected320/390/1440,
warm SW hard reload, actual cancellation ACK404/410, different URL, another-tab
session, new version after network, observed receipt/RUEN/static-only cache.
Source: [REPORT-OFFLINE-PROGRAM](../фичи/021-тайминг/REPORT-OFFLINE-PROGRAM.md).
No source changes after final full; current source inventory106 hashes.
No GitHub/provider/production/release actions, app uncommitted/unpushed.
Cold critical routes/seating/delegated/event invitations/RSVP/transfers and
all SC/NFR/WP00-WP16 remain required. Other clone's API0.64/participation/staff
draft are reported dependencies only, not integrated or independently accepted.

## T009: Seating And Cold Critical Routes

2026-10-01 local scoped acceptance, REPORT-OFFLINE-SEATING.md. Separate person
rows count once; actual backend projected assignment/legacy placeholder capacity
and idempotent compatibility plusOne. Minimal session/wedding/observed-role
seating with independent captured guest/table read times, no sensitive guest
fields or invented atomic ETag/version/retention. Offline/pending reconnect
read-only, draft/selection discarded, no replay, matching known refusals and
session/consent/cancel/current membership cleanup. DayX prepares only through
actual successful permitted seating/member reads.409 table error stays in form.
Build-derived entry/critical-page/shared JS/CSS precache, validated full install
before activation, no API/cache capabilities. Actual Chromium offlineseating3:
14checks/zeroerrors/all11PNG inspected320/390/1440, cold first Seating/registered
reader/list/external unread URL; no unread program data invented. Full fresh
migrated seatingfinal3/Redis13:1373frontend/1532backend no skips/types/lint/build/
contracts/initexit0.117-source/build-config SHA256 inventory, old106 historical.
No source changes since this final full; no feature commit/push/main/production.
Follow-up pending-route/scope/SW upgrade/subpath/live-after-wait review, event
invitations/RSVP/transfers, delegated actors, all SC/NFR/WP00-WP16 remain required.
Cold chunk availability is not actual physical-device/PWA/provider acceptance.

## T009: Lifecycle And Scoped Upgrade (Local Checkpoint)

2026-10-01. REPORT-OFFLINE-LIFECYCLE.md records5 before-fix failures, late reader
guard/DayX cleanup, exact-scope static caches, explicit waiting-worker approval,
complete body drain before all-header wait/cache installation. Actual pair2
upgrade9:9checks/zeroerrors across two subpaths/foreigncanary/old-new offline cold
route, historical pair2. Final fresh migrated recovered test PG/Redis13 full3:
1385front/1532back/no skips/types/wholelint/build/contracts/initexit0. Final pair3
upgrade10:9checks/all8PNG inspected and seating4:14checks/all11PNG inspected,
zeroerrors; no source edits after full3 started.122 hashes match;117/106 historical.
Entry617.99KB warning/legacy caches/physical devices/principal-after-wait remain.
Scoped final documentation/gates not full T009/SC/NFR acceptance.
No source integration or publication. All original FR/SC/NFR/WP00-WP16 remain.

## T009: Seating Live Write Access (Local Scoped Work)

2026-10-01. [REPORT-SEATING-LIVE-ACCESS](../фичи/021-тайминг/REPORT-SEATING-LIVE-ACCESS.md):
before2 realPG44failed=5doors×8revocations+2phonewrite+2privateprojection.
Current wedding/user/session/member/sole consent reader held locks, unchanged
ACL/person capacity; actual JWT expiry after waits rolls back side effects.
Focused108=60new+22family+26consent,65actual waits and actual booked vendor
rollback/positive controls. Current124 source inventory, previous122 historical.
Fresh whole1385front/1592back/no skips/types/wholelint/build/contracts/init0;
actual production Chromium seating5:14checks/zeroerrors/all11PNG inspected,
124 hashes rechecked. Not completed T009/feature/main/push.
Separate CORS review, other guest doors/reads, event/delegation/SC/NFR/all WP
remain. Parallel source/test reports are not original integration acceptance.

## Isolated CORS Writes (Local Scoped Work)

2026-10-01. [REPORT-CORS-WRITES](../фичи/021-тайминг/REPORT-CORS-WRITES.md): original
actual HTTP before3fail/7pass, production Chromium before1 real3CORS failures/
no SQL changes. Isolated methods6 patch in original app.ts, origins/credentials/
exposedHeaders/auth/ACL unchanged; no cloned fullfile integration. HTTP10passed,
after1 actual9checks/zeroerrors/all3PNG inspected, writes/ETag/401403409/origin
refusals. Current125 inventory/prior124 historical. Final fresh migrated whole:
1385front/1602back/no skips/types/wholelint/build/contracts/init0; final same-source
production Chromium corsafter2:9checks/zeroerrors/all3PNG inspected,125hashmatch.
Scoped docs/manual gates not full-feature/main/push/production acceptance;
all original requirements remain, other guest doors/reads/COMMIT proof next.

## Guest POST Live Access (Local Scoped Work)

2026-10-01. [REPORT-GUEST-WRITE-ACCESS](../фичи/021-тайминг/REPORT-GUEST-WRITE-ACCESS.md):
actual before58new52fail/6pass; current transactional four guest POST/current
role phone/privacy/finalJWT and member post-COMMIT reply. Expanded180passed
=72new+108neighbor,76actualwaits including held revoke order/identity deletion.
Interrupted after2 runtime recorded; same retained PG recovered15432 without
data deletion/production env changes.126source frozen, full/browser pending;
125CORS and older checkpoints historical. GET/reminder still separate; no
new provider/pricing/retention decisions, production prohibited, all SC/NFR/
full WP00-WP16 acceptance and separate commits/remote/main still mandatory.

Final guest stage: firstfull1385/1674/prelayoutbrowser7checks exposed clipped
mobile guestheading. Actualbeforegeometryfailure and scopedcompactInvite action,
current126count but different Wedding.tsxSHA, oldmanifest retained. Final fresh
guestwrite3 PG15432/Redis13/allmigrations init0:1385front/1674back/no skips/types/
wholelint/build/contracts. Same-source production guestfinal1:9checks/zeroerrors/
all5PNG inspected RU320/390/1440 EN320/390, current126hashmatch. Scoped docs/gates
not full feature acceptance. Next GET/remind actual witnesses; no real provider/
production/GitHub/main operations. All SC/NFR/WP requirements remain mandatory.

## T012: Персональные Ответы На Мероприятия (локально) · 2026-10-02

Продолжение «Текущая Работа 022 · 2026-10-01» выше: после публикации состава
приглашённых следующим шагом был T012 — отдельный RSVP с дедлайном; эта запись
фиксирует его локальный результат. Основание — merged main после 030: PR
https://github.com/bairasbai/tili-tili/pull/27, merge2026-10-02T06:31:56Z
(aa85f88), CI7/7, включая фикс «двойное «Сохранить» первой анкеты» (LOCAL-030-31).
Контракт0.70.0/6операций(0da3e23), миграция1763700000000_event_rsvp_deadlines.cjs,
backend rsvp-events.ts, гостевой блок `/invite` (один список, решение D5) и новый
экран пары `/wedding/events/:eventId/rsvp`. Основной RSVP и его эффекты
(автобус/гостиница/стол/меню) не меняются (решение D2).

Targeted4files/68tests, весь фронт111files/2085passed, tsc/eslint чисто. Backend
на свежей полной БД (79миграций по порядку): набор T012131tests+legacy regression
RSVP/family/access266; после независимого Opus-ревью (ниже) —155tests на dev-БД,
регрессия тихих часов/notify318. Migration drill на чистой БД:22own migrations
до1763700000000/12T012SQL-отказов+1guarded CLI down refusal. Actual production
build+real API/PG browser сценарий (`.unlazy/tz-full-20261002/scripts/browser-t012.mjs`):
9/9checks/zeroerrors RU/EN320/390/1440.

Независимое ревью нашло и закрыло до публикации: P1 каскадное удаление
гостя/семьи/+1/события с живой просьбой падало500 (BEFORE DELETE стража путал
ON DELETE CASCADE с прямым удалением, которого в коде нет); P1 решение по
просьбе человека, снятого с ростера между просьбой и решением, 404-илось и
откатывалось целиком, просьба оставалась pending навсегда; P2 чужой guestId
с действующим токеном пары отдавал401 вместо404 (identity-оракул); P2 срок
≤ дата мероприятия вынесен из обработчика в CHECK базы; P3 чтение по
гостевому токену взяло for share вместо безусловного for update; P3
DST-переход ровно на местной полуночи (America/Santiago) потребовал второго
прохода коррекции смещения в `fromLocal`. Источник и числа:
[REPORT-RSVP](../фичи/022-мероприятия/REPORT-RSVP.md); правила на будущее —
`ERRORS.md` (LOCAL-030-32…35).

PENDING на этой границе: полный `bash init.sh` на финальном дереве, CI, merge
владельцем — следующий шаг, T012 не объявлен опубликованным. После публикации —
030, этапы370–374 (K-Q10: основная дата остаётся на «Мы» до этого момента);
батчи напоминаний (K-Q11) и остальной WP00–WP16/FR/SC/NFR сохраняются открытыми.
