# Точка передачи · Codex, 2026-10-03

Наша ограниченная поставка030 уже в main: [PR27](https://github.com/bairasbai/tili-tili/pull/27), merge aa85f886, head04d349f; семь успешных проверок подтверждены повторно. Клод затем опубликовал022/T012 и PR30/31. На main4f6381d Codex повторил init.sh: фронт112/2105, сервер145/3067, без пропусков; типы, линт и сборки прошли. Все867 хешей совпали. Браузерный пробел атомарной замены закрыт: реальные локальные HTTP409/200, SQL-сохранение оплаты/истории/чужих дат, RU/EN320/390/480.

Полный итог: [REPORT-CLOSE](tasks/фичи/030-экосистема-local/REPORT-CLOSE-20261003.md). Инструкция Claude: [CLAUDE-CONTINUE](tasks/фичи/030-экосистема-local/CLAUDE-CONTINUE.md), раздел15. Итоговые документы публикуются отдельным PR; его CI/merge подтверждаются отдельно. После этого данная сессия останавливается по поручению пользователя. Production не выкладывался.

Следующий380 остаётся непринятым черновиком в remote feature/030-370-legacy-inventory@6a0e6a3; основной локальный checkoutbde3e40 отстаёт. Модуль legacy-source.ts и новая репетиция отсутствуют. Миграция176380 не входит в main и эту приёмку. Сохрани обе версии, сначала проверь статус и владельцев. [Переносимый контракт](tasks/фичи/030-экосистема-local/c380-inventory-contract.md). Широкий WP00–WP16/A/U не завершён. Предыдущие границы ниже — исторические.

# Session Handoff: Full WP00-WP16 Delivery

## Current Boundary · 2026-10-03 (Claude, облачная сессия)

Опубликовано: T012 — PR #29 (merge a495968, CI зелёный); PR #30 (адаптивная навигация, доступные
пикеры) — merge 92d79f4. Запись ниже «2026-10-02» про T012 как PENDING устарела.

Приказ владельца: закрыть хвосты §3 `C:/Тили-тили/.unlazy/tz-full-20261002/HANDOFF-NEW-CHAT.md` по
порядку, новое не начинать; потолок расхода — 80% недельного лимита.

