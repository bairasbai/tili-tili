/* FULL371 forward schema94: per-holder bounds, real agreements and common occupancy.
 * Input: c371-schema-interface.md 14F7A5914BFB45444078E65CFBBC0546552996B97C0F641741F189180E7CA79D (D12).
 * Only the two literal old DATE constructor functions receive forward COR; no business rows/counters change.
 * Revision of7CCAC508; exact original retained in migration94-7CCAC508-SOURCE-BEFORE-REVIEW.raw.cjs.
 * Native-fix revision of45EE98A1; frozen source retained in migration94-45EE98A1-SOURCE-BEFORE-NATIVE-FIX.raw.cjs.
 */
const LEGACY_DAY_CORRECTIONS = [{"signature":"legacy_day_lock_vendors(uuid[])","oldDefinition":"CREATE OR REPLACE FUNCTION public.legacy_day_lock_vendors(vendors uuid[])\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\n    declare k integer; highest bigint; new_keys integer[];\n    begin\n      if vendors is null or array_position(vendors,null) is not null then\n        raise exception 'Exact vendor union required' using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      select array_agg(key order by key) into new_keys from\n        (select distinct hashtext(id::text) key from unnest(vendors) id\n          where not legacy_day_vendor_locked(id)) keys;\n      if new_keys is null then return; end if;\n      select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)\n        into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()\n          and granted and classid=176387 and objsubid=2;\n      if highest is not null and (new_keys[1]<highest or\n        exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or\n        exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then\n        raise exception 'Nested DATE scope cannot extend a written vendor union'\n          using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;\n    end $function$\n","oldProsrc":"\n    declare k integer; highest bigint; new_keys integer[];\n    begin\n      if vendors is null or array_position(vendors,null) is not null then\n        raise exception 'Exact vendor union required' using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      select array_agg(key order by key) into new_keys from\n        (select distinct hashtext(id::text) key from unnest(vendors) id\n          where not legacy_day_vendor_locked(id)) keys;\n      if new_keys is null then return; end if;\n      select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)\n        into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()\n          and granted and classid=176387 and objsubid=2;\n      if highest is not null and (new_keys[1]<highest or\n        exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or\n        exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then\n        raise exception 'Nested DATE scope cannot extend a written vendor union'\n          using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;\n    end ","newDefinition":"CREATE OR REPLACE FUNCTION public.legacy_day_lock_vendors(vendors uuid[])\n RETURNS void\n LANGUAGE plpgsql\nAS $function$\n    declare k integer; highest bigint; new_keys integer[];\n    begin\n      if vendors is null or array_position(vendors,null) is not null then\n        raise exception 'Exact vendor union required' using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      select array_agg(key order by key) into new_keys from\n        (select distinct hashtext(id::text) key from unnest(vendors) id\n          where not legacy_day_vendor_locked(id)) keys;\n      if new_keys is null then\n        perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);\n        return;\n      end if;\n      select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)\n        into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()\n          and granted and classid=176387 and objsubid=2;\n      if highest is not null and (new_keys[1]<highest or\n        exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or\n        exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then\n        raise exception 'Nested DATE scope cannot extend a written vendor union'\n          using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;\n      perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);\n    end $function$\n","newProsrc":"\n    declare k integer; highest bigint; new_keys integer[];\n    begin\n      if vendors is null or array_position(vendors,null) is not null then\n        raise exception 'Exact vendor union required' using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      select array_agg(key order by key) into new_keys from\n        (select distinct hashtext(id::text) key from unnest(vendors) id\n          where not legacy_day_vendor_locked(id)) keys;\n      if new_keys is null then\n        perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);\n        return;\n      end if;\n      select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)\n        into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()\n          and granted and classid=176387 and objsubid=2;\n      if highest is not null and (new_keys[1]<highest or\n        exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or\n        exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then\n        raise exception 'Nested DATE scope cannot extend a written vendor union'\n          using errcode='23514',constraint='legacy_day_lock_order';\n      end if;\n      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;\n      perform public.legacy_calendar_bounds_note_day_mutex(vendors,true);\n    end ","metadata":{"provolatile":"v","prosecdef":false,"proleakproof":false,"proisstrict":false,"proretset":false,"proparallel":"u","proconfig":null,"prokind":"f","procost":100,"prorows":0,"support":"-","result":"void","lanname":"plpgsql","proacl":null,"comment":null}},{"signature":"legacy_day_discover_new()","oldDefinition":"CREATE OR REPLACE FUNCTION public.legacy_day_discover_new()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\n    declare wed uuid;\n    begin\n      if NEW.source<>'deal' or not legacy_day_vendor_locked(NEW.vendor_id) then return NEW; end if;\n      wed:=legacy_day_group_wedding(NEW.id);\n      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)\n        values(NEW.id,NEW.vendor_id,NEW.date,wed,case when wed is null then 'opaque' else 'exact' end,'{}'::uuid[],1);\n      return NEW;\n    end $function$\n","oldProsrc":"\n    declare wed uuid;\n    begin\n      if NEW.source<>'deal' or not legacy_day_vendor_locked(NEW.vendor_id) then return NEW; end if;\n      wed:=legacy_day_group_wedding(NEW.id);\n      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)\n        values(NEW.id,NEW.vendor_id,NEW.date,wed,case when wed is null then 'opaque' else 'exact' end,'{}'::uuid[],1);\n      return NEW;\n    end ","newDefinition":"CREATE OR REPLACE FUNCTION public.legacy_day_discover_new()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\n    declare wed uuid;\n    begin\n      if NEW.source<>'deal' or not public.legacy_calendar_bounds_discovery_locked(NEW.vendor_id) then return NEW; end if;\n      wed:=legacy_day_group_wedding(NEW.id);\n      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)\n        values(NEW.id,NEW.vendor_id,NEW.date,wed,case when wed is null then 'opaque' else 'exact' end,'{}'::uuid[],1);\n      return NEW;\n    end $function$\n","newProsrc":"\n    declare wed uuid;\n    begin\n      if NEW.source<>'deal' or not public.legacy_calendar_bounds_discovery_locked(NEW.vendor_id) then return NEW; end if;\n      wed:=legacy_day_group_wedding(NEW.id);\n      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)\n        values(NEW.id,NEW.vendor_id,NEW.date,wed,case when wed is null then 'opaque' else 'exact' end,'{}'::uuid[],1);\n      return NEW;\n    end ","metadata":{"provolatile":"v","prosecdef":false,"proleakproof":false,"proisstrict":false,"proretset":false,"proparallel":"u","proconfig":null,"prokind":"f","procost":100,"prorows":0,"support":"-","result":"trigger","lanname":"plpgsql","proacl":null,"comment":null}}]
function legacyDayCorrectionSQL(forward, replace) {
  const rows = LEGACY_DAY_CORRECTIONS.map(row => ({
    signature: row.signature, definition: forward ? row.oldDefinition : row.newDefinition,
    prosrc: forward ? row.oldProsrc : row.newProsrc, metadata: row.metadata,
    replacementDefinition: forward ? row.newDefinition : row.oldDefinition,
    replacementProsrc: forward ? row.newProsrc : row.oldProsrc,
  }))
  const json = JSON.stringify(rows)
  if (json.includes('$legacy_day94_data$') || json.includes('$legacy_day94_verify$')) throw new Error('Unexpected DATE correction delimiter')
  return String.raw`
    do $legacy_day94_verify$
    declare expected jsonb; native regprocedure; actual jsonb; saved jsonb;
    begin
      for expected in select value from pg_catalog.jsonb_array_elements($legacy_day94_data$__DATA__$legacy_day94_data$::jsonb) loop
        native:=pg_catalog.to_regprocedure('public.'||(expected->>'signature'));
        select pg_catalog.jsonb_build_object(
          'provolatile',p.provolatile,'prosecdef',p.prosecdef,'proleakproof',p.proleakproof,
          'proisstrict',p.proisstrict,'proretset',p.proretset,'proparallel',p.proparallel,
          'proconfig',p.proconfig,'prokind',p.prokind,'procost',p.procost,'prorows',p.prorows,
          'support',p.prosupport::regproc::text,'result',p.prorettype::regtype::text,
          'lanname',l.lanname,'proacl',p.proacl,'comment',pg_catalog.obj_description(p.oid,'pg_proc'))
          into actual from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang where p.oid=native;
        if native is null or actual is distinct from expected->'metadata'
          or pg_catalog.pg_get_functiondef(native) is distinct from expected->>'definition'
          or (select p.prosrc from pg_catalog.pg_proc p where p.oid=native) is distinct from expected->>'prosrc' then
          raise exception 'Applied DATE function differs from the literal admitted definition: %',expected->>'signature'
            using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
        end if;
        if __APPLY__ then
          select pg_catalog.to_jsonb(p)-'prosrc' into saved from pg_catalog.pg_proc p where p.oid=native;
          execute expected->>'replacementDefinition';
          select pg_catalog.to_jsonb(p)-'prosrc' into actual from pg_catalog.pg_proc p where p.oid=native;
          if actual is distinct from saved
            or pg_catalog.pg_get_functiondef(native) is distinct from expected->>'replacementDefinition'
            or (select p.prosrc from pg_catalog.pg_proc p where p.oid=native) is distinct from expected->>'replacementProsrc' then
            raise exception 'DATE correction changed metadata or unexpected body: %',expected->>'signature'
              using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
          end if;
        end if;
      end loop;
    end $legacy_day94_verify$;
  `.replace('__DATA__', () => json).replace('__APPLY__', replace ? 'true' : 'false')
}

