# WP03: Configured-Origin CORS Writes

Historical125-source checkpoint after later guest-write changes; latest scope:
[REPORT-GUEST-WRITE-ACCESS](REPORT-GUEST-WRITE-ACCESS.md). Results below remain
evidence for the tested125 source, not a new full verification of126.

2026-10-01. Local isolated CORS patch and verification, not full T009/WP03/
WP00-WP16 acceptance. No remote/GitHub/commit/push/main/provider/production.
No migration/API/dependency/environment changes or cloned app.ts wholesale copy.
Prior124 seating live access inventory is historical after these source edits.

## Witness And Fix

Authorized parallel task reported an isolated methods allowlist. Independently
read its code, then tested ORIGINAL existing wedding/timeline routes, not clone
order routes. No other resource/order/consent/users/delegation source integrated.

Original backend/src/app.ts register(cors) lacked methods. Actual HTTP
corswrites-cors-before.log:3 failed/7 passed; returned GET,HEAD,POST only,
not PUT/PATCH/DELETE. corsWrites.test.ts uses actual Fastify/CORS without DB,
checks six method declarations, origins, credentials, request headers, exposed
timeline version headers, unsupported CONNECT/TRACE and unauthenticated401.

Actual Chromium corsbefore1 against production-build UI3000 and API3001/fresh
migrated PostgreSQL:8 witnessed checks/zero pageerrors/all3 PNG inspected.
GET with bearer/ETag worked; PATCH seating, PUT timeline with actual If-Match,
DELETE table each failed TypeError with actual CORS policy diagnostics. Actual
guest/table/timeline state stayed unchanged. Native server401 and unconfigured
localhost-origin refusal retained. This is before-fix evidence, not feature success.

Patch adds only methods ['GET','HEAD','POST','PUT','PATCH','DELETE'] inside
existing original register(cors). corsOrigins, credentials:true and exposedHeaders
unchanged; no wildcard origin, no OPTIONS/private authority or auth bypass.
After corswrites-cors-fix.log:10 passed; scoped eslint0.

Actual Chromium corsafter1:9 checks/zero pageerrors/all3 PNG inspected320/390/1440.
Cross-origin POST201, PATCH named-person seating200, PUT with current If-Match200/
changed readable ETag+actor, DELETE204/actual unseating. Stale If-Match409,
unauthorized401/helper private-phone403 remain readable and change no state.
Unconfigured localhost-origin write remains blocked, actual server unchanged.
No browser routing/API response mocks or fake authorization/provider delivery.

Logs C:/Тили-тили/.unlazy/wp03-shift-20260930/corswrites-*.log;
browser evidence C:/Тили-тили/.unlazy/wp03-cors-writes-20261001/browser-evidence-corsbefore1
and browser-evidence-corsafter1. Private fixtures/own services disposed,
actual3000/3001 no listeners after runs. PostgreSQL retained for isolated tests.

## Final Verification

LOCAL SCOPED ACCEPTANCE. full-cors-full.log: fresh migrated whole init.sh on
tili_codex_seatingcors1_20260930_test/actual Redis13,95 frontend files/1385 passed,
113 backend files/1602 passed, no skips/types/whole-tree lint/build/contracts,
init.sh exit0/all migrations/preflight. Backend delta1602-1592=10 CORS tests;
frontend1385 unchanged. Entry617.99KB/gzip192.60KB warning retained, no raised
threshold or complete NFR/device/production/provider acceptance claim.

Final same-source production-build Chromium corsafter2:9 checks/zero pageerrors/
all3 PNG inspected320/390/1440. Actual cross-origin operations/ETag/current
If-Match/stale409/noauth401/helperphone403/no unauthorized SQL changes and
unconfigured localhost-origin write refusal verified again. Evidence:
C:/Тили-тили/.unlazy/wp03-cors-writes-20261001/browser-evidence-corsafter2.
Own children/privatefixture disposed, actual3000/3001 no listeners/no preview.
Current125 source/test/migration/API/build-config SHA256 entries:
C:/Тили-тили/.unlazy/wp03-cors-writes-20261001/current-source-manifest.json,
created before full and rechecked after full/browser. No source edits after
freeze. Branch/HEAD feature/master-plan-delivery-20260930/
bdca2f63f1faa2cd1b93f50fb6558ac61eb5f01f, uncommitted/unpushed. Inventory is not a commit
or completed feature. Full requirements, other guest reads/doors, event/delegation/
SC/NFR/provider/product rules and production restriction unchanged.
Master spec/plan/baseline/tasks diff empty from c2dea5; current README diff empty,
pre-existing8-line initial delivery header retained, not byte-identical to c2dea5.
CRLF-aware diffcheck0. Scoped manual final docs/gates status+approve each
exit0/ALL MET4 after documentation;
not independent full-feature acceptance. No local=GitHub identity claim.
