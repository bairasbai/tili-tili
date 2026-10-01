exports.up = pgm => {
  pgm.sql(`create or replace function check_resource_allocation_counter() returns trigger language plpgsql as $$
    declare w resource_capacity_windows%rowtype;target uuid;
    begin
      if TG_TABLE_NAME='resource_capacity_windows' then target=NEW.id;
      else target=coalesce(NEW.capacity_window_id,OLD.capacity_window_id);end if;
      if target is null then return null;end if;
      select * into w from resource_capacity_windows where id=target;
      if found and w.used::bigint<>w.legacy_used::bigint+coalesce((select sum(quantity::bigint) from resource_allocations
        where capacity_window_id=target and released_at is null),0) then
        raise exception 'allocation ledger and used counter differ' using errcode='23514';
      end if;return null;
    end $$;
    create or replace function check_resource_commitment_complete() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;v deal_resource_commitment_versions%rowtype;target uuid;n integer;
    begin
      target=coalesce(NEW.deal_id,OLD.deal_id);
      select * into h from deal_resource_commitments where deal_id=target;
      if not found then return null;end if;
      if TG_TABLE_NAME='deal_resource_commitment_versions' then
        if not exists(
        with recursive ancestry as (
          select id,previous_version_id from deal_resource_commitment_versions where id=h.current_version_id
          union all select p.id,p.previous_version_id from deal_resource_commitment_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=NEW.id) then
        raise exception 'orphan commitment version' using errcode='23514';
      end if;
      end if;
      if h.revision=0 then
        if exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'empty head has allocations' using errcode='23514';
        end if;return null;
      end if;
      select * into v from deal_resource_commitment_versions where id=h.current_version_id and wedding_id=h.wedding_id and deal_id=h.deal_id;
      if not found or v.revision<>h.revision or v.state<>h.state then
        raise exception 'invalid commitment head' using errcode='23514';
      end if;
      if h.state='released' then
        if exists(select 1 from deal_resource_commitment_members where version_id=v.id) or
          exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'released head retains live allocations' using errcode='23514';
        end if;
      else
        select jsonb_array_length(private_snapshot->'lines') into n from deal_resource_plan_versions where id=v.plan_revision_id;
        if n=0 or (select count(*) from deal_resource_commitment_members where version_id=v.id)<>n or
          (select count(*) from resource_allocations where deal_id=target and released_at is null)<>n or
          exists(select 1 from deal_resource_commitment_members m join resource_allocations a on a.id=m.allocation_id
            where m.version_id=v.id and (a.released_at is not null or m.line_index>=n)) or
          exists(select 1 from resource_allocations a where a.deal_id=target and a.released_at is null and
            not exists(select 1 from deal_resource_commitment_members m where m.version_id=v.id and m.allocation_id=a.id)) then
          raise exception 'current commitment membership incomplete' using errcode='23514';
        end if;
      end if;return null;
    end $$;`)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_commitment_versions) then
      raise exception 'booking evidence exists; use preserving forward migration';
    end if;
  end $$;
  create or replace function check_resource_allocation_counter() returns trigger language plpgsql as $$
    declare w resource_capacity_windows%rowtype;target uuid;
    begin
      target=case when TG_TABLE_NAME='resource_capacity_windows' then NEW.id else coalesce(NEW.capacity_window_id,OLD.capacity_window_id) end;
      if target is null then return null;end if;
      select * into w from resource_capacity_windows where id=target;
      if found and w.used::bigint<>w.legacy_used::bigint+coalesce((select sum(quantity::bigint) from resource_allocations
        where capacity_window_id=target and released_at is null),0) then
        raise exception 'allocation ledger and used counter differ' using errcode='23514';
      end if;return null;
    end $$;
    create or replace function check_resource_commitment_complete() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;v deal_resource_commitment_versions%rowtype;target uuid;n integer;
    begin
      target=coalesce(NEW.deal_id,OLD.deal_id);
      select * into h from deal_resource_commitments where deal_id=target;
      if not found then return null;end if;
      if TG_TABLE_NAME='deal_resource_commitment_versions' and not exists(
        with recursive ancestry as (
          select id,previous_version_id from deal_resource_commitment_versions where id=h.current_version_id
          union all select p.id,p.previous_version_id from deal_resource_commitment_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=NEW.id) then
        raise exception 'orphan commitment version' using errcode='23514';
      end if;
      if h.revision=0 then
        if exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'empty head has allocations' using errcode='23514';
        end if;return null;
      end if;
      select * into v from deal_resource_commitment_versions where id=h.current_version_id and wedding_id=h.wedding_id and deal_id=h.deal_id;
      if not found or v.revision<>h.revision or v.state<>h.state then
        raise exception 'invalid commitment head' using errcode='23514';
      end if;
      if h.state='released' then
        if exists(select 1 from deal_resource_commitment_members where version_id=v.id) or
          exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'released head retains live allocations' using errcode='23514';
        end if;
      else
        select jsonb_array_length(private_snapshot->'lines') into n from deal_resource_plan_versions where id=v.plan_revision_id;
        if n=0 or (select count(*) from deal_resource_commitment_members where version_id=v.id)<>n or
          (select count(*) from resource_allocations where deal_id=target and released_at is null)<>n or
          exists(select 1 from deal_resource_commitment_members m join resource_allocations a on a.id=m.allocation_id
            where m.version_id=v.id and (a.released_at is not null or m.line_index>=n)) or
          exists(select 1 from resource_allocations a where a.deal_id=target and a.released_at is null and
            not exists(select 1 from deal_resource_commitment_members m where m.version_id=v.id and m.allocation_id=a.id)) then
          raise exception 'current commitment membership incomplete' using errcode='23514';
        end if;
      end if;return null;
    end $$;`)
}
