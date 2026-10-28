# FULL371 — Root SQL/domain interface, schema94

Статус 28.10.2026: ниже сохранён исходный frozen контракт/interface. Реализация schema94 и локальные SOURCE/native/frontend проверки приняты; compiled UI исполнен, финальная независимая приёмка и remote publication отслеживаются в session-handoff.md и E/GATES.md. Начальные UNRUN/freeze формулировки ниже исторические. 372/373/374/T009 остаются OPEN.

Base748a3da; current contract25C713CCF3EB9E095F951F48A176A581EEAE5F50E5AD26CEF49B01E58F3EDA2E. Root owns ONLY migration1763920000000_legacy_calendar_bounds.cjs; applied93 immutable. Root adopts candidate with binding clarifications D9 below; not installed DDL, UNRUN. Native timestamptz; UUID lower, bigint DTO decimal; SHA256 text lowercase64hex. Stable person key не cascade.

## Таблицы: обязательные columns

V=legacy_calendar_bounds_versions,H=legacy_calendar_bounds_holders; default NOT NULL, ?=NULL. FK SET NULL only actual parent erasure, other fields immutable.

```sql
legacy_calendar_bounds_versions(
 id uuid PK, source_id uuid, inventory_version_id uuid,
 version bigint CHECK(version>0), previous_version_id uuid?,
 wedding_id uuid?, company_id uuid?,
 source_revision bigint CHECK(source_revision>=0), inventory_revision bigint CHECK(inventory_revision>0),
 inventory_digest text, source_fingerprint text,
 declaration jsonb, canonical text, digest text,
 staffing_completeness text, association_fingerprint text,
 created_by uuid?, created_session_id uuid?, policy_version text, created_at timestamptz
)
 UNIQUE(source_id,version), UNIQUE(source_id,id),
 UNIQUE(source_id,id,inventory_version_id), UNIQUE(id,inventory_version_id).
 FK source_id -> legacy_calendar_sources(id) ON DELETE CASCADE.
 FK(source_id,inventory_version_id)->legacy_calendar_versions(source_id,id).
 FK(source_id,previous_version_id)->V(source_id,id) DEFERRABLE INITIALLY DEFERRED.
 FK wedding_id->weddings(id) ON DELETE CASCADE; company_id->vendors(id) ON DELETE CASCADE.
 FK created_by->users(id),created_session_id->sessions(id) ON DELETE SET NULL.
 CHECK exactly one wedding/company parent; native guard matches source kind/parent.
 CHECK canonical::jsonb::text=canonical; SHA256 UTF8 canonical=digest.
 CHECK staffing_completeness IN('unknown','declared_complete').
 previous NULL iff version1; predecessor exact current proposed version.

legacy_calendar_bounds_holders(
 id uuid PK,source_id uuid,bounds_version_id uuid,inventory_version_id uuid,
 wedding_id uuid,deal_id uuid,slot_id uuid,
 expected_order_version bigint CHECK(>0),day_version_id uuid?,
 outcome text,closure_reason text?,holder_snapshot jsonb,holder_fingerprint text
)
 UNIQUE(bounds_version_id,wedding_id,deal_id), UNIQUE(bounds_version_id,id),
 UNIQUE(source_id,bounds_version_id,id).
 FK(source_id,bounds_version_id,inventory_version_id)->V(source_id,id,inventory_version_id) ON DELETE CASCADE.
 FK(inventory_version_id,wedding_id,deal_id)
   ->legacy_calendar_version_holders(version_id,wedding_id,deal_id).
 CHECK outcome IN('finite','calendar_closed');
 closed iff closure_reason='no_remaining_calendar_engagement';
 finite iff closure_reason NULL. Deferred exact holder set and source wedding equality.
 No independent deal cascade: history follows legitimate source wedding.

legacy_calendar_bounds_spans(
 bounds_version_id uuid,owner_key uuid,span_index integer CHECK(>=0),
 holder_id uuid?,owner_kind text,original_date date?,
 span_mode text,local_starts_at text,local_ends_at text,
 supplied_starts_at text,supplied_ends_at text,time_zone text,
 starts_at timestamptz,ends_at timestamptz,coverage jsonb,
 PRIMARY KEY(bounds_version_id,owner_key,span_index)
)
 FK bounds_version_id->V(id) ON DELETE CASCADE.
 FK(bounds_version_id,holder_id)->H(bounds_version_id,id).
 owner_kind IN('holder','manual'); holder:holder_id=owner_key; manual:holder_id NULL/owner_key=bounds_version_id.
 span_mode IN('explicit','whole_local_day'); five exact literal coverage true.
 finite start<end, ms precision, [); sort/dense indices/no duplicate-overlap per owner.
 Whole day original_date required/native adjacent local DATE midnight roundtrip.

legacy_calendar_bounds_person_scope(
 bounds_version_id uuid,person_identity uuid,context_material jsonb,
 PRIMARY KEY(bounds_version_id,person_identity)
)
 FK bounds_version_id->V(id) ON DELETE CASCADE.
 person_identity immutable stable UUID, NO user CASCADE.
 Actual observed context guard; declared_complete includes conservative known set.

legacy_calendar_bounds_receipts(
 id uuid PK,source_id uuid,bounds_version_id uuid,holder_id uuid,
 party text,user_id uuid?,session_id uuid?,policy_version text,
 purpose text,digest text,read_claims jsonb,proof_hash text,
 read_iat bigint,read_exp bigint,accepted_at timestamptz
)
 UNIQUE(bounds_version_id,holder_id,party).
 FK(source_id,bounds_version_id,holder_id)->H(source_id,bounds_version_id,id) ON DELETE CASCADE.
 FK user_id->users(id),session_id->sessions(id) ON DELETE SET NULL.
 CHECK party IN('customer','performer'),purpose='calendar-bounds-read',
 read_exp>read_iat AND read_exp-read_iat<=600.
 INSERT requires nonNULL current user/session, exact claims/native DB time and holder.
 Activation checks all receipt parties current/distinct, not only caller.
 read expiry checked at acceptance; receipt retention never releases promise.


legacy_calendar_bounds_heads(
 source_id uuid PK,revision bigint CHECK(>=0),
 proposed_version_id uuid?,effective_event_id uuid?,
 proposed_version bigint CHECK(>=0),updated_at timestamptz
)
 FK source_id->legacy_calendar_sources(id) ON DELETE CASCADE.
 FK(source_id,proposed_version_id)->V(source_id,id) DEFERRABLE INITIALLY DEFERRED.
 FK(source_id,effective_event_id)->legacy_calendar_resolution_events(source_id,id)
   DEFERRABLE INITIALLY DEFERRED.
 proposed_version=0 iff proposed_version_id NULL; independent head revision++ on proposal/activation.
 Receipt insert does NOT bump head. Next proposal version = prior proposed_version+1, not head revision+1.

legacy_calendar_resolution_events(
 id uuid PK,source_id uuid,bounds_version_id uuid?,
 action text,previous_event_id uuid?,actor_id uuid?,session_id uuid?,
 policy_version text?,reason text?,before_fingerprint text?,after_fingerprint text?,
 material jsonb,created_at timestamptz,transaction_id bigint,backend_pid integer
)
 UNIQUE(source_id,id), UNIQUE(source_id,bounds_version_id,id).
 FK source_id->legacy_calendar_sources(id) ON DELETE CASCADE.
 FK(source_id,bounds_version_id)->V(source_id,id).
 FK(source_id,previous_event_id)->events(source_id,id) DEFERRABLE INITIALLY DEFERRED.
 FK actor/session -> users/sessions SET NULL.
 action IN('activate','holder_cancelled','source_unavailable','source_stale','superseded').
 Native txid/pid/xmin ownership for newly published effect; no freely settable release permission.

legacy_calendar_resolution_holders(
 event_id uuid,source_id uuid,bounds_version_id uuid,holder_id uuid,outcome text,material jsonb,
 PRIMARY KEY(event_id,holder_id)
)
 FK(source_id,bounds_version_id,event_id)->events(source_id,bounds_version_id,id) ON DELETE CASCADE;
 FK(source_id,bounds_version_id,holder_id)->H(source_id,bounds_version_id,id).
 Complete exact set for activation; cancellation only actual cancelled holder membership.

legacy_calendar_person_links(
 id uuid PK,vendor_identity uuid,person_identity uuid?,
 origin_kind text,origin_id uuid,unknown_identity boolean,observed_at timestamptz
)
 UNIQUE NULLS NOT DISTINCT(vendor_identity,person_identity,origin_kind,origin_id).
 origin_kind IN('owner','accepted_staff','person_resource','duty','bounds_certificate').
 unknown_identity iff person_identity NULL. Stable identities no destructive user/vendor FK.
 Append native observed evidence only; semantic hash deduplicates identities/unknown origin,
 not timestamps/repeated link evidence. Invitation target alone excluded.

resource_occupancy_origin_certificates(
 id uuid PK,scope_kind text,source_identity uuid,vendor_identity uuid,
 bounds_version_identity uuid,activation_event_identity uuid,
 app_wedding_id uuid?,live_source_id uuid?,live_vendor_id uuid?,
 live_bounds_version_id uuid?,live_activation_event_id uuid?,
 digest text,canonical text,created_at timestamptz
)
 UNIQUE(bounds_version_identity).
 scope_kind IN('app','manual'); app iff app_wedding_id NOT NULL.
 FK app_wedding_id->weddings(id) ON DELETE CASCADE.
 Other live FKs -> source/vendor/V/event ON DELETE SET NULL.
 Stable identity/digest/minimal person-range canonical immutable; NO manual vendor cascade.
 INSERT only exact current native activation, deferred exact certificate/person/span set.
 Erased live source never licenses release. Private proposal can cascade, certificate remains.
 Canonical contains only required stable origin/person/range/proof digest, no copied economics.
 Parent removal can NULL pointers only, cannot alter range/person/digest.

resource_occupancy(
 id uuid PK,origin_kind text,origin_id uuid,origin_version_id uuid,origin_line_index integer,
 certificate_id uuid?,allocation_id uuid?,
 vendor_identity uuid,kind text,conflict_identity uuid,
 resource_id uuid?,capacity_window_id uuid?,quantity integer,
 occupied_starts_at timestamptz,occupied_ends_at timestamptz,
 enforcement text,released_at timestamptz?,release_reason text?,release_event_id uuid?
)
 UNIQUE(origin_kind,origin_id,origin_line_index).
 origin_kind IN('commitment','legacy_person'); new manual origins not enabled371.
 commitment: allocation_id=origin_id/certificate NULL, exact allocation origin_version/line;
 legacy_person: allocation NULL/certificate NOT NULL, kind person/quantity1/resource-window NULL.
 FK allocation_id->resource_allocations(id) ON DELETE CASCADE (legitimate own-wedding only).
 FK certificate_id->certificates(id) ON DELETE CASCADE (manual parent independent).
 FK resource/window -> existing resources/windows RESTRICT, stable person no user FK.
 finite [), quantity>0, kind IN('person','equipment','capacity'),
 enforcement IN('exclusive','legacy_barrier'), release paired exact reason/proof.
 GiST exclusion active exclusive person/equipment; barrier overlap allowed.
 BEFORE new exclusive shared-key check live barriers, no fake release by source_unavailable.
```

