exports.up = pgm => pgm.sql(`
  alter table bus_routes add constraint bus_routes_wedding_id_unique unique(wedding_id,id),
    add column deadline_on date,
    add column replacement_contact text,
    add column replacement_instructions text,
    add constraint bus_replacement_complete check(
      (replacement_contact is null and replacement_instructions is null) or
      (replacement_contact is not null and replacement_instructions is not null
        and length(btrim(replacement_contact)) between 1 and 160
        and length(btrim(replacement_instructions)) between 1 and 1000)
    );
  create table shuttle_change_requests (
    wedding_id uuid not null references weddings(id) on delete cascade,
    id uuid not null,
    guest_id uuid not null,
    program_event_id uuid,
    from_bus_id uuid,
    to_bus_id uuid,
    from_label text not null,
    to_label text not null,
    status text not null default 'pending' check(status in ('pending','approved','declined','withdrawn')),
    created_at timestamptz not null default now(),
    resolved_at timestamptz,
    resolved_by uuid references users(id) on delete set null,
    primary key(wedding_id,id),
    foreign key(wedding_id,guest_id) references guests(wedding_id,id) on delete cascade,
    foreign key(wedding_id,from_bus_id) references bus_routes(wedding_id,id) on delete set null (from_bus_id),
    foreign key(wedding_id,to_bus_id) references bus_routes(wedding_id,id) on delete set null (to_bus_id),
    check(from_bus_id is distinct from to_bus_id or from_bus_id is null),
    check((status='pending' and resolved_at is null and from_bus_id is not null and to_bus_id is not null)
      or (status<>'pending' and resolved_at is not null))
  );
  create unique index shuttle_change_one_pending on shuttle_change_requests(wedding_id,guest_id,from_bus_id) where status='pending';
  create index shuttle_change_source on shuttle_change_requests(wedding_id,from_bus_id);
  create index shuttle_change_destination on shuttle_change_requests(wedding_id,to_bus_id);
  create index shuttle_change_guest on shuttle_change_requests(wedding_id,guest_id,created_at desc);

  create function withdraw_shuttle_change_on_route_loss() returns trigger language plpgsql as $$
  begin
    if new.status='pending' and (new.from_bus_id is null or new.to_bus_id is null) then
      new.status := 'withdrawn';
      new.resolved_at := clock_timestamp();
    end if;
    return new;
  end $$;
  create trigger shuttle_change_route_loss before update of from_bus_id,to_bus_id on shuttle_change_requests
    for each row execute function withdraw_shuttle_change_on_route_loss();

  create function withdraw_shuttle_changes_on_seat_loss() returns trigger language plpgsql as $$
  begin
    update shuttle_change_requests q set status='withdrawn',resolved_at=clock_timestamp()
      where q.from_bus_id=old.bus_id and q.guest_id=old.guest_id and q.status='pending';
    return old;
  end $$;
  create trigger shuttle_change_seat_loss after delete on bus_bookings
    for each row execute function withdraw_shuttle_changes_on_seat_loss();

  create function release_shuttle_seats_on_invitation_loss() returns trigger language plpgsql as $$
  begin
    delete from bus_bookings b using bus_routes r where b.bus_id=r.id and b.guest_id=old.guest_id
      and r.wedding_id=old.wedding_id and r.program_event_id=old.event_id;
    return old;
  end $$;
  create trigger shuttle_invitation_loss after delete on guest_event_invitations
    for each row execute function release_shuttle_seats_on_invitation_loss();
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists(select 1 from shuttle_change_requests)
      or exists(select 1 from bus_routes where deadline_on is not null or replacement_contact is not null) then
      raise exception using errcode='23514', message='shuttle_changes_rollback_preserves_history';
    end if;
  end $$;
  drop trigger shuttle_invitation_loss on guest_event_invitations;
  drop function release_shuttle_seats_on_invitation_loss();
  drop trigger shuttle_change_seat_loss on bus_bookings;
  drop function withdraw_shuttle_changes_on_seat_loss();
  drop table shuttle_change_requests;
  drop function withdraw_shuttle_change_on_route_loss();
  alter table bus_routes drop constraint bus_replacement_complete, drop constraint bus_routes_wedding_id_unique,
    drop column deadline_on, drop column replacement_contact, drop column replacement_instructions;
`)
