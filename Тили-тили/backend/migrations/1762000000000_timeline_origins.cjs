exports.up = (pgm) => {
  pgm.sql(`
    alter table timeline_events
      add column template_start time,
      add column template_day_offset smallint,
      add constraint timeline_template_origin_valid check (
        (template_start is null and template_day_offset is null)
        or (template_start is not null and template_start < time '24:00'
            and template_day_offset is not null and template_day_offset between 0 and 366)
      );
    -- Historical sort/name cannot prove provenance; leave it unknown.
    do $$
    declare unknown_count bigint;
    begin
      select count(*) into unknown_count from timeline_events where starts_at is null;
      if unknown_count > 0 then
        raise notice '% undated timeline blocks have no recorded template origin; first-date times must be supplied explicitly', unknown_count;
      end if;
    end $$;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from timeline_events where template_start is not null) then
        raise exception 'Cannot discard recorded timeline template origins' using errcode='23514';
      end if;
    end $$;
    alter table timeline_events
      drop constraint timeline_template_origin_valid,
      drop column template_start,
      drop column template_day_offset;
  `)
}
