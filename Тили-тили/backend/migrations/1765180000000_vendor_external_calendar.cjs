exports.up = (pgm) => {
  pgm.sql(`
    create table vendor_external_calendar_periods (
      vendor_id uuid not null references vendors(id) on delete cascade,
      source text not null check (source in ('ics','external')),
      days daterange not null check (not isempty(days) and not lower_inf(days) and not upper_inf(days)
        and isfinite(lower(days)) and isfinite(upper(days)) and upper(days)-lower(days) <= 370),
      occupied tstzrange not null check (not isempty(occupied) and not lower_inf(occupied) and not upper_inf(occupied)
        and isfinite(lower(occupied)) and isfinite(upper(occupied)) and lower_inc(occupied) and not upper_inc(occupied)),
      marked_at timestamptz not null default clock_timestamp(),
      primary key (vendor_id,source,days,occupied)
    );

    create function assert_external_calendar_day() returns trigger language plpgsql as $$
    begin
      if NEW.source='deal'
        and not exists(select 1 from vendor_busy_dates b where b.vendor_id=NEW.vendor_id and b.date=NEW.date)
        and exists(select 1 from vendor_external_calendar_periods p where p.vendor_id=NEW.vendor_id and p.days @> NEW.date) then
        raise unique_violation using message='DATE overlaps external calendar',constraint='vendor_busy_dates_pk';
      end if;
      return NEW;
    end $$;
    create trigger assert_external_calendar_day before insert on vendor_busy_dates
      for each row execute function assert_external_calendar_day();

    create function assert_external_calendar_resource() returns trigger language plpgsql as $$
    begin
      if NEW.released_at is null and exists(
        select 1 from vendor_external_calendar_periods p where p.vendor_id=NEW.vendor_id
          and p.occupied && tstzrange(NEW.occupied_starts_at,NEW.occupied_ends_at,'[)')
      ) then
        raise exclusion_violation using message='Resource period overlaps external calendar',constraint='vendor_external_calendar_occupied';
      end if;
      return NEW;
    end $$;
    create trigger assert_external_calendar_resource before insert on resource_allocations
      for each row execute function assert_external_calendar_resource();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table vendor_busy_dates, resource_allocations in share row exclusive mode;
    lock table vendor_external_calendar_periods in access exclusive mode;
    do $$ begin
      if exists (select 1 from vendor_external_calendar_periods) then
        raise exception 'External calendar periods exist; refusing to drop them';
      end if;
    end $$;
    drop trigger assert_external_calendar_resource on resource_allocations;
    drop trigger assert_external_calendar_day on vendor_busy_dates;
    drop function assert_external_calendar_resource();
    drop function assert_external_calendar_day();
    drop table vendor_external_calendar_periods;
  `)
}
