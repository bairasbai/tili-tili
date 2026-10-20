/* R1.2 storage-only extension. No writer, backfill, API or booking authority.
 * Applied87 remains immutable; down preserves every ledger revision.
 */
exports.up = pgm => {
  pgm.sql(`
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

    create or replace function deal_day_scope_matches_current(v deal_day_scope_versions)
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

      -- The existing DATE row can represent several own roots. Its pointer
      -- is operational, not the complete membership or immutable provenance.
      select exists(select 1 from vendor_busy_dates b join deals p on p.id=b.deal_id
        where b.id=v.day_id and b.source='deal' and b.vendor_id=v.vendor_id and b.date=v.service_date
          and p.wedding_id=v.wedding_id and p.vendor_id=v.vendor_id
          and p.state in ('booked','paid_deposit','done')) into pointer_valid;
      return pointer_valid;
    end $$;

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
  `);
};

exports.down = pgm => {
  pgm.sql(`
    set local lock_timeout='5s';
    lock table deal_day_scope_versions in access exclusive mode;
    lock table deal_day_scope_heads in access exclusive mode;
    do $$ begin
      if exists(select 1 from deal_day_scope_versions where binding_state='done_undated') then
        raise exception 'Undated terminal history exists; use a preserving forward migration'
          using errcode='23514',constraint='deal_day_scope_preserving_down';
      end if;
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
          when 'released' then v.day_id is null
          else false end
        and (v.operation='observe'
          or (v.operation in ('acquire','move') and v.binding_state in ('active','undated','external'))
          or (v.operation='retain_done' and v.binding_state='done_retained')
          or (v.operation='release' and v.binding_state='released'))
      ) is true
    $$;

    create or replace function deal_day_scope_matches_current(v deal_day_scope_versions)
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

      -- The existing DATE row can represent several own roots. Its pointer
      -- is operational, not the complete membership or immutable provenance.
      select exists(select 1 from vendor_busy_dates b join deals p on p.id=b.deal_id
        where b.id=v.day_id and b.source='deal' and b.vendor_id=v.vendor_id and b.date=v.service_date
          and p.wedding_id=v.wedding_id and p.vendor_id=v.vendor_id
          and p.state in ('booked','paid_deposit','done')) into pointer_valid;
      return pointer_valid;
    end $$;

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
          or (NEW.operation='move' and previous.binding_state in ('done_retained','released'))
          or (NEW.operation='retain_done' and previous.binding_state not in ('active','done_retained')) then
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
  `);
};