## Native SQL interface: freeze names/return shapes до domain кода

Public new functions; material NO LOCK, mutations caller TX; raw missing-prefix NOWAIT/refuse.

```sql
legacy_calendar_bounds_source_material(p_source_id uuid) RETURNS jsonb STABLE
-- current source+/1-/2+unfiltered DAY/group/holders/orders/plans/parts/person semantic context;
-- NULL only absent; incomplete explicit reason.
legacy_calendar_bounds_material(p_source_id uuid,p_inventory_version_id uuid,p_declaration jsonb)
 RETURNS jsonb STABLE
-- validated declaration + exact current input refs; excludes own heads/receipts/events outputs.
legacy_calendar_bounds_fingerprint(p_material jsonb) RETURNS text IMMUTABLE
legacy_calendar_bounds_known_person_scope(p_vendor_id uuid) RETURNS jsonb STABLE
-- {identities:[uuid sorted],unknownOrigins:[{kind,id} sorted]}, not assignment proof.
legacy_calendar_bounds_span_valid(p_span jsonb,p_original_date date) RETURNS boolean STABLE
-- TIME exact syntax/ms/native named-zone roundtrip/coverage/whole-day check.
legacy_calendar_bounds_principal_current(
 p_source_id uuid,p_wedding_id uuid,p_deal_id uuid,p_party text,
 p_user_id uuid,p_session_id uuid,p_policy_version text) RETURNS boolean STABLE
legacy_calendar_bounds_complete(p_bounds_version_id uuid) RETURNS boolean STABLE
-- exact inventory holder set/spans/persons/ancestry/canonical field equality.
legacy_calendar_bounds_agreed(p_bounds_version_id uuid,p_policy_version text)
 RETURNS boolean STABLE
-- complete + current digest and all distinct current receipt parties;
-- manual own declaration handled by explicit owner authority branch, never fake receipts.
legacy_calendar_bounds_assert_applied(p_event_id uuid) RETURNS void VOLATILE
-- new event TX ownership + exact final heads/certificates/occupancy/native data conservation.
legacy_calendar_bounds_current_effect(p_source_id uuid) RETURNS jsonb STABLE
-- {state,freshness,effectiveVersionId,conflicted}, unavailable/stale never silently finite/free.
legacy_calendar_bounds_assert_mirror(p_allocation_id uuid) RETURNS void VOLATILE
legacy_calendar_bounds_assert_certificate(p_certificate_id uuid) RETURNS void VOLATILE
legacy_calendar_bounds_assert_boundary(
 p_vendor_id uuid,p_deal_id uuid,p_lines jsonb,p_initial_witness_id uuid)
 RETURNS void VOLATILE
-- p_initial_witness_id nullable, DB-validated actual own initial conversion only.
legacy_calendar_bounds_assert_person_links(p_person_ids uuid[],p_vendor_ids uuid[])
 RETURNS void VOLATILE
```

