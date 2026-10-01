# WP03 / T007: External Link Program Protocol

2026-09-30. Local server stage, not entire external UI/T007/WP03/WP00-WP16.
No production or GitHub operations. No external provider/human identity claims.

## Implementation

- New GET /guest-vendor/:token/timeline and POST /timeline/ack, no invented
  account/session. Each new invite has random program_identity and an explicitly
  captured program_deal_id under wedding lock/live issuing member/session checks.
  Link identity describes actual issued link, not a verified individual person.
  New created_at/expiry use clock_timestamp after waits, not transaction start.
- Migration176230 assigns identities to existing rows but leaves historical
  program_deal_id null. No inferred issuance-time deal and no historical ack.
  Old links get409 program_link_unbound for the new protocol, requiring a newly
  issued link. Existing old cabinet/chat still available according to their guards.
- Common readProgram now requires only actual snapshot/wedding/deal IDs, no fake
  vendor/user ID for external actors. Only own assigned blocks and own dependencies;
  actual event date/timezone/location, known complete intervals, unknown null.
  No who/private participants/hidden IDs/phones/money.
- Legacy cabinet previously returned entire timeline and who. Regression proved
  hidden block bypass. Legacy timeline now filters actual assignments to current
  deal and emits null who; this is not a complete rewrite of legacy chat/access.
- New protocol transaction locks wedding then invite/slot/deal; after all waits
  actual clock_timestamp validates TTL and live link/wedding/current committed
  external deal. Cancelled/archived/gone410. Captured bound deal must remain current.
- Separate external-purpose signing key/header/audience, wedding/invite/deal/
  version/digest600s. GET readonly/no-store; coherent ETag/sourceVersion.
  POST requires original If-Match, live access, exact version and content.
  New version/link doesn't inherit receipt; no assignments -> no proof or waiting.
- Durable minimal permitted snapshot and actual server time, actorKind external_link
  and real invite/deal identity in audit, actor_id null. No fake user/name, no raw
  URL token or read proof persisted. Receipt/audit one transaction, concurrency
  and retry preserve original timestamp; error rolls both back.
- Tenant composite FKs and uniqueness/checks; receipt also requires the exact
  issued invite/deal composite binding, not merely two IDs of the same wedding.
  Historical unbound invites cannot get fabricated receipts by direct SQL;
  recorded binding cannot be mutated. Protected rollback for receipt or
  issued bound link. No new dependency/.env/lockfile/provider change.
- API0.60.0,160paths/210operations/109schemas; normal generators executed.

## Evidence

External C:/Тили-тили/.unlazy/wp03-shift-20260930/:

- vendor-vendor-before-external-program.log:2newfailed/68oldpassed, missing GET404.
- vendor-vendor-external-program-first.log:70passed after first implementation.
- vendor-vendor-external-legacy-witness.log:1failed/89passed, legacy cabinet returned
  two timeline rows instead of assigned one. This temporarily restored only our
  legacy-filter edit to reproduce old behavior; original user changes not reverted.
- vendor-vendor-external-program-current.log:90passed,22new real DB/API cases versus68.
  Permitted projection/real receipt/retry/IfMatch/purpose/link/version/content/
  no link inheritance/empty assignments/cancellation-rebooking/history/audit SQL
  rollback/concurrent receipt; ten actual wedding-lock waits (GET and POST:
  revoke, expiry, deal cancellation, archive, wedding cancellation) and actual
  proof expiry during a blocked POST. Waiting SQL executes genuinely; observed
  query wrapper does not synthesize lock or data. Special mutations use SQLfixture.
- Direct typecheck caught redundant vendorId argument in shared projection caller
  after narrowing input type. Removed unused field, no runtime guard weakened.
  full-full-external-program-first.log1187frontendpassed/1453backendpassed/1failed
  old prod2 case expected an unassigned block. Fixture now assigns it through
  actual owner PUT and adds stronger hidden-block/count/who checks.
