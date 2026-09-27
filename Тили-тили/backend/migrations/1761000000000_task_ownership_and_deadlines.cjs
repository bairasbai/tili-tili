'use strict'

exports.up = (pgm) => {
  pgm.sql(`
    alter table tasks
      add column if not exists assignee_id uuid references users(id) on delete set null,
      add column if not exists due_mode text not null default 'relative';

    alter table tasks
      add constraint tasks_due_mode_check check (due_mode in ('relative', 'fixed'));

    create index if not exists tasks_assignee_due_idx
      on tasks (assignee_id, due)
      where kind = 'checklist' and done_at is null;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    drop index if exists tasks_assignee_due_idx;
    alter table tasks drop constraint if exists tasks_due_mode_check;
    alter table tasks drop column if exists due_mode;
    alter table tasks drop column if exists assignee_id;
  `)
}
