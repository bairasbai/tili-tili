/* Preserving forward fix for JSONB extraction/subtraction precedence in91.
 * Applied91 remains byte-exact; no data or key-set changes. */
exports.up = pgm => pgm.sql(`
    create or replace function event_move_snapshot_valid(value jsonb) returns boolean language plpgsql immutable as $$
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
        and (value->'eventObligations')-obligation_keys='{}'::jsonb and value->'eventObligations' ?& obligation_keys
        and jsonb_typeof(value->'physical')='object' and (value->'physical')-physical_keys='{}'::jsonb
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
          and jsonb_typeof(r->'domain')='object' and (r->'domain')-domain_keys='{}'::jsonb and r->'domain' ?& domain_keys
          and jsonb_typeof(r->'day')='object' and (r->'day')-array['heads','versions']='{}'::jsonb
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
`);

exports.down = pgm => pgm.sql(`
    set local lock_timeout='5s';
    lock table event_move_proposals,event_move_roots,event_move_receipts,event_move_effects,audit_log in access exclusive mode;
    do $guard$ begin
      if exists(select 1 from event_move_proposals) or exists(select 1 from event_move_roots)
        or exists(select 1 from event_move_receipts) or exists(select 1 from event_move_effects)
        or exists(select 1 from audit_log where left(action,11)='event_move.'
          or (action='legacy_day.resolved' and diff->>'reason'='event_move')) then
        raise exception using errcode='23514',constraint='event_move_snapshot_fix_preserving_down',
          message='Event move evidence exists; use a preserving forward migration';
      end if;
    end $guard$;
    create or replace function event_move_snapshot_valid(value jsonb) returns boolean language plpgsql immutable as $$
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
`);
