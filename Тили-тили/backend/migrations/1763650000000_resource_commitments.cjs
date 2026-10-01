exports.up = pgm => {
  pgm.sql(`
    alter table resource_capacity_windows add column legacy_used integer not null default 0 check(legacy_used>=0);
    update resource_capacity_windows set legacy_used=used;
    create table resource_conflict_keys(
      kind text not null check(kind in ('person','equipment','capacity')),
      identity uuid not null,primary key(kind,identity)
    );
    create table deal_resource_commitments(
      wedding_id uuid not null,deal_id uuid primary key,
      revision bigint not null default 0 check(revision>=0),
      state text not null default 'not_reserved' check(state in ('not_reserved','reserved','released')),
      current_version_id uuid,unique(wedding_id,deal_id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      check((revision=0 and state='not_reserved' and current_version_id is null) or
        (revision>0 and state in ('reserved','released') and current_version_id is not null))
    );
    create table deal_resource_commitment_versions(
      id uuid primary key,wedding_id uuid not null,deal_id uuid not null,vendor_id uuid not null,
      revision bigint not null check(revision>0),previous_version_id uuid,
      terms_id uuid not null,plan_revision_id uuid not null,policy_revision bigint not null check(policy_revision>0),
      action text not null check(action in ('commit','replace','release')),
      state text not null check(state in ('reserved','released')),
      reason text check(reason in ('deal_cancelled','wedding_erased','vendor_erased')),
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      unique(deal_id,revision),unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_resource_commitments(wedding_id,deal_id) on delete cascade,
      foreign key(wedding_id,deal_id,previous_version_id) references deal_resource_commitment_versions(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id,terms_id) references deal_terms_versions(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id,plan_revision_id) references deal_resource_plan_versions(wedding_id,deal_id,id),
      check((action='release' and state='released' and reason is not null) or
        (action in ('commit','replace') and state='reserved' and reason is null))
    );
    alter table deal_resource_commitments add constraint resource_commitment_head_scope
      foreign key(wedding_id,deal_id,current_version_id) references deal_resource_commitment_versions(wedding_id,deal_id,id)
      deferrable initially deferred;
    create table resource_allocations(
      id uuid primary key,wedding_id uuid not null,deal_id uuid not null,vendor_id uuid not null,
      origin_version_id uuid not null,origin_line_index integer not null check(origin_line_index>=0),
      line_snapshot jsonb not null check(jsonb_typeof(line_snapshot)='object'),
      resource_id uuid not null references vendor_resources(id) on delete restrict,
      capacity_window_id uuid references resource_capacity_windows(id) on delete restrict,
      kind text not null check(kind in ('person','equipment','capacity')),conflict_identity uuid not null,
      quantity integer not null check(quantity>0),occupied_starts_at timestamptz not null,occupied_ends_at timestamptz not null,
      released_at timestamptz,release_reason text check(release_reason in ('replaced','deal_cancelled','wedding_erased','vendor_erased')),
      unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      foreign key(wedding_id,deal_id,origin_version_id) references deal_resource_commitment_versions(wedding_id,deal_id,id),
      check(isfinite(occupied_starts_at) and isfinite(occupied_ends_at) and occupied_starts_at<occupied_ends_at),
      check((kind='capacity' and capacity_window_id is not null) or
        (kind in ('person','equipment') and quantity=1 and capacity_window_id is null)),
      check((released_at is null and release_reason is null) or (released_at is not null and release_reason is not null)),
      exclude using gist(kind with =,conflict_identity with =,tstzrange(occupied_starts_at,occupied_ends_at,'[)') with &&)
        where(released_at is null and kind in ('person','equipment'))
    );
    create index resource_allocations_live_window on resource_allocations(capacity_window_id) where released_at is null;
    create index resource_allocations_deal on resource_allocations(deal_id,id);
    create table deal_resource_commitment_members(
      wedding_id uuid not null,deal_id uuid not null,version_id uuid not null,
      line_index integer not null check(line_index>=0),allocation_id uuid not null,
      primary key(version_id,line_index),unique(version_id,allocation_id),
      foreign key(wedding_id,deal_id,version_id) references deal_resource_commitment_versions(wedding_id,deal_id,id) on delete cascade,
      foreign key(wedding_id,deal_id,allocation_id) references resource_allocations(wedding_id,deal_id,id)
        deferrable initially deferred
    );
    create function protect_resource_commitment_version() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;t deal_terms_versions%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'commitment evidence can only be erased with wedding' using errcode='23514';
        end if;return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'created_by')<>(to_jsonb(OLD)-'created_by') or
          (NEW.created_by is distinct from OLD.created_by and not(OLD.created_by is not null and NEW.created_by is null
            and not exists(select 1 from users where id=OLD.created_by))) then
          raise exception 'commitment evidence is immutable' using errcode='23514';
        end if;return NEW;
      end if;
      select * into h from deal_resource_commitments where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id for update;
      if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'commitment requires next scoped head revision' using errcode='23514';
      end if;
      select * into t from deal_terms_versions where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id and id=NEW.terms_id;
      if not found or t.resource_plan_id is distinct from NEW.plan_revision_id or
        not exists(select 1 from deal_resource_plan_versions p where p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id
          and p.id=NEW.plan_revision_id and p.vendor_id=NEW.vendor_id) then
        raise exception 'commitment requires exact scoped accepted resource plan' using errcode='23514';
      end if;
      if NEW.action='release' then
        if h.state<>'reserved' or not exists(select 1 from deal_resource_commitment_versions v where v.id=h.current_version_id
          and v.terms_id=NEW.terms_id and v.plan_revision_id=NEW.plan_revision_id and v.vendor_id=NEW.vendor_id
          and v.policy_revision=NEW.policy_revision) then
          raise exception 'release retains previous accepted proof' using errcode='23514';
        end if;
      elsif not exists(select 1 from deal_orders o where o.wedding_id=NEW.wedding_id and o.deal_id=NEW.deal_id
        and o.proposed_terms_id=NEW.terms_id and o.agreed_terms_id=NEW.terms_id and o.resource_plan_id=NEW.plan_revision_id) then
        raise exception 'commitment requires current agreed head' using errcode='23514';
      end if;
      if (NEW.action='commit' and h.revision<>0) or (NEW.action='replace' and h.state<>'reserved') then
        raise exception 'invalid commitment transition' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger immutable_resource_commitment_version before insert or update or delete on deal_resource_commitment_versions
      for each row execute function protect_resource_commitment_version();
    create function protect_resource_commitment_head() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' then
        if NEW.revision<>0 then raise exception 'initial commitment head is empty' using errcode='23514';end if;return NEW;
      end if;
      if NEW.wedding_id<>OLD.wedding_id or NEW.deal_id<>OLD.deal_id then
        raise exception 'commitment scope is immutable' using errcode='23514';
      end if;
      if NEW is distinct from OLD and (NEW.revision<>OLD.revision+1 or not exists(
        select 1 from deal_resource_commitment_versions v where v.wedding_id=NEW.wedding_id and v.deal_id=NEW.deal_id
          and v.id=NEW.current_version_id and v.revision=NEW.revision and v.state=NEW.state
          and v.previous_version_id is not distinct from OLD.current_version_id)) then
        raise exception 'commitment head must advance by one exact revision' using errcode='23514';
      end if;return NEW;
    end $$;
    create trigger resource_commitment_head_monotone before insert or update on deal_resource_commitments
      for each row execute function protect_resource_commitment_head();
    create function protect_resource_allocation() returns trigger language plpgsql as $$
    declare line jsonb;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'allocation history can only be erased with wedding' using errcode='23514';
        end if;return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'released_at'-'release_reason')<>(to_jsonb(OLD)-'released_at'-'release_reason') or
          OLD.released_at is not null or NEW.released_at is null or not isfinite(NEW.released_at) or NEW.release_reason is null then
          raise exception 'allocation facts are immutable; release is one way' using errcode='23514';
        end if;return NEW;
      end if;
      select p.private_snapshot->'lines'->NEW.origin_line_index into line from deal_resource_commitment_versions v
        join deal_resource_plan_versions p on p.wedding_id=v.wedding_id and p.deal_id=v.deal_id and p.id=v.plan_revision_id
        where v.wedding_id=NEW.wedding_id and v.deal_id=NEW.deal_id and v.id=NEW.origin_version_id
          and v.vendor_id=NEW.vendor_id and v.state='reserved';
      if line is null or line<>NEW.line_snapshot or NEW.released_at is not null or
        ((line->>'resourceId')::uuid=NEW.resource_id and (line->>'capacityWindowId')::uuid is not distinct from NEW.capacity_window_id
          and line->>'kind'=NEW.kind and (line->>'conflictIdentity')::uuid=NEW.conflict_identity
          and (line->>'quantity')::integer=NEW.quantity and (line->>'occupiedStartsAt')::timestamptz=NEW.occupied_starts_at
          and (line->>'occupiedEndsAt')::timestamptz=NEW.occupied_ends_at) is not true or
        not exists(select 1 from vendor_resources r where r.id=NEW.resource_id and r.vendor_id=NEW.vendor_id
          and r.kind=NEW.kind and r.conflict_identity=NEW.conflict_identity and r.retired_at is null) or
        (NEW.kind='capacity' and not exists(select 1 from resource_capacity_windows w where w.id=NEW.capacity_window_id
          and w.resource_id=NEW.resource_id and w.starts_at<=NEW.occupied_starts_at and w.ends_at>=NEW.occupied_ends_at)) then
        raise exception 'allocation requires exact validated private plan line' using errcode='23514';
      end if;return NEW;
    end $$;
    create trigger immutable_resource_allocation before insert or update or delete on resource_allocations
      for each row execute function protect_resource_allocation();
    create function protect_resource_commitment_member() returns trigger language plpgsql as $$
    begin
      if TG_OP<>'INSERT' then
        if TG_OP='DELETE' and not exists(select 1 from weddings where id=OLD.wedding_id) then return OLD;end if;
        raise exception 'commitment membership evidence is immutable' using errcode='23514';
      end if;
      if not exists(select 1 from deal_resource_commitment_versions v
        join deal_resource_plan_versions p on p.wedding_id=v.wedding_id and p.deal_id=v.deal_id and p.id=v.plan_revision_id
        join resource_allocations a on a.wedding_id=v.wedding_id and a.deal_id=v.deal_id and a.id=NEW.allocation_id
        where v.wedding_id=NEW.wedding_id and v.deal_id=NEW.deal_id and v.id=NEW.version_id and v.state='reserved'
          and a.released_at is null and a.line_snapshot=p.private_snapshot->'lines'->NEW.line_index) then
        raise exception 'member requires exact live scoped plan line' using errcode='23514';
      end if;return NEW;
    end $$;
    create trigger immutable_resource_commitment_member before insert or update or delete on deal_resource_commitment_members
      for each row execute function protect_resource_commitment_member();
    create function update_resource_allocation_counter() returns trigger language plpgsql as $$
    declare window_id uuid;delta bigint;
    begin
      if TG_OP='INSERT' then window_id=NEW.capacity_window_id;delta=NEW.quantity;
      elsif TG_OP='DELETE' then window_id=OLD.capacity_window_id;delta=case when OLD.released_at is null then -OLD.quantity else 0 end;
      else window_id=OLD.capacity_window_id;delta=-OLD.quantity;end if;
      if window_id is not null and delta<>0 then
        update resource_capacity_windows set used=used+delta where id=window_id;
        if not found then raise exception 'allocation window disappeared' using errcode='23514';end if;
      end if;return null;
    end $$;
    create trigger resource_allocation_counter after insert or update or delete on resource_allocations
      for each row execute function update_resource_allocation_counter();
    create function protect_resource_legacy_counter() returns trigger language plpgsql as $$
    begin
      if NEW.legacy_used<>OLD.legacy_used and exists(select 1 from resource_allocations where capacity_window_id=OLD.id) then
        raise exception 'historical baseline cannot change after allocation' using errcode='23514';
      end if;return NEW;
    end $$;
    create trigger resource_legacy_counter_immutable before update on resource_capacity_windows
      for each row execute function protect_resource_legacy_counter();
    create function check_resource_allocation_counter() returns trigger language plpgsql as $$
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
    create constraint trigger exact_resource_window_counter after insert or update on resource_capacity_windows
      deferrable initially deferred for each row execute function check_resource_allocation_counter();
    create constraint trigger exact_resource_allocation_counter after insert or update or delete on resource_allocations
      deferrable initially deferred for each row execute function check_resource_allocation_counter();
    create function check_resource_commitment_complete() returns trigger language plpgsql as $$
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
    end $$;
    create constraint trigger complete_resource_commitment_head after insert or update on deal_resource_commitments
      deferrable initially deferred for each row execute function check_resource_commitment_complete();
    create constraint trigger complete_resource_commitment_version after insert on deal_resource_commitment_versions
      deferrable initially deferred for each row execute function check_resource_commitment_complete();
    create constraint trigger complete_resource_commitment_member after insert on deal_resource_commitment_members
      deferrable initially deferred for each row execute function check_resource_commitment_complete();
    create constraint trigger complete_resource_commitment_allocation after insert or update or delete on resource_allocations
      deferrable initially deferred for each row execute function check_resource_commitment_complete();
    comment on table deal_resource_commitment_versions is 'Immutable evidence of explicit accepted resource booking; saving a resource plan alone never reserves resources';
    comment on column resource_capacity_windows.legacy_used is 'Preserved pre-ledger window inventory; kernel never edits it. Exact used includes only this baseline and active ledger allocations';
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_commitment_versions) or exists(select 1 from resource_allocations) or
      exists(select 1 from deal_resource_commitments where revision<>0) then
      raise exception 'resource booking evidence exists; use a preserving forward migration';
    end if;
  end $$;
  drop trigger complete_resource_commitment_allocation on resource_allocations;
  drop trigger complete_resource_commitment_member on deal_resource_commitment_members;
  drop trigger complete_resource_commitment_version on deal_resource_commitment_versions;
  drop trigger complete_resource_commitment_head on deal_resource_commitments;
  drop function check_resource_commitment_complete();
  drop trigger exact_resource_allocation_counter on resource_allocations;
  drop trigger exact_resource_window_counter on resource_capacity_windows;
  drop function check_resource_allocation_counter();
  drop trigger resource_legacy_counter_immutable on resource_capacity_windows;
  drop function protect_resource_legacy_counter();
  drop table deal_resource_commitment_members;
  drop function protect_resource_commitment_member();
  drop table resource_allocations;
  drop function protect_resource_allocation();
  drop function update_resource_allocation_counter();
  alter table deal_resource_commitments drop constraint resource_commitment_head_scope;
  drop table deal_resource_commitment_versions;
  drop function protect_resource_commitment_version();
  drop table deal_resource_commitments;
  drop function protect_resource_commitment_head();
  drop table resource_conflict_keys;
  alter table resource_capacity_windows drop column legacy_used;`)
}
