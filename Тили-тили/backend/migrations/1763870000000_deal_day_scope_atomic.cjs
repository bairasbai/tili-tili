/* Atomic DATE groups and versioned inventory. No historical backfill.
 * The financial writer owns its existing authority/lock prefix; these SQL
 * primitives require the complete transaction vendor union before any write.
 * Applied 380/381/87/88 and the /1 material builder remain unchanged.
 */
exports.up = pgm => {
  pgm.sql(`
    create table legacy_day_groups(
      day_id uuid primary key references vendor_busy_dates(id) on delete cascade,
      vendor_id uuid not null, service_date date not null, wedding_id uuid,
      classification text not null check(classification in ('exact','legacy_unknown','opaque')),
      legacy_candidates uuid[] not null, revision bigint not null check(revision>0),
      classified_at timestamptz not null default clock_timestamp()
    );

    create function legacy_day_transaction_owns(row_xmin xid) returns boolean language sql stable as $$
      select row_xmin::text::numeric = mod(pg_current_xact_id()::text::numeric,4294967296)
    $$;
    create function legacy_day_version_new(target uuid) returns boolean language sql stable as $$
      select exists(select 1 from deal_day_scope_versions v where v.id=target and legacy_day_transaction_owns(v.xmin))
    $$;
    create function legacy_day_uuid_set(ids uuid[]) returns uuid[] language sql immutable as $$
      select coalesce(array_agg(id order by id),'{}'::uuid[])
        from (select distinct id from unnest(ids) id where id is not null) x
    $$;
    create function legacy_day_vendor_locked(vendor uuid) returns boolean language sql volatile as $$
      select exists(select 1 from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()
        and granted and mode='ExclusiveLock' and classid=176387 and objsubid=2
        and objid::bigint=mod(hashtext(vendor::text)::bigint+4294967296,4294967296))
    $$;
    create function legacy_day_lock_vendors(vendors uuid[]) returns void language plpgsql as $$
    declare k integer; highest bigint; new_keys integer[];
    begin
      if vendors is null or array_position(vendors,null) is not null then
        raise exception 'Exact vendor union required' using errcode='23514',constraint='legacy_day_lock_order';
      end if;
      select array_agg(key order by key) into new_keys from
        (select distinct hashtext(id::text) key from unnest(vendors) id
          where not legacy_day_vendor_locked(id)) keys;
      if new_keys is null then return; end if;
      select max(case when objid::bigint>=2147483648 then objid::bigint-4294967296 else objid::bigint end)
        into highest from pg_catalog.pg_locks where locktype='advisory' and pid=pg_backend_pid()
          and granted and classid=176387 and objsubid=2;
      if highest is not null and (new_keys[1]<highest or
        exists(select 1 from legacy_day_groups g where legacy_day_transaction_owns(g.xmin)) or
        exists(select 1 from deal_day_scope_versions v where legacy_day_version_new(v.id))) then
        raise exception 'Nested DATE scope cannot extend a written vendor union'
          using errcode='23514',constraint='legacy_day_lock_order';
      end if;
      foreach k in array new_keys loop perform pg_advisory_xact_lock(176387,k); end loop;
    end $$;
    create function legacy_day_require_vendor(vendor uuid) returns void language plpgsql as $$
    begin
      if vendor is null or not legacy_day_vendor_locked(vendor) then
        raise exception 'DATE vendor union must be locked first' using errcode='23514',constraint='legacy_day_lock_order';
      end if;
    end $$;

    -- Pointer-independent tuple predicate is installed below from the literal
    -- 88 matcher. The historical matcher itself keeps its strict pointer test.
    create function legacy_day_tuple_current(v deal_day_scope_versions)
    returns boolean language plpgsql stable as $$
    declare root_row record; event_row record; event_found boolean; pointer_valid boolean;
    begin
      select d.state,d.vendor_id,d.external_name,d.slot_id,s.program_event_id,s.deal_id selected_deal_id,
        w.date wedding_date,w.tz wedding_tz
        into root_row from deals d join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
        join weddings w on w.id=d.wedding_id
        where d.id=v.deal_id and d.wedding_id=v.wedding_id;
      if not found or root_row.slot_id is distinct from v.slot_id then return false; end if;

      -- Release is a non-membership observation; its literal history need not
      -- retain a live company/event. It never makes the old DATE available.
      if v.binding_state='released' then return root_row.state='cancelled' and v.day_id is null; end if;
      if v.performer_kind='catalog' then
        if root_row.vendor_id is distinct from v.vendor_id
          or not exists(select 1 from vendors where id=v.vendor_id) then return false; end if;
      elsif v.performer_kind='external' then
        if root_row.vendor_id is not null or root_row.external_name is null then return false; end if;
      end if;

      -- Undated completion retains the predecessor tuple without a live event,
      -- DATE or selected-deal lookup. It grants no availability authority.
      if v.binding_state='done_undated' then
        return root_row.state='done';
      end if;
      if v.binding_state='done_retained' then
        if root_row.state<>'done' then return false; end if;
      else
        select e.id,e.is_main,e.date,e.time_zone into event_row from wedding_events e
          where e.wedding_id=v.wedding_id and
            ((root_row.program_event_id is null and e.is_main) or e.id=root_row.program_event_id);
        event_found := found;
        if v.context_kind='implicit_main' then
          if root_row.program_event_id is not null or not event_found or not event_row.is_main
            or v.event_id is distinct from event_row.id then return false; end if;
        elsif v.context_kind in ('explicit_main','explicit_event') then
          if not event_found or root_row.program_event_id is distinct from v.event_id
            or v.event_id is distinct from event_row.id
            or event_row.is_main is distinct from (v.context_kind='explicit_main') then return false; end if;
        end if;
        if v.context_kind='unknown' and v.event_id is not null
          and (not event_found or v.event_id is distinct from event_row.id) then return false; end if;
        if v.binding_state='unknown' then
          if (v.event_id is not null and (not event_found or v.event_id is distinct from event_row.id))
            or (v.service_date is not null and (not event_found or v.service_date is distinct from event_row.date))
            or (v.time_zone is not null and (not event_found or v.time_zone is distinct from event_row.time_zone)) then return false; end if;
          if event_found and event_row.is_main and
            ((v.service_date is not null and v.service_date is distinct from root_row.wedding_date)
              or (v.time_zone is not null and v.time_zone is distinct from root_row.wedding_tz)) then return false; end if;
          return v.day_id is null;
        end if;
        if not event_found or v.service_date is distinct from event_row.date
          or v.time_zone is distinct from event_row.time_zone then return false; end if;
        if event_row.is_main and (event_row.date is distinct from root_row.wedding_date
          or event_row.time_zone is distinct from root_row.wedding_tz) then return false; end if;
        if root_row.selected_deal_id is distinct from v.deal_id then return false; end if;
        if v.binding_state='external' then return root_row.state in ('booked','paid_deposit','done'); end if;
        if root_row.state not in ('booked','paid_deposit') then return false; end if;
        if v.binding_state='undated' then return v.service_date is null and v.day_id is null; end if;
      end if;

      return true;
    end $$;

    create function legacy_day_known_holders(target uuid) returns setof deal_day_scope_versions language sql stable as $$
      select v.* from deal_day_scope_heads h join deal_day_scope_versions v
        on v.id=h.current_version_id and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
      join vendor_busy_dates b on b.id=v.day_id and b.vendor_id=v.vendor_id and b.date=v.service_date and b.source='deal'
      where b.id=target and v.binding_state in ('active','done_retained')
        and legacy_day_tuple_current(v)
        and not exists(select 1 from deal_resource_commitments c where c.deal_id=v.deal_id and c.revision>0)
    $$;
    create function legacy_day_exact_root(root_id uuid) returns boolean language sql stable as $$
      select exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
        and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
        where h.deal_id=root_id and v.binding_state in ('active','done_retained')
          and deal_day_scope_matches_current(v)
          and exists(select 1 from legacy_day_known_holders(v.day_id) k where k.id=v.id))
    $$;
    create function legacy_day_initial_candidates(target uuid) returns uuid[] language sql stable as $$
      select coalesce(array_agg(d.id order by d.id),'{}'::uuid[])
      from vendor_busy_dates b join deals p on p.id=b.deal_id
      join deals d on d.wedding_id=p.wedding_id and d.vendor_id=b.vendor_id
      where b.id=target and b.source='deal' and p.vendor_id=b.vendor_id
        and p.state in ('booked','paid_deposit','done') and exists(select 1 from weddings where id=p.wedding_id)
        and d.state in ('booked','paid_deposit','done')
        and (d.id=b.deal_id or d.state<>'done' or not exists(
          select 1 from vendor_busy_dates x where x.deal_id=d.id and x.source='deal'))
        and not legacy_day_exact_root(d.id)
    $$;
    create function legacy_day_group_wedding(target uuid) returns uuid language sql stable as $$
      select p.wedding_id from vendor_busy_dates b join deals p on p.id=b.deal_id
        join weddings w on w.id=p.wedding_id
      where b.id=target and b.source='deal' and p.vendor_id=b.vendor_id and p.state in ('booked','paid_deposit','done')
        and not exists(select 1 from legacy_calendar_sources s where s.day_id=b.id and s.kind='app_day'
          and s.wedding_id is distinct from p.wedding_id)
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where v.day_id=b.id and v.wedding_id is distinct from p.wedding_id)
        and not exists(select 1 from deal_resource_commitments c where c.deal_id=p.id and c.revision>0)
    $$;

    create function legacy_day_resolution_valid(target uuid,root_id uuid) returns boolean language sql stable as $$
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
    create function protect_legacy_day_group() returns trigger language plpgsql as $$
    declare b vendor_busy_dates%rowtype; wed uuid; candidate uuid;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from vendor_busy_dates where id=OLD.day_id) then
          raise exception 'Group can only disappear with its DATE' using errcode='23514',constraint='legacy_day_group_identity';
        end if;
        return OLD;
      end if;
      if not(TG_OP='UPDATE' and NEW.classification='opaque' and NEW.legacy_candidates=OLD.legacy_candidates
        and (not exists(select 1 from vendors where id=OLD.vendor_id)
          or (OLD.wedding_id is not null and not exists(select 1 from weddings where id=OLD.wedding_id)))) then
        perform legacy_day_require_vendor(NEW.vendor_id);
      end if;
      select * into b from vendor_busy_dates where id=NEW.day_id for update;
      if not found or b.source<>'deal' or b.vendor_id is distinct from NEW.vendor_id
        or b.date is distinct from NEW.service_date
        or NEW.legacy_candidates is distinct from legacy_day_uuid_set(NEW.legacy_candidates) then
        raise exception 'Group must bind one exact DATE identity' using errcode='23514',constraint='legacy_day_group_identity';
      end if;
      if TG_OP='INSERT' then
        NEW.classified_at:=clock_timestamp();
        wed:=legacy_day_group_wedding(b.id);
        if NEW.revision<>1 or NEW.wedding_id is distinct from wed or
          (NEW.classification='exact' and (pg_trigger_depth()<2 or wed is null or b.source_revision<>1
            or cardinality(NEW.legacy_candidates)<>0)) or
          (wed is not null and NEW.classification<>'exact' and
            (NEW.classification<>'legacy_unknown' or NEW.legacy_candidates is distinct from legacy_day_initial_candidates(b.id))) or
          (wed is null and (NEW.classification<>'opaque' or cardinality(NEW.legacy_candidates)<>0)) then
          raise exception 'Group classification requires actual first observation'
            using errcode='23514',constraint='legacy_day_group_identity';
        end if;
      else
        if row(NEW.day_id,NEW.vendor_id,NEW.service_date,NEW.wedding_id,NEW.classified_at) is distinct from
          row(OLD.day_id,OLD.vendor_id,OLD.service_date,OLD.wedding_id,OLD.classified_at)
          or NEW.revision<>OLD.revision+1
          or not NEW.legacy_candidates<@OLD.legacy_candidates
          or (NEW.classification<>OLD.classification and NEW.classification<>'opaque')
          or (NEW.classification=OLD.classification and NEW.legacy_candidates=OLD.legacy_candidates) then
          raise exception 'Group identity/uncertainty cannot be rewritten'
            using errcode='23514',constraint='legacy_day_group_identity';
        end if;
        foreach candidate in array OLD.legacy_candidates loop
          if not candidate=any(NEW.legacy_candidates) and not legacy_day_resolution_valid(OLD.day_id,candidate) then
            raise exception 'Unknown membership requires an actual own command'
              using errcode='23514',constraint='legacy_day_group_resolution';
          end if;
        end loop;
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_day_group before insert or update or delete on legacy_day_groups
      for each row execute function protect_legacy_day_group();
    create function legacy_day_discover_new() returns trigger language plpgsql as $$
    declare wed uuid;
    begin
      if NEW.source<>'deal' or not legacy_day_vendor_locked(NEW.vendor_id) then return NEW; end if;
      wed:=legacy_day_group_wedding(NEW.id);
      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)
        values(NEW.id,NEW.vendor_id,NEW.date,wed,case when wed is null then 'opaque' else 'exact' end,'{}'::uuid[],1);
      return NEW;
    end $$;
    create trigger legacy_day_discover_new after insert on vendor_busy_dates
      for each row execute function legacy_day_discover_new();
    create function audit_legacy_day_resolution() returns trigger language plpgsql as $$
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
    create trigger audit_legacy_day_resolution after update on legacy_day_groups
      for each row execute function audit_legacy_day_resolution();

    create function legacy_day_group_touch(day_id uuid,wedding_id uuid,expected_source_revision bigint)
    returns legacy_day_groups language plpgsql as $$
    declare b vendor_busy_dates%rowtype; g legacy_day_groups%rowtype; wed uuid;
    begin
      select * into b from vendor_busy_dates where id=$1;
      if not found then raise exception 'DATE disappeared' using errcode='23514',constraint='legacy_day_group_identity'; end if;
      perform legacy_day_require_vendor(b.vendor_id);
      select * into b from vendor_busy_dates where id=$1 for update;
      if not found or b.source<>'deal' or b.source_revision is distinct from $3 then
        raise exception 'DATE identity/revision changed' using errcode='23514',constraint='legacy_day_group_identity';
      end if;
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1 for update;
      if found then
        if g.wedding_id is distinct from $2 and not(g.classification='opaque' and g.wedding_id is null) then
          raise exception 'DATE belongs to another scope' using errcode='23514',constraint='legacy_day_group_identity';
        end if;
        return g;
      end if;
      wed:=legacy_day_group_wedding(b.id);
      if wed is not null and wed is distinct from $2 then
        raise exception 'DATE pointer scope changed' using errcode='23514',constraint='legacy_day_group_identity';
      end if;
      insert into legacy_day_groups(day_id,vendor_id,service_date,wedding_id,classification,legacy_candidates,revision)
        values(b.id,b.vendor_id,b.date,wed,case when wed is null then 'opaque' else 'legacy_unknown' end,
          case when wed is null then '{}'::uuid[] else legacy_day_initial_candidates(b.id) end,1) returning * into g;
      return g;
    end $$;
    create function legacy_day_acquire(vendor_id uuid,service_date date,wedding_id uuid,deal_id uuid)
    returns uuid language plpgsql as $$
    declare b vendor_busy_dates%rowtype; g legacy_day_groups%rowtype;
    begin
      perform legacy_day_require_vendor($1);
      if $2 is null or not exists(select 1 from deals d join slots s on s.id=d.slot_id
        where d.id=$4 and d.wedding_id=$3 and d.vendor_id=$1 and s.wedding_id=$3
          and (d.state='done' or s.deal_id=d.id) and d.state in ('booked','paid_deposit','done')) then
        raise exception 'DATE acquire requires its actual selected committed root'
          using errcode='23514',constraint='legacy_day_group_identity';
      end if;
      insert into vendor_busy_dates(vendor_id,date,source,deal_id) values($1,$2,'deal',$4)
        on conflict on constraint vendor_busy_dates_pk do nothing;
      select * into b from vendor_busy_dates where vendor_busy_dates.vendor_id=$1 and date=$2 for update;
      if b.source='deal' and exists(select 1 from legacy_day_groups where day_id=b.id and legacy_day_groups.wedding_id=$3)
        and not exists(select 1 from deals p where p.id=b.deal_id and p.wedding_id=$3 and p.vendor_id=$1
          and p.state in ('booked','paid_deposit','done'))
        and exists(select 1 from legacy_day_known_holders(b.id) k where k.wedding_id=$3) then
        select * into g from legacy_day_groups where day_id=b.id for update;
        perform legacy_day_reconcile(b.id,g.revision);
        select * into b from vendor_busy_dates where vendor_busy_dates.vendor_id=$1 and date=$2 for update;
      end if;
      if b.source<>'deal' or not exists(select 1 from deals p where p.id=b.deal_id
          and p.wedding_id=$3 and p.vendor_id=$1 and p.state in ('booked','paid_deposit','done')) then
        raise exception 'DATE is unavailable' using errcode='23505',constraint='vendor_busy_dates_pk';
      end if;
      g:=legacy_day_group_touch(b.id,$3,b.source_revision);
      return b.id;
    end $$;
    create function legacy_day_resolve(day_id uuid,deal_id uuid,expected_group_revision bigint,current_version_id uuid,reason text)
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
    create function legacy_day_reconcile(day_id uuid,expected_group_revision bigint) returns void language plpgsql as $$
    declare g legacy_day_groups%rowtype; b vendor_busy_dates%rowtype; representative uuid;
    begin
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1;
      if not found then raise exception 'Group not classified' using errcode='23514',constraint='legacy_day_group_identity'; end if;
      perform legacy_day_require_vendor(g.vendor_id);
      select * into b from vendor_busy_dates where id=$1 for update;
      select * into g from legacy_day_groups where legacy_day_groups.day_id=$1 for update;
      if g.revision is distinct from $2 or b.id is null then
        raise exception 'Group revision changed' using errcode='23514',constraint='legacy_day_group_identity';
      end if;
      select k.deal_id into representative from legacy_day_known_holders($1) k
        where g.wedding_id is null or k.wedding_id=g.wedding_id order by k.deal_id limit 1;
      if representative is null then
        select d.id into representative from deals d where d.id=any(g.legacy_candidates)
          and d.wedding_id=g.wedding_id and d.vendor_id=g.vendor_id and d.state in ('booked','paid_deposit','done')
          and (d.id=b.deal_id or d.state<>'done' or not exists(
            select 1 from vendor_busy_dates x where x.source='deal' and x.deal_id=d.id and x.id<>b.id))
          order by d.created_at,d.id limit 1;
      end if;
      if representative is not null then
        if b.deal_id is distinct from representative then update vendor_busy_dates set deal_id=representative where id=$1; end if;
      elsif cardinality(g.legacy_candidates)=0 and g.classification<>'opaque'
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where v.day_id=$1 and v.binding_state in ('active','done_retained')) then
        delete from vendor_busy_dates where id=$1 and source='deal';
      elsif g.classification<>'opaque' then
        update legacy_day_groups set classification='opaque',revision=revision+1 where legacy_day_groups.day_id=$1;
      end if;
    end $$;

    -- Literal head+version, including stale/unknown/non-DATE heads. NULL means
    -- no head, never a filtered-out binding. This is evidence, not K/authority.
    create function legacy_day_scope_material(wedding uuid,root_id uuid) returns jsonb language plpgsql stable as $$
    declare h deal_day_scope_heads%rowtype; v deal_day_scope_versions%rowtype;
    begin
      select * into h from deal_day_scope_heads where wedding_id=$1 and deal_id=$2;
      if not found then return null; end if;
      select * into v from deal_day_scope_versions where id=h.current_version_id and wedding_id=h.wedding_id
        and deal_id=h.deal_id and revision=h.revision;
      if not found then raise exception 'Head requires its exact version' using errcode='23514',constraint='deal_day_scope_chain'; end if;
      return jsonb_build_object('head',jsonb_build_object('weddingId',h.wedding_id,'dealId',h.deal_id,
          'revision',h.revision::text,'currentVersionId',h.current_version_id),
        'version',jsonb_build_object('id',v.id,'weddingId',v.wedding_id,'dealId',v.deal_id,'slotId',v.slot_id,
          'schemaVersion',v.schema_version,'revision',v.revision::text,'previousVersionId',v.previous_version_id,
          'originKnowledge',v.origin_knowledge,'operation',v.operation,
          'recordedAt',to_char(v.recorded_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'contextKind',v.context_kind,'eventId',v.event_id,'performerKind',v.performer_kind,'vendorId',v.vendor_id,
          'bindingState',v.binding_state,'serviceDate',to_char(v.service_date,'YYYY-MM-DD'),'timeZone',v.time_zone,'dayId',v.day_id));
    end $$;
    create function legacy_calendar_holder_v2(p_wedding_id uuid,p_deal_id uuid) returns jsonb language sql stable as $$
      select old_holder||jsonb_build_object('dayScope',legacy_day_scope_material($1,$2))
        from (select legacy_calendar_holder($1,$2) old_holder) literal where old_holder is not null
    $$;
    -- /2 is derived by one pure SQL dispatcher. No read/capture classifies U.
    create function legacy_day_group_material(day_id uuid) returns jsonb language sql stable as $$
      select jsonb_build_object('dayId',$1,'vendorId',coalesce(b.vendor_id,g.vendor_id),
        'date',to_char(coalesce(b.date,g.service_date),'YYYY-MM-DD'),'weddingId',g.wedding_id,
        'classification',coalesce(g.classification,'unclassified'),'groupRevision',g.revision::text,
        'legacyCandidates',to_jsonb(coalesce(g.legacy_candidates,'{}'::uuid[])),
        'opaque',g.day_id is null or b.id is null or g.classification='opaque'
          or (g.wedding_id is not null and not exists(select 1 from weddings where id=g.wedding_id)) or
          exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
            where v.day_id=$1 and v.binding_state in ('active','done_retained') and not exists(
              select 1 from legacy_day_known_holders($1) k where k.id=v.id)),
        'knownHolders',coalesce((select jsonb_agg(legacy_day_scope_material(k.wedding_id,k.deal_id)
          order by k.wedding_id,k.deal_id) from legacy_day_known_holders($1) k),'[]'::jsonb),
        'day',case when b.id is null then null else jsonb_build_object('id',b.id,'vendorId',b.vendor_id,
          'date',to_char(b.date,'YYYY-MM-DD'),'source',b.source,'dealId',b.deal_id,
          'createdAt',to_char(b.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
          'sourceRevision',b.source_revision::text) end)
      from (select 1) witness left join vendor_busy_dates b on b.id=$1 left join legacy_day_groups g on g.day_id=$1
    $$;
    create function legacy_calendar_day_ids(source legacy_calendar_sources) returns setof uuid language sql stable as $$
      select id from (
        select source.day_id id where source.day_id is not null
        union select b.id from vendor_busy_dates b where source.root_deal_id is not null and b.deal_id=source.root_deal_id
        union select v.day_id from deal_day_scope_versions v where source.root_deal_id is not null
          and v.deal_id=source.root_deal_id and v.wedding_id=source.wedding_id and v.day_id is not null
        union select g.day_id from legacy_day_groups g where source.root_deal_id=any(g.legacy_candidates)
          and g.wedding_id=source.wedding_id
      ) ids order by id
    $$;
    create function legacy_calendar_current_inventory_material(source legacy_calendar_sources)
    returns jsonb language plpgsql stable as $$
    declare mat jsonb; scopes jsonb; activated boolean; holders jsonb; root jsonb; uncertain boolean;
    begin
      mat:=legacy_calendar_inventory_material(source);
      select exists(select 1 from legacy_day_groups g where g.day_id in (select legacy_calendar_day_ids(source)))
        or exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where (source.root_deal_id=h.deal_id and source.wedding_id=h.wedding_id) or v.day_id=source.day_id
            or exists(select 1 from vendor_busy_dates b where b.id=source.day_id and b.deal_id=h.deal_id))
        or exists(select 1 from legacy_calendar_versions v where v.source_id=source.id
          and v.canonical::jsonb->>'encoding'='legacy-calendar-inventory/2') into activated;
      if not activated then return mat; end if;
      select coalesce(jsonb_agg(legacy_day_group_material(id) order by id),'[]'::jsonb)
        into scopes from legacy_calendar_day_ids(source) id;
      uncertain:=exists(select 1 from jsonb_array_elements(scopes) g where (g->>'opaque')::boolean
        or g->>'classification'='unclassified' or jsonb_array_length(g->'legacyCandidates')>0);
      if source.kind='app_day' then
        select coalesce(jsonb_agg(legacy_calendar_holder_v2(k.wedding_id,k.deal_id) order by k.wedding_id,k.deal_id),'[]'::jsonb)
          into holders from legacy_day_known_holders(source.day_id) k
          where k.wedding_id=source.wedding_id and k.vendor_id=source.vendor_id;
        mat:=jsonb_set(mat,'{holders}',holders);
      elsif source.kind in ('app_root','live_negotiation') then
        root:=case when mat->'root' is null or mat->'root'='null'::jsonb then null
          else legacy_calendar_holder_v2(source.wedding_id,source.root_deal_id) end;
        mat:=mat||jsonb_build_object('root',root,'holders',case when root is null then '[]'::jsonb else jsonb_build_array(root) end);
        if exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where h.deal_id=source.root_deal_id and (v.binding_state='unknown' or not deal_day_scope_matches_current(v))) then uncertain:=true; end if;
      end if;
      if uncertain then mat:=mat||jsonb_build_object('completeness','unknown','reason',coalesce(mat->>'reason','mixed_scope')); end if;
      return mat||jsonb_build_object('encoding','legacy-calendar-inventory/2','dayScopes',scopes);
    end $$;

    create function legacy_day_scope_material_valid(scope jsonb) returns boolean language plpgsql immutable as $$
    declare version_keys text[];
    begin
      if scope is null or scope='null'::jsonb then return true; end if;
      version_keys:=array['id','weddingId','dealId','slotId','schemaVersion','revision','previousVersionId','originKnowledge',
        'operation','recordedAt','contextKind','eventId','performerKind','vendorId','bindingState','serviceDate','timeZone','dayId'];
      return jsonb_typeof(scope)='object'
        and (select array_agg(key order by key) from jsonb_object_keys(scope) key)=array['head','version']::text[]
        and (select array_agg(key order by key) from jsonb_object_keys(scope->'head') key)=
          array['currentVersionId','dealId','revision','weddingId']::text[]
        and (select array_agg(key order by key) from jsonb_object_keys(scope->'version') key)=
          (select array_agg(key order by key) from unnest(version_keys) key)
        and scope->'head'->'currentVersionId'=scope->'version'->'id'
        and scope->'head'->'weddingId'=scope->'version'->'weddingId'
        and scope->'head'->'dealId'=scope->'version'->'dealId'
        and scope->'head'->'revision'=scope->'version'->'revision'
        and jsonb_typeof(scope->'version'->'schemaVersion')='number'
        and scope->'version'->>'schemaVersion'='1';
    end $$;
    create function legacy_calendar_holder_v2_valid(holder jsonb) returns boolean language plpgsql immutable as $$
    declare day jsonb;
    begin
      if jsonb_typeof(holder) is distinct from 'object' or
        (select array_agg(key order by key) from jsonb_object_keys(holder) key) is distinct from
        (select array_agg(key order by key) from unnest(array['weddingId','dealId','vendorId','state','createdAt','bookedAt',
          'doneAt','weddingDate','slot','order','economics','commitmentRevision','ownDays','dayScope']) key)
        or (select array_agg(key order by key) from jsonb_object_keys(holder->'slot') key) is distinct from
          array['categoryId','id','programEventId','selected']::text[]
        or (select array_agg(key order by key) from jsonb_object_keys(holder->'economics') key) is distinct from
          array['currency','packageId','price']::text[]
        or jsonb_typeof(holder->'ownDays') is distinct from 'array'
        or legacy_day_scope_material_valid(holder->'dayScope') is not true then return false; end if;
      if holder->'order'<>'null'::jsonb and (select array_agg(key order by key) from jsonb_object_keys(holder->'order') key)
        is distinct from array['resourcePlanId','resourcePlanRevision','version']::text[] then return false; end if;
      if holder->'dayScope'<>'null'::jsonb and
        (holder->'dayScope'->'head'->'weddingId' is distinct from holder->'weddingId'
          or holder->'dayScope'->'head'->'dealId' is distinct from holder->'dealId') then return false; end if;
      for day in select * from jsonb_array_elements(holder->'ownDays') loop
        if (select array_agg(key order by key) from jsonb_object_keys(day) key) is distinct from
          array['createdAt','date','dealId','id','source','sourceRevision','vendorId']::text[] then return false; end if;
      end loop;
      return true;
    end $$;
    create function legacy_calendar_material_valid(mat jsonb) returns boolean language plpgsql immutable as $$
    declare base_keys text[]; g jsonb; holder jsonb; version_keys text[];
    begin
      if mat->>'encoding'='legacy-calendar-inventory/1' then return true; end if;
      if mat->>'encoding' is distinct from 'legacy-calendar-inventory/2' then return false; end if;
      base_keys:=array['encoding','sourceId','kind','vendorId','completeness','reason','holders','dayScopes'];
      if mat->>'kind' in ('app_day','manual_day','orphan_day') then base_keys:=base_keys||array['day','pointer'];
      elsif mat->>'kind'='app_root' then base_keys:=base_keys||array['root'];
      elsif mat->>'kind'='live_negotiation' then base_keys:=base_keys||array['root','negotiation'];
      else return false; end if;
      if (select array_agg(key order by key) from jsonb_object_keys(mat) key) is distinct from
        (select array_agg(key order by key) from unnest(base_keys) key)
        or jsonb_typeof(mat->'holders')<>'array' or jsonb_typeof(mat->'dayScopes')<>'array' then return false; end if;
      for holder in select * from jsonb_array_elements(mat->'holders') loop
        if not legacy_calendar_holder_v2_valid(holder) then return false; end if;
      end loop;
      if mat->>'kind' in ('app_root','live_negotiation') then
        if mat->'root'='null'::jsonb then
          if mat->'holders'<>'[]'::jsonb then return false; end if;
        elsif not legacy_calendar_holder_v2_valid(mat->'root') or mat->'holders'<>jsonb_build_array(mat->'root') then return false; end if;
      end if;
      if (select count(distinct scope_item.value->>'dayId') from jsonb_array_elements(mat->'dayScopes') as scope_item(value))<>jsonb_array_length(mat->'dayScopes')
        or (select coalesce(jsonb_agg(scope_item.value order by scope_item.value->>'dayId'),'[]'::jsonb) from jsonb_array_elements(mat->'dayScopes') as scope_item(value))
          is distinct from mat->'dayScopes' then return false; end if;
      version_keys:=array['id','weddingId','dealId','slotId','schemaVersion','revision','previousVersionId','originKnowledge',
        'operation','recordedAt','contextKind','eventId','performerKind','vendorId','bindingState','serviceDate','timeZone','dayId'];
      for g in select * from jsonb_array_elements(mat->'dayScopes') loop
        if (select array_agg(key order by key) from jsonb_object_keys(g) key) is distinct from
          (select array_agg(key order by key) from unnest(array['dayId','vendorId','date','weddingId','classification',
            'groupRevision','legacyCandidates','opaque','knownHolders','day']) key)
          or jsonb_typeof(g->'legacyCandidates')<>'array' or jsonb_typeof(g->'knownHolders')<>'array'
          or jsonb_typeof(g->'opaque')<>'boolean' then return false; end if;
        if g->>'classification' not in ('exact','legacy_unknown','opaque','unclassified')
          or ((g->>'classification'='unclassified') is distinct from (g->'groupRevision'='null'::jsonb))
          or ((g->>'classification' in ('unclassified','opaque') or g->'day'='null'::jsonb) and g->'opaque'<>'true'::jsonb)
          or (g->'day'<>'null'::jsonb and (select array_agg(key order by key) from jsonb_object_keys(g->'day') key)
            is distinct from array['createdAt','date','dealId','id','source','sourceRevision','vendorId']::text[]) then return false; end if;
        if (select count(distinct candidate) from jsonb_array_elements(g->'legacyCandidates') candidate)
            <>jsonb_array_length(g->'legacyCandidates')
          or (select coalesce(jsonb_agg(candidate order by candidate),'[]'::jsonb)
            from jsonb_array_elements(g->'legacyCandidates') candidate) is distinct from g->'legacyCandidates'
          or (select count(distinct jsonb_build_array(k->'head'->'weddingId',k->'head'->'dealId'))
            from jsonb_array_elements(g->'knownHolders') k)<>jsonb_array_length(g->'knownHolders')
          or (select coalesce(jsonb_agg(k order by k->'head'->>'weddingId',k->'head'->>'dealId'),'[]'::jsonb)
            from jsonb_array_elements(g->'knownHolders') k) is distinct from g->'knownHolders' then return false; end if;
        for holder in select * from jsonb_array_elements(g->'knownHolders') loop
          if legacy_day_scope_material_valid(holder) is not true
            or holder->'version'->>'bindingState' not in ('active','done_retained')
            or holder->'version'->'dayId' is distinct from g->'dayId'
            or holder->'version'->'vendorId' is distinct from g->'vendorId'
            or holder->'version'->'serviceDate' is distinct from g->'date'
            or (select array_agg(key order by key) from jsonb_object_keys(holder) key) is distinct from array['head','version']::text[]
            or (select array_agg(key order by key) from jsonb_object_keys(holder->'head') key) is distinct from
              array['currentVersionId','dealId','revision','weddingId']::text[]
            or (select array_agg(key order by key) from jsonb_object_keys(holder->'version') key) is distinct from
              (select array_agg(key order by key) from unnest(version_keys) key) then return false; end if;
        end loop;
      end loop;
      return true;
    end $$;

    create or replace function legacy_calendar_present(source legacy_calendar_sources) returns boolean language plpgsql stable as $$
    declare mat jsonb; wedding_row weddings%rowtype;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        return exists(select 1 from vendor_busy_dates where id=source.day_id);
      end if;
      mat := legacy_calendar_current_inventory_material(source);
      if not exists(select 1 from deals d where d.id=source.root_deal_id and d.wedding_id=source.wedding_id
        and d.vendor_id=source.vendor_id and ((source.kind='app_root' and d.state in ('booked','paid_deposit','done')
          and not exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0))
          or (source.kind='live_negotiation' and d.state='negotiating'))) then return false; end if;
      if source.kind<>'live_negotiation' then return true; end if;
      if (mat->'negotiation'->>'negotiatingUntil') is null then return false; end if;
      if (mat->'negotiation'->>'negotiatingUntil')::timestamptz<=clock_timestamp() then return false; end if;
      if (mat->'negotiation'->>'weddingArchived')::boolean or (mat->'negotiation'->>'weddingCancelled')::boolean then return false; end if;
      return true;
    end $$;

    create or replace function legacy_calendar_append_version(p_source_id uuid, p_captured_by uuid, p_capture_kind text,
        out version_id uuid, out revision text, out created boolean) language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype; canon text; current_canon text; elem jsonb;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then raise exception 'legacy calendar source not found' using errcode='23503'; end if;
      select * into h from legacy_calendar_heads where source_id=p_source_id for update;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      canon := legacy_calendar_current_inventory_material(src)::text;
      if h.current_version_id is not null then
        select canonical into current_canon from legacy_calendar_versions where id=h.current_version_id;
        if current_canon=canon then
          version_id := h.current_version_id; revision := h.revision::text; created := false; return;
        end if;
      end if;
      version_id := gen_random_uuid(); revision := (h.revision+1)::text;
      insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
        values(version_id,p_source_id,h.revision+1,h.current_version_id,canon,
          encode(pg_catalog.sha256(convert_to(canon,'UTF8')),'hex'),p_capture_kind,p_captured_by);
      for elem in select * from jsonb_array_elements(canon::jsonb->'holders') loop
        insert into legacy_calendar_version_holders(source_id,version_id,wedding_id,deal_id,snapshot,fingerprint)
          values(p_source_id,version_id,(elem->>'weddingId')::uuid,(elem->>'dealId')::uuid,elem,
            encode(pg_catalog.sha256(convert_to(elem::text,'UTF8')),'hex'));
      end loop;
      update legacy_calendar_heads set revision=h.revision+1,current_version_id=version_id where source_id=p_source_id;
      created := true;
    end $$;

    create or replace function protect_legacy_calendar_version() returns trigger language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from legacy_calendar_sources where id=OLD.source_id) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        -- Единственный законный UPDATE версии — FK ON DELETE SET NULL у автора
        -- стёртого аккаунта: captured_by X -> NULL, X уже нет, всё остальное
        -- равно. Любой иной UPDATE (в том числе «пустой») — отказ.
        if OLD.captured_by is null or NEW.captured_by is not null
          or exists(select 1 from users where id=OLD.captured_by)
          or (to_jsonb(NEW)-'captured_by')<>(to_jsonb(OLD)-'captured_by') then
          raise exception 'inventory evidence is immutable' using errcode='23514';
        end if;
        return NEW;
      end if;
      select * into src from legacy_calendar_sources where id=NEW.source_id;
      select * into h from legacy_calendar_heads where source_id=NEW.source_id for update;
      if not found or NEW.revision<>h.revision+1 then
        raise exception 'inventory version requires next exact head revision' using errcode='23514';
      end if;
      if not legacy_calendar_material_valid(NEW.canonical::jsonb) or NEW.canonical<>legacy_calendar_current_inventory_material(src)::text then
        raise exception 'inventory version must equal current material' using errcode='23514';
      end if;
      if NEW.capture_kind='migration_backfill' then
        if NEW.revision<>1 or src.discovered_by<>'migration' or NEW.captured_by is not null then
          raise exception 'inventory version must equal current material' using errcode='23514';
        end if;
      else
        if not exists(select 1 from vendors v where v.id=src.vendor_id and v.user_id=NEW.captured_by) then
          raise exception 'inventory capture author must be the current company owner' using errcode='23514';
        end if;
      end if;
      -- Предок — ровно версия головы. Проверяется последним: ревизия, материал
      -- и автор говорят о более грубом нарушении, чем разрыв цепочки.
      if NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'inventory version requires next exact head revision' using errcode='23514';
      end if;
      return NEW;
    end $$;

    create or replace function check_legacy_calendar_inventory() returns trigger language plpgsql as $$
    declare target uuid; h legacy_calendar_heads%rowtype; row_json jsonb;
    begin
      row_json := to_jsonb(NEW);
      target := case when TG_TABLE_NAME='legacy_calendar_sources' then (row_json->>'id')::uuid else (row_json->>'source_id')::uuid end;
      if not exists(select 1 from legacy_calendar_sources where id=target) then return null; end if;
      select * into h from legacy_calendar_heads where source_id=target;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      if TG_TABLE_NAME='legacy_calendar_versions' and not exists(
        with recursive ancestry as (
          select id,previous_version_id from legacy_calendar_versions where source_id=target and id=h.current_version_id
          union all
          select p.id,p.previous_version_id from legacy_calendar_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=(row_json->>'id')::uuid
      ) then
        raise exception 'orphan inventory version' using errcode='23514';
      end if;
      if h.revision=0 then return null; end if;
      if exists(select 1 from legacy_calendar_versions v where v.source_id=target
        and not legacy_calendar_material_valid(v.canonical::jsonb)) then
        raise exception 'Invalid versioned inventory material' using errcode='23514',constraint='legacy_calendar_material';
      end if;
      if exists(select 1 from legacy_calendar_versions v join legacy_calendar_sources s on s.id=v.source_id
        where v.id=h.current_version_id and v.canonical::jsonb->>'encoding'='legacy-calendar-inventory/2'
          and legacy_day_transaction_owns(v.xmin)
          and v.canonical is distinct from legacy_calendar_current_inventory_material(s)::text) then
        raise exception 'Captured /2 material changed before COMMIT' using errcode='23514',constraint='legacy_calendar_material';
      end if;
      -- Every immutable version needs its complete captured group, including
      -- an intermediate version superseded later in the same transaction.
      if exists(select 1 from legacy_calendar_versions v where v.source_id=target
        and (select count(*) from legacy_calendar_version_holders where version_id=v.id)
          <>jsonb_array_length(v.canonical::jsonb->'holders')) then
        raise exception 'inventory version holders incomplete' using errcode='23514';
      end if;
      return null;
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

    create or replace function protect_deal_day_scope_version() returns trigger language plpgsql as $$
    declare h deal_day_scope_heads%rowtype; previous deal_day_scope_versions%rowtype;
    begin
      NEW.recorded_at := clock_timestamp();
      if not deal_day_scope_shape_valid(NEW) then
        raise exception 'Invalid day scope shape' using errcode='23514',constraint='deal_day_scope_shape';
      end if;
      if NEW.time_zone is not null and not exists(select 1 from pg_timezone_names where name=NEW.time_zone) then
        raise exception 'Unknown day scope time zone' using errcode='23514',constraint='deal_day_scope_time_zone';
      end if;
      select * into h from deal_day_scope_heads where deal_id=NEW.deal_id and wedding_id=NEW.wedding_id for update;
      if NEW.revision=1 then
        if found then raise exception 'First version already exists' using errcode='23514',constraint='deal_day_scope_chain'; end if;
      else
        if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
          raise exception 'Version requires exact current predecessor' using errcode='23514',constraint='deal_day_scope_chain';
        end if;
        select * into previous from deal_day_scope_versions where id=h.current_version_id
          and wedding_id=NEW.wedding_id and deal_id=NEW.deal_id;
        if not found then raise exception 'Missing predecessor' using errcode='23514',constraint='deal_day_scope_chain'; end if;
        if (NEW.operation='acquire' and previous.binding_state not in ('unknown','undated','external','active'))
          or (NEW.operation='move' and previous.binding_state in ('done_retained','done_undated','released'))
          or (NEW.operation='retain_done' and not (
            (NEW.binding_state='done_retained' and previous.binding_state in ('active','done_retained'))
            or (NEW.binding_state='done_undated' and previous.binding_state in ('undated','done_undated'))
            or (NEW.binding_state='external' and previous.binding_state='external'
              and exists(select 1 from deals d where d.id=NEW.deal_id
                and d.wedding_id=NEW.wedding_id and d.state='done')))) then
          raise exception 'Invalid predecessor state' using errcode='23514',constraint='deal_day_scope_shape';
        end if;
        if NEW.operation='retain_done' and row(NEW.slot_id,NEW.context_kind,NEW.event_id,NEW.performer_kind,
          NEW.vendor_id,NEW.service_date,NEW.time_zone,NEW.day_id) is distinct from
          row(previous.slot_id,previous.context_kind,previous.event_id,previous.performer_kind,
            previous.vendor_id,previous.service_date,previous.time_zone,previous.day_id) then
          raise exception 'Retained day must preserve the prior tuple' using errcode='23514',constraint='deal_day_scope_shape';
        end if;
      end if;
      if not deal_day_scope_matches_current(NEW) then
        raise exception 'Day scope does not match its live root' using errcode='23514',constraint='deal_day_scope_current';
      end if;
      return NEW;
    end $$;

    create function legacy_day_initial_done_valid(v deal_day_scope_versions) returns boolean language sql stable as $$
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
    create function check_legacy_day_initial_done() returns trigger language plpgsql as $$
    begin
      if NEW.operation='observe_done' and
        (TG_WHEN='BEFORE' or exists(select 1 from deal_day_scope_heads where deal_id=NEW.deal_id and current_version_id=NEW.id))
        and not legacy_day_initial_done_valid(NEW) then
        raise exception 'First undated done requires its exact live main context'
          using errcode='23514',constraint='deal_day_scope_current';
      end if;
      return NEW;
    end $$;
    create trigger check_legacy_day_initial_done_insert before insert on deal_day_scope_versions
      for each row execute function check_legacy_day_initial_done();
    create constraint trigger check_legacy_day_initial_done_commit after insert on deal_day_scope_versions
      deferrable initially deferred for each row execute function check_legacy_day_initial_done();

    create function legacy_day_erased_catalog(v deal_day_scope_versions) returns boolean language sql stable as $$
      select v.performer_kind='catalog' and not exists(select 1 from vendors where id=v.vendor_id)
        and exists(select 1 from deals d where d.id=v.deal_id and d.wedding_id=v.wedding_id and d.slot_id=v.slot_id
          and d.vendor_id is null and d.external_name is not null and d.state in ('booked','paid_deposit','done'))
    $$;
    create function legacy_day_assert_root(root_id uuid) returns void language plpgsql as $$
    declare v deal_day_scope_versions%rowtype;
    begin
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=$1;
      if not found or not exists(select 1 from deals where id=$1) then return; end if;
      if v.operation='retain_done' and v.binding_state='external'
        and not exists(select 1 from deals d where d.id=root_id
          and d.wedding_id=v.wedding_id and d.state='done') then
        raise exception 'External retained head requires a completed root'
          using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if not deal_day_scope_matches_current(v) and not
        (not legacy_day_version_new(v.id) and (legacy_day_erased_catalog(v)
          or (v.binding_state in ('unknown','external') and exists(select 1 from deals d where d.id=$1 and d.state='done')))) then
        raise exception 'Managed root requires a final current tuple' using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if v.binding_state in ('active','done_retained') and exists(select 1 from deal_resource_commitments c
        where c.deal_id=$1 and c.revision>0) then
        raise exception 'Resource agreement cannot become a legacy DATE holder'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
    end $$;
    create function protect_legacy_day_terminal_transition() returns trigger language plpgsql as $$
    declare v deal_day_scope_versions%rowtype;
    begin
      if OLD.state not in ('booked','paid_deposit') or NEW.state<>'done' then return NEW; end if;
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=OLD.id;
      if found and not deal_day_scope_matches_current(v) and not legacy_day_erased_catalog(v) then
        raise exception 'Terminal transition requires a fresh pre-state tuple'
          using errcode='23514',constraint='deal_day_scope_current';
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_day_terminal_transition before update of state on deals
      for each row execute function protect_legacy_day_terminal_transition();
    create function legacy_day_assert_group(target uuid) returns void language plpgsql as $$
    declare g legacy_day_groups%rowtype; v deal_day_scope_versions%rowtype; b vendor_busy_dates%rowtype;
    begin
      select * into g from legacy_day_groups where day_id=target;
      if not found then return; end if;
      select * into b from vendor_busy_dates where id=target;
      if not found or row(g.vendor_id,g.service_date) is distinct from row(b.vendor_id,b.date) then
        raise exception 'Managed group lost its DATE' using errcode='23514',constraint='legacy_day_group_current';
      end if;
      if g.classification<>'opaque' and exists(select 1 from weddings where id=g.wedding_id)
        and not exists(select 1 from deals d where d.id=b.deal_id and d.wedding_id=g.wedding_id
          and d.vendor_id=g.vendor_id and d.state in ('booked','paid_deposit','done'))
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
          where x.day_id=target and legacy_day_erased_catalog(x)) then
        raise exception 'Managed DATE requires a compatible final representative'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
      for v in select * from legacy_day_known_holders(target) loop
        if (g.wedding_id is not null and v.wedding_id is distinct from g.wedding_id) or not deal_day_scope_matches_current(v) then
          raise exception 'Final representative must serve every exact holder'
            using errcode='23514',constraint='legacy_day_group_current';
        end if;
      end loop;
      if g.classification='exact' and cardinality(g.legacy_candidates)=0
        and not exists(select 1 from legacy_day_known_holders(target))
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
          where x.day_id=target and legacy_day_erased_catalog(x)) then
        raise exception 'Exact DATE requires a proven holder or deletion'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
    end $$;
    create function protect_legacy_day_delete() returns trigger language plpgsql as $$
    declare g legacy_day_groups%rowtype;
    begin
      select * into g from legacy_day_groups where day_id=OLD.id;
      if TG_OP='UPDATE' then
        if found and exists(select 1 from vendors where id=OLD.vendor_id)
          and (g.wedding_id is null or exists(select 1 from weddings where id=g.wedding_id))
          and (OLD.deal_id is null or exists(select 1 from deals where id=OLD.deal_id)) then
          perform legacy_day_require_vendor(OLD.vendor_id);
        end if;
        if g.day_id is not null and OLD.deal_id is not null and NEW.deal_id is null
          and not exists(select 1 from deals where id=OLD.deal_id) and g.classification<>'opaque' then
          update legacy_day_groups set classification='opaque',revision=revision+1 where day_id=OLD.id;
        end if;
        return NEW;
      end if;
      if found and exists(select 1 from vendors where id=OLD.vendor_id)
        and (g.wedding_id is null or exists(select 1 from weddings where id=g.wedding_id)) then
        perform legacy_day_require_vendor(OLD.vendor_id);
      end if;
      if found and exists(select 1 from vendors where id=OLD.vendor_id)
        and (g.wedding_id is null or exists(select 1 from weddings where id=g.wedding_id))
        and (g.classification='opaque' or cardinality(g.legacy_candidates)>0
          or exists(select 1 from legacy_day_known_holders(OLD.id))
          or exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
            where v.day_id=OLD.id and v.binding_state in ('active','done_retained'))) then
        raise exception 'DATE still has exact or unresolved holders'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
      return OLD;
    end $$;
    create trigger protect_legacy_day_delete before update or delete on vendor_busy_dates
      for each row execute function protect_legacy_day_delete();
    create function legacy_day_mark_erasure() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and NEW.vendor_id is not distinct from OLD.vendor_id then return NEW; end if;
      update legacy_day_groups g set classification='opaque',revision=revision+1
        where g.classification<>'opaque' and (OLD.id=any(g.legacy_candidates) or exists(
          select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
            where h.deal_id=OLD.id and v.day_id=g.day_id));
      return null;
    end $$;
    create trigger legacy_day_mark_erasure after update or delete on deals
      for each row execute function legacy_day_mark_erasure();
    create function check_legacy_day_managed() returns trigger language plpgsql as $$
    declare row_data jsonb; old_data jsonb; target uuid; root_id uuid;
    begin
      row_data:=case when TG_OP='DELETE' then to_jsonb(OLD) else to_jsonb(NEW) end;
      if TG_OP='UPDATE' then
        old_data:=to_jsonb(OLD);
        -- A payment/price change is not a new financial freshness gate. The
        -- inventory still changes its digest; DATE guards watch only its tuple.
        if TG_TABLE_NAME='deals' and
          row(row_data->'wedding_id',row_data->'slot_id',row_data->'vendor_id',row_data->'external_name') is not distinct from
          row(old_data->'wedding_id',old_data->'slot_id',old_data->'vendor_id',old_data->'external_name') and
          ((row_data->>'state') is not distinct from (old_data->>'state') or
            (row_data->>'state' in ('booked','paid_deposit') and old_data->>'state' in ('booked','paid_deposit'))) then return null; end if;
        if TG_TABLE_NAME='weddings' and row(row_data->'date',row_data->'tz') is not distinct from
          row(old_data->'date',old_data->'tz') then return null; end if;
        if TG_TABLE_NAME='wedding_events' and
          row(row_data->'wedding_id',row_data->'date',row_data->'time_zone',row_data->'is_main') is not distinct from
          row(old_data->'wedding_id',old_data->'date',old_data->'time_zone',old_data->'is_main') then return null; end if;
        if TG_TABLE_NAME='slots' and row(row_data->'wedding_id',row_data->'program_event_id',row_data->'deal_id') is not distinct from
          row(old_data->'wedding_id',old_data->'program_event_id',old_data->'deal_id') then return null; end if;
        if TG_TABLE_NAME='deal_resource_commitments' and (row_data->>'revision')::bigint=0
          and (old_data->>'revision')::bigint=0 then return null; end if;
      end if;
      if TG_TABLE_NAME in ('vendor_busy_dates','legacy_day_groups') then
        target:=(row_data->>case when TG_TABLE_NAME='vendor_busy_dates' then 'id' else 'day_id' end)::uuid;
        perform legacy_day_assert_group(target);
        for root_id in select h.deal_id from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where v.day_id=target loop perform legacy_day_assert_root(root_id); end loop;
      elsif TG_TABLE_NAME in ('deals','deal_resource_commitments','deal_day_scope_heads') then
        root_id:=(row_data->>case when TG_TABLE_NAME='deals' then 'id' else 'deal_id' end)::uuid;
        perform legacy_day_assert_root(root_id);
        for target in select g.day_id from legacy_day_groups g where root_id=any(g.legacy_candidates)
          union select v.day_id from deal_day_scope_versions v where v.deal_id=root_id and v.day_id is not null
          loop perform legacy_day_assert_group(target); end loop;
      else
        for root_id in select h.deal_id from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where (TG_TABLE_NAME='weddings' and h.wedding_id=(row_data->>'id')::uuid)
            or (TG_TABLE_NAME='wedding_events' and v.event_id=(row_data->>'id')::uuid)
            or (TG_TABLE_NAME='slots' and v.slot_id=(row_data->>'id')::uuid)
            or (TG_TABLE_NAME='vendors' and v.vendor_id=(row_data->>'id')::uuid)
          loop perform legacy_day_assert_root(root_id); end loop;
      end if;
      return null;
    end $$;
    create constraint trigger check_legacy_day_groups after insert or update on legacy_day_groups
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_busy after insert or update or delete on vendor_busy_dates
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_roots after update or delete on deals
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_commitments after insert or update or delete on deal_resource_commitments
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_heads after insert or update or delete on deal_day_scope_heads
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_slots after update or delete on slots
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_weddings after update on weddings
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_events after update or delete on wedding_events
      deferrable initially deferred for each row execute function check_legacy_day_managed();
    create constraint trigger check_legacy_day_vendors after delete on vendors
      deferrable initially deferred for each row execute function check_legacy_day_managed();
  `);
};

