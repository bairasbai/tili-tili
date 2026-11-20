exports.up = pgm => pgm.sql(`
  alter table bus_routes
    add column program_event_id uuid,
    add column direction text not null default 'outbound' check(direction in ('outbound','return')),
    add column departure_date date,
    add column destination text check(length(destination)<=300),
    add column stops text[] not null default '{}' check(cardinality(stops)<=12),
    add column public_contact text check(length(public_contact)<=160),
    add constraint bus_route_event_fk foreign key(wedding_id,program_event_id)
      references wedding_events(wedding_id,id) deferrable initially deferred;
  create index bus_routes_event_direction on bus_routes(wedding_id,program_event_id,direction);
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists(select 1 from bus_routes where program_event_id is not null or direction<>'outbound'
      or departure_date is not null or destination is not null or cardinality(stops)>0 or public_contact is not null) then
      raise exception using errcode='23514', message='shuttle_trips_rollback_preserves_routes';
    end if;
  end $$;
  drop index bus_routes_event_direction;
  alter table bus_routes drop constraint bus_route_event_fk, drop column program_event_id, drop column direction,
    drop column departure_date, drop column destination, drop column stops, drop column public_contact;
`)
