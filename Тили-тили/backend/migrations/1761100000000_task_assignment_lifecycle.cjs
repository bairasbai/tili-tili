'use strict'

exports.up = pgm => {
  pgm.sql(`
    -- Existing assigned tasks survive; invalid/removed assignees become unassigned.
    update tasks t set assignee_id=null where assignee_id is not null and not exists (
      select 1 from wedding_members m join users u on u.id=m.user_id
      where m.wedding_id=t.wedding_id and m.user_id=t.assignee_id
        and m.role in ('couple','helper','coordinator') and u.deleted_at is null
    );
    alter table tasks add constraint tasks_assignee_member_fk
      foreign key (wedding_id,assignee_id) references wedding_members(wedding_id,user_id)
      on delete set null (assignee_id);

    create function clear_deleted_task_assignee() returns trigger language plpgsql as $$
    begin
      if new.deleted_at is not null and old.deleted_at is null then
        update tasks set assignee_id=null where assignee_id=new.id;
      end if;
      return new;
    end $$;
    create trigger tasks_clear_deleted_user after update of deleted_at on users
      for each row execute function clear_deleted_task_assignee();

    create function clear_ineligible_task_member() returns trigger language plpgsql as $$
    begin
      if new.role not in ('couple','helper','coordinator') then
        update tasks set assignee_id=null where wedding_id=new.wedding_id and assignee_id=new.user_id;
      end if;
      return new;
    end $$;
    create trigger tasks_clear_ineligible_member after update of role on wedding_members
      for each row execute function clear_ineligible_task_member();
  `)
}
exports.down = pgm => {
  pgm.sql(`
    drop trigger if exists tasks_clear_ineligible_member on wedding_members;
    drop function if exists clear_ineligible_task_member();
    drop trigger if exists tasks_clear_deleted_user on users;
    drop function if exists clear_deleted_task_assignee();
    alter table tasks drop constraint if exists tasks_assignee_member_fk;
  `)
}
