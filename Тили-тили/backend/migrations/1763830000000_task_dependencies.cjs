'use strict'

/** Explicit checklist prerequisites. Historical tasks start with an empty graph. */
exports.up = pgm => {
  pgm.sql(`
    alter table tasks add column dependency_version bigint not null default 0;
    alter table tasks add constraint tasks_wedding_identity unique(wedding_id,id);
    create table task_dependencies (
      wedding_id uuid not null references weddings(id) on delete cascade,
      task_id uuid not null,
      prerequisite_id uuid not null,
      primary key(task_id,prerequisite_id),
      constraint task_dependencies_no_self check(task_id<>prerequisite_id),
      constraint task_dependencies_task_fk foreign key(wedding_id,task_id)
        references tasks(wedding_id,id) on delete cascade,
      constraint task_dependencies_prerequisite_fk foreign key(wedding_id,prerequisite_id)
        references tasks(wedding_id,id) on delete cascade
    );
    create index task_dependencies_reverse on task_dependencies(wedding_id,prerequisite_id);

    create function guard_task_dependency() returns trigger language plpgsql as $$
    declare target_kind text; target_done timestamptz; prerequisite_kind text;
    begin
      if TG_OP='UPDATE' then
        raise exception using errcode='23514',constraint='task_dependency_immutable',message='Replace a dependency by explicit removal and insertion';
      end if;
      -- Same serialization root as task completion, member changes and wedding removal.
      perform 1 from weddings where id=NEW.wedding_id for update;
      select kind,done_at into target_kind,target_done from tasks where id=NEW.task_id and wedding_id=NEW.wedding_id;
      select kind into prerequisite_kind from tasks where id=NEW.prerequisite_id and wedding_id=NEW.wedding_id;
      if target_kind is distinct from 'checklist' or prerequisite_kind is distinct from 'checklist' then
        raise exception using errcode='23514',constraint='task_dependency_scope',message='Prerequisites must be checklist tasks of one wedding';
      end if;
      if target_done is not null then
        raise exception using errcode='23514',constraint='task_dependency_completed',message='Reopen a completed task before adding prerequisites';
      end if;
      if (select count(*) from task_dependencies where task_id=NEW.task_id)>=64 then
        raise exception using errcode='23514',constraint='task_dependency_limit',message='At most 64 prerequisites per task';
      end if;
      if exists(with recursive chain(id) as (
        select NEW.prerequisite_id union
        select d.prerequisite_id from task_dependencies d join chain c on d.task_id=c.id where d.wedding_id=NEW.wedding_id
      ) select 1 from chain where id=NEW.task_id) then
        raise exception using errcode='23514',constraint='task_dependency_cycle',message='Dependency cycle';
      end if;
      return NEW;
    end $$;
    create trigger task_dependency_guard before insert or update on task_dependencies
      for each row execute function guard_task_dependency();

    create function task_dependency_version_changed() returns trigger language plpgsql as $$
    begin
      update tasks set dependency_version=dependency_version+1 where id=coalesce(NEW.task_id,OLD.task_id);
      return null;
    end $$;
    create trigger task_dependency_version after insert or delete on task_dependencies
      for each row execute function task_dependency_version_changed();

    create function guard_task_dependency_subject() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        -- A wedding/account cascade removes the parent first. Ordinary task deletion
        -- cannot silently make another task ready by erasing its prerequisite.
        if exists(select 1 from weddings where id=OLD.wedding_id) and
           exists(select 1 from task_dependencies where prerequisite_id=OLD.id) then
          raise exception using errcode='23514',constraint='task_dependency_in_use',message='Remove dependent links before deleting this prerequisite';
        end if;
        return OLD;
      end if;
      if NEW.kind<>'checklist' and exists(select 1 from task_dependencies where task_id=OLD.id or prerequisite_id=OLD.id) then
        raise exception using errcode='23514',constraint='task_dependency_scope',message='Linked tasks must remain checklist tasks';
      end if;
      return NEW;
    end $$;
    create trigger task_dependency_subject before delete or update of kind on tasks
      for each row execute function guard_task_dependency_subject();

    create function guard_task_dependency_completion() returns trigger language plpgsql as $$
    declare pending uuid[]; actor uuid; reason text; expected uuid[];
    begin
      if OLD.done_at is not null or NEW.done_at is null or NEW.kind<>'checklist' then return NEW; end if;
      perform 1 from weddings where id=NEW.wedding_id for update;
      select array_agg(p.id order by p.id) into pending from task_dependencies d
        join tasks p on p.id=d.prerequisite_id where d.task_id=NEW.id and p.done_at is null;
      if pending is null then return NEW; end if;
      if current_setting('tili.task_override_target',true) is distinct from NEW.id::text then
        raise exception using errcode='23514',constraint='task_dependencies_pending',message='Prerequisites are incomplete';
      end if;
      actor := nullif(current_setting('tili.task_override_actor',true),'')::uuid;
      reason := btrim(coalesce(current_setting('tili.task_override_reason',true),''));
      expected := current_setting('tili.task_override_blockers',true)::uuid[];
      if length(reason)<1 or length(reason)>500 or expected is distinct from pending or not exists(
        select 1 from wedding_members m join users u on u.id=m.user_id join weddings w on w.id=m.wedding_id
        where m.wedding_id=NEW.wedding_id and m.user_id=actor and m.role='couple' and u.deleted_at is null
          and w.archived_at is null and w.cancelled_at is null
      ) then
        raise exception using errcode='23514',constraint='task_dependency_override_invalid',message='A current couple decision and exact blockers are required';
      end if;
      insert into audit_log(actor_id,action,entity,entity_id,diff)
        values(actor,'task.dependencies.overridden','task',NEW.id,jsonb_build_object(
          'weddingId',NEW.wedding_id,'reason',reason,'prerequisiteIds',pending,'completedAt',NEW.done_at));
      return NEW;
    end $$;
    create trigger task_dependency_completion before update of done_at on tasks
      for each row execute function guard_task_dependency_completion();
  `)
}
exports.down = pgm => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from task_dependencies) or exists(select 1 from audit_log where action='task.dependencies.overridden') then
        raise exception 'Refusing to remove task dependency behavior with retained dependency or override evidence';
      end if;
    end $$;
    drop trigger task_dependency_completion on tasks;
    drop function guard_task_dependency_completion();
    drop trigger task_dependency_subject on tasks;
    drop function guard_task_dependency_subject();
    drop trigger task_dependency_version on task_dependencies;
    drop function task_dependency_version_changed();
    drop trigger task_dependency_guard on task_dependencies;
    drop function guard_task_dependency();
    drop table task_dependencies;
    alter table tasks drop constraint tasks_wedding_identity, drop column dependency_version;
  `)
}
