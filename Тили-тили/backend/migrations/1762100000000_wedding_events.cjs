exports.up = (pgm) => {
  pgm.sql(`
    create table wedding_events (
      id uuid primary key,
      wedding_id uuid not null references weddings(id) on delete cascade,
      name text not null check (length(btrim(name)) between 1 and 200),
      kind text not null check (kind in ('registration','nikah','ceremony','banquet','second_day','other')),
      date date,
      time_zone text,
      location text check (length(location)<=300),
      is_main boolean not null default false,
      modified_at timestamptz,
      unique(wedding_id,id)
    );
    create unique index wedding_main_event on wedding_events(wedding_id) where is_main;
    create index wedding_event_date on wedding_events(wedding_id,date,id);
    insert into wedding_events(id,wedding_id,name,kind,date,time_zone,location,is_main)
      select gen_random_uuid(),id,'Основная программа','other',date,tz,venue,true from weddings;
    alter table timeline_events add column program_event_id uuid;
    -- An unvalidated historical interval must survive this metadata-only backfill.
    do $$
    declare historical_check text;
    begin
      select pg_get_constraintdef(oid) into historical_check from pg_constraint
        where conrelid='timeline_events'::regclass and conname='timeline_interval_valid' and not convalidated;
      if historical_check is not null then alter table timeline_events drop constraint timeline_interval_valid; end if;
      alter table timeline_events disable trigger timeline_revision_changed;
      update timeline_events t set program_event_id=e.id from wedding_events e
        where e.wedding_id=t.wedding_id and e.is_main;
      alter table timeline_events enable trigger timeline_revision_changed;
      if historical_check is not null then
        execute 'alter table timeline_events add constraint timeline_interval_valid ' || historical_check;
      end if;
    end $$;
    alter table timeline_events alter column program_event_id set not null;
    alter table timeline_events add constraint timeline_program_event_fk
      foreign key(wedding_id,program_event_id) references wedding_events(wedding_id,id)
      deferrable initially deferred;
    create index timeline_program_event on timeline_events(wedding_id,program_event_id);

    create function guard_wedding_event() returns trigger language plpgsql as $$
    declare w weddings%rowtype; target uuid;
    begin
      if TG_OP='DELETE' then target:=OLD.wedding_id; else target:=NEW.wedding_id; end if;
      select * into w from weddings where id=target for update;
      if TG_OP='DELETE' then
        if OLD.is_main and w.id is not null then
          raise exception 'Cannot delete the main wedding event' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' and (OLD.id is distinct from NEW.id or OLD.wedding_id is distinct from NEW.wedding_id or OLD.is_main is distinct from NEW.is_main) then
        raise exception 'Wedding event identity cannot change' using errcode='23514';
      end if;
      if TG_OP='INSERT' and (select count(*) from wedding_events where wedding_id=target)>=50 then
        raise exception 'Wedding event limit exceeded' using errcode='23514';
      end if;
      if NEW.time_zone is not null and (TG_OP='INSERT' or NEW.time_zone is distinct from OLD.time_zone)
        and not exists(select 1 from pg_timezone_names where name=NEW.time_zone) then
        raise exception 'Unknown event time zone' using errcode='23514';
      end if;
      if NEW.is_main and (NEW.date is distinct from w.date or NEW.time_zone is distinct from w.tz or NEW.location is distinct from w.venue) then
        raise exception 'Main event context must match wedding context' using errcode='23514';
      end if;
      NEW.modified_at:=clock_timestamp();
      return NEW;
    end $$;
    create trigger wedding_event_guard before insert or update or delete on wedding_events
      for each row execute function guard_wedding_event();
    create trigger wedding_event_revision after insert or update or delete on wedding_events
      for each row execute function record_timeline_change();
    create function sync_main_wedding_event() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' then
        insert into wedding_events(id,wedding_id,name,kind,date,time_zone,location,is_main)
          values(gen_random_uuid(),NEW.id,'Основная программа','other',NEW.date,NEW.tz,NEW.venue,true);
      elsif NEW.date is distinct from OLD.date or NEW.tz is distinct from OLD.tz or NEW.venue is distinct from OLD.venue then
        update wedding_events set date=NEW.date,time_zone=NEW.tz,location=NEW.venue
          where wedding_id=NEW.id and is_main;
      end if;
      return NULL;
    end $$;
    create trigger wedding_main_event_created after insert on weddings
      for each row execute function sync_main_wedding_event();
    create trigger wedding_main_event_context after update of date,tz,venue on weddings
      for each row execute function sync_main_wedding_event();
    create function default_timeline_program_event() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and OLD.wedding_id is distinct from NEW.wedding_id then
        raise exception 'timeline blocks cannot move between weddings' using errcode='23514';
      end if;
      if NEW.program_event_id is null then
        select id into NEW.program_event_id from wedding_events where wedding_id=NEW.wedding_id and is_main;
      end if;
      return NEW;
    end $$;
    create trigger timeline_default_program_event before insert or update on timeline_events
      for each row execute function default_timeline_program_event();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from wedding_events where not is_main or modified_at is not null)
        or exists(select 1 from timeline_events t join wedding_events e on e.id=t.program_event_id where not e.is_main) then
        raise exception 'Cannot discard managed wedding events' using errcode='23514';
      end if;
    end $$;
    drop trigger timeline_default_program_event on timeline_events;
    drop function default_timeline_program_event();
    drop trigger wedding_main_event_created on weddings;
    drop trigger wedding_main_event_context on weddings;
    drop function sync_main_wedding_event();
    drop trigger wedding_event_revision on wedding_events;
    drop trigger wedding_event_guard on wedding_events;
    drop function guard_wedding_event();
    alter table timeline_events drop constraint timeline_program_event_fk, drop column program_event_id;
    drop table wedding_events;
  `)
}
