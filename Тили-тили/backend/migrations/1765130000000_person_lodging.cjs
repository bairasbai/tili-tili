exports.up = (pgm) => pgm.sql(`
  alter table hotel_blocks add constraint lodging_hotel_scope unique(wedding_id,id);

  create table lodging_rooms (
    wedding_id uuid not null,
    id uuid not null,
    hotel_id uuid not null,
    label text not null check (length(btrim(label)) between 1 and 120),
    capacity integer not null check (capacity between 1 and 500),
    legacy_guest_id uuid,
    version integer not null default 1 check (version > 0),
    primary key (wedding_id,id),
    foreign key (wedding_id,hotel_id) references hotel_blocks(wedding_id,id) on delete cascade,
    foreign key (hotel_id,legacy_guest_id) references hotel_bookings(hotel_id,guest_id)
      on delete set null (legacy_guest_id),
    constraint lodging_room_label_unique unique(hotel_id,label),
    constraint lodging_room_legacy_unique unique(hotel_id,legacy_guest_id)
  );

  create table lodging_placements (
    wedding_id uuid not null,
    id uuid not null,
    room_id uuid not null,
    guest_id uuid not null,
    check_in date not null,
    check_out date not null,
    responsible_id uuid,
    source text not null check (source in ('organizer','guest','hotel')),
    version integer not null default 1 check (version > 0),
    primary key (wedding_id,id),
    foreign key (wedding_id,room_id) references lodging_rooms(wedding_id,id) on delete cascade,
    foreign key (wedding_id,guest_id) references guests(wedding_id,id) on delete cascade,
    foreign key (wedding_id,responsible_id) references wedding_members(wedding_id,user_id)
      on delete set null (responsible_id),
    check (check_in < check_out),
    constraint lodging_guest_no_overlap exclude using gist
      (wedding_id with =,guest_id with =,daterange(check_in,check_out,'[)') with &&)
  );
  create index lodging_placements_room on lodging_placements(wedding_id,room_id);

  create function lodging_inventory_used(block_id uuid) returns integer language sql stable as $$
    select ((select count(*) from lodging_rooms r where r.hotel_id=block_id)
         + (select count(*) from hotel_bookings b where b.hotel_id=block_id and not exists
             (select from lodging_rooms r where r.hotel_id=b.hotel_id and r.legacy_guest_id=b.guest_id)))::integer;
  $$;

  create function check_lodging_inventory(target_hotel uuid) returns void language plpgsql as $$
  declare room_limit integer;
  begin
    -- Update the shared row so even a repeatable-read writer must retry on a concurrent change.
    update hotel_blocks set booked=booked where id=target_hotel returning rooms into room_limit;
    if found and lodging_inventory_used(target_hotel)>room_limit then
      raise check_violation using message='Hotel inventory exceeded', constraint='hotel_inventory_bounded';
    end if;
  end;
  $$;

  create function check_lodging_inventory_child() returns trigger language plpgsql as $$
  begin
    perform check_lodging_inventory(new.hotel_id);
    return new;
  end;
  $$;
  create trigger hotel_bookings_inventory after insert on hotel_bookings
    for each row execute function check_lodging_inventory_child();
  create trigger lodging_rooms_inventory after insert or update of hotel_id,legacy_guest_id on lodging_rooms
    for each row execute function check_lodging_inventory_child();

  create function check_lodging_inventory_block() returns trigger language plpgsql as $$
  begin
    if lodging_inventory_used(new.id)>new.rooms then
      raise check_violation using message='Hotel inventory exceeded', constraint='hotel_inventory_bounded';
    end if;
    return new;
  end;
  $$;
  create trigger hotel_blocks_inventory after update of rooms on hotel_blocks
    for each row execute function check_lodging_inventory_block();

  create function check_lodging_room_capacity(target_wedding uuid,target_room uuid) returns void language plpgsql as $$
  declare room_limit integer;
  begin
    update lodging_rooms set version=version where wedding_id=target_wedding and id=target_room
      returning capacity into room_limit;
    if not found then return; end if;
    if exists (
      select from (
        select sum(sum(delta)) over (order by day) as people from (
          select check_in as day,1 as delta from lodging_placements
            where wedding_id=target_wedding and room_id=target_room
          union all
          select check_out,-1 from lodging_placements
            where wedding_id=target_wedding and room_id=target_room
        ) changes group by day
      ) occupancy where people>room_limit
    ) then
      raise check_violation using message='Room capacity exceeded', constraint='lodging_room_capacity';
    end if;
  end;
  $$;

  create function check_lodging_capacity() returns trigger language plpgsql as $$
  begin
    if tg_table_name='lodging_rooms' then
      perform check_lodging_room_capacity(new.wedding_id,new.id);
    else
      perform check_lodging_room_capacity(new.wedding_id,new.room_id);
    end if;
    return new;
  end;
  $$;
  create trigger lodging_rooms_capacity after update of capacity on lodging_rooms
    for each row execute function check_lodging_capacity();
  create trigger lodging_placements_capacity after insert or update of room_id,check_in,check_out on lodging_placements
    for each row execute function check_lodging_capacity();
`)

exports.down = (pgm) => pgm.sql(`
  do $$ begin
    if exists(select from lodging_rooms) then
      raise exception 'Cannot remove the lodging schema while it contains rooms';
    end if;
  end $$;
  drop trigger hotel_bookings_inventory on hotel_bookings;
  drop trigger hotel_blocks_inventory on hotel_blocks;
  drop table lodging_placements;
  drop table lodging_rooms;
  drop function check_lodging_capacity();
  drop function check_lodging_room_capacity(uuid,uuid);
  drop function check_lodging_inventory_block();
  drop function check_lodging_inventory_child();
  drop function check_lodging_inventory(uuid);
  drop function lodging_inventory_used(uuid);
  alter table hotel_blocks drop constraint lodging_hotel_scope;
`)
