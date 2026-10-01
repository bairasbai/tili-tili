exports.up = (pgm) => {
  pgm.sql(`
    alter table weddings
      add column attention_mode text not null default 'essential'
        check (attention_mode in ('essential','coordinator','detailed')),
      add column attention_version bigint not null default 1 check (attention_version > 0),
      add column attention_coordinator_user_id uuid references users(id) on delete set null;
    alter table notification_prefs
      add column urgent_incidents boolean not null default false;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from weddings where attention_mode <> 'essential'
          or attention_coordinator_user_id is not null or attention_version <> 1)
        or exists (select 1 from notification_prefs where urgent_incidents) then
        raise exception 'Cannot discard attention choices; restore from a reviewed backup instead';
      end if;
    end $$;
    alter table notification_prefs drop column urgent_incidents;
    alter table weddings drop column attention_coordinator_user_id,
      drop column attention_version, drop column attention_mode;
  `)
}
