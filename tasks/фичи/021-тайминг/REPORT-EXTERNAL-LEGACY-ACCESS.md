# WP03 / T007: Legacy External Cabinet And Chat Live Rights

2026-09-30. Local implementation stage; not complete T007/WP03/allWP.
No GitHub/production/provider operations, feature commit/push/main not done.

## Implementation

- All three old routes (cabinet GET, messages GET and POST) now use the same
  actual issued binding/live wedding/invite/slot/external committed deal check
  as the versioned reader, in one transaction with wedding->invite->slot->deal
  locks. They no longer follow current slot into a replacement deal or rely
  solely on link TTL/revocation. Deleted/archived/cancelled/unbooked/mismatched
  contexts410. Historical unknown binding409program_link_unbound requires a
  newly issued link for every door; no guessed binding or old unsafe fallback.
- Cabinet accepted_at, lazy chat and allowed projection one transaction. Invite
  update lock avoids parallel SHARE->UPDATE accepted_at upgrades/deadlocks.
  Chat/read/message SQL all use the same client; actual TTL checked again
  after every route's last potentially waiting query, not transaction now().
  Denial rolls changes back. accepted_at and sentAt use clock_timestamp after
  waits; accepted_at is still NOT a program acknowledgment/version change.
- Assigned-only legacy projection/who null retained; actual own slot/deal
  contract still includes own deal fields, not asserted money-free API. Program
  projection remains minimal/no contact/finance. Message senderId null/link
  possession, not human identity. GET cabinet/messages no-store.
- Realtime and recipient notifications only after actual message commit; no
  denied/rolled-back message publication. Recipient matrix still rolesSeeing
  external chat, not helpers/all wedding members; wedding timezone retained.
  This does not claim delivery to a real SMS/push provider or new offline cache.
- API0.62.0, normal generators160paths/210operations/109schemas; three legacy
  historical binding409 responses documented. No new migration/dependency/env.

## Actual Evidence

Logs .unlazy/wp03-shift-20260930:
- vendor-external-legacy-witness.log:3failed/119passed before implementation.
  Explicit local SQL cancelled actual deal without revoking link; cabinet200,
  messages200 and POST201 persisted forbidden text. No fabricated success.
- vendor-external-legacy-current.log:151pass/4fail. Three inverted fixture lock
  order deal->wedding caused actual PostgreSQL deadlocks; production cancellation
  takes wedding first. Failed fixture finally also did not restore observers
  after blocker rejected; later allowed POST500. Root-of-500 diagnosis from
  this run is not independently proven; both observer problems fixed explicitly.
- vendor-external-legacy-fixed.log158pass: wedding-first cancellation fixture,
  separate deal-lock natural TTL wait (no inverted trigger mutation), bound
  realtime observer and finally restoration even on failure. Same denial/state
  assertions retained. Fixture is not a tested alternate production lock order.
- vendor-external-legacy-final.log160pass =119prior+41new: three cancelled deal
  doors, replacement binding3, unknown historical binding3, actual waits27
  (3doors*9states), parallel cabinet1, post-wait timestamps2, committed
  publication1, real lazy-chat/accepted SQL failure rollback1.
  3+3+3+27+1+2+1+1=41. Waits include revoked/expired/archive/cancelled wedding,
  slot replacement, cancelled deal under wedding lock, natural expiry during
  wedding/deal/chat-row waits. Actual SQL and clocks, observer not fake locks.
- Backend tsc --noEmit exit0. Normal generators paths160/ops210/schemas109.
- full-external-legacy-current.log:1217frontpass/2frontfailed, stopped before
  backend. audit17 and audit49h route-loading did not settle within existing
 4000ms assertions. Cause not verified; tests/timeouts/app loading unchanged.
- legacyfront-external-legacy-timeout-isolated.log:27passed in same two files,
  unchanged assertions. Isolated pass is not a retroactive fix of failed full.
- full-external-legacy-final.log:frontend1219pass, backend153failed/305passed/
  1066skipped from failed hooks,96failed suites/15passed. Fresh final2 DB was
  created but runner invocation omitted migrate; init.sh explicitly requires
  pre-migrated DB. Actual migration preflight sees public.pgmigrations null.
  Not a passing full or application regression proof. ERR0373.
- External verify.mjs full now requires actual public.pgmigrations/users and
  all current .cjs migration names. Same unmigrated final2 full refused before
  tests; new final3 actual migrateexit0/preflight passed. Production/init.sh/
  tests/skip guards not changed.
- FINAL full-external-legacy-current-migrated.log:87frontendfiles/1219tests,
  111backendfiles/1524tests, no skipped; types/lint/build/contracts/initexit0.
  Fresh tili_codex_externallegacyfinal3_20260930_test plus real Redis13, actual
  migrateexit0 and full preflight checked. Backend1524-1483=41 new cases,
  frontend1219 unchanged. No source/test/schema edits after this full started.

Browser evidence .unlazy/wp03-external-legacy-20260930:
- externallegacy1:5checks then exact reply-text locator failed because the
  paragraph also contains author label "Пара". failure.png viewed: actual reply
  present; page_errors empty. Runner now scopes actual chat paragraph/author
  and verifies same API message ID/mine=false, not a product change. ERR0374.
- externallegacy2:11 passed entries/zero page_errors/runnerexit0. Actual bound
  cabinet/read no-store, anonymous program boundaries, real UI POST201 persisted
  message/own mine=true/no programack, actual owner chat reply on reload, RUEN,
  controlled SQL cancelled deal WITHOUT link revocation ->actual legacy POST410/
  UI whole-cabinet hide/all old GET410, historical-shaped unknown binding409/
  new-link prompt/no private content, actual public reissue/fresh review/old
  historical link remains409, controlled selected-link expiry410 on reload.
- Eight PNG viewed:legacy320/390/1440,legacy-en390,chat-denied390,unbound390,
  fresh-issued390,expired390. No horizontal overflow and send hit target checked
  at320/390/1440. Actual result provider/device flags false; no production claim.
  Cancellation/unbound/expiry controls are explicitly guarded SQL fixtures on
  127.0.0.1:55432 fresh named browser *_test, not public cancellation commands
  or natural30day wait. Actual natural expiry during row waits APItested.
  Runner disposed own API/Vite/Python and removed private auth fixture (absence
  checked). Not server/device/provider end-to-end delivery verification.

Isolated intentional preview restarted after verification:127.0.0.1:3000
timeline HTTP200,3001/health statusok. Actual listener/API5176 parent12652,
Vite19452 commands inspected. DB externallegacy2_test, RedisNULL/no provider/
envunchanged; fixture links now expired/cancelled, no live-login/SMS claim.
Scoped legacy ledger status then approve returned ALL MET4. Reports/business/
maps/tasks/delivery/JOURNAL/ERRORS/handoff current; CRLF-aware diffcheckexit0,
immutable master spec/plan/baseline diff empty. No full-feature release claim.

## Scope Still Required

Delegated company/WP06 actors, events/participation/RSVP/transfers/management,
full T009 versioned offline/access cleanup, all SC/NFR and full feature release,
all original WP00-WP16 remain mandatory. Idle-device automatic remote expiry/
revocation detection not claimed. Parallel clone snapshot is not accepted feature.
