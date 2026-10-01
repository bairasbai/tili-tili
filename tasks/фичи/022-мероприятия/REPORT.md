# 022: Event Management UI

## Boundary
Started from clean main788e801651322f31a526050aca227cbc03f94074 (PR24 merged),
local/fetched origin/main equal. Branch feature/event-management-20261001.
Existing event API/schema/migrations untouched. Only event CRUD UI, shared
DELETE option support, navigation, RU/EN and tests. Not full WP04 acceptance.
Main-date survey unanswered; existing `/us` date flow preserved. No production,
external sending, tariffs or retention assumptions.

## Final Local Verification · Before Publication
Fresh actual DB `tili_codex_eventsfull3_20260930_test`, retained disposable PG
127.0.0.1:15432/Redis13, SMS_PROVIDER empty. Entire current migration set applied
before init.sh. `C:/Тили-тили/.unlazy/wp03-shift-20260930/full-eventsfull3.log`:
98frontend files/1429passed,116backend files/1733passed, no skipped cases,
types/whole lint/build/init exit0. Front count = prior1401 +26new UI cases
+1DELETE regression +1new server-down route case =1429. Backend unchanged.
Final focused `eventsui-final4.log`:10files219passed. Full evidence checker
rejects both failed full logs and validates final footer/stages/pass-only
summaries plus recomputed569 current source hashes.

After this full build: actual production-preview `eventsfinal1` browser9passed,
zero page_errors, all11PNG inspected at
`C:/Тили-тили/.unlazy/wp04-events-ui-20261001/browser-evidence-eventsfinal1/`.
Same live CRUD/conflict/block preservation/role/RUEN/geometry checks described
below; no HTTP mocks. Source569 hashes match again after browser, own browser
services/private fixture cleaned. Prior browser logs are retained history.
Maps/todo/delivery/spec/plan/tasks/report/JOURNAL/ERRORS/handoff updated.
Scoped publication was not yet executed at this document's commit boundary.
Actual publication confirmation, once performed, is recorded separately at
`C:/Тили-тили/.unlazy/wp04-events-ui-20261001/PUBLICATION-CONFIRMED.md` and the
attached GitHub PR; never infer merge from this local test record.

## Implementation
`app/src/pages/WeddingEvents.tsx`: exact event snapshot/ETag and actual role,
read-only helper/coordinator, fail-closed unknown access/version/offline. New
`/wedding/events` route with timeline navigation. Common Radix Dialog, real
POST/PATCH/DELETE; capture version with form, PATCH changed fields only,
nullable unknowns preserved, main date omitted/main deletion unavailable.
No optimistic rows/silent rebase/automatic retry after409 or ambiguous network.
Explicit fresh opening replaces the draft, accepted write rereads actual data.
Keyed wedding component and dialog lifetime guard ignore late old acceptance.
`api.delete` now accepts existing Options, passing If-Match; old calls unchanged.
Types reference generated canonical paths/WeddingEvent, no hand-edited schema.

## Retained Witnesses And Failures
- External `C:/Тили-тили/.unlazy/wp03-shift-20260930/eventsdeletewitness-before.log`:
  one selected test failed, expected If-Match "7", actual null. Six unselected
  cases are runner-filter skips, not full verification or skipped acceptance.
- `eventsui-first.log`:2failed/81passed. Fixture401 did not supply the refresh
  refusal, and second click queried old Save label after it became Saving.
  Corrected fixture/element capture; not represented as two product defects.
- `eventsui-final.log`:1failed/84passed; malformed accepted body did not claim
  success, but generic Error hid the specific unconfirmed-save text. Use the
  existing ApiError presentation for the actual200/invalid response.
- Browser eventsui1 exact selection could not resolve implicit select label.
  Explicit aria-label added, consistent with existing shift control.
- eventsui2 screenshot captured disabled conflict fields exceeding dialog edge.
  fieldset min-width:0 fixes the intrinsic width; eventsui3/4 geometry confirms.
- English geometry in eventsui2/3 sampled the shared Dialog enter animation
  immediately after resizing. eventsui3 captured x80.16,width281.89 on320;
  screenshot later shows it moving into bounds. Harness now awaits actual
  element animation completion, not relaxed width thresholds or product edits.
  Failed logs/screenshots remain beside succeeding evidence.

## Historical Intermediate Verification
- `eventsui-final2.log`:7files85passed, including26new UI cases and permanent
  shared DELETE regression. Source types/scoped lint exit0. Full check pending.
- Actual production Vite preview/real API and fresh migrated PostgreSQL:
  `C:/Тили-тили/.unlazy/wp04-events-ui-20261001/browser-evidence-eventsui4/timeline-browser-result.json`
  has9passed check entries, zero page_errors. All11PNG inspected.
  Navigation/create/reload, other-session stale409/explicit fresh edit,
  populated delete409/block retention, independent-date timestamp retention,
  main protection/date link/Escape, null-create/delete204/reload, helper/API403/
  unauthenticated401, English save, RU/EN320/390/1440 heading/nav bounds.
  No HTTP mocks; local fixture OTP authentication, SMS_PROVIDER empty. Physical
  devices/provider delivery and personal event RSVP are not verified here.
-569 source/test/config SHA256 entries frozen in external events-ui manifest;
  text EOL normalized. Freeze excludes docs/env/dist/dependencies, includes all
  existing source/tests/workflows/migrations plus3new source/test files.
- Fresh eventsfull1 DB migrated before full init.sh. Full result pending.

Full eventsfull1 stopped at frontend:2failed/1426passed. The new submit color
pair had2.31 light-theme contrast per existing source token scanner (required
4.5); changed to the existing rose-soft/rose-ink pair valid in both themes,
without test exclusions. /wedding/events was missing from existing exhaustive
server-down route sweep; added the actual route plus false-empty/success
forbidden controls. These are feature integration failures, not ignored or
claimed as a successful full run. Backend had not run at this failed boundary.
Initial569 manifest retained separately; new full uses a fresh eventsfull2 DB.

Full eventsfull2 stopped at frontend:1failed/1428passed. audit36 conflict test
queried a unique alert, but its fixture also refuses the existing acknowledgments
route, yielding a second real alert. Target the exact conflict message and
assert its alert role (also for the same autogen pattern), preserving all draft/
ETag/retry assertions and keeping unrelated refusal visible. This is a harness
ambiguity; no product error suppression or route-response fabrication.
Final expanded focused run and fresh eventsfull3 verification pending.

## Remaining
Local full/browser/source checks passed as recorded in Final Local Verification.
Next at this commit boundary is scoped publication/CI/main. Keep T010 and WP04 not accepted:
individual invite sets/person-event RSVP/deadlines/transfers/privacy/FR-066,
SC-006/008/015 and all other WP00-WP16/SC/NFR obligations remain.
