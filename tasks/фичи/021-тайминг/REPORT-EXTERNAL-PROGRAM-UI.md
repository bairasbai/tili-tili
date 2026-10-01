# WP03 / T007: External Program UI

2026-09-30. Local checked UI stage, not complete T007/WP03/WP00-WP16.
No GitHub/production/provider operations. Link holder is not a verified person.

## Implementation

- `/guest-vendor/:token` now reads the versioned assigned-only program and uses
  an explicit review checkbox before actual POST `/timeline/ack`. Old legacy
  browser-local start-only timeline is not also displayed or used as fallback.
- Shared `components/ProgramSnapshot.tsx` retains registered reader behavior,
  captured ETag/proof, complete intervals, actual event context, fractional
  planning, unknown values, RU/EN, expiry/refusal and original-proof retry.
  The caller supplies its actual acknowledgment route, not a fake vendor role.
- Anonymous wrappers use `auth:false`: no unrelated account bearer, refresh or
  consent-expiry side effect. Existing authenticated API calls retain default
  behavior. Legacy cabinet/chat wrappers use the same anonymous boundary.
- Only server receipt of the displayed version produces confirmed status;
  pending POST is single-flight. Network/5xx retry reuses original proof/version.
  Stale/invalid proof hides captured program; explicit reopen reads anew and
  requires a new unchecked checkbox. A new invite cannot inherit old receipt.
- Program GET/POST or chat refusal401/403/404/410 removes the entire cabinet,
  including chat composer/slot. Historical unbound409 reports the actual server
  reason, no guessed binding, false empty or legacy program fallback.
- Offline unmounts cabinet/program/chat/draft and in-memory checkbox. Reconnect
  mounts fresh readers, never queues a confirmation. Late old-route or unmounted
  requests cannot restore prior program/receipt. URL token/proof are not written
  to storage by these components. No general full offline acceptance claim.
- Header/program/chat are unframed; no new card nesting. Mobile wrapping and
  fixed confirmation dimensions checked. No API/schema/migration change.

## Evidence

`C:/Тили-тили/.unlazy/wp03-external-ui-20260930/current.log`:
4files/56tests passed: external23 + existing vendor22 + old route/chat5 + client6.
New cases cover captured proof/ETag, actual link route/no bearer, network/503
retry, stale reset, four access refusals, unrelated account refresh/consent
isolation, historical unbound, incomplete ETag, proof expiry, offline/draft/
late receipt, single-flight, empty, wrong reply version, chat cancellation,
English and route-late response. Fetch replies are controlled UI fixtures,
not actual database or provider evidence. Existing full-App audit49b fixtures
now explicitly answer the new program endpoint; route/chat assertions retained.

`C:/Тили-тили/.unlazy/wp03-shift-20260930/full-external-ui.log` failed before
tests on two unused imports left by extraction. Removed those imports only.
FINAL `full-external-ui-fixed.log`:87frontendfiles/1210tests,
111backendfiles/1460tests, no skipped, types/lint/build/contracts and init exit0.
Fresh `tili_codex_externalui_20260930_test` plus real local Redis13. First failed
run stopped before tests/database use; corrected run used that fresh migrated DB.
Frontend delta1210-1187=23, matching new external UI cases; backend unchanged.
No app/backend/tests changes after this full run started, docs/external runner only.

Browser `browser-evidence-externalui1/timeline-browser-result.json` failed on
test expectation Europe/Moscow: actual fixture wedding Ufa has
Asia/Yekaterinburg; reader correctly rendered16:00-16:30 from11:00-11:30UTC.
Failure.png inspected, product time logic not changed. No failed run reclassified.

FINAL `browser-evidence-externalui2/timeline-browser-result.json`:
14actual Chromium/API checks, page_errors[], runner exit0. Real PostgreSQL-backed
public booking/issued bound link/owner assignment -> anonymous UI -> checkbox ->
actual receipt/reload. New link pending, owner edit pending, stale409/reset,
real SQL commit followed by transport response abort and retry same original
receipt, offline removes draft/program/chat with reconnect fresh unchecked,
public cancellation and actual POST410 clears entire cabinet, revoked reload.
Timezone actualAsia/Yekaterinburg versus UTC browser; known exact interval;
width320/390/1440 no horizontal overflow and confirmation elementFromPoint
hit target. RU/EN seven PNG inspected:external320/390/1440,external-en390,
offline390,stale390,revoked390. No overlapping content seen in these states.
Lost response uses route.fetch against actual API then route.abort, not a
synthetic success. No production/SMS/physical-device/provider verification.
Runner stopped only owned services and removed private auth fixture.

Scoped `.unlazy/wp03-external-ui-20260930/GATES.md`: status then approve ALL MET4,
only UI stage. Initial EXPECT used literal text resembling regex, so56passing
tests did not match. External wrapper now emits success marker only on exit0;
reapproved/reran, gated.log56passed, product assertions unchanged. CRLF-aware
diff --check exit0. Intentional isolated preview externalui2 DB healthok/UI200,
actual API9008/parent18384/Vite4404 commands inspected; no real login/provider claim.

## Remaining Full Scope

Team summary still reports external assigned `not_supported`: actual external
receipt/history/current latest link visibility must be connected and verified,
without calling anonymous holder a named verified actor. Full legacy read/chat
server revocation-after-wait lifecycle, delegated employees/WP09, T006 event
invitees/RSVP/transfers, T008 event management, T009 full versioned offline/access
cleanup, T010 all SC/NFR and T011 feature commit/push/main remain mandatory.
This UI stage does not complete T007/WP03 or the WP00-WP16 goal.
