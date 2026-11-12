exports.up = pgm => pgm.sql(`
  create table support_cases (
    id uuid primary key,
    owner_id uuid not null references users(id) on delete cascade,
    assignee_id uuid references users(id) on delete set null,
    subject text not null check(length(btrim(subject)) between 1 and 160),
    status text not null default 'open' check(status in ('open','resolved')),
    created_at timestamptz not null default clock_timestamp(),
    check(assignee_id is distinct from owner_id)
  );
  create index support_cases_owner on support_cases(owner_id,created_at,id);
  create index support_cases_assignee on support_cases(assignee_id,created_at,id);
  create index support_cases_queue on support_cases(created_at,id) where status='open';

  create table support_case_events (
    id uuid primary key,
    position bigint generated always as identity unique,
    case_id uuid not null references support_cases(id) on delete cascade,
    actor_id uuid references users(id) on delete set null,
    kind text not null check(kind in ('opened','assigned','released','resolved')),
    message text,
    created_at timestamptz not null default clock_timestamp(),
    check(case when kind in ('opened','resolved') then message is not null and length(btrim(message)) between 1 and 4000
      else message is null end)
  );
  create index support_case_events_history on support_case_events(case_id,position);
  create index support_case_events_actor on support_case_events(actor_id);
  create unique index support_case_events_terminal on support_case_events(case_id,kind) where kind in ('opened','resolved');
`)

exports.down = pgm => pgm.sql(`
  lock table support_cases,support_case_events in access exclusive mode;
  do $$ begin
    if exists(select 1 from support_cases) then
      raise exception using errcode='23514', message='support_cases_preserving_down_fr068';
    end if;
  end $$;
  drop table support_case_events,support_cases;
`)
