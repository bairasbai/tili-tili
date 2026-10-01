# Guest Writes: Live Access And Committed Responses

2026-10-01. Scoped local verification, not full WP03/WP00-WP16 acceptance.
No provider, production, remote, commit, push or main operation.

## Scope And Sources

Only POST guest creation, import, family-member addition and invite-link issuance
in backend/src/routes/guests.ts. Existing wedding/access.ts route ACL and central
auth/consent.ts reader remain authoritative. No new routes/schema/migrations,
blanket roles, phone privileges or integration of parallel-clone source.
Existing API responses remain create/import/member201 and invite200.
Existing Guests toolbar additionally receives a scoped responsive invite action:
icon-only under sm, visible text at sm+, same navigation/aria-label/title. No
global TopBar changes. Actual320 screenshot showed heading squeezed to nothing,
390 truncated; browser guestlayoutbefore explicitly failed heading geometry.
GET guests/tables and POST reminders are separate remaining work, not covered
by this claim. Cancellation write404 is not applied to permitted reads.

## Before Fix

Actual freshly migrated disposable PostgreSQL, real signed JWT and Fastify:
guestwrites-guest-before.log: 58 new cases,52failed/6passed; including existing
seating/family/consent regression files:52failed/114passed,166total.
52 =32 access failures (4doors x8 changes) +12 role/phone/privacy failures
+6 real elapsed-time JWT failures +2 premature family-member response failures.
No fake DB, clock, lock notification, HTTP response or weaker authority checks.

All wait tests observe actual pg_stat_activity Lock and pg_blocking_pids before
release; pg_stat_clear_snapshot prevents stale statistics. Refusals check SQL
people/party positions/phone/comment/token hashes/invite-code hashes and expiry,
vendor_updates and timeline_version. Test capability hashes, not raw tokens,
are included in state assertions.

Family member actually returned201 while COMMIT was held; another test executes
real select1/0 after handler writes, causing rollback but old handler still201.
Other three doors' COMMIT/rollback positive controls passed before source fix.

## Fix And Focused Verification

Same transactional wedding-first access guard now covers these four doors.
Principal/session/member/current-policy consent are pinned until COMMIT; fresh
role controls phone permission and DTO projection. Guest/party identity lookup
for invite is inside the transaction under locks. Family response is sent only
after await tx; create/import DTOs are read inside tx and sent after COMMIT.
Final genuine JWT verification rolls back later wait side effects on expiry.
Family IDs/positions/max10/placeholder behavior and import duplicate/skip rules
remain unchanged; invite token rotation/old-code expiry semantics preserved.

guestwrites-guest-after1.log:166passed. Expanded after2 was interrupted by
ECONNREFUSED127.0.0.1:55432, not accepted as success. Actual pg_ctl status found
no test server; restart55432 bind Permission denied. Get-NetTCPConnection found
55432 Bound by codex.exe13532,55433 also Bound; shutdown cause unconfirmed.
Same retained pgdata recovered on checked-free loopback15432, actual log ready
10:42:49MSK. No PID/data deletion, duplicate cluster, production DB or env edit.
External runners use explicit TILI_DISPOSABLE_PG_PORT=15432 only.

guestwrites-guest-after3.log:4files180passed =72new +60seating +22family +26consent.
72 =32access +12role/phone/privacy +4wedding expiry +2later-resource expiry
+12pinned-ordering +2deleted-guest identity +8held-COMMIT/real-SQL-rollback.
76 observed PG waits =32+12+4+2+24+2; ordering cases observe both blocked writers.
Pinned ordering permits the earlier authorized operation to commit, then denies
the next request after revocation, without inventing retroactive cancellation.
Scoped ESLint and backend tsc --noEmit each exit0.

## Final Acceptance

First pre-layout full-guest-full.log:95frontend files1385passed,114backend files
1674passed, no skips/types/wholelint/build/contracts/init0, fresh migrated
guestwrite2 on actual retained PG15432/Redis13. Delta1674-1602=72newtests.
Browser guestafter1 observer incorrectly expected API3001 URL while actual UI
uses /api proxy; screenshot family creation succeeded, no page errors. Corrected
observer accepts exact actual proxy/direct same-door URL, not fabricated response.
guestafter2:7realchecks/zeroerrors, all3PNG inspected; exposed clipped mobile
heading. guestlayoutbefore:7checks then real clipped-title geometry failure.

before-layout-source-manifest.json preserves this old126-entry source. Wedding.tsx
was already in the manifest, so current count remains126 but its SHA256 changed;
current-source-manifest.json regenerated before final full-guest-layout-full.
Final full-guest-layout-full.log: fresh guestwrite3/all migrations actual PG15432/
Redis13,95frontend files1385passed/114backend files1674passed, no skips/types/
wholelint/build/contracts/init0. Production warning617.99KB/gzip192.59KB entry
over500KB remains an open performance concern, not ignored as feature acceptance.

Final same-source production Chromium guestfinal1:9checks/zero pageerrors,
all5PNG inspected: RU320/390/1440 and EN320/390. Actual UI creates named primary/
secondary with normalized phone, adds individual third, imports new person with
duplicate identity preserved. Actual cross-origin issuance rotates link and
oldcode410; helper phone create/import and capability403/no state changes;
allowed helper member201 omits private fields, unauth401/no state changes.
Title geometry fits all tested widths, compact accessible Invite navigates to
actual /wedding/invites. No routed/mocked browser responses. Actual API persists
to its fresh migrated disposable PostgreSQL, not a UI-only fake state.
126 SHA256 manifest checked after full and browser, unchanged since final freeze.
Own browser children/privatefixture disposed;3000/3001 have no listeners,
testPG retained15432 for local work, no preview/release/provider operation.
Scoped manual documentation/gates are separate from full WP acceptance.
After final documentation: manual gate status and approve each exit0/ALL MET4;
first status missing EVIDENCE fields was rejected and retained as a process
correction, not application verification. CRLF-aware git diff --check exit0.
No claim that an unchanged entry count means the same source verification.

## Evidence And Limits

External scope C:/Тили-тили/.unlazy/wp03-guest-write-access-20261001 contains
GATES.md/current-source-manifest.json/recovery logs and browser evidence.
Test/full logs in C:/Тили-тили/.unlazy/wp03-shift-20260930.
Reports and checkpoints before this126 source are historical after source edits.
All original SC/NFR, other guest reads/reminders, event/delegation contracts,
full WP acceptance, separate commits and GitHub/main integration remain open.
Provider and pricing/refund/retention decisions remain with owner; no invented
values or claim of real delivery/storage/payment. Production forbidden.
