exports.up = pgm => {
  pgm.sql(`alter table slots add constraint order_slot_wedding_identity unique(wedding_id,id);
    alter table slots add column program_event_id uuid;
    alter table slots add constraint order_slot_event_fk foreign key(wedding_id,program_event_id)
      references wedding_events(wedding_id,id);
    create table deal_orders(
      deal_id uuid primary key, wedding_id uuid not null,
      version bigint not null default 1 check(version>0),
      schema_version smallint not null default 1 check(schema_version=1),
      source text not null default 'legacy' check(source in ('legacy','structured')),
      brief_category_id text references categories(id), brief_subtype_id text,
      brief jsonb check(brief is null or jsonb_typeof(brief)='object'),
      created_at timestamptz not null default now(), modified_at timestamptz not null default now(),
      foreign key(wedding_id,deal_id) references deals(wedding_id,id) on delete cascade,
      unique(wedding_id,deal_id),
      check((brief is null and brief_category_id is null and brief_subtype_id is null)
        or (brief is not null and brief_category_id is not null))
    );
    insert into deal_orders(deal_id,wedding_id) select id,wedding_id from deals;
    create function initialize_deal_order() returns trigger language plpgsql as $$ begin
      insert into deal_orders(deal_id,wedding_id) values(NEW.id,NEW.wedding_id);
      return NEW;
    end $$;
    create trigger initialize_deal_order after insert on deals for each row execute function initialize_deal_order();
    create table order_assignments(
      id uuid primary key, wedding_id uuid not null, deal_id uuid not null, slot_id uuid not null,
      program_event_id uuid not null, version bigint not null default 1 check(version>0),
      source text not null check(source in ('legacy','structured')),
      label text not null check(length(label) between 1 and 200),
      cancelled_at timestamptz, created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(),
      unique(wedding_id,id), unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      foreign key(wedding_id,slot_id) references slots(wedding_id,id),
      foreign key(wedding_id,program_event_id) references wedding_events(wedding_id,id)
    );
    create unique index order_assignment_live_slot on order_assignments(slot_id) where cancelled_at is null;
    create index order_assignment_deal on order_assignments(deal_id,id);
    create table order_parts(
      id uuid primary key, wedding_id uuid not null, deal_id uuid not null, assignment_id uuid,
      kind text not null check(kind in ('timed_service','supply','rental','deliverable','appointment')),
      version bigint not null default 1 check(version>0),
      source text not null check(source in ('legacy','structured')),
      title text not null check(length(title) between 1 and 200),
      details jsonb not null check(jsonb_typeof(details)='object'),
      cancelled_at timestamptz, created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default now(), modified_at timestamptz not null default now(),
      unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      foreign key(wedding_id,deal_id,assignment_id) references order_assignments(wedding_id,deal_id,id),
      check(kind='deliverable' or assignment_id is not null)
    );
    create index order_part_assignment on order_parts(assignment_id,id);
    create table event_guest_participation(
      wedding_id uuid not null, program_event_id uuid not null, guest_id uuid not null,
      status text not null check(status in ('unknown','attending','declined')),
      version bigint not null default 1 check(version>0),
      source text not null check(source in ('legacy_main_rsvp','guest_response','team_observation')),
      actor_user_id uuid references users(id) on delete set null,
      recorded_at timestamptz not null default now(),
      primary key(program_event_id,guest_id),
      foreign key(wedding_id,program_event_id) references wedding_events(wedding_id,id) on delete cascade,
      foreign key(wedding_id,guest_id) references guests(wedding_id,id) on delete cascade
    );
    insert into event_guest_participation(wedding_id,program_event_id,guest_id,status,source)
      select g.wedding_id,e.id,g.id,case g.rsvp when 'yes' then 'attending' when 'no' then 'declined' else 'unknown' end,
        'legacy_main_rsvp' from guests g join wedding_events e on e.wedding_id=g.wedding_id and e.is_main;`)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_orders where source='structured' or version<>1)
      or exists(select 1 from order_assignments) or exists(select 1 from order_parts)
      or exists(select 1 from event_guest_participation where source<>'legacy_main_rsvp' or version<>1)
      or exists(select 1 from slots where program_event_id is not null) then
      raise exception 'Cannot remove structured order or participation history';
    end if;
  end $$;
  drop table event_guest_participation,order_parts,order_assignments;
  drop trigger initialize_deal_order on deals;
  drop function initialize_deal_order();
  drop table deal_orders;
  alter table slots drop constraint order_slot_event_fk,drop column program_event_id,drop constraint order_slot_wedding_identity;`)
}
