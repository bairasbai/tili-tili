exports.up = pgm => {
  pgm.sql(`alter table notifications add column push_disposition text not null default 'planned';
    alter table notifications add constraint notification_push_disposition_known
      check(push_disposition in ('planned','inbox_only','processed'));
    update notifications set push_disposition='processed' where pushed_at is not null;
    comment on column notifications.pushed_at is 'Legacy push-processing timestamp; does not prove provider acceptance, device delivery or reading';
    comment on column notifications.push_disposition is 'planned queues push; inbox_only is intentionally silent; processed is terminal processing, not delivery proof';`)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from notifications where push_disposition='inbox_only') then
      raise exception 'Cannot remove intentional inbox-only disposition history';
    end if;
  end $$;
  alter table notifications drop column push_disposition;`)
}
