# WP03 / T009: Versioned DayX Offline Lifecycle

2026-09-30. Local implementation stage, not completed T009/WP03/all WP.
No feature commit/push/main, GitHub/provider/production operations.
API remains0.62.0; backend invitation response timing corrected after a full-run
failure and real PostgreSQL witnesses. No migration/dependency/secret/env changes
in this offline lifecycle stage.

## Implementation

- One explicit schema2 DayX copy: actual timeline ETag and same-version event
  context, captured event names/zones/date, savedAt from this device, observed
  PlanB and separately freshly read permitted crew/contact state. No claim of
  an atomic multi-endpoint server snapshot for PlanB/crew/wedding metadata.
- Cache namespace user/session from sub/sid is untrusted isolation metadata,
  NOT JWT profile/identity verification or a new authorization mechanism.
  Role comes from actual wedding members response. Same-session refresh keeps
  the copy; new account/session/logout clears it. DayX remounts at session or
  wedding change and cannot use the previous store's crew. Snapshot does not
  persist raw token/read proof, money, internal who/notes or unknown fields.
- Validated minimum structure/ISO instants/ETag/role/unique block/event IDs.
  Unknown legacy copies discarded, not assigned a fabricated session/version
  or today's event zone. Disabled storage does not crash or fake a saved copy.
- Offline event immediately removes LIVE/current/next and disables shift,
  PlanB and chat. Cache is read-only; permitted telephone remains callable.
  Network/timeout/5xx except501 can show the copy, with revision/full savedAt
  and explicit unverified current version/access. HTTP4xx/501 are not offline
  success. Known read401/403/404/410 clears the matching wedding even if DayX
  is unmounted. Consent-outdated clears independently of current route.
- Actual membership list reconciles disappearance or changed role without
  turning network failure into an empty list. Actual executed cancellation
  clears the copy; confirmation_required does not pretend cancellation.
  Known role/missing session user hides former copy immediately. Cleanup
  generation prevents requests started before cleanup from restoring it.
- Reconnect freshly reads timeline/context/wedding/PlanB/crew before leaving
  read-only mode; no queued critical commands or old confirmation checkbox.
  Offline minute timer does not poll backend. Online minute read remains.
- Actual screenshot revealed fixed shared connection banner covering heading
  and clipped horizontal offline telephone. Status now occupies layout space;
  offline crew gets wrapped rows/separate phone line, PlanB content wraps.
  Shared banner does not promise an offline write queue or unverified repairs.

## Tests And Failure History

Logs C:/Тили-тили/.unlazy/wp03-shift-20260930:
- offlinewitness-offline-before.log:4failed/0passed BEFORE implementation;
  actual component restores copy after404 and another session, retains LIVE
  after offline event, loses captured event zone/revision.
- offline-offline-first.log96pass/1failed: duplicate rendered error locator.
- offline-offline-regressions.log132pass/1failed: context error UI only renders
  after a timeline block exists; waiting for it while deliberately blocking
  timeline was incorrect. New assertion observes actual cache cleanup first,
  releases timeline, then verifies context refusal and no restored copy.
- offline-offline-expanded.log151pass/3failed: audit29/audit30 five-second test
  timeouts and early no-member cache assertion. Cause of those timeouts is NOT
  verified. Added settled-state requirement to refresh after cleanup; separate
  diagnostic offlineloop-offline-race-witness.log passed even with that guard
  temporarily removed (1pass/19 filtered skips), so it does NOT prove the
  timeouts were caused by a retry loop. Guard restored, no timeouts increased.
- Type check found it.each array rows were spread as arguments in membership
  cases; object cases now actually pass []/changed-role arrays, not a catch
  caused by invalid test input. Other generated optional fields narrowed.
- offline-offline-racefix.log153pass/1failed retained: asynchronous no-member
  deletion assertion still early. Actual no-private-render assertion kept;
  waitFor verifies the effect's real storage cleanup, not timeout widening.
