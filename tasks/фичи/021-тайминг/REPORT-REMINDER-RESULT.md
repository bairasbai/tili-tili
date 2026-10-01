# Guest Reminder Failure Result

2026-10-01. Continuation after PR23/main9cf734f. Scope: show the existing
server failed counter in Russian/English and announce the result as status.
No backend/contract/ACL/batch-policy changes. No real SMS or production.

## Witnesses

Actual production-preview resultbefore2 uses the real backend HTTP route and
fresh migrated PostgreSQL15432, with an explicitly controlled sender adapter:
one eligible phone completes, one throws, one has no phone, one opened its link.
HTTP200 returns sent1/skippedNoPhone1/skippedLinkUsed1/failed1. Old UI fails to
show failed1, zero page errors. This is not an external provider failure test.
Initial resultbefore1 could not start: external Windows ESM imports needed
file URLs. Fixed only external harness; original log retained.

New permanent guestReminderResult.test.tsx:8cases. Initial3fail/5pass included
an incorrect EN expectation (no phone instead of existing no phone number).
First after1 focused55pass/1fail identified that expectation error. Correct
the expectation, restore only our own two UI/translation hunks to exact main
(git diff for both files empty), and run result-before2:3fail/5pass. Failures
are RU/EN mixed failure and RU complete failure. All5 controls pass before:
zero failed, skips distinct, daily refusal clears old result, pending busy,
helper action absent. Reapply correction; focused result-after2:5files56pass.
Types/scopedlint0. All logs retained, no overwritten before/after evidence.

## Correction

Append positive failed count using existing result parts and i18n dictionary:
Не отправлено:/Not sent:. Do not label every failure as a provider error:
the existing backend also counts recipients beyond the per-batch limit.
Keep zero-failure results concise, skips separate, server refusal unchanged,
and old result cleared before another attempt. Result paragraph role=status.
No new request or retry, delivery claim, permission or provider configuration.

## Verification

Source566 SHA256 frozen before fresh resultfull1 full. Actual full:
97frontendfiles/1401tests and116backendfiles/1733tests, no skips;
types/wholelint/build/init.sh exit0. Source566 hashes match after full.
Actual production-preview resultafter1:10checks/zero page errors, all7PNG
inspected. RU/EN separate test weddings have actual HTTP sent1/failed1/skips
and visible translated result; result/nav geometry and no horizontal overflow
asserted at320/390/1440. Daily429 clears the prior result, mark persists on
reload, helper action hidden/API403, unauthenticated401 and existing opened
guest capability still usable. Sender is controlled, real_provider_delivery=false.
No own3000/3001 listeners or private fixture remain; retained PostgreSQL15432.
Source566 hashes match after full/browser; product source unchanged.
Evidence: C:/Тили-тили/.unlazy/wp03-reminder-result-20261001/browser-evidence-resultbefore2/
timeline-browser-result.json; unit/full logs under .unlazy/wp03-shift-20260930.
After evidence: browser-evidence-resultafter1/timeline-browser-result.json and
7PNG in the same external folder; full-result-full.log and
reminderresult-result-after2.log under .unlazy/wp03-shift-20260930.
GATES created before implementation; screen/button maps updated.

## Remaining

Owner accepted-batch withdrawal survey unanswered; existing policy unchanged.
Real providers, irreversible acceptance/reconciliation/retries, event-specific
invitations/RSVP/transfers and all FR/SC/NFR/WP acceptance remain. Synthetic
fixtures and controlled sender do not prove real SMS delivery or allWP readiness.
Current code local on feature/guest-reminder-result-20261001 until checked publication.