exports.down = pgm => {
  pgm.sql(`
    set local lock_timeout='5s';
    lock table deal_day_scope_versions,deal_day_scope_heads,legacy_day_groups,
      legacy_calendar_versions,legacy_calendar_heads,legacy_calendar_version_holders in access exclusive mode;
    do $$ begin
      if exists(select 1 from legacy_day_groups)
        or exists(select 1 from deal_day_scope_versions where operation='observe_done')
        or exists(select 1 from deal_day_scope_versions where operation='retain_done' and binding_state='external')
        or exists(select 1 from legacy_calendar_versions where canonical::jsonb->>'encoding'='legacy-calendar-inventory/2')
        or exists(select 1 from audit_log where action='legacy_day.resolved') then
        raise exception 'Atomic day scope evidence exists; use a preserving forward migration'
          using errcode='23514',constraint='deal_day_scope_atomic_preserving_down';
      end if;
    end $$;
    create or replace function legacy_calendar_present(source legacy_calendar_sources) returns boolean language plpgsql stable as $$
    declare mat jsonb; wedding_row weddings%rowtype;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        return exists(select 1 from vendor_busy_dates where id=source.day_id);
      end if;
      mat := legacy_calendar_inventory_material(source);
      if (mat->>'completeness')<>'complete' then return false; end if;
      if source.kind<>'live_negotiation' then return true; end if;
      if (mat->'negotiation'->>'negotiatingUntil') is null then return false; end if;
      if (mat->'negotiation'->>'negotiatingUntil')::timestamptz<=clock_timestamp() then return false; end if;
      if (mat->'negotiation'->>'weddingArchived')::boolean or (mat->'negotiation'->>'weddingCancelled')::boolean then return false; end if;
      return true;
    end $$;

    create or replace function legacy_calendar_append_version(p_source_id uuid, p_captured_by uuid, p_capture_kind text,
        out version_id uuid, out revision text, out created boolean) language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype; canon text; current_canon text; elem jsonb;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then raise exception 'legacy calendar source not found' using errcode='23503'; end if;
      select * into h from legacy_calendar_heads where source_id=p_source_id for update;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      canon := legacy_calendar_inventory_material(src)::text;
      if h.current_version_id is not null then
        select canonical into current_canon from legacy_calendar_versions where id=h.current_version_id;
        if current_canon=canon then
          version_id := h.current_version_id; revision := h.revision::text; created := false; return;
        end if;
      end if;
      version_id := gen_random_uuid(); revision := (h.revision+1)::text;
      insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
        values(version_id,p_source_id,h.revision+1,h.current_version_id,canon,
          encode(pg_catalog.sha256(convert_to(canon,'UTF8')),'hex'),p_capture_kind,p_captured_by);
      for elem in select * from jsonb_array_elements(canon::jsonb->'holders') loop
        insert into legacy_calendar_version_holders(source_id,version_id,wedding_id,deal_id,snapshot,fingerprint)
          values(p_source_id,version_id,(elem->>'weddingId')::uuid,(elem->>'dealId')::uuid,elem,
            encode(pg_catalog.sha256(convert_to(elem::text,'UTF8')),'hex'));
      end loop;
      update legacy_calendar_heads set revision=h.revision+1,current_version_id=version_id where source_id=p_source_id;
      created := true;
    end $$;

    create or replace function protect_legacy_calendar_version() returns trigger language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from legacy_calendar_sources where id=OLD.source_id) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        -- Единственный законный UPDATE версии — FK ON DELETE SET NULL у автора
        -- стёртого аккаунта: captured_by X -> NULL, X уже нет, всё остальное
        -- равно. Любой иной UPDATE (в том числе «пустой») — отказ.
        if OLD.captured_by is null or NEW.captured_by is not null
          or exists(select 1 from users where id=OLD.captured_by)
          or (to_jsonb(NEW)-'captured_by')<>(to_jsonb(OLD)-'captured_by') then
          raise exception 'inventory evidence is immutable' using errcode='23514';
        end if;
        return NEW;
      end if;
      select * into src from legacy_calendar_sources where id=NEW.source_id;
      select * into h from legacy_calendar_heads where source_id=NEW.source_id for update;
      if not found or NEW.revision<>h.revision+1 then
        raise exception 'inventory version requires next exact head revision' using errcode='23514';
      end if;
      if NEW.canonical<>legacy_calendar_inventory_material(src)::text then
        raise exception 'inventory version must equal current material' using errcode='23514';
      end if;
      if NEW.capture_kind='migration_backfill' then
        if NEW.revision<>1 or src.discovered_by<>'migration' or NEW.captured_by is not null then
          raise exception 'inventory version must equal current material' using errcode='23514';
        end if;
      else
        if not exists(select 1 from vendors v where v.id=src.vendor_id and v.user_id=NEW.captured_by) then
          raise exception 'inventory capture author must be the current company owner' using errcode='23514';
        end if;
      end if;
      -- Предок — ровно версия головы. Проверяется последним: ревизия, материал
      -- и автор говорят о более грубом нарушении, чем разрыв цепочки.
      if NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'inventory version requires next exact head revision' using errcode='23514';
      end if;
      return NEW;
    end $$;

    create or replace function check_legacy_calendar_inventory() returns trigger language plpgsql as $$
    declare target uuid; h legacy_calendar_heads%rowtype; row_json jsonb;
    begin
      row_json := to_jsonb(NEW);
      target := case when TG_TABLE_NAME='legacy_calendar_sources' then (row_json->>'id')::uuid else (row_json->>'source_id')::uuid end;
      if not exists(select 1 from legacy_calendar_sources where id=target) then return null; end if;
      select * into h from legacy_calendar_heads where source_id=target;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      if TG_TABLE_NAME='legacy_calendar_versions' and not exists(
        with recursive ancestry as (
          select id,previous_version_id from legacy_calendar_versions where source_id=target and id=h.current_version_id
          union all
          select p.id,p.previous_version_id from legacy_calendar_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=(row_json->>'id')::uuid
      ) then
        raise exception 'orphan inventory version' using errcode='23514';
      end if;
      if h.revision=0 then return null; end if;
      -- Every immutable version needs its complete captured group, including
      -- an intermediate version superseded later in the same transaction.
      if exists(select 1 from legacy_calendar_versions v where v.source_id=target
        and (select count(*) from legacy_calendar_version_holders where version_id=v.id)
          <>jsonb_array_length(v.canonical::jsonb->'holders')) then
        raise exception 'inventory version holders incomplete' using errcode='23514';
      end if;
      return null;
    end $$;

    create or replace function deal_day_scope_shape_valid(v deal_day_scope_versions)
    returns boolean language sql immutable as $$
      select (
        v.schema_version=1 and v.revision>0
        and ((v.revision=1 and v.previous_version_id is null
            and v.origin_knowledge in ('observed_tracking','legacy_unknown')
            and v.operation in ('observe','acquire'))
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
            and v.revision>1 and v.operation='retain_done'
          when 'released' then v.day_id is null
          else false end
        and (v.operation='observe'
          or (v.operation in ('acquire','move') and v.binding_state in ('active','undated','external'))
          or (v.operation='retain_done' and v.binding_state in ('done_retained','done_undated'))
          or (v.operation='release' and v.binding_state='released'))
      ) is true
    $$;
    create or replace function protect_deal_day_scope_version() returns trigger language plpgsql as $$
    declare h deal_day_scope_heads%rowtype; previous deal_day_scope_versions%rowtype;
    begin
      NEW.recorded_at := clock_timestamp();
      if not deal_day_scope_shape_valid(NEW) then
        raise exception 'Invalid day scope shape' using errcode='23514',constraint='deal_day_scope_shape';
      end if;
      if NEW.time_zone is not null and not exists(select 1 from pg_timezone_names where name=NEW.time_zone) then
        raise exception 'Unknown day scope time zone' using errcode='23514',constraint='deal_day_scope_time_zone';
      end if;
      select * into h from deal_day_scope_heads where deal_id=NEW.deal_id and wedding_id=NEW.wedding_id for update;
      if NEW.revision=1 then
        if found then raise exception 'First version already exists' using errcode='23514',constraint='deal_day_scope_chain'; end if;
      else
        if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
          raise exception 'Version requires exact current predecessor' using errcode='23514',constraint='deal_day_scope_chain';
        end if;
        select * into previous from deal_day_scope_versions where id=h.current_version_id
          and wedding_id=NEW.wedding_id and deal_id=NEW.deal_id;
        if not found then raise exception 'Missing predecessor' using errcode='23514',constraint='deal_day_scope_chain'; end if;
        if (NEW.operation='acquire' and previous.binding_state not in ('unknown','undated','external','active'))
          or (NEW.operation='move' and previous.binding_state in ('done_retained','done_undated','released'))
          or (NEW.operation='retain_done' and not (
            (NEW.binding_state='done_retained' and previous.binding_state in ('active','done_retained'))
            or (NEW.binding_state='done_undated' and previous.binding_state in ('undated','done_undated')))) then
          raise exception 'Invalid predecessor state' using errcode='23514',constraint='deal_day_scope_shape';
        end if;
        if NEW.operation='retain_done' and row(NEW.slot_id,NEW.context_kind,NEW.event_id,NEW.performer_kind,
          NEW.vendor_id,NEW.service_date,NEW.time_zone,NEW.day_id) is distinct from
          row(previous.slot_id,previous.context_kind,previous.event_id,previous.performer_kind,
            previous.vendor_id,previous.service_date,previous.time_zone,previous.day_id) then
          raise exception 'Retained day must preserve the prior tuple' using errcode='23514',constraint='deal_day_scope_shape';
        end if;
      end if;
      if not deal_day_scope_matches_current(NEW) then
        raise exception 'Day scope does not match its live root' using errcode='23514',constraint='deal_day_scope_current';
      end if;
      return NEW;
    end $$;
    drop trigger check_legacy_day_vendors on vendors;
    drop trigger check_legacy_day_events on wedding_events;
    drop trigger check_legacy_day_weddings on weddings;
    drop trigger check_legacy_day_slots on slots;
    drop trigger check_legacy_day_heads on deal_day_scope_heads;
    drop trigger check_legacy_day_commitments on deal_resource_commitments;
    drop trigger check_legacy_day_roots on deals;
    drop trigger check_legacy_day_busy on vendor_busy_dates;
    drop trigger check_legacy_day_groups on legacy_day_groups;
    drop trigger protect_legacy_day_delete on vendor_busy_dates;
    drop trigger legacy_day_mark_erasure on deals;
    drop trigger protect_legacy_day_terminal_transition on deals;
    drop trigger check_legacy_day_initial_done_commit on deal_day_scope_versions;
    drop trigger check_legacy_day_initial_done_insert on deal_day_scope_versions;
    drop trigger audit_legacy_day_resolution on legacy_day_groups;
    drop trigger legacy_day_discover_new on vendor_busy_dates;
    drop trigger protect_legacy_day_group on legacy_day_groups;
    drop function check_legacy_day_managed();
    drop function protect_legacy_day_delete();
    drop function legacy_day_mark_erasure();
    drop function legacy_day_assert_group(uuid);
    drop function protect_legacy_day_terminal_transition();
    drop function legacy_day_assert_root(uuid);
    drop function legacy_day_erased_catalog(deal_day_scope_versions);
    drop function check_legacy_day_initial_done();
    drop function legacy_day_initial_done_valid(deal_day_scope_versions);
    drop function legacy_calendar_material_valid(jsonb);
    drop function legacy_calendar_holder_v2_valid(jsonb);
    drop function legacy_day_scope_material_valid(jsonb);
    drop function legacy_calendar_current_inventory_material(legacy_calendar_sources);
    drop function legacy_calendar_day_ids(legacy_calendar_sources);
    drop function legacy_day_group_material(uuid);
    drop function legacy_calendar_holder_v2(uuid,uuid);
    drop function legacy_day_scope_material(uuid,uuid);
    drop function legacy_day_reconcile(uuid,bigint);
    drop function legacy_day_resolve(uuid,uuid,bigint,uuid,text);
    drop function legacy_day_acquire(uuid,date,uuid,uuid);
    drop function legacy_day_group_touch(uuid,uuid,bigint);
    drop function audit_legacy_day_resolution();
    drop function legacy_day_discover_new();
    drop function protect_legacy_day_group();
    drop function legacy_day_resolution_valid(uuid,uuid);
    drop function legacy_day_group_wedding(uuid);
    drop function legacy_day_initial_candidates(uuid);
    drop function legacy_day_exact_root(uuid);
    drop function legacy_day_known_holders(uuid);
    drop function legacy_day_tuple_current(deal_day_scope_versions);
    drop function legacy_day_require_vendor(uuid);
    drop function legacy_day_lock_vendors(uuid[]);
    drop function legacy_day_vendor_locked(uuid);
    drop function legacy_day_uuid_set(uuid[]);
    drop function legacy_day_version_new(uuid);
    drop function legacy_day_transaction_owns(xid);
    drop table legacy_day_groups;
  `);
};