- full-offline-current.log1259frontendpass/8failed, backend not run. Two full
  client mocks lacked new accessor, and PlanB fixture omitted events causing
  actual fixture404. Mocks explicitly have no offline token namespace; PlanB
  now supplies actual same-version context. Original domain assertions kept.
- offlineregression-offline-compatibility.log:5files/63pass after fixture fixes.
- full-offline-final.log:89frontendfiles/1267tests and111backendfiles/1524tests,
  no skipped/types/lint/build/contracts/initexit0; migrated fresh offlinefinal2
  plus real Redis13. This is BEFORE the layout correction, not current-source
  full acceptance after that edit.
- offline-offline-layout-current.log:9files/156pass, before the later status
  correction. At that checkpoint21 lifecycle+28 storage/API=49 new cases.
- full-offline-committed-final.log:89frontendfiles/1268passed and111backendfiles/
  1526passed/no skipped/types/lint/build/contracts/initexit0. Fresh migrated
  offlinefinal4 plus Redis13. This proves the commit timing/layout source, but
  predates the later known-refusal status text correction below.
- Final screenshot inspection revealed no-copy state after reconnect404 still
  labelled "Нет связи с сервером". Actual connectionLost means not revalidated,
  not necessarily unreachable server. New online->offline->online404 regression:
  offlinewitness-offline-refusal-label-before.log1failed/21passed.
  No-copy status now suppresses the connection claim upon a known non-down
  refusal, preserving concrete API errors and cache/content cleanup.
- offline-offline-refusal-label-fixed.log:9files/157passed. New files now22
  lifecycle+28 storage/API=50 cases.
- full-offline-refusal-final.log:1268frontendpassed/1failed typography source
  guard on adjacent JSX expressions; backend not run. Separator was inside
  conditional fragment, not evidence of actual runtime glued text. Status now
  one translated string expression; shared guard/assertions unchanged.
- offline-offline-refusal-typography-fixed.log:10files/160passed, including the
  three existing typography cases.
- FINAL full-offline-verified-final.log:89frontendfiles/1269passed and111backend
  files/1526passed, no skipped/types/lint/build/contracts/initexit0. Fresh
  tili_codex_offlinefinal6_20260930_test, migrateexit0 and actual preflight for
  all current migration names/users; real loopback Redis13. Frontend total:
  previous1219 +22 lifecycle +28 storage/API =1269. Backend1524 +2 real commit
  witnesses =1526. No app/backend/test/schema edits since this full started.

## Verified Invitation Commit Defect

- full-offline-layout-final.log:1268 frontend passed; backend1522passed/2failed.
  audit32 immediately read a new invitation and got410; prod4 could not read
  the row after HTTP201. This failed full run is retained, not labelled flaky.
- slots.ts external/invite sent reply.code(201).send inside db().tx callback.
  Two witnesses in prod4.test.ts hold the actual transaction before COMMIT
  and force actual SQL select1/0 rollback. Separate PostgreSQL pool cannot
  see the newly inserted row before commit, while the old route already
  completed HTTP201. Rollback also previously returned201, with no stored row.
- issuancecommit-offline-commit-before.log:1failed/144 filtered skips;
  issuancecommit-offline-commit-two-before.log:2failed/144 filtered skips.
  Filtered diagnostic runs are not whole-suite acceptance evidence.
- Route now returns the invitation from the callback and sends201 only after
  awaited db().tx has committed. Existing body/status/contract unchanged.
- issuancecommit-offline-commit-fixed.log:2passed/144 filtered skips.
  vendorcommit-offline-commit-current.log:5files/173passed/no skipped, including
  both witnesses, audit32 and external access/protocol regressions. Current
  fresh migrated full-offline-committed-final passed1268frontend/1526backend,
  as recorded above. The later refusal-label edit requires another full run.

## Actual Browser Evidence

C:/Тили-тили/.unlazy/wp03-offline-day-20260930:
- offlineday1/2 failed before first scenario: runner incorrectly searched
  kind=main, then a nonexistent fixture name. Main identity is isMain,
  independent of kind. Runner now explicitly creates its actual ceremony
  through public versioned POST and uses returned ID/context.
