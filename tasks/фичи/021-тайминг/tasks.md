# Задачи WP03

- [x] T001 Baseline с полной БД/Redis, исходное поведение FR-036, regression до фикса: baseline.log, negative.log и stale-save-probe.log в `.unlazy/master-plan-20260930/` внешнего workspace.
- [x] T002 Постоянные ID и tenant-scoped атомарное сохранение: локально 7/7 regression, полный gate 1089 frontend / 1293 backend. Feature-коммит ещё не опубликован; защита версии относится к T003.
- [x] T003 Версия/автор/время всех найденных путей изменения; конкурентный/устаревший PUT и повторная проверка доступа после ожидания lock. Видимые metadata RU/EN и две реальные browser-сессии проверены; доказательства — REPORT.md. Локально, ещё не feature-коммит.
- [x] T004 Миграция 1761800000000: прежние данные/ID, неизвестная история, up/down/up, повтор up, защищённый rollback и rollback транзакции — семь проверок. После расширения модели T005 миграционную проверку повторить.
- [x] T005 Длительности, зависимости, fixed, назначения, travel/buffer; циклы и чужие ID. Локально: 38 server regressions, полный gate 1110 frontend / 1324 backend без skipped, девять реальных browser-проверок, два migration drill. Доказательства и границы — REPORT-PLANNING.md; полного WP03/выпуска это не заменяет.
- [ ] T006 Scoped preview/confirm сдвига, конфликты и запрет изменения других дней/fixed/прошедших.
  Origin/calculator и event DB/API — REPORT-SHIFT-CORE.md / REPORT-EVENT-MODEL.md. Протокол — REPORT-SHIFT-HTTP.md. Captured human-readable consequences/полные интервалы/имена и digest recheck реализованы; checkpoint1146/1385 без skipped и18real browser checks — REPORT-EFFECTS.md. Event invitations/RSVP и реальные связанные transfers остаются обязательными; T006 не закрыт.
- [ ] T007 Версионное ознакомление подрядчика и отзыв доступа. Legacy revocation — REPORT-VENDOR-ACCESS.md. Registered program projection/exact-version-content-session proof/history/new pending — REPORT-PROGRAM-ACK-HTTP.md. Registered list/reader/checkbox/ack — REPORT-PROGRAM-UI.md. Pair/helper/coordinator summary exactversion/content/liveowner/current receipt separate history — REPORT-TEAM-ACK.md; full1187/1432 no skipped,18new API/19newfrontend cases. External/delegated actors и полноценный offline lifecycle остаются; T007 не закрыт.
- [ ] T008 UI, RU/EN, конфликт/сеть/повтор/пусто; черновик и принятый список. Версия, planning editor и scoped Dialog проверены. Основной /dayx — REPORT-DAYX.md. Captured effects — REPORT-EFFECTS.md. Registered acknowledgment UI — REPORT-PROGRAM-UI.md; team summary — REPORT-TEAM-ACK.md, teamack2 16real checks/screenshots reviewed. External reader/checkbox — REPORT-EXTERNAL-PROGRAM-UI.md. Event management/team external/delegated UI ещё впереди; T008 открыт.
- [ ] T009 Offline снимок и очистка при изменении доступа.

T009 DayX local checkpoint: REPORT-OFFLINE-DAY.md. schema2 namespace/version/
captured event contexts, minimal permitted contacts, read-only/no LIVE/critical
replay; final read refusals/session/membership/consent/cancel cleanup and no
late restoration. Shared banner/contact layout, precise known-refusal status.
Full run exposed actual issuer201 before COMMIT/after rollback; two PG witnesses
and postcommit response fix. Final full1269frontend/1526backend no skipped/
types/lint/build/contracts; focused160frontend/173backend; Chromium offlineday8:
13checks/eightPNG inspected320/390/1440, actual warm service-worker reload/public
member deletion/account switch/logout. No app edits since final full started.
All remaining registered/external/delegated offline readers/cold critical routes/
seating/SC/NFR remain mandatory. T009/WP03 not checked off, no partial release.

