/**
 * Provisional T023 candidate: the migration number is not reserved.
 * Apply transactionally with task writers quiescent after the A13 merge.
 * Existing task rows remain unkeyed; no title inference or data repair.
 */
exports.up = (pgm) => {
  pgm.sql(`
    lock table tasks in access exclusive mode;

    alter table tasks add column system_template_key text;
    alter table tasks add constraint tasks_system_template_key_shape check (
      system_template_key is null or (
        source='system' and kind='planb' and system_template_key in (
          'planb.vendor_arrival',
          'planb.rings_passports',
          'planb.venue_materials',
          'planb.weather_venue_backup',
          'planb.timeline_buffer',
          'planb.emergency_kit'
        )
      )
    );
    create unique index tasks_system_template_scope_key
      on tasks(wedding_id,kind,system_template_key)
      where system_template_key is not null;

    create function protect_task_system_template_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' then
        if NEW.source='system' and NEW.kind='planb' and (
          NEW.system_template_key is null or NEW.system_template_key not in (
            'planb.vendor_arrival',
            'planb.rings_passports',
            'planb.venue_materials',
            'planb.weather_venue_backup',
            'planb.timeline_buffer',
            'planb.emergency_kit'
          )
        ) then
          raise exception 'new system Plan B task requires a known template key'
            using errcode='23514', constraint='tasks_system_template_key_required';
        end if;
        return NEW;
      end if;

      if NEW.system_template_key is distinct from OLD.system_template_key then
        raise exception 'task system template key is immutable'
          using errcode='23514', constraint='tasks_system_template_key_immutable';
      end if;
      -- Historical NULL system/planb rows retain their original scope too.
      if OLD.source='system' and OLD.kind='planb' and
        row(NEW.id,NEW.wedding_id,NEW.kind,NEW.source,NEW.system_template_key)
          is distinct from row(OLD.id,OLD.wedding_id,OLD.kind,OLD.source,OLD.system_template_key) then
        raise exception 'system Plan B task identity is immutable'
          using errcode='23514', constraint='tasks_system_planb_identity_immutable';
      end if;
      -- UPDATE must not promote an unkeyed row around the new INSERT guard.
      if NEW.source='system' and NEW.kind='planb' and NEW.system_template_key is null
        and not (OLD.source='system' and OLD.kind='planb') then
        raise exception 'an existing unkeyed task cannot become a system Plan B task'
          using errcode='23514', constraint='tasks_system_planb_insert_identity';
      end if;
      return NEW;
    end $$;
    create trigger tasks_system_template_guard before insert or update on tasks
      for each row execute function protect_task_system_template_identity();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table tasks in access exclusive mode;
    do $$ begin
      if exists(select 1 from tasks where system_template_key is not null) then
        raise exception 'system task template key evidence exists; use a preserving forward migration'
          using errcode='23514';
      end if;
    end $$;

    drop trigger tasks_system_template_guard on tasks;
    drop function protect_task_system_template_identity();
    drop index tasks_system_template_scope_key;
    alter table tasks drop constraint tasks_system_template_key_shape;
    alter table tasks drop column system_template_key;
  `)
}
