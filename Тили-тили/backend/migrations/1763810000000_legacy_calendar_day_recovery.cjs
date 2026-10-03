/**
 * Preserving forward fix for 380: a day reassigned to another wedding can
 * outlive its original wedding-owned app_day. Discover a new identity from
 * the live pointer, with a rev0 head; never transplant or capture history.
 * Apply transactionally with writers quiescent: the backfill takes table
 * locks and adds only missing sources/heads, preserving all existing rows.
 */
exports.up = (pgm) => {
  pgm.sql(`
    -- Keep the backfill's pointer, origin and parent stable until COMMIT.
    -- node-pg-migrate runs this migration in one transaction.
    lock table weddings, vendors, deals, vendor_busy_dates,
      legacy_calendar_sources, legacy_calendar_heads in access exclusive mode;

    create or replace function legacy_calendar_pin_cascade_companies() returns trigger language plpgsql as $$
    begin
      -- Pin both the actual pointer scope and retained days whose immutable
      -- app_day still belongs to the wedding being deleted, before day locks.
      perform v.id from vendors v where v.id in (
        select b.vendor_id from vendor_busy_dates b join deals d on d.id=b.deal_id
        where d.wedding_id=OLD.id and b.source='deal'
        union
        select b.vendor_id from vendor_busy_dates b join legacy_calendar_sources s on s.day_id=b.id
        where s.wedding_id=OLD.id and s.kind='app_day' and b.source='deal'
      ) order by v.id for key share;
      return OLD;
    end $$;

    create function legacy_calendar_recover_retained_day() returns trigger language plpgsql as $$
    declare day_row vendor_busy_dates%rowtype; actual_wedding_id uuid; new_source_id uuid;
    begin
      if OLD.kind<>'app_day' or exists(select 1 from weddings where id=OLD.wedding_id) then return OLD; end if;

      select * into day_row from vendor_busy_dates where id=OLD.day_id for share;
      -- FK cascades may already have removed the day or nulled its pointer.
      -- Existing orphan discovery owns the NULL case, in either cascade order.
      if not found or day_row.source<>'deal' or day_row.deal_id is null then return OLD; end if;
      select d.wedding_id into actual_wedding_id from deals d join weddings w on w.id=d.wedding_id
        where d.id=day_row.deal_id;
      if not found or actual_wedding_id=OLD.wedding_id then return OLD; end if;

      -- We already hold company/day locks. Waiting for a different wedding
      -- would invert ordinary wedding -> company -> day writers. NOWAIT must
      -- propagate 55P03 so the whole deletion rolls back; never hide the gap.
      perform w.id from weddings w where w.id=actual_wedding_id for key share nowait;
      if not found then return OLD; end if;

      insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,origin,discovered_by)
        values('app_day',day_row.vendor_id,actual_wedding_id,null,day_row.id,
          legacy_calendar_origin('app_day',day_row.id,null),'writer')
        on conflict(day_id,kind) do nothing returning id into new_source_id;
      if new_source_id is not null then
        insert into legacy_calendar_heads(source_id) values(new_source_id);
      end if;
      return OLD;
    end $$;
    create trigger legacy_calendar_recover_retained_day after delete on legacy_calendar_sources
      for each row execute function legacy_calendar_recover_retained_day();

    -- Repair gaps left while 380 was active. Fresh discovery carries no
    -- invented prior snapshot: old sources, versions, holders and heads stay
    -- immutable, including another historical kind for the same day.
    with discovered as (
      insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,origin,discovered_by)
      select 'app_day',b.vendor_id,d.wedding_id,null,b.id,legacy_calendar_origin('app_day',b.id,null),'writer'
      from vendor_busy_dates b join deals d on d.id=b.deal_id join weddings w on w.id=d.wedding_id
      where b.source='deal' and not exists(
        select 1 from legacy_calendar_sources s where s.day_id=b.id and s.kind='app_day'
      )
      order by b.vendor_id,b.id
      on conflict(day_id,kind) do nothing returning id
    )
    insert into legacy_calendar_heads(source_id) select id from discovered;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table legacy_calendar_sources, legacy_calendar_versions,
      legacy_calendar_version_holders, legacy_calendar_heads in access exclusive mode;
    do $$ begin
      if exists(select 1 from legacy_calendar_sources) or exists(select 1 from legacy_calendar_versions)
        or exists(select 1 from legacy_calendar_version_holders) or exists(select 1 from legacy_calendar_heads) then
        raise exception 'legacy calendar inventory evidence exists; use a preserving forward migration';
      end if;
    end $$;

    drop trigger legacy_calendar_recover_retained_day on legacy_calendar_sources;
    drop function legacy_calendar_recover_retained_day();
    create or replace function legacy_calendar_pin_cascade_companies() returns trigger language plpgsql as $$
    begin
      perform v.id from vendors v where v.id in (
        select b.vendor_id from vendor_busy_dates b join deals d on d.id=b.deal_id
        where d.wedding_id=OLD.id and b.source='deal'
      ) order by v.id for key share;
      return OLD;
    end $$;
  `)
}
