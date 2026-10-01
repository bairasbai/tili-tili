# WP03 / T009: Contractor Offline Program Lifecycle

Started2026-09-30, local scoped acceptance2026-10-01; not completed T009/WP03/WP00-WP16.
No feature commit/push/main, GitHub/provider/production operations. API0.62.0
unchanged; no new backend/migration/dependency/env changes in this stage.

## Implementation

- Schema1 minimum permitted projection in tt_program_offline, separate entries
  for actual registered user/session and SHA256 external URL capability.
  Parsed JWT claims/hash are untrusted cache isolation, NOT authentication,
  token validation, an account profile or server authorization.
- Only actual server-read wedding/version/ETag/updatedAt/observed receipt and
  permitted block/event context saved. Raw link/readToken/expiresAt, internal
  notes, finance, chat, draft and other contractor blocks are not persisted.
  Unknown legacy context is not inferred. Structure/ISO instants/roles/minutes/
  unique block IDs/dependencies/namespace/version consistency validated.
- Known storage failure has no fake saved success; missing crypto capability
  disables external offline saving rather than using a weak/raw namespace.
  Saved browser storage is NOT encrypted or tamper-proof. It is not a device
  protection mechanism; a server revocation cannot be discovered while offline.
- Registered reader/list and external cabinet show the captured version/time
  and explicit unverified current version/access. Offline copy is read-only:
  no checkbox/acknowledgment/chat or critical replay. Observed acknowledgment
  is explicitly historical. The 600-second read proof is NOT an invented
  offline access lease; no retention/TTL product rule is introduced.
- Warm reconnect reads a fresh permitted program/proof before enabling review;
  a pending GET keeps the old copy read-only. Old checkbox/draft are discarded,
  no automatic POST. Only a later actual GET observation persists a receipt.
- Final read/ACK401/403/404/410 cleanup lives in the common client, including
  unmounted routes and legacy external cabinet/messages. Cleanup is scoped to
  actual wedding/session/link, no fallback that silently reopens denied data.
  Same-session refresh retains registered copies; changed account/session/
  logout/consent/executed wedding cancellation clean the relevant entries.
  Confirmation-required is not represented as an executed cancellation.
- Refusal notification precedes cache-generation cleanup, so an unmounted ACK
  component cannot drop the known denial and silently trigger a fresh GET.
  Generation rejects late reads started before cleanup. Another-tab auth
  change removes registered copies, not independent auth:false external data.
- Network/timeout/5xx except501 permit read-only fallback; HTTP409/422/429/501
  neither prove revocation nor constitute offline success. Actual known refusal
  has its concrete error, not a false claim that the server is unreachable.

## Tests And Failure History

Logs: C:/Тили-тили/.unlazy/wp03-shift-20260930.
- offlineprogramwitness-contractor-before.log:2failed, actual mounted registered
  valid session and external link lose their permitted copy after offline.
- offlineprogramwitness-contractor-first.log:2passed after initial implementation.
- offlineprogram-contractor-core.log:128passed/8failed. Six denial regressions
  exposed this stage's ACK race: shared cleanup unmounted the old component
  before its catch reported refusal. Other failures: old external offline
  expectation conflicted with the new saved-copy requirement; prototype spy
  did not intercept actual global localStorage in this test environment.
  Denial/history/proof assertions retained; storage fixture now actually throws.
- offlineprogram-contractor-refusal-order.log:136passed/8files after explicit
  refusal-before-cleanup event and no silent generation-triggered GET.
- offlineprogram-contractor-resume.log:160passed/8files after expanded lifecycle
  cases. App tsc -b exit0 verified again; interrupted older handle is not proof.
- full-contractor-fresh.log:91frontendfiles/1325passed, then lint rejected two
  synchronous state setters in ProgramReader effects; backend/build not run.
  Refusal now derives from known failure; read-only state derives from network,
  settled generation and saved copy. No lint rule disabled.
- offlineprogram-contractor-derived-state.log:161passed/1failed, reconnect test
  used an unchanged saved block name as proof that a fresh GET had finished.
