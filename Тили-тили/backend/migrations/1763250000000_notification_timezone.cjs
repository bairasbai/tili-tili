exports.up = pgm => {
  pgm.sql(`alter table notifications add column delivery_time_zone text;
    comment on column notifications.delivery_time_zone is 'Validated scheduling fallback; current user timezone still takes precedence. Null legacy value is unknown, not inferred from notification text.';`)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from notifications where delivery_time_zone is not null) then
      raise exception 'Cannot remove recorded notification timezone context';
    end if;
  end $$;
  alter table notifications drop column delivery_time_zone;`)
}