Initial witness: actual client+txid/pid pending root/head0/no history/no DATE/current terms-plan; final guard exact same-TX commit1/allocations/selected booked/conversion. Only own live_negotiation excluded; old/manual/orphan/aliases block. Current reserved retry preserved. Root freezes native derivation/table before boundary code.

Trigger names: protect_legacy_calendar_bounds_version/holder/span/person/receipt/head/event/person_link/certificate/occupancy; check_legacy_calendar_bounds_complete; maintain_resource_occupancy_mirror; guard_resource_occupancy_origin; check_resource_occupancy_complete. BEFORE immutability/shape/origin; deferred watchers on all new tables + exact domain dependency tables including offer_requests/offers/member/auth/plan/parts/DAY. No signature requires replacing applied365–93 files; Root adds forward COR/guards only as needed.

Lock interface remains domain internal: locate full actor+receipt+historical union; weddings→requests→financial→FULL sorted accounts strongest SHARE/erasure UPDATE FIRST→principal/session/consent/member→companies/policy→staff→stable keys→resource/window/allocation→signed-hashtext DATE advisory union→DAY/groups/heads→bounds/occupancy. Re-locate after wait, expansion409, no late earlier locks. Session proof clock fetched after locks. Physical locks not conveyed by plain input DTO.

Root freeze: literal initial-witness derivation and remaining-work predicate; no omitted371. Cross-history FKs marked no delete cascade are DEFERRABLE INITIALLY DEFERRED where legitimate whole-parent cascade needs end-of-TX consistency. SOURCE candidate only, SQL UNRUN.