T009 registered/external reader checkpoint: REPORT-OFFLINE-PROGRAM.md.
Latest scoped seating/cold checkpoint2026-10-01: REPORT-OFFLINE-SEATING.md.
Actual minimal session/role seating copy with separate captured guest/table times,
no claimed atomic revision, read-only/no mutator/draft/replay; projected person
capacity and idempotent legacy compatibility. Build-derived static critical
chunks installed before first route visit. Fresh actual PG/Redis full1373front/
1532back no skips/types/lint/build/contracts; Chromium offlineseating3:14checks/
zeroerrors/all11PNG inspected320/390/1440.117-source/build-config hashes,
uncommitted/unpushed, no release. Later-route pending-read, SW update/subpath/
scope, delegated/events/all SC/NFR remain open; T009 checkbox stays open.

Historical contractor acceptance follows,106 manifest is not current after seating.
schema1 minimal permitted program/version/context/savedAt, registered session/
SHA256 external namespace (not authorization), no raw URL/read proof/chat/
finance. Offline read-only/no ACK; pending reconnect GET remains read-only,
known read/ACK/legacy denial cleans matching copy before old component unmount,
late responses cannot restore it. Session/consent/logout/executed cancellation
cleanup; historical observed receipt not current verification. Optional title
wrapping fixes320 ellipsis without changing other screens. Focused163pass;
FINAL full-contractor-layout-final1328frontend/1526backend no skips/types/lint/
build/contracts on fresh migrated contractorfinal3/Redis13. Chromium offlineprogram3:
15checks/zeroerrors/all12PNG inspected320/390/1440, actual warm SW reload,
other-tab session, different external URL, real cancel/ACK404 and410 cleanup,
new revision/reconnect/no POST replay, English historical receipt/static cache.
No source edits since final full;106-file source inventory replaces old101.
Delegated/cold critical routes/seating/events/all SC/NFR/all WP remain mandatory.

T007 external server checkpoint: REPORT-EXTERNAL-PROGRAM-HTTP.md, API0.60.0,
actual link/deal binding/read proof/exact-version receipt/legacy assigned filter;
full1187/1460 no skipped,28new cases,migration13,browserHTTP8.
This server checkpoint doesn't check off T007/T008/WP03.
External UI checkpoint now REPORT-EXTERNAL-PROGRAM-UI.md: full1210/1460 no skipped,
23new frontend cases, actual Chromium UI14/sevenPNG. Checkbox/reader connected;
External team checkpoint now REPORT-EXTERNAL-TEAM-ACK.md: API0.61.0,
explicit atomic issued-current-link pointer/unknown historical pointer, exact
link/deal/version/content/live rights, anonymous source and separate history.
Full1219frontend/1483backend/no skipped,23new API/9new frontend cases,
migration14 and actual Chromium externalteam2:17checks/eight regions plus
viewport320 reviewed. Scoped stage only; delegated/full legacy/offline/events
remain mandatory. T007/T008/WP03 stay open; no feature commit/push/main yet.
Legacy external server lifecycle checkpoint REPORT-EXTERNAL-LEGACY-ACCESS.md:
all old cabinet/messages routes actual issued-bound/live TX, late expiry/
atomic accepted/chat/message/no denied publication; historical unbound409.
API0.62.0, full1219/1524 no skipped,41new API cases, actual Chromium
externallegacy2:11checks/eightPNG inspected. No current-code edits since full.
Delegated company actors, full T009 offline/access cleanup and event management/
RSVP/transfers/SC/NFR/whole WP00-WP16 still mandatory. No partial feature release.
- [ ] T010 Финальная проверка всего WP03: контрактные генераторы, полный init.sh без skipped и browser desktop/mobile. Текущий этап T005 прошёл 1110 frontend / 1324 backend и девять browser-проверок; после следующих изменений повторить, все SC/NFR остаются обязательными.
- [ ] T011 Карты, JOURNAL, ERRORS, REPORT, feature-коммит/push/main на принятом SHA.