Сделано в ветке `fix/handoff-tails-20261003` (от main 92d79f4): №3 T012 — пояс гостю словами
(`zoneLabel`), без «Имя · Имя» у пары; №4 — уникальные имена browser-проверок CI; №6 — deep-link под
nginx из `deploy/`: «404» не воспроизвёлся, белая страница на адресе со слешем исправлена в шиме
(ERR-0427). Проверки: фронт 112 файлов / 2105 тестов, tsc, линт, сборка; бэкенд main в облаке —
145 / 3066 на PG16 + Redis 7. Репетиция миграций экосистемы — только в CI (защита checkout'а).

Не сделано — нужен ПК (из облака `.unlazy` и рабочий checkout недоступны): №1 удалить worktree
`C:/Тили-тили/wt/pa` (junction node_modules — `cmd /c rmdir`, не `/s`); №2 этап 370 — черновик
миграции/теста только на диске ПК, ветка `feature/030-370-legacy-inventory`, не закоммичен; №5
браузерные оракулы 030 (харнесс `.unlazy/ecosystem-audit-20260930`). Обязательные browser-проверки в
защите main — действие владельца.

Next: PR ветки → зелёный CI → влить; затем на ПК №1 → №2 → №5. Production запрещён.

## Boundary · 2026-10-02 (Claude)

Ведомость драйвера вне репозитория: `C:/Тили-тили/.unlazy/tz-full-20261002/PLAN.md`.
030 опубликован: PR https://github.com/bairasbai/tili-tili/pull/27, merge
2026-10-02T06:31:56Z (aa85f88), CI 7/7, включая фикс «двойное «Сохранить»
первой анкеты» (LOCAL-030-31). T012 (022: персональный RSVP по person/event,
общий дедлайн до конца дня по поясу события, обращение после срока,
organizer-provenance) реализован на этом main и проверен локально: контракт
0.70.0/6 операций (0da3e23), миграция `1763700000000_event_rsvp_deadlines.cjs`,
backend `rsvp-events.ts`, гостевой блок `/invite` (один список, решение D5) и
новый экран пары `/wedding/events/:eventId/rsvp`.

Проверки: targeted 4 files/68 tests; весь фронт 111 files/2085 passed, tsc/
eslint чисто. Backend на свежей полной БД (79 миграций по порядку): T012
131 tests + legacy regression 266, tsc ok; после независимого Opus-ревью —
155 tests на dev-БД + regression тихих часов/notify 318. Migration drill на
чистой БД: 22 own migrations до 1763700000000 включительно / 12 T012 SQL-отказов
+ 1 guarded CLI down. Browser (prod build + real API/PG,
`.unlazy/tz-full-20261002/scripts/browser-t012.mjs`): 9/9 checks, 0 ошибок,
RU/EN 320/390/1440.

Независимое ревью нашло и закрыло до публикации (разбор и правило —
`ERRORS.md` LOCAL-030-32…35): P1 каскадное удаление гостя/семьи/+1/события с
живой просьбой падало 500 (BEFORE DELETE стража против легитимного ON DELETE
CASCADE); P1 решение по просьбе человека, снятого с ростера между просьбой и
решением, 404-илось и откатывалось целиком (просьба оставалась pending
навсегда); P2 чужой guestId с действующим токеном пары отдавал 401 вместо 404
(identity-оракул); P2 срок ≤ дата мероприятия вынесен в CHECK базы; P3 чтение
по гостевому токену — for share вместо for update; P3 DST-переход ровно на
местной полуночи потребовал второго прохода коррекции смещения в `fromLocal`.
Источник и полные числа — `REPORT-RSVP.md` (`tasks/фичи/022-мероприятия/`).

PENDING: полный `bash init.sh` на финальном дереве, CI, merge владельцем —
T012 не объявлен опубликованным. Next: публикация T012 → затем 030 этапы
370–374 (K-Q10: основная дата остаётся на «Мы» до этого момента) → остальные
WP. Production запрещён; выкладка — позже вместе с владельцем.
Старые границы ниже — исторические.

## Boundary · 2026-10-01
Primary repo: C:/Тили-тили/Тили-тили_код_и_документация.
PR25 actually merged2026-10-01T12:00:51Z, all7displayed CI SUCCESS,
main04a8355182467a93d9c10499bf4a11dbd6de3d6b/local-fetched clean/source569.
New feature/event-rsvp-20261001 starts from that main. Do not replay old
pending-publication records for PR21-25.
At this document's commit boundary the personal invitation roster is verified
locally, not yet published. Next scoped commit/push/CI/main. After remote work
use actual attached PR and external confirmation:
C:/Тили-тили/.unlazy/wp04-event-invitations-20261001/PUBLICATION-CONFIRMED.md.
If absent, verify status rather than infer merge from tests or intentions.

## Delivered Locally
022 partial personal invitation roster, not separate event RSVP or whole WP04.
Migration1762500000000 follows actual176240 chain: additive event/person
table, composite wedding FKs, immutable identity/main exclusion, common
wedding lock/revision; populated rollback refusal. Old guests/parties/RSVP/
tokens preserved by actual migration drill. Main invitations remain existing
people. New extra event/new family member receives no automatic extra invite.
Couple-only GET/PUT event invitations, captured If-Match/full set, no-op keeps
version, fresh locked access/finalJWT; event delete refuses populated roster.
GET RSVP pins the exact wedding/party/token and returns only main and explicit
own-person additional events; no foreign names/IDs/roster/contacts/statuses.
Unknown event metadata remains null. Legacy POST RSVP remains main-only.
Canonical OpenAPI0.63.0,161paths/212operations/111schemas, standard regeneration.
New /wedding/events/:eventId/invitations, per-person checkbox editor, accepted
model verification, role/version/shape/offline/lifetime/double-click controls.
Conflict/ambiguous network keeps exact draft; explicit fresh opening only,
no automatic retry/rebase. Private guest event list and main-only RSVP label.
RU/EN/maps/report updated; source unchanged after final full freeze.

## Actual Verification
- Focused invitations-final3.log:9files289passed including new29PG cases and
  exact audit55 contract invariant. Front invitationsui-final2.log:8files182
  passed including new22UI cases, dictionary/route/contrast/shell guards.
- Fresh full-invitationsfull3.log:99front files1452passed/117backend files
  1762passed, no skips, all8init.sh stages types/tests/wholelint/build/init0.
  PG16 on127.0.0.1:15432, Redis13, SMS empty, actual Node25.9.0.
- Actual production-build local preview/API/PG invitationsfinal3:9checks,
  zero page_errors; all10PNG inspected RU/EN320/390/1440, private guest list,
  preserved main responses, populated DELETE409, stale409/fresh action, clear[],
  helper403/anonymous401, ENsave, new form/nav/text geometry. No HTTP mocks,
  physical-device, production deploy or real sender claim.
-574 normalized SHA256 source/test/config hashes match after full/browser;
  docs/env/dist/deps excluded. Original master spec/plan/tasks/baseline
  unchanged against c2dea5a4; checker rejects earlier failed full logs.
- Actual migration-drill-second baseline176240/up176250 preserves old rows,
  own empty down/up, populated down refusal, wedding cascade. First incorrect
  target rehearsal retained, not acceptance. Token reassignment controlled
  before witness1failed (28filter skips), then exact resource regression passed.
- Retain full1 dictionary failure, full2 audit55 old exact literal failure,
  initial test fixture/observer and browser selector/layout logs. Final1
  browser nine checks had guest animation screenshots; final2 observer
  tolerance y=-0.15625px. Final3 waits opacity0 and checks actual guest bounds.
  No source change for these last harness corrections.

Evidence paths:
C:/Тили-тили/.unlazy/wp04-event-invitations-20261001/GATES.md, check-evidence.mjs,
migration-drill-second-*.log, browser-evidence-invitationsfinal3/;
C:/Тили-тили/.unlazy/wp03-shift-20260930/full-invitationsfull3.log;
C:/Тили-тили/.unlazy/wp03-publication-20261001/event-invitations-source-manifest.json.
Browser children/private fixture cleaned; retained disposable PostgreSQL kept.
No production environment or configuration changed.

## Next Step / Scope Still Open
Owner's latest instruction: finish this roster increment, merge only after
CI, prepare full Claude instructions and STOP. Do not start T012 in Codex
now. Resume guidance: tasks/фичи/022-мероприятия/CLAUDE-CONTINUE.md.
PR26 https://github.com/bairasbai/tili-tili/pull/26 carries sourcecc8a31b;
at this docs commit it is still open. Final actual confirmation remains the
external PUBLICATION-CONFIRMED.md/PR, never inferred from a planned merge.
After scoped publication continue T012 in tasks/фичи/022-мероприятия/tasks.md:
per-person/event RSVP, common calendar deadline, late contact and organizer
correction provenance. Read canonical spec/plan before paths/migration changes.
Human approved one deadline per event until the end of its chosen local
calendar day; cutoff is next local day's start, not UTC23:59:59/fixed24h.
Unknown zone must block deadline activation, no silent Moscow substitution.
Keep main legacy responses and bus/hotel effects isolated from extra RSVP;
test roster/access/token/deadline changes during waits, DST/null metadata,
family scopes and migration preservation. Do not half-activate deadlines.
Main-date survey unanswered: /us remains. Accepted reminder withdrawal survey
also pending. Providers unchosen; tariff/retention rules not supplied.
Production forbidden. All remaining WP04/master T010/FR/SC/NFR/WP00-WP16
obligations remain open. No claim that every hole/full delivery is complete.

## Remote / Coordination
Before GitHub node C:/Users/Bayra/.claude/hooks/github-api-guard.js --status;
pause means no remote. Sequential requests/writes spaced, no watch/loops;
CI reads at least2-3min apart. Stop403/429/auth/abuse/rate refusal, no bypass.
Attach every created PR. Merge only after actual green CI, verify local main/
fetched origin/main/clean tree/source hashes. Preserve unrelated changes.
Authorized parallel thread01a0f198-4c17-7cd1-8931-516ff056d1a6,
title «Проверь статус параллельной сессии», clone ecosystem-local-20260930.
Do not import its app.ts/users/schema/migrations wholesale or accept its
self-reported all-WP coverage without primary independent tests.
# Current local ecosystem030 handoff — 2026-10-01

Current task works ONLY in C:/Тили-тили/ecosystem-local-20260930, branch feature/ecosystem-audit-local-20260930, baseline9628d0b22711782dec121fa4596119e5fb7cce6a, no remotes. User requests staged audit/calm UX implementation through agents and separate LOCAL commit; no main merge, GitHub, push or production. Original checkout and other session remain separate. Instructions in the historical inherited section below do not authorize publication by this task.

Latest accepted resource stage: private preparation77/18waits, actual registered API81/13waits, legacy boundary31/9waits, catalogue/shortlist32/4waits, Search controlledDOM49, reservation controlledDOM79. Actual synthetic browser commit1→replacement2 preserves one15000kopeck root/payments/program; old5 lives through newplan edit and only explicit agreed replacement changes livecapacity to3. All12RU/EN pair/vendor320/390/480 screenshots parent inspected. Evidence+sourceSHA: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/commitment-browser-acceptance.md. Applied365–369 immutable. Freshdrill12 previously98SQL/16CLI through21own migrations; any newDDL needs fresh reviewed namespace. Our8091/8092 exec49050/54911 stopped and fixtureHTML removed; shared retainedPG15432 continues, Redis12 ours. No API/provider/human/legal/physical-device extrapolation. Current types/scopedlint0; prior full1555/2370/780 is HISTORICAL and current whole run pending.

Finite legacy review accepted as source proposal only (35links/report008a8576), not implemented. Next: ordinary card resource-book journey and truthful NULLcity/initial journal; then finite originalDATE/fullholder snapshots/schema3same-root adoption/common manual occupancy/reschedule. Broader staff/duties/incident routing/PlanB/fulfillment/logistics/refunds/lifecycle/fulltests/maps/localcommit still required. Goal/tool reports blocked from earlier interruption; user explicitly resumed, so work continues and must not be marked complete prematurely. All17WP remain broader scope; no feature commit exists yet.

## Inherited historical session snapshot


## Local ecosystem030 continuation — 2026-10-01

This section describes OUR isolated clone only: `C:/Тили-тили/ecosystem-local-20260930`, branch `feature/ecosystem-audit-local-20260930`, inherited baseline9628d0b, no remote. User authorized staged implementation, agents and coordination with “Можешь найти все дыры и исправить”; do not write the original checkout, push, merge main or touch production. Its earlier WP03 notes above are inherited context, not our acceptance evidence.

Current bounded foundations and evidence are in JOURNAL/ERRORS and `C:/Тили-тили/.unlazy/ecosystem-audit-20260930/PLAN.md`. Resources API119/actualPG waits82 and UI54 were independently reverified; UI browser synthetic RU/EN320/390/480 preserves legacy obligations and claims declared capacity only. Published terms browser demonstrates two separate synthetic parties accepting revision2; this is not real-user/legal/provider evidence. Migrations through355 are immutable; the14-migration drill retained fresh9 with51 SQL refusals and9 down guards. Staff public API/UI, accepted resource plan/booking commitments and broad A/U outcomes remain unfinished.

Latest correction: first full frontend failed5/1467, archived `full-full-first-frontend-failure.log`; fixed redundant Push dictionary keys, scanner domain files and stale test labels. Focused4 files71 passed (`ui-full.log`). Repeated `verify.mjs full full` is running on own `tili_ecosystem_full_20260930_test`/Redis12; result pending at this entry. Our API/Vite are stopped. No final commit yet. Before final commit remove only our temporary `backend/scripts/.ecosystem-browser-local.mts` and `app/.ecosystem-browser-local.html`, retain external evidence. Continue all authorized stages; do not call limited foundation full ecosystem or all17WP completed.

## Local ecosystem030 — verified checkpoint 2026-10-01

Third `verify.mjs full full` ended exit1: frontend93 files/1467 tests and backend130 files/2295 tests all passed, no skips. Frontend types/lint/build and backend types passed. Only stopping backend lint error was no-console in our temporary browser fixture helper; this is NOT a whole init.sh pass. Evidence: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/full-full-third-lint-failure.log, lines7-8,91-101.

The two temporary browser fixtures were removed from our clone after preserving them externally as browser-fixture-helper.mts and browser-fixture-page.html. Whole backend ESLint and tsc build then independently exited0. Source-manifest verify confirmed all772 captured file hashes still matched after fixture removal; preserved as checkpoint-full-third-source-manifest.json before further implementation. GATES:G2 remains pending one final whole init.sh exit0. No commit/push/main or original-checkout mutation.

Next required implementation is actual optional order resource plan, immutable private revision and safe public terms projection, followed by real booking commitments/legacy compatibility. Saving a plan must not claim reservation. Staff public duties, incident routing, Plan B and remaining broad A/U outcomes remain open. Local foundations are not all17WP or complete ecosystem.

## Local ecosystem030 — resource plan continuation 2026-10-01

Immutable360/361 and optional order resource plan are implemented in our isolated clone. Public terms schema2 binds the exact safe immutable plan; schema1 remains valid for orders without plans. Saving a plan explicitly reserves nothing and changes no paid balance, timeline, legacy busy date or capacity used. The initially applied360 was restored unchanged when a missing-schema/deferred-head improvement was identified; integrity was added as preserving forward361. Both were applied only to our fenced resource_plan test DB. No production migration.

Independent parent leaf1.7.1/2 review and reverify: static source check0 and61 actual PostgreSQL tests passed, with6 observed lock waits, actual deferred orphan COMMIT23514 and audit SQL rollback. Sources/hashes and bounded evidence are recorded in the leaf ledgers; their exact leases released. Historical-author deletion in those tests uses a synthetic transfer fixture and does not verify current-owner eraseUser.

Registered API14 passed after a real cached-owner privacy defect was fixed (ERRORS LOCAL-030-12). Before-fix200 private replay is preserved in resource-plan-api-before-owner-replay-fix.log; current scoped owner verification now occurs before cache lookup. Current owner positive replay/no-op and exact distinct synthetic party schema2 acceptance passed. This is not human acceptance or a production transfer workflow.

Parent optional editor64 passed; integration3 files149=83 terms+64 editor+2 dictionary passed (ui-plan_integrated.log, node-1.7:G3). Frontend full project tsc -b exited0 after source freeze. The first schema2 test run failed18 assertions because malformed projections remove the accept control rather than disable it; corrected tests assert no control/no POST, not weaker validation. Archive ui-terms_schema2-first-assertion-failure.log. An earlier in-flight UI parse error was resolved before this source freeze. Final UI still awaits actual browser RU/EN320/390/480 acceptance and leaf1.7.3 lease remains active.

OpenAPI0.66.0 local generation measured179paths/233operations/139schemas. The historical772-file manifest describes the earlier355 checkpoint; it is not current stage1.7 acceptance. Migration drill extension is under reviewed agent execution on first-absent exact fresh10–12 only, retaining earlier8/9 evidence. Its success is pending at this entry. No final full init.sh exit0, final feature commit, push/main or whole17-feature/ecosystem completion claim. Booking commitments and broader staff/incidents/PlanB/logistics/settlement/lifecycle still required.
## Local ecosystem030 — resource-plan checkpoint, 2026-10-01

Current isolated clone whole init exit0: frontend94files/1555tests, backend132files/2370tests; no skipped tests; both projects types/lint/build passed. Source-manifest verify matched all780 captured local files after the run. Evidence: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/checkpoint-resource-plan-full-passed.log and checkpoint-resource-plan-full-source-manifest.json. This supersedes the prior partial init failure only for this reviewed snapshot; future changes need fresh checks.

Retained shared PG now loopback15432 (same data directory, no deletion/rebuild); shutdown cause unconfirmed. Exact own resource_plan/full/browser databases remain fenced, Redis12 empty. Parent domain61 and API14 rerun on15432; editor64 and integrated149 rerun after final EN recorded-in-commitments/timezone-list polish. Source hashes/actual receipt and browser limitations: C:/Тили-тили/.unlazy/ecosystem-audit-20260930/resource-plan-browser-acceptance.md.

Actual synthetic browser: distinct vendor then couple accepted terms2/schema2. Manufacture June13 and delivery June14 remained distinct; buffers10/15/20/25 show occupied09:30–12:40 Moscow. Invalid qty0 retained input/showed error; restored5 saved as no-op. Independent actual SQL confirms plan1/terms2/order4/two distinct user-session receipts, capacityused0 and business snapshot unchanged. RU/EN vendor and pair320/390/480 no horizontal overflow; all12 screenshots visually inspected. Synthetic Chromium only; no physical-device, provider, human or legal acceptance claim. Own8091/8092 stopped, temporary helper/credential page removed from clone after external preservation; sharedPG remains running.

Parent fresh migration drill11 actual G1 subprocess exit0:68SQL/11CLI controls and actual current-owner eraseUser/history preservation, frozen script6f6b20e3; leaf1.4.2 accepted/released. Raw migration_drill-migration_drill11.log. Historical drill10 raw numeric exit unavailable after runtime reinit; not invented. Leaf1.7.3 final browser/source reviewed and released; stage1.7 plan only verified. No final commit/push/main/production or source transfer to the other session.

Next: actual allocation ledger and common booking/cancellation/erasure/capacity doors, explicit finite legacy reconciliation. A saved/agreed resource plan still reserves nothing. Staff public duties, incidents/routing, PlanB, fulfilment/logistics, settlement/lifecycle and broader A/U outcomes remain open. No claim complete ecosystem or all17WP.

## 2026-10-01 · commitments kernel checkpoint and next guarded integration

Parent current kernel998bc/test9e5c independently89/89 actual PG passed with20 observed waits; leaf1.8.1/2 gates accepted and leases released, ready22 fullyreturned. Applied immutable365–369: source-backed allocations/head/version/membership/usedcounter; sourceproof after final windows; same financial root; exact replacement reuse; tx-bound cancel/erase/purge release. Reproduced42703/23503/false-release SQL COMMITs retained and corrected via367/368/369; ERRORS LOCAL03013–15. This is bounded synthetic/local kernel acceptance, not registered booking/legacy/UI/full acceptance. Old full1555/2370/780 remains historical.

Root next common safety integration sources static0: booking-boundary.ts; oldcatalog/offer/bookVendor/lowesthold/PATCH firstcommitted refuse resourcespolicy or retained liveallocations after downgrade; manual DATE batch actualoneTXcurrentprincipal/owner/company mutex; interim resource reschedule returns409 before any mutation. This guarded-away reschedule is temporary safety, not completed reschedule product. Independent new tests authoring `/root/commitments_tests` exactonlyresourceBookingBoundaries.test.ts leaf1.8.3/ready24 (sealed). Migration drill authoring `/root/catalog` exactonlyscripts/ecosystem-migration-drill.mjs leaf1.4.3/ready23(sealed), through21 own immutablefiles, fresh12 stillunused. Agents do not run DB; root serializes.

An initial prior-regression invocation wrongly selected allocations for three suites with narrower exactDB allowlists:2files93passed,3beforeAll guard refusals/157skipped, actualexit1; not application failure or acceptance of all250. Archive boundary-prior-regression93-wrong-db-guards.log. Guards remain unchanged; ownfull DB now being upgraded365–369 then exactsame5suites rerun on allowedfull. SharedPG15432 alive; Redis12 ours/13 other session; no own API/Vite or original ports stopped/changed. Other session reports its own authorized PR21/mainf9ccfa published and further guestread work; our noGitHub/main/push constraint unchanged, no source import. Entire030/17WP/finallocalcommit remains unfinished.

## 2026-10-01 · accepted boundary and next public resource stage

Parent fresh12 preserving drill accepted/released:21 own immutable migrations,98SQL controls (12+9+23+7+17+30) and16CLI guards, actualexit0, sourcea6c6228c/manifests215433e. Archive commitments-migration-drill12-passed98-16.log. Fresh10/11/12 now occupied and must remain; future materially changed drill needs new reviewed finite namespace, never deletion/reuse. Prior5 regression suites250/250 passed on allowedfull after365–369, archive boundary-prior-regressions-passed250.log. Historical whole init1555/2370 does not accept later source.

Independent olddoors current31/31 passed with9actualPGwaits and source/testreview; leaf1.8.3 released, frozen test2435283f, archive booking-boundary-current-public-api31-passed.log. First18/31 and next30/31 failures were invalid snapshot fixture/inflight exact cache claim/owner EPQ expectation and forbidden price rewrite in positive; preserve negative archives. Final state-only paid/done proves full finance/counter/allocation invariants and price_locked negative. Resource reschedule remains safe409 only, not completed UX.

Root actual profile package-delete/selected retry cycle40P01 reproduced and repaired, ERRORS LOCAL03016. Actual before/after JSON preserve lockqueries, one moneyroot and original15500/snapshot after catalogue package deletion. New profile-locks.ts sortedW/request/deal/currentprincipal/company with postwait scope recheck; absent company uses owner userUPDATE before SHARE. Creation race source found independently, permanent actual witness still pending.

Catalogue preparation source1bedb20f126lines authored/frozen; initial draft event notified_at is processing suppression marker, not delivery. leaf1.8.4 remains open independent tests, leaf1.8.5 /root/catalog onlytestresourceOrderPreparation onready26 authoring. NoDBbyagents. Public root OpenAPI0.67/generated183paths238ops144schemas; safevendorbookingpolicyGET/resource-orderPOST/commitmentGET-POST-replace registered, exactactor/currentACL-before-cache and freshcommitmentreadonreplay. Plan reservation projection now refers only to exact currentplanId; newer draft leaves older promise visible separately. Public/API/UI independent gates remain open: ready27 sealed2/2started leaf1.8.6 /root/commitments_tests onlyresourceCommitmentApi.test; leaf1.8.7 /root/commitments_domain onlyOrderResourceCommitments component+test. Root Search reachable preparation/calendar-truth/replacement-safety integration underway, not accepted yet; root APIhelpers/oldplanlabels updated. No current full/browser/finalcommit. No source imports/main/push/GitHub/production. Other session's reportedmain9cf734f is theirs only; sharedPG15432/Redis13 retained, oursRedis12/noown8091/8092.

Continue all authorized broad outcomes: finite legacy reconciliation/adoption, offer preparation, resource manual availability/calendar/reschedule, staff duties/handoffs, incidents/PlanB, fulfilment/logistics, settlement/lifecycle and WP03 scoped dependency. All17/full ecosystem not completed; no final local feature commit yet.

## 2026-10-01 · atomic replacement continuation

Our clone/branch/no-remotes/no-feature-commit constraints verified again: branch feature/ecosystem-audit-local-20260930, HEAD9628d0b. Original checkout/3000/3001 and shared PostgreSQL retained. All own migrations through369 immutable,21 own; next forward370+, fresh drill10/11/12 retained. No GitHub/main/push/production.

Accepted public resource81/13waits; preparation77/18; catalogue32/4 includes actual profile creation race; UI resource-reader79, Search resource58/location truth, ordinary Deal47, plan97. Actual synthetic browser previous commitment+replacement checks documented externally; new ordinary card CTA focused current panel and SQL nofinancial/receipt/allocation changes. Own8091/8092 stopped and temporary HTML removed before this continuation. These are bounded local evidence, not human/provider/device/legal acceptance or all17.

Current atomic legacy replacement source replace.ts SHA2d6028ceb65cd6a3d7602b015ac0ac6d38952219efce664dca4a5885c693c672, POST slots/replace and SDK, one caller TX. Actual registered PostgreSQL73/73/no skips with24 observed waits (atomic-legacy-passed73-waits24.log); test SHA7156a7a8d07754a618f6a5d00b4713476f71dd41ebfcbad4cb5d0e1bfc82eacd. 72/73 prior failure was direct-only wait observer: actual graph proved second request queued behind first, corrected bounded transitive observer preserves exactly2 actual waiters and final200/409/one cancellation+newroot/money checks. Leaf1.9.2/3 reviewed/VERIFIED/exact leases released. Common bookVendor actual before tests exposed wrong-category company booking; category guard now shared before financial DML. New malformed-200 missing/new-old-id UI negatives reproduced then fixed; current parent78/78=18retained+60new, leaf1.9.4 accepted/released, Search SHAc3174943e61c3aa2747039a8665d5bb1b5f2c191c2717f46719b2b1668e529bd. Whole front/backend types and scoped lint0.

OpenAPI0.68.0 generated184paths/239operations/144schemas. Prior full first front12failure corrected by fixture agents without removing assertions. Second full used wrong namespace and13 suite guard refusals; harness full mode now ALWAYS targets dedicated_full DB, tags name logs only. Actual source scanner/serial manifest/documented error controls39/39 and prior resource310/310 separately passed; their source snapshot precedes latest common category guard. Current correct `verify.mjs full booking_ui3` running session58047 at this entry, result UNKNOWN until polled; never call full exit0 from partial evidence. No source changes during this run (agents only external design/helper).

Active external-only leaf1.9.5 (/root/atomic_domain, ready34) finite-calendar-design.md; manual review pending, not implementation. Active external-only leaf1.9.6 (/root/booking_review, ready35) atomic-replacement-browser-helper.mts; root alone runs DB/browser/servers after source freeze, pending real409+SQL refusal and success acceptance. No background polling/reports/UI retry; manual same-key uncertain-response verification only. Continue finite groups/original DATE/proved explicit zones/schema3same-rootadopt/manualorigins/reschedule and broader030 outcomes. User resumed goal despite inherited blocked tool status; meaningful work ongoing, do not stop or claim all17/final commit.

## 2026-10-01 — завершение текущего этапа по новой инструкции владельца

Владелец попросил закончить текущий этап, подготовить полную инструкцию Claude, отправить завершённую работу на GitHub и влить в main при успешной проверке, затем остановиться. Это заменяет прежний запрет GitHub/main для данного завершения; production по-прежнему вне поручения. Следующий370+ этап не начинать. Весь аудит030, A01–A20/U01–U16 и17WP не объявляются выполненными.

Атомарная замена обычного подрядчика выполняет один POST /weddings/{weddingId}/slots/{slotId}/replace и одну транзакцию: проверяет текущие права, выбранную прежнюю сделку, актуального кандидата/пакет/цену/календарь; отменяет старую и создаёт новую бронь вместе. При отказе старая бронь не отменяется. Повтор после неизвестного ответа сохраняет исходный ключ/тело и требует ручного действия; автоматического опроса/повтора и регулярных отчётов нет. Старые платежи и история остаются у прежней сделки; автоматический возврат денег не реализован. Ресурсные обязательства заменяются своим отдельным согласованным путём.

Исправление прежней интерпретации: введённое ограничение категории в общем bookVendor было несовместимо с установленной возможностью компании оказывать несколько услуг одной свадьбе. Полный прогон выявил20 таких регрессий; это ограничение удалено, прежняя совместимость восстановлена. Строгая проверка категории нового кандидата в атомарной replace сохранена. Две PostgreSQL-проверки теперь доказывают сохранение200 старого book, полную сохранность прежних корней/сумм/истории и текущую проверку прав/пакета после реального ожидания.

Текущие ограниченные доказательства: atomicLegacyReplacement73/73 без skips,24 реальных ожидания PostgreSQL; тест SHA54dd296a644f79273cecb0ef624dbb22d548ecc19ebb27dbf3e9e2cfb3cb39e3, atomic-legacy-final-compat-passed73.log. Затронутые11 серверных файлов395/395 без skips (atomic-and-legacy-compatibility-passed395.log). UI63 atomic+18 прежних shortlist+58 resource journey=139/139 (ui-atomic_uuid_fixed.log); точный leaf81/81. Новые malformed-success проверки требуют новый валидный UUID и не принимают старый UUID в ином регистре.

Реальный синтетический браузер:409/date_taken после занятия выбранной даты другой свадьбой и200 свободного кандидата; по одному HTTP POST на действие. Независимые SQL-oracles подтверждают отказ без потери старой брони/оплаты/истории и успешную замену с одной отменой/новым корнем, сохранением чужих DATE/ресурсных обещаний. RU success и EN bookedcard на320/390/480 без горизонтального переполнения. Это Chromium/синтетические пользователи, не человеческая/юридическая приёмка, не реальные устройства/провайдеры. Свои8091/8092 остановлены, временный HTML с токенами удалён, база сохранена.

Свежая preserving rehearsal13 прошла:21 неизменяемая собственная миграция300–369;98 SQL-контролей (12+9+23+7+17+30) и16 настоящих CLI-отказов отката; полный snapshot сохранён. Script SHA14b9518b4f0d69d8c197d94445ef54b0594c0cad6fdd70276866b89248ece00b; manifest SHA215433ea637a4edca82aa9f12f203ca17a8c45c27c559f931d973f9009f24ae1. Старые fresh10–12 не удалены. CI получает отдельный loopback-only15432 PostgreSQL под точные защитные проверки; фактический CI ещё требует исполнения на опубликованном head.

Дизайн finite-calendar-design.md подготовлен и проверен, но370+ DDL/домен/тесты не реализованы. Нужны явная инвентаризация старых DATE/всех держателей, доказанные конечные интервалы/IANA, новый schema3 proof, adoption того же оплаченного корня, ручные источники и атомарный перенос. Owner-only предложение не освобождает чужие обещания. Остальной незавершённый scope перенесён в CLAUDE-CONTINUE.md; исходный аудит сохранён рядом.

На момент этой записи финальный полный прогон и интеграция в опубликованный main f725ce96f0f694c3e1db74b0fe768556230aa915 ещё проверяются. Они не считаются успешными по частным результатам выше. Более поздняя итоговая запись содержит фактически измеренный результат. Подробные локальные доказательства: C:/Тили-тили/.unlazy/ecosystem-audit-20260930; не включать токены/fixtures/runtime в Git.

## 2026-10-02 · Separate presentation-fix handoff

Scope is limited to the five UI groups in `tasks/presentation-accessibility-20261002.md`.
Branch: `fix/presentation-accessibility-20261002`, base main aa85f8868154000cab2c5b049dcf92a1c679259f.
104 targeted frontend tests, TypeScript, full frontend lint and build pass; 15 new
regressions fail on the base. Browser/screen-reader/full-app verification is not claimed.
No backend/API/authentication/membership/receipt changes, deployment or main merge.
Next: review the single-commit draft PR and run supported-browser presentation QA.
Earlier work and its pending decisions above are unchanged.
