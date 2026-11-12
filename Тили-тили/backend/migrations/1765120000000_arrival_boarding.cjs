exports.up = pgm => pgm.sql(`
  alter table wedding_events add column arrival jsonb,
    add constraint wedding_event_arrival_valid check (
      arrival is null or (
        jsonb_typeof(arrival)='object'
        and arrival ?& array['entrance','parking','accessibleRoute']
        and arrival - array['entrance','parking','accessibleRoute']='{}'::jsonb
        and jsonb_typeof(arrival->'entrance') in ('null','string')
        and jsonb_typeof(arrival->'parking') in ('null','string')
        and jsonb_typeof(arrival->'accessibleRoute') in ('null','string')
        and (arrival->>'entrance' is null or length(btrim(arrival->>'entrance')) between 1 and 300)
        and (arrival->>'parking' is null or length(btrim(arrival->>'parking')) between 1 and 300)
        and (arrival->>'accessibleRoute' is null or length(btrim(arrival->>'accessibleRoute')) between 1 and 600)
        and (arrival->>'entrance' is not null or arrival->>'parking' is not null or arrival->>'accessibleRoute' is not null)
      )
    );
  create table shuttle_pickup_notices (
    wedding_id uuid not null references weddings(id) on delete cascade,
    change_id uuid not null,
    guest_id uuid not null,
    bus_id uuid,
    program_event_id uuid,
    route_label text not null,
    event_label text,
    previous_pickup text,
    pickup text,
    created_at timestamptz not null default clock_timestamp(),
    primary key(wedding_id,change_id,guest_id),
    foreign key(wedding_id,guest_id) references guests(wedding_id,id) on delete cascade,
    foreign key(wedding_id,bus_id) references bus_routes(wedding_id,id) on delete set null (bus_id),
    check(previous_pickup is distinct from pickup)
  );
  create index shuttle_pickup_notices_guest on shuttle_pickup_notices(wedding_id,guest_id,created_at desc);
  create index shuttle_pickup_notices_route on shuttle_pickup_notices(wedding_id,bus_id) where bus_id is not null;
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists(select 1 from shuttle_pickup_notices) or exists(select 1 from wedding_events where arrival is not null) then
      raise exception using errcode='23514', message='arrival_boarding_rollback_preserves_history';
    end if;
  end $$;
  drop table shuttle_pickup_notices;
  alter table wedding_events drop constraint wedding_event_arrival_valid, drop column arrival;
`)