## D9. Binding Root clarifications before joint implementation

1. Maincontract25C713CC D1perSOURCEstrict. `source_fingerprint` = SHA256 current `legacy_calendar_bounds_source_material(source_id)::text`, excluding current inventory/bounds head outputs/clock/receipt/effect outputs. Material includes exact actual current inventory data +full DAY/group/known aliases+current holder order/plan/active parts/effective person semantic context; `inventory_version_id`/digest stored separately in immutable proposal. New alias/holder/input after wait changes source fingerprint. Bounds material canonical is SQL-generated declaration+validated current sourceMaterial+exact captured inventory references. API sourceFingerprint=head-independent current input; proposedVersion monotone per source independently of mutable headRevision.

2. Native initial conversion witness: NEW `legacy_calendar_initial_commit_witnesses(id uuid PK,wedding_id uuid,deal_id uuid,vendor_id uuid,terms_id uuid,plan_revision_id uuid,policy_revision bigint,actor_id uuid,session_id uuid,policy_version text,pending_state text,recorded_at timestamptz,transaction_id bigint,backend_pid integer)`; unique(wedding_id,deal_id,transaction_id); ownwedding FK CASCADE, scoped financial refs deferred where needed. Rows immutable, initial native function only. Server-only `legacy_calendar_bounds_prepare_initial_commit(p_wedding uuid,p_deal uuid,p_terms uuid,p_plan uuid,p_policy_revision bigint,p_actor uuid,p_session uuid,p_policy text) RETURNS uuid VOLATILE` captures under prepared locks actual pending candidate/contacted/negotiating, selected slot empty-or-same/no prebooked, head0/no history/no prior allocations/no old DATE or previously booked/paid/done event, exact current agreed=proposed terms/plan +distinct parties/current actor. Returns UUID whose authority is native row+current txid/pid/xmin, not a request flag.

Witness deferred COMMIT guard requires actual SAME-TX new commitment version1/actioncommit/selected slot/booked root + actual new deal_event from captured pending state +exact plan/terms/policy/allocations (existing365 exact-member proof remains). If intent did not finish initial conversion, rollback whole TX. SQL raw occupancy guard derives witness from actual origin version/root/currentTX; no body except list. BEFORE allocation it may ignore ONLY own live_negotiation source/certificate; manual/orphan/app_root/oldDAY/otherroot never excluded. Add resolution action `negotiation_committed` bound to actual final witness+commit1/new actual booked event; it releases only the same root's old negotiation person barrier. Expiry/done/source_unavailable alone never releases it. Failed/wrong-root/old-witness/noop-retry cannot borrow witness. Existing reserved no-op has no new witness and retains current guards. This is initial workflow, not372adoption of old booked root.

3. Remaining-work predicate `legacy_calendar_bounds_engagement_covered(p_wedding uuid,p_deal uuid,p_outcome text,p_spans jsonb) RETURNS boolean STABLE`. Read ONLY current active order_parts(cancelled_atNULL), actual immutable current resourcePlan.lines, actual live allocations. Finite must cover actual occupied resourceplan/allocation intervals with buffers and all known active part periods: timed_service/appointment startsAt..endsAt expanded by known setup/teardown and, conservatively, the single travelMinutes on BOTH sides (direction is not encoded; same rule in the one native predicate); supply windowStartsAt..windowEndsAt; rental handoverAt..returnAt (equal instant uses point containment); deliverable dueAt point. Missing/invalid required calendar endpoint or required timed buffer is explicit unknown→false. Quantity/price/unit are not invented calendar durations. All relevant intervals/points must be contained in union of declared spans; no lexical wall-time comparison. Outcome closed requires no active allocation/accepted plan lines/active remaining or unknown parts. Empty legacy structure plus fresh both-party complete declaration may finite/closed; old financial state/past DATE alone never qualifies. This is conservative known repository scope, not proof of wholly unrecorded external work. SQL/TS share this predicate, no second drifted heuristic.

4. TS authorization uses existing lockCurrentConsent/lockOrderPrincipal (audit54 single TS consent reader); new SQL principal guard may use native actual existing event_move_principal_current pattern with explicit current server-policy parameter, not claim policyVersion globally exists in DB. Native activation/currentness must not re-expire previously accepted read token; token expiry only on accept. All receipt principals/sessions/current server policy checked again at activation; expired/revoked live auth blocks new action, not historical occupancy. Read clock is `select clock_timestamp()` AFTER final source/principal locks.

