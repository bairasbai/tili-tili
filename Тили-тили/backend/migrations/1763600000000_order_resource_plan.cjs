exports.up = pgm => {
  pgm.sql(`
    create function resource_plan_public_lines(lines jsonb) returns jsonb language sql immutable strict as $$
      select coalesce(jsonb_agg(jsonb_build_object(
        'partId',line->'partId','assignmentId',line->'assignmentId','programEventId',line->'programEventId',
        'label',line->'label','kind',line->'kind','quantity',line->'quantity','unit',line->'unit',
        'startsAt',line->'startsAt','endsAt',line->'endsAt','timeZone',line->'timeZone',
        'setupMinutes',line->'setupMinutes','teardownMinutes',line->'teardownMinutes',
        'travelBeforeMinutes',line->'travelBeforeMinutes','travelAfterMinutes',line->'travelAfterMinutes',
        'occupiedStartsAt',line->'occupiedStartsAt','occupiedEndsAt',line->'occupiedEndsAt',
        'window',line->'window') order by ordinal),'[]'::jsonb)
      from jsonb_array_elements(lines) with ordinality as source(line,ordinal)
    $$;
    create table deal_resource_plan_versions(
      id uuid primary key,
      wedding_id uuid not null,
      deal_id uuid not null,
      vendor_id uuid not null,
      version bigint not null check(version>0),
      source_order_version bigint not null check(source_order_version>0),
      private_payload text not null,
      private_snapshot jsonb not null,
      private_digest text not null check(private_digest ~ '^[0-9a-f]{64}$'),
      public_snapshot jsonb not null,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      unique(deal_id,version),
      unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      check(private_snapshot=private_payload::jsonb),
      check(private_digest=encode(pg_catalog.sha256(convert_to(private_payload,'UTF8')),'hex')),
      check(jsonb_typeof(private_snapshot)='object' and private_snapshot->>'schemaVersion'='1'),
      check(case when jsonb_typeof(private_snapshot->'lines')='array'
        then jsonb_array_length(private_snapshot->'lines')<=100 else false end),
      check(public_snapshot=jsonb_build_object('planRevisionId',id::text,'revision',version::text,
        'lines',resource_plan_public_lines(private_snapshot->'lines')))
    );
    alter table deal_orders add column resource_plan_revision bigint not null default 0 check(resource_plan_revision>=0),
      add column resource_plan_id uuid,
      add constraint resource_plan_head_exists check((resource_plan_revision=0 and resource_plan_id is null)
        or (resource_plan_revision>0 and resource_plan_id is not null)),
      add constraint resource_plan_head_scope foreign key(wedding_id,deal_id,resource_plan_id)
        references deal_resource_plan_versions(wedding_id,deal_id,id) deferrable initially deferred;
    create function protect_resource_plan_revision() returns trigger language plpgsql as $$
    declare head deal_orders%rowtype;
    begin
      if TG_OP='INSERT' then
        select * into head from deal_orders where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id for update;
        if not found or NEW.version<>head.resource_plan_revision+1 or NEW.source_order_version<>head.version+1
          or not exists(select 1 from deals where wedding_id=NEW.wedding_id and id=NEW.deal_id and vendor_id=NEW.vendor_id) then
          raise exception 'resource plan requires current scoped order and next revision' using errcode='23514';
        end if;
        return NEW;
      end if;
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'resource plan history can only be erased with its wedding' using errcode='23514';
        end if;
        return OLD;
      end if;
      if (to_jsonb(NEW)-'created_by')<>(to_jsonb(OLD)-'created_by') or
        (NEW.created_by is distinct from OLD.created_by and not
          (OLD.created_by is not null and NEW.created_by is null and not exists(select 1 from users where id=OLD.created_by))) then
        raise exception 'resource plan revision is immutable' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger immutable_resource_plan before insert or update or delete on deal_resource_plan_versions
      for each row execute function protect_resource_plan_revision();
    create function check_resource_plan_head() returns trigger language plpgsql as $$
    begin
      if NEW.resource_plan_id is distinct from OLD.resource_plan_id or NEW.resource_plan_revision<>OLD.resource_plan_revision then
        if NEW.resource_plan_revision<>OLD.resource_plan_revision+1 or NEW.version<>OLD.version+1 or
          not exists(select 1 from deal_resource_plan_versions p where p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id
            and p.id=NEW.resource_plan_id and p.version=NEW.resource_plan_revision and p.source_order_version=NEW.version) then
          raise exception 'resource plan head must advance with the order version' using errcode='23514';
        end if;
      end if;
      return NEW;
    end $$;
    create trigger resource_plan_head_monotone before update on deal_orders
      for each row execute function check_resource_plan_head();
    alter table deal_terms_versions add column resource_plan_id uuid,
      add constraint resource_plan_terms_scope foreign key(wedding_id,deal_id,resource_plan_id)
        references deal_resource_plan_versions(wedding_id,deal_id,id) deferrable initially deferred,
      add constraint resource_plan_terms_format check(
        (snapshot->>'schemaVersion'='1' and resource_plan_id is null) or
        (snapshot->>'schemaVersion'='2' and resource_plan_id is not null
          and snapshot->'resourcePlan'->>'planRevisionId'=resource_plan_id::text));
    create function check_resource_plan_terms_binding() returns trigger language plpgsql as $$
    begin
      if NEW.resource_plan_id is not null and not exists(select 1 from deal_resource_plan_versions p
        where p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id and p.id=NEW.resource_plan_id
          and p.public_snapshot=NEW.snapshot->'resourcePlan') then
        raise exception 'terms must expose their exact immutable resource plan' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger resource_plan_terms_binding before insert on deal_terms_versions
      for each row execute function check_resource_plan_terms_binding();
    comment on table deal_resource_plan_versions is 'Immutable private selection and exact safe public projection. A saved plan is not a reservation or capacity/availability proof. Live source facts are rechecked on explicit operations';
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_plan_versions) or
      exists(select 1 from deal_orders where resource_plan_id is not null or resource_plan_revision<>0) or
      exists(select 1 from deal_terms_versions where resource_plan_id is not null) then
      raise exception 'resource plan or acceptance history exists; use a preserving forward migration';
    end if;
  end $$;
  drop trigger resource_plan_terms_binding on deal_terms_versions;
  drop function check_resource_plan_terms_binding();
  alter table deal_terms_versions drop constraint resource_plan_terms_format,drop constraint resource_plan_terms_scope,
    drop column resource_plan_id;
  drop trigger resource_plan_head_monotone on deal_orders;
  drop function check_resource_plan_head();
  alter table deal_orders drop constraint resource_plan_head_scope,drop constraint resource_plan_head_exists,
    drop column resource_plan_id,drop column resource_plan_revision;
  drop table deal_resource_plan_versions;
  drop function protect_resource_plan_revision();
  drop function resource_plan_public_lines(jsonb);`)
}
