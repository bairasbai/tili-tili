# WP03 / T009: Offline Seating And Cold Critical Routes

2026-10-01. Local scoped work, not completion of T009/WP03/WP00-WP16.
Historical seating checkpoint117. New final same-source lifecycle acceptance
is REPORT-OFFLINE-LIFECYCLE.md (122 hashes/full1385front/1532back/upgrade10/
seating4); this file's earlier "current"/"final" statements refer only to117.
No feature commit/push/main/GitHub/provider/production operations. API0.62.0
unchanged; no new endpoint/schema/migration/dependency/env changes.

## Implementation

- Actual person-shaped Guest rows each count once. Compatibility plusOne on
  the primary describes an existing family, not an additional invisible seat.
- Backend PATCHguest capacity counts the projected actual assignment: named
  people move individually; only the generated legacy placeholder follows its
  primary. Repeating plusOne=true with a named second person is idempotent,
  not a second position2 insert. Removing one named person compacts positions,
  so the surviving named second person remains an existing companion.
- Seating reads guests/tables and actual current membership; unknown JWT claims
  name an untrusted cache namespace, never verify identity or authorize access.
  A matching role must be couple/helper/coordinator. Opaque old test tokens
  retain online server-read behavior but cannot create offline data.
- Schema1 tt_seating_offline contains only namespace/wedding/observed role,
  captured savedAt/guestsReadAt/tablesReadAt, person ID/name/status/table ID and
  table ID/name/capacity. Parse/project on save and recall drops phone, comment,
  medical/diet/transfer/links/raw tokens/proof/finance/drafts/unknown fields.
  Duplicate IDs, missing tables and contradictory actual table guestIds reject
  a new copy. Independent reads are NOT an atomic server snapshot or revision;
  UI explicitly says so. No invented ETag/version/TTL/retention or access lease.
- DayX may prepare the minimum seating through actual permitted reads before
  opening Seating. Failure of optional preparation does not mean data saved.
- Offline, down-server or pending fresh reconnect show only read-only permitted
  copy with independent capture times and unverified current data/access. Live
  editor unmounts, drops selection/draft and does not queue/replay mutations.
  Final guests/tables/members/wedding401/403/404/410 also purge matching copy
  with route unmounted. Known refusal is delivered before cleanup/unmount.
  Session/logout/consent/actual cancellation and current wedding-list membership
  reconciliation clear copies; same-session token refresh retains storage.
  Cache generation rejects reads started before cleanup.
- Table capacity409 remains in the open form. Previously swallowed failure
  resolved the outer write, triggered reload and destroyed the form/error.
  Names wrap instead of truncating; mobile uses one table column; familiar
  pencil/trash/refresh icons have accessible names and titles.
- Build plugin follows actual Rollup entry/Smart/Tools/VendorPrograms/GuestVendor
  chunks and their static imports, CSS/fonts; fails for missing/unsafe output.
  Built sw.js has a build-derived asset list/cache version. Installation waits
  for all successful non-redirected, non-HTML-swapped static responses before
  caching/activation; failure deletes the partial cache. Private API responses,
  capability URLs and POSTs never enter this static precache.

## Evidence And Failures

Logs: C:/Тили-тили/.unlazy/wp03-shift-20260930.
- seatingwitness-seating-before.log:4failed. Actual separate family DTO counted
  as3/2 instead of2/2; one person exhausted2/2 instead of1/2; offline kept
  mutators; no minimum copy. seating-first-fix4passed.
- seating-lifecycle.log:15pass/1fail. Mock refusal body omitted the actual
  error envelope, so client truthfully showed fallback403. Corrected fixture,
  same privacy/refusal assertions retained.
- Direct9file regression:176pass/1fail. New editor unmount exposed swallowed
  table409 losing the form/error. Error propagation corrected, no weaker test.
- seating-seating-lifecycle-static.log:13files/215passed. Includes16 lifecycle,
 23 projector/isolation/membership cases and6 actual-build/SW installer cases,
  plus old capacity/privacy/client/program/DayX regressions.
- seatingserver-seating-server-before.log:3failed/16pass. Single primary and
  secondary named person each receive incorrect409 at a one-seat table; a
  repeated compatibility flag receives actual500 with an existing named second
  person. Initial third witness expected409 rather than the correct idempotent
  200; corrected before the implementation, count2/no hidden person retained.
