exports.up = pgm => {
  pgm.sql(`
    alter table deal_resource_plan_versions add constraint resource_plan_schema_exact
      check((jsonb_typeof(private_snapshot)='object' and private_snapshot->>'schemaVersion'='1') is true);
    create function check_resource_plan_committed_head() returns trigger language plpgsql as $$
    begin
      if exists(select 1 from deal_resource_plan_versions where id=NEW.id) and not exists(
        select 1 from deal_orders o where o.wedding_id=NEW.wedding_id and o.deal_id=NEW.deal_id
          and o.resource_plan_revision>=NEW.version and o.version>=NEW.source_order_version) then
        raise exception 'resource plan revision must commit with its advanced order head' using errcode='23514';
      end if;
      return null;
    end $$;
    create constraint trigger resource_plan_committed_head after insert on deal_resource_plan_versions
      deferrable initially deferred for each row execute function check_resource_plan_committed_head();
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_plan_versions) then
      raise exception 'resource plan integrity protects history; use a preserving forward migration';
    end if;
  end $$;
  drop trigger resource_plan_committed_head on deal_resource_plan_versions;
  drop function check_resource_plan_committed_head();
  alter table deal_resource_plan_versions drop constraint resource_plan_schema_exact;`)
}
