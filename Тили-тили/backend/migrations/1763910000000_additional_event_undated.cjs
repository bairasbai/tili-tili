/* Schema93: prospective own-TZ undated catalog roots and agreed first DATE.
 * Applied87-92 remain literal; no backfill, inferred DATE or historical consent. */
exports.up = pgm => pgm.sql(`
    create or replace function deal_day_scope_shape_valid(v deal_day_scope_versions)
    returns boolean language sql immutable as $$
      select (
        v.schema_version=1 and v.revision>0
        and ((v.revision=1 and v.previous_version_id is null
            and v.origin_knowledge in ('observed_tracking','legacy_unknown')
            and v.operation in ('observe','acquire','observe_done'))
          or (v.revision>1 and v.previous_version_id is not null and v.origin_knowledge is null
            and v.operation in ('acquire','move','retain_done','release')))
        and v.context_kind in ('implicit_main','explicit_main','explicit_event','unknown')
        and (v.context_kind='unknown' or v.event_id is not null)
        and ((v.performer_kind='catalog' and v.vendor_id is not null)
          or (v.performer_kind in ('external','unknown') and v.vendor_id is null))
        and case v.binding_state
          when 'unknown' then v.day_id is null
          when 'undated' then v.performer_kind='catalog'
            and (v.context_kind in ('implicit_main','explicit_main') or (v.context_kind='explicit_event' and v.time_zone is not null))
            and v.service_date is null and v.day_id is null
          when 'external' then v.performer_kind='external' and v.day_id is null
          when 'active' then v.performer_kind='catalog' and v.context_kind<>'unknown'
            and v.service_date is not null and v.day_id is not null
            and (v.context_kind<>'explicit_event' or v.time_zone is not null)
          when 'done_retained' then v.performer_kind='catalog' and v.context_kind<>'unknown'
            and v.service_date is not null and v.day_id is not null
          when 'done_undated' then v.performer_kind='catalog'
            and (v.context_kind in ('implicit_main','explicit_main') or (v.context_kind='explicit_event' and v.time_zone is not null))
            and v.service_date is null and v.day_id is null
            and ((v.revision>1 and v.operation='retain_done') or (v.revision=1 and v.operation='observe_done' and v.origin_knowledge='legacy_unknown'))
          when 'released' then v.day_id is null
          else false end
        and (v.operation='observe'
          or (v.operation in ('acquire','move') and v.binding_state in ('active','undated','external'))
          or (v.operation='retain_done' and v.binding_state in ('done_retained','done_undated','external'))
          or (v.operation='release' and v.binding_state='released')
          or (v.operation='observe_done' and v.binding_state='done_undated' and v.revision=1
            and v.previous_version_id is null and v.origin_knowledge='legacy_unknown'))
      ) is true
    $$;

    create or replace function legacy_day_initial_done_valid(v deal_day_scope_versions) returns boolean language sql stable as $$
      select exists(select 1 from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
        join weddings w on w.id=d.wedding_id join wedding_events e on e.wedding_id=w.id
          and ((s.program_event_id is null and e.is_main) or e.id=s.program_event_id)
        where d.id=v.deal_id and d.wedding_id=v.wedding_id and d.state='done'
          and d.slot_id=v.slot_id and s.deal_id=d.id and d.vendor_id=v.vendor_id
          and exists(select 1 from vendors where id=v.vendor_id)
          and v.event_id=e.id and e.date is null and v.service_date is null and v.day_id is null
          and v.time_zone is not distinct from e.time_zone
          and ((e.is_main and w.date is null and v.time_zone is not distinct from w.tz
              and ((s.program_event_id is null and v.context_kind='implicit_main')
                or (s.program_event_id=e.id and v.context_kind='explicit_main')))
            or (not e.is_main and s.program_event_id=e.id and v.context_kind='explicit_event' and e.time_zone is not null)))
    $$;

    create or replace function offer_request_event_context_guard() returns trigger language plpgsql as $$
    declare actual jsonb; extra boolean;
    begin
      if TG_OP='UPDATE' then
        if row(new.program_event_context,new.slot_id,new.wedding_date) is distinct from
          row(old.program_event_context,old.slot_id,old.wedding_date) then
          raise exception 'offer request event snapshot is immutable' using errcode='23514',constraint='offer_request_event_context';
        end if;
        return new;
      end if;
      select jsonb_build_object('id',e.id,'isMain',s.program_event_id is null or e.is_main,
        'date',case when s.program_event_id is null or e.is_main then w.date else e.date end,
        'timeZone',case when s.program_event_id is null or e.is_main then w.tz else e.time_zone end,
        'name',e.name,'kind',e.kind,'location',e.location),
        s.program_event_id is not null and not coalesce(e.is_main,false)
      into actual,extra
      from slots s join weddings w on w.id=s.wedding_id left join wedding_events e
        on e.wedding_id=s.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
      where s.id=new.slot_id;
      if new.program_event_context is null then
        if extra then raise exception 'additional offer request needs event context' using errcode='23514',constraint='offer_request_event_context'; end if;
      elsif new.program_event_context is distinct from actual
        or new.wedding_date is distinct from (actual->>'date')::date
        or (extra and (actual->>'id' is null or actual->>'timeZone' is null)) then
        raise exception 'offer request needs exact current event context' using errcode='23514',constraint='offer_request_event_context';
      end if;
      return new;
    end $$;

    create or replace function event_move_scope_supported(material jsonb) returns boolean language plpgsql stable as $$
    declare root jsonb; d jsonb; item jsonb; obligation record; active_count int:=0;
    begin
      if event_move_snapshot_valid(material) is not true then return false; end if;
      -- A NULL source is a literal known-TZ context, never a fabricated DATE.
      if material->'event'->>'date' is null then
        if (jsonb_typeof(material->'event'->'date')='null'
          and jsonb_typeof(material->'event'->'time_zone')='string'
          and length(material->'event'->>'time_zone') between 1 and 128
          and material->'event'->>'time_zone' ~ '^[A-Za-z0-9_+/-]+$'
          and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=material->'event'->>'time_zone')
          and (jsonb_typeof(material->'event'->'location')='null' or
            (jsonb_typeof(material->'event'->'location')='string' and length(material->'event'->>'location')<=300))) is not true then return false; end if;
      elsif event_move_target_valid(jsonb_build_object('date',material->'event'->'date',
        'timeZone',material->'event'->'time_zone','location',material->'event'->'location')) is not true then return false; end if;
      if (material->'event'->>'is_main'='false'
        and material->'event'->>'time_zone' is not null) is not true then return false; end if;
      if material is null or jsonb_typeof(material)<>'object' or material->>'schemaVersion'<>'1'
        or material->'event'->>'is_main'<>'false' or material->'event'->>'time_zone' is null
        or jsonb_typeof(material->'roots')<>'array' or material->'event'->>'rsvp_deadline' is not null then return false; end if;
      -- The first agreed-move protocol cannot silently shift timed work, guest
      -- responses, staff duties, open quotes or existing program promises.
      for obligation in select key,value from jsonb_each(material->'eventObligations') loop
        if obligation.key='offer_requests' then
          if exists(select 1 from jsonb_array_elements(obligation.value) r where r->>'status' is distinct from 'closed') then return false; end if;
        elsif obligation.key<>'offers' and obligation.value<>'[]'::jsonb then return false;
        end if;
      end loop;
      for root in select value from jsonb_array_elements(material->'roots') loop
        if jsonb_array_length(root->'domain'->'deals')<>1 or jsonb_array_length(root->'domain'->'deal_orders')<>1 then return false; end if;
        d:=root->'domain'->'deals'->0;
        if exists(select 1 from jsonb_array_elements(root->'domain'->'order_parts') p where p->>'cancelled_at' is null)
          or exists(select 1 from jsonb_array_elements(root->'domain'->'order_assignments') a
            where a->>'cancelled_at' is null and a->>'program_event_id' is distinct from material->'event'->>'id')
          or exists(select 1 from jsonb_array_elements(root->'domain'->'deal_resource_commitments') c where (c->>'revision')::bigint>0)
          or root->'domain'->'resource_allocations'<>'[]' or root->'domain'->'vendor_live_allocations'<>'[]'
          or exists(select 1 from jsonb_array_elements(root->'domain'->'policy') p where p->>'mode'='resources')
          or root->'domain'->'vendor_staff_duties'<>'[]'::jsonb then return false; end if;
        if d->>'state'='cancelled' then
          if exists(select 1 from jsonb_array_elements(root->'domain'->'order_assignments') a where a->>'cancelled_at' is null) then return false; end if;
          continue;
        end if;
        -- Unknown historical money cannot become a known-price consent material.
        -- Zero remains a known amount; preserve the original deal without pricing it.
        if jsonb_typeof(d->'price') is distinct from 'number' then return false; end if;
        if (d->>'price')::numeric>9007199254740991 then return false; end if;
        if d->>'state' not in ('booked','paid_deposit') or d->>'vendor_id' is null or d->>'external_name' is not null
          or jsonb_array_length(root->'domain'->'vendor')<>1 or root->'domain'->'vendor'->0->>'deleted_at' is not null
          or root->'domain'->'vendor'->0->>'blocked_at' is not null
          or not exists(select 1 from jsonb_array_elements(material->'slots') s where s->>'id'=d->>'slot_id'
            and s->>'deal_id'=d->>'id' and s->>'program_event_id'=material->'event'->>'id')
          or jsonb_array_length(root->'day'->'heads')<>1 then return false; end if;
        select value into item from jsonb_array_elements(root->'day'->'versions') v
          where v->>'id'=root->'day'->'heads'->0->>'current_version_id';
        if (item is not null and item->>'context_kind'='explicit_event'
          and item->>'event_id'=material->'event'->>'id'
          and item->>'time_zone'=material->'event'->>'time_zone'
          and item->>'vendor_id'=d->>'vendor_id' and item->>'slot_id'=d->>'slot_id'
          and item->>'deal_id'=d->>'id' and item->>'wedding_id'=material->>'weddingId'
          and item->'revision'=root->'day'->'heads'->0->'revision'
          and ((material->'event'->>'date' is null and item->>'binding_state'='undated'
              and jsonb_typeof(item->'service_date')='null' and jsonb_typeof(item->'day_id')='null')
            or (material->'event'->>'date' is not null and item->>'binding_state'='active'
              and item->>'service_date'=material->'event'->>'date' and item->>'day_id' is not null
              and exists(select 1 from jsonb_array_elements(material->'physical'->'known') k where k=item)))) is not true then return false; end if;
        active_count:=active_count+1;
      end loop;
      return active_count>0;
    end $$;

    create or replace function event_move_expected_physical(before_image jsonb,wedding uuid,target jsonb,moves jsonb,generated jsonb)
    returns jsonb language plpgsql immutable as $$
    declare state jsonb; heads jsonb; known jsonb; move jsonb; b jsonb; g jsonb; fact jsonb; stamp jsonb;
      id text; representative text; remaining jsonb; target_ids text[];
    begin
      state:=jsonb_build_object('days',coalesce((select jsonb_object_agg(x->>'id',x) from jsonb_array_elements(before_image->'days') x),'{}'),
        'groups',coalesce((select jsonb_object_agg(x->>'day_id',x) from jsonb_array_elements(before_image->'groups') x),'{}'));
      select coalesce(jsonb_agg(x order by x->>'id'),'[]') into heads from (
        select x from jsonb_array_elements(before_image->'heads') x where not exists(
          select 1 from jsonb_array_elements(moves) m where m->>'dealId'=x->>'deal_id')
        union all select m->'version' from jsonb_array_elements(moves) m) expected(x);
      select coalesce(jsonb_agg(x order by x->>'id'),'[]') into known from (
        select x from jsonb_array_elements(before_image->'known') x where not exists(
          select 1 from jsonb_array_elements(moves) m where m->>'dealId'=x->>'deal_id')
        union all select m->'version' from jsonb_array_elements(moves) m) expected(x);
      -- The TS observer touches previous DATEs and only already-owned target
      -- DATEs, under the old context, before changing the event.
      for id in select m->>'previousDayId' from jsonb_array_elements(moves) m where m->>'previousDayId' is not null
        union select x->>'id' from jsonb_array_elements(before_image->'days') x
          join jsonb_array_elements(before_image->'facts') f on f->>'id'=x->>'id'
          where x->>'source'='deal' and x->>'date'=target->>'date' and f->>'weddingId'=wedding::text
            and exists(select 1 from jsonb_array_elements(moves) m where m->'version'->>'vendor_id'=x->>'vendor_id') loop
        if state->'groups'->id is not null then continue; end if;
        b:=state->'days'->id;
        select x into fact from jsonb_array_elements(before_image->'facts') x where x->>'id'=id;
        select x into stamp from jsonb_array_elements(generated->'groups') x where x->>'dayId'=id;
        g:=jsonb_build_object('day_id',id,'vendor_id',b->'vendor_id','service_date',b->'date','wedding_id',fact->'weddingId',
          'classification',case when fact->>'weddingId' is null then 'opaque' else 'legacy_unknown' end,
          'legacy_candidates',case when fact->>'weddingId' is null then '[]'::jsonb else fact->'initialCandidates' end,
          'revision',1,'classified_at',stamp->'classifiedAt');
        state:=jsonb_set(state,array['groups',id],g);
      end loop;
      for stamp in select x from jsonb_array_elements(generated->'days') x loop
        id:=stamp->>'id';
        select min(m->>'dealId') into representative from jsonb_array_elements(moves) m
          where m->'version'->>'vendor_id'=stamp->>'vendorId';
        b:=jsonb_build_object('id',id,'vendor_id',stamp->'vendorId','date',target->'date','source','deal',
          'deal_id',representative,'created_at',stamp->'createdAt','source_revision',1);
        state:=jsonb_set(state,array['days',id],b);
        select x into fact from jsonb_array_elements(generated->'groups') x where x->>'dayId'=id;
        g:=jsonb_build_object('day_id',id,'vendor_id',stamp->'vendorId','service_date',target->'date','wedding_id',wedding,
          'classification','exact','legacy_candidates','[]'::jsonb,'revision',1,'classified_at',fact->'classifiedAt');
        state:=jsonb_set(state,array['groups',id],g);
      end loop;
      -- Same order as the sole writer's sorted root plan. All new heads have
      -- already been published; an opaque remainder is never pruned.
      for move in select x from jsonb_array_elements(moves) x order by x->>'dealId' loop
        id:=move->>'previousDayId';g:=state->'groups'->id;
        if g is null then continue; end if;
        if g->>'classification'<>'opaque' and g->>'wedding_id'=wedding::text and g->'legacy_candidates' ? (move->>'dealId') then
          select coalesce(jsonb_agg(x order by x),'[]') into remaining from jsonb_array_elements_text(g->'legacy_candidates') x where x<>move->>'dealId';
          g:=g||jsonb_build_object('legacy_candidates',remaining,'revision',(g->>'revision')::bigint+1);
          state:=jsonb_set(state,array['groups',id],g);
        end if;
        state:=event_move_reconcile_projection(state,id::uuid,known,heads,before_image->'candidates',before_image->'outside');
      end loop;
      select array_agg(distinct m->'version'->>'day_id' order by m->'version'->>'day_id') into target_ids from jsonb_array_elements(moves) m;
      foreach id in array target_ids loop
        state:=event_move_reconcile_projection(state,id::uuid,known,heads,before_image->'candidates',before_image->'outside');
      end loop;
      return jsonb_build_object('vendors',before_image->'vendors',
        'days',coalesce((select jsonb_agg(value order by key) from jsonb_each(state->'days')),'[]'),
        'groups',coalesce((select jsonb_agg(value order by key) from jsonb_each(state->'groups')),'[]'),
        'heads',heads,'known',known,'candidates',before_image->'candidates','outside',before_image->'outside');
    end $$;

    create or replace function event_move_assert_applied(effect_id uuid) returns void language plpgsql as $$
    declare e event_move_effects%rowtype; p event_move_proposals%rowtype; actual jsonb; root jsonb; plan jsonb;
      h deal_day_scope_heads%rowtype; v deal_day_scope_versions%rowtype; previous jsonb; rows jsonb;
      moves jsonb:='[]'; expected_version jsonb;
    begin
      select * into e from event_move_effects where id=effect_id;
      if not found then raise exception 'New move effect disappeared before commit' using errcode='23514',constraint='event_move_complete'; end if;
      if e.action<>'apply' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from event_move_effects where id=e.id and legacy_day_transaction_owns(xmin)) then return; end if;
      select * into strict p from event_move_proposals where id=e.proposal_id;
      actual:=event_move_source_snapshot(e.wedding_id,e.event_id);
      if actual is null or event_move_domain(actual) is distinct from event_move_expected_domain(p.baseline,p.target,to_jsonb(e.created_at))
        or event_move_agreed(p.id,e.policy_version) is not true
        or not exists(select 1 from weddings w where w.id=e.wedding_id and w.timeline_updated_by=e.actor_id
          and w.timeline_updated_at>=e.created_at and w.timeline_updated_at<=clock_timestamp())
        or not event_move_principal_current(e.wedding_id,null,'customer',e.actor_id,e.session_id,e.policy_version) then
        raise exception 'Applied move must preserve complete domain and agreement' using errcode='23514',constraint='event_move_complete';
      end if;
      for root in select value from jsonb_array_elements(p.baseline->'roots') loop
        select coalesce(jsonb_agg(to_jsonb(x) order by x.revision),'[]') into rows from deal_day_scope_versions x
          where x.deal_id=(root->>'dealId')::uuid and x.id in(select (value->>'id')::uuid from jsonb_array_elements(root->'day'->'versions'));
        if rows is distinct from root->'day'->'versions' then
          raise exception 'Prior day evidence changed' using errcode='23514',constraint='event_move_complete';
        end if;
        if root->'domain'->'deals'->0->>'state'='cancelled' then
          if (select value->'day' from jsonb_array_elements(actual->'roots') where value->>'dealId'=root->>'dealId') is distinct from root->'day' then
            raise exception 'Cancelled history is outside move delta' using errcode='23514',constraint='event_move_complete';
          end if;
          continue;
        end if;
        select value into strict plan from jsonb_array_elements(e.planned_versions) where value->>'dealId'=root->>'dealId';
        select * into h from deal_day_scope_heads where wedding_id=p.wedding_id and deal_id=(root->>'dealId')::uuid;
        select * into v from deal_day_scope_versions where id=(plan->>'versionId')::uuid;
        if not found or h.current_version_id is distinct from v.id or h.revision is distinct from v.revision
          or event_move_version_allowed(v) is not true or legacy_day_version_new(v.id) is not true
          or deal_day_scope_matches_current(v) is not true
          or not exists(select 1 from legacy_day_known_holders(v.day_id) k where k.id=v.id)
          or (select count(*) from deal_day_scope_versions where deal_id=v.deal_id)<>jsonb_array_length(root->'day'->'versions')+1 then
          raise exception 'Every planned day version must be the exact final current holder' using errcode='23514',constraint='event_move_complete';
        end if;
        select value into strict previous from jsonb_array_elements(root->'day'->'versions') where value->>'id'=plan->>'previousVersionId';
        expected_version:=previous||jsonb_build_object('id',plan->'versionId','revision',(plan->>'revision')::bigint,
          'previous_version_id',plan->'previousVersionId','origin_knowledge',null,'operation','move','binding_state','active',
          'recorded_at',to_jsonb(v)->'recorded_at','service_date',p.target->'date','time_zone',p.target->'timeZone','day_id',v.day_id);
        if to_jsonb(v) is distinct from expected_version or v.recorded_at<e.created_at or v.recorded_at>clock_timestamp() then
          raise exception 'New version may change only the planned tuple and native clock' using errcode='23514',constraint='event_move_complete';
        end if;
        moves:=moves||jsonb_build_array(jsonb_build_object('dealId',root->'dealId','previousDayId',previous->'day_id','version',expected_version));
      end loop;
      perform event_move_assert_physical(e,p.baseline,p.target,moves,actual->'physical');
    end $$;
`);

