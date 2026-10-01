# WP03 / T009: Seating Transactional Live Access

Historical124-source checkpoint after subsequent isolated CORS changes.
Current verification: [REPORT-CORS-WRITES](REPORT-CORS-WRITES.md).
The results below apply to their frozen source, not a current124 hash match.

2026-10-01. Scoped local work, not completed T009/WP03/WP00-WP16.
No GitHub, commit, push, main, production or provider operation. No API,
migration, dependency or environment change. Previous122 source inventory
is historical after this stage's source edits; current inventory has124 entries.

## Reproduction

Actual PostgreSQL, signed access tokens, actual sessions/users/consent/membership,
HTTP app.inject, no mocked database responses. A real transaction holds wedding,
table and guest rows. The test observes pg_blocking_pids before changing access
and committing/releasing the blocker. SQL snapshots check guest/table/update
state. HTTP permission codes match the existing auth and ACL matrix.

Logs under C:/Тили-тили/.unlazy/wp03-shift-20260930:
- seatingaccess-seating-access-before2.log:44 failed/48 passed. New witnesses
  all failed:5 operations x8 changes =40, plus2 phone edits and2 private response
  projections. Operations: guest PATCH/DELETE, table POST/PATCH/DELETE. Changes:
  member removal, role vendor, revoked session, deleted account, archived wedding,
  cancelled wedding, withdrawn consent, outdated consent. Writes returned
  200/201/204 after revocation; helper/coordinator received private guest fields.
- Initial fixture expected invite-link201; actual route returns200. Corrected
  only the fixture, then before2 reached both actual privacy assertions.
- seatingaccess-seating-access-fix1.log:91 passed/1 observation timeout. The
  observer reused a transaction statistics snapshot; not accepted as green.
- seatingaccess-seating-access-expiry-before.log:101 passed/3 failed, including
  actual token expiry while waiting for a guest row:200 instead of401, plus2
  observation timeouts. pg_stat_clear_snapshot now runs before every bounded
  statistics probe; no mocked wait or weakened product permission guard.
- seatingaccess-seating-access-fix2.log:104 passed. Final focused
  seatingaccess-seating-access-final.log:3 files/108 passed,60 new access tests,
  existing family02022 and audit54 consent26. Scoped lint exit0.

## Fix And Coverage

lockSeatingAccess pins wedding FOR UPDATE, then current user/session/member
FOR SHARE, then active consent rows through the sole auth/consent.ts reader.
After actual waits it checks archived/cancelled wedding, deleted account,
revocation, membership, existing allowedRoles and configured policy version.
No blanket role expansion. Phone editing and response projection use the locked
current role, not the preHandler role. Table creation is transactional; guest
and all table writes take wedding before resource locks. Existing named-person,
legacy placeholder and person-count capacity semantics remain unchanged.

Time can advance while resource locks wait. Actual JWT verification occurs
after access waits and before each transaction callback finishes, including
both single-person and remaining-family deletion branches. An expired token
throws before COMMIT, rolling back writes, unseating, timeline-version changes
and actual vendor updates. HTTP table201 is sent after the transaction returns.

60 new cases =40 access changes +4 role/phone/privacy +5 real wedding-wait
expiry +4 later-resource expiry +6 held-row ordering +1 allowed side-effect
control. Actual observed waits:44 +5 +4 +(6 x2) =65. The held-row tests first
observe HTTP waiting for a guest, then the revocation SQL waiting for that HTTP
transaction, before releasing the guest lock. The permitted write completes;
revocation then commits, and the next request is denied. No mock clock used for
expiry: backdated genuinely signed short-remaining-life tokens expire in real time.

Later-resource expiry fixtures include a real booked vendor. Guest/table/update
snapshots and wedding timeline_version remain identical after401. The positive
control commits individual assignment and actual vendor update, then table
removal/unseating and its update. This distinguishes real side effects from an
empty recipient fixture. No real external SMS/push delivery is claimed.

## Final Verification

LOCAL SCOPED ACCEPTANCE. Fresh migrated whole init.sh:
full-seating-access-full.log,95 frontend files/1385 passed,112 backend files/
1592 passed, no skips, types/whole-tree lint/build/contracts, init.sh exit0.
Actual tili_codex_seatingaccess2_20260930_test/all migrations/preflight/Redis13.
Backend delta1592-1532=60 new cases; frontend1385 unchanged. Entry617.99KB/
gzip192.60KB warning remains; not hidden or accepted as a full NFR result.

Actual production-build Chromium offlineseating5 with fresh migrated PostgreSQL
and actual API:14 checks/zero page_errors. All11 PNG inspected at320/390/1440:
cold seating3, unread program routes3, live390, after draft offline390,
English390, other-session390, known-revocation390. Individual assignments1/2→2/2,
actual third-person/backend/UI409 retained, cold Tools route after permitted
DayX preparation, static-only precache/no private API, reconnect/discarded draft/
no replay, session/helper removal404/no resurrection. No browser API mock.
Evidence: C:/Тили-тили/.unlazy/wp03-offline-seating-20261001/browser-evidence-offlineseating5.
Own browser children/private fixture disposed; actual3000/3001 no listeners.
No preview remains. Separate test PostgreSQL stays available, not production.

Current124 SHA256 inventory rechecked after full and browser; no source changes
after freeze. Source:
C:/Тили-тили/.unlazy/wp03-seating-live-access-20261001/current-source-manifest.json.
It is not a commit, publication, integration or full-feature acceptance.
Branch/HEAD feature/master-plan-delivery-20260930/
bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f. Master spec/plan/baseline/tasks unchanged
from c2dea5; README retains pre-existing initial delivery8-line header, current
README diff empty. CRLF-aware diffcheck0. Scoped final documentation/manual
gates status+approve both exit0/ALL MET4 after documentation; they do not
replace independent whole-feature review.

## Remaining Scope

Other guest operations/reads are not automatically covered by this scoped
write helper. CORS patch from the authorized parallel task is reported, not
reviewed/imported/tested here. Delegated access/events/RSVP/transfers/all original
SC/NFR and WP00-WP16 remain mandatory. Provider choices and product tariff,
refund/retention rules are still missing; production remains forbidden.
