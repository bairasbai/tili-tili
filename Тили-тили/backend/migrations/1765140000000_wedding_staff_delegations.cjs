exports.up = pgm => pgm.sql(`
  alter table wedding_task_delegations
    add column issued_as text not null default 'couple' check (issued_as in ('couple','coordinator')),
    add column target_user_id uuid references users(id) on delete set null,
    add constraint wedding_task_staff_target check (
      (issued_as='couple' or target_user_id is not null or revoked_at is not null)
      and (target_user_id is null or accepted_by is null or accepted_by=target_user_id));
  create index wedding_task_delegations_live_issuer on wedding_task_delegations(issued_by,wedding_id) where revoked_at is null;
  create index wedding_task_delegations_live_target on wedding_task_delegations(target_user_id,wedding_id) where revoked_at is null;

  create function retire_task_delegations_after_membership_change() returns trigger language plpgsql as $$
  declare member_role text;
  begin
    if tg_op='UPDATE' then member_role:=new.role; end if;
    if member_role='couple' or not exists(select from weddings where id=old.wedding_id) then return null; end if;
    with locked as (
      select id from wedding_task_delegations where wedding_id=old.wedding_id and issued_by=old.user_id
        and revoked_at is null and (member_role is distinct from 'coordinator' or issued_as='couple')
      order by id for update
    ), retired as (
      update wedding_task_delegations g set revoked_at=statement_timestamp() from locked
        where g.id=locked.id returning g.id,g.task_id
    ) insert into audit_log(action,entity,entity_id,diff)
      select 'task_delegation.access_ended','task',task_id,jsonb_build_object('delegationId',id,'reason','issuer_access_lost') from retired;
    return null;
  end $$;
  create trigger wedding_members_retire_task_delegations after delete or update of role on wedding_members
    for each row execute function retire_task_delegations_after_membership_change();

  create function retire_task_delegations_after_account_change() returns trigger language plpgsql as $$
  begin
    if tg_op='UPDATE' then
      if old.deleted_at is not null or new.deleted_at is null then return new; end if;
    end if;
    with locked as (
      select id from wedding_task_delegations where revoked_at is null
        and (issued_by=old.id or target_user_id=old.id or accepted_by=old.id)
      order by id for update
    ), retired as (
      update wedding_task_delegations g set revoked_at=statement_timestamp() from locked
        where g.id=locked.id returning g.id,g.task_id
    ) insert into audit_log(action,entity,entity_id,diff)
      select 'task_delegation.access_ended','task',task_id,jsonb_build_object('delegationId',id,'reason','account_removed') from retired;
    if tg_op='DELETE' then return old; end if;
    return new;
  end $$;
  create trigger users_retire_task_delegations before delete or update of deleted_at on users
    for each row execute function retire_task_delegations_after_account_change();

  -- Keep previously accepted work and its audit. Retire only grants whose authority already ended.
  with retired as (
    update wedding_task_delegations g set revoked_at=statement_timestamp() where revoked_at is null
      and (not exists (select from wedding_members m join users u on u.id=m.user_id
        where m.wedding_id=g.wedding_id and m.user_id=g.issued_by and m.role='couple' and u.deleted_at is null)
        or (g.accepted_at is not null and not exists (select from users u where u.id=g.accepted_by and u.deleted_at is null)))
      returning g.id,g.task_id
  ) insert into audit_log(action,entity,entity_id,diff)
    select 'task_delegation.access_ended','task',task_id,jsonb_build_object('delegationId',id,'reason','previous_authority_ended') from retired;
`)

exports.down = pgm => pgm.sql(`
  lock table wedding_members,users,wedding_task_delegations in access exclusive mode;
  do $$ begin
    if exists(select from wedding_task_delegations where issued_as='coordinator' or target_user_id is not null) then
      raise exception using errcode='23514',message='wedding_staff_delegations_preserving_down_fr052';
    end if;
  end $$;
  drop trigger users_retire_task_delegations on users;
  drop function retire_task_delegations_after_account_change();
  drop trigger wedding_members_retire_task_delegations on wedding_members;
  drop function retire_task_delegations_after_membership_change();
  drop index wedding_task_delegations_live_target;
  drop index wedding_task_delegations_live_issuer;
  alter table wedding_task_delegations drop constraint wedding_task_staff_target, drop column target_user_id, drop column issued_as;
`)
