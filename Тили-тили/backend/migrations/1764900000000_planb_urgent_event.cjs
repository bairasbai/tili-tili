exports.up = pgm => {
  pgm.sql(`
    alter table broadcasts
      add column planb_urgent_event_id uuid,
      add column planb_urgent_event_version text,
      add constraint broadcasts_planb_urgent_event_context check (
        (planb_urgent_event_id is null and planb_urgent_event_version is null) or
        (planb_urgent_event_id is not null and planb_urgent_event_version is not null
          and planb_urgent_event_version ~ '^[0-9a-f]{64}$' and planb_current is not null)
      );
    -- Keep the activation's historical binding even after its event is removed.
    -- A live match by wedding and event is required on every urgent send.
  `)
}

exports.down = pgm => {
  pgm.sql(`
    lock table broadcasts in access exclusive mode;
    do $$ begin
      if exists (select 1 from broadcasts where planb_urgent_event_id is not null) then
        raise exception 'planb_urgent_event_preserving_down_t016';
      end if;
    end $$;
    alter table broadcasts drop column planb_urgent_event_id, drop column planb_urgent_event_version;
  `)
}
