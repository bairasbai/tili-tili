# WP03 / T007: External Team Acknowledgments

2026-09-30. Local stage, not entire T007/WP03/WP00-WP16.
No GitHub/production/provider operations or verified-human identity claims.

## Implementation

- Migration176240 adds nullable `deals.current_program_invite_id`. Historical
  issuance order/current pointer is unknown and NOT reconstructed from timestamps
  or receipts. Old link program/history remains, but team current-link status
  requires a newly issued invitation captured by the current protocol.
- New invite and explicit current pointer are saved atomically under live
  issuing-owner/session/wedding lock. Older links remain usable according to
  their own live rights; old receipt cannot acknowledge the newly issued link.
  Current is not inferred from UUID ordering, transaction time or maximum date.
- Exact composite FK(wedding,pointer,deal) to issued invite(wedding,identity,deal)
  rejects unbound/foreign/wrong-deal links; registered deals cannot use pointer.
  Deleting current invite clears only pointer; recorded pointer protects down.
- Authorized couple/helper/coordinator summary uses the same actual assigned
  projection/version/digest as the external reader. External group is actual
  deal ID, not name. Invite/slot locks precede deal locks; changed pointer/candidate
  actor snapshot409. Last actual clock check follows all actor/projection/receipt
  queries; expired latest link unavailable, no old-link green fallback.
- Live current-link+deal+version+digest receipt -> acknowledged; valid link/no
  receipt -> pending; no assignments -> unassigned; revoked/expired/unknown
  pointer/old slot -> unavailable. Current receipt and previous history separate,
  including old link at the same version. Latest expired history is ordered by
  PostgreSQL timestamp precision, not JavaScript millisecond comparison.
- External acknowledgedBy always null: link possession is not verified human
  identity. UI current-link/source labels explicit; registered actual author
  unchanged. Fabricated external named author is rejected as incomplete response.
  Current rows require timeline ETag=summary ETag=body version; refresh/offline
  hides old rows. No proof/rawtoken/identity/finance/contact fields in summary.
- API0.61.0,160paths/210operations/109schemas, normal generators. Status
  not_supported remains contract/client compatibility for historical servers,
  not an emitted current external state. No dependency/lockfile/.env change.

## Evidence

`C:/Тили-тили/.unlazy/wp03-shift-20260930/`:

- vendor-external-team-current.log:117pass/1old historical-fixture failure.
  Exact FK rightly rejected clearing an issued binding while still current.
  Historical fixture now clears synthetic pointer first, preserving prior
  unbound409/expired410 assertions; production guard not relaxed.
- vendor-external-team-fixed.log118pass, initial22new compared to previous96.
  Actual pending/receipt/anonymous source, explicit pointer versus changed old
  timestamp, new link/old link still live, version/content change/history,
  four unavailability states, unassigned, cancel/rebook/retained receipts,
  same-name distinct deals, helper/coordinator/stranger/link permissions,
  six real lock waits (revoked/expired/natural expiry/slot/pointer/late receipt
  expiry), actual SQL division-by-zero issuance rollback. Query observers run
  actual SQL; special mutation/TTL controls are explicit local fixtures.
- ackui-external-team-current.log71pass = summary26+vendor22+audit31editor23.
  Nine new summary UI cases: explicit link source/current-link pending/history/
  unavailable, fabricated current or past named external actors rejected,
  refresh/offline/English. Controlled fetch bodies, not DB/provider evidence.
- full-external-team-final.log1219frontpass/1481backpass/1audit53 failure: fixture
  prefix string resembled unscoped UPDATE. Real query had tenant/deal WHERE.
  Matcher now exact complete SQL string including WHERE; audit53 guard unchanged.
- full-external-team-verify.log1219front/1482back no skipped/types/lint/build/
  contracts/initexit0, NEW externalteamverify DB+real Redis13. Checkpoint BEFORE
  the stronger history-precision witness/fix, not final current-code evidence.
- vendor-external-team-time-witness.log1fail/118pass: controlled real PG timestamps
  .123999Z versus .123001Z differ998microseconds (123999-123001=998), but both
  Date/DTO timestamps .123Z. Expected previous version16, got20 because JS tie
  chose current receipt. Synthetic timestamp controls, not historical human facts.
  SQL now selects latest receipt at full PG precision before final TTL check.
- vendor-external-team-time-fixed.log119pass =96previous+23new. No SQL guard,
  access or history assertions weakened. The extra case proves precision fix.
- FINAL full-external-team-current.log:87 frontend files/1219 tests and111
  backend files/1483 tests, no skipped; types/lint/build/contracts/initexit0.
  Fresh tili_codex_externalteamfinal2_20260930_test plus real Redis13.
  1219-1210=9 new frontend cases;1483-1460=23 new backend cases.
  No app/backend/test/schema edits after this full run started.

`C:/Тили-тили/.unlazy/wp03-external-team-20260930/`:

- migration-a-result.json14 actual PG/CLI checks from pre176240 externalui DB:
  all old-column fingerprints/receipt history preserved, unknown pointer/repeat
  up/empty down/up/DDL rollback/pointer transaction rollback, same-wedding wrong
  deal/foreign wedding/registered/unbound pointer deny, exact binding mutation
  protection, protected populated down, delete synthetic current invite clears
  only pointer, real tenant cascade/rollback with mutual FK. Pointer assignments
  for constraint checks explicitly synthetic, not inferred historical issuance.
- Browser externalteam1:13 completed checks then ambiguous English locator
  selected both current source and collapsed history source. failure.png viewed;
  product labels were correct. Selector now separately checks current source
  and expanded history; no product code/assertion removal. ERR0369.
- Browser externalteam2:17 entries in timeline-browser-result.json passed,
  page_errors empty, runnerexit0. Actual public issue/book/assign, anonymous UI
  checkbox -> SQL receipt -> couple/helper/coordinator summary, new link pending/
  old link still live/history, guarded local SQL current-link expiry -> unavailable/
  previous receipt/no old-link green fallback/reader410, reissue, edit/newversion/
  fresh review, RU/EN, offline clear/reconnect, public cancel and membership removal.
  Explicit SQL expiry is a fixture, not public revoke or natural thirty-day wait;
  real natural expiry after lock waits is covered by API cases. Cancellation
  receipt retention is separately API/DB-checked, not claimed from browser alone.
- Eight region PNG viewed:external-team320/390/1440,new-link-history390,
  expired-link390,revised-history390,external-team-en390,cancelled390.
  viewport-external-team320.png also viewed. Whole-region bounds above fixed
  nav, refresh elementFromPoint and no horizontal overflow asserted at320/390/1440.
  Not physical-device/SMS/provider/production verification. Runner disposed
  only its own API/Vite/Python processes and removed private auth fixture.

## Scope Still Open

Scoped external-team GATES.md status then approve returned ALL MET5. Reports/
business/maps/tasks/JOURNAL/ERRORS/handoff updated; CRLF-aware diff checkexit0.
No GitHub/production operations; no feature commit/push/main yet.

Statuses reflect actual server GET; no automatic discovery of expiry/remote
revocation on an idle device claimed. Complete legacy external cabinet/chat
server rights-after-wait lifecycle, delegated company/WP09 actors, T006 actual
event invitees/RSVP/transfers, T008 management, T009 full versioned offline/access
cleanup, all T010 SC/NFR and T011 feature commit/push/main remain mandatory.
Full WP00-WP16 remains active; this stage does not redefine completion.
