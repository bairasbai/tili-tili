# Reminder Claim Access And Bookkeeping

2026-10-01. Continuation after PR22/main ce3bc97. Scope: current access before
POST guests/remind claim, atomic claim/recipient preparation, and resetting
only the failed job's own claim. Not acceptance of accepted-batch withdrawal
policy, durable dispatch/retry semantics, real providers, WP03 or allWP.
Production forbidden; owner survey on stopping remaining sends is unanswered.

## Actual Reproduction

External actual PostgreSQL15432 probe at38feafb:8/8 access changes committed
while claim UPDATE waited still returned200, called the controlled sender1,
and wrote the reminder mark. realProviderDelivery=false in retained JSON.
No SMS was delivered by that probe; send was replaced by an invocation counter.

Permanent test/guestReminderAccess.test.ts has15cases. Fresh reminderbefore1
reported13failed/2passed. The physical SQL-error witness was strengthened
to execute actual SELECT1/0 in both old direct-query and new transaction paths;
fresh reminderbefore2 also13failed/2passed. Both failure logs retained.

Failures:8late access refusals,2genuine JWT expiry waits,1required atomic
preparation transaction/COMMIT barrier,1recipient SQL error leaving a committed
mark, and1old failed dispatch clearing a newer successful mark. Controls:
no eligible phone releases allowance, parallel claims return200/429 and send1.
The old claim was an autocommit UPDATE: the COMMIT-barrier failure does NOT
prove an SMS was sent before that old autocommit; it proves the required
claim-and-recipient transaction was absent. Physical SELECT1/0 reproduces the
actual stale claim after recipient selection failed.

## Correction

Use existing wedding-first current-write access helper, unchanged couple-only
ACL and central consent reader. Prepare daily claim and recipients in the
same transaction, checking real JWT again after data selection. Any access/
expiry/SQL refusal rolls back the mark and never invokes the sender.
Use clock_timestamp for actual claim time after waits. Await transaction COMMIT
before external I/O; hold no database locks across provider calls.

If sent=0, reset only where the current mark equals the exact owned stamp.
PostgreSQL text retains microseconds; a JavaScript Date would truncate them.
The delayed failure test deliberately ages the existing mark25hours to model
an eligible newer claim while the older sender is pending; this is a test state
change, not evidence that a real provider call actually waited25hours.
New successful mark remains unchanged after the old failure finishes.

## Verification

Fresh migrated reminderafter1:10files/292passed/exit0, including15new reminders,
219prior read/write/seating/family/consent cases and58related existing tests.
Separate audit53guard5passed; backend types/scoped lint0. Test sender is
controlled, smsProvider=null; runner forces empty SMS_PROVIDER without editing
production config. This verifies invocation/HTTP/SQL, not external delivery.
Source565 SHA256 frozen before full (tracked/untracked source/test configuration,
text EOL normalized; no env/docs/deps/dist). Fresh reminderfull1 completed:
96frontend files/1393tests,116backend files/1733tests, no skips;
types/wholelint/build/init.sh exit0. Same565 hashes match after full/browser.
Actual production-preview Chromium reminderui3:8checks, zero page errors,
all4PNG inspected; result fits320/390/1440 above actual nav bounds without
horizontal overflow. Tests actual successful console dispatch/skips, daily429
and cleared old result, persistent daily mark, helper403/hidden action,
unauthenticated401 and preserved previously opened guest capability.
No real SMS: runner explicitly forces empty SMS_PROVIDER.

reminderui1 functional8checks passed, but its320 full-page screenshot overlapped
fixed navigation. Stricter reminderui2 failed after2checks while measuring an
unfinished smooth scroll. CSS has scroll-behavior:smooth. reminderui3 uses an
instant scroll, awaits the bottom and measures actual nav/result geometry;
viewport PNGs confirm visibility. Both earlier artifacts retained, not hidden.
No application layout change was needed; no own3000/3001 listeners or private
fixture file remain. Disposable PostgreSQL15432 is retained.

Evidence under C:/Тили-тили/.unlazy/wp03-shift-20260930:
reminderwitness-reminder-before.log, reminderwitness-reminder-before2.log,
reminders-reminder-after.log, full-reminder-full.log. External probe and565
hash inventory under C:/Тили-тили/.unlazy/wp03-publication-20261001.
GATES and browser-evidence-reminderui1/2/3 under
C:/Тили-тили/.unlazy/wp03-reminder-claim-20261001; gates created before implementation.

## Remaining

Owner decision: stop remaining sends after the initiator loses access/consent,
or complete the already accepted batch. Current batch policy is unchanged.
Do not claim full per-recipient revalidation, durable exactly-once delivery,
provider timeout/acceptance reconciliation or real SMS readiness.
At the claim checkpoint the guest UI did not display the returned failed
counter. Subsequent correction is independently witnessed in
REPORT-REMINDER-RESULT.md: full1401/1733/browser10/source566, scoped publication
pending. It does not verify real provider failure or delivery acceptance.
Then event invitations/RSVP/transfers/delegation and all FR/SC/NFR/WP remain.
New code local on feature/guest-reminder-claim-20261001 until verified publication.