5. Core SQL mutation order: insert version with proposed_version+1 and predecessor=current proposed ID; then exact H/spans/person children, then head.revision+1/proposed pointer (no effective). Accept inserts immutable own receipt only. Activate creates event+complete resolution_holders+certificate+legacy-person occupancy and publishes head.effective_event_id with head.revision+1. No adoption/resource-allocation/money/DATE write during proposal/read/accept/activate. Manual no app holder/receipt; owner authority repeated. Superseding old effective certificate is one-way resolution proof for actual prior effect, preserves original rows; reactivation cannot silently drop previously accepted promised periods. Until matching full new proof/current scope, retain conservative prior barriers.

6. Policy read keeps existing historical manual/deal/unknown/committed/negotiating counters as diagnostics; `unresolved`/reason derived from unique actual-present sources which lack current complete effective proof, not the sum of overlapping historical subsets. Add typed unique `{totalSources,unresolvedSources,finiteSources,closedSources}` counts. Existing DATE-only booking boundary remains refused in resources mode, no fake reservation through policy switch.

7. Precise catalogue aggregate: NEW authed `GET /catalog/vendors/:vendorId/occupancy` with required explicit UTC `from`,`to` (finite increasing, maximum370days), same assertVendorLive published/unblocked/deleted check as current catalogue availability. Safe DTO `{state:'busy'|'unknown'|'none',occupiedPeriods:[{startsAt,endsAt,timeZone:string|null}],freshness:'current'|'stale'|'unavailable',updatedAt:string|null}`; no source/root/person/receipt IDs/economics. `none` means no recorded occupancy in requested window, explicitly NOT a resource-plan capacity/free promise. Unknown/stale sources force unknown (known occupied periods may still be shown); otherwise any actual finite source/allocations/capacitybaseline occupied intersection→busy, else none. Old /availability busyDates/holdDates stays compatible/conservative. Scope/privacy/unknown and no-id leak assertions mandatory; no public DTO reuse of private projections.

8. Domain/SQL missing-prefix guards never claim complete nonwaiting semantics for RI/unique/initial target row waits; strong sorted domain prefix remains mandatory. Source locks, semantic link expansion, numeric DAY advisory union and all 19 writer entries remain full-stage requirements. Final acceptance cannot be inferred from isolated token module/unit tests.

Implementation clarification: company-wide checks include all active accepted legacy certificate/ranges by stable vendor identity for EVERY resource kind, even after live source/DAY removal; not just person-selected lines. Complete staffing must include actual observed owner, hence finite activation has at least one known person and each company span is represented. source_unavailable never disables these accepted rows; released/superseded rows excluded only by native scoped proof.

## D10. SQL JSON return contract / module integration

`legacy_calendar_bounds_source_material(uuid)` returns NULL only if source record absent; otherwise exact object `{encoding:'legacy-calendar-bounds-source/1',sourceId,kind,vendorId,weddingId,companyId,originDate,sourceRevision,scopeCompleteness,unavailableReason,inventoryMaterial,holders,context,personScope,vendorOwnerId,ownerAvailable,policyMode,policyRevision}`. Nullable keys always present. `inventoryMaterial` is actual current /1 or/2 JSON (not recomputed historical encoding). `holders` sorted records `{weddingId,dealId,slotId,orderVersion,holderSnapshot,holderFingerprint,calendarInputs}`; snapshot/fingerprint are actual corresponding current inventory holder, `calendarInputs` contains active parts/current plan and allocations needed engagement guard. `context` sorted `{weddingIds,dealIds,slotIds,dayIds,sourceIds}` complete related DAY/aliases for locks/freshness; unfiltered K consistency required. `personScope`=`{identities:UUID[],unknownOrigins:{kind,id}[]}` sorted. All revisions decimalstrings, originDate nullable. No inventory/bounds heads, proposal/receipt/effect outputs, auth clock/expiry, UI labels in this input. Source fingerprint=SHA256 this PG jsonb text.

`legacy_calendar_bounds_material(source,inventoryVersion,declaration)` returns canonical object `{encoding:'legacy-calendar-bounds/1',sourceId,kind,vendorId,weddingId,originDate,sourceFingerprint,inventory:{versionId,revision,digest},declaration}`. It validates exact current captured inventory version and material, group/people/engagement; returns data only, caller hashes exact `::text`. `declaration` exact `{holders,manualBounds,staffing}`: sorted holders `{weddingId,dealId,expectedOrderVersion,outcome,closureReason,spans}`, manualBoundsNULL orsameoutcome/reason/spans; staffing `{completeness,personIds}` sorted. Spans normalized `LegacyBoundsSpan` output (9keys: TIMEinput7 plus suppliedStartsAt/EndsAt), not raw7 input: UTC/local canonical `.SSS`, original supplied instants preserved. Native parity validates all9 keys; relational original_date is separately server-derived. API input7 → TS parse → SQL declaration9. Do not feed normalized output back to body without explicit7-key projection.

`legacy_calendar_bounds_current_effect(source)` exact `{state:'unresolved'|'finite'|'calendar_closed',freshness:'current'|'stale'|'unavailable',effectiveVersionId:UUID|null,conflicted:boolean,updatedAt:UTC|null}`; effectiveVersion refers event.bounds_version_id. Proposal-only state unresolved/effectNULL, receipt insert no change. SQL freshness predicate checks input material equality/person completeness; stored old effect never implies current finite.

