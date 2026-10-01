# Guest And Seating Read Access

2026-10-01. Continuation after verified PR21 publication/main f9ccfa1.
This report covers GET /weddings/:weddingId/guests and /tables only.
It is not acceptance of reminders, all guest routes, WP03 or WP00-WP16.
Production remains forbidden; no real provider integration is claimed.

## Reproduction

Actual migrated disposable PostgreSQL15432, guestreadbefore1:
guest-read-before.log reported39 new tests:34failed/5passed.
Ordinary SELECT ignores FOR UPDATE row locks, so the test takes an actual
ACCESS EXCLUSIVE table lock, plus an optional wedding row lock. It observes
pg_stat_activity Lock and pg_blocking_pids with pg_stat_clear_snapshot before
committing the access change and releasing the SQL read.

The34 failures comprised14 late access refusals,4 token-expiry refusals,
14 absent access pins, and2 private-field projection failures. The5 controls
were cancellation reads2, allowed helper/coordinator table reads2, and couple
private projection1. These numbers sum to39; no skips substitute for results.
The old handlers returned200 after removed membership, denied role, revoked
session, deleted account, archived wedding, withdrawn/outdated consent, or
expired JWT. Couple-to-helper/coordinator retained phone/comment/inviteUrl.

## Correction

Shared transactional current-access helper preserves the previous write path.
Read mode uses wedding FOR SHARE and permits cancelled, nonarchived weddings;
write mode retains FOR UPDATE and cancellation refusal. Both pin the actual
user/session/member/central consent rows and check the unchanged route ACL.
Guest DTO uses the locked current role, not the cached preHandler role.
Both reads recheck the actual JWT after data selection and await transaction
completion before returning. No contract shape, route, UI or role grant changes.

Access revocation committed before the access lock is refused. If read has
already pinned valid access, revocation waits for that transaction to finish;
the next read is denied. This is serialization, not retroactive cancellation
of an already returned response. Time-based token expiry is checked separately.

## Test Harness Correction

First focused guestreadafter1:11failed/208passed of219. Whole-table lock
observers also saw unrelated parallel suites; this was retained as a failed
verification, not used as acceptance. Named application_name isolates observer
PIDs, and this shared-table suite now runs in existing serial group.
audit53 recognises explicit LOCK TABLE as shared state and has a positive/
negative regression. It also detected the existing prod4 whole-table lock;
that suite was moved to serial without weakening its assertions.

Second fresh migrated guestreadafter2:219passed,5files, exit0.
219 =39 new reads +72 guest writes +60 seating +22 family +26 consent.
Separate audit53:5passed; backend types and scoped lint exit0.
Source564 SHA256 frozen (tracked/untracked source and test configuration,
text EOL normalized; no env/docs/deps/dist).

## Verified Local Checkpoint

Fresh guestreadfull1/all migrations/actual PostgreSQL15432/Redis13:
init.sh exit0,96frontend files/1393passed and115backend files/1718passed;
no skipped tests, types/whole-tree lint/production builds passed.
Actual production-preview Chromium readguest1:9checks passed/zero page errors;
readseating1:14checks passed/zero page errors. All16PNG inspected: guest5
RU320/390/1440 EN320/390 and seating11 including cold320/390/1440,
reconnect/409/draft discard/current-role/known404/session-switch/offline cases.
No UI source changes in this checkpoint. Source564 hashes still matched after
full/browser. Own browser fixtures removed and no3000/3001 listeners remained.
Retained disposable PostgreSQL15432 left running; no production access.
Evidence browser directories: wp03-guest-write-access-20261001/browser-evidence-readguest1
and wp03-offline-seating-20261001/browser-evidence-readseating1 under .unlazy.
Large frontend chunk warning remains; no new performance/reminders acceptance.

Scoped gate ledger is being recorded after verification, not represented as
created before implementation. Its manual status is not independent acceptance
of the whole feature or full WP00-WP16. Source snapshot frozen before full.
Evidence: C:/Тили-тили/.unlazy/wp03-shift-20260930/guestreadwitness-guest-read-before.log,
guestreads-guest-read-after.log, guestreads-guest-read-after2.log,
full-guest-read-full.log; hash inventory under
C:/Тили-тили/.unlazy/wp03-publication-20261001/guest-read-source-manifest.json.
At this pre-publication checkpoint, code is on feature/guest-read-access-20261001;
publication requires commit/push and fresh GitHub CI before merging main.
Reminders access/claim/reset and irreversible dispatch remain the next scope;
owner survey asks whether to stop remaining sends after access withdrawal.