- offlineday3 passed7 entries, then exact fresh-name locator matched current
  card and timeline row. failure.png inspected: both show the fresh actual
  program. Scoped timeline-row assertion plus separate LIVE/version checks.
- offlineday4 passed11 entries, then removal expectation wrongly required403.
  Actual access.ts intentionally returns404 for absent membership to avoid
  enumeration. Next run checks real404/not_found, not generic any error.
- offlineday5 passed13 entries/zero page_errors/runnerexit0 BEFORE layout edit:
  actual production Vite build/registered service worker, real migrated PG/API,
  warm-route offline hard reload, captured zone/version/contact, actual online
  revision/reconnect, no critical POST, RUEN/320/390/1440, static CacheStorage
  without private API, actual other-tab session/account change, helper's own
  permitted copy, public member deletion, fresh404/membership cleanup, logout.
  Screenshot review found banner/contact layout issue despite no page overflow.
  New runner asserts banner/back-control geometry and full telephone bounds.
- offlineday6 passed8 entries then capture offline-en390 wrongly searched RU
  button label "Назад" instead of translated Back. failure.png inspected,
  control exists. Exact bilingual regex fixes runner only; geometry preserved.
- offlineday7 passed13/zero page_errors/runnerexit0. All eight final PNG viewed:
  offline320/390/1440, offline-reloaded390, reconnected390, offline-en390,
  changed-account-offline390, known-revocation390. Banner/back and phone bounds
  passed, old program/contact absent after member removal. Screenshot inspection
  found the status-label defect described above, so this run is not acceptance
  of the later status edit. Runner now requires actual "Свадьба не найдена" and
  no "Нет связи с сервером" after real public member removal/reconnect.
- FINAL offlineday8:13passed/zero page_errors/runnerexit0 on current production
  build. All eight PNG above inspected again in browser-evidence-offlineday8;
  known-revocation390 now shows actual refusal/no copy, no false connection
  claim. Banner/back/phone geometry and no overflow passed on320/390/1440.
  Actual warm-route service-worker hard reload, namespace/account storage event,
  own helper snapshot, public memberDELETE204/actual helperGET404/not_found,
  fresh reconciliation, no retained contact and actual other-tab logout checked.
  critical_commands empty; no offline confirm/action replay. Before-fix and
  runner errors remain separate evidence, not reclassified as passed.
- Runner disposes owned API/Vite/Python children and deletes private auth
  fixture; no actual provider delivery/physical-device claims.
- After offlineday8 terminal: actual ports3000/3001 have no listeners; private
  fixture Test-Path false. No preview left running. Current-source-manifest.json
  generated via manifest.mjs has101 source/test/migration/API SHA256 entries,
  excludes secrets/env/dependencies/build/docs. HEAD remains
  bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f, branch feature/master-plan-delivery-
  20260930; application changes uncommitted. Inventory is not a release proof.
- Scoped manual GATES.md status/approve each ALL MET4; implementation/evidence,
  fresh full, documents and current warm browser checked separately. Initial
  --status with --cwd rejected as execution-only; corrected status passed.
  Source manifest and exact cleanup/proof boundaries sent to user-authorized
  task "Проверь статус параллельной сессии"; no code copied or integrated.

## Remaining Mandatory Scope

T009 stays open: registered/external/delegated program readers still need
complete permitted offline lifecycle, cold unvisited lazy-route availability,
remaining acceptance/scenarios and access cleanup. Warm DayX reopening is not
a proof for all routes/PWA installation or physical devices. Seating/resource
offline requirements and other WP integrations are not erased by this stage.
No approved new offline TTL/lease/retention rule invented or copied from the
600-second acknowledgment proof. Device cannot learn a remote revocation
while disconnected; warning is explicit, cleanup occurs on known server state.
LocalStorage is not claimed encrypted or tamper-proof against origin/device
access. All WP00-WP16, providers/product rules and final per-feature release
remain required; production stays forbidden.