- seatingserver-seating-server-before-complete.log:4failed/16pass; fourth
  witness initially missed actual DELETE position compaction. It too must
  preserve the surviving named second person, not invent a new hidden person.
  Source/data checked; assertion corrected to idempotent200/count2.
- seatingserver-seating-server-fix.log:22passed on real migrated PostgreSQL.
  Six added regressions preserve individual identities/full-table409,
  idempotent compatibility, compacted family, generated placeholder behavior
  and atomic refusal of new legacy companion at a one-seat table.
- full-seating-full.log stopped at TS: it.each unpacked list entries rather
  than a list argument. Explicit fixture objects fixed, no production change.
- full-seating-full-v2.log:1372frontendpass/1dictionaryfail. New warning omitted
  the existing translated key's final period. Existing RU/EN key now reused.
- Standalone production build succeeded; Vite still reports an entry chunk
  over500KB. This is a remaining whole-feature performance concern, not hidden
  by raising the limit or declaring all NFR complete.
- Browser offlineseating1 stopped at actual422: fixture diet value was not in
  the existing enum. Corrected to source-defined other; API was not loosened.
- Browser offlineseating2:5checks/zero pageerrors then locator failed: actual
  reader combines network/no-copy text in one element. PNG showed the correct
  message. Substring match now checks that same complete message; no API mock.

## Actual Browser

FINAL offlineseating3:14checks/zero page_errors. Actual production preview,
fresh migrated disposable PostgreSQL/API, Chromium and registered SW; no
browser API mocking. Tools/VendorPrograms/GuestVendor absent from the page's
resource execution before offline; their actual built chunks already in SW.
First-ever offline Seating uses DayX-prepared permitted copy, then offline
hard reload. First-ever registered list/reader and external unread URL execute
their cold chunks but explicitly have no saved program; no invented access.
DayX remains non-LIVE. Reconnect reads fresh data/member before controls;
exactly one secondary-person PATCH changes actual PostgreSQL to2/2, third
person refused by both UI and backend. Actual409 keeps form/error. Offline
unmount discards draft, owner rename is read fresh without replay. English
historical/access warning, actual other-tab session/account purge, helper-role
copy, public member removal/fresh404 cleanup and no resurrection on hard reload.

All11 PNG inspected: seating cold320/390/1440, three cold unread program routes,
live390, after-draft-offline390, English390, changed-session390 and known
revocation390. Whole viewport, full names/table heading and no clipped text.
Evidence: C:/Тили-тили/.unlazy/wp03-offline-seating-20261001/browser-evidence-offlineseating3.
Private fixture deleted; actual ports3000/3001 no listeners. No preview.
Physical devices/PWA install/upgrade/multiple scope caches are NOT verified.

## Full Verification

FINAL full-seating-final.log:94frontendfiles/1373passed,111backendfiles/1532passed,
no skips; types, whole-tree lint, production builds and contract tests through
init.sh exit0. Fresh tili_codex_seatingfinal3_20260930_test with actual migration
preflight and real loopback Redis13. Delta from previous contractor acceptance:
1373-1328=45 frontend cases (16+23+6),1532-1526=6 backend cases. No source/test/
build-config edits after this final full started. Earlier stopped runs remain.
117 actual SHA256 entries in current-source-manifest.json include changed
source/tests/migrations/API and build configuration/public assets; generated
dist, secrets/env/dependencies/docs excluded. This supersedes the106-entry
contractor manifest as current inventory, not as a release. Branch/HEAD remain
feature/master-plan-delivery-20260930/bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f.
Immutable master spec/plan/baseline diff empty; uncommitted/unpushed, local=GitHub
not verified. Scoped manual GATES status/approve exit0/ALL MET4 after all docs;
117 source hashes matched, CRLF-aware diff check exit0. This is not full T009.

## Remaining Scope

Full T009, delegated actors, all event invitations/RSVP/transfers/T007-T008,
SC/NFR/T010/T011 and every original WP00-WP16 remain mandatory. Follow-up
review must also test route/wedding change during pending seating preparation,
SW install/update/subpath/cache scope and real mutation authorization after
waits. Cold chunk availability is not a provider/device/production acceptance
or a guarantee that an unread program has business data saved.
