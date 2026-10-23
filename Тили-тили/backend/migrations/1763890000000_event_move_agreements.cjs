/* Prospective extra-event agreements. No historical consent/date inference.
 * Up is additive; the old main writer and applied migrations remain literal. */
exports.up = pgm => {
  pgm.sql(`
    create function event_move_target_valid(value jsonb) returns boolean language plpgsql stable as $$
    declare y int; m int; d int; parsed date;
    begin
      if (jsonb_typeof(value)='object' and value-array['date','timeZone','location']='{}'::jsonb
        and value ?& array['date','timeZone','location'] and jsonb_typeof(value->'date')='string'
        and value->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and jsonb_typeof(value->'timeZone')='string' and length(value->>'timeZone') between 1 and 128
        and value->>'timeZone' ~ '^[A-Za-z0-9_+/-]+$'
        and (jsonb_typeof(value->'location')='null' or
          (jsonb_typeof(value->'location')='string' and length(value->>'location')<=300))) is not true then return false; end if;
      y:=substring(value->>'date',1,4)::int;m:=substring(value->>'date',6,2)::int;d:=substring(value->>'date',9,2)::int;
      if y not between 1 and 9999 or m not between 1 and 12 or d not between 1 and 31 then return false; end if;
      begin parsed:=make_date(y,m,d); exception when datetime_field_overflow then return false; end;
      return isfinite(parsed) and exists(select 1 from pg_catalog.pg_timezone_names z where z.name=value->>'timeZone');
    end $$;

    -- These are read-only facts, never enrollment/backfill. Unaffected DATEs
    -- of every current/historical/U vendor are part of the immutable source.
    create function event_move_physical_snapshot(vendors uuid[],root_ids uuid[]) returns jsonb language sql stable as $$
      with days as materialized(select b.* from vendor_busy_dates b where b.vendor_id=any(vendors)),
      groups as materialized(select g.* from legacy_day_groups g where g.vendor_id=any(vendors)),
      heads as materialized(select v.* from deal_day_scope_heads h join deal_day_scope_versions v
        on v.id=h.current_version_id and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
        join days b on b.id=v.day_id),
      ids as materialized(select id from deals where vendor_id=any(vendors)
        union select unnest(root_ids) union select deal_id from days where deal_id is not null
        union select unnest(legacy_candidates) from groups union select deal_id from heads)
      select jsonb_build_object('vendors',to_jsonb(legacy_day_uuid_set(vendors)),
        'days',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from days b),'[]'),
        'groups',coalesce((select jsonb_agg(to_jsonb(g) order by g.day_id) from groups g),'[]'),
        'heads',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from heads v),'[]'),
        'known',coalesce((select jsonb_agg(to_jsonb(v) order by v.id) from days b
          cross join lateral legacy_day_known_holders(b.id) v),'[]'),
        'candidates',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'wedding_id',d.wedding_id,
          'vendor_id',d.vendor_id,'kind',case when d.state in ('booked','paid_deposit') then 'open'
            when d.state='done' then 'done' else 'other' end,'created_at',d.created_at) order by i.id)
          from ids i left join deals d on d.id=i.id),'[]'),
        'outside',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from vendor_busy_dates b
          where b.source='deal' and b.deal_id in(select id from ids) and not(b.vendor_id=any(vendors))),'[]'),
        'facts',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,
          'weddingId',legacy_day_group_wedding(b.id),'initialCandidates',to_jsonb(legacy_day_initial_candidates(b.id))) order by b.id)
          from days b),'[]'))
    $$;

    create function event_move_snapshot_valid(value jsonb) returns boolean language plpgsql immutable as $$
    declare r jsonb; entry jsonb; source record;
      top_keys text[]:=array['schemaVersion','weddingId','programVersion','wedding','event','otherEvents','slots','roots','eventObligations','physical'];
      domain_keys text[]:=array['deals','deal_orders','order_assignments','order_parts','deal_events','payments','payment_installments',
        'payment_corrections','payment_installment_edits','deal_terms_versions','deal_terms_receipts','deal_resource_plan_versions',
        'deal_resource_commitments','deal_resource_commitment_versions','deal_resource_commitment_members','resource_allocations',
        'payment_receipts','vendor','policy','vendor_live_allocations','vendor_staff_duties'];
      obligation_keys text[]:=array['timeline_events','vendor_staff_duties','guest_event_invitations','event_guest_participation',
        'event_rsvp_requests','offer_requests','offers','external_invites','external_program_acknowledgments',
        'vendor_program_acknowledgments','timeline_assignments','timeline_dependencies'];
      physical_keys text[]:=array['vendors','days','groups','heads','known','candidates','outside','facts'];
    begin
      if (jsonb_typeof(value)='object' and value-top_keys='{}'::jsonb and value ?& top_keys
        and value->'schemaVersion'='1'::jsonb and jsonb_typeof(value->'weddingId')='string'
        and value->>'weddingId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        and value->>'programVersion' ~ '^[0-9]+$' and jsonb_typeof(value->'wedding')='object'
        and jsonb_typeof(value->'event')='object' and value->'event' ?& array['id','wedding_id','is_main','date','time_zone','rsvp_deadline']
        and jsonb_typeof(value->'event'->'is_main')='boolean'
        and value->'event'->>'wedding_id'=value->>'weddingId'
        and jsonb_typeof(value->'roots')='array' and jsonb_typeof(value->'slots')='array'
        and jsonb_typeof(value->'otherEvents')='array' and jsonb_typeof(value->'eventObligations')='object'
        and value->'eventObligations'-obligation_keys='{}'::jsonb and value->'eventObligations' ?& obligation_keys
        and jsonb_typeof(value->'physical')='object' and value->'physical'-physical_keys='{}'::jsonb
        and value->'physical' ?& physical_keys) is not true then return false; end if;
      for source in select e.key,e.value as data from jsonb_each(value->'eventObligations') e loop
        if jsonb_typeof(source.data) is distinct from 'array' then return false; end if;
      end loop;
      for source in select e.key,e.value as data from jsonb_each(value->'physical') e loop
        if jsonb_typeof(source.data) is distinct from 'array' then return false; end if;
      end loop;
      if (select count(distinct x->>'dealId') from jsonb_array_elements(value->'roots') x)
        <>jsonb_array_length(value->'roots') then return false; end if;
      for r in select x from jsonb_array_elements(value->'roots') x loop
        if (jsonb_typeof(r)='object' and r-array['dealId','domain','day']='{}'::jsonb
          and r ?& array['dealId','domain','day'] and r->>'dealId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          and jsonb_typeof(r->'domain')='object' and r->'domain'-domain_keys='{}'::jsonb and r->'domain' ?& domain_keys
          and jsonb_typeof(r->'day')='object' and r->'day'-array['heads','versions']='{}'::jsonb
          and r->'day' ?& array['heads','versions'] and jsonb_typeof(r->'day'->'heads')='array'
          and jsonb_typeof(r->'day'->'versions')='array') is not true then return false; end if;
        for source in select e.key,e.value as data from jsonb_each(r->'domain') e loop
          if jsonb_typeof(source.data) is distinct from 'array' then return false; end if;
          for entry in select x from jsonb_array_elements(source.data) x loop
            if jsonb_typeof(entry) is distinct from 'object' then return false; end if;
          end loop;
        end loop;
        if jsonb_array_length(r->'domain'->'deals')<>1 or jsonb_array_length(r->'domain'->'deal_orders')<>1 then return false; end if;
        entry:=r->'domain'->'deals'->0;
        if (entry ?& array['id','wedding_id','slot_id','vendor_id','state','external_name']
          and entry->>'id'=r->>'dealId' and entry->>'wedding_id'=value->>'weddingId'
          and jsonb_typeof(entry->'state')='string'
          and jsonb_typeof(entry->'slot_id') in ('string','null')
          and jsonb_typeof(entry->'vendor_id') in ('string','null')) is not true then return false; end if;
      end loop;
      return true;
    end $$;

    create function event_move_source_snapshot(p_wedding_id uuid,p_event_id uuid) returns jsonb language plpgsql stable as $$
    declare ids uuid[]; positions uuid[]; vendors uuid[]; item record; root_id uuid; domain jsonb; days jsonb;
      roots jsonb:='[]'; obligations jsonb:='{}'; value jsonb; event_row jsonb;
    begin
      select to_jsonb(e) into event_row from wedding_events e where e.wedding_id=$1 and e.id=$2;
      if not found then return null; end if;
      -- Discover all states, performers and historical assignments before
      -- classification. Neither absent heads nor an erased vendor hide a root.
      select coalesce(array_agg(id order by id),'{}'::uuid[]) into ids from (
        select d.id from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
          where d.wedding_id=$1 and s.program_event_id=$2
        union select s.deal_id from slots s where s.wedding_id=$1 and s.program_event_id=$2 and s.deal_id is not null
        union select a.deal_id from order_assignments a where a.wedding_id=$1 and a.program_event_id=$2
        union select duty.deal_id from vendor_staff_duties duty where duty.wedding_id=$1 and duty.program_event_id=$2
        union select a.deal_id from timeline_assignments a join timeline_events t on t.id=a.event_id and t.wedding_id=a.wedding_id
          where t.wedding_id=$1 and t.program_event_id=$2 and a.deal_id is not null
        union select c.deal_id from deal_resource_commitment_versions c where c.wedding_id=$1 and exists(
          select 1 from deal_resource_plan_versions p,jsonb_array_elements(p.public_snapshot->'lines') line
          where p.id=c.plan_revision_id and line->>'programEventId'=$2::text)
      ) discovered;
      select coalesce(array_agg(id order by id),'{}'::uuid[]) into positions from (
        select id from slots where wedding_id=$1 and program_event_id=$2
        union select slot_id from deals where wedding_id=$1 and id=any(ids)
        union select slot_id from order_assignments where wedding_id=$1 and deal_id=any(ids)
      ) discovered;
      foreach root_id in array ids loop
        domain:='{}';
        for item in select * from (values
          ('deals','id'),('deal_orders','deal_id'),('order_assignments','deal_id'),('order_parts','deal_id'),
          ('deal_events','deal_id'),('payments','deal_id'),('payment_installments','deal_id'),
          ('payment_corrections','deal_id'),('payment_installment_edits','deal_id'),('deal_terms_versions','deal_id'),
          ('deal_terms_receipts','deal_id'),('deal_resource_plan_versions','deal_id'),('deal_resource_commitments','deal_id'),
          ('deal_resource_commitment_versions','deal_id'),('deal_resource_commitment_members','deal_id'),('resource_allocations','deal_id'),
          ('vendor_staff_duties','deal_id')
        ) sources(table_name,root_column) loop
          execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %I t where %I=$1',
            item.table_name,item.root_column) into value using root_id;
          domain:=domain||jsonb_build_object(item.table_name,value);
        end loop;
        select coalesce(jsonb_agg((to_jsonb(r)-'content')||jsonb_build_object('contentSHA256',encode(pg_catalog.sha256(r.content),'hex')) order by r.id),'[]')
          into value from payment_receipts r join payments p on p.id=r.payment_id where p.deal_id=root_id;
        domain:=domain||jsonb_build_object('payment_receipts',value);
        select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'user_id',v.user_id,'name',v.name,'category_id',v.category_id,
          'blocked_at',v.blocked_at,'published_at',v.published_at,'deleted_at',u.deleted_at) order by v.id),'[]') into value
          from vendors v join users u on u.id=v.user_id join deals d on d.vendor_id=v.id where d.id=root_id;
        domain:=domain||jsonb_build_object('vendor',value);
        select coalesce(jsonb_agg(to_jsonb(p) order by p.vendor_id),'[]') into value from vendor_availability_policy p
          join deals d on d.vendor_id=p.vendor_id where d.id=root_id;
        domain:=domain||jsonb_build_object('policy',value);
        select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]') into value from resource_allocations a
          join deals d on d.vendor_id=a.vendor_id where d.id=root_id and a.released_at is null;
        domain:=domain||jsonb_build_object('vendor_live_allocations',value);
        select jsonb_build_object('heads',coalesce((select jsonb_agg(to_jsonb(h) order by h.deal_id) from deal_day_scope_heads h where h.deal_id=root_id),'[]'),
          'versions',coalesce((select jsonb_agg(to_jsonb(v) order by v.revision) from deal_day_scope_versions v where v.deal_id=root_id),'[]')) into days;
        roots:=roots||jsonb_build_array(jsonb_build_object('dealId',root_id,'domain',domain,'day',days));
      end loop;
      for item in select * from (values
        ('timeline_events','program_event_id'),('vendor_staff_duties','program_event_id'),
        ('guest_event_invitations','event_id'),('event_guest_participation','program_event_id'),('event_rsvp_requests','program_event_id')
      ) sources(table_name,event_column) loop
        execute format('select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),''[]''::jsonb) from %I t where wedding_id=$1 and %I=$2',
          item.table_name,item.event_column) into value using p_wedding_id,p_event_id;
        obligations:=obligations||jsonb_build_object(item.table_name,value);
      end loop;
      select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') into value from offer_requests r where r.slot_id=any(positions);
      obligations:=obligations||jsonb_build_object('offer_requests',value);
      select coalesce(jsonb_agg(to_jsonb(o) order by o.id),'[]') into value from offers o join offer_requests r on r.id=o.request_id where r.slot_id=any(positions);
      obligations:=obligations||jsonb_build_object('offers',value);
      select coalesce(jsonb_agg(to_jsonb(i) order by i.token),'[]') into value from external_invites i where i.wedding_id=$1 and (i.slot_id=any(positions) or i.program_deal_id=any(ids));
      obligations:=obligations||jsonb_build_object('external_invites',value);
      select coalesce(jsonb_agg(to_jsonb(a) order by to_jsonb(a)::text),'[]') into value from external_program_acknowledgments a where a.wedding_id=$1 and a.deal_id=any(ids);
      obligations:=obligations||jsonb_build_object('external_program_acknowledgments',value);
      select coalesce(jsonb_agg(to_jsonb(a) order by to_jsonb(a)::text),'[]') into value from vendor_program_acknowledgments a
        where a.wedding_id=$1 and a.vendor_id in(select vendor_id from deals where id=any(ids));
      obligations:=obligations||jsonb_build_object('vendor_program_acknowledgments',value);
      select coalesce(jsonb_agg(to_jsonb(a) order by to_jsonb(a)::text),'[]') into value from timeline_assignments a
        where a.wedding_id=$1 and (a.deal_id=any(ids) or a.event_id in(select id from timeline_events where wedding_id=$1 and program_event_id=$2));
      obligations:=obligations||jsonb_build_object('timeline_assignments',value);
      select coalesce(jsonb_agg(to_jsonb(d) order by to_jsonb(d)::text),'[]') into value from timeline_dependencies d where d.wedding_id=$1
        and (d.event_id in(select id from timeline_events where wedding_id=$1 and program_event_id=$2)
          or d.depends_on in(select id from timeline_events where wedding_id=$1 and program_event_id=$2));
      obligations:=obligations||jsonb_build_object('timeline_dependencies',value);
      select legacy_day_uuid_set(array_agg(vendor)) into vendors from (
        select d.vendor_id vendor from deals d where d.id=any(ids)
        union select v.vendor_id from deal_day_scope_versions v where v.deal_id=any(ids)
        union select v.vendor_id from deal_resource_commitment_versions v where v.deal_id=any(ids)
        union select g.vendor_id from legacy_day_groups g where g.legacy_candidates && ids
        union select b.vendor_id from vendor_busy_dates b where b.deal_id=any(ids)
      ) all_vendors where vendor is not null;
      return jsonb_build_object('schemaVersion',1,'weddingId',p_wedding_id,
        'programVersion',(select timeline_version::text from weddings where id=$1),
        'wedding',(select to_jsonb(w)-'timeline_version'-'timeline_updated_at'-'timeline_updated_by' from weddings w where w.id=$1),'event',event_row,
        'otherEvents',coalesce((select jsonb_agg(to_jsonb(e) order by e.id) from wedding_events e where e.wedding_id=$1 and e.id<>$2),'[]'),
        'slots',coalesce((select jsonb_agg(to_jsonb(s) order by s.id) from slots s where s.wedding_id=$1),'[]'),
        'roots',roots,'eventObligations',obligations,'physical',event_move_physical_snapshot(vendors,ids));
    end $$;

    create function event_move_scope_supported(material jsonb) returns boolean language plpgsql stable as $$
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

    create table event_move_proposals(
      id uuid primary key,wedding_id uuid not null,event_id uuid not null,
      baseline jsonb not null,target jsonb not null,canonical_payload text not null,
      digest text not null check(digest ~ '^[0-9a-f]{64}$'),
      created_by uuid references users(id) on delete set null,
      session_id uuid references sessions(id) on delete set null,policy_version text not null,
      created_at timestamptz not null default clock_timestamp(),
      unique(wedding_id,id),unique(wedding_id,event_id,id),
      foreign key(wedding_id,event_id) references wedding_events(wedding_id,id) on delete cascade,
      constraint event_move_shape check((jsonb_typeof(target)='object'
        and target-array['date','timeZone','location']='{}'::jsonb and target ?& array['date','timeZone','location']
        and jsonb_typeof(target->'date')='string' and jsonb_typeof(target->'timeZone')='string'
        and jsonb_typeof(target->'location') in ('string','null')
        and jsonb_build_object('baseline',baseline,'target',target)=canonical_payload::jsonb
        and digest=encode(pg_catalog.sha256(convert_to(canonical_payload,'UTF8')),'hex')) is true)
    );
    create table event_move_roots(
      wedding_id uuid not null,proposal_id uuid not null,deal_id uuid not null,vendor_id uuid not null,
      material jsonb not null,canonical_payload text not null,digest text not null check(digest ~ '^[0-9a-f]{64}$'),
      primary key(proposal_id,deal_id),unique(wedding_id,proposal_id,deal_id),
      foreign key(wedding_id,proposal_id) references event_move_proposals(wedding_id,id) on delete cascade,
      constraint event_move_shape check((material=canonical_payload::jsonb
        and digest=encode(pg_catalog.sha256(convert_to(canonical_payload,'UTF8')),'hex')) is true)
    );
    create table event_move_receipts(
      id uuid primary key,wedding_id uuid not null,proposal_id uuid not null,deal_id uuid not null,
      party text not null check(party in ('customer','performer')),
      user_id uuid references users(id) on delete set null,session_id uuid references sessions(id) on delete set null,
      policy_version text not null,digest text not null,read_proof_hash text not null check(read_proof_hash ~ '^[0-9a-f]{64}$'),
      accepted_at timestamptz not null default clock_timestamp(),unique(proposal_id,deal_id,party),
      foreign key(wedding_id,proposal_id,deal_id) references event_move_roots(wedding_id,proposal_id,deal_id) on delete cascade
    );
    create table event_move_effects(
      id uuid primary key,wedding_id uuid not null,event_id uuid not null,proposal_id uuid not null unique,
      action text not null check(action in ('apply','cancel')),digest text not null,
      actor_id uuid references users(id) on delete set null,session_id uuid references sessions(id) on delete set null,
      policy_version text not null,planned_versions jsonb not null,
      transaction_id bigint not null default txid_current(),backend_pid int not null default pg_backend_pid(),
      created_at timestamptz not null default clock_timestamp(),
      foreign key(wedding_id,event_id,proposal_id) references event_move_proposals(wedding_id,event_id,id) on delete cascade,
      constraint event_move_shape check(jsonb_typeof(planned_versions)='array')
    );
    create function event_move_root_material(baseline jsonb,target jsonb,proposal_id uuid,root_id uuid) returns jsonb language sql immutable as $$
      select jsonb_build_object('schemaVersion',1,'proposalId',proposal_id,'dealId',root_id,
        'event',jsonb_build_object('id',baseline->'event'->'id','name',baseline->'event'->'name','kind',baseline->'event'->'kind',
          'from',jsonb_build_object('date',baseline->'event'->'date','timeZone',baseline->'event'->'time_zone','location',baseline->'event'->'location'),
          'to',target),
        'economics',jsonb_build_object('amount',r->'domain'->'deals'->0->'price','currency',r->'domain'->'deals'->0->'currency',
          'vendorId',r->'domain'->'deals'->0->'vendor_id','packageTitle',r->'domain'->'deals'->0->'package_title_snapshot',
          'packageIncludes',r->'domain'->'deals'->0->'package_includes_snapshot',
          'comparisonTerms',r->'domain'->'deals'->0->'offer_comparison_terms_snapshot'),
        'assignments',coalesce((select jsonb_agg(jsonb_build_object('id',a->'id','slotId',a->'slot_id',
          'eventId',a->'program_event_id','label',a->'label') order by a->>'id')
          from jsonb_array_elements(r->'domain'->'order_assignments') a where a->>'cancelled_at' is null),'[]'),
        'preserved',jsonb_build_object('price',true,'payments',true,'paymentDueDates',true,'otherEvents',true))
      from jsonb_array_elements(baseline->'roots') r where r->>'dealId'=root_id::text
        and r->'domain'->'deals'->0->>'state' in ('booked','paid_deposit')
    $$;
    create function event_move_principal_current(wedding uuid,deal uuid,party text,person uuid,session uuid,policy text)
    returns boolean language sql stable as $$
      select person is not null and session is not null and exists(select 1 from users u join sessions s on s.user_id=u.id
        where u.id=person and u.deleted_at is null and s.id=session and s.revoked_at is null)
        and exists(select 1 from consents c where c.user_id=person and c.policy_version=policy and c.withdrawn_at is null)
        and exists(select 1 from weddings w where w.id=wedding and w.archived_at is null and w.cancelled_at is null)
        and ((party='customer' and exists(select 1 from wedding_members m where m.wedding_id=wedding and m.user_id=person and m.role='couple'))
          or (party='performer' and exists(select 1 from deals d join vendors v on v.id=d.vendor_id
            where d.wedding_id=wedding and d.id=deal and v.user_id=person and v.blocked_at is null)))
    $$;
    create function event_move_history_guard() returns trigger language plpgsql as $$
    declare n jsonb; o jsonb; field text;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'Move history is retained until wedding erasure' using errcode='23514',constraint='event_move_immutable';
        end if;
        return OLD;
      end if;
      n:=to_jsonb(NEW);o:=to_jsonb(OLD);
      if n-array['created_by','user_id','actor_id','session_id'] is distinct from o-array['created_by','user_id','actor_id','session_id'] then
        raise exception 'Move history is immutable' using errcode='23514',constraint='event_move_immutable';
      end if;
      foreach field in array array['created_by','user_id','actor_id','session_id'] loop
        if n->field is distinct from o->field and (n->>field is not null or o->>field is null
          or (field='session_id' and exists(select 1 from sessions where id=(o->>field)::uuid))
          or (field<>'session_id' and exists(select 1 from users where id=(o->>field)::uuid))) then
          raise exception 'Only actual erased principal may be nulled' using errcode='23514',constraint='event_move_immutable';
        end if;
      end loop;
      return NEW;
    end $$;
    create trigger immutable_event_move_proposal before update or delete on event_move_proposals for each row execute function event_move_history_guard();
    create trigger immutable_event_move_root before update or delete on event_move_roots for each row execute function event_move_history_guard();
    create trigger immutable_event_move_receipt before update or delete on event_move_receipts for each row execute function event_move_history_guard();
    create trigger immutable_event_move_effect before update or delete on event_move_effects for each row execute function event_move_history_guard();

    create function event_move_proposal_guard() returns trigger language plpgsql as $$
    begin
      if not event_move_principal_current(NEW.wedding_id,null,'customer',NEW.created_by,NEW.session_id,NEW.policy_version)
        or NEW.baseline is distinct from event_move_source_snapshot(NEW.wedding_id,NEW.event_id)
        or event_move_scope_supported(NEW.baseline) is not true then
        raise exception 'Move proposal needs complete current scope and customer' using errcode='23514',constraint='event_move_source_current';
      end if;
      if event_move_target_valid(NEW.target) is not true
        or jsonb_build_object('date',NEW.baseline->'event'->'date','timeZone',NEW.baseline->'event'->'time_zone',
          'location',NEW.baseline->'event'->'location')=NEW.target then
        raise exception 'Move needs a different known target' using errcode='23514',constraint='event_move_shape';
      end if;
      NEW.created_at:=clock_timestamp();
      return NEW;
    end $$;
    create trigger event_move_proposal_guard before insert on event_move_proposals for each row execute function event_move_proposal_guard();
    create function event_move_root_guard() returns trigger language plpgsql as $$
    declare p event_move_proposals%rowtype; r jsonb;
    begin
      select * into strict p from event_move_proposals where wedding_id=NEW.wedding_id and id=NEW.proposal_id;
      select value into r from jsonb_array_elements(p.baseline->'roots') where value->>'dealId'=NEW.deal_id::text;
      if not exists(select 1 from event_move_proposals where id=p.id and legacy_day_transaction_owns(xmin))
        or NEW.material is distinct from event_move_root_material(p.baseline,p.target,p.id,NEW.deal_id)
        or NEW.material is null or NEW.vendor_id::text is distinct from r->'domain'->'deals'->0->>'vendor_id' then
        raise exception 'Root material must be exact own prospective proposal' using errcode='23514',constraint='event_move_scope';
      end if;
      return NEW;
    end $$;
    create trigger event_move_root_guard before insert on event_move_roots for each row execute function event_move_root_guard();

    create function event_move_receipt_guard() returns trigger language plpgsql as $$
    declare p event_move_proposals%rowtype; r event_move_roots%rowtype;
    begin
      select * into strict p from event_move_proposals where wedding_id=NEW.wedding_id and id=NEW.proposal_id for update;
      select * into strict r from event_move_roots where wedding_id=NEW.wedding_id and proposal_id=NEW.proposal_id and deal_id=NEW.deal_id;
      if exists(select 1 from event_move_effects where proposal_id=p.id)
        or p.baseline is distinct from event_move_source_snapshot(p.wedding_id,p.event_id)
        or event_move_scope_supported(p.baseline) is not true or NEW.digest is distinct from r.digest then
        raise exception 'Read material is no longer current' using errcode='23514',constraint='event_move_source_current';
      end if;
      if not event_move_principal_current(NEW.wedding_id,NEW.deal_id,NEW.party,NEW.user_id,NEW.session_id,NEW.policy_version)
        or exists(select 1 from event_move_receipts a where a.proposal_id=NEW.proposal_id and a.deal_id=NEW.deal_id
          and a.party<>NEW.party and (a.user_id=NEW.user_id or a.session_id=NEW.session_id)) then
        raise exception 'Move acceptance needs its distinct real party' using errcode='23514',constraint='event_move_party';
      end if;
      NEW.accepted_at:=clock_timestamp();
      return NEW;
    end $$;
    create trigger event_move_receipt_guard before insert on event_move_receipts for each row execute function event_move_receipt_guard();

    create function event_move_root_set_complete(proposal uuid) returns boolean language sql stable as $$
      select (select coalesce(array_agg(r.deal_id order by r.deal_id),'{}'::uuid[]) from event_move_roots r where r.proposal_id=p.id)
        = (select coalesce(array_agg((r->>'dealId')::uuid order by (r->>'dealId')::uuid),'{}'::uuid[])
          from jsonb_array_elements(p.baseline->'roots') r where r->'domain'->'deals'->0->>'state' in ('booked','paid_deposit'))
      from event_move_proposals p where p.id=proposal
    $$;
    create function event_move_agreed(proposal uuid,current_policy text) returns boolean language sql stable as $$
      select event_move_root_set_complete(proposal) is true and exists(select 1 from event_move_roots where proposal_id=proposal)
        and not exists(select 1 from event_move_roots r where r.proposal_id=proposal and not exists(
          select 1 from event_move_receipts a join event_move_receipts b on b.proposal_id=a.proposal_id and b.deal_id=a.deal_id
            and a.party='customer' and b.party='performer' and a.user_id<>b.user_id and a.session_id<>b.session_id
          where a.proposal_id=r.proposal_id and a.deal_id=r.deal_id and a.digest=r.digest and b.digest=r.digest
            and a.policy_version=current_policy and b.policy_version=current_policy
            and event_move_principal_current(r.wedding_id,r.deal_id,a.party,a.user_id,a.session_id,current_policy)
            and event_move_principal_current(r.wedding_id,r.deal_id,b.party,b.user_id,b.session_id,current_policy)))
    $$;
    create function event_move_effect_guard() returns trigger language plpgsql as $$
    declare p event_move_proposals%rowtype; plan jsonb; h deal_day_scope_heads%rowtype; ids uuid[]; vendor text;
    begin
      select * into strict p from event_move_proposals where id=NEW.proposal_id and wedding_id=NEW.wedding_id and event_id=NEW.event_id for update;
      if NEW.digest is distinct from p.digest
        or not event_move_principal_current(NEW.wedding_id,null,'customer',NEW.actor_id,NEW.session_id,NEW.policy_version) then
        raise exception 'Move effect requires its current customer and exact proposal' using errcode='23514',constraint='event_move_party';
      end if;
      if NEW.action='cancel' then
        if NEW.planned_versions<>'[]'::jsonb then raise exception 'Cancellation has no move versions' using errcode='23514',constraint='event_move_shape'; end if;
      else
        for vendor in select jsonb_array_elements_text(p.baseline->'physical'->'vendors') loop
          perform legacy_day_require_vendor(vendor::uuid);
        end loop;
        if exists(select 1 from event_move_effects e where e.wedding_id=NEW.wedding_id and e.event_id=NEW.event_id
          and e.action='apply' and legacy_day_transaction_owns(e.xmin))
          or p.baseline is distinct from event_move_source_snapshot(p.wedding_id,p.event_id)
          or event_move_scope_supported(p.baseline) is not true or event_move_agreed(p.id,NEW.policy_version) is not true then
          raise exception 'Move effect requires exact complete agreed source' using errcode='23514',constraint='event_move_source_current';
        end if;
        if jsonb_typeof(NEW.planned_versions)<>'array' then raise exception 'Invalid move map' using errcode='23514',constraint='event_move_day_scope'; end if;
        for plan in select value from jsonb_array_elements(NEW.planned_versions) loop
          if (jsonb_typeof(plan)='object' and plan-array['dealId','previousVersionId','revision','versionId']='{}'::jsonb
            and plan ?& array['dealId','previousVersionId','revision','versionId']
            and jsonb_typeof(plan->'dealId')='string' and jsonb_typeof(plan->'previousVersionId')='string'
            and jsonb_typeof(plan->'versionId')='string' and jsonb_typeof(plan->'revision')='string'
            and plan->>'dealId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            and plan->>'previousVersionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            and plan->>'versionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
            and plan->>'revision' ~ '^[1-9][0-9]{0,18}$') is not true then
            raise exception 'Invalid prospective version map' using errcode='23514',constraint='event_move_day_scope';
          end if;
          if (plan->>'revision')::numeric>9223372036854775807 then
            raise exception 'Invalid prospective revision' using errcode='23514',constraint='event_move_day_scope';
          end if;
        end loop;
        select coalesce(array_agg((x->>'dealId')::uuid order by (x->>'dealId')::uuid),'{}'::uuid[]) into ids from jsonb_array_elements(NEW.planned_versions) x;
        if ids is distinct from (select array_agg(deal_id order by deal_id) from event_move_roots where proposal_id=p.id)
          or (select count(distinct x->>'versionId') from jsonb_array_elements(NEW.planned_versions) x)<>cardinality(ids) then
          raise exception 'Move map must contain every root once' using errcode='23514',constraint='event_move_day_scope';
        end if;
        for plan in select value from jsonb_array_elements(NEW.planned_versions) loop
          if plan-array['dealId','previousVersionId','revision','versionId']<>'{}'::jsonb
            or not plan ?& array['dealId','previousVersionId','revision','versionId']
            or (plan->>'versionId')::uuid is null or exists(select 1 from deal_day_scope_versions where id=(plan->>'versionId')::uuid) then
            raise exception 'Invalid prospective version map' using errcode='23514',constraint='event_move_day_scope';
          end if;
          select * into h from deal_day_scope_heads where wedding_id=p.wedding_id and deal_id=(plan->>'dealId')::uuid;
          if not found or h.current_version_id is distinct from (plan->>'previousVersionId')::uuid
            or h.revision+1 is distinct from (plan->>'revision')::bigint then
            raise exception 'Prospective version must follow exact current head' using errcode='23514',constraint='event_move_day_scope';
          end if;
        end loop;
      end if;
      NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();NEW.created_at:=clock_timestamp();
      return NEW;
    end $$;
    create trigger event_move_effect_guard before insert on event_move_effects for each row execute function event_move_effect_guard();

    create function event_move_version_allowed(v deal_day_scope_versions) returns boolean language sql stable as $$
      select exists(select 1 from event_move_effects e join event_move_proposals p on p.id=e.proposal_id
        join event_move_roots r on r.proposal_id=p.id and r.deal_id=v.deal_id and r.wedding_id=v.wedding_id,
        jsonb_array_elements(e.planned_versions) plan
        where e.action='apply' and legacy_day_transaction_owns(e.xmin) and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid()
          and plan->>'dealId'=v.deal_id::text and plan->>'versionId'=v.id::text
          and plan->>'previousVersionId'=v.previous_version_id::text and (plan->>'revision')::bigint=v.revision
          and v.operation='move' and v.context_kind='explicit_event' and v.event_id=p.event_id
          and v.performer_kind='catalog' and v.vendor_id=r.vendor_id and v.binding_state='active' and v.day_id is not null
          and v.service_date=(p.target->>'date')::date and v.time_zone=p.target->>'timeZone'
          and v.slot_id=(select (root->'domain'->'deals'->0->>'slot_id')::uuid from jsonb_array_elements(p.baseline->'roots') root
            where root->>'dealId'=v.deal_id::text)
          and event_move_agreed(p.id,e.policy_version) is true)
    $$;
    create function event_move_version_guard() returns trigger language plpgsql as $$
    begin
      if NEW.operation='move' and (NEW.context_kind='explicit_event'
        or exists(select 1 from deal_day_scope_versions where id=NEW.previous_version_id and context_kind='explicit_event'))
        and event_move_version_allowed(NEW) is not true then
        raise exception 'Additional day move needs its real agreed effect' using errcode='23514',constraint='event_move_day_scope';
      end if;
      return NEW;
    end $$;
    create trigger event_move_version_guard before insert on deal_day_scope_versions for each row execute function event_move_version_guard();

    create function event_move_requires_agreement(wedding uuid,event uuid) returns boolean language sql stable as $$
      select exists(select 1 from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
        where d.wedding_id=wedding and d.state in ('booked','paid_deposit','done') and (s.program_event_id=event
          or exists(select 1 from order_assignments a where a.wedding_id=d.wedding_id and a.deal_id=d.id
            and a.program_event_id=event and a.cancelled_at is null)))
        or exists(select 1 from slots s join deals d on d.id=s.deal_id and d.wedding_id=s.wedding_id
          where s.wedding_id=wedding and s.program_event_id=event and d.state in ('booked','paid_deposit','done'))
        or exists(select 1 from vendor_staff_duties duty where duty.wedding_id=wedding and duty.program_event_id=event and duty.revoked_at is null)
        or exists(select 1 from deal_resource_commitment_versions c join deal_resource_commitments h on h.current_version_id=c.id
          join deal_resource_plan_versions p on p.id=c.plan_revision_id,jsonb_array_elements(p.public_snapshot->'lines') line
          where c.wedding_id=wedding and h.state='reserved' and line->>'programEventId'=event::text)
    $$;
    create function event_move_context_guard() returns trigger language plpgsql as $$
    declare p event_move_proposals%rowtype; e event_move_effects%rowtype;
    begin
      if OLD.is_main or row(NEW.date,NEW.time_zone,NEW.location) is not distinct from row(OLD.date,OLD.time_zone,OLD.location)
        or not event_move_requires_agreement(OLD.wedding_id,OLD.id) then return NEW; end if;
      select x.* into e from event_move_effects x where x.wedding_id=OLD.wedding_id and x.event_id=OLD.id and x.action='apply'
        and legacy_day_transaction_owns(x.xmin) and x.transaction_id=txid_current() and x.backend_pid=pg_backend_pid();
      if not found then raise exception 'Additional committed context needs agreement' using errcode='23514',constraint='event_move_requires_agreement'; end if;
      select * into strict p from event_move_proposals where id=e.proposal_id;
      if p.baseline->'event' is distinct from to_jsonb(OLD)
        or p.target is distinct from jsonb_build_object('date',NEW.date,'timeZone',NEW.time_zone,'location',NEW.location)
        or to_jsonb(NEW)-array['date','time_zone','location','modified_at'] is distinct from to_jsonb(OLD)-array['date','time_zone','location','modified_at']
        or event_move_agreed(p.id,e.policy_version) is not true then
        raise exception 'Context does not match its complete agreed proposal' using errcode='23514',constraint='event_move_requires_agreement';
      end if;
      -- Runs after the existing wedding_event_guard. This known DB time is
      -- part of the pure expected-domain projection, not an arbitrary mask.
      NEW.modified_at:=e.created_at;
      return NEW;
    end $$;
    create trigger zz_event_move_context_guard before update of date,time_zone,location on wedding_events
      for each row execute function event_move_context_guard();

    create function event_move_heads_published(proposal uuid) returns boolean language sql stable as $$
      select exists(select 1 from event_move_effects e where e.proposal_id=proposal and e.action='apply'
        and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(e.xmin)
        and not exists(select 1 from jsonb_array_elements(e.planned_versions) plan where not exists(
          select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
            and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
          where h.deal_id=(plan->>'dealId')::uuid and v.id=(plan->>'versionId')::uuid
            and event_move_version_allowed(v) is true
            and exists(select 1 from legacy_day_known_holders(v.day_id) k where k.id=v.id))))
    $$;
    create function event_move_resolution_command(target uuid,root_id uuid,version_id uuid) returns boolean language sql stable as $$
      select exists(select 1 from legacy_day_groups g join deals d on d.id=root_id
        join deal_day_scope_heads h on h.deal_id=d.id and h.wedding_id=d.wedding_id
        join deal_day_scope_versions v on v.id=h.current_version_id and v.id=version_id
          and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
        join deal_day_scope_versions previous on previous.id=v.previous_version_id and previous.deal_id=d.id and previous.wedding_id=d.wedding_id
        where g.day_id=target and g.vendor_id=v.vendor_id and previous.day_id=target
          and (g.wedding_id=d.wedding_id or (g.classification='opaque' and g.wedding_id is null))
          and d.state in ('booked','paid_deposit')
          and legacy_day_version_new(v.id) and event_move_version_allowed(v)
          and legacy_day_tuple_current(v) and v.context_kind='explicit_event' and previous.context_kind='explicit_event'
          and previous.event_id=v.event_id and previous.performer_kind='catalog' and previous.vendor_id=v.vendor_id
          and previous.binding_state='active' and previous.slot_id=v.slot_id
          and (v.day_id is distinct from target or exists(select 1 from legacy_day_known_holders(target) k where k.id=v.id))
          and exists(select 1 from event_move_effects e,jsonb_array_elements(e.planned_versions) plan
            where e.action='apply' and plan->>'versionId'=v.id::text and event_move_heads_published(e.proposal_id)))
    $$;
    create function event_move_resolution_valid(target uuid,root_id uuid,version_id uuid) returns boolean language sql stable as $$
      select event_move_resolution_command(target,root_id,version_id) and exists(select 1 from legacy_day_groups g
        join deals d on d.id=root_id and d.wedding_id=g.wedding_id
        where g.day_id=target and g.classification<>'opaque' and root_id=any(g.legacy_candidates))
    $$;

    create or replace function legacy_day_resolution_valid(target uuid,root_id uuid) returns boolean language sql stable as $$
      select exists(select 1 from legacy_day_groups g join deals d on d.id=root_id and d.wedding_id=g.wedding_id
        join deal_day_scope_heads h on h.deal_id=d.id and h.wedding_id=d.wedding_id
        join deal_day_scope_versions v on v.id=h.current_version_id and v.deal_id=h.deal_id
          and v.wedding_id=h.wedding_id and v.revision=h.revision
        where g.day_id=target and root_id=any(g.legacy_candidates) and legacy_day_version_new(v.id)
          and ((d.state='cancelled' and v.binding_state='released' and v.operation in ('observe','release')
                and deal_day_scope_matches_current(v))
            or (d.state in ('booked','paid_deposit') and v.operation='move'
              and v.context_kind in ('implicit_main','explicit_main')
              and v.binding_state in ('active','undated','external') and legacy_day_tuple_current(v)
              and exists(select 1 from deal_day_scope_versions prev where prev.id=v.previous_version_id
                and prev.wedding_id=v.wedding_id and prev.deal_id=v.deal_id
                and prev.context_kind in ('implicit_main','explicit_main')
                and prev.binding_state not in ('done_retained','done_undated','released')
                and (v.day_id is distinct from target
                  or (v.day_id=target
                    and exists(select 1 from legacy_day_known_holders(target) k where k.id=v.id)
                    and row(prev.context_kind,prev.event_id,prev.service_date,prev.time_zone)
                      is distinct from row(v.context_kind,v.event_id,v.service_date,v.time_zone)))))))
      or exists(select 1 from deal_day_scope_heads h where h.deal_id=root_id
        and event_move_resolution_valid(target,root_id,h.current_version_id))
    $$;
    create or replace function legacy_day_resolve(day_id uuid,deal_id uuid,expected_group_revision bigint,current_version_id uuid,reason text)
    returns legacy_day_groups language plpgsql as $$
    declare g legacy_day_groups%rowtype; v deal_day_scope_versions%rowtype;
    begin
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1;
      if not found then raise exception 'Group not classified' using errcode='23514',constraint='legacy_day_group_resolution'; end if;
      perform legacy_day_require_vendor(g.vendor_id);
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1 for update;
      if g.revision is distinct from $3 then
        raise exception 'Group revision changed' using errcode='23514',constraint='legacy_day_group_resolution';
      end if;
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=$2 and (h.wedding_id=g.wedding_id or (g.classification='opaque' and g.wedding_id is null)) and x.id=$4;
      if $5='event_move' then
        if v.id is null or event_move_resolution_command($1,$2,$4) is not true then
          raise exception 'Event resolution needs every exact agreed current head'
            using errcode='23514',constraint='legacy_day_group_resolution';
        end if;
        if g.classification='opaque' or not $2=any(g.legacy_candidates) then return g; end if;
        if event_move_resolution_valid($1,$2,$4) is not true then
          raise exception 'Event resolution cannot invent old membership'
            using errcode='23514',constraint='legacy_day_group_resolution';
        end if;
        update legacy_day_groups set legacy_candidates=array_remove(legacy_candidates,$2),revision=revision+1
          where legacy_day_groups.day_id=$1 returning * into g;
        return g;
      end if;
      if v.context_kind='explicit_event' and event_move_version_allowed(v) then
        raise exception 'Agreed event resolution must name its actual command'
          using errcode='23514',constraint='legacy_day_group_resolution';
      end if;
      if not found or $5 is null or $5 not in ('cancel','main_move')
        or (($5='cancel') is distinct from (v.binding_state='released'))
        or not legacy_day_version_new(v.id) then
        raise exception 'Resolution requires its new exact command version'
          using errcode='23514',constraint='legacy_day_group_resolution';
      end if;
      if $2=any(g.legacy_candidates) then
        if not legacy_day_resolution_valid($1,$2) then
          raise exception 'Resolution cannot invent old membership' using errcode='23514',constraint='legacy_day_group_resolution';
        end if;
        update legacy_day_groups set legacy_candidates=array_remove(legacy_candidates,$2),revision=revision+1
          where legacy_day_groups.day_id=$1 returning * into g;
      end if;
      return g;
    end $$;
    create or replace function audit_legacy_day_resolution() returns trigger language plpgsql as $$
    declare candidate uuid; v deal_day_scope_versions%rowtype;
    begin
      foreach candidate in array OLD.legacy_candidates loop
        if not candidate=any(NEW.legacy_candidates) then
          select x.* into strict v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
            where h.deal_id=candidate and h.wedding_id=OLD.wedding_id;
          if event_move_resolution_command(OLD.day_id,candidate,v.id) is true then
            insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'legacy_day.resolved','deal',candidate,
              jsonb_build_object('dayId',OLD.day_id,'versionId',v.id,'reason','event_move',
                'beforeRevision',OLD.revision::text,'afterRevision',NEW.revision::text));
            continue;
          end if;
          insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'legacy_day.resolved','deal',candidate,
            jsonb_build_object('dayId',OLD.day_id,'versionId',v.id,'reason',
              case when v.binding_state='released' then 'cancel' else 'main_move' end,
              'beforeRevision',OLD.revision::text,'afterRevision',NEW.revision::text));
        end if;
      end loop;
      return NEW;
    end $$;

    create function event_move_domain(material jsonb) returns jsonb language sql immutable as $$
      select jsonb_set(material-'physical','{roots}',coalesce((select jsonb_agg(r-'day' order by r->>'dealId') from jsonb_array_elements(material->'roots') r),'[]'))
    $$;
    create function event_move_expected_domain(baseline jsonb,target jsonb,recorded_at jsonb) returns jsonb language sql immutable as $$
      select jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(event_move_domain(baseline),'{event,date}',target->'date'),
         '{event,time_zone}',target->'timeZone'),'{event,location}',target->'location'),'{event,modified_at}',recorded_at),
        '{programVersion}',to_jsonb(((baseline->>'programVersion')::bigint+1)::text))
    $$;
    -- A pure simulation of the unchanged 89 reconcile algorithm. Its inputs
    -- are the immutable before image and exact planned versions, not an after
    -- row renamed "expected". Only validated native IDs/times are supplied.
    create function event_move_reconcile_projection(p_state jsonb,day uuid,known jsonb,heads jsonb,candidates jsonb,outside_days jsonb)
    returns jsonb language plpgsql immutable as $$
    declare b jsonb; g jsonb; representative text;
    begin
      b:=p_state->'days'->day::text;g:=p_state->'groups'->day::text;
      if b is null or g is null then return p_state; end if;
      select min(x->>'deal_id') into representative from jsonb_array_elements(known) x
        where x->>'day_id'=day::text and (g->>'wedding_id' is null or x->>'wedding_id'=g->>'wedding_id');
      if representative is null then
        select c->>'id' into representative from jsonb_array_elements(candidates) c
          where g->'legacy_candidates' ? (c->>'id') and c->>'wedding_id'=g->>'wedding_id'
            and c->>'vendor_id'=g->>'vendor_id' and c->>'kind' in ('open','done')
            and (c->>'id'=b->>'deal_id' or c->>'kind'<>'done' or not exists(
              select 1 from (select value as pointer_row from jsonb_each(p_state->'days')
                union all select value from jsonb_array_elements(outside_days)) pointers
              where pointers.pointer_row->>'source'='deal' and pointers.pointer_row->>'deal_id'=c->>'id'
                and pointers.pointer_row->>'id'<>day::text))
          order by c->>'created_at',c->>'id' limit 1;
      end if;
      if representative is not null then
        if b->>'deal_id' is distinct from representative then
          b:=b||jsonb_build_object('deal_id',representative,'source_revision',(b->>'source_revision')::bigint+1);
          p_state:=jsonb_set(p_state,array['days',day::text],b);
        end if;
      elsif jsonb_array_length(g->'legacy_candidates')=0 and g->>'classification'<>'opaque'
        and not exists(select 1 from jsonb_array_elements(heads) x where x->>'day_id'=day::text
          and x->>'binding_state' in ('active','done_retained')) then
        p_state:=jsonb_set(jsonb_set(p_state,'{days}',(p_state->'days')-day::text),'{groups}',(p_state->'groups')-day::text);
      elsif g->>'classification'<>'opaque' then
        g:=g||jsonb_build_object('classification','opaque','revision',(g->>'revision')::bigint+1);
        p_state:=jsonb_set(p_state,array['groups',day::text],g);
      end if;
      return p_state;
    end $$;

    create function event_move_expected_physical(before_image jsonb,wedding uuid,target jsonb,moves jsonb,generated jsonb)
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

    create function event_move_assert_physical(effect event_move_effects,baseline jsonb,target jsonb,moves jsonb,actual jsonb)
    returns void language plpgsql as $$
    declare row jsonb; generated jsonb:='{"days":[],"groups":[]}';
      b vendor_busy_dates%rowtype; g legacy_day_groups%rowtype; clock_value jsonb;
    begin
      if event_move_heads_published(effect.proposal_id) is not true then
        raise exception 'Every move head must precede physical resolution' using errcode='23514',constraint='event_move_complete';
      end if;
      for row in select x from jsonb_array_elements(actual->'days') x where not exists(
        select 1 from jsonb_array_elements(baseline->'physical'->'days') old where old->>'id'=x->>'id') loop
        select * into b from vendor_busy_dates where id=(row->>'id')::uuid;
        if not found or b.source<>'deal' or b.date is distinct from (target->>'date')::date
          or b.created_at is distinct from transaction_timestamp()
          or not exists(select 1 from vendor_busy_dates x where x.id=b.id and legacy_day_transaction_owns(x.xmin))
          or not exists(select 1 from jsonb_array_elements(moves) m where m->'version'->>'day_id'=b.id::text
            and m->'version'->>'vendor_id'=b.vendor_id::text) then
          raise exception 'Only genuine planned new target DATEs are allowed' using errcode='23514',constraint='event_move_complete';
        end if;
        generated:=jsonb_set(generated,'{days}',generated->'days'||jsonb_build_array(jsonb_build_object('id',b.id,'vendorId',b.vendor_id,'createdAt',to_jsonb(b.created_at))));
      end loop;
      -- A deleted newly observed old group needs no surviving clock. Its
      -- placeholder cannot hide a retained-row mismatch in the pure result.
      for row in select x from jsonb_array_elements(baseline->'physical'->'days') x
        union all select x from jsonb_array_elements(actual->'days') x loop
        if exists(select 1 from jsonb_array_elements(baseline->'physical'->'groups') old where old->>'day_id'=row->>'id')
          or exists(select 1 from jsonb_array_elements(generated->'groups') old where old->>'dayId'=row->>'id') then continue; end if;
        select * into g from legacy_day_groups where day_id=(row->>'id')::uuid;
        clock_value:=to_jsonb(effect.created_at);
        if found then
          if g.classified_at<effect.created_at or g.classified_at>clock_timestamp()
            or not exists(select 1 from legacy_day_groups x where x.day_id=g.day_id and legacy_day_transaction_owns(x.xmin)) then
            raise exception 'New group clock must be native to this effect' using errcode='23514',constraint='event_move_complete';
          end if;
          clock_value:=to_jsonb(g.classified_at);
        end if;
        generated:=jsonb_set(generated,'{groups}',generated->'groups'||jsonb_build_array(jsonb_build_object('dayId',row->'id','classifiedAt',clock_value)));
      end loop;
      if actual-'facts' is distinct from event_move_expected_physical(baseline->'physical',effect.wedding_id,target,moves,generated) then
        raise exception 'Move changed an unplanned physical DATE, holder or uncertainty' using errcode='23514',constraint='event_move_complete';
      end if;
    end $$;

    create function event_move_assert_applied(effect_id uuid) returns void language plpgsql as $$
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
    create function event_move_complete_guard() returns trigger language plpgsql as $$
    declare e record;
    begin
      if TG_TABLE_NAME='event_move_proposals' then
        if TG_OP='INSERT' then
          if exists(select 1 from event_move_proposals where id=NEW.id) and event_move_root_set_complete(NEW.id) is not true then
            raise exception 'Proposal must contain its entire root set' using errcode='23514',constraint='event_move_complete';
          end if;
        end if;
      elsif TG_TABLE_NAME='event_move_effects' then
        if TG_OP='INSERT' then
          if NEW.action='apply' then perform event_move_assert_applied(NEW.id); end if;
        end if;
      end if;
      for e in select id from event_move_effects x where x.action='apply' and x.transaction_id=txid_current()
        and x.backend_pid=pg_backend_pid() and legacy_day_transaction_owns(x.xmin) loop
        perform event_move_assert_applied(e.id);
      end loop;
      return null;
    end $$;
  `)
  for (const table of ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects',
    'weddings', 'wedding_events', 'slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_events',
    'payments', 'payment_installments', 'payment_receipts', 'payment_corrections', 'payment_installment_edits',
    'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments',
    'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations', 'vendor_availability_policy',
    'deal_day_scope_heads', 'deal_day_scope_versions', 'vendor_busy_dates', 'legacy_day_groups',
    'timeline_events', 'timeline_assignments', 'timeline_dependencies', 'vendor_staff_duties', 'guest_event_invitations',
    'event_guest_participation', 'event_rsvp_requests', 'offer_requests', 'offers', 'external_invites', 'external_program_acknowledgments', 'vendor_program_acknowledgments',
    'users', 'sessions', 'consents', 'wedding_members', 'vendors']) {
    pgm.sql(`create constraint trigger event_move_complete after insert or update or delete on ${table}
      deferrable initially deferred for each row execute function event_move_complete_guard();`)
  }
}

