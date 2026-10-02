exports.up = pgm => {
  pgm.sql(`
    create table ecosystem_resource_schema(
      singleton boolean primary key default true check(singleton),
      installed_btree_gist boolean not null
    );
    insert into ecosystem_resource_schema(singleton,installed_btree_gist)
      select true,not exists(select 1 from pg_extension where extname='btree_gist');
    create extension if not exists btree_gist;
    create table vendor_availability_policy(
      vendor_id uuid primary key references vendors(id) on delete cascade,
      mode text not null default 'legacy_day' check(mode in ('legacy_day','resources')),
      revision bigint not null default 1 check(revision>0),
      changed_by uuid references users(id) on delete set null,
      changed_at timestamptz not null default clock_timestamp()
    );
    create table vendor_resources(
      id uuid primary key,
      vendor_id uuid references vendors(id) on delete set null,
      kind text not null check(kind in ('person','equipment','capacity')),
      label text not null check(length(btrim(label)) between 1 and 200),
      person_user_id uuid references users(id) on delete set null,
      staff_member_id uuid references vendor_staff_members(id) on delete set null,
      conflict_identity uuid not null,
      capacity_unit text,
      version bigint not null default 1 check(version>0),
      retired_at timestamptz,
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      unique(vendor_id,id),
      check((kind='capacity' and capacity_unit is not null and length(btrim(capacity_unit)) between 1 and 80)
        or (kind<>'capacity' and capacity_unit is null)),
      check(kind='person' or (person_user_id is null and staff_member_id is null and conflict_identity=id)),
      check(kind<>'person' or person_user_id is null or conflict_identity=person_user_id)
    );
    create unique index vendor_resource_person on vendor_resources(vendor_id,conflict_identity) where kind='person';
    create function protect_vendor_resource_identity() returns trigger language plpgsql as $$
    declare actual_owner uuid; member_vendor uuid; member_user uuid;
    begin
      if TG_OP='UPDATE' then
        if NEW.id<>OLD.id or NEW.kind<>OLD.kind or NEW.conflict_identity<>OLD.conflict_identity
          or NEW.capacity_unit is distinct from OLD.capacity_unit
          or (NEW.vendor_id is distinct from OLD.vendor_id and
            not (NEW.vendor_id is null and not exists(select 1 from vendors where id=OLD.vendor_id)))
          or (NEW.person_user_id is distinct from OLD.person_user_id and
            not (NEW.person_user_id is null and not exists(select 1 from users where id=OLD.person_user_id)))
          or (NEW.staff_member_id is distinct from OLD.staff_member_id and
            not (NEW.staff_member_id is null and not exists(select 1 from vendor_staff_members where id=OLD.staff_member_id))) then
          raise exception 'resource identity is immutable' using errcode='23514';
        end if;
        return NEW;
      end if;
      if NEW.vendor_id is null then raise exception 'new resource requires a real vendor' using errcode='23514'; end if;
      if NEW.kind='person' then
        if NEW.person_user_id is null or NEW.conflict_identity<>NEW.person_user_id then
          raise exception 'person resource requires actual identity' using errcode='23514';
        end if;
        select user_id into actual_owner from vendors where id=NEW.vendor_id;
        if NEW.staff_member_id is null then
          if NEW.person_user_id is distinct from actual_owner then
            raise exception 'person is neither owner nor scoped company member' using errcode='23514';
          end if;
        else
          select vendor_id,user_id into member_vendor,member_user from vendor_staff_members
            where id=NEW.staff_member_id and state='active';
          if member_vendor is distinct from NEW.vendor_id or member_user is distinct from NEW.person_user_id then
            raise exception 'person resource requires accepted scoped member' using errcode='23514';
          end if;
        end if;
      end if;
      return NEW;
    end $$;
    create trigger protect_vendor_resource_identity before insert or update on vendor_resources
      for each row execute function protect_vendor_resource_identity();
    create table resource_capacity_windows(
      id uuid primary key,
      resource_id uuid not null references vendor_resources(id) on delete cascade,
      starts_at timestamptz not null,
      ends_at timestamptz not null,
      capacity integer not null check(capacity>0),
      used integer not null default 0 check(used>=0 and used<=capacity),
      version bigint not null default 1 check(version>0),
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      unique(resource_id,id),
      check(isfinite(starts_at) and isfinite(ends_at) and starts_at<ends_at),
      exclude using gist(resource_id with =,tstzrange(starts_at,ends_at,'[)') with &&)
    );
    create function check_resource_capacity_kind() returns trigger language plpgsql as $$
    begin
      if not exists(select 1 from vendor_resources where id=NEW.resource_id and kind='capacity') then
        raise exception 'capacity window requires a capacity resource' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger check_resource_capacity_kind before insert or update on resource_capacity_windows
      for each row execute function check_resource_capacity_kind();
    comment on table vendor_availability_policy is 'Explicit policy; missing row means legacy day. Switching alone never releases old obligations';
    comment on column vendor_resources.conflict_identity is 'Stable internal conflict key; a person uses actual account identity across companies. Not an authorization proof';
    comment on table resource_capacity_windows is 'Explicit finite nonoverlapping capacity windows. Units are declared by the owner, never inferred from category';
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from vendor_resources) or exists(select 1 from resource_capacity_windows)
      or exists(select 1 from vendor_availability_policy) then
      raise exception 'resource history or explicit policy exists; use a preserving forward migration';
    end if;
  end $$;
  drop table resource_capacity_windows;
  drop function check_resource_capacity_kind();
  drop table vendor_resources;
  drop function protect_vendor_resource_identity();
  drop table vendor_availability_policy;
  do $$ begin
    if (select installed_btree_gist from ecosystem_resource_schema where singleton) then
      execute 'drop extension btree_gist';
    end if;
  end $$;
  drop table ecosystem_resource_schema;`)
}
