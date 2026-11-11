exports.up = pgm => pgm.sql(`
  alter table reviews add column author_user_id uuid references users(id) on delete set null;
  create index reviews_author_user on reviews(author_user_id) where author_user_id is not null;
  alter table complaints add column affected_user_id uuid references users(id) on delete set null;
  create index complaints_affected_history on complaints(affected_user_id,resolved_at,id)
    where affected_user_id is not null;
  create index complaints_target_decisions on complaints(target_kind,target_id,resolved_at)
    where status='resolved';

  create table complaint_appeals (
    id uuid primary key,
    complaint_id uuid not null unique references complaints(id),
    appellant_id uuid references users(id) on delete set null,
    appellant_role text not null check (appellant_role in ('reporter','affected')),
    message text,
    assignee_id uuid references users(id) on delete set null,
    outcome text check (outcome in ('upheld','changed')),
    new_action text check (new_action in ('dismiss','warn','downrank','block')),
    reason text,
    created_at timestamptz not null default clock_timestamp(),
    resolved_at timestamptz,
    check (assignee_id is null or assignee_id is distinct from appellant_id),
    check (case when appellant_id is null then message is null and reason is null
      else message is not null and length(btrim(message)) between 1 and 4000
        and (outcome is null or (reason is not null and length(btrim(reason)) between 1 and 2000)) end),
    check (case when outcome is null then reason is null and new_action is null and resolved_at is null
      else resolved_at is not null and resolved_at >= created_at
        and (outcome='changed') = (new_action is not null) end)
  );
  create index complaint_appeals_appellant on complaint_appeals(appellant_id) where appellant_id is not null;
  create index complaint_appeals_assignee on complaint_appeals(assignee_id) where assignee_id is not null;
  create index complaint_appeals_queue on complaint_appeals(created_at,id)
    where outcome is null and appellant_id is not null;

  create function complaint_appeal_scrub() returns trigger language plpgsql as $$
  begin
    if new.appellant_id is null then
      new.message := null;
      new.reason := null;
    end if;
    return new;
  end;
  $$;
  create trigger complaint_appeal_scrub before update of appellant_id on complaint_appeals
    for each row execute function complaint_appeal_scrub();
`)

exports.down = pgm => pgm.sql(`
  lock table reviews,complaints,complaint_appeals in access exclusive mode;
  do $$ begin
    if exists(select 1 from complaint_appeals) or exists(select 1 from complaints where affected_user_id is not null)
      or exists(select 1 from reviews where author_user_id is not null) then
      raise exception using errcode='23514', message='complaint_appeals_preserving_down_fr069';
    end if;
  end $$;
  drop table complaint_appeals;
  drop function complaint_appeal_scrub();
  drop index complaints_affected_history,complaints_target_decisions;
  alter table complaints drop column affected_user_id;
  drop index reviews_author_user;
  alter table reviews drop column author_user_id;
`)
