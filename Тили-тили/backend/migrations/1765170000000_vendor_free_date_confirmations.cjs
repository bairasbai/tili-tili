exports.up = (pgm) => {
  pgm.sql(`
    create table vendor_free_date_confirmations (
      vendor_id uuid not null references vendors(id) on delete cascade,
      date date not null check (isfinite(date)),
      confirmed_at timestamptz not null default clock_timestamp() check (isfinite(confirmed_at)),
      primary key (vendor_id, date)
    );

    create function invalidate_vendor_free_date() returns trigger language plpgsql as $$
    begin
      delete from vendor_free_date_confirmations where vendor_id=NEW.vendor_id and date=NEW.date;
      return NEW;
    end;
    $$;

    create trigger invalidate_vendor_free_date_on_busy
      after insert on vendor_busy_dates for each row execute function invalidate_vendor_free_date();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table vendor_busy_dates in share row exclusive mode;
    lock table vendor_free_date_confirmations in access exclusive mode;
    do $$ begin
      if exists (select 1 from vendor_free_date_confirmations) then
        raise exception 'Vendor calendar confirmations exist; refusing to drop them';
      end if;
    end $$;
    drop trigger invalidate_vendor_free_date_on_busy on vendor_busy_dates;
    drop function invalidate_vendor_free_date();
    drop table vendor_free_date_confirmations;
  `)
}
