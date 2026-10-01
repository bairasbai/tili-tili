exports.up = pgm => {
  pgm.sql(`
    alter table guests add constraint guests_event_wedding_id_unique unique(wedding_id,id);
    create table guest_event_invitations (
      wedding_id uuid not null references weddings(id) on delete cascade,
      event_id uuid not null,
      guest_id uuid not null,
      primary key(event_id,guest_id),
      foreign key(wedding_id,event_id) references wedding_events(wedding_id,id) deferrable initially deferred,
      foreign key(wedding_id,guest_id) references guests(wedding_id,id) on delete cascade
    );
    create index guest_event_invitation_person on guest_event_invitations(wedding_id,guest_id,event_id);
    create function guard_guest_event_invitation() returns trigger language plpgsql as $$
    declare target uuid;
    begin
      if TG_OP='DELETE' then target:=OLD.wedding_id; else target:=NEW.wedding_id; end if;
      perform id from weddings where id=target for update;
      if TG_OP='DELETE' then return OLD; end if;
      if TG_OP='UPDATE' and (OLD.wedding_id,OLD.event_id,OLD.guest_id) is distinct from (NEW.wedding_id,NEW.event_id,NEW.guest_id) then
        raise exception 'Invitation identity cannot change' using errcode='23514';
      end if;
      if exists(select 1 from wedding_events where wedding_id=NEW.wedding_id and id=NEW.event_id and is_main) then
        raise exception 'Main event uses existing guest invitation' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger guest_event_invitation_guard before insert or update or delete on guest_event_invitations
      for each row execute function guard_guest_event_invitation();
    create trigger guest_event_invitation_revision after insert or update or delete on guest_event_invitations
      for each row execute function record_timeline_change();
  `)
}

exports.down = pgm => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from guest_event_invitations) then
        raise exception 'Refusing rollback with individual event invitations';
      end if;
    end $$;
    drop table guest_event_invitations;
    drop function guard_guest_event_invitation();
    alter table guests drop constraint guests_event_wedding_id_unique;
  `)
}