const OWN_FUNCTIONS = [
  'legacy_calendar_bounds_fail(text,text)','legacy_calendar_bounds_fingerprint(jsonb)','legacy_calendar_bounds_ids(jsonb)',
  'legacy_calendar_bounds_wall(text)','legacy_calendar_bounds_instant(text)','legacy_calendar_bounds_span_valid(jsonb,date)',
  'legacy_calendar_bounds_span_set_valid(jsonb,date)','legacy_calendar_bounds_covers(jsonb,timestamptz,timestamptz)',
  'legacy_calendar_bounds_engagement_covered(uuid,uuid,text,jsonb)','legacy_calendar_bounds_known_person_scope(uuid)',
  'legacy_calendar_bounds_related(uuid)','legacy_calendar_bounds_locate(jsonb)','legacy_calendar_bounds_pin_scope(jsonb,boolean,boolean)',
  'legacy_calendar_bounds_prepare_scope(jsonb)','legacy_calendar_bounds_require_scope(jsonb)','legacy_calendar_bounds_source_material(uuid)',
  'legacy_calendar_bounds_material(uuid,uuid,jsonb)','legacy_calendar_bounds_principal_current(uuid,uuid,uuid,text,uuid,uuid,text)',
  'legacy_calendar_bounds_span_json(legacy_calendar_bounds_spans)','legacy_calendar_bounds_complete(uuid)','legacy_calendar_bounds_agreed(uuid,text)',
  'legacy_calendar_bounds_original_date(uuid,uuid,jsonb)','legacy_calendar_bounds_span_original_date(uuid,uuid,jsonb)',
  'legacy_calendar_bounds_activation_material(uuid,text)','legacy_calendar_bounds_certificate_material(uuid,uuid)',
  'legacy_calendar_bounds_assert_certificate(uuid)','legacy_calendar_bounds_assert_mirror(uuid)','legacy_calendar_bounds_current_effect(uuid)',
  'legacy_calendar_bounds_assert_applied(uuid)','legacy_calendar_bounds_activate(uuid,uuid,uuid,text)',
  'legacy_calendar_bounds_span_set_for_holder(uuid,uuid,jsonb)','legacy_calendar_bounds_initial_current(uuid,uuid)',
  'legacy_calendar_bounds_assert_boundary(uuid,uuid,jsonb,uuid)','legacy_calendar_bounds_assert_person_links(uuid[],uuid[])',
  'legacy_calendar_bounds_prepare_initial_commit(uuid,uuid,uuid,uuid,bigint,uuid,uuid,text)','legacy_calendar_bounds_assert_initial(uuid)',
  'protect_legacy_calendar_bounds_history()','protect_legacy_calendar_bounds_certificate()',
  'legacy_calendar_bounds_release_valid(resource_occupancy,uuid,text)','protect_resource_occupancy_origin()',
  'maintain_resource_occupancy_mirror()','legacy_calendar_bounds_allocation_prefix()','protect_legacy_calendar_person_link()',
  'legacy_calendar_bounds_observe_link(uuid,uuid,text,uuid)','legacy_calendar_bounds_observe()',
  'check_legacy_calendar_bounds_complete()','legacy_calendar_bounds_cancel_trace()',
  'legacy_calendar_bounds_inserted_in_transaction(text,uuid)','legacy_calendar_bounds_record_birth()',
  'legacy_calendar_bounds_original_day_options(uuid,uuid)',
  'legacy_calendar_bounds_initial_preconditions(uuid,uuid,uuid,uuid,uuid,bigint,uuid,uuid,text,text)',
  'legacy_calendar_bounds_association_prefix()','legacy_calendar_bounds_assert_date_booking(uuid,uuid)',
  'legacy_calendar_bounds_date_prefix()','legacy_calendar_bounds_financial_prefix()',
  'legacy_calendar_bounds_note_day_mutex(uuid[],boolean)','legacy_calendar_bounds_discovery_locked(uuid)',
  'legacy_calendar_bounds_person_orphan(uuid)','legacy_calendar_bounds_scrub_erased_person(uuid)'
]
exports.up = pgm => {
  // Reject unexpected old bodies/metadata before any94 DDL.
  pgm.sql(legacyDayCorrectionSQL(true, false))
  pgm.sql(String.raw`
    create table legacy_calendar_bounds_versions(
      id uuid primary key,source_id uuid not null references legacy_calendar_sources(id) on delete cascade,
      inventory_version_id uuid not null,version bigint not null check(version>0),previous_version_id uuid,
      wedding_id uuid references weddings(id) on delete cascade,company_id uuid references vendors(id) on delete cascade,
      source_revision bigint not null check(source_revision>=0),inventory_revision bigint not null check(inventory_revision>0),
      inventory_digest text not null,source_fingerprint text not null,declaration jsonb not null,
      canonical text not null,digest text not null,staffing_completeness text not null,
      association_fingerprint text not null,created_by uuid references users(id) on delete set null,
      created_session_id uuid references sessions(id) on delete set null,policy_version text not null,
      created_at timestamptz not null default clock_timestamp(),
      unique(source_id,version),unique(source_id,id),unique(source_id,id,inventory_version_id),unique(id,inventory_version_id),
      foreign key(source_id,inventory_version_id) references legacy_calendar_versions(source_id,id) deferrable initially deferred,
      foreign key(source_id,previous_version_id) references legacy_calendar_bounds_versions(source_id,id) deferrable initially deferred,
      check((wedding_id is null)<>(company_id is null)),check((version=1)=(previous_version_id is null)),
      check(staffing_completeness in('unknown','declared_complete')),
      check(jsonb_typeof(declaration)='object' and canonical::jsonb::text=canonical),
      check(digest=encode(pg_catalog.sha256(convert_to(canonical,'UTF8')),'hex')),
      check(inventory_digest~'^[0-9a-f]{64}$' and source_fingerprint~'^[0-9a-f]{64}$' and association_fingerprint~'^[0-9a-f]{64}$')
    );
    create table legacy_calendar_bounds_holders(
      id uuid primary key,source_id uuid not null,bounds_version_id uuid not null,inventory_version_id uuid not null,
      wedding_id uuid not null,deal_id uuid not null,slot_id uuid not null,expected_order_version bigint not null check(expected_order_version>0),
      day_version_id uuid,outcome text not null,closure_reason text,holder_snapshot jsonb not null,holder_fingerprint text not null,
      unique(bounds_version_id,wedding_id,deal_id),unique(bounds_version_id,id),unique(source_id,bounds_version_id,id),
      foreign key(source_id,bounds_version_id,inventory_version_id) references legacy_calendar_bounds_versions(source_id,id,inventory_version_id) on delete cascade,
      foreign key(inventory_version_id,wedding_id,deal_id) references legacy_calendar_version_holders(version_id,wedding_id,deal_id) deferrable initially deferred,
      check(outcome in('finite','calendar_closed')),
      check((outcome='calendar_closed' and closure_reason='no_remaining_calendar_engagement') or(outcome='finite' and closure_reason is null)),
      check(holder_fingerprint=encode(pg_catalog.sha256(convert_to(holder_snapshot::text,'UTF8')),'hex'))
    );
    create table legacy_calendar_bounds_spans(
      bounds_version_id uuid not null references legacy_calendar_bounds_versions(id) on delete cascade,
      owner_key uuid not null,span_index integer not null check(span_index>=0),holder_id uuid,owner_kind text not null,
      original_date date,span_mode text not null,local_starts_at text not null,local_ends_at text not null,
      supplied_starts_at text not null,supplied_ends_at text not null,time_zone text not null,
      starts_at timestamptz not null,ends_at timestamptz not null,coverage jsonb not null,
      primary key(bounds_version_id,owner_key,span_index),
      foreign key(bounds_version_id,holder_id) references legacy_calendar_bounds_holders(bounds_version_id,id) deferrable initially deferred,
      check((owner_kind='holder' and holder_id is not null and holder_id=owner_key) or(owner_kind='manual' and holder_id is null and owner_key=bounds_version_id)),
      check(span_mode in('explicit','whole_local_day')),
      check(isfinite(starts_at) and isfinite(ends_at) and starts_at<ends_at and date_trunc('milliseconds',starts_at)=starts_at and date_trunc('milliseconds',ends_at)=ends_at)
    );
    create table legacy_calendar_bounds_person_scope(
      bounds_version_id uuid not null references legacy_calendar_bounds_versions(id) on delete cascade,
      person_identity uuid not null,context_material jsonb not null,primary key(bounds_version_id,person_identity)
    );
    create table legacy_calendar_bounds_receipts(
      id uuid primary key,source_id uuid not null,bounds_version_id uuid not null,holder_id uuid not null,
      party text not null check(party in('customer','performer')),user_id uuid references users(id) on delete set null,
      session_id uuid references sessions(id) on delete set null,policy_version text not null,
      purpose text not null check(purpose='calendar-bounds-read'),digest text not null,read_claims jsonb not null,
      proof_hash text not null check(proof_hash~'^[0-9a-f]{64}$'),read_iat bigint not null,read_exp bigint not null,
      accepted_at timestamptz not null default clock_timestamp(),unique(bounds_version_id,holder_id,party),
      foreign key(source_id,bounds_version_id,holder_id) references legacy_calendar_bounds_holders(source_id,bounds_version_id,id) on delete cascade,
      check(read_exp>read_iat and read_exp-read_iat<=600 and read_iat>=0 and read_exp<=9007199254740991)
    );
    create table legacy_calendar_resolution_events(
      id uuid primary key,source_id uuid not null references legacy_calendar_sources(id) on delete cascade deferrable initially deferred,
      bounds_version_id uuid,action text not null,previous_event_id uuid,
      actor_id uuid references users(id) on delete set null,session_id uuid references sessions(id) on delete set null,
      policy_version text,reason text,before_fingerprint text,after_fingerprint text,material jsonb not null,
      created_at timestamptz not null default clock_timestamp(),transaction_id bigint not null default txid_current(),backend_pid integer not null default pg_backend_pid(),
      unique(source_id,id),unique(source_id,bounds_version_id,id),
      foreign key(source_id,bounds_version_id) references legacy_calendar_bounds_versions(source_id,id) deferrable initially deferred,
      foreign key(source_id,previous_event_id) references legacy_calendar_resolution_events(source_id,id) deferrable initially deferred,
      check(action in('activate','holder_cancelled','source_unavailable','source_stale','superseded','negotiation_committed'))
    );
    create table legacy_calendar_resolution_holders(
      event_id uuid not null,source_id uuid not null,bounds_version_id uuid not null,holder_id uuid not null,outcome text not null,material jsonb not null,
      primary key(event_id,holder_id),
      foreign key(source_id,bounds_version_id,event_id) references legacy_calendar_resolution_events(source_id,bounds_version_id,id) on delete cascade,
      foreign key(source_id,bounds_version_id,holder_id) references legacy_calendar_bounds_holders(source_id,bounds_version_id,id) deferrable initially deferred
    );
    create table legacy_calendar_bounds_heads(
      source_id uuid primary key references legacy_calendar_sources(id) on delete cascade,revision bigint not null default 0 check(revision>=0),
      proposed_version_id uuid,effective_event_id uuid,proposed_version bigint not null default 0 check(proposed_version>=0),
      updated_at timestamptz not null default clock_timestamp(),check((proposed_version=0)=(proposed_version_id is null)),
      foreign key(source_id,proposed_version_id) references legacy_calendar_bounds_versions(source_id,id) deferrable initially deferred,
      foreign key(source_id,effective_event_id) references legacy_calendar_resolution_events(source_id,id) deferrable initially deferred
    );
    create table legacy_calendar_person_links(
      id uuid primary key default gen_random_uuid(),vendor_identity uuid not null,person_identity uuid,
      origin_kind text not null check(origin_kind in('owner','accepted_staff','person_resource','duty','bounds_certificate')),
      origin_id uuid not null,unknown_identity boolean not null,observed_at timestamptz not null default clock_timestamp(),
      unique nulls not distinct(vendor_identity,person_identity,origin_kind,origin_id),check(unknown_identity=(person_identity is null))
    );
    create index legacy_calendar_person_links_person on legacy_calendar_person_links(person_identity,vendor_identity);
    create table resource_occupancy_origin_certificates(
      id uuid primary key,scope_kind text not null check(scope_kind in('app','manual')),
      source_identity uuid not null,vendor_identity uuid not null,bounds_version_identity uuid not null unique,
      activation_event_identity uuid not null,app_wedding_id uuid references weddings(id) on delete cascade,
      live_source_id uuid references legacy_calendar_sources(id) on delete set null,
      live_vendor_id uuid references vendors(id) on delete set null,
      live_bounds_version_id uuid references legacy_calendar_bounds_versions(id) on delete set null,
      live_activation_event_id uuid references legacy_calendar_resolution_events(id) on delete set null,
      digest text not null,canonical text not null,created_at timestamptz not null default clock_timestamp(),
      check((scope_kind='app')=(app_wedding_id is not null)),check(canonical::jsonb::text=canonical),
      check(digest=encode(pg_catalog.sha256(convert_to(canonical,'UTF8')),'hex'))
    );
    create index resource_occupancy_certificate_vendor on resource_occupancy_origin_certificates(vendor_identity);
    create table resource_occupancy(
      id uuid primary key,origin_kind text not null check(origin_kind in('commitment','legacy_person')),
      origin_id uuid not null,origin_version_id uuid not null,origin_line_index integer not null check(origin_line_index>=0),
      certificate_id uuid references resource_occupancy_origin_certificates(id) on delete cascade,
      allocation_id uuid references resource_allocations(id) on delete cascade,
      vendor_identity uuid not null,kind text not null check(kind in('person','equipment','capacity')),conflict_identity uuid not null,
      resource_id uuid references vendor_resources(id) on delete restrict,capacity_window_id uuid references resource_capacity_windows(id) on delete restrict,
      quantity integer not null check(quantity>0),occupied_starts_at timestamptz not null,occupied_ends_at timestamptz not null,
      enforcement text not null check(enforcement in('exclusive','legacy_barrier')),released_at timestamptz,release_reason text,
      release_event_id uuid references legacy_calendar_resolution_events(id) on delete set null,
      unique(origin_kind,origin_id,origin_line_index),
      check((origin_kind='commitment' and allocation_id=origin_id and certificate_id is null and enforcement='exclusive') or
        (origin_kind='legacy_person' and allocation_id is null and certificate_id=origin_id and kind='person' and quantity=1 and resource_id is null and capacity_window_id is null and enforcement='legacy_barrier')),
      check(isfinite(occupied_starts_at) and isfinite(occupied_ends_at) and occupied_starts_at<occupied_ends_at),
      check((released_at is null and release_reason is null) or(released_at is not null and release_reason is not null)),
      exclude using gist(kind with =,conflict_identity with =,tstzrange(occupied_starts_at,occupied_ends_at,'[)') with &&)
        where(released_at is null and enforcement='exclusive' and kind in('person','equipment'))
    );
    create index resource_occupancy_live_person on resource_occupancy(kind,conflict_identity) where released_at is null;
    create index resource_occupancy_live_vendor on resource_occupancy(vendor_identity) where released_at is null;
    create table legacy_calendar_initial_commit_witnesses(
      id uuid primary key,wedding_id uuid not null references weddings(id) on delete cascade,deal_id uuid not null,vendor_id uuid not null,
      terms_id uuid not null,plan_revision_id uuid not null,policy_revision bigint not null check(policy_revision>0),
      actor_id uuid not null,session_id uuid not null,policy_version text not null,
      pending_state text not null check(pending_state in('candidate','contacted','negotiating')),
      recorded_at timestamptz not null default clock_timestamp(),transaction_id bigint not null default txid_current(),backend_pid integer not null default pg_backend_pid(),
      unique(wedding_id,deal_id,transaction_id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade deferrable initially deferred,
      foreign key(wedding_id,deal_id,terms_id) references deal_terms_versions(wedding_id,deal_id,id) deferrable initially deferred,
      foreign key(wedding_id,deal_id,plan_revision_id) references deal_resource_plan_versions(wedding_id,deal_id,id) deferrable initially deferred
    );

    create function legacy_calendar_bounds_fail(message text,rule text default 'legacy_calendar_bounds_complete') returns void language plpgsql as $$
    begin raise exception '%',message using errcode='23514',constraint=rule; end $$;
    create function legacy_calendar_bounds_fingerprint(material jsonb) returns text language sql immutable strict as $$
      select encode(pg_catalog.sha256(convert_to(material::text,'UTF8')),'hex')
    $$;
    create function legacy_calendar_bounds_ids(value jsonb) returns uuid[] language plpgsql immutable as $$
    declare result uuid[];
    begin
      if value is null then return '{}'::uuid[]; end if;
      if jsonb_typeof(value)<>'array' or exists(select 1 from jsonb_array_elements(value) x where jsonb_typeof(x)<>'string'
        or x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
        perform legacy_calendar_bounds_fail('Exact UUID array required','legacy_calendar_bounds_scope'); end if;
      select legacy_day_uuid_set(array_agg(x::uuid)) into result from jsonb_array_elements_text(value) x;
      return coalesce(result,'{}'::uuid[]);
    end $$;
    create function legacy_calendar_bounds_wall(value text) returns timestamp language plpgsql immutable as $$
    declare result timestamp;
    begin
      if value is null or value~'[[:space:]]' or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?$'
        or substring(value,1,4)='0000' or substring(value,12,2)::int>23 or substring(value,15,2)::int>59 or substring(value,18,2)::int>59 then return null; end if;
      result:=value::timestamp;
      if not isfinite(result) or extract(year from result) not between 1 and 9999 then return null; end if;
      return result;
    exception when others then return null;
    end $$;
    create function legacy_calendar_bounds_instant(value text) returns timestamptz language plpgsql immutable as $$
    declare result timestamptz; tail text; base text; minutes int;
    begin
      if value is null or value !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then return null; end if;
      tail:=case when right(value,1)='Z' then 'Z' else right(value,6) end;
      base:=left(value,length(value)-length(tail));
      if legacy_calendar_bounds_wall(base) is null or tail='-00:00' then return null; end if;
      minutes:=0;
      if tail<>'Z' then
        if substring(tail,2,2)::int>23 or substring(tail,5,2)::int>59 then return null; end if;
        minutes:=(substring(tail,2,2)::int*60+substring(tail,5,2)::int)*case when left(tail,1)='-' then -1 else 1 end;
      end if;
      result:=(legacy_calendar_bounds_wall(base)-make_interval(mins=>minutes)) at time zone 'UTC';
      if not isfinite(result) or extract(year from result at time zone 'UTC') not between 1 and 9999 then return null; end if;
      return result;
    exception when others then return null;
    end $$;
    create function legacy_calendar_bounds_span_valid(p_span jsonb,p_original_date date) returns boolean language plpgsql stable as $$
    declare a timestamptz;b timestamptz; la timestamp;lb timestamp; zone text; expected text[];
    begin
      expected:=array['coverage','endsAt','localEndsAt','localStartsAt','spanMode','startsAt','suppliedEndsAt','suppliedStartsAt','timeZone'];
      if jsonb_typeof(p_span)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(p_span) k) is distinct from expected
        or p_span->>'spanMode' not in('explicit','whole_local_day') or p_span->'coverage'<>'{"preparation":true,"travel":true,"handover":true,"returns":true,"remainingWork":true}'::jsonb then return false; end if;
      if exists(select 1 from jsonb_each(p_span) x where x.key<>'coverage' and jsonb_typeof(x.value)<>'string') then return false; end if;
      zone:=p_span->>'timeZone';
      if length(zone) not between 1 and 100 or zone~'\s|^[+-]' or not exists(select 1 from pg_timezone_names where name=zone) then return false; end if;
      a:=legacy_calendar_bounds_instant(p_span->>'suppliedStartsAt');b:=legacy_calendar_bounds_instant(p_span->>'suppliedEndsAt');
      la:=legacy_calendar_bounds_wall(p_span->>'localStartsAt');lb:=legacy_calendar_bounds_wall(p_span->>'localEndsAt');
      if a is null or b is null or la is null or lb is null or a>=b or
        to_char(a at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from p_span->>'startsAt' or
        to_char(b at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') is distinct from p_span->>'endsAt' or
        to_char(la,'YYYY-MM-DD"T"HH24:MI:SS.MS') is distinct from p_span->>'localStartsAt' or
        to_char(lb,'YYYY-MM-DD"T"HH24:MI:SS.MS') is distinct from p_span->>'localEndsAt' or
        a at time zone zone is distinct from la or b at time zone zone is distinct from lb then return false; end if;
      if p_span->>'spanMode'='whole_local_day' and (p_original_date is null or la::date<>p_original_date
        or lb::date<>p_original_date+1 or la::time<>'00:00:00'::time or lb::time<>'00:00:00'::time) then return false; end if;
      return true;
    exception when others then return false;
    end $$;
    create function legacy_calendar_bounds_span_set_valid(spans jsonb,original_date date) returns boolean language sql stable as $$
      select jsonb_typeof(spans)='array' and jsonb_array_length(spans) between 1 and 64
        and not exists(select 1 from jsonb_array_elements(spans) x where legacy_calendar_bounds_span_valid(x,original_date) is not true)
        and not exists(select 1 from jsonb_array_elements(spans) with ordinality a(x,n),jsonb_array_elements(spans) with ordinality b(x,n)
          where a.n<b.n and ((a.x->>'startsAt')::timestamptz>(b.x->>'startsAt')::timestamptz
            or tstzrange((a.x->>'startsAt')::timestamptz,(a.x->>'endsAt')::timestamptz,'[)') && tstzrange((b.x->>'startsAt')::timestamptz,(b.x->>'endsAt')::timestamptz,'[)')))
    $$;
    create function legacy_calendar_bounds_covers(spans jsonb,a timestamptz,b timestamptz) returns boolean language sql stable as $$
      select a is not null and b is not null and isfinite(a) and isfinite(b) and a<=b and case when a=b then
        exists(select 1 from jsonb_array_elements(spans) x where (x->>'startsAt')::timestamptz<=a and a<(x->>'endsAt')::timestamptz)
      else coalesce((select range_agg(tstzrange((x->>'startsAt')::timestamptz,(x->>'endsAt')::timestamptz,'[)')) @> tstzrange(a,b,'[)') from jsonb_array_elements(spans) x),false) end
    $$;
    create function legacy_calendar_bounds_engagement_covered(p_wedding uuid,p_deal uuid,p_outcome text,p_spans jsonb)
    returns boolean language plpgsql stable as $$
    declare item record;line jsonb;details jsonb;a timestamptz;b timestamptz;plan jsonb;
    begin
      if p_outcome not in('finite','calendar_closed') or jsonb_typeof(p_spans)<>'array' then return false; end if;
      select p.private_snapshot->'lines' into plan from deal_orders o left join deal_resource_plan_versions p on p.id=o.resource_plan_id
        where o.wedding_id=p_wedding and o.deal_id=p_deal;
      if not found then return false; end if;
      for item in select op.kind,op.details from order_parts op where op.wedding_id=p_wedding and op.deal_id=p_deal and op.cancelled_at is null loop
        if p_outcome='calendar_closed' then return false; end if;
        details:=item.details;
        if item.kind in('timed_service','appointment') then
          if exists(select 1 from unnest(array['setupMinutes','teardownMinutes','travelMinutes']) k
            where jsonb_typeof(details->k)<>'number' or details->>k !~ '^[0-9]+$' or (details->>k)::numeric>10080) then return false; end if;
          a:=legacy_calendar_bounds_instant(details->>'startsAt');b:=legacy_calendar_bounds_instant(details->>'endsAt');
          if a is null or b is null or a>=b then return false;end if;
          a:=a-make_interval(mins=>(details->>'setupMinutes')::int+(details->>'travelMinutes')::int);
          b:=b+make_interval(mins=>(details->>'teardownMinutes')::int+(details->>'travelMinutes')::int);
        elsif item.kind='supply' then
          a:=legacy_calendar_bounds_instant(details->>'windowStartsAt');b:=legacy_calendar_bounds_instant(details->>'windowEndsAt');
          if a is null or b is null or a>=b then return false;end if;
        elsif item.kind='rental' then a:=legacy_calendar_bounds_instant(details->>'handoverAt');b:=legacy_calendar_bounds_instant(details->>'returnAt');
        elsif item.kind='deliverable' then a:=legacy_calendar_bounds_instant(details->>'dueAt');b:=a;
        else return false; end if;
        if legacy_calendar_bounds_covers(p_spans,a,b) is not true then return false; end if;
      end loop;
      for line in select value from jsonb_array_elements(coalesce(plan,'[]')) loop
        a:=legacy_calendar_bounds_instant(line->>'occupiedStartsAt');b:=legacy_calendar_bounds_instant(line->>'occupiedEndsAt');
        if p_outcome='calendar_closed' or a is null or b is null or a>=b or legacy_calendar_bounds_covers(p_spans,a,b) is not true then return false; end if;
      end loop;
      for item in select occupied_starts_at a,occupied_ends_at b from resource_allocations where wedding_id=p_wedding and deal_id=p_deal and released_at is null loop
        if p_outcome='calendar_closed' or item.a is null or item.b is null or item.a>=item.b or legacy_calendar_bounds_covers(p_spans,item.a,item.b) is not true then return false; end if;
      end loop;
      return true;
    exception when others then return false;
    end $$;
  `)
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_known_person_scope(p_vendor_id uuid) returns jsonb language sql stable as $$
      with known as (
        select user_id person from vendors where id=p_vendor_id
        union select user_id from vendor_staff_members where vendor_id=p_vendor_id and accepted_at is not null and user_id is not null
        union select conflict_identity from vendor_resources where vendor_id=p_vendor_id and kind='person'
        union select person_identity from legacy_calendar_person_links where vendor_identity=p_vendor_id and person_identity is not null
      ), unknowns as (
        select 'accepted_staff'::text kind,m.id from vendor_staff_members m where m.vendor_id=p_vendor_id and m.accepted_at is not null
          and m.user_id is null and not exists(select 1 from vendor_resources r where r.staff_member_id=m.id and r.kind='person')
          and not exists(select 1 from legacy_calendar_person_links l where l.vendor_identity=m.vendor_id and l.origin_id=m.id and l.person_identity is not null)
        union select l.origin_kind,l.origin_id from legacy_calendar_person_links l where l.vendor_identity=p_vendor_id and l.unknown_identity
          and not exists(select 1 from legacy_calendar_person_links k where k.vendor_identity=l.vendor_identity and k.origin_kind=l.origin_kind and k.origin_id=l.origin_id and k.person_identity is not null)
      ) select jsonb_build_object('identities',coalesce((select jsonb_agg(person order by person) from known where person is not null),'[]'),
        'unknownOrigins',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'id',id) order by kind,id) from unknowns),'[]'))
    $$;
    create function legacy_calendar_bounds_related(p_source uuid) returns jsonb language plpgsql stable as $$
    declare source_ids uuid[]:=array[p_source];prior_source_ids uuid[];day_ids uuid[];deal_ids uuid[];wedding_ids uuid[];slot_ids uuid[];
    begin
      loop
        prior_source_ids:=source_ids;
        select legacy_day_uuid_set(array_agg(d)) into day_ids from legacy_calendar_sources s cross join lateral legacy_calendar_day_ids(s) d where s.id=any(source_ids);
        select legacy_day_uuid_set(array_agg(id)) into deal_ids from (
          select root_deal_id id from legacy_calendar_sources where id=any(source_ids) and root_deal_id is not null
          union select (h->>'dealId')::uuid from legacy_calendar_sources s cross join lateral jsonb_array_elements(legacy_calendar_current_inventory_material(s)->'holders') h where s.id=any(source_ids)
          union select k.deal_id from unnest(day_ids) d cross join lateral legacy_day_known_holders(d) k
          union select unnest(g.legacy_candidates) from legacy_day_groups g where g.day_id=any(day_ids)
        ) x;
        select legacy_day_uuid_set(source_ids||coalesce(array_agg(s.id),'{}')) into source_ids from legacy_calendar_sources s
          where s.root_deal_id=any(deal_ids) or s.day_id=any(day_ids);
        exit when source_ids=prior_source_ids;
        if cardinality(source_ids)>128 then perform legacy_calendar_bounds_fail('Related source scope exceeds limit','legacy_calendar_bounds_scope'); end if;
      end loop;
      select legacy_day_uuid_set(array_agg(id)) into wedding_ids from (
        select wedding_id id from legacy_calendar_sources where id=any(source_ids) and wedding_id is not null
        union select wedding_id from deals where id=any(deal_ids)
        union select wedding_id from legacy_day_groups where day_id=any(day_ids) and wedding_id is not null
      ) x;
      select legacy_day_uuid_set(array_agg(slot_id)) into slot_ids from deals where id=any(deal_ids);
      return jsonb_build_object('weddingIds',to_jsonb(wedding_ids),'dealIds',to_jsonb(deal_ids),'slotIds',to_jsonb(slot_ids),'dayIds',to_jsonb(day_ids),'sourceIds',to_jsonb(source_ids));
    end $$;
    create function legacy_calendar_bounds_locate(seed jsonb) returns jsonb language plpgsql stable as $$
    declare ow uuid[];w uuid[];v uuid[];pv uuid[];p uuid[];r uuid[];st uuid[];so uuid[];dy uuid[];d uuid[];sl uuid[];
      ac uuid[];se uuid[];req uuid[];win uuid[];al uuid[];extra uuid[];q record;ctx jsonb;result jsonb;parents jsonb;
      prior_v uuid[];prior_so uuid[];prior_r uuid[];prior_d uuid[];ctx_cache jsonb:='{}'::jsonb;
    begin
      if seed is null or jsonb_typeof(seed)<>'object' or exists(select 1 from jsonb_object_keys(seed) k where k<>all(array['weddingIds','vendorIds','personIds','resourceIds','sourceIds','actor','extraAccountIds','mode']))
        or coalesce(seed->>'mode','write') not in('write','erase') then perform legacy_calendar_bounds_fail('Invalid scope seed','legacy_calendar_bounds_scope'); end if;
      ow:=legacy_calendar_bounds_ids(seed->'weddingIds');w:=ow;pv:=legacy_calendar_bounds_ids(seed->'vendorIds');
      p:=legacy_calendar_bounds_ids(seed->'personIds');r:=legacy_calendar_bounds_ids(seed->'resourceIds');so:=legacy_calendar_bounds_ids(seed->'sourceIds');extra:=legacy_calendar_bounds_ids(seed->'extraAccountIds');
      if seed ? 'actor' and (jsonb_typeof(seed->'actor')<>'object' or
        (select array_agg(k order by k) from jsonb_object_keys(seed->'actor') k) is distinct from array['policyVersion','sessionId','userId']) then
        perform legacy_calendar_bounds_fail('Invalid scope actor','legacy_calendar_bounds_scope'); end if;
      if seed ? 'actor' then extra:=legacy_day_uuid_set(extra||array[(seed->'actor'->>'userId')::uuid]);end if;
      -- A directly seeded source's wedding is primary; associated-company source weddings below are not.
      select legacy_day_uuid_set(ow||coalesce(array_agg(wedding_id),'{}')) into ow from legacy_calendar_sources where id=any(so) and wedding_id is not null;
      w:=ow;
      select legacy_day_uuid_set(pv||coalesce(array_agg(id),'{}')) into pv from (
        select vendor_id id from legacy_calendar_sources where id=any(so)
        union select vendor_id from vendor_resources where id=any(r) and vendor_id is not null
        union select vendor_id from deals where wedding_id=any(ow) and vendor_id is not null
        union select vendor_id from deal_day_scope_versions where wedding_id=any(ow) and vendor_id is not null
        union select vendor_id from deal_resource_commitment_versions where wedding_id=any(ow)
        union select histplan.vendor_id from deal_resource_plan_versions histplan where histplan.wedding_id=any(ow)
        union select rq.vendor_id from offer_requests rq join slots slot on slot.id=rq.slot_id where slot.wedding_id=any(ow) and rq.vendor_id is not null
        union select sh.vendor_id from slot_shortlist sh join slots slot on slot.id=sh.slot_id where slot.wedding_id=any(ow) and sh.vendor_id is not null
        union select duty.vendor_id from vendor_staff_duties duty where duty.wedding_id=any(ow)
        union select resource.vendor_id from resource_allocations a join vendor_resources resource on resource.id=a.resource_id where a.wedding_id=any(ow) and resource.vendor_id is not null
        union select resource.vendor_id from deal_resource_plan_versions plan cross join lateral jsonb_array_elements(plan.private_snapshot->'lines') line
          join vendor_resources resource on resource.id=(line->>'resourceId')::uuid where plan.wedding_id=any(ow) and resource.vendor_id is not null
      ) x;
      select legacy_day_uuid_set(r||coalesce(array_agg(id),'{}')) into r from(
        select id from vendor_resources where vendor_id=any(pv)
        union select resource_id from resource_allocations where wedding_id=any(ow)
        union select (line->>'resourceId')::uuid from deal_resource_plan_versions plan cross join lateral jsonb_array_elements(plan.private_snapshot->'lines') line where plan.wedding_id=any(ow)
      ) x;
      -- Freeze the affected person set here. Associated companies do NOT add their unrelated staff recursively.
      select legacy_day_uuid_set(p||coalesce(array_agg(id),'{}')) into p from (
        select conflict_identity id from vendor_resources where kind='person' and(id=any(r) or vendor_id=any(pv))
        union select (x#>>'{}')::uuid from unnest(pv) vendor cross join lateral jsonb_array_elements(legacy_calendar_bounds_known_person_scope(vendor)->'identities') x
        union select (line->>'conflictIdentity')::uuid from deal_resource_plan_versions plan
          cross join lateral jsonb_array_elements(plan.private_snapshot->'lines') line where plan.wedding_id=any(ow) and line->>'kind'='person'
      ) x;
      select legacy_day_uuid_set(pv||coalesce(array_agg(id),'{}')) into v from (
        select id from vendors where user_id=any(p)
        union select vendor_id from vendor_resources where kind='person' and conflict_identity=any(p) and vendor_id is not null
        union select vendor_id from vendor_staff_members where user_id=any(p) and accepted_at is not null
        union select vendor_identity from legacy_calendar_person_links where person_identity=any(p)
        union select c.vendor_identity from resource_occupancy o join resource_occupancy_origin_certificates c on c.id=o.certificate_id
          where o.conflict_identity=any(p) and o.released_at is null
      ) x;
      d:='{}';sl:='{}';dy:='{}';
      loop
      prior_v:=v;prior_so:=so;prior_r:=r;prior_d:=d;
      select legacy_day_uuid_set(so||coalesce(array_agg(id),'{}')) into so from legacy_calendar_sources where vendor_id=any(v);
      for q in select id from legacy_calendar_sources where id=any(so) order by id loop
        -- Memo lives only in this STABLE invocation; every post-wait invocation starts empty.
        ctx:=ctx_cache->q.id::text;
        if ctx is null then
          ctx:=legacy_calendar_bounds_related(q.id);
          ctx_cache:=jsonb_set(ctx_cache,array[q.id::text],ctx,true);
        end if;
        w:=legacy_day_uuid_set(w||legacy_calendar_bounds_ids(ctx->'weddingIds'));
        d:=legacy_day_uuid_set(d||legacy_calendar_bounds_ids(ctx->'dealIds'));sl:=legacy_day_uuid_set(sl||legacy_calendar_bounds_ids(ctx->'slotIds'));
        dy:=legacy_day_uuid_set(dy||legacy_calendar_bounds_ids(ctx->'dayIds'));so:=legacy_day_uuid_set(so||legacy_calendar_bounds_ids(ctx->'sourceIds'));
      end loop;
      -- Original wedding fanout is complete; newly found weddings contribute actual source parents only.
      select legacy_day_uuid_set(d||coalesce(array_agg(id),'{}')) into d from deals where wedding_id=any(ow);
      select legacy_day_uuid_set(sl||coalesce(array_agg(slot_id),'{}')) into sl from deals where id=any(d);
      select legacy_day_uuid_set(sl||coalesce(array_agg(id),'{}')) into sl from slots where wedding_id=any(ow);
      select legacy_day_uuid_set(r||coalesce(array_agg(id),'{}')) into r from (
        select id from vendor_resources where vendor_id=any(pv) or (kind='person' and conflict_identity=any(p))
        union select resource_id from resource_allocations where wedding_id=any(ow) or deal_id=any(d)
        union select (line->>'resourceId')::uuid from deal_resource_plan_versions plan
          cross join lateral jsonb_array_elements(plan.private_snapshot->'lines') line where plan.wedding_id=any(ow) or plan.deal_id=any(d)
      ) x;
      select legacy_day_uuid_set(v||coalesce(array_agg(id),'{}')) into v from(
        select vendor_id id from vendor_resources where id=any(r) and vendor_id is not null
        union select vendor_id from deal_resource_plan_versions where deal_id=any(d)
        union select vendor_id from deal_resource_commitment_versions where deal_id=any(d)
      ) x;
      if cardinality(so)>128 or cardinality(w)>128 or cardinality(d)>128 then perform legacy_calendar_bounds_fail('Scope exceeds full-set limit','legacy_calendar_bounds_scope');end if;
      exit when v=prior_v and so=prior_so and r=prior_r and d=prior_d;
      end loop;
      select legacy_day_uuid_set(array_agg(id)) into st from vendor_staff_members where vendor_id=any(pv) or user_id=any(p)
        or id in(select staff_member_id from vendor_resources where id=any(r));
      select legacy_day_uuid_set(v||coalesce(array_agg(vendor_id),'{}')) into v from vendor_resources where id=any(r) and vendor_id is not null;
      select legacy_day_uuid_set(array_agg(id)) into win from resource_capacity_windows where resource_id=any(r);
      select legacy_day_uuid_set(array_agg(id)) into al from resource_allocations where resource_id=any(r) or deal_id=any(d);
      select legacy_day_uuid_set(array_agg(id)) into req from offer_requests where vendor_id=any(pv) or slot_id=any(sl);
      select legacy_day_uuid_set(extra||p||coalesce(array_agg(id),'{}')) into ac from (
        select user_id id from vendors where id=any(v)
        union select owner_id from weddings where id=any(w)
        union select user_id from wedding_members where wedding_id=any(w)
        union select user_id from vendor_staff_members where id=any(st) and user_id is not null
        union select assignee_id from tasks where wedding_id=any(ow) and assignee_id is not null
        union select n.user_id from notifications n join tasks t on t.id=n.task_id where t.wedding_id=any(ow)
        union select user_id from legacy_calendar_bounds_receipts where source_id=any(so) and user_id is not null
      ) x;
      select legacy_day_uuid_set(coalesce(array_agg(id),'{}')||case when seed ? 'actor' then array[(seed->'actor'->>'sessionId')::uuid] else '{}'::uuid[] end)
        into se from sessions where user_id=any(ac);
      parents:=jsonb_build_object(
        'weddings',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'ownerId',x.owner_id) order by x.id) from weddings x where x.id=any(w)),'[]'),
        'requests',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'slotId',x.slot_id,'vendorId',x.vendor_id) order by x.id) from offer_requests x where x.id=any(req)),'[]'),
        'deals',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'weddingId',x.wedding_id,'slotId',x.slot_id,'vendorId',x.vendor_id) order by x.id) from deals x where x.id=any(d)),'[]'),
        'slots',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'weddingId',x.wedding_id,'eventId',x.program_event_id,'dealId',x.deal_id) order by x.id) from slots x where x.id=any(sl)),'[]'),
        'orders',coalesce((select jsonb_agg(jsonb_build_object('dealId',x.deal_id,'weddingId',x.wedding_id,'planId',x.resource_plan_id) order by x.deal_id) from deal_orders x where x.deal_id=any(d)),'[]'),
        'vendors',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'ownerId',x.user_id) order by x.id) from vendors x where x.id=any(v)),'[]'),
        'staff',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'vendorId',x.vendor_id,'userId',x.user_id,'accepted',x.accepted_at is not null) order by x.id) from vendor_staff_members x where x.id=any(st)),'[]'),
        'resources',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'vendorId',x.vendor_id,'kind',x.kind,'identity',x.conflict_identity,'personId',x.person_user_id,'staffId',x.staff_member_id) order by x.id) from vendor_resources x where x.id=any(r)),'[]'),
        'windows',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'resourceId',x.resource_id) order by x.id) from resource_capacity_windows x where x.id=any(win)),'[]'),
        'allocations',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'weddingId',x.wedding_id,'dealId',x.deal_id,'vendorId',x.vendor_id,'resourceId',x.resource_id,'windowId',x.capacity_window_id,'kind',x.kind,'identity',x.conflict_identity,'originVersionId',x.origin_version_id) order by x.id) from resource_allocations x where x.id=any(al)),'[]'),
        'sources',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'kind',x.kind,'vendorId',x.vendor_id,'weddingId',x.wedding_id,'companyId',x.company_id,'dayId',x.day_id,'rootId',x.root_deal_id) order by x.id) from legacy_calendar_sources x where x.id=any(so)),'[]'),
        'days',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'vendorId',x.vendor_id,'date',x.date,'source',x.source,'dealId',x.deal_id) order by x.id) from vendor_busy_dates x where x.id=any(dy)),'[]'),
        'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'userId',x.user_id) order by x.id) from sessions x where x.id=any(se)),'[]'));
      result:=jsonb_build_object('weddings',to_jsonb(w),'requests',to_jsonb(req),'deals',to_jsonb(d),'slots',to_jsonb(sl),'orders',to_jsonb(d),
        'accounts',to_jsonb(ac),'vendors',to_jsonb(v),'staff',to_jsonb(st),'resources',to_jsonb(r),'windows',to_jsonb(win),'allocations',to_jsonb(al),
        'sources',to_jsonb(so),'days',to_jsonb(dy),'persons',to_jsonb(p),'sessions',to_jsonb(se),'parents',parents,
        'keys',coalesce((select jsonb_agg(jsonb_build_object('kind',kind,'identity',identity) order by kind,identity) from (
          select kind,conflict_identity identity from vendor_resources where id=any(r)
          union select kind,conflict_identity from resource_allocations where id=any(al)
          union select 'person',unnest(p)) x),'[]'));
      if cardinality(so)>128 or cardinality(w)>128 or cardinality(p)>256 or cardinality(d)>128 then perform legacy_calendar_bounds_fail('Scope exceeds full-set limit','legacy_calendar_bounds_scope');end if;
      return result;
    exception when invalid_text_representation then perform legacy_calendar_bounds_fail('Invalid scope identity','legacy_calendar_bounds_scope');
    end $$;
    -- Private constructor provenance shares the old physical signed hash key.
    create function legacy_calendar_bounds_note_day_mutex(p_vendor_ids uuid[],p_explicit boolean)
    returns void language plpgsql volatile as $$
    declare k integer;held boolean;registry regclass;compatible boolean;
    begin
      if p_vendor_ids is null or array_position(p_vendor_ids,null) is not null or p_explicit is null then
        raise exception 'Exact vendor union and explicit intent required'
          using errcode='23514',constraint='legacy_day_lock_order';
      end if;
      if cardinality(p_vendor_ids)=0 then return;end if;
      registry:=pg_catalog.to_regclass('pg_temp.legacy_calendar_bounds_day_mutex');
      if registry is null then
        create temporary table pg_temp.legacy_calendar_bounds_day_mutex(
          mutex_key integer primary key,explicit_intent boolean not null,
          backend_pid integer not null,transaction_id bigint not null) on commit drop;
        registry:=pg_catalog.to_regclass('pg_temp.legacy_calendar_bounds_day_mutex');
      end if;
      select c.relpersistence='t' and c.relkind='r' and c.relnamespace=pg_catalog.pg_my_temp_schema()
        and c.relowner=current_user::regrole and not c.relrowsecurity and not c.relforcerowsecurity
        and not c.relispartition and not c.relhasrules and not c.relhassubclass
        and (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,
          pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated) order by a.attnum)
          from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
          ='[[1,"mutex_key","integer",true,false,"",""],[2,"explicit_intent","boolean",true,false,"",""],[3,"backend_pid","integer",true,false,"",""],[4,"transaction_id","bigint",true,false,"",""]]'::jsonb
        and (select count(*) from pg_catalog.pg_constraint q where q.conrelid=c.oid)=1
        and exists(select 1 from pg_catalog.pg_constraint q where q.conrelid=c.oid and q.contype='p'
          and q.conkey='{1}'::smallint[] and not q.condeferrable and not q.condeferred and q.convalidated)
        and not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=c.oid)
        into compatible from pg_catalog.pg_class c where c.oid=registry;
      if compatible is distinct from true then
        raise exception 'Unexpected DATE mutex registry shape'
          using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
      end if;
      if exists(select 1 from pg_temp.legacy_calendar_bounds_day_mutex r
        where r.backend_pid<>pg_backend_pid() or r.transaction_id<>txid_current()) then
        raise exception 'Unexpected DATE mutex registry transaction'
          using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
      end if;
      for k in select distinct hashtext(id::text) from unnest(p_vendor_ids) id order by 1 loop
        select exists(select 1 from pg_catalog.pg_locks l where l.locktype='advisory' and l.pid=pg_backend_pid()
          and l.granted and l.mode='ExclusiveLock' and l.classid=176387 and l.objsubid=2
          and l.objid::bigint=mod(k::bigint+4294967296,4294967296)) into held;
        if p_explicit then
          if not held then
            raise exception 'Explicit DATE constructor requires actual old X'
              using errcode='23514',constraint='legacy_day_lock_order';
          end if;
          insert into pg_temp.legacy_calendar_bounds_day_mutex as r(mutex_key,explicit_intent,backend_pid,transaction_id)
            values(k,true,pg_backend_pid(),txid_current())
            on conflict(mutex_key) do update set explicit_intent=true;
        else
          -- Never infer intent from a lock acquired by a previous safety note.
          insert into pg_temp.legacy_calendar_bounds_day_mutex(mutex_key,explicit_intent,backend_pid,transaction_id)
            values(k,held,pg_backend_pid(),txid_current()) on conflict(mutex_key) do nothing;
        end if;
      end loop;
    end $$;
    create function legacy_calendar_bounds_discovery_locked(p_vendor uuid)
    returns boolean language plpgsql volatile as $$
    declare registry regclass;compatible boolean;intent boolean;
    begin
      if not legacy_day_vendor_locked(p_vendor) then return false;end if;
      registry:=pg_catalog.to_regclass('pg_temp.legacy_calendar_bounds_day_mutex');
      if registry is null then return true;end if;
      select c.relpersistence='t' and c.relkind='r' and c.relnamespace=pg_catalog.pg_my_temp_schema()
        and c.relowner=current_user::regrole and not c.relrowsecurity and not c.relforcerowsecurity
        and not c.relispartition and not c.relhasrules and not c.relhassubclass
        and (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.attnum,a.attname,
          pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,a.atthasdef,a.attidentity,a.attgenerated) order by a.attnum)
          from pg_catalog.pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)
          ='[[1,"mutex_key","integer",true,false,"",""],[2,"explicit_intent","boolean",true,false,"",""],[3,"backend_pid","integer",true,false,"",""],[4,"transaction_id","bigint",true,false,"",""]]'::jsonb
        and (select count(*) from pg_catalog.pg_constraint q where q.conrelid=c.oid)=1
        and exists(select 1 from pg_catalog.pg_constraint q where q.conrelid=c.oid and q.contype='p'
          and q.conkey='{1}'::smallint[] and not q.condeferrable and not q.condeferred and q.convalidated)
        and not exists(select 1 from pg_catalog.pg_trigger t where t.tgrelid=c.oid)
        into compatible from pg_catalog.pg_class c where c.oid=registry;
      if compatible is distinct from true then
        raise exception 'Unexpected DATE mutex registry shape'
          using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
      end if;
      if exists(select 1 from pg_temp.legacy_calendar_bounds_day_mutex r
        where r.backend_pid<>pg_backend_pid() or r.transaction_id<>txid_current()) then
        raise exception 'Unexpected DATE mutex registry transaction'
          using errcode='23514',constraint='legacy_calendar_bounds_old_date_functions';
      end if;
      select coalesce((select r.explicit_intent from pg_temp.legacy_calendar_bounds_day_mutex r
        where r.mutex_key=hashtext(p_vendor::text) and r.backend_pid=pg_backend_pid()
          and r.transaction_id=txid_current()),true) into intent;
      return intent;
    end $$;
    create function legacy_calendar_bounds_pin_scope(scope jsonb,erase boolean,nonwaiting boolean) returns void language plpgsql volatile as $$
    declare pair record;clause text;mode text;ids uuid[];key jsonb;vendor uuid;k int;highest bigint;new_keys integer[];
    begin
      for pair in select * from(values('weddings','weddings','id'),('requests','offer_requests','id'),('deals','deals','id'),('slots','slots','id'),
        ('orders','deal_orders','deal_id'),('orders','deal_resource_commitments','deal_id'),('accounts','users','id')) x(scope_key,table_name,id_column) loop
        ids:=legacy_calendar_bounds_ids(scope->pair.scope_key);mode:=case when pair.table_name='users' and not erase then 'share' else 'update' end;
        execute format('select %I from %I where %I=any($1) order by %I for %s%s',pair.id_column,pair.table_name,pair.id_column,pair.id_column,mode,case when nonwaiting then ' nowait' else '' end) using ids;
      end loop;
      -- Accounts are already held in strongest sorted mode before sessions/consents/member principals.
      for pair in select * from(values('sessions','sessions','id'),('accounts','consents','user_id'),('weddings','wedding_members','wedding_id'),
        ('vendors','vendors','id'),('vendors','vendor_availability_policy','vendor_id'),('staff','vendor_staff_members','id')) x(scope_key,table_name,id_column) loop
        ids:=legacy_calendar_bounds_ids(scope->pair.scope_key);mode:=case when pair.table_name in('sessions','consents','wedding_members') then 'share' else 'update' end;
        execute format('select %I from %I where %I=any($1) order by %I for %s%s',pair.id_column,pair.table_name,pair.id_column,pair.id_column,mode,case when nonwaiting then ' nowait' else '' end) using ids;
      end loop;
      for key in select value from jsonb_array_elements(scope->'keys') order by value->>'kind',value->>'identity' loop
        if not exists(select 1 from resource_conflict_keys where kind=key->>'kind' and identity=(key->>'identity')::uuid) then
          perform legacy_calendar_bounds_fail('Stable key must exist before scope pin','legacy_calendar_bounds_scope');end if;
        execute 'select identity from resource_conflict_keys where kind=$1 and identity=$2 for update'||case when nonwaiting then ' nowait' else '' end
          using key->>'kind',(key->>'identity')::uuid;
      end loop;
      for pair in select * from(values('resources','vendor_resources','id'),('windows','resource_capacity_windows','id'),('allocations','resource_allocations','id')) x(scope_key,table_name,id_column) loop
        execute format('select %I from %I where %I=any($1) order by %I for update%s',pair.id_column,pair.table_name,pair.id_column,pair.id_column,case when nonwaiting then ' nowait' else '' end)
          using legacy_calendar_bounds_ids(scope->pair.scope_key);
      end loop;
      ids:=legacy_calendar_bounds_ids(scope->'vendors');
      -- Note the entire union before any new X; safety is not explicit tracking.
      perform legacy_calendar_bounds_note_day_mutex(ids,false);
      if not nonwaiting then
        select array_agg(mutex_keys.mutex_key order by mutex_keys.mutex_key) into new_keys from
          (select distinct hashtext(id::text) mutex_key from unnest(ids) id
            where not legacy_day_vendor_locked(id)) mutex_keys;
        if new_keys is not null then
          select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)
            into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()
              and granted and classid=176387 and objsubid=2;
          if highest is not null and (new_keys[1]<highest or
            exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or
            exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then
            raise exception 'Nested DATE scope cannot extend a written vendor union'
              using errcode='23514',constraint='legacy_day_lock_order';
          end if;
          foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k);end loop;
        end if;
      else
        select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end) into highest
          from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted and classid=176387 and objsubid=2;
        for k in select distinct hashtext(id::text) from unnest(ids) id where not legacy_day_vendor_locked(id) order by 1 loop
          if (highest is not null and k<highest) or exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin))
            or exists(select 1 from deal_day_scope_versions x where legacy_day_transaction_owns(x.xmin)) then
            perform legacy_calendar_bounds_fail('Raw scope cannot extend written DATE union','legacy_day_lock_order'); end if;
          if not pg_try_advisory_xact_lock(176387,k) then raise lock_not_available using message='Raw DATE prefix unavailable';end if;
        end loop;
      end if;
      for pair in select * from(values('days','vendor_busy_dates','id'),('days','legacy_day_groups','day_id'),('deals','deal_day_scope_heads','deal_id'),
        ('sources','legacy_calendar_heads','source_id'),('sources','legacy_calendar_bounds_heads','source_id')) x(scope_key,table_name,id_column) loop
        execute format('select %I from %I where %I=any($1) order by %I for update%s',pair.id_column,pair.table_name,pair.id_column,pair.id_column,case when nonwaiting then ' nowait' else '' end)
          using legacy_calendar_bounds_ids(scope->pair.scope_key);
      end loop;
    end $$;
    create function legacy_calendar_bounds_prepare_scope(seed jsonb) returns jsonb language plpgsql volatile as $$
    declare initial jsonb;actual jsonb;
    begin
      initial:=legacy_calendar_bounds_locate(seed);
      perform legacy_calendar_bounds_pin_scope(initial,coalesce(seed->>'mode','write')='erase',false);
      actual:=legacy_calendar_bounds_locate(seed);
      if initial is distinct from actual then perform legacy_calendar_bounds_fail('Scope changed after wait','legacy_calendar_bounds_scope_changed');end if;
      return actual;
    end $$;
    create function legacy_calendar_bounds_require_scope(seed jsonb) returns void language plpgsql volatile as $$
    declare initial jsonb;
    begin
      initial:=legacy_calendar_bounds_locate(seed);perform legacy_calendar_bounds_pin_scope(initial,coalesce(seed->>'mode','write')='erase',true);
      if initial is distinct from legacy_calendar_bounds_locate(seed) then perform legacy_calendar_bounds_fail('Raw scope changed','legacy_calendar_bounds_scope_changed');end if;
    end $$;
  `)
  // Both old OIDs/metadata survive their exact admitted constructor corrections.
  pgm.sql(legacyDayCorrectionSQL(true, true))
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_source_material(p_source_id uuid) returns jsonb language plpgsql stable as $$
    declare src legacy_calendar_sources%rowtype;inv jsonb;ctx jsonb;person_scope jsonb;holders jsonb;holder jsonb;inputs jsonb;
      original_date date;complete text;reason text;owner uuid;available boolean;policy_mode text;policy_revision text;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then return null;end if;
      inv:=legacy_calendar_current_inventory_material(src);ctx:=legacy_calendar_bounds_related(src.id);
      complete:=inv->>'completeness';reason:=inv->>'reason';
      if not legacy_calendar_present(src) then complete:='unknown';reason:='source_changed';end if;
      if exists(select 1 from legacy_day_groups g where g.day_id=any(legacy_calendar_bounds_ids(ctx->'dayIds'))
        and(g.classification='opaque' or cardinality(g.legacy_candidates)>0 or g.wedding_id is distinct from src.wedding_id))
        or exists(select 1 from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) d cross join lateral legacy_day_known_holders(d) k
          where k.wedding_id is distinct from src.wedding_id) then complete:='unknown';reason:='mixed_scope';end if;
      original_date:=(src.origin->>'date')::date;
      if src.kind='app_root' then
        select case when count(distinct b.date)=1 then min(b.date) else null end into original_date
          from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) day(day_id) join vendor_busy_dates b on b.id=day.day_id
          where exists(select 1 from legacy_day_known_holders(b.id) k where k.deal_id=src.root_deal_id and k.wedding_id=src.wedding_id);
      end if;
      select v.user_id,v.blocked_at is null and u.deleted_at is null into owner,available from vendors v join users u on u.id=v.user_id where v.id=src.vendor_id;
      select mode,revision::text into policy_mode,policy_revision from vendor_availability_policy where vendor_id=src.vendor_id;
      person_scope:=legacy_calendar_bounds_known_person_scope(src.vendor_id);holders:='[]';
      for holder in select value from jsonb_array_elements(inv->'holders') order by value->>'weddingId',value->>'dealId' loop
        select jsonb_build_object(
          'parts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'version',p.version::text,'assignmentId',p.assignment_id,'details',p.details) order by p.id)
            from order_parts p where p.wedding_id=(holder->>'weddingId')::uuid and p.deal_id=(holder->>'dealId')::uuid and p.cancelled_at is null),'[]'),
          'plan',(select jsonb_build_object('id',p.id,'version',p.version::text,'privateDigest',p.private_digest,'lines',
            (select coalesce(jsonb_agg(x.value-'label' order by x.ordinality),'[]') from jsonb_array_elements(p.private_snapshot->'lines') with ordinality x(value,ordinality)))
            from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id where o.wedding_id=(holder->>'weddingId')::uuid and o.deal_id=(holder->>'dealId')::uuid),
          'allocations',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'originVersionId',a.origin_version_id,'originLineIndex',a.origin_line_index,'resourceId',a.resource_id,
            'windowId',a.capacity_window_id,'kind',a.kind,'identity',a.conflict_identity,'quantity',a.quantity,'startsAt',a.occupied_starts_at,'endsAt',a.occupied_ends_at) order by a.id)
            from resource_allocations a where a.wedding_id=(holder->>'weddingId')::uuid and a.deal_id=(holder->>'dealId')::uuid and a.released_at is null),'[]'),
          'relatedSources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'material',legacy_calendar_current_inventory_material(s)) order by s.id)
            from legacy_calendar_sources s where s.id=any(legacy_calendar_bounds_ids(ctx->'sourceIds'))),'[]')) into inputs;
        holders:=holders||jsonb_build_array(jsonb_build_object('weddingId',holder->'weddingId','dealId',holder->'dealId','slotId',holder->'slot'->'id',
          'orderVersion',holder->'order'->'version','holderSnapshot',holder,'holderFingerprint',legacy_calendar_bounds_fingerprint(holder),'calendarInputs',inputs));
      end loop;
      if jsonb_array_length(holders)>128 then perform legacy_calendar_bounds_fail('Holder limit exceeded','legacy_calendar_bounds_scope');end if;
      return jsonb_build_object('encoding','legacy-calendar-bounds-source/1','sourceId',src.id,'kind',src.kind,'vendorId',src.vendor_id,
        'weddingId',src.wedding_id,'companyId',src.company_id,'originDate',original_date,'sourceRevision',
        case when src.day_id is null then '0' else coalesce((select source_revision::text from vendor_busy_dates where id=src.day_id),'0') end,
        'scopeCompleteness',complete,'unavailableReason',reason,'inventoryMaterial',inv,'holders',holders,'context',ctx,'personScope',person_scope,
        'vendorOwnerId',owner,'ownerAvailable',coalesce(available,false),'policyMode',coalesce(policy_mode,'legacy_day'),'policyRevision',coalesce(policy_revision,'0'));
    end $$;
    create function legacy_calendar_bounds_material(p_source_id uuid,p_inventory_version_id uuid,p_declaration jsonb)
    returns jsonb language plpgsql stable as $$
    declare source jsonb;captured legacy_calendar_versions%rowtype;item jsonb;actual jsonb;manual jsonb;staffing jsonb;ids uuid[];original_date date;total int:=0;
    begin
      source:=legacy_calendar_bounds_source_material(p_source_id);
      if source is null or source->>'scopeCompleteness'<>'complete' or source->>'kind'='orphan_day' or not(source->>'ownerAvailable')::boolean then
        perform legacy_calendar_bounds_fail('Source is unresolved','legacy_calendar_bounds_source_changed');end if;
      select v.* into captured from legacy_calendar_heads h join legacy_calendar_versions v on v.id=h.current_version_id
        where h.source_id=p_source_id and v.id=p_inventory_version_id;
      if not found or captured.source_id<>p_source_id or captured.canonical::jsonb is distinct from source->'inventoryMaterial' then
        perform legacy_calendar_bounds_fail('Exact current captured inventory required','legacy_calendar_bounds_source_changed');end if;
      if jsonb_typeof(p_declaration)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(p_declaration) k) is distinct from array['holders','manualBounds','staffing']
        or jsonb_typeof(p_declaration->'holders')<>'array' or jsonb_array_length(p_declaration->'holders')>128 then
        perform legacy_calendar_bounds_fail('Invalid complete declaration','legacy_calendar_bounds_declaration');end if;
      staffing:=p_declaration->'staffing';
      if jsonb_typeof(staffing)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(staffing) k) is distinct from array['completeness','personIds']
        or staffing->>'completeness' not in('unknown','declared_complete') then perform legacy_calendar_bounds_fail('Invalid staffing declaration','legacy_calendar_bounds_declaration');end if;
      ids:=legacy_calendar_bounds_ids(staffing->'personIds');
      if cardinality(ids)>256 or to_jsonb(ids) is distinct from staffing->'personIds'
        or not ids<@legacy_calendar_bounds_ids(source->'personScope'->'identities')
        or (staffing->>'completeness'='declared_complete' and (staffing->'personIds' is distinct from source->'personScope'->'identities'
          or jsonb_array_length(source->'personScope'->'unknownOrigins')>0)) then perform legacy_calendar_bounds_fail('Staffing is not the exact observed scope','legacy_calendar_bounds_declaration');end if;
      original_date:=(source->>'originDate')::date;
      if source->>'kind'='manual_day' then
        if p_declaration->'holders'<>'[]'::jsonb or jsonb_typeof(p_declaration->'manualBounds')<>'object' then perform legacy_calendar_bounds_fail('Manual declaration cannot fabricate holders','legacy_calendar_bounds_declaration');end if;
        manual:=p_declaration->'manualBounds';
        if (select array_agg(k order by k) from jsonb_object_keys(manual) k) is distinct from array['closureReason','outcome','spans']
          or manual->>'outcome' is null or manual->>'outcome' not in('finite','calendar_closed')
          or jsonb_typeof(manual->'spans')<>'array' or
          not((manual->>'outcome'='finite' and manual->'closureReason'='null'::jsonb and legacy_calendar_bounds_span_set_valid(manual->'spans',original_date))
            or(manual->>'outcome'='calendar_closed' and manual->>'closureReason'='no_remaining_calendar_engagement' and manual->'spans'='[]'::jsonb)) then
          perform legacy_calendar_bounds_fail('Invalid manual bounds','legacy_calendar_bounds_declaration');end if;
      else
        if p_declaration->'manualBounds'<>'null'::jsonb or jsonb_array_length(p_declaration->'holders')<>jsonb_array_length(source->'holders')
          or not exists(select 1 from jsonb_array_elements(source->'holders')) then perform legacy_calendar_bounds_fail('Complete app holder set required','legacy_calendar_bounds_declaration');end if;
        if (select jsonb_agg(jsonb_build_array(x->'weddingId',x->'dealId') order by n) from jsonb_array_elements(p_declaration->'holders') with ordinality h(x,n))
          is distinct from(select jsonb_agg(jsonb_build_array(x->'weddingId',x->'dealId') order by x->>'weddingId',x->>'dealId') from jsonb_array_elements(source->'holders') x) then
          perform legacy_calendar_bounds_fail('Holder set/order differs from actual source','legacy_calendar_bounds_declaration');end if;
        for item in select value from jsonb_array_elements(p_declaration->'holders') loop
          if jsonb_typeof(item)<>'object' or (select array_agg(k order by k) from jsonb_object_keys(item) k) is distinct from
            array['closureReason','dealId','expectedOrderVersion','outcome','spans','weddingId'] or jsonb_typeof(item->'spans')<>'array' then perform legacy_calendar_bounds_fail('Invalid holder declaration','legacy_calendar_bounds_declaration');end if;
          select value into actual from jsonb_array_elements(source->'holders') where value->'weddingId'=item->'weddingId' and value->'dealId'=item->'dealId';
          if item->>'outcome' is null or item->>'outcome' not in('finite','calendar_closed')
            or item->>'expectedOrderVersion' !~ '^[1-9][0-9]{0,18}$' or item->'expectedOrderVersion' is distinct from actual->'orderVersion'
          or not((item->>'outcome'='finite' and item->'closureReason'='null'::jsonb and legacy_calendar_bounds_span_set_for_holder(p_source_id,(item->>'dealId')::uuid,item->'spans'))
              or(item->>'outcome'='calendar_closed' and item->>'closureReason'='no_remaining_calendar_engagement' and item->'spans'='[]'::jsonb))
            or legacy_calendar_bounds_engagement_covered((item->>'weddingId')::uuid,(item->>'dealId')::uuid,item->>'outcome',item->'spans') is not true then
            perform legacy_calendar_bounds_fail('Holder engagement is incomplete or changed','legacy_calendar_bounds_declaration');end if;
          total:=total+jsonb_array_length(item->'spans');
        end loop;
        if total>512 then perform legacy_calendar_bounds_fail('Span total exceeds limit','legacy_calendar_bounds_declaration');end if;
      end if;
      return jsonb_build_object('encoding','legacy-calendar-bounds/1','sourceId',p_source_id,'kind',source->'kind','vendorId',source->'vendorId',
        'weddingId',source->'weddingId','originDate',source->'originDate','sourceFingerprint',legacy_calendar_bounds_fingerprint(source),
        'inventory',jsonb_build_object('versionId',captured.id,'revision',captured.revision::text,'digest',captured.digest),'declaration',p_declaration);
    end $$;
    create function legacy_calendar_bounds_principal_current(p_source_id uuid,p_wedding_id uuid,p_deal_id uuid,p_party text,p_user_id uuid,p_session_id uuid,p_policy_version text)
    returns boolean language sql stable as $$
      select exists(select 1 from users u join sessions se on se.user_id=u.id where u.id=p_user_id and u.deleted_at is null and se.id=p_session_id
        and se.revoked_at is null)
      and exists(select 1 from consents c where c.user_id=p_user_id and c.policy_version=p_policy_version and c.withdrawn_at is null)
      and exists(select 1 from legacy_calendar_sources s join vendors v on v.id=s.vendor_id join users owner on owner.id=v.user_id
        where s.id=p_source_id and v.blocked_at is null and owner.deleted_at is null and
          ((p_party='performer' and v.user_id=p_user_id and (p_wedding_id is null or s.wedding_id=p_wedding_id)) or
           (p_party='customer' and s.wedding_id=p_wedding_id and exists(select 1 from weddings w join wedding_members m on m.wedding_id=w.id
             join deals d on d.wedding_id=w.id where w.id=p_wedding_id and w.archived_at is null and w.cancelled_at is null and m.user_id=p_user_id
             and m.role='couple' and d.id=p_deal_id and d.vendor_id=s.vendor_id))))
    $$;
    create function legacy_calendar_bounds_span_json(s legacy_calendar_bounds_spans) returns jsonb language sql stable as $$
      select jsonb_build_object('spanMode',s.span_mode,'localStartsAt',s.local_starts_at,'localEndsAt',s.local_ends_at,
        'startsAt',to_char(s.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'endsAt',to_char(s.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'suppliedStartsAt',s.supplied_starts_at,'suppliedEndsAt',s.supplied_ends_at,'timeZone',s.time_zone,'coverage',s.coverage)
    $$;
    create function legacy_calendar_bounds_complete(p_bounds_version_id uuid) returns boolean language plpgsql stable as $$
    declare v legacy_calendar_bounds_versions%rowtype;h record;expected jsonb;actual jsonb;material jsonb;
    begin
      select * into v from legacy_calendar_bounds_versions where id=p_bounds_version_id;if not found then return false;end if;
      -- Structural completeness survives later source staleness; currentness is checked separately.
      if v.canonical::jsonb->'declaration' is distinct from v.declaration or v.canonical::jsonb->>'sourceId'<>v.source_id::text
        or v.canonical::jsonb->'inventory' is distinct from jsonb_build_object('versionId',v.inventory_version_id,'revision',v.inventory_revision::text,'digest',v.inventory_digest)
        or v.canonical::jsonb->>'sourceFingerprint'<>v.source_fingerprint then return false;end if;
      select coalesce(jsonb_agg(jsonb_build_object('weddingId',x.wedding_id,'dealId',x.deal_id,'snapshot',x.snapshot,'fingerprint',x.fingerprint) order by x.wedding_id,x.deal_id),'[]') into expected
        from legacy_calendar_version_holders x where x.version_id=v.inventory_version_id;
      select coalesce(jsonb_agg(jsonb_build_object('weddingId',x.wedding_id,'dealId',x.deal_id,'snapshot',x.holder_snapshot,'fingerprint',x.holder_fingerprint) order by x.wedding_id,x.deal_id),'[]') into actual
        from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id;
      if expected is distinct from actual then return false;end if;
      select coalesce(jsonb_agg(person_identity order by person_identity),'[]') into actual from legacy_calendar_bounds_person_scope where bounds_version_id=v.id;
      if actual is distinct from v.declaration->'staffing'->'personIds' then return false;end if;
      if v.company_id is not null then
        select coalesce(jsonb_agg(legacy_calendar_bounds_span_json(s) order by s.span_index),'[]') into actual from legacy_calendar_bounds_spans s where bounds_version_id=v.id and owner_kind='manual';
        if actual is distinct from v.declaration->'manualBounds'->'spans' or exists(select 1 from legacy_calendar_bounds_holders where bounds_version_id=v.id) then return false;end if;
      else
        for h in select * from legacy_calendar_bounds_holders where bounds_version_id=v.id order by wedding_id,deal_id loop
          select value into expected from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=h.wedding_id::text and value->>'dealId'=h.deal_id::text;
          select coalesce(jsonb_agg(legacy_calendar_bounds_span_json(s) order by s.span_index),'[]') into actual from legacy_calendar_bounds_spans s where bounds_version_id=v.id and holder_id=h.id;
          if expected is null or actual is distinct from expected->'spans' or h.outcome<>expected->>'outcome' or h.closure_reason is distinct from expected->>'closureReason'
            or h.expected_order_version::text<>expected->>'expectedOrderVersion' or h.slot_id::text is distinct from h.holder_snapshot->'slot'->>'id' then return false;end if;
        end loop;
      end if;
      if exists(select 1 from legacy_calendar_bounds_spans s where s.bounds_version_id=v.id and (s.span_index<0 or
        s.span_index<>(select count(*) from legacy_calendar_bounds_spans p where p.bounds_version_id=s.bounds_version_id and p.owner_key=s.owner_key and p.span_index<s.span_index))) then return false;end if;
      return true;
    exception when others then return false;
    end $$;
    create function legacy_calendar_bounds_agreed(p_bounds_version_id uuid,p_policy_version text) returns boolean language plpgsql stable as $$
    declare v legacy_calendar_bounds_versions%rowtype;h record;a legacy_calendar_bounds_receipts%rowtype;b legacy_calendar_bounds_receipts%rowtype;
    begin
      select * into v from legacy_calendar_bounds_versions where id=p_bounds_version_id;
      if not found or legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
        or v.staffing_completeness<>'declared_complete' or not exists(select 1 from legacy_calendar_bounds_person_scope where bounds_version_id=v.id) then return false;end if;
      if v.company_id is not null then return true;end if;
      for h in select * from legacy_calendar_bounds_holders where bounds_version_id=v.id loop
        select * into a from legacy_calendar_bounds_receipts where bounds_version_id=v.id and holder_id=h.id and party='customer';
        select * into b from legacy_calendar_bounds_receipts where bounds_version_id=v.id and holder_id=h.id and party='performer';
        if a.id is null or b.id is null or a.user_id is null or b.user_id is null or a.session_id is null or b.session_id is null
          or a.user_id=b.user_id or a.session_id=b.session_id or a.digest<>v.digest or b.digest<>v.digest
          or a.policy_version<>p_policy_version or b.policy_version<>p_policy_version
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,'customer',a.user_id,a.session_id,p_policy_version)
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,'performer',b.user_id,b.session_id,p_policy_version) then return false;end if;
      end loop;
      return true;
    exception when others then return false;
    end $$;
  `)
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_original_date(p_source uuid,p_deal uuid,p_span jsonb) returns date language plpgsql stable as $$
    declare s legacy_calendar_sources%rowtype;result date;local_date date;
    begin
      select * into s from legacy_calendar_sources where id=p_source;if not found then return null;end if;
      if s.day_id is not null then return (s.origin->>'date')::date;end if;
      if s.kind<>'app_root' or p_deal is distinct from s.root_deal_id then return null;end if;
      local_date:=legacy_calendar_bounds_wall(p_span->>'localStartsAt')::date;
      select case when count(distinct b.id)=1 then min(b.date) else null end into result
        from legacy_calendar_day_ids(s) day(day_id) join vendor_busy_dates b on b.id=day.day_id
        where b.date=local_date and exists(select 1 from legacy_day_known_holders(b.id) k where k.deal_id=p_deal and k.wedding_id=s.wedding_id);
      return result;
    end $$;
    create function legacy_calendar_bounds_span_original_date(p_source uuid,p_holder uuid,p_span jsonb) returns date language plpgsql stable as $$
    declare h legacy_calendar_bounds_holders%rowtype;
    begin
      if p_holder is not null then
        select * into h from legacy_calendar_bounds_holders where id=p_holder and source_id=p_source;
        if not found then perform legacy_calendar_bounds_fail('Span holder does not belong to source');end if;
      end if;
      return legacy_calendar_bounds_original_date(p_source,h.deal_id,p_span);
    end $$;
    create function legacy_calendar_bounds_activation_material(p_version uuid,p_policy text) returns jsonb language sql stable as $$
      select jsonb_build_object('encoding','legacy-calendar-bounds-activation/1','sourceId',v.source_id,'boundsVersionId',v.id,'boundsDigest',v.digest,
        'sourceFingerprint',v.source_fingerprint,'holderIds',coalesce((select jsonb_agg(id order by id) from legacy_calendar_bounds_holders where bounds_version_id=v.id),'[]'),
        'personIds',coalesce((select jsonb_agg(person_identity order by person_identity) from legacy_calendar_bounds_person_scope where bounds_version_id=v.id),'[]'),
        'policyVersion',p_policy) from legacy_calendar_bounds_versions v where v.id=p_version
    $$;
    create function legacy_calendar_bounds_certificate_material(p_version uuid,p_event uuid) returns jsonb language sql stable as $$
      with v as(select * from legacy_calendar_bounds_versions where id=p_version),ranges as(
        select sp.owner_key,h.wedding_id,h.deal_id,sp.span_index,
          to_char(sp.starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') a,
          to_char(sp.ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') b,sp.time_zone
        from legacy_calendar_bounds_spans sp left join legacy_calendar_bounds_holders h on h.id=sp.holder_id where sp.bounds_version_id=p_version
      ),lines as(
        select row_number() over(order by r.owner_key,r.span_index,p.person_identity)-1 line_index,r.*,p.person_identity
          from ranges r cross join legacy_calendar_bounds_person_scope p where p.bounds_version_id=p_version
      ) select jsonb_build_object('encoding','legacy-calendar-occupancy-certificate/1','sourceId',v.source_id,'sourceKind',v.canonical::jsonb->'kind',
        'vendorIdentity',v.canonical::jsonb->'vendorId','boundsVersionId',v.id,'activationEventId',p_event,'boundsDigest',v.digest,
        'scopeKind',case when v.wedding_id is null then 'manual' else 'app' end,'weddingIdentity',v.wedding_id,
        'persons',coalesce((select jsonb_agg(person_identity order by person_identity) from legacy_calendar_bounds_person_scope where bounds_version_id=v.id),'[]'),
        'ranges',coalesce((select jsonb_agg(jsonb_build_object('ownerKey',owner_key,'weddingId',wedding_id,'dealId',deal_id,'spanIndex',span_index,'startsAt',a,'endsAt',b,'timeZone',time_zone)
          order by owner_key,span_index) from ranges),'[]'),
        'lines',coalesce((select jsonb_agg(jsonb_build_object('lineIndex',line_index,'ownerKey',owner_key,'personIdentity',person_identity,'spanIndex',span_index,'startsAt',a,'endsAt',b,'timeZone',time_zone)
          order by line_index) from lines),'[]')) from v
    $$;
    create function legacy_calendar_bounds_assert_certificate(p_certificate_id uuid) returns void language plpgsql volatile as $$
    declare c resource_occupancy_origin_certificates%rowtype;expected jsonb;actual jsonb;
    begin
      select * into c from resource_occupancy_origin_certificates where id=p_certificate_id;if not found then return;end if;
      if c.live_bounds_version_id is not null and c.live_activation_event_id is not null then
        expected:=legacy_calendar_bounds_certificate_material(c.live_bounds_version_id,c.live_activation_event_id);
        if expected is null or expected::text<>c.canonical then perform legacy_calendar_bounds_fail('Certificate must preserve exact native accepted material');end if;
      end if;
      expected:=c.canonical::jsonb;
      if expected->>'encoding'<>'legacy-calendar-occupancy-certificate/1' or expected->>'sourceId'<>c.source_identity::text
        or expected->>'vendorIdentity'<>c.vendor_identity::text or expected->>'boundsVersionId'<>c.bounds_version_identity::text
        or expected->>'activationEventId'<>c.activation_event_identity::text or expected->>'scopeKind'<>c.scope_kind
        or expected->>'weddingIdentity' is distinct from c.app_wedding_id::text then perform legacy_calendar_bounds_fail('Certificate identity mismatch');end if;
      select coalesce(jsonb_agg(jsonb_build_object('lineIndex',o.origin_line_index,'personIdentity',o.conflict_identity,
        'startsAt',to_char(o.occupied_starts_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'endsAt',to_char(o.occupied_ends_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by o.origin_line_index),'[]') into actual
        from resource_occupancy o where o.certificate_id=c.id;
      select coalesce(jsonb_agg(x-'ownerKey'-'spanIndex'-'timeZone' order by(x->>'lineIndex')::int),'[]') into expected from jsonb_array_elements(expected->'lines') x;
      if expected is distinct from actual or exists(select 1 from resource_occupancy o where o.certificate_id=c.id and
        (o.origin_kind<>'legacy_person' or o.origin_id<>c.id or o.origin_version_id<>c.bounds_version_identity or o.vendor_identity<>c.vendor_identity
          or o.kind<>'person' or o.quantity<>1 or o.enforcement<>'legacy_barrier' or o.resource_id is not null or o.capacity_window_id is not null)) then
        perform legacy_calendar_bounds_fail('Certificate occupancy full set mismatch');end if;
    end $$;
    create function legacy_calendar_bounds_assert_mirror(p_allocation_id uuid) returns void language plpgsql volatile as $$
    declare a resource_allocations%rowtype;o resource_occupancy%rowtype;
    begin
      select * into a from resource_allocations where id=p_allocation_id;
      if not found then
        if exists(select 1 from resource_occupancy where allocation_id=p_allocation_id) then perform legacy_calendar_bounds_fail('Orphan commitment mirror');end if;return;
      end if;
      select * into o from resource_occupancy where allocation_id=a.id;
      if not found or row(o.origin_kind,o.origin_id,o.origin_version_id,o.origin_line_index,o.vendor_identity,o.kind,o.conflict_identity,o.resource_id,o.capacity_window_id,o.quantity,
        o.occupied_starts_at,o.occupied_ends_at,o.released_at,o.release_reason,o.enforcement)
        is distinct from row('commitment'::text,a.id,a.origin_version_id,a.origin_line_index,a.vendor_id,a.kind,a.conflict_identity,a.resource_id,a.capacity_window_id,a.quantity,
        a.occupied_starts_at,a.occupied_ends_at,a.released_at,a.release_reason,'exclusive'::text) or o.certificate_id is not null then
        perform legacy_calendar_bounds_fail('Commitment mirror differs from actual allocation');end if;
    end $$;
    create function legacy_calendar_bounds_current_effect(p_source_id uuid) returns jsonb language plpgsql stable as $$
    declare h legacy_calendar_bounds_heads%rowtype;e legacy_calendar_resolution_events%rowtype;v legacy_calendar_bounds_versions%rowtype;
      source jsonb;fresh text:='stale';state text:='unresolved';conflicted boolean:=false;
    begin
      select * into h from legacy_calendar_bounds_heads where source_id=p_source_id;
      select * into e from legacy_calendar_resolution_events where id=h.effective_event_id;
      select * into v from legacy_calendar_bounds_versions where id=e.bounds_version_id;
      source:=legacy_calendar_bounds_source_material(p_source_id);
      if source is null or source->>'unavailableReason'='source_changed' then fresh:='unavailable';
      elsif v.id is not null and e.action='activate' and v.staffing_completeness='declared_complete'
        and legacy_calendar_bounds_complete(v.id) and v.source_fingerprint=legacy_calendar_bounds_fingerprint(source)
        and not exists(select 1 from legacy_calendar_resolution_events x where x.source_id=p_source_id and x.action in('source_stale','source_unavailable','holder_cancelled','negotiation_committed')
          and (x.created_at,x.id)>(e.created_at,e.id)) then
        fresh:='current';state:=case when exists(select 1 from legacy_calendar_bounds_spans where bounds_version_id=v.id) then 'finite' else 'calendar_closed' end;
      end if;
      if v.id is not null then
        select exists(select 1 from resource_occupancy a join resource_occupancy_origin_certificates c on c.id=a.certificate_id
          join resource_occupancy b on b.id<>a.id and ((b.kind=a.kind and b.conflict_identity=a.conflict_identity)
            or(b.origin_kind='commitment' and b.vendor_identity=c.vendor_identity))
          and b.released_at is null and tstzrange(a.occupied_starts_at,a.occupied_ends_at,'[)')&&tstzrange(b.occupied_starts_at,b.occupied_ends_at,'[)')
          where c.bounds_version_identity=v.id and a.released_at is null) into conflicted;
      end if;
      return jsonb_build_object('state',state,'freshness',fresh,'effectiveVersionId',v.id,'conflicted',conflicted,
        'updatedAt',case when h.source_id is null then null else to_char(h.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end);
    exception when others then
      return jsonb_build_object('state','unresolved','freshness','stale','effectiveVersionId',v.id,'conflicted',false,'updatedAt',null);
    end $$;
    create function legacy_calendar_bounds_assert_applied(p_event_id uuid) returns void language plpgsql volatile as $$
    declare e legacy_calendar_resolution_events%rowtype;v legacy_calendar_bounds_versions%rowtype;expected jsonb;actual jsonb;c record;
    begin
      select * into e from legacy_calendar_resolution_events where id=p_event_id;
      if not found or e.action<>'activate' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events own where own.id=e.id and legacy_day_transaction_owns(own.xmin)) then return;end if;
      select * into strict v from legacy_calendar_bounds_versions where id=e.bounds_version_id;
      if legacy_calendar_bounds_agreed(v.id,e.policy_version) is not true or e.material is distinct from legacy_calendar_bounds_activation_material(v.id,e.policy_version)
        or not exists(select 1 from legacy_calendar_bounds_heads where source_id=e.source_id and effective_event_id=e.id)
        or (not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',e.actor_id,e.session_id,e.policy_version)
          and not exists(select 1 from legacy_calendar_bounds_holders h where h.bounds_version_id=v.id and
            legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,'customer',e.actor_id,e.session_id,e.policy_version))) then
        perform legacy_calendar_bounds_fail('New activation must retain whole current agreement and authority');end if;
      select coalesce(jsonb_agg(jsonb_build_object('holderId',h.id,'outcome',h.outcome,'material',jsonb_build_object('encoding','legacy-calendar-holder-resolution/1',
        'holderId',h.id,'weddingId',h.wedding_id,'dealId',h.deal_id,'outcome',h.outcome,'boundsDigest',v.digest)) order by h.id),'[]') into expected
        from legacy_calendar_bounds_holders h where h.bounds_version_id=v.id;
      select coalesce(jsonb_agg(jsonb_build_object('holderId',r.holder_id,'outcome',r.outcome,'material',r.material) order by r.holder_id),'[]') into actual
        from legacy_calendar_resolution_holders r where r.event_id=e.id;
      if actual is distinct from expected then perform legacy_calendar_bounds_fail('Activation resolution holder set incomplete');end if;
      if (select count(*) from resource_occupancy_origin_certificates where activation_event_identity=e.id)<>1 then perform legacy_calendar_bounds_fail('Activation requires exactly one native origin certificate');end if;
      for c in select id from resource_occupancy_origin_certificates where activation_event_identity=e.id loop perform legacy_calendar_bounds_assert_certificate(c.id);end loop;
    end $$;
    create function legacy_calendar_bounds_activate(p_version uuid,p_actor uuid,p_session uuid,p_policy text) returns uuid language plpgsql volatile as $$
    declare v legacy_calendar_bounds_versions%rowtype;h legacy_calendar_bounds_heads%rowtype;e legacy_calendar_resolution_events%rowtype;
      new_event_id uuid:=gen_random_uuid();new_certificate_id uuid:=gen_random_uuid();mat jsonb;line jsonb;item record;
    begin
      select * into v from legacy_calendar_bounds_versions where id=p_version;if not found then perform legacy_calendar_bounds_fail('Proposal missing');end if;
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(v.source_id),'actor',jsonb_build_object('userId',p_actor,'sessionId',p_session,'policyVersion',p_policy)));
      select * into h from legacy_calendar_bounds_heads where source_id=v.source_id for update;
      if h.proposed_version_id is distinct from v.id or legacy_calendar_bounds_agreed(v.id,p_policy) is not true
        or (not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',p_actor,p_session,p_policy)
          and not exists(select 1 from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id and legacy_calendar_bounds_principal_current(v.source_id,x.wedding_id,x.deal_id,'customer',p_actor,p_session,p_policy))) then
        perform legacy_calendar_bounds_fail('Activation requires current whole proof','legacy_calendar_bounds_not_agreed');end if;
      select * into e from legacy_calendar_resolution_events where id=h.effective_event_id;
      if e.action='activate' and e.bounds_version_id=v.id and legacy_calendar_bounds_current_effect(v.source_id)->>'freshness'='current' then return e.id;end if;
      insert into legacy_calendar_resolution_events(id,source_id,bounds_version_id,action,previous_event_id,actor_id,session_id,policy_version,before_fingerprint,after_fingerprint,material)
        values(new_event_id,v.source_id,v.id,'activate',h.effective_event_id,p_actor,p_session,p_policy,v.source_fingerprint,v.source_fingerprint,legacy_calendar_bounds_activation_material(v.id,p_policy));
      insert into legacy_calendar_resolution_holders(event_id,source_id,bounds_version_id,holder_id,outcome,material)
        select new_event_id,v.source_id,v.id,x.id,x.outcome,jsonb_build_object('encoding','legacy-calendar-holder-resolution/1','holderId',x.id,'weddingId',x.wedding_id,'dealId',x.deal_id,'outcome',x.outcome,'boundsDigest',v.digest)
        from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id;
      mat:=legacy_calendar_bounds_certificate_material(v.id,new_event_id);
      insert into resource_occupancy_origin_certificates(id,scope_kind,source_identity,vendor_identity,bounds_version_identity,activation_event_identity,app_wedding_id,
        live_source_id,live_vendor_id,live_bounds_version_id,live_activation_event_id,digest,canonical)
        values(new_certificate_id,mat->>'scopeKind',v.source_id,(mat->>'vendorIdentity')::uuid,v.id,new_event_id,v.wedding_id,v.source_id,(mat->>'vendorIdentity')::uuid,v.id,new_event_id,
          legacy_calendar_bounds_fingerprint(mat),mat::text);
      for line in select value from jsonb_array_elements(mat->'lines') loop
        insert into resource_occupancy(id,origin_kind,origin_id,origin_version_id,origin_line_index,certificate_id,vendor_identity,kind,conflict_identity,quantity,occupied_starts_at,occupied_ends_at,enforcement)
          values(gen_random_uuid(),'legacy_person',new_certificate_id,v.id,(line->>'lineIndex')::int,new_certificate_id,(mat->>'vendorIdentity')::uuid,'person',(line->>'personIdentity')::uuid,1,
            (line->>'startsAt')::timestamptz,(line->>'endsAt')::timestamptz,'legacy_barrier');
      end loop;
      update resource_occupancy o set released_at=clock_timestamp(),release_reason='superseded',release_event_id=new_event_id
        from resource_occupancy_origin_certificates c where c.id=o.certificate_id and c.source_identity=v.source_id and c.id<>new_certificate_id and o.released_at is null;
      update legacy_calendar_bounds_heads set effective_event_id=new_event_id,revision=revision+1,updated_at=clock_timestamp() where source_id=v.source_id;
      perform legacy_calendar_bounds_assert_applied(new_event_id);
      return new_event_id;
    end $$;
  `)
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_span_set_for_holder(p_source uuid,p_deal uuid,p_spans jsonb) returns boolean language plpgsql stable as $$
    declare sp jsonb;
    begin
      if jsonb_typeof(p_spans)<>'array' or jsonb_array_length(p_spans) not between 1 and 64 then return false;end if;
      for sp in select value from jsonb_array_elements(p_spans) loop
        if legacy_calendar_bounds_span_valid(sp,legacy_calendar_bounds_original_date(p_source,p_deal,sp)) is not true then return false;end if;
      end loop;
      return not exists(select 1 from jsonb_array_elements(p_spans) with ordinality a(x,n),jsonb_array_elements(p_spans) with ordinality b(x,n)
        where a.n<b.n and ((a.x->>'startsAt')::timestamptz>(b.x->>'startsAt')::timestamptz or
          tstzrange((a.x->>'startsAt')::timestamptz,(a.x->>'endsAt')::timestamptz,'[)') && tstzrange((b.x->>'startsAt')::timestamptz,(b.x->>'endsAt')::timestamptz,'[)')));
    exception when others then return false;
    end $$;
    create function legacy_calendar_bounds_initial_current(p_witness uuid,p_deal uuid) returns boolean language sql stable as $$
      select exists(select 1 from legacy_calendar_initial_commit_witnesses w where w.id=p_witness and w.deal_id=p_deal
        and w.transaction_id=txid_current() and w.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(w.xmin))
    $$;
    create function legacy_calendar_bounds_assert_boundary(p_vendor_id uuid,p_deal_id uuid,p_lines jsonb,p_initial_witness_id uuid)
    returns void language plpgsql volatile as $$
    declare line jsonb;source record;effect jsonb;company uuid;person uuid;associated uuid[];a timestamptz;b timestamptz;own_initial boolean;
    begin
      if jsonb_typeof(p_lines)<>'array' then perform legacy_calendar_bounds_fail('Exact resource lines required','resource_booking_conflict');end if;
      own_initial:=p_initial_witness_id is not null and legacy_calendar_bounds_initial_current(p_initial_witness_id,p_deal_id);
      if p_initial_witness_id is not null and not own_initial then perform legacy_calendar_bounds_fail('Initial witness is not current','legacy_calendar_initial_commit');end if;
      for line in select value from jsonb_array_elements(p_lines) loop
        a:=legacy_calendar_bounds_instant(line->>'occupiedStartsAt');b:=legacy_calendar_bounds_instant(line->>'occupiedEndsAt');
        if a is null or b is null or a>=b or line->>'kind' not in('person','equipment','capacity') then perform legacy_calendar_bounds_fail('Invalid occupied interval','resource_booking_conflict');end if;
        associated:=array[p_vendor_id];
        if line->>'kind'='person' then
          person:=(line->>'conflictIdentity')::uuid;
          select legacy_day_uuid_set(associated||coalesce(array_agg(id),'{}')) into associated from(
            select id from vendors where user_id=person
            union select vendor_id from vendor_resources where kind='person' and conflict_identity=person and vendor_id is not null
            union select vendor_id from vendor_staff_members where user_id=person and accepted_at is not null
            union select vendor_identity from legacy_calendar_person_links where person_identity=person
            union select c.vendor_identity from resource_occupancy o join resource_occupancy_origin_certificates c on c.id=o.certificate_id
              where o.conflict_identity=person and o.released_at is null
          ) x;
        end if;
        for source in select s.* from legacy_calendar_sources s where s.vendor_id=any(associated) and legacy_calendar_present(s) order by s.id loop
          if own_initial and source.kind='live_negotiation' and source.root_deal_id=p_deal_id then continue;end if;
          effect:=legacy_calendar_bounds_current_effect(source.id);
          if effect->>'freshness'<>'current' or effect->>'state'='unresolved' then
            perform legacy_calendar_bounds_fail('Relevant legacy source is unresolved',case when source.vendor_id=p_vendor_id then 'unresolved_legacy_obligations' else 'legacy_person_scope_unknown' end);
          end if;
        end loop;
        -- Stable vendor ranges apply to every resource kind, independently of live source/DAY FKs.
        if exists(select 1 from resource_occupancy o join resource_occupancy_origin_certificates c on c.id=o.certificate_id
          where o.released_at is null and o.enforcement='legacy_barrier' and
            (c.vendor_identity=p_vendor_id or(line->>'kind'='person' and o.conflict_identity=person))
            and tstzrange(o.occupied_starts_at,o.occupied_ends_at,'[)')&&tstzrange(a,b,'[)')
            and not(own_initial and c.canonical::jsonb->>'sourceKind'='live_negotiation'
              and exists(select 1 from legacy_calendar_sources s where s.id=c.source_identity and s.root_deal_id=p_deal_id))) then
          perform legacy_calendar_bounds_fail('Accepted legacy period overlaps requested resources','resource_booking_conflict');
        end if;
      end loop;
    end $$;
    create function legacy_calendar_bounds_assert_person_links(p_person_ids uuid[],p_vendor_ids uuid[]) returns void language plpgsql volatile as $$
    declare p uuid;
    begin
      -- Native raw fallback takes the full closed prefix NOWAIT before stable keys.
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('vendorIds',to_jsonb(legacy_day_uuid_set(p_vendor_ids)),'personIds',to_jsonb(legacy_day_uuid_set(p_person_ids))));
      for p in select unnest(legacy_day_uuid_set(p_person_ids)) loop
        if not exists(select 1 from resource_conflict_keys where kind='person' and identity=p) then perform legacy_calendar_bounds_fail('Stable person key missing','legacy_calendar_bounds_scope');end if;
        perform identity from resource_conflict_keys where kind='person' and identity=p for update nowait;
      end loop;
      -- Association expansion changes computed input fingerprints. Existing accepted ranges remain.
    end $$;
    create function legacy_calendar_bounds_initial_preconditions(p_wedding uuid,p_deal uuid,p_vendor uuid,p_terms uuid,p_plan uuid,p_policy_revision bigint,p_actor uuid,p_session uuid,p_policy text,p_pending text)
    returns boolean language sql stable as $$
      select exists(select 1 from deals d join slots sl on sl.id=d.slot_id and sl.wedding_id=d.wedding_id
        join deal_orders o on o.wedding_id=d.wedding_id and o.deal_id=d.id
        join deal_terms_versions t on t.wedding_id=d.wedding_id and t.deal_id=d.id and t.id=p_terms
        join deal_resource_plan_versions plan on plan.wedding_id=d.wedding_id and plan.deal_id=d.id and plan.id=p_plan
        join vendor_availability_policy policy on policy.vendor_id=d.vendor_id
        where d.wedding_id=p_wedding and d.id=p_deal and d.vendor_id=p_vendor and d.state=p_pending
          and d.state in('candidate','contacted','negotiating') and d.booked_at is null and sl.prebooked_at is null and(sl.deal_id is null or sl.deal_id=d.id)
          and o.proposed_terms_id=p_terms and o.agreed_terms_id=p_terms and o.resource_plan_id=p_plan
          and t.resource_plan_id=p_plan and t.snapshot->>'schemaVersion'='2' and t.source_order_version=o.version
          and plan.vendor_id=d.vendor_id and t.snapshot->'resourcePlan'=plan.public_snapshot
          and policy.mode='resources' and policy.revision=p_policy_revision
          and not exists(select 1 from deal_resource_commitments h where h.deal_id=d.id and(h.revision<>0 or h.state<>'not_reserved' or h.current_version_id is not null))
          and not exists(select 1 from deal_resource_commitment_versions where deal_id=d.id)
          and not exists(select 1 from resource_allocations where deal_id=d.id)
          and not exists(select 1 from vendor_busy_dates where deal_id=d.id)
          and not exists(select 1 from deal_day_scope_versions where deal_id=d.id and day_id is not null)
          and not exists(select 1 from legacy_day_groups g where d.id=any(g.legacy_candidates))
          and not exists(select 1 from legacy_calendar_sources s where s.root_deal_id=d.id and s.kind='app_root')
          and not exists(select 1 from deal_events where deal_id=d.id and(to_state in('booked','paid_deposit','done') or from_state in('booked','paid_deposit','done')))
          and event_move_principal_current(p_wedding,p_deal,'customer',p_actor,p_session,p_policy)
          and exists(select 1 from deal_terms_receipts a join deal_terms_receipts b on b.terms_id=a.terms_id
            where a.wedding_id=p_wedding and a.deal_id=p_deal and b.wedding_id=p_wedding and b.deal_id=p_deal and a.terms_id=p_terms
              and a.party='customer' and b.party='performer' and a.user_id is not null and b.user_id is not null and a.session_id is not null and b.session_id is not null
              and a.user_id<>b.user_id and a.session_id<>b.session_id and a.digest=t.digest and b.digest=t.digest
              and event_move_principal_current(p_wedding,p_deal,'customer',a.user_id,a.session_id,p_policy)
              and event_move_principal_current(p_wedding,p_deal,'performer',b.user_id,b.session_id,p_policy)))
    $$;
    create function legacy_calendar_bounds_prepare_initial_commit(p_wedding uuid,p_deal uuid,p_terms uuid,p_plan uuid,p_policy_revision bigint,p_actor uuid,p_session uuid,p_policy text)
    returns uuid language plpgsql volatile as $$
    declare id uuid:=gen_random_uuid();d deals%rowtype;o deal_orders%rowtype;sl slots%rowtype;t deal_terms_versions%rowtype;found_id uuid;
    begin
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(p_wedding),'actor',jsonb_build_object('userId',p_actor,'sessionId',p_session,'policyVersion',p_policy)));
      select * into d from deals where wedding_id=p_wedding and deals.id=p_deal;select * into o from deal_orders where wedding_id=p_wedding and deal_id=p_deal;
      select * into sl from slots where slots.id=d.slot_id;select * into t from deal_terms_versions where wedding_id=p_wedding and deal_id=p_deal and deal_terms_versions.id=p_terms;
      if legacy_calendar_bounds_initial_preconditions(p_wedding,p_deal,d.vendor_id,p_terms,p_plan,p_policy_revision,p_actor,p_session,p_policy,d.state) is not true then
        perform legacy_calendar_bounds_fail('Initial conversion requires exact pending proof','legacy_calendar_initial_commit');end if;
      select w.id into found_id from legacy_calendar_initial_commit_witnesses w where w.wedding_id=p_wedding and w.deal_id=p_deal and w.transaction_id=txid_current();
      if found_id is not null then return found_id;end if;
      insert into legacy_calendar_initial_commit_witnesses(id,wedding_id,deal_id,vendor_id,terms_id,plan_revision_id,policy_revision,actor_id,session_id,policy_version,pending_state)
        values(id,p_wedding,p_deal,d.vendor_id,p_terms,p_plan,p_policy_revision,p_actor,p_session,p_policy,d.state);
      return id;
    end $$;
    create function legacy_calendar_bounds_assert_initial(p_witness uuid) returns void language plpgsql volatile as $$
    declare w legacy_calendar_initial_commit_witnesses%rowtype;v deal_resource_commitment_versions%rowtype;s record;e_id uuid;src record;old_id uuid;
    begin
      select * into w from legacy_calendar_initial_commit_witnesses where id=p_witness;
      if not found or not legacy_calendar_bounds_initial_current(w.id,w.deal_id) then return;end if;
      select v0.* into v from deal_resource_commitments h join deal_resource_commitment_versions v0 on v0.id=h.current_version_id
        where h.wedding_id=w.wedding_id and h.deal_id=w.deal_id and h.revision=1 and h.state='reserved' and v0.revision=1 and v0.action='commit'
          and v0.previous_version_id is null and v0.terms_id=w.terms_id and v0.plan_revision_id=w.plan_revision_id and v0.policy_revision=w.policy_revision
          and v0.vendor_id=w.vendor_id and legacy_day_transaction_owns(v0.xmin);
      if not found or not exists(select 1 from deals d join slots sl on sl.id=d.slot_id where d.id=w.deal_id and d.wedding_id=w.wedding_id
        and d.vendor_id=w.vendor_id and d.state='booked' and d.booked_at>=w.recorded_at and sl.deal_id=d.id and sl.prebooked_at is null)
        or not exists(select 1 from deal_events ev where ev.deal_id=w.deal_id and ev.from_state=w.pending_state and ev.to_state='booked'
          and ev.actor_id=w.actor_id and legacy_day_transaction_owns(ev.xmin)) then perform legacy_calendar_bounds_fail('Witness must finish actual same-TX initial booking','legacy_calendar_initial_commit');end if;
      for src in select * from legacy_calendar_sources where root_deal_id=w.deal_id and kind='live_negotiation' loop
        if exists(select 1 from legacy_calendar_resolution_events e where e.source_id=src.id and e.action='negotiation_committed' and e.material->>'witnessId'=w.id::text) then continue;end if;
        select effective_event_id into old_id from legacy_calendar_bounds_heads where source_id=src.id;
        e_id:=gen_random_uuid();
        insert into legacy_calendar_resolution_events(id,source_id,bounds_version_id,action,previous_event_id,actor_id,session_id,policy_version,reason,material)
          select e_id,src.id,e.bounds_version_id,'negotiation_committed',old_id,w.actor_id,w.session_id,w.policy_version,'initial_commit',
            jsonb_build_object('witnessId',w.id,'dealId',w.deal_id,'commitmentVersionId',v.id) from(select 1) x left join legacy_calendar_resolution_events e on e.id=old_id;
        update resource_occupancy o set released_at=clock_timestamp(),release_reason='negotiation_committed',release_event_id=e_id
          from resource_occupancy_origin_certificates c where c.id=o.certificate_id and c.source_identity=src.id and o.released_at is null;
      end loop;
    end $$;
  `)
  pgm.sql(String.raw`
    create function protect_legacy_calendar_bounds_history() returns trigger language plpgsql as $$
    declare n jsonb;o jsonb;v legacy_calendar_bounds_versions%rowtype;h legacy_calendar_bounds_holders%rowtype;s legacy_calendar_sources%rowtype;
      head legacy_calendar_bounds_heads%rowtype;event legacy_calendar_resolution_events%rowtype;captured legacy_calendar_version_holders%rowtype;
      material jsonb;part jsonb;expected jsonb;field text;parent_table text;parent_exists boolean;available boolean;erasure_update boolean:=false;
    begin
      if TG_OP='DELETE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' and
          ((o->>'wedding_id' is not null and not exists(select 1 from weddings where id=(o->>'wedding_id')::uuid)) or
           (o->>'company_id' is not null and not exists(select 1 from vendors where id=(o->>'company_id')::uuid))) then return OLD;end if;
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_holders' or TG_TABLE_NAME='legacy_calendar_bounds_spans' or TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then parent_table:='legacy_calendar_bounds_versions';field:='bounds_version_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then parent_table:='legacy_calendar_bounds_holders';field:='holder_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_events' or TG_TABLE_NAME='legacy_calendar_bounds_heads' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then parent_table:='legacy_calendar_resolution_events';field:='event_id';
        elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then parent_table:='weddings';field:='wedding_id';
        else perform legacy_calendar_bounds_fail('Evidence cannot be directly deleted','legacy_calendar_bounds_immutable');end if;
        execute format('select exists(select 1 from %I where %I=$1)',parent_table,case when parent_table='legacy_calendar_sources' then 'id' else 'id' end)
          into parent_exists using (o->>field)::uuid;
        if parent_exists then perform legacy_calendar_bounds_fail('Evidence may disappear only with its actual parent','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      n:=to_jsonb(NEW);
      if TG_OP='UPDATE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
          if n=o then return NEW;end if;
          if NEW.source_id<>OLD.source_id or NEW.revision<>OLD.revision+1 then perform legacy_calendar_bounds_fail('Bounds head must advance one revision');end if;
          if NEW.proposed_version_id is distinct from OLD.proposed_version_id then
            select * into v from legacy_calendar_bounds_versions where id=NEW.proposed_version_id and source_id=NEW.source_id;
            if not found or v.version<>OLD.proposed_version+1 or v.previous_version_id is distinct from OLD.proposed_version_id
              or NEW.proposed_version<>v.version or NEW.effective_event_id is distinct from OLD.effective_event_id then perform legacy_calendar_bounds_fail('Proposal head ancestry mismatch');end if;
          else
            select * into event from legacy_calendar_resolution_events where id=NEW.effective_event_id and source_id=NEW.source_id;
            if not found or event.action<>'activate' or event.bounds_version_id is distinct from NEW.proposed_version_id or NEW.proposed_version<>OLD.proposed_version
              or event.transaction_id<>txid_current() or event.backend_pid<>pg_backend_pid() then perform legacy_calendar_bounds_fail('Effective head requires native activation');end if;
          end if;
          NEW.updated_at:=clock_timestamp();return NEW;
        end if;
        -- History updates only perform actual users/sessions FK erasure nulling.
        for field,parent_table in select * from(values('created_by','users'),('created_session_id','sessions'),('user_id','users'),('session_id','sessions'),('actor_id','users')) x(f,t) loop
          if n ? field and o->field is distinct from n->field then
            if o->field='null'::jsonb or n->field<>'null'::jsonb then perform legacy_calendar_bounds_fail('History identity is immutable');end if;
            execute format('select exists(select 1 from %I where id=$1)',parent_table) into available using (o->>field)::uuid;
            if available then perform legacy_calendar_bounds_fail('History nulling requires actual parent erasure');end if;
            erasure_update:=true;
          end if;
          n:=n-field;o:=o-field;
        end loop;
        if not erasure_update or n is distinct from o then perform legacy_calendar_bounds_fail('Bounds evidence is immutable','legacy_calendar_bounds_immutable');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
        if NEW.revision<>0 or NEW.proposed_version<>0 or NEW.proposed_version_id is not null or NEW.effective_event_id is not null then perform legacy_calendar_bounds_fail('Initial bounds head is empty');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.created_by,'sessionId',NEW.created_session_id,'policyVersion',NEW.policy_version)));
        select * into s from legacy_calendar_sources where id=NEW.source_id;
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        material:=legacy_calendar_bounds_material(NEW.source_id,NEW.inventory_version_id,NEW.declaration);
        if NEW.wedding_id is distinct from s.wedding_id or NEW.company_id is distinct from s.company_id or NEW.version<>head.proposed_version+1
          or NEW.previous_version_id is distinct from head.proposed_version_id or NEW.canonical is distinct from material::text
          or NEW.source_fingerprint is distinct from material->>'sourceFingerprint'
          or NEW.source_revision::text is distinct from legacy_calendar_bounds_source_material(s.id)->>'sourceRevision'
          or NEW.inventory_revision::text is distinct from material->'inventory'->>'revision' or NEW.inventory_digest is distinct from material->'inventory'->>'digest'
          or NEW.association_fingerprint is distinct from legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_known_person_scope(s.vendor_id))
          or NEW.staffing_completeness is distinct from NEW.declaration->'staffing'->>'completeness'
          or not legacy_calendar_bounds_principal_current(s.id,null,null,'performer',NEW.created_by,NEW.created_session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Proposal must equal exact current owner material');end if;
        NEW.created_at:=clock_timestamp();return NEW;
      end if;
      if n ? 'bounds_version_id' and n->>'bounds_version_id' is not null then
        select * into v from legacy_calendar_bounds_versions where id=(n->>'bounds_version_id')::uuid;
        if not found then perform legacy_calendar_bounds_fail('Proposal parent missing');end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_holders' then
        select * into captured from legacy_calendar_version_holders where version_id=v.inventory_version_id and wedding_id=NEW.wedding_id and deal_id=NEW.deal_id;
        select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=NEW.wedding_id::text and value->>'dealId'=NEW.deal_id::text;
        if captured.version_id is null or part is null or NEW.source_id<>v.source_id or NEW.inventory_version_id<>v.inventory_version_id
          or NEW.holder_snapshot is distinct from captured.snapshot or NEW.holder_fingerprint<>captured.fingerprint or NEW.slot_id::text is distinct from captured.snapshot->'slot'->>'id'
          or NEW.day_version_id is distinct from(captured.snapshot#>>'{dayScope,version,id}')::uuid
          or NEW.expected_order_version::text is distinct from part->>'expectedOrderVersion' or NEW.outcome is distinct from part->>'outcome' or NEW.closure_reason is distinct from part->>'closureReason'
          or NEW.wedding_id is distinct from v.wedding_id then perform legacy_calendar_bounds_fail('Bounds holder must equal captured exact holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_spans' then
        if NEW.holder_id is null then part:=v.declaration->'manualBounds';
          if v.company_id is null then perform legacy_calendar_bounds_fail('Manual span in app proposal');end if;
        else
          select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
          select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=h.wedding_id::text and value->>'dealId'=h.deal_id::text;
        end if;
        expected:=part->'spans'->NEW.span_index;
        if expected is null or legacy_calendar_bounds_span_json(NEW) is distinct from expected
          or NEW.original_date is distinct from legacy_calendar_bounds_span_original_date(v.source_id,NEW.holder_id,expected)
          or legacy_calendar_bounds_span_valid(expected,NEW.original_date) is not true then perform legacy_calendar_bounds_fail('Span must equal native accepted declaration');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then
        if not v.declaration->'staffing'->'personIds' @> to_jsonb(array[NEW.person_identity])
          or NEW.context_material is distinct from legacy_calendar_bounds_known_person_scope((v.canonical::jsonb->>'vendorId')::uuid) then perform legacy_calendar_bounds_fail('Person scope must equal observed conservative context');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        select * into head from legacy_calendar_bounds_heads where source_id=v.source_id;
        expected:=jsonb_build_object('purpose','calendar-bounds-read','sourceId',v.source_id,'inventoryVersionId',v.inventory_version_id,'boundsVersionId',v.id,'version',v.version::text,'digest',v.digest,
          'weddingId',h.wedding_id,'dealId',h.deal_id,'userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version,'iss','tili-tili','aud','calendar-bounds-read','iat',NEW.read_iat,'exp',NEW.read_exp);
        if h.id is null or NEW.source_id<>v.source_id or head.proposed_version_id is distinct from v.id or NEW.digest<>v.digest or NEW.read_claims is distinct from expected
          or NEW.read_iat>floor(extract(epoch from clock_timestamp())) or NEW.read_exp<=floor(extract(epoch from clock_timestamp()))
          or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,NEW.party,NEW.user_id,NEW.session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Receipt requires current exact read proof and party');end if;
        NEW.accepted_at:=clock_timestamp();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_events' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id)));
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        if NEW.previous_event_id is distinct from head.effective_event_id then perform legacy_calendar_bounds_fail('Resolution ancestry mismatch');end if;
        if NEW.action='activate' then
          if NEW.material is distinct from legacy_calendar_bounds_activation_material(v.id,NEW.policy_version) or legacy_calendar_bounds_agreed(v.id,NEW.policy_version) is not true
            or (not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',NEW.actor_id,NEW.session_id,NEW.policy_version)
              and not exists(select 1 from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id and legacy_calendar_bounds_principal_current(v.source_id,x.wedding_id,x.deal_id,'customer',NEW.actor_id,NEW.session_id,NEW.policy_version))) then
            perform legacy_calendar_bounds_fail('Activation requires real current whole proof');end if;
        elsif NEW.action='holder_cancelled' then
          if not exists(select 1 from legacy_calendar_bounds_holders x join deals d on d.id=x.deal_id and d.wedding_id=x.wedding_id
            where x.bounds_version_id=v.id and d.state='cancelled' and NEW.material->>'dealId'=d.id::text) then perform legacy_calendar_bounds_fail('Cancellation resolution requires actual own cancelled holder');end if;
        elsif NEW.action='negotiation_committed' then
          if not exists(select 1 from legacy_calendar_sources source join legacy_calendar_initial_commit_witnesses w on w.deal_id=source.root_deal_id
            join deal_resource_commitments ch on ch.deal_id=w.deal_id join deal_resource_commitment_versions cv on cv.id=ch.current_version_id
            where source.id=NEW.source_id and source.kind='live_negotiation' and NEW.material->>'witnessId'=w.id::text
              and NEW.material->>'commitmentVersionId'=cv.id::text and cv.revision=1 and cv.action='commit' and legacy_calendar_bounds_initial_current(w.id,w.deal_id)) then
            perform legacy_calendar_bounds_fail('Negotiation resolution requires actual initial conversion');end if;
        elsif NEW.action in('source_stale','source_unavailable') then
          if v.id is not null and v.source_fingerprint=legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_source_material(NEW.source_id)) then
            perform legacy_calendar_bounds_fail('Unchanged source cannot be declared stale');end if;
        elsif NEW.action='superseded' then
          if not exists(select 1 from legacy_calendar_resolution_events e where e.id=(NEW.material->>'newEventId')::uuid and e.source_id=NEW.source_id
            and e.action='activate' and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid() and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version)) then perform legacy_calendar_bounds_fail('Supersession requires actual newly agreed activation');end if;
        else perform legacy_calendar_bounds_fail('Unknown resolution action');end if;
        NEW.created_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then
        select * into event from legacy_calendar_resolution_events where id=NEW.event_id;
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        expected:=jsonb_build_object('encoding','legacy-calendar-holder-resolution/1','holderId',h.id,'weddingId',h.wedding_id,'dealId',h.deal_id,'outcome',h.outcome,'boundsDigest',v.digest);
        if event.action<>'activate' or event.bounds_version_id<>v.id or NEW.source_id<>v.source_id or NEW.outcome<>h.outcome or NEW.material is distinct from expected then perform legacy_calendar_bounds_fail('Resolution member is not exact native holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(NEW.wedding_id),'actor',jsonb_build_object('userId',NEW.actor_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        if legacy_calendar_bounds_initial_preconditions(NEW.wedding_id,NEW.deal_id,NEW.vendor_id,NEW.terms_id,NEW.plan_revision_id,NEW.policy_revision,
          NEW.actor_id,NEW.session_id,NEW.policy_version,NEW.pending_state) is not true then
          perform legacy_calendar_bounds_fail('Witness is not a genuine initial pending context','legacy_calendar_initial_commit');end if;
        NEW.recorded_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      end if;
      return NEW;
    end $$;
  `)
  pgm.sql(String.raw`
    create function protect_legacy_calendar_bounds_certificate() returns trigger language plpgsql as $$
    declare expected jsonb;n jsonb;o jsonb;field text;parent text;present boolean;erasure_update boolean:=false;e legacy_calendar_resolution_events%rowtype;
    begin
      if TG_OP='DELETE' then
        if OLD.scope_kind<>'app' or exists(select 1 from weddings where id=OLD.app_wedding_id) then perform legacy_calendar_bounds_fail('Origin certificate cannot disappear with live promises','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        n:=to_jsonb(NEW);o:=to_jsonb(OLD);
        for field,parent in select * from(values('live_source_id','legacy_calendar_sources'),('live_vendor_id','vendors'),('live_bounds_version_id','legacy_calendar_bounds_versions'),('live_activation_event_id','legacy_calendar_resolution_events')) x(f,t) loop
          if n->field is distinct from o->field then
            if o->field='null'::jsonb or n->field<>'null'::jsonb then perform legacy_calendar_bounds_fail('Certificate identity is immutable');end if;
            execute format('select exists(select 1 from %I where id=$1)',parent) into present using(o->>field)::uuid;
            if present then perform legacy_calendar_bounds_fail('Only actual parent erasure may null live certificate pointer');end if;
            erasure_update:=true;
          end if;
          n:=n-field;o:=o-field;
        end loop;
        if not erasure_update or n is distinct from o then perform legacy_calendar_bounds_fail('Certificate facts cannot change','legacy_calendar_bounds_immutable');end if;
        return NEW;
      end if;
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_identity)));
      expected:=legacy_calendar_bounds_certificate_material(NEW.bounds_version_identity,NEW.activation_event_identity);
      select * into e from legacy_calendar_resolution_events where id=NEW.activation_event_identity;
      if expected is null or NEW.canonical is distinct from expected::text or NEW.source_identity::text<>expected->>'sourceId'
        or NEW.vendor_identity::text<>expected->>'vendorIdentity' or NEW.scope_kind<>expected->>'scopeKind'
        or NEW.app_wedding_id::text is distinct from expected->>'weddingIdentity'
        or NEW.live_source_id is distinct from NEW.source_identity or NEW.live_vendor_id is distinct from NEW.vendor_identity
        or NEW.live_bounds_version_id is distinct from NEW.bounds_version_identity or NEW.live_activation_event_id is distinct from NEW.activation_event_identity
        or e.action<>'activate' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or legacy_calendar_bounds_agreed(NEW.bounds_version_identity,e.policy_version) is not true then perform legacy_calendar_bounds_fail('Certificate must derive from actual native activation');end if;
      NEW.created_at:=clock_timestamp();return NEW;
    end $$;
    create function legacy_calendar_bounds_release_valid(p_occupancy resource_occupancy,p_event uuid,p_reason text) returns boolean language plpgsql stable as $$
    declare e legacy_calendar_resolution_events%rowtype;c resource_occupancy_origin_certificates%rowtype;line jsonb;owner uuid;
    begin
      select * into c from resource_occupancy_origin_certificates where id=p_occupancy.certificate_id;
      select * into e from legacy_calendar_resolution_events where id=p_event;
      if c.id is null or e.id is null or e.source_id<>c.source_identity or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events x where x.id=e.id and legacy_day_transaction_owns(x.xmin)) then return false;end if;
      if p_reason='superseded' then return e.action='activate' and e.bounds_version_id<>c.bounds_version_identity and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version);end if;
      if p_reason='negotiation_committed' then
        return e.action='negotiation_committed' and c.canonical::jsonb->>'sourceKind'='live_negotiation'
          and exists(select 1 from legacy_calendar_initial_commit_witnesses w join legacy_calendar_sources s on s.root_deal_id=w.deal_id
            where s.id=c.source_identity and e.material->>'witnessId'=w.id::text and legacy_calendar_bounds_initial_current(w.id,w.deal_id));
      end if;
      if p_reason='holder_cancelled' and e.action='holder_cancelled' then
        select x into line from jsonb_array_elements(c.canonical::jsonb->'lines') x where (x->>'lineIndex')::int=p_occupancy.origin_line_index;
        owner:=(line->>'ownerKey')::uuid;
        return exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'ranges') r join deals d on d.id=(r->>'dealId')::uuid and d.wedding_id=(r->>'weddingId')::uuid
          where r->>'ownerKey'=owner::text and d.state='cancelled' and e.material->>'dealId'=d.id::text);
      end if;
      return false;
    end $$;
    create function protect_resource_occupancy_origin() returns trigger language plpgsql as $$
    declare a resource_allocations%rowtype;c resource_occupancy_origin_certificates%rowtype;line jsonb;witness uuid;
    begin
      if TG_OP='DELETE' then
        if (OLD.origin_kind='commitment' and exists(select 1 from resource_allocations where id=OLD.allocation_id))
          or(OLD.origin_kind='legacy_person' and exists(select 1 from resource_occupancy_origin_certificates where id=OLD.certificate_id)) then
          perform legacy_calendar_bounds_fail('Live origin history cannot be deleted','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        if OLD.release_event_id is not null and NEW.release_event_id is null and not exists(select 1 from legacy_calendar_resolution_events where id=OLD.release_event_id)
          and(to_jsonb(NEW)-'release_event_id')=(to_jsonb(OLD)-'release_event_id') then return NEW;end if;
        if (to_jsonb(NEW)-'released_at'-'release_reason'-'release_event_id') is distinct from(to_jsonb(OLD)-'released_at'-'release_reason'-'release_event_id')
          or OLD.released_at is not null or NEW.released_at is null or not isfinite(NEW.released_at) then perform legacy_calendar_bounds_fail('Occupancy release must be one-way exact origin proof');end if;
        if NEW.origin_kind='commitment' then
          select * into a from resource_allocations where id=NEW.allocation_id;
          if a.id is null or a.released_at is distinct from NEW.released_at or a.release_reason is distinct from NEW.release_reason or NEW.release_event_id is not null then
            perform legacy_calendar_bounds_fail('Mirror release must equal actual allocation release');end if;
        elsif not legacy_calendar_bounds_release_valid(OLD,NEW.release_event_id,NEW.release_reason) then perform legacy_calendar_bounds_fail('Legacy release needs actual scoped resolution');end if;
        return NEW;
      end if;
      if NEW.origin_kind='commitment' then
        select * into a from resource_allocations where id=NEW.allocation_id;
        if a.id is null or row(NEW.origin_id,NEW.origin_version_id,NEW.origin_line_index,NEW.vendor_identity,NEW.kind,NEW.conflict_identity,NEW.resource_id,NEW.capacity_window_id,NEW.quantity,NEW.occupied_starts_at,NEW.occupied_ends_at,NEW.released_at,NEW.release_reason)
          is distinct from row(a.id,a.origin_version_id,a.origin_line_index,a.vendor_id,a.kind,a.conflict_identity,a.resource_id,a.capacity_window_id,a.quantity,a.occupied_starts_at,a.occupied_ends_at,a.released_at,a.release_reason) then
          perform legacy_calendar_bounds_fail('Mirror insert requires exact actual allocation');end if;
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(a.wedding_id),'resourceIds',jsonb_build_array(a.resource_id)));
        select w.id into witness from legacy_calendar_initial_commit_witnesses w where w.deal_id=a.deal_id and w.transaction_id=txid_current() and w.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(w.xmin);
        if NEW.released_at is null then perform legacy_calendar_bounds_assert_boundary(a.vendor_id,a.deal_id,jsonb_build_array(a.line_snapshot),witness);end if;
      else
        select * into c from resource_occupancy_origin_certificates where id=NEW.certificate_id;
        if c.id is null then perform legacy_calendar_bounds_fail('Legacy occupancy origin missing');end if;
        select value into line from jsonb_array_elements(c.canonical::jsonb->'lines') where(value->>'lineIndex')::int=NEW.origin_line_index;
        if line is null or NEW.origin_id<>c.id or NEW.origin_version_id<>c.bounds_version_identity or NEW.vendor_identity<>c.vendor_identity
          or NEW.conflict_identity::text is distinct from line->>'personIdentity' or NEW.occupied_starts_at is distinct from(line->>'startsAt')::timestamptz
          or NEW.occupied_ends_at is distinct from(line->>'endsAt')::timestamptz or NEW.released_at is not null or NEW.release_reason is not null or NEW.release_event_id is not null
          or not exists(select 1 from legacy_calendar_resolution_events e where e.id=c.activation_event_identity and e.action='activate'
            and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(e.xmin)) then perform legacy_calendar_bounds_fail('Legacy barrier must equal exact new accepted certificate line');end if;
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(c.source_identity),'personIds',jsonb_build_array(NEW.conflict_identity)));
      end if;
      return NEW;
    end $$;
    create function maintain_resource_occupancy_mirror() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' then
        insert into resource_occupancy(id,origin_kind,origin_id,origin_version_id,origin_line_index,allocation_id,vendor_identity,kind,conflict_identity,resource_id,capacity_window_id,quantity,
          occupied_starts_at,occupied_ends_at,enforcement,released_at,release_reason)
          values(gen_random_uuid(),'commitment',NEW.id,NEW.origin_version_id,NEW.origin_line_index,NEW.id,NEW.vendor_id,NEW.kind,NEW.conflict_identity,NEW.resource_id,NEW.capacity_window_id,NEW.quantity,
            NEW.occupied_starts_at,NEW.occupied_ends_at,'exclusive',NEW.released_at,NEW.release_reason);
      elsif TG_OP='UPDATE' then
        update resource_occupancy set released_at=NEW.released_at,release_reason=NEW.release_reason where allocation_id=NEW.id;
      end if;
      return null;
    end $$;
    create function legacy_calendar_bounds_allocation_prefix() returns trigger language plpgsql as $$
    declare witness uuid;
    begin
      if TG_OP='INSERT' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(NEW.wedding_id),'vendorIds',jsonb_build_array(NEW.vendor_id),'resourceIds',jsonb_build_array(NEW.resource_id)));
        select w.id into witness from legacy_calendar_initial_commit_witnesses w where w.deal_id=NEW.deal_id and w.transaction_id=txid_current() and w.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(w.xmin);
        perform legacy_calendar_bounds_assert_boundary(NEW.vendor_id,NEW.deal_id,jsonb_build_array(NEW.line_snapshot),witness);
      end if;
      return NEW;
    end $$;
    -- An orphan technical person key is not an occupied or historical identity.
    -- Any surviving proof is conservative retention, including released allocations.
    create function legacy_calendar_bounds_person_orphan(p_person uuid) returns boolean language plpgsql volatile as $$
    declare name text;referenced boolean;l record;needles text[];
    begin
      if p_person is null or exists(select 1 from public.users where id=p_person)
        or exists(select 1 from public.vendors where user_id=p_person)
        or exists(select 1 from public.vendor_staff_members where user_id=p_person)
        or exists(select 1 from public.vendor_resources where conflict_identity=p_person or person_user_id=p_person)
        or exists(select 1 from public.resource_allocations where conflict_identity=p_person)
        or exists(select 1 from public.resource_occupancy where conflict_identity=p_person)
        or exists(select 1 from public.legacy_calendar_bounds_person_scope where person_identity=p_person) then return false;end if;
      select array[p_person::text]||coalesce(array_agg(id::text),'{}'::text[]) into needles
        from public.legacy_calendar_person_links where person_identity=p_person;
      -- This closed list contains current and historical resource/source/proof material.
      -- Substring matching also retains an identity nested in JSON/canonical text.
      foreach name in array array[
        'deal_resource_plan_versions','deal_terms_versions','deal_terms_receipts','deal_resource_commitment_versions','deal_resource_commitment_members',
        'resource_allocations','resource_occupancy','resource_occupancy_origin_certificates',
        'legacy_calendar_sources','legacy_calendar_versions','legacy_calendar_version_holders',
        'legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans',
        'legacy_calendar_bounds_person_scope','legacy_calendar_bounds_receipts','legacy_calendar_resolution_events',
        'legacy_calendar_resolution_holders','legacy_calendar_initial_commit_witnesses',
        'deal_day_scope_versions','legacy_day_groups','deal_orders','order_assignments','order_parts'
      ] loop
        execute format('select exists(select 1 from public.%I t where exists(select 1 from unnest($1::text[]) n(value) where position(n.value in to_jsonb(t)::text)>0))',name)
          into referenced using needles;
        if referenced then return false;end if;
      end loop;
      for l in select * from public.legacy_calendar_person_links where person_identity=p_person loop
        -- Only a vanished owner's purely technical link is eligible. Unknown, staff,
        -- resource, duty and certificate links remain immutable even when retired.
        if l.origin_kind<>'owner' or l.origin_id<>l.vendor_identity or l.unknown_identity
          or exists(select 1 from public.vendors where id=l.vendor_identity)
          or exists(select 1 from public.legacy_calendar_sources s where s.vendor_id=l.vendor_identity and public.legacy_calendar_present(s))
          or exists(select 1 from public.vendor_busy_dates where vendor_id=l.vendor_identity) then return false;end if;
      end loop;
      return true;
    end $$;
    create function legacy_calendar_bounds_scrub_erased_person(p_person uuid) returns boolean language plpgsql volatile as $$
    declare tomb uuid;changed integer;
    begin
      if p_person is null or exists(select 1 from public.users where id=p_person) then
        perform public.legacy_calendar_bounds_fail('Person must be actually erased','legacy_calendar_bounds_immutable');end if;
      if not exists(select 1 from public.resource_conflict_keys where kind='person' and identity=p_person) then return false;end if;
      -- Root's erasure already holds the full union. Raw fallback never waits for earlier locks.
      perform public.legacy_calendar_bounds_require_scope(jsonb_build_object('personIds',jsonb_build_array(p_person),'mode','erase'));
      if not public.legacy_calendar_bounds_person_orphan(p_person) then return false;end if;
      tomb:=substr(encode(pg_catalog.sha256(convert_to('legacy-calendar-erased-person/1:'||p_person::text,'UTF8')),'hex'),1,32)::uuid;
      if tomb=p_person or exists(select 1 from public.resource_conflict_keys where identity=tomb)
        or exists(select 1 from public.legacy_calendar_person_links where person_identity=tomb)
        or not public.legacy_calendar_bounds_person_orphan(tomb) then
        perform public.legacy_calendar_bounds_fail('Erased person pseudonym collision','legacy_calendar_bounds_immutable');end if;
      -- Keep the old mutex until every guarded orphan link has moved. No key is deleted.
      update public.legacy_calendar_person_links set person_identity=tomb where person_identity=p_person;
      update public.resource_conflict_keys set identity=tomb where kind='person' and identity=p_person;
      get diagnostics changed=row_count;
      if changed<>1 then perform public.legacy_calendar_bounds_fail('Erased person key changed','legacy_calendar_bounds_immutable');end if;
      return true;
    end $$;
    create function protect_legacy_calendar_person_link() returns trigger language plpgsql as $$
    declare valid boolean;
    begin
      if TG_OP='UPDATE' then
        if OLD.person_identity is null or NEW.person_identity is null
          or (to_jsonb(NEW)-'person_identity') is distinct from (to_jsonb(OLD)-'person_identity')
          or NEW.person_identity is distinct from substr(encode(pg_catalog.sha256(convert_to('legacy-calendar-erased-person/1:'||OLD.person_identity::text,'UTF8')),'hex'),1,32)::uuid
          or NEW.person_identity=OLD.person_identity then
          perform legacy_calendar_bounds_fail('Known person association history is immutable','legacy_calendar_bounds_immutable');end if;
        -- Lock the actual old-person closure before fresh semantic checks. This raw
        -- row-level fallback is NOWAIT and cannot add a waiting earlier parent.
        perform public.legacy_calendar_bounds_require_scope(jsonb_build_object('personIds',jsonb_build_array(OLD.person_identity),'mode','erase'));
        if not public.legacy_calendar_bounds_person_orphan(OLD.person_identity)
          or exists(select 1 from public.resource_conflict_keys where identity=NEW.person_identity)
          or not public.legacy_calendar_bounds_person_orphan(NEW.person_identity) then
          perform legacy_calendar_bounds_fail('Known person association history is immutable','legacy_calendar_bounds_immutable');end if;
        return NEW;
      end if;
      if TG_OP<>'INSERT' then perform legacy_calendar_bounds_fail('Known person association history is immutable','legacy_calendar_bounds_immutable');end if;
      valid:=case NEW.origin_kind
        when 'owner' then exists(select 1 from vendors v where v.id=NEW.vendor_identity and v.id=NEW.origin_id and v.user_id=NEW.person_identity)
        when 'accepted_staff' then exists(select 1 from vendor_staff_members m where m.vendor_id=NEW.vendor_identity and m.id=NEW.origin_id and m.accepted_at is not null and
          (m.user_id is not distinct from NEW.person_identity or(m.user_id is null and exists(select 1 from vendor_resources r where r.staff_member_id=m.id and r.kind='person' and r.conflict_identity=NEW.person_identity))))
        when 'person_resource' then exists(select 1 from vendor_resources r where r.vendor_id=NEW.vendor_identity and r.id=NEW.origin_id and r.kind='person' and r.conflict_identity=NEW.person_identity)
        when 'duty' then exists(select 1 from vendor_staff_duties d join vendor_staff_members m on m.id=d.member_id where d.vendor_id=NEW.vendor_identity and d.id=NEW.origin_id and m.accepted_at is not null and
          (m.user_id is not distinct from NEW.person_identity or(m.user_id is null and exists(select 1 from vendor_resources r where r.vendor_id=d.vendor_id and r.staff_member_id=m.id and r.kind='person' and r.conflict_identity=NEW.person_identity))))
        when 'bounds_certificate' then exists(select 1 from resource_occupancy_origin_certificates c where c.vendor_identity=NEW.vendor_identity and c.id=NEW.origin_id and c.canonical::jsonb->'persons' @> jsonb_build_array(NEW.person_identity))
        else false end;
      if valid is not true then perform legacy_calendar_bounds_fail('Association needs actual native source evidence');end if;
      perform legacy_calendar_bounds_assert_person_links(case when NEW.person_identity is null then '{}'::uuid[] else array[NEW.person_identity] end,array[NEW.vendor_identity]);
      NEW.observed_at:=clock_timestamp();return NEW;
    end $$;
    create function legacy_calendar_bounds_observe_link(vendor uuid,person uuid,origin text,origin_id uuid) returns void language plpgsql volatile as $$
    begin
      if exists(select 1 from legacy_calendar_person_links l where l.vendor_identity=vendor and l.person_identity is not distinct from person
        and l.origin_kind=origin and l.origin_id=legacy_calendar_bounds_observe_link.origin_id) then return;end if;
      if person is null and origin='accepted_staff' then
        select case when count(distinct r.conflict_identity)=1 then min(r.conflict_identity::text)::uuid else null end into person
          from vendor_resources r where r.vendor_id=vendor and r.staff_member_id=origin_id and r.kind='person';
      end if;
      if person is null and origin='duty' then
        select case when count(distinct r.conflict_identity)=1 then min(r.conflict_identity::text)::uuid else null end into person
          from vendor_staff_duties d join vendor_resources r on r.vendor_id=d.vendor_id and r.staff_member_id=d.member_id and r.kind='person' where d.id=origin_id;
      end if;
      insert into legacy_calendar_person_links(vendor_identity,person_identity,origin_kind,origin_id,unknown_identity)
        values(vendor,person,origin,origin_id,person is null) on conflict do nothing;
    end $$;
    create function legacy_calendar_bounds_observe() returns trigger language plpgsql as $$
    declare j jsonb;r record;person jsonb;
    begin
      j:=case when TG_OP='DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
      if TG_TABLE_NAME='users' then
        if TG_OP='INSERT' then insert into resource_conflict_keys(kind,identity) values('person',NEW.id) on conflict do nothing;
        elsif TG_OP='DELETE' then
          for r in select id,user_id from vendors where user_id=OLD.id loop perform legacy_calendar_bounds_observe_link(r.id,r.user_id,'owner',r.id);end loop;
          for r in select id,vendor_id,user_id from vendor_staff_members where user_id=OLD.id and accepted_at is not null loop perform legacy_calendar_bounds_observe_link(r.vendor_id,r.user_id,'accepted_staff',r.id);end loop;
        end if;
      elsif TG_TABLE_NAME='vendors' then
        perform legacy_calendar_bounds_observe_link((j->>'id')::uuid,(j->>'user_id')::uuid,'owner',(j->>'id')::uuid);
      elsif TG_TABLE_NAME='vendor_staff_members' then
        if j->>'accepted_at' is not null then perform legacy_calendar_bounds_observe_link((j->>'vendor_id')::uuid,(j->>'user_id')::uuid,'accepted_staff',(j->>'id')::uuid);end if;
      elsif TG_TABLE_NAME='vendor_resources' then
        if TG_OP='INSERT' then insert into resource_conflict_keys(kind,identity) values(NEW.kind,NEW.conflict_identity) on conflict do nothing;end if;
        if j->>'kind'='person' and j->>'vendor_id' is not null then perform legacy_calendar_bounds_observe_link((j->>'vendor_id')::uuid,(j->>'conflict_identity')::uuid,'person_resource',(j->>'id')::uuid);end if;
      elsif TG_TABLE_NAME='vendor_staff_duties' then
        select * into r from vendor_staff_members where id=(j->>'member_id')::uuid and accepted_at is not null;
        if found then perform legacy_calendar_bounds_observe_link((j->>'vendor_id')::uuid,r.user_id,'duty',(j->>'id')::uuid);end if;
      elsif TG_TABLE_NAME='resource_occupancy_origin_certificates' then
        for person in select value from jsonb_array_elements(NEW.canonical::jsonb->'persons') loop perform legacy_calendar_bounds_observe_link(NEW.vendor_identity,(person#>>'{}')::uuid,'bounds_certificate',NEW.id);end loop;
      elsif TG_TABLE_NAME='legacy_calendar_sources' then
        insert into legacy_calendar_bounds_heads(source_id) values(NEW.id) on conflict do nothing;
      end if;
      return case when TG_OP='DELETE' then OLD else NEW end;
    end $$;
  `)
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_inserted_in_transaction(p_table text,p_id uuid) returns boolean language plpgsql stable as $$
    declare result boolean;
    begin
      if p_table<>all(array['offer_requests','deals','slots','deal_orders','vendor_staff_members','vendor_resources','resource_capacity_windows','resource_allocations','legacy_calendar_sources','vendor_busy_dates'])
        or to_regclass('pg_temp.legacy_calendar_bounds_births') is null then return false;end if;
      execute 'select exists(select 1 from pg_temp.legacy_calendar_bounds_births where table_name=$1 and row_id=$2 and transaction_id=txid_current() and backend_pid=pg_backend_pid())'
        into result using p_table,p_id;
      return result;
    end $$;
    create function legacy_calendar_bounds_record_birth() returns trigger language plpgsql as $$
    declare row_id uuid;
    begin
      if TG_OP<>'INSERT' or TG_TABLE_NAME<>all(array['offer_requests','deals','slots','deal_orders','vendor_staff_members','vendor_resources','resource_capacity_windows','resource_allocations','legacy_calendar_sources','vendor_busy_dates']) then
        perform legacy_calendar_bounds_fail('Birth proof requires actual allowed-table INSERT','legacy_calendar_bounds_scope');end if;
      row_id:=case when TG_TABLE_NAME='deal_orders' then (to_jsonb(NEW)->>'deal_id')::uuid else(to_jsonb(NEW)->>'id')::uuid end;
      create temporary table if not exists pg_temp.legacy_calendar_bounds_births(
        table_name text not null,row_id uuid not null,transaction_id bigint not null,backend_pid integer not null,
        primary key(table_name,row_id,transaction_id,backend_pid)
      ) on commit delete rows;
      insert into pg_temp.legacy_calendar_bounds_births(table_name,row_id,transaction_id,backend_pid)
        values(TG_TABLE_NAME,row_id,txid_current(),pg_backend_pid()) on conflict do nothing;
      return NEW;
    end $$;
    create function legacy_calendar_bounds_original_day_options(p_source uuid,p_deal uuid default null) returns date[] language plpgsql stable as $$
    declare src legacy_calendar_sources%rowtype;inv jsonb;result date[];
    begin
      select * into src from legacy_calendar_sources where id=p_source;
      if not found or not legacy_calendar_present(src) then return '{}'::date[];end if;
      inv:=legacy_calendar_current_inventory_material(src);
      if inv->>'completeness'<>'complete' then return '{}'::date[];end if;
      if p_deal is not null and not exists(select 1 from jsonb_array_elements(inv->'holders') h where h->>'dealId'=p_deal::text) then return '{}'::date[];end if;
      if src.day_id is not null then
        select array[b.date] into result from vendor_busy_dates b where b.id=src.day_id and b.vendor_id=src.vendor_id and b.date=(src.origin->>'date')::date;
        return coalesce(result,'{}'::date[]);
      end if;
      if src.kind<>'app_root' or(p_deal is not null and p_deal<>src.root_deal_id) then return '{}'::date[];end if;
      select array_agg(day_date order by day_date) into result from(
        select distinct b.date day_date from legacy_calendar_day_ids(src) day(day_id) join vendor_busy_dates b on b.id=day.day_id
        where exists(select 1 from legacy_day_known_holders(b.id) k where k.deal_id=src.root_deal_id and k.wedding_id=src.wedding_id and k.vendor_id=src.vendor_id)
      ) x;
      return coalesce(result,'{}'::date[]);
    end $$;
    create function legacy_calendar_bounds_association_prefix() returns trigger language plpgsql as $$
    declare vendor_ids uuid[];person_ids uuid[];member record;
    begin
      if TG_TABLE_NAME='vendors' then
        if TG_OP='UPDATE' and NEW.user_id is not distinct from OLD.user_id then return NEW;end if;
        vendor_ids:=array[NEW.id];person_ids:=array[NEW.user_id];
        if TG_OP='UPDATE' then person_ids:=legacy_day_uuid_set(person_ids||array[OLD.user_id]);end if;
      elsif TG_TABLE_NAME='vendor_staff_members' then
        if NEW.accepted_at is null or (TG_OP='UPDATE' and OLD.accepted_at is not null and(NEW.user_id is null or NEW.user_id is not distinct from OLD.user_id)) then return NEW;end if;
        vendor_ids:=array[NEW.vendor_id];person_ids:=case when NEW.user_id is null then '{}'::uuid[] else array[NEW.user_id] end;
      elsif TG_TABLE_NAME='vendor_resources' then
        if NEW.kind<>'person' or NEW.vendor_id is null then return NEW;end if;
        if TG_OP='UPDATE' and row(NEW.vendor_id,NEW.conflict_identity,NEW.person_user_id,NEW.staff_member_id) is not distinct from row(OLD.vendor_id,OLD.conflict_identity,OLD.person_user_id,OLD.staff_member_id) then return NEW;end if;
        vendor_ids:=array[NEW.vendor_id];person_ids:=array[NEW.conflict_identity];
      elsif TG_TABLE_NAME='vendor_staff_duties' then
        if TG_OP='UPDATE' and row(NEW.vendor_id,NEW.member_id,NEW.wedding_id,NEW.deal_id) is not distinct from row(OLD.vendor_id,OLD.member_id,OLD.wedding_id,OLD.deal_id) then return NEW;end if;
        select vendor_id,user_id into member from vendor_staff_members where id=NEW.member_id and accepted_at is not null;
        vendor_ids:=legacy_day_uuid_set(array[NEW.vendor_id,member.vendor_id]);person_ids:=case when member.user_id is null then '{}'::uuid[] else array[member.user_id] end;
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(NEW.wedding_id),'vendorIds',to_jsonb(vendor_ids),'personIds',to_jsonb(person_ids)));
      else perform legacy_calendar_bounds_fail('Unknown association source','legacy_calendar_bounds_scope');end if;
      perform legacy_calendar_bounds_assert_person_links(person_ids,vendor_ids);
      return NEW;
    end $$;
    create function legacy_calendar_bounds_assert_date_booking(p_vendor uuid,p_deal uuid default null) returns void language plpgsql volatile as $$
    declare people uuid[];other_vendors uuid[];weddings uuid[];
    begin
      people:=legacy_calendar_bounds_ids(legacy_calendar_bounds_known_person_scope(p_vendor)->'identities');
      select legacy_day_uuid_set(array_agg(wedding_id)) into weddings from deals where id=p_deal;
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('vendorIds',to_jsonb(array[p_vendor]),'weddingIds',to_jsonb(weddings),'personIds',to_jsonb(people)));
      select legacy_day_uuid_set(array_agg(id)) into other_vendors from(
        select id from vendors where user_id=any(people) and id<>p_vendor
        union select vendor_id from vendor_resources where kind='person' and conflict_identity=any(people) and vendor_id is not null and vendor_id<>p_vendor
        union select vendor_id from vendor_staff_members where user_id=any(people) and accepted_at is not null and vendor_id<>p_vendor
        union select vendor_identity from legacy_calendar_person_links where person_identity=any(people) and vendor_identity<>p_vendor
        union select c.vendor_identity from resource_occupancy o join resource_occupancy_origin_certificates c on c.id=o.certificate_id
          where o.released_at is null and o.conflict_identity=any(people) and c.vendor_identity<>p_vendor
      ) x;
      if exists(select 1 from resource_occupancy o where o.released_at is null and
          (o.vendor_identity=p_vendor or(o.conflict_identity=any(people) and o.vendor_identity<>p_vendor)))
        or exists(select 1 from legacy_calendar_sources s where s.vendor_id=any(other_vendors) and legacy_calendar_present(s)
          and(legacy_calendar_bounds_current_effect(s.id)->>'state'='unresolved' or legacy_calendar_bounds_current_effect(s.id)->>'freshness'<>'current')) then
        perform legacy_calendar_bounds_fail('DATE cannot represent retained common promises; use an explicit resource plan','resource_booking_required');end if;
    end $$;
    create function legacy_calendar_bounds_date_prefix() returns trigger language plpgsql as $$
    begin
      -- ON CONFLICT observation of an existing physical DATE changes no promise here.
      -- A genuinely new financial root is independently fenced by the deals trigger below.
      if not exists(select 1 from vendor_busy_dates b where b.vendor_id=NEW.vendor_id and b.date=NEW.date) then
        perform legacy_calendar_bounds_assert_date_booking(NEW.vendor_id,NEW.deal_id);end if;
      return NEW;
    end $$;
    create function legacy_calendar_bounds_financial_prefix() returns trigger language plpgsql as $$
    begin
      if NEW.vendor_id is null or NEW.state not in('booked','paid_deposit','done') then return NEW;end if;
      if TG_OP='UPDATE' and OLD.state in('booked','paid_deposit','done') and OLD.vendor_id is not distinct from NEW.vendor_id then return NEW;end if;
      if exists(select 1 from deal_resource_commitments h where h.wedding_id=NEW.wedding_id and h.deal_id=NEW.id and h.revision>0) then return NEW;end if;
      perform legacy_calendar_bounds_assert_date_booking(NEW.vendor_id,NEW.id);
      return NEW;
    end $$;
    create function check_legacy_calendar_bounds_complete() returns trigger language plpgsql as $$
    declare v record;r record;e record;c record;h record;source jsonb;
    begin
      -- Only newly written proposal/read/activation evidence rechecks current auth/input.
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' and TG_OP='INSERT' then
        select x.* into v from legacy_calendar_bounds_versions x where x.id=NEW.id;
        if found then
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not exists(select 1 from legacy_calendar_bounds_heads hd where hd.source_id=v.source_id and hd.proposed_version>=v.version)
          or not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',v.created_by,v.created_session_id,v.policy_version)
          or (not exists(select 1 from legacy_calendar_bounds_heads hd where hd.proposed_version_id=v.id)
            and not exists(select 1 from legacy_calendar_bounds_versions nx where nx.source_id=v.source_id and nx.previous_version_id=v.id)) then perform legacy_calendar_bounds_fail('New proposal graph must finish complete/current');end if;
        end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_receipts' and TG_OP='INSERT' then
        select x.* into r from legacy_calendar_bounds_receipts x where x.id=NEW.id;
        if found then
        select * into h from legacy_calendar_bounds_holders where id=r.holder_id;
        select * into v from legacy_calendar_bounds_versions where id=r.bounds_version_id;
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,r.party,r.user_id,r.session_id,r.policy_version) then perform legacy_calendar_bounds_fail('New receipt must finish with current exact party/material');end if;
        end if;
      end if;
      for e in select id from legacy_calendar_resolution_events where action='activate' and transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_applied(e.id);end loop;
      if TG_TABLE_NAME='resource_occupancy_origin_certificates' then
        perform legacy_calendar_bounds_assert_certificate(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(OLD.certificate_id);end if;
        if TG_OP<>'DELETE' and NEW.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(NEW.certificate_id);end if;
      end if;
      if TG_TABLE_NAME='resource_allocations' then
        perform legacy_calendar_bounds_assert_mirror(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(OLD.allocation_id);end if;
        if TG_OP<>'DELETE' and NEW.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(NEW.allocation_id);end if;
      end if;
      for e in select id from legacy_calendar_initial_commit_witnesses where transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_initial(e.id);end loop;
      -- Old committed proofs become conservatively stale, never rejected just for logout/input evolution.
      -- No live FK/source loss ever releases retained certificates.
      return null;
    end $$;
    create function legacy_calendar_bounds_cancel_trace() returns trigger language plpgsql as $$
    declare old_effect record;e_id uuid;
    begin
      if NEW.state<>'cancelled' or OLD.state='cancelled' then return NEW;end if;
      for old_effect in select distinct v.source_id,v.id version_id,hd.effective_event_id from legacy_calendar_bounds_holders h
        join legacy_calendar_bounds_versions v on v.id=h.bounds_version_id join legacy_calendar_bounds_heads hd on hd.source_id=v.source_id
        join legacy_calendar_resolution_events e on e.id=hd.effective_event_id and e.bounds_version_id=v.id and e.action='activate'
        where h.deal_id=NEW.id and h.wedding_id=NEW.wedding_id loop
        e_id:=gen_random_uuid();
        insert into legacy_calendar_resolution_events(id,source_id,bounds_version_id,action,previous_event_id,reason,material)
          values(e_id,old_effect.source_id,old_effect.version_id,'holder_cancelled',old_effect.effective_event_id,'actual_cancel',jsonb_build_object('dealId',NEW.id));
        update resource_occupancy o set released_at=clock_timestamp(),release_reason='holder_cancelled',release_event_id=e_id
          from resource_occupancy_origin_certificates c where c.id=o.certificate_id and c.source_identity=old_effect.source_id and o.released_at is null
            and exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line join jsonb_array_elements(c.canonical::jsonb->'ranges') range
              on range->'ownerKey'=line->'ownerKey' where(line->>'lineIndex')::int=o.origin_line_index and range->>'dealId'=NEW.id::text and range->>'weddingId'=NEW.wedding_id::text);
      end loop;
      return NEW;
    end $$;
    create index legacy_calendar_bounds_events_transaction on legacy_calendar_resolution_events(transaction_id,backend_pid);
    create index legacy_calendar_bounds_witness_transaction on legacy_calendar_initial_commit_witnesses(transaction_id,backend_pid);

    -- Technical backfills only: no DATE/order/financial/allocation/counter mutation.
    insert into resource_conflict_keys(kind,identity)
      select 'person',id from users union select kind,conflict_identity from vendor_resources
      union select kind,conflict_identity from resource_allocations on conflict do nothing;
    insert into legacy_calendar_bounds_heads(source_id) select id from legacy_calendar_sources;
    insert into legacy_calendar_person_links(vendor_identity,person_identity,origin_kind,origin_id,unknown_identity)
      select id,user_id,'owner',id,false from vendors
      union all select m.vendor_id,resolved.person_id,'accepted_staff',m.id,resolved.person_id is null
        from vendor_staff_members m cross join lateral(select coalesce(m.user_id,(select case when count(distinct r.conflict_identity)=1 then min(r.conflict_identity::text)::uuid else null end
          from vendor_resources r where r.vendor_id=m.vendor_id and r.staff_member_id=m.id and r.kind='person')) person_id) resolved where m.accepted_at is not null
      union all select vendor_id,conflict_identity,'person_resource',id,false from vendor_resources where kind='person' and vendor_id is not null
      union all select d.vendor_id,resolved.person_id,'duty',d.id,resolved.person_id is null from vendor_staff_duties d join vendor_staff_members m on m.id=d.member_id
        cross join lateral(select coalesce(m.user_id,(select case when count(distinct r.conflict_identity)=1 then min(r.conflict_identity::text)::uuid else null end
          from vendor_resources r where r.vendor_id=d.vendor_id and r.staff_member_id=m.id and r.kind='person')) person_id) resolved where m.accepted_at is not null
      on conflict do nothing;
    insert into resource_occupancy(id,origin_kind,origin_id,origin_version_id,origin_line_index,allocation_id,vendor_identity,kind,conflict_identity,resource_id,capacity_window_id,quantity,
      occupied_starts_at,occupied_ends_at,enforcement,released_at,release_reason)
      select gen_random_uuid(),'commitment',id,origin_version_id,origin_line_index,id,vendor_id,kind,conflict_identity,resource_id,capacity_window_id,quantity,
        occupied_starts_at,occupied_ends_at,'exclusive',released_at,release_reason from resource_allocations;
  `)
  for (const table of ['legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans','legacy_calendar_bounds_person_scope',
    'legacy_calendar_bounds_receipts','legacy_calendar_bounds_heads','legacy_calendar_resolution_events','legacy_calendar_resolution_holders','legacy_calendar_initial_commit_witnesses']) {
    pgm.sql(`create trigger protect_${table} before insert or update or delete on ${table} for each row execute function protect_legacy_calendar_bounds_history();`)
  }
  pgm.sql(`
    create trigger aaa_legacy_calendar_bounds_date before insert on vendor_busy_dates for each row execute function legacy_calendar_bounds_date_prefix();
    create trigger aaa_legacy_calendar_bounds_financial after insert or update of state,vendor_id on deals for each row execute function legacy_calendar_bounds_financial_prefix();
    create trigger protect_legacy_calendar_person_link before insert or update or delete on legacy_calendar_person_links for each row execute function protect_legacy_calendar_person_link();
    create trigger protect_legacy_calendar_bounds_certificate before insert or update or delete on resource_occupancy_origin_certificates for each row execute function protect_legacy_calendar_bounds_certificate();
    create trigger guard_resource_occupancy_origin before insert or update or delete on resource_occupancy for each row execute function protect_resource_occupancy_origin();
    create trigger aaa_legacy_calendar_bounds_allocation before insert on resource_allocations for each row execute function legacy_calendar_bounds_allocation_prefix();
    create trigger maintain_resource_occupancy_mirror after insert or update on resource_allocations for each row execute function maintain_resource_occupancy_mirror();
    create trigger legacy_calendar_bounds_cancel_trace after update of state on deals for each row execute function legacy_calendar_bounds_cancel_trace();
  `)
  for (const table of ['vendors','vendor_staff_members','vendor_resources','vendor_staff_duties']) {
    pgm.sql(`create trigger aaa_legacy_calendar_bounds_association before insert or update on ${table} for each row execute function legacy_calendar_bounds_association_prefix();`)
  }
  // AFTER INSERT only, installed AFTER backfill: UPDATE xmin is never birth evidence.
  for (const table of ['offer_requests','deals','slots','deal_orders','vendor_staff_members','vendor_resources','resource_capacity_windows','resource_allocations','legacy_calendar_sources','vendor_busy_dates']) {
    pgm.sql(`create trigger aaa_legacy_calendar_bounds_birth after insert on ${table} for each row execute function legacy_calendar_bounds_record_birth();`)
  }
  for (const [table,timing,events] of [
    ['users','after','insert'],['users','before','delete'],['vendors','after','insert or update'],['vendors','before','delete'],
    ['vendor_staff_members','after','insert or update'],['vendor_staff_members','before','delete'],
    ['vendor_resources','after','insert or update'],['vendor_resources','before','delete'],
    ['vendor_staff_duties','after','insert or update'],['vendor_staff_duties','before','delete'],
    ['resource_occupancy_origin_certificates','after','insert'],['legacy_calendar_sources','after','insert']
  ]) {
    pgm.sql(`create trigger legacy_calendar_bounds_observe_${timing}_${table} ${timing} ${events} on ${table} for each row execute function legacy_calendar_bounds_observe();`)
  }
  for (const table of [
    'legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans','legacy_calendar_bounds_person_scope','legacy_calendar_bounds_receipts',
    'legacy_calendar_bounds_heads','legacy_calendar_resolution_events','legacy_calendar_resolution_holders','legacy_calendar_person_links','resource_occupancy_origin_certificates',
    'resource_occupancy','legacy_calendar_initial_commit_witnesses','resource_allocations','deal_resource_commitments','deal_resource_commitment_versions','deal_resource_commitment_members',
    'legacy_calendar_sources','legacy_calendar_versions','legacy_calendar_version_holders','legacy_calendar_heads','legacy_day_groups','deal_day_scope_heads','deal_day_scope_versions',
    'weddings','wedding_events','slots','deals','deal_orders','order_assignments','order_parts','deal_terms_versions','deal_terms_receipts','deal_resource_plan_versions',
    'offer_requests','offers','vendor_resources','vendor_staff_members','vendor_staff_duties','vendor_availability_policy','resource_capacity_windows',
    'vendors','users','sessions','consents','wedding_members','payments','payment_installments','payment_receipts','payment_corrections','payment_installment_edits'
  ]) {
    pgm.sql(`create constraint trigger check_legacy_calendar_bounds_complete after insert or update or delete on ${table}
      deferrable initially deferred for each row execute function check_legacy_calendar_bounds_complete();`)
  }
}

exports.down = pgm => {
  pgm.sql(String.raw`
    set local lock_timeout='5s';
    lock table legacy_calendar_bounds_versions,legacy_calendar_bounds_holders,legacy_calendar_bounds_spans,legacy_calendar_bounds_person_scope,
      legacy_calendar_bounds_receipts,legacy_calendar_bounds_heads,legacy_calendar_resolution_events,legacy_calendar_resolution_holders,legacy_calendar_person_links,
      resource_occupancy_origin_certificates,resource_occupancy,legacy_calendar_initial_commit_witnesses in access exclusive mode;
    do $$ begin
      if exists(select 1 from legacy_calendar_bounds_versions) or exists(select 1 from legacy_calendar_bounds_holders)
        or exists(select 1 from legacy_calendar_bounds_spans) or exists(select 1 from legacy_calendar_bounds_person_scope)
        or exists(select 1 from legacy_calendar_bounds_receipts) or exists(select 1 from legacy_calendar_resolution_events)
        or exists(select 1 from legacy_calendar_resolution_holders) or exists(select 1 from legacy_calendar_person_links)
        or exists(select 1 from resource_occupancy_origin_certificates) or exists(select 1 from resource_occupancy)
        or exists(select 1 from legacy_calendar_initial_commit_witnesses) or exists(select 1 from legacy_calendar_bounds_heads where revision<>0) then
        raise exception 'Bounds evidence exists; use preserving forward migration' using errcode='23514',constraint='legacy_calendar_bounds_preserving_down';
      end if;
    end $$;
  `)
  // The preserving evidence gate above must succeed before either old body is restored.
  pgm.sql(legacyDayCorrectionSQL(false, true))
  for (const table of [
    'legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans','legacy_calendar_bounds_person_scope','legacy_calendar_bounds_receipts',
    'legacy_calendar_bounds_heads','legacy_calendar_resolution_events','legacy_calendar_resolution_holders','legacy_calendar_person_links','resource_occupancy_origin_certificates',
    'resource_occupancy','legacy_calendar_initial_commit_witnesses','resource_allocations','deal_resource_commitments','deal_resource_commitment_versions','deal_resource_commitment_members',
    'legacy_calendar_sources','legacy_calendar_versions','legacy_calendar_version_holders','legacy_calendar_heads','legacy_day_groups','deal_day_scope_heads','deal_day_scope_versions',
    'weddings','wedding_events','slots','deals','deal_orders','order_assignments','order_parts','deal_terms_versions','deal_terms_receipts','deal_resource_plan_versions',
    'offer_requests','offers','vendor_resources','vendor_staff_members','vendor_staff_duties','vendor_availability_policy','resource_capacity_windows',
    'vendors','users','sessions','consents','wedding_members','payments','payment_installments','payment_receipts','payment_corrections','payment_installment_edits'
  ]) pgm.sql(`drop trigger check_legacy_calendar_bounds_complete on ${table};`)
  for (const [table,timing] of [['users','after'],['users','before'],['vendors','after'],['vendors','before'],['vendor_staff_members','after'],['vendor_staff_members','before'],
    ['vendor_resources','after'],['vendor_resources','before'],['vendor_staff_duties','after'],['vendor_staff_duties','before'],['resource_occupancy_origin_certificates','after'],['legacy_calendar_sources','after']]) {
    pgm.sql(`drop trigger legacy_calendar_bounds_observe_${timing}_${table} on ${table};`)
  }
  pgm.sql(`
    drop trigger aaa_legacy_calendar_bounds_date on vendor_busy_dates;
    drop trigger aaa_legacy_calendar_bounds_financial on deals;
    drop trigger legacy_calendar_bounds_cancel_trace on deals;
    drop trigger maintain_resource_occupancy_mirror on resource_allocations;
    drop trigger aaa_legacy_calendar_bounds_allocation on resource_allocations;
  `)
  for (const table of ['vendors','vendor_staff_members','vendor_resources','vendor_staff_duties']) {
    pgm.sql(`drop trigger aaa_legacy_calendar_bounds_association on ${table};`)
  }
  for (const table of ['offer_requests','deals','slots','deal_orders','vendor_staff_members','vendor_resources','resource_capacity_windows','resource_allocations','legacy_calendar_sources','vendor_busy_dates']) {
    pgm.sql(`drop trigger aaa_legacy_calendar_bounds_birth on ${table};`)
  }
  for (const table of ['legacy_calendar_bounds_versions','legacy_calendar_bounds_holders','legacy_calendar_bounds_spans','legacy_calendar_bounds_person_scope',
    'legacy_calendar_bounds_receipts','legacy_calendar_bounds_heads','legacy_calendar_resolution_events','legacy_calendar_resolution_holders','legacy_calendar_initial_commit_witnesses']) {
    pgm.sql(`drop trigger protect_${table} on ${table};`)
  }
  pgm.sql(`drop trigger protect_legacy_calendar_person_link on legacy_calendar_person_links;
    drop trigger protect_legacy_calendar_bounds_certificate on resource_occupancy_origin_certificates;
    drop trigger guard_resource_occupancy_origin on resource_occupancy;`)
  // All and only94 functions are named explicitly, before dropping their row types.
  pgm.sql(`drop function ${OWN_FUNCTIONS.join(',')};`)
  pgm.sql(`drop table resource_occupancy,resource_occupancy_origin_certificates,legacy_calendar_resolution_holders,legacy_calendar_bounds_heads,
    legacy_calendar_bounds_receipts,legacy_calendar_bounds_spans,legacy_calendar_bounds_person_scope,legacy_calendar_bounds_holders,
    legacy_calendar_resolution_events,legacy_calendar_bounds_versions,legacy_calendar_person_links,legacy_calendar_initial_commit_witnesses;`)
}