Root new scope module exports `prepareLegacyCalendarScope(client,input)` where input `{weddingIds?:readonly UUID[],vendorIds?:readonly UUID[],personIds?:readonly UUID[],resourceIds?:readonly UUID[],sourceIds?:readonly UUID[],actor?:OrderActor,extraAccountIds?:readonly UUID[],mode?:'write'|'erase'}`. Returns prepared `{assertCurrent():Promise<void>,sourceIds,weddingIds,vendorIds,personIds}`; transaction-private client/pid/txid, nested scopes must be subset, no new earlier parent. Full prefix is source95contract D6 strongest accounts first; actor in union. GET uses existing read-only owner/own-holder auth, not this UPDATE prefix; all mutation entrypoints use it before legacy helpers. Root owns file+existing-writer integration; domain worker imports only this API.

Domain NEW `resources/legacy-calendar.ts` exports typed inputs/views and operations `loadLegacyCalendarSources`, `loadLegacyCalendarEditor`, `loadOwnLegacyCalendarSources`, `captureLegacyCalendarBoundsInventory`, `proposeLegacyCalendarBounds`, `readLegacyCalendarBounds`, `acceptLegacyCalendarBounds`, `activateLegacyCalendarBounds`, `loadPublicLegacyCalendarOccupancy`. Client supplied TX, no begin/commit/service. Owner inputs `{vendorId,actor}` plus sourceId forsource; holder `{weddingId,dealId,sourceId,actor}`. Mutation bodies per coreD7, actor never bodyauthority. read/accept take `{secret}` proof options. Propose normalizes TIME/span sets and validates native material before row writes; exact children derived nativecaptured snapshots, no financial/root generation. Owner editor labels from actual slots.label/current directory queried after authority, not included calendar fingerprint. Owner GET/editor tokensNULL; only explicit ownholder GET signs currentproposal DBclock proof. All mutations re-auth after union and before effect; current receipts principals at activation must use current server policy.

Activation same current already-effective proposal with unchanged authorized scope is no-op after expected current head check; no duplicate certificate/event/revision. Same idempotency-key replay handled Root routes before CAS while fresh ACL/material checked; domain never accepts arbitrary body except list. New revision full supersession requires native proof and retains old rows, does not inherit receipt. Own-neg witness/context passed ONLY by Rootcommitment internal writer, never public bounds/body. Common boundary helper stays closed until meaningful full native RED and integrated acceptance.

## D11. Native activation constructors (no guessed JS proof JSON)

`legacy_calendar_bounds_activation_material(p_version uuid,p_policy text) RETURNS jsonb STABLE` exact `{encoding:'legacy-calendar-bounds-activation/1',sourceId,boundsVersionId,boundsDigest,sourceFingerprint,holderIds:UUID[] sorted,personIds:UUID[] sorted,policyVersion:p_policy}`. Only native current whole proof may create activation event with this material. Resolution-holder `material` exact `{encoding:'legacy-calendar-holder-resolution/1',holderId,weddingId,dealId,outcome,boundsDigest}` from actual H/V rows; event/H/receipt set checked bidirectionally.

`legacy_calendar_bounds_certificate_material(p_version uuid,p_event uuid) RETURNS jsonb STABLE` exact `{encoding:'legacy-calendar-occupancy-certificate/1',sourceId,sourceKind,vendorIdentity,boundsVersionId,activationEventId,boundsDigest,scopeKind:'app'|'manual',weddingIdentity:UUID|null,persons:UUID[] sorted,ranges:[...],lines:[...]}`. `ranges` sorted ownerKey/spanIndex are actual finite proposal spans `{ownerKey:holderId|manualVersionId,weddingId:UUID|null,dealId:UUID|null,spanIndex,startsAt,endsAt,timeZone}`. `lines` is exact cartesian actual persons×ranges, sorted ownerKey/spanIndex/personIdentity with dense lineIndex: `{lineIndex,ownerKey,personIdentity,spanIndex,startsAt,endsAt,timeZone}`. UTC strings canonical millisecondsZ from accepted normalized spans. No economics/user session/extra private snapshots copied. Certificate canonical=constructor::text and certificate.digest=SHA256 owncanonical; boundsDigest inside separately matches V.digest. legacy_person occupancy origin_id=certificate.id, certificate_id=same, origin_version_id=V.id, origin_line_index=constructor lineIndex, kind=person/quantity1/noresource-window. Native equality includes all fields. Company checks include these ranges by stable vendor identity for all kinds even when live source no longer exists.

`legacy_calendar_bounds_activate(p_version uuid,p_actor uuid,p_session uuid,p_policy text) RETURNS uuid VOLATILE` validates current actor/whole source/all current receipts/time/person/complete graph, creates native event/resolution_holders/certificate/cartesian legacy rows and publishes head in one TX; returns event UUID. Domain first prepares scope/re-auth/CAS/sourceFingerprint+digest, then calls this function and safeprojects; never invents event/cert JSON. Same already-effective current version after valid current head/actor checks returns existing event with no new certificate/revision. Supersession releases prior active rows only with matching full newly agreed version/native one-way proof and retains all old rows. No money/allocation/DAY writes.

