exports.up = (pgm) => {
  pgm.sql(`
    alter table broadcasts add column planb_current boolean,
      add constraint broadcasts_planb_current_action check (planb_current is null or action like 'planb:%');
    create unique index broadcasts_planb_current_wedding on broadcasts(wedding_id) where planb_current;
    alter table notifications add column broadcast_id uuid references broadcasts(id) on delete set null,
      add constraint notifications_broadcast_system_only check (broadcast_id is null or (kind = 'system' and task_id is null));
    create unique index notifications_broadcast_user on notifications(broadcast_id, user_id) where broadcast_id is not null;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table broadcasts, notifications in access exclusive mode;
    do $$ begin
      if exists (select 1 from broadcasts where planb_current is not null)
        or exists (select 1 from notifications where broadcast_id is not null) then
        raise exception 'planb_notification_batch_preserving_down_t016';
      end if;
    end $$;
    alter table notifications drop column broadcast_id;
    alter table broadcasts drop column planb_current;
  `)
}
