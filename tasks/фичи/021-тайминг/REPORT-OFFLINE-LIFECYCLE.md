# WP03 / T009: Read Lifetime And Scoped Worker Upgrade

Historical122-source checkpoint after subsequent seating live-access edits.
Current verification: [REPORT-SEATING-LIVE-ACCESS](REPORT-SEATING-LIVE-ACCESS.md).
The lifecycle results below remain evidence for their frozen source, not a
claim that the122 inventory still matches the current working tree.

2026-10-01. Local scoped work, not completion of T009/WP03/WP00-WP16.
No feature commit/push/main/GitHub/provider/production operations. No API,
migration, dependency or environment contract change in this scoped stage.
Prior117 seating-source manifest is historical after these source edits.

## Implementation

- readSeating accepts the caller's current-read guard and rejects before saving
  if the reader was abandoned. useSeating tracks mount/dependency lifetime and
  latest request in a ref; cleanup invalidates old requests, including StrictMode
  cleanup/restart. DayX optional preparation has its own effect cleanup guard.
  Existing session/generation/refusal/consent/minimum projection rules remain.
- Static CacheStorage names bind the registration scope pathname and actual
  build-derived version. Reads open only the current owned cache; activation
  deletes only obsolete caches with that exact scope prefix. Foreign caches
  and sibling subpaths are not read or removed. Legacy unscoped caches cannot
  be unambiguously assigned to one subpath and are not used by the new worker.
- First install may activate; replacement of an existing active worker waits.
  A same-scope client must explicitly send SKIP_WAITING. In-flow update notice
  opens the existing scoped dialog, warns about unsaved changes/open tabs,
  supports cancellation and reports failed commands/activation timeout.
  Controller replacement reloads once through reloadToRoot to restore deep
  routes; first claim does not reload. No native confirm or API/mutation replay.
- Installation consumes each validated response body before waiting for every
  response. Cache writes start only after all complete required static assets
  arrived. This prevents stalled bounded streams and detects incomplete bodies;
  partial installation still fails closed. No private API/capability responses.

## Witnesses And Failures

Logs under C:/Тили-тили/.unlazy/wp03-shift-20260930:
- seating-seating-lifetime-scope-before.log:5failed/215passed. Old wedding read
  overwrote the new copy; abandoned reader saved; forced activation; foreign
  and sibling cache deletion; same-URL foreign cache served as own static JS.
- seating-seating-lifetime-final.log:13files/222passed after fixes, including
  existing program/DayX/API/session/refusal/capacity/privacy regressions.
- upgrade-upgrade-stream-before.log:1failed/21passed. A bounded-stream VM
  installer stalled because bodies were not consumed until all headers arrived.
- upgrade-upgrade-stream-fix.log:3files/22passed. Includes explicit update UI,
  failed command, first claim/reload once, same-scope message and stream cases.
- Initial update test used a matcher not installed in this repo; changed to
  actual textContent checks. tsc caught unsupported getByRole exact option;
  actual exact-name queries retained. No production guard weakened.
- Whole lint rejected mutating a useMemo value; ref-based lifetime replaces it,
  cleanup captures the ref value, no rules disabled. Initial whole verification
  full-hardening-final.log:1384frontendpassed/1duplicate-dictionary failure.
  Added duplicate translation removed; existing translation remains.

Browser evidence under
C:/Тили-тили/.unlazy/wp03-offline-lifecycle-hardening-20261001:
- upgrade1 hung awaiting worker.ready; only its own Python/Chromium children
  terminated, runner disposed services/private fixture; no passing evidence.
- upgrade2-7 retained actual install timeouts. Diagnostics saw the actual
  worker/28critical assets, only first shell network streams arriving; correct
  Content-Length on fixture host alone did not fix it. No browser API mocks.
- After actual body-consumption fix, upgrade8 reached5checks but fixture used
  nonexistent /seating route; actual App.tsx route is /wedding/seating. Failure
  PNG inspected and fixture corrected, routing/API source not loosened.
