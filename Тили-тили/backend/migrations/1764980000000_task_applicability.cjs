exports.up = pgm => pgm.sql(`
  alter table tasks add column excluded_reason text;
  alter table tasks add constraint tasks_excluded_reason_check check (
    excluded_reason is null or (kind = 'checklist' and source = 'system'
      and char_length(excluded_reason) <= 500 and excluded_reason ~ '[^[:space:]]')
  );
  create function task_applicability_notice_lifecycle() returns trigger language plpgsql as $$
  begin
    new.notice_version := old.notice_version + 1;
    new.reminded_version := null;
    update notifications set cancelled_at = coalesce(cancelled_at, now()) where task_id = old.id;
    return new;
  end $$;
  create trigger tasks_applicability_notice_lifecycle before update of excluded_reason on tasks
    for each row when ((old.excluded_reason is null) <> (new.excluded_reason is null))
    execute function task_applicability_notice_lifecycle();
`)

exports.down = pgm => pgm.sql(`
  lock table tasks in access exclusive mode;
  do $$ begin
    if exists (select 1 from tasks where excluded_reason is not null) then
      raise exception using errcode = '23514', message = 'tasks_preserve_exclusions_fr003';
    end if;
  end $$;
  drop trigger tasks_applicability_notice_lifecycle on tasks;
  drop function task_applicability_notice_lifecycle();
  alter table tasks drop column excluded_reason;
`)