exports.down = pgm => pgm.sql(`
    -- Lock every retained feature history before deciding whether old definitions
    -- are safe. ANY move evidence is deliberately stronger than NULL-only data.
    set local lock_timeout='5s';
    lock table deal_day_scope_versions,deal_day_scope_heads,offer_requests,
      event_move_proposals,event_move_roots,event_move_receipts,event_move_effects,audit_log
      in access exclusive mode;
    do $$ begin
      if exists(select 1 from deal_day_scope_versions where context_kind='explicit_event'
          and binding_state in ('undated','done_undated'))
        or exists(select 1 from offer_requests where program_event_context->>'isMain'='false'
          and jsonb_typeof(program_event_context->'date')='null')
        or exists(select 1 from event_move_proposals) or exists(select 1 from event_move_roots)
        or exists(select 1 from event_move_receipts) or exists(select 1 from event_move_effects)
        or exists(select 1 from audit_log where left(action,11)='event_move.'
          or (action='legacy_day.resolved' and diff->>'reason'='event_move')) then
        raise exception 'Additional undated or move evidence exists; use a preserving forward migration'
          using errcode='23514',constraint='additional_event_undated_preserving_down';
      end if;
    end $$;

    create or replace function deal_day_scope_shape_valid(v deal_day_scope_versions)
    returns boolean language sql immutable as $$
      select (
        v.schema_version=1 and v.revision>0
        and ((v.revision=1 and v.previous_version_id is null
            and v.origin_knowledge in ('observed_tracking','legacy_unknown')
            and v.operation in ('observe','acquire','observe_done'))
          or (v.revision>1 and v.previous_version_id is not null and v.origin_knowledge is null
            and v.operation in ('acquire','move','retain_done','release')))
        and v.context_kind in ('implicit_main','explicit_main','explicit_event','unknown')
        and (v.context_kind='unknown' or v.event_id is not null)
        and ((v.performer_kind='catalog' and v.vendor_id is not null)
          or (v.performer_kind in ('external','unknown') and v.vendor_id is null))
        and case v.binding_state
          when 'unknown' then v.day_id is null
          when 'undated' then v.performer_kind='catalog'
            and v.context_kind in ('implicit_main','explicit_main')
            and v.service_date is null and v.day_id is null
          when 'external' then v.performer_kind='external' and v.day_id is null
          when 'active' then v.performer_kind='catalog' and v.context_kind<>'unknown'
            and v.service_date is not null and v.day_id is not null
            and (v.context_kind<>'explicit_event' or v.time_zone is not null)
          when 'done_retained' then v.performer_kind='catalog' and v.context_kind<>'unknown'
            and v.service_date is not null and v.day_id is not null
          when 'done_undated' then v.performer_kind='catalog'
            and v.context_kind in ('implicit_main','explicit_main')
            and v.service_date is null and v.day_id is null
            and ((v.revision>1 and v.operation='retain_done') or (v.revision=1 and v.operation='observe_done' and v.origin_knowledge='legacy_unknown'))
          when 'released' then v.day_id is null
          else false end
        and (v.operation='observe'
          or (v.operation in ('acquire','move') and v.binding_state in ('active','undated','external'))
          or (v.operation='retain_done' and v.binding_state in ('done_retained','done_undated','external'))
          or (v.operation='release' and v.binding_state='released')
          or (v.operation='observe_done' and v.binding_state='done_undated' and v.revision=1
            and v.previous_version_id is null and v.origin_knowledge='legacy_unknown'))
      ) is true
    $$;

    create or replace function legacy_day_initial_done_valid(v deal_day_scope_versions) returns boolean language sql stable as $$
      select exists(select 1 from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
        join weddings w on w.id=d.wedding_id join wedding_events e on e.wedding_id=w.id and e.is_main
        where d.id=v.deal_id and d.wedding_id=v.wedding_id and d.state='done'
          and d.slot_id=v.slot_id and s.deal_id=d.id and d.vendor_id=v.vendor_id
          and exists(select 1 from vendors where id=v.vendor_id)
          and ((s.program_event_id is null and v.context_kind='implicit_main')
            or (s.program_event_id=e.id and v.context_kind='explicit_main'))
          and v.event_id=e.id and w.date is null and e.date is null and v.service_date is null and v.day_id is null
          and v.time_zone is not distinct from w.tz and v.time_zone is not distinct from e.time_zone)
    $$;

    create or replace function offer_request_event_context_guard() returns trigger language plpgsql as $$
    declare actual jsonb; extra boolean;
    begin
      if TG_OP='UPDATE' then
        if row(new.program_event_context,new.slot_id,new.wedding_date) is distinct from
          row(old.program_event_context,old.slot_id,old.wedding_date) then
          raise exception 'offer request event snapshot is immutable' using errcode='23514',constraint='offer_request_event_context';
        end if;
        return new;
      end if;
      select jsonb_build_object('id',e.id,'isMain',s.program_event_id is null or e.is_main,
        'date',case when s.program_event_id is null or e.is_main then w.date else e.date end,
        'timeZone',case when s.program_event_id is null or e.is_main then w.tz else e.time_zone end,
        'name',e.name,'kind',e.kind,'location',e.location),
        s.program_event_id is not null and not coalesce(e.is_main,false)
      into actual,extra
      from slots s join weddings w on w.id=s.wedding_id left join wedding_events e
        on e.wedding_id=s.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
      where s.id=new.slot_id;
      if new.program_event_context is null then
        if extra then raise exception 'additional offer request needs event context' using errcode='23514',constraint='offer_request_event_context'; end if;
      elsif new.program_event_context is distinct from actual
        or new.wedding_date is distinct from (actual->>'date')::date
        or (extra and (actual->>'id' is null or actual->>'date' is null or actual->>'timeZone' is null)) then
        raise exception 'offer request needs exact current event context' using errcode='23514',constraint='offer_request_event_context';
      end if;
      return new;
    end $$;

    create or replace function event_move_scope_supported(material jsonb) returns boolean language plpgsql stable as $$
    declare root jsonb; d jsonb; item jsonb; obligation record; active_count int:=0;
    begin
      if event_move_snapshot_valid(material) is not true then return false; end if;
      if event_move_target_valid(jsonb_build_object('date',material->'event'->'date',
        'timeZone',material->'event'->'time_zone','location',material->'event'->'location')) is not true then return false; end if;
      if (material->'event'->>'is_main'='false' and material->'event'->>'date' is not null
        and material->'event'->>'time_zone' is not null) is not true then return false; end if;
      if material is null or jsonb_typeof(material)<>'object' or material->>'schemaVersion'<>'1'
        or material->'event'->>'is_main'<>'false' or material->'event'->>'date' is null or material->'event'->>'time_zone' is null
        or jsonb_typeof(material->'roots')<>'array' or material->'event'->>'rsvp_deadline' is not null then return false; end if;
      -- The first agreed-move protocol cannot silently shift timed work, guest
      -- responses, staff duties, open quotes or existing program promises.
      for obligation in select key,value from jsonb_each(material->'eventObligations') loop
        if obligation.key='offer_requests' then
          if exists(select 1 from jsonb_array_elements(obligation.value) r where r->>'status' is distinct from 'closed') then return false; end if;
        elsif obligation.key<>'offers' and obligation.value<>'[]'::jsonb then return false;
        end if;
      end loop;
      for root in select value from jsonb_array_elements(material->'roots') loop
        if jsonb_array_length(root->'domain'->'deals')<>1 or jsonb_array_length(root->'domain'->'deal_orders')<>1 then return false; end if;
        d:=root->'domain'->'deals'->0;
        if exists(select 1 from jsonb_array_elements(root->'domain'->'order_parts') p where p->>'cancelled_at' is null)
          or exists(select 1 from jsonb_array_elements(root->'domain'->'order_assignments') a
            where a->>'cancelled_at' is null and a->>'program_event_id' is distinct from material->'event'->>'id')
          or exists(select 1 from jsonb_array_elements(root->'domain'->'deal_resource_commitments') c where (c->>'revision')::bigint>0)
          or root->'domain'->'resource_allocations'<>'[]' or root->'domain'->'vendor_live_allocations'<>'[]'
          or exists(select 1 from jsonb_array_elements(root->'domain'->'policy') p where p->>'mode'='resources')
          or root->'domain'->'vendor_staff_duties'<>'[]'::jsonb then return false; end if;
        if d->>'state'='cancelled' then
          if exists(select 1 from jsonb_array_elements(root->'domain'->'order_assignments') a where a->>'cancelled_at' is null) then return false; end if;
          continue;
        end if;
        -- Unknown historical money cannot become a known-price consent material.
        -- Zero remains a known amount; preserve the original deal without pricing it.
        if jsonb_typeof(d->'price') is distinct from 'number' then return false; end if;
        if (d->>'price')::numeric>9007199254740991 then return false; end if;
        if d->>'state' not in ('booked','paid_deposit') or d->>'vendor_id' is null or d->>'external_name' is not null
          or jsonb_array_length(root->'domain'->'vendor')<>1 or root->'domain'->'vendor'->0->>'deleted_at' is not null
          or root->'domain'->'vendor'->0->>'blocked_at' is not null
          or not exists(select 1 from jsonb_array_elements(material->'slots') s where s->>'id'=d->>'slot_id'
            and s->>'deal_id'=d->>'id' and s->>'program_event_id'=material->'event'->>'id')
          or jsonb_array_length(root->'day'->'heads')<>1 then return false; end if;
        select value into item from jsonb_array_elements(root->'day'->'versions') v
          where v->>'id'=root->'day'->'heads'->0->>'current_version_id';
        if (item is not null and item->>'binding_state'='active' and item->>'context_kind'='explicit_event'
          and item->>'event_id'=material->'event'->>'id' and item->>'service_date'=material->'event'->>'date'
          and item->>'time_zone'=material->'event'->>'time_zone' and item->>'day_id' is not null
          and item->>'vendor_id'=d->>'vendor_id' and item->>'slot_id'=d->>'slot_id'
          and item->>'deal_id'=d->>'id' and item->>'wedding_id'=material->>'weddingId'
          and item->'revision'=root->'day'->'heads'->0->'revision'
          and exists(select 1 from jsonb_array_elements(material->'physical'->'known') k where k=item)) is not true then return false; end if;
        active_count:=active_count+1;
      end loop;
      return active_count>0;
    end $$;

    create or replace function event_move_expected_physical(before_image jsonb,wedding uuid,target jsonb,moves jsonb,generated jsonb)
    returns jsonb language plpgsql immutable as $$
    declare state jsonb; heads jsonb; known jsonb; move jsonb; b jsonb; g jsonb; fact jsonb; stamp jsonb;
      id text; representative text; remaining jsonb; target_ids text[];
    begin
      state:=jsonb_build_object('days',coalesce((select jsonb_object_agg(x->>'id',x) from jsonb_array_elements(before_image->'days') x),'{}'),
        'groups',coalesce((select jsonb_object_agg(x->>'day_id',x) from jsonb_array_elements(before_image->'groups') x),'{}'));
      select coalesce(jsonb_agg(x order by x->>'id'),'[]') into heads from (
        select x from jsonb_array_elements(before_image->'heads') x where not exists(
          select 1 from jsonb_array_elements(moves) m where m->>'dealId'=x->>'deal_id')
        union all select m->'version' from jsonb_array_elements(moves) m) expected(x);
      select coalesce(jsonb_agg(x order by x->>'id'),'[]') into known from (
        select x from jsonb_array_elements(before_image->'known') x where not exists(
          select 1 from jsonb_array_elements(moves) m where m->>'dealId'=x->>'deal_id')
        union all select m->'version' from jsonb_array_elements(moves) m) expected(x);
      -- The TS observer touches previous DATEs and only already-owned target
      -- DATEs, under the old context, before changing the event.
      for id in select m->>'previousDayId' from jsonb_array_elements(moves) m
        union select x->>'id' from jsonb_array_elements(before_image->'days') x
          join jsonb_array_elements(before_image->'facts') f on f->>'id'=x->>'id'
          where x->>'source'='deal' and x->>'date'=target->>'date' and f->>'weddingId'=wedding::text
            and exists(select 1 from jsonb_array_elements(moves) m where m->'version'->>'vendor_id'=x->>'vendor_id') loop
        if state->'groups'->id is not null then continue; end if;
        b:=state->'days'->id;
        select x into fact from jsonb_array_elements(before_image->'facts') x where x->>'id'=id;
        select x into stamp from jsonb_array_elements(generated->'groups') x where x->>'dayId'=id;
        g:=jsonb_build_object('day_id',id,'vendor_id',b->'vendor_id','service_date',b->'date','wedding_id',fact->'weddingId',
          'classification',case when fact->>'weddingId' is null then 'opaque' else 'legacy_unknown' end,
          'legacy_candidates',case when fact->>'weddingId' is null then '[]'::jsonb else fact->'initialCandidates' end,
          'revision',1,'classified_at',stamp->'classifiedAt');
        state:=jsonb_set(state,array['groups',id],g);
      end loop;
      for stamp in select x from jsonb_array_elements(generated->'days') x loop
        id:=stamp->>'id';
        select min(m->>'dealId') into representative from jsonb_array_elements(moves) m
          where m->'version'->>'vendor_id'=stamp->>'vendorId';
        b:=jsonb_build_object('id',id,'vendor_id',stamp->'vendorId','date',target->'date','source','deal',
          'deal_id',representative,'created_at',stamp->'createdAt','source_revision',1);
        state:=jsonb_set(state,array['days',id],b);
        select x into fact from jsonb_array_elements(generated->'groups') x where x->>'dayId'=id;
        g:=jsonb_build_object('day_id',id,'vendor_id',stamp->'vendorId','service_date',target->'date','wedding_id',wedding,
          'classification','exact','legacy_candidates','[]'::jsonb,'revision',1,'classified_at',fact->'classifiedAt');
        state:=jsonb_set(state,array['groups',id],g);
      end loop;
      -- Same order as the sole writer's sorted root plan. All new heads have
      -- already been published; an opaque remainder is never pruned.
      for move in select x from jsonb_array_elements(moves) x order by x->>'dealId' loop
        id:=move->>'previousDayId';g:=state->'groups'->id;
        if g is null then continue; end if;
        if g->>'classification'<>'opaque' and g->>'wedding_id'=wedding::text and g->'legacy_candidates' ? (move->>'dealId') then
          select coalesce(jsonb_agg(x order by x),'[]') into remaining from jsonb_array_elements_text(g->'legacy_candidates') x where x<>move->>'dealId';
          g:=g||jsonb_build_object('legacy_candidates',remaining,'revision',(g->>'revision')::bigint+1);
          state:=jsonb_set(state,array['groups',id],g);
        end if;
        state:=event_move_reconcile_projection(state,id::uuid,known,heads,before_image->'candidates',before_image->'outside');
      end loop;
      select array_agg(distinct m->'version'->>'day_id' order by m->'version'->>'day_id') into target_ids from jsonb_array_elements(moves) m;
      foreach id in array target_ids loop
        state:=event_move_reconcile_projection(state,id::uuid,known,heads,before_image->'candidates',before_image->'outside');
      end loop;
      return jsonb_build_object('vendors',before_image->'vendors',
        'days',coalesce((select jsonb_agg(value order by key) from jsonb_each(state->'days')),'[]'),
        'groups',coalesce((select jsonb_agg(value order by key) from jsonb_each(state->'groups')),'[]'),
        'heads',heads,'known',known,'candidates',before_image->'candidates','outside',before_image->'outside');
    end $$;

    create or replace function event_move_assert_applied(effect_id uuid) returns void language plpgsql as $$
    declare e event_move_effects%rowtype; p event_move_proposals%rowtype; actual jsonb; root jsonb; plan jsonb;
      h deal_day_scope_heads%rowtype; v deal_day_scope_versions%rowtype; previous jsonb; rows jsonb;
      moves jsonb:='[]'; expected_version jsonb;
    begin
      select * into e from event_move_effects where id=effect_id;
      if not found then raise exception 'New move effect disappeared before commit' using errcode='23514',constraint='event_move_complete'; end if;
      if e.action<>'apply' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from event_move_effects where id=e.id and legacy_day_transaction_owns(xmin)) then return; end if;
      select * into strict p from event_move_proposals where id=e.proposal_id;
      actual:=event_move_source_snapshot(e.wedding_id,e.event_id);
      if actual is null or event_move_domain(actual) is distinct from event_move_expected_domain(p.baseline,p.target,to_jsonb(e.created_at))
        or event_move_agreed(p.id,e.policy_version) is not true
        or not exists(select 1 from weddings w where w.id=e.wedding_id and w.timeline_updated_by=e.actor_id
          and w.timeline_updated_at>=e.created_at and w.timeline_updated_at<=clock_timestamp())
        or not event_move_principal_current(e.wedding_id,null,'customer',e.actor_id,e.session_id,e.policy_version) then
        raise exception 'Applied move must preserve complete domain and agreement' using errcode='23514',constraint='event_move_complete';
      end if;
      for root in select value from jsonb_array_elements(p.baseline->'roots') loop
        select coalesce(jsonb_agg(to_jsonb(x) order by x.revision),'[]') into rows from deal_day_scope_versions x
          where x.deal_id=(root->>'dealId')::uuid and x.id in(select (value->>'id')::uuid from jsonb_array_elements(root->'day'->'versions'));
        if rows is distinct from root->'day'->'versions' then
          raise exception 'Prior day evidence changed' using errcode='23514',constraint='event_move_complete';
        end if;
        if root->'domain'->'deals'->0->>'state'='cancelled' then
          if (select value->'day' from jsonb_array_elements(actual->'roots') where value->>'dealId'=root->>'dealId') is distinct from root->'day' then
            raise exception 'Cancelled history is outside move delta' using errcode='23514',constraint='event_move_complete';
          end if;
          continue;
        end if;
        select value into strict plan from jsonb_array_elements(e.planned_versions) where value->>'dealId'=root->>'dealId';
        select * into h from deal_day_scope_heads where wedding_id=p.wedding_id and deal_id=(root->>'dealId')::uuid;
        select * into v from deal_day_scope_versions where id=(plan->>'versionId')::uuid;
        if not found or h.current_version_id is distinct from v.id or h.revision is distinct from v.revision
          or event_move_version_allowed(v) is not true or legacy_day_version_new(v.id) is not true
          or deal_day_scope_matches_current(v) is not true
          or not exists(select 1 from legacy_day_known_holders(v.day_id) k where k.id=v.id)
          or (select count(*) from deal_day_scope_versions where deal_id=v.deal_id)<>jsonb_array_length(root->'day'->'versions')+1 then
          raise exception 'Every planned day version must be the exact final current holder' using errcode='23514',constraint='event_move_complete';
        end if;
        select value into strict previous from jsonb_array_elements(root->'day'->'versions') where value->>'id'=plan->>'previousVersionId';
        expected_version:=previous||jsonb_build_object('id',plan->'versionId','revision',(plan->>'revision')::bigint,
          'previous_version_id',plan->'previousVersionId','origin_knowledge',null,'operation','move',
          'recorded_at',to_jsonb(v)->'recorded_at','service_date',p.target->'date','time_zone',p.target->'timeZone','day_id',v.day_id);
        if to_jsonb(v) is distinct from expected_version or v.recorded_at<e.created_at or v.recorded_at>clock_timestamp() then
          raise exception 'New version may change only the planned tuple and native clock' using errcode='23514',constraint='event_move_complete';
        end if;
        moves:=moves||jsonb_build_array(jsonb_build_object('dealId',root->'dealId','previousDayId',previous->'day_id','version',expected_version));
      end loop;
      perform event_move_assert_physical(e,p.baseline,p.target,moves,actual->'physical');
    end $$;
`);