Proposal row details: H.day_version_id = captured inventory holder_snapshot #>>'{dayScope,version,id}' (/1 NULL), not a guessed current head; native equality checks captured exact snapshot. Each declaredperson scope.context_material = whole exact `legacy_calendar_bounds_known_person_scope(vendor)` snapshot JSON (identities/unknownOrigins); this represents conservative observed context, not factual assignment. `legacy_calendar_bounds_span_original_date(p_source uuid,p_holder uuid,p_span jsonb) RETURNS date STABLE`: source DAY original_date if source has actual DAY; app_root whole_day only unique proven actual ownDAY matching selected local start date, never current event date. Manual p_holderNULL; explicit app_root with no unique originalDATE returnsNULL. H row inserted before span helper call; parent source/inventory snapshot already verified. Whole-day NULL originaldate refuses; explicit preserves nullable originaldate separately.

Private view readiness addition: `{requiredReceipts,acceptedReceipts,canAccept,canActivate,hasStaleReceipts}` safe counts from actual current valid proof, not array length guessed by client. Holder GET exposes both authorized parties' receipts of THIS holder; no otherholder receipt IDs/data. canAcceptfalse if immutable this-party receipt already exists; a stale session/policy receipt needs newproposal. canActivate uses native agreed(current serverpolicy)+fresh material/current actor; manual requiredReceipts0 with currentowner declaration. No autoaction from ready=true.


## D12. Implementation-review corrections (same full371, no scope reduction)

- Native `legacy_calendar_bounds_locate(seed)` includes deterministic parent maps in addition to closed ID/key arrays. First prepare compares the whole before/after native object, including owners/resource and staff parents, after waits. TS nested checks allow own changes but never acquire new earlier parents. Original wedding fanout includes empty slots, unassigned offer requests and selected/shortlisted companies before the fixed affected-person set is frozen.
- `legacy_calendar_bounds_inserted_in_transaction(tableName,id)` accepts only fixed-table actual AFTER INSERT births recorded by a native trigger in backend/tx-bound private temporary state. UPDATE xmin does not qualify. New early wedding/account/vendor/person/session parents still refuse. `legacy_calendar_bounds_record_birth()` registers children only; backfill does not manufacture births. Company first creation and soft withdrawal require the strongest full account pass directly; the existing `erase` lock mode is a lock choice only and performs no deletion.
- Owner editor holders additionally expose `originalDayOptions:string[]`; editor exposes `manualOriginalDayOptions:string[]`. Native `legacy_calendar_bounds_original_day_options(sourceId,dealId defaultNULL)` uses actual current DAY provenance only. Empty means unsupported/unknown; no event-date or browser-zone fallback. Original-day option is not itself consent or a time zone.
- New named native business rules are mapped at the HTTP boundary, including outer COMMIT: scope/scope_changed/source_changed→409, declaration→422, not_agreed/common resource conflict/unresolved person/company→409. Unexpected structural CHECK/FK failures remain integrity errors; no blanket23514 translation.
- Every saved private mutation reply binds actor userId/sessionId/current policyVersion as well as operation-specific current source/material/head state. A new session or policy cannot replay old accepted/readiness data. An already accepted token does not re-expire on exact authorized response-loss replay. Actual owner has performer precedence when also a couple member; a different human/session must supply the customer receipt.
- Native `legacy_calendar_bounds_assert_date_booking(vendorId,dealId defaultNULL)` fences legacy DATE acquisition when retained accepted company ranges or other-company common occupancy/unknown obligations of its known people cannot be safely represented without explicit UTC bounds. There is no invented time zone. Raw genuinely new DAY/new financial commitment transitions use the same guard; unchanged observations, cancellation and terminal retention do not become new promises. Actual resource commitment takes its resource proof path. Existing resources-policy/live-allocation refusal is preserved. Removing a manual DATE never releases retained certificates.
- Association INSERT/acceptance/resource/duty/owner observation participates in the same stable-person and native scope protocol. Native NOWAIT applies to explicit requested row locks, not a claim about initial tuple/RI/unique/exclusion waits. Raw initial-commit witness preconditions match the native constructor, including absence of historical DAY/adoption and current exact agreed terms/plan/policy/real two-party receipts.

These are SOURCE interface corrections from independent review. They require current native INSERT-versus-UPDATE, post-wait, cross-company association/DAY, replay and outer-COMMIT controls before acceptance. Old REFUSE/FAILED and applied migrations remain preserved;372–374 stay separate.


## D13. DATE mutex constructor provenance (25.10.2026)

Native full-backend regression exposed a distinction between the existing physical vendor mutex and an explicit DATE constructor. The full94 safety prefix must retain old signed X176387 serialization without manufacturing an exact DATE group. A transaction-local ON COMMIT DROP registry records pre-acquisition intent by the actual signed mutex key, current backend and transaction. Repeated safety acquisition cannot promote false intent; an explicit old constructor marks true on both successful exits. Unknown raw legacy rows remain conservative. No business rows, money, counters, DATE values, human receipts or existing holder/final guards are rewritten.