- full-full-external-program-final.log1187frontend/1454backend no skipped/types/lint/
  build/contracts passed on fresh externalfinal2 DB/Redis13. This is the
  checkpoint before stronger invite/deal composite FK; final current run below.
- vendor-vendor-external-issued-time-witness.log91passed had insufficient actual wait
  to distinguish JavaScript millisecond timestamps reliably; not a negative witness.
  Stronger held witness adds50ms before release:
  vendor-vendor-external-issued-time-witness-held.log1failed/90passed, created_at predates
  release. Explicit clock_timestamp issuance fixes it. Five additional real
  issuing-owner lock waits (role/session/account/archive/cancellation) reject
  without creating another link. Final coverage28new =22initial+1issuance-time+
  5issuing-owner revocations, proved by full1460-1432=28.
- full-full-external-program-bound-final.log:1187frontendpassed/1460backendtests
  passed, but ratelimit.test.ts suite failed Connection is closed (ioredis socket
  close stack). This is a failed full run, not accepted final. Actual historical
  disconnect cause unverified. No unrelated limiter/test/Redis app code changed.
  redis-observation.json shows current PONG/ready/localDB13; separate
  redis-external-close-isolated.log10passed. Full retry on NEW externalverify DB
  now passed below; these observations do not by themselves prove earlier cause.
- FINAL full-external-protocol-current.log:86frontendfiles/1187tests,
  111backendfiles/1460tests, no skipped, init.sh exit0 and types/lint/build/contracts
  passed. NEW tili_codex_externalverify_20260930_test PostgreSQL + actualRedis13.
  No app/backend/test/schema/migration edits since this final started; later
  docs/external browser/preview only. Earlier failed/checkpoint runs retained.

C:/Тили-тили/.unlazy/wp03-external-program-20260930/:

- migration-bound-result.json:13passed actual PG/CLI checks. All pre-existing
  column fingerprints retained; identity uniqueness/repeatup; emptydown/up;
  real DDL transaction rollback/receipt rollback; version/digest/object checks;
  foreign-wedding deal FKs reject; binding-protecteddown/receipt-protecteddown;
  additional unbound/same-wedding wrong deal/recorded binding mutation rejection.
  Earlier migration-first-result.json10 checks precede stronger composite binding.
  Synthetic migration history fixture is not human acknowledgment evidence.
- externalprogram1 actual Chromium/HTTP8passed, page_errors empty, runner exit0.
  Public external booking/issue/assignment; old UI only own block; browser fetch
  permitted coherent proof/complete interval/GET readonly; real browser POST and
  retry original receipt; new link pending/wrong proof422; owner revision pending/
  stale409/newack; public cancel GET/POST410; old cabinet reload removes program/chat.
  Two actual PNG legacy390/revoked390 inspected, no observed overlap; legacy
  clock UI is not accepted as the new event-timezone/full-interval reader.
  This deliberately tests HTTP protocol via browser fetch, not checkbox command.
  New external checkbox UI/team summary/physical devices/providers flags false.
  Runner stops API/Vite/Python and removes private JWT fixture.
- Intentional preview uses isolated externalprogram1*_test DB, APIhealthok/UI200,
  listener commands/parents verified: API21108/parent21140, Vite3132. No production.

Scoped server ledger status then approve: ALL MET5. CRLF-aware git diff check
exit0. Only server stage, not external UI/team/T007/WP03/all WP. No publication.

## Remaining

External checkbox/full interval reader/refusal/retry/offline and corresponding
pair/team current external receipt/history still mandatory. Existing summary
not_supported has not yet been changed, and must not be claimed complete.
Legacy external chat/read revocation lifecycle needs its own full review.
Delegated company actors/WP09, T009 full offline/access cleanup, event invitations/
RSVP/transfers/management, whole SC/NFR and feature commit/push/main still open.
All original WP00–WP16 retained. This server stage doesn't close T007/WP03.