exports.down = pgm => {
  // Lock evidence before deciding whether down is empty. No evidence deletion
  // or CASCADE is an acceptable substitute for a preserving forward change.
  pgm.sql(`
    set local lock_timeout='5s';
    lock table event_move_proposals,event_move_roots,event_move_receipts,event_move_effects,
      deal_day_scope_versions,deal_day_scope_heads,legacy_day_groups,vendor_busy_dates,wedding_events,audit_log
      in access exclusive mode;
    do $$ begin
      if exists(select 1 from event_move_proposals) or exists(select 1 from event_move_roots)
        or exists(select 1 from event_move_receipts) or exists(select 1 from event_move_effects)
        or exists(select 1 from audit_log where left(action,11)='event_move.'
          or (action='legacy_day.resolved' and diff->>'reason'='event_move')) then
        raise exception 'Event move evidence exists; use a preserving forward migration'
          using errcode='23514',constraint='event_move_preserving_down';
      end if;
    end $$;
  `)
  for (const table of ['event_move_proposals', 'event_move_roots', 'event_move_receipts', 'event_move_effects',
    'weddings', 'wedding_events', 'slots', 'deals', 'deal_orders', 'order_assignments', 'order_parts', 'deal_events',
    'payments', 'payment_installments', 'payment_receipts', 'payment_corrections', 'payment_installment_edits',
    'deal_terms_versions', 'deal_terms_receipts', 'deal_resource_plan_versions', 'deal_resource_commitments',
    'deal_resource_commitment_versions', 'deal_resource_commitment_members', 'resource_allocations', 'vendor_availability_policy',
    'deal_day_scope_heads', 'deal_day_scope_versions', 'vendor_busy_dates', 'legacy_day_groups',
    'timeline_events', 'timeline_assignments', 'timeline_dependencies', 'vendor_staff_duties', 'guest_event_invitations',
    'event_guest_participation', 'event_rsvp_requests', 'offer_requests', 'offers', 'external_invites', 'external_program_acknowledgments', 'vendor_program_acknowledgments',
    'users', 'sessions', 'consents', 'wedding_members', 'vendors']) {
    pgm.sql(`drop trigger event_move_complete on ${table};`)
  }
  pgm.sql(`
    drop trigger event_move_version_guard on deal_day_scope_versions;
    drop trigger zz_event_move_context_guard on wedding_events;
    drop trigger event_move_proposal_guard on event_move_proposals;
    drop trigger event_move_root_guard on event_move_roots;
    drop trigger event_move_receipt_guard on event_move_receipts;
    drop trigger event_move_effect_guard on event_move_effects;
    drop trigger immutable_event_move_proposal on event_move_proposals;
    drop trigger immutable_event_move_root on event_move_roots;
    drop trigger immutable_event_move_receipt on event_move_receipts;
    drop trigger immutable_event_move_effect on event_move_effects;
    create or replace function legacy_day_resolution_valid(target uuid,root_id uuid) returns boolean language sql stable as $$
      select exists(select 1 from legacy_day_groups g join deals d on d.id=root_id and d.wedding_id=g.wedding_id
        join deal_day_scope_heads h on h.deal_id=d.id and h.wedding_id=d.wedding_id
        join deal_day_scope_versions v on v.id=h.current_version_id and v.deal_id=h.deal_id
          and v.wedding_id=h.wedding_id and v.revision=h.revision
        where g.day_id=target and root_id=any(g.legacy_candidates) and legacy_day_version_new(v.id)
          and ((d.state='cancelled' and v.binding_state='released' and v.operation in ('observe','release')
                and deal_day_scope_matches_current(v))
            or (d.state in ('booked','paid_deposit') and v.operation='move'
              and v.context_kind in ('implicit_main','explicit_main')
              and v.binding_state in ('active','undated','external') and legacy_day_tuple_current(v)
              and exists(select 1 from deal_day_scope_versions prev where prev.id=v.previous_version_id
                and prev.wedding_id=v.wedding_id and prev.deal_id=v.deal_id
                and prev.context_kind in ('implicit_main','explicit_main')
                and prev.binding_state not in ('done_retained','done_undated','released')
                and (v.day_id is distinct from target
                  or (v.day_id=target
                    and exists(select 1 from legacy_day_known_holders(target) k where k.id=v.id)
                    and row(prev.context_kind,prev.event_id,prev.service_date,prev.time_zone)
                      is distinct from row(v.context_kind,v.event_id,v.service_date,v.time_zone)))))))
    $$;
    create or replace function legacy_day_resolve(day_id uuid,deal_id uuid,expected_group_revision bigint,current_version_id uuid,reason text)
    returns legacy_day_groups language plpgsql as $$
    declare g legacy_day_groups%rowtype; v deal_day_scope_versions%rowtype;
    begin
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1;
      if not found then raise exception 'Group not classified' using errcode='23514',constraint='legacy_day_group_resolution'; end if;
      perform legacy_day_require_vendor(g.vendor_id);
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1 for update;
      if g.revision is distinct from $3 then
        raise exception 'Group revision changed' using errcode='23514',constraint='legacy_day_group_resolution';
      end if;
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=$2 and (h.wedding_id=g.wedding_id or (g.classification='opaque' and g.wedding_id is null)) and x.id=$4;
      if not found or $5 is null or $5 not in ('cancel','main_move')
        or (($5='cancel') is distinct from (v.binding_state='released'))
        or not legacy_day_version_new(v.id) then
        raise exception 'Resolution requires its new exact command version'
          using errcode='23514',constraint='legacy_day_group_resolution';
      end if;
      if $2=any(g.legacy_candidates) then
        if not legacy_day_resolution_valid($1,$2) then
          raise exception 'Resolution cannot invent old membership' using errcode='23514',constraint='legacy_day_group_resolution';
        end if;
        update legacy_day_groups set legacy_candidates=array_remove(legacy_candidates,$2),revision=revision+1
          where legacy_day_groups.day_id=$1 returning * into g;
      end if;
      return g;
    end $$;
    create or replace function audit_legacy_day_resolution() returns trigger language plpgsql as $$
    declare candidate uuid; v deal_day_scope_versions%rowtype;
    begin
      foreach candidate in array OLD.legacy_candidates loop
        if not candidate=any(NEW.legacy_candidates) then
          select x.* into strict v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
            where h.deal_id=candidate and h.wedding_id=OLD.wedding_id;
          insert into audit_log(actor_id,action,entity,entity_id,diff) values(null,'legacy_day.resolved','deal',candidate,
            jsonb_build_object('dayId',OLD.day_id,'versionId',v.id,'reason',
              case when v.binding_state='released' then 'cancel' else 'main_move' end,
              'beforeRevision',OLD.revision::text,'afterRevision',NEW.revision::text));
        end if;
      end loop;
      return NEW;
    end $$;
    drop function event_move_complete_guard();
    drop function event_move_assert_applied(uuid);
    drop function event_move_assert_physical(event_move_effects,jsonb,jsonb,jsonb,jsonb);
    drop function event_move_expected_physical(jsonb,uuid,jsonb,jsonb,jsonb);
    drop function event_move_reconcile_projection(jsonb,uuid,jsonb,jsonb,jsonb,jsonb);
    drop function event_move_expected_domain(jsonb,jsonb,jsonb);
    drop function event_move_domain(jsonb);
    drop function event_move_resolution_valid(uuid,uuid,uuid);
    drop function event_move_resolution_command(uuid,uuid,uuid);
    drop function event_move_heads_published(uuid);
    drop function event_move_context_guard();
    drop function event_move_requires_agreement(uuid,uuid);
    drop function event_move_version_guard();
    drop function event_move_version_allowed(deal_day_scope_versions);
    drop function event_move_effect_guard();
    drop function event_move_agreed(uuid,text);
    drop function event_move_root_set_complete(uuid);
    drop function event_move_receipt_guard();
    drop function event_move_root_guard();
    drop function event_move_proposal_guard();
    drop function event_move_history_guard();
    drop function event_move_principal_current(uuid,uuid,text,uuid,uuid,text);
    drop function event_move_root_material(jsonb,jsonb,uuid,uuid);
    drop function event_move_scope_supported(jsonb);
    drop function event_move_source_snapshot(uuid,uuid);
    drop function event_move_snapshot_valid(jsonb);
    drop function event_move_physical_snapshot(uuid[],uuid[]);
    drop function event_move_target_valid(jsonb);
    drop table event_move_effects;
    drop table event_move_receipts;
    drop table event_move_roots;
    drop table event_move_proposals;
  `)
}