Closed exception to earlier blanket old-function preservation: only `legacy_day_lock_vendors(uuid[])` (two successful explicit-intent notes) and `legacy_day_discover_new()` (constructor-intent predicate) receive exact literal forward CREATE OR REPLACE corrections in new94. All87–93 migration files and every other old function body remain immutable. Exact native old definitions/prosrc and metadata are verified before94 DDL; each correction preserves the full pg_proc row except prosrc, including OID, owner and ACL. Empty DOWN first passes the unchanged evidence refusal, restores the two exact old definitions, then drops the57 own94 functions. Populated DOWN must refuse and preserve all rows/catalogue. No DROP/reCREATE of either old function, generic body normalization or skipped catalogue comparison.

New native internal VOLATILE helpers: `legacy_calendar_bounds_note_day_mutex(uuid[],boolean)` and `legacy_calendar_bounds_discovery_locked(uuid)`. Full sorted company/person/resource prefix, old signed advisory ordering, raw NOWAIT branch and post-wait re-location remain required. A manual advisory lock taken after a false safety marker remains unknown until the actual explicit constructor runs. The private registry is internal protocol state, not a defence against a privileged database administrator.

SOURCE candidate C5F1B092186C85C885D159CB8476D3A7AE3EE8A8D84ADBD1992DD75AE9B96764 has independent SOURCE review96191DF30EA189F7D5A13F8849099A568086ADAB8782DE747FC2E537EC7C46E3 and exact whole inverse to888F. This appendix does not declare native acceptance. Required gates include old DATE regressions, real exact-head positives and missing-holder negatives, repeated/same-statement visibility, signed multi-vendor union and hash collision, SAVEPOINT/exception rollback, pooled next transaction, current ACL/races, whole raw money/history/counter preservation, empty/repeat/preserving migration drill and full371 delivery.372–374 remain separate OPEN.


## D14. Financial capability и semantic orphan scrub interface (26.10.2026)

TypeScript internal export:
prepareCalendarFinancialDraft(client: Queryable, input: Pick<LegacyCalendarScopeInput,'weddingIds'|'vendorIds'|'actor'>): Promise<void>.
Ровно одна wedding, одна vendor, current actor; никакого mode/profile из wire. Отдельный private financialDraftPrepared cache keyed by same client + actual PID/TX stamp. Full prepared cache и этот cache не являются взаимозаменяемыми; full→draft и draft→full в той же TX throw calendar_scope_changed409. Для operational action — fresh TX.

Lock/read interface: nonlocking locate только actual local financial scope одной свадьбы; weddings→requests→deals→slots→order/commitment heads→sorted accounts SHARE→session/current consent/member→vendor/policy SHARE, затем postwait parents/owner validation. Exact first financial lock SQL: select id from weddings where id=any($1::uuid[]) order by id for update. Никаких новых native profile columns/GUC/availability DTO или DAY/occupancy permission. Native inserted_in_transaction разрешает только собственные финансовые children, не чужие новые account/vendor/owner. Existing resource-order current ACL/slot/source/package/version/quote/replay contract неизменён.

Ровно две новые own94 функции C6:
- legacy_calendar_bounds_person_orphan(p_person uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE.
- legacy_calendar_bounds_scrub_erased_person(p_person uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE.

person_orphan — закрытый predicate actual absence + needed references/person-link UUIDs по reviewed24table list. scrub — internal native semantic routine, не HTTP permission/consent и не native proof, что DELETE совершил конкретный caller. Root eraseUser вызывает после actual DELETE users и DAY cleanup в той же full erase TX; повторное отсутствующее стирание не начинает новый inverse lock path. require_scope(mode erase) перед свежим VOLATILE orphan read; raw fallback NOWAIT не изображает preheld prefix.

scrub допускает только детерминированный SHA256('legacy-calendar-erased-person/1:'+oldUUID), первые32hex→UUID. Прежде update owner links, затем ровно1 person key; нет DELETE/ON CONFLICT merge. Collision/null/live user/needed current или historical identity — отказ/retention по точному native return/constraint contract. Existing protect_legacy_calendar_person_link получает только exact semantic person_identity UPDATE exception; прочие fields/immutable histories защищены. Не добавляется global key trigger и не заявляется baseline raw-key hardening.

Schema tables/columns/FKs/enums/triggers, financial writes, native origin/mirror/boundary/COR2 не меняются. OWN_FUNCTIONS current array=старый57 ordered prefix+ровно2 suffix, всего59; current C6 migration pin023FFCD77A29A94AEF26974B5686ADBDF53BB63B515684B6E2DC21391349B697. Empty DOWN restores literal oldCOR2 перед DROP own59; previous evidence refusal unchanged. Historical schema93 inputs и C5 proof нельзя переписывать. Full-contract D14 semantics и все full371/currentC6 acceptance gates применяются; ни этот appendix, ни Source review не являются runtime acceptance.