- upgrade9:9checks/zero page_errors, actual two production outputs (normal and
  unminified) of pair2, actual fresh PostgreSQL/backend and static loopback
  subpath proxy, real Chromium service workers. Not a production/provider test.
  This pair2 result is historical; final source evidence is below.

## Final Acceptance Status

LOCAL SCOPED ACCEPTANCE, not complete T009/feature publication. Full2 on
seatinghard2 was interrupted: no result log/live runner, result not confirmed.
After resume PG55432 was stopped; initial seatinghard3 setup/migrate/full
preflight failed ECONNREFUSED. Restarted existing separate test data directory;
pg_ctl timed out while actual recovery continued. Journal then explicitly
confirmed ready to accept connections; no PID/data deletion or second instance.

FINAL full-hardening-final3.log:95frontendfiles/1385passed,
111backendfiles/1532passed, no skips; actual fresh
tili_codex_seatinghard3_20260930_test, all migrations/preflight and actual Redis13,
init.sh exit0/types/whole-tree lint/build/contracts. Frontend delta1385-1373=12:
2 late-read lifetime +5 new SW/stream/ownership/message +5 update UI/controller
cases. Backend1532 unchanged in this scoped frontend/worker stage.
Entry617.99KB/gzip192.60KB warning retained, no raised threshold/NFR claim.

FINAL production Chromium upgrade10:9checks/zero page_errors, actual pair3
normal/unminified outputs (different actual hashes/manifests), actual migrated
PG/API and loopback static /one/ and /two/ hosting, no browser API mocks.
Verified two own scopes/foreign cache preservation, exact-URL foreign JS ignored,
critical chunks before first visit, new build installed/waiting, cancellation,
old cold Seating route offline, approved actual offline replacement/reload/deep
route/new chunk, sibling cold route still usable and no owned API caches.
All8 PNG inspected: waiting/confirmation320/390/1440, old/new cold offline.
Evidence: .unlazy/wp03-offline-lifecycle-hardening-20261001/browser-evidence-upgrade10.

FINAL actual production Chromium offlineseating4:14checks/zero page_errors,
fresh actual PG/API; same final source/dist. Named individual assignments1/2
and2/2/actual third409/form409, cold route after DayX preparation, static-only
critical CacheStorage, unread programs no fake copies, reconnect/no queued draft,
English historical warning, actual session/helper removal404/no resurrection.
All11 PNG inspected: cold320/390/1440, three unread cold programs, live390,
after-draft-offline390, English390, another-session390 and known-revocation390.
Evidence: .unlazy/wp03-offline-seating-20261001/browser-evidence-offlineseating4.
Both private fixtures absent and actual ports3000/3001 no listeners; no preview.
Test PostgreSQL left available for ongoing local/parallel verification, not prod.

Current122 source/test/migration/API/build-config SHA256 entries match
.unlazy/wp03-offline-lifecycle-hardening-20261001/current-source-manifest.json.
No source changes after final full started; excludes docs/env/secrets/deps/dist.
Branch/HEAD feature/master-plan-delivery-20260930/
bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f, uncommitted/unpushed. Immutable
master spec/plan/baseline diff empty; CRLF-aware diffcheck0. Scoped manual gates
status and approve each exit0/ALL MET4 after final documentation; do not
confuse scoped approval with full T009/SC/NFR/independent feature acceptance.
Extended diff also confirms tasks.md unchanged fromc2dea5. README has the
pre-existing initial-delivery2026-09-30 header (+8lines), not byte-identical
to that source commit; current git diff for README is empty. No README edits
in this lifecycle stage; original requirements are not rewritten by that header.

## Remaining Scope

Legacy unscoped-cache cleanup/privacy migration is not proven. Actual physical
devices/PWA installation/real production host upgrades are not verified. Entry
bundle size warning remains; limit not raised. Current minimum is not encrypted
storage, current authorization or atomic server revision. No unread business
data invented. Real authorization after PG waits, delegated readers, all event
invitations/RSVP/transfers/T007-T008, all SC/NFR/T010-T011 and original WP00-WP16
remain mandatory. Partial checkpoints do not replace feature commit/push/main.
