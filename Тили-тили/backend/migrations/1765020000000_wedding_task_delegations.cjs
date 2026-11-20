exports.up = pgm => pgm.sql(`
  alter table tasks add constraint tasks_delegation_identity unique(wedding_id,id);
  create table wedding_task_delegations (
    id uuid primary key,
    wedding_id uuid not null,
    task_id uuid not null,
    issued_by uuid references users(id) on delete set null,
    code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
    created_at timestamptz not null default now(),
    expires_at timestamptz not null,
    accepted_by uuid references users(id) on delete set null,
    accepted_at timestamptz,
    revoked_at timestamptz,
    foreign key (wedding_id,task_id) references tasks(wedding_id,id) on delete cascade,
    check (expires_at > created_at),
    check (accepted_by is null or accepted_at is not null)
  );
  create unique index wedding_task_delegations_one_live_idx on wedding_task_delegations(wedding_id,task_id)
    where revoked_at is null;
  create index wedding_task_delegations_task_idx on wedding_task_delegations(wedding_id,task_id);
  create index wedding_task_delegations_recipient_idx on wedding_task_delegations(accepted_by) where revoked_at is null;

  create function revoke_stale_wedding_task_delegation() returns trigger language plpgsql as $$ begin
    update wedding_task_delegations set revoked_at=now()
      where wedding_id=new.wedding_id and task_id=new.id and revoked_at is null;
    return null;
  end $$;
  create trigger tasks_revoke_stale_delegation after update of assignee_id,excluded_reason,kind on tasks
    for each row when (old.assignee_id is distinct from new.assignee_id
      or (old.excluded_reason is null and new.excluded_reason is not null)
      or old.kind is distinct from new.kind)
    execute function revoke_stale_wedding_task_delegation();
`)

exports.down = pgm => pgm.sql(`
  lock table tasks, wedding_task_delegations in access exclusive mode;
  do $$ begin
    if exists (select 1 from wedding_task_delegations) then
      raise exception using errcode='23514', message='wedding_task_delegations_preserving_down_fr008';
    end if;
  end $$;
  drop trigger tasks_revoke_stale_delegation on tasks;
  drop function revoke_stale_wedding_task_delegation();
  drop table wedding_task_delegations;
  alter table tasks drop constraint tasks_delegation_identity;
`)
