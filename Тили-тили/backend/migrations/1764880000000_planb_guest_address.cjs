exports.up = (pgm) => {
  pgm.sql(`
    alter table broadcasts add column planb_guest_address text,
      add constraint broadcasts_planb_guest_address check (planb_guest_address is null or (
        planb_current is not null and planb_revision is not null and action like 'planb:%'
        and char_length(planb_guest_address) between 1 and 500 and btrim(planb_guest_address) <> ''
      ));
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table broadcasts in access exclusive mode;
    do $$ begin
      if exists (select 1 from broadcasts where planb_guest_address is not null) then
        raise exception 'planb_guest_address_preserving_down_t016';
      end if;
    end $$;
    alter table broadcasts drop column planb_guest_address;
  `)
}