- offlineprogram-contractor-revalidation-settled.log:161passed/1failed, the
  chat parent updates one render after the actual reader. Assertions now await
  actual fresh checkbox and chat input, still require unchecked/empty/no POST.
- offlineprogram-contractor-revalidation-current.log:8files/162passed/no skips.
  Two additional pending-GET cases explicitly require read-only captured copy
  until resolution, then the actual new version and unchecked fresh review.
- full-contractor-final.log:91frontendfiles/1327passed and111backendfiles/1526
  passed/no skips/types/lint/build/contracts/initexit0 on fresh migrated
  contractorfinal2 with actual migration preflight and real Redis13. This is
  BEFORE the later optional wrapped title, not current final-source acceptance.
- Browser offlineprogram1:11passed/zero page_errors, then owner revision tried
  to reassign an already actually cancelled registered deal; API rejected its
  participants as unavailable. Runner now removes that assignment only after
  actual cancel200 and actual ACK404, preserving both refusal assertions.
- Browser offlineprogram2:15passed/zero page_errors; production build/API/PG,
  registered/external actual warm SW reload/reconnect/session/link isolation,
  actual SQL cancellations/ACK404 and410, historical receipt/RUEN/static cache.
  Screenshot inspection of registered320 found heading ellipsis, not an
  overflow failure. Opt-in wrapped TopBar title leaves old screen defaults
  unchanged; browser capture now tests the whole heading, not just scrollWidth.
- offlineprogram-contractor-layout.log:8files/163passed/no skips, including new
  wrapped title regression. Final full/browser on the changed source pending.

## Final Verification

FINAL full-contractor-layout-final.log:91frontendfiles/1328passed and111backend
files/1526passed, no skips/types/lint/build/contracts/initexit0. Fresh
tili_codex_contractorfinal3_20260930_test, migrateexit0 and actual migration
preflight; real loopback Redis13. Frontend delta from accepted DayX1269 is
1328-1269=59 tests; focused offlineprogram-contractor-layout.log8files/163pass.
No app/backend/test/schema edits after this full started.

FINAL browser offlineprogram3:15checks/zero page_errors, real production build/
actual API/PG, warm registered/external SW hard reload, offline own-copy list,
new owner revision/reconnect, no old checkbox/draft/POST replay, actual other-tab
auth change, unrelated new URL isolation, real cancel200/ACK404 and410 cleanup,
observed receipt after fresh GET, RU/EN and static-only CacheStorage. Captured
event clocks use Asia/Yekaterinburg despite UTC browser. Retained first failed
run and earlier green run, not overwritten or claimed as final changed source.
All12 PNG in .unlazy/wp03-offline-program-20260930/browser-evidence-offlineprogram3
were inspected: registered320/390/1440/warm390/after-known-refusal390 and external
320/390/1440/warm390/otherlink390/English390/known410390. Geometry checks cover
overflow, visible buttons, banner/back and complete wrapped registered heading.
Registered after-refusal PNG is offline after real ACK404 and hard reload, not
a screenshot of the earlier live HTTP404 message. No physical device, cold
route/PWA installation, provider or production deployment verified.

Runner disposed only its children; actual Get-NetTCPConnection found no
listeners3000/3001 and private fixture Test-Path returnedFalse. No preview.
Source inventory current-source-manifest.json106 SHA256 entries, excluding
env/secrets/dependencies/build/docs; branch feature/master-plan-delivery-20260930,
HEAD bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f. App code uncommitted/unpushed,
not a release or synchronization proof. Immutable master diff empty.
Scoped manual GATES status/approve exit0/ALL MET4 after documentation;
this does not check off T009/WP03/whole original objective.

## Remaining Scope

Delegated contractor/company actors, cold critical routes/seating, all offline
scenarios and final SC/NFR remain required. T006 event invitations/RSVP/real
transfers, T007-T008 delegated/event/team workflows, T010 whole-feature testing
and T011 accepted feature publication remain open. Every original WP00-WP16
is retained; this report cannot replace a complete feature release.
