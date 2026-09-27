'use strict'

exports.up = pgm => {
  pgm.sql(`
    alter table tasks
      add column reminder_days_before smallint,
      add column reminder_time time not null default '09:00',
      add column notice_version bigint not null default 0,
      add column reminded_version bigint;
    alter table tasks add constraint tasks_reminder_days_check check (
      reminder_days_before is null or (reminder_days_before between 0 and 30
        and due is not null and assignee_id is not null and kind = 'checklist'));
    alter table notifications
      add column task_id uuid references tasks(id) on delete set null,
      add column task_version bigint,
      add column task_event text,
      add column expires_at timestamptz,
      add column cancelled_at timestamptz;
    alter table notifications add constraint notifications_task_context_check check (
      cancelled_at is not null or (task_id is null and task_version is null and task_event is null)
      or (task_id is not null and task_version is not null and task_event is not null
          and task_event in ('assignment','reminder') and expires_at is not null and kind = 'task'));
    create unique index notifications_task_once_idx on notifications(task_id,task_version,task_event,user_id)
      where task_id is not null;
    create index tasks_pending_reminder_idx on tasks(due,id)
      where reminder_days_before is not null and done_at is null;

    -- Membership/account cleanup and wedding rescheduling use UPDATE too.
    -- Invalidate old queued notices in the same transaction as their source.
    create function task_notice_lifecycle() returns trigger language plpgsql as $$
    begin
      if new.due is null or new.assignee_id is null then
        new.reminder_days_before := null;
      end if;
      if row(new.assignee_id,new.due,new.done_at,new.reminder_days_before,new.reminder_time)
        is distinct from row(old.assignee_id,old.due,old.done_at,old.reminder_days_before,old.reminder_time) then
        new.notice_version := old.notice_version + 1;
        new.reminded_version := null;
        update notifications set cancelled_at = coalesce(cancelled_at,now()) where task_id = old.id;
      elsif new.title is distinct from old.title then
        -- Renaming does not re-arm an already delivered reminder.
        update notifications set body = new.title where task_id = old.id and cancelled_at is null;
      end if;
      return new;
    end $$;
    -- Keep cancelled records for the push daily-cap calculation; hide them in the inbox.
    -- A delete must not erase the count of pushes already handed to the provider.
    create function task_notice_deleted() returns trigger language plpgsql as $$
    begin
      update notifications set cancelled_at = coalesce(cancelled_at,now()) where task_id = old.id;
      return old;
    end $$;
    create trigger tasks_notice_deleted before delete on tasks
      for each row execute function task_notice_deleted();
    create trigger tasks_notice_lifecycle before update on tasks
      for each row execute function task_notice_lifecycle();
  `)
}
exports.down = pgm => {
  pgm.sql(`
    drop trigger if exists tasks_notice_deleted on tasks;
    drop function if exists task_notice_deleted();
    drop trigger if exists tasks_notice_lifecycle on tasks;
    drop function if exists task_notice_lifecycle();
    delete from notifications where task_event is not null;
    drop index if exists notifications_task_once_idx;
    alter table notifications drop constraint if exists notifications_task_context_check;
    alter table notifications drop column cancelled_at, drop column expires_at, drop column task_event,
      drop column task_version, drop column task_id;
    drop index if exists tasks_pending_reminder_idx;
    alter table tasks drop constraint if exists tasks_reminder_days_check;
    alter table tasks drop column reminded_version, drop column notice_version,
      drop column reminder_time, drop column reminder_days_before;
  `)
}
