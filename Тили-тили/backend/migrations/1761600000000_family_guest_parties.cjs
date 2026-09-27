/**
 * 020: семейное приглашение отдельно от персон.
 *
 * До этой миграции одна строка guests означала одновременно «получатель
 * ссылки» и 1–2 человека через plus_one. Из-за этого разные подсистемы
 * считали разные единицы: стол/автобус умножали строку на два, меню имело
 * один голос, hotel — одну комнату, gifts — один токен. 020 делает единицы
 * явными:
 *   - guest_parties = одно приглашение/семья (token, invite code, hotel);
 *   - guests = отдельные персоны (RSVP, menu, table, transfer, bus).
 *
 * Старый token становится token party; old plus_one=true создаёт вторую
 * person. Гостевой gift token не меняется, поэтому анонимные резервы и
 * взносы продолжают принадлежать тому же приглашению.
 */
exports.up = pgm => pgm.sql(`
  create table guest_parties (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    rsvp_token text not null unique,
    created_at timestamptz not null default now(),
    unique (id, wedding_id)
  );
  create index guest_parties_wedding_idx on guest_parties(wedding_id);

  alter table guests
    add column party_id uuid,
    add column is_primary boolean not null default false;

  /* Один старый guest = одно старое приглашение. ID party намеренно тот же:
   * это упрощает backfill FK и не меняет ни один внешний guest_id. */
  insert into guest_parties(id, wedding_id, rsvp_token, created_at)
  select id, wedding_id, rsvp_token, created_at from guests;

  update guests set party_id = id, is_primary = true;

  alter table guests
    alter column party_id set not null,
    add constraint guests_party_same_wedding
      foreign key (party_id, wedding_id)
      references guest_parties(id, wedding_id) on delete cascade;

  create unique index guests_one_primary_per_party
    on guests(party_id) where is_primary;

  /* Invitation codes теперь принадлежат party, а не конкретной person. */
  alter table guest_invite_codes add column party_id uuid;
  update guest_invite_codes c set party_id = g.party_id
    from guests g where g.id = c.guest_id;
  alter table guest_invite_codes alter column party_id set not null;
  alter table guest_invite_codes
    add constraint guest_invite_codes_party_fk
      foreign key (party_id) references guest_parties(id) on delete cascade;
  create index guest_invite_codes_party_idx
    on guest_invite_codes(party_id) where used_at is null;
  alter table guest_invite_codes drop column guest_id;

  /* Hotel — одна комната на приглашение. Старые строки 1:1 переводятся
   * через party primary person, поэтому booked физически не меняется. */
  alter table hotel_bookings add column party_id uuid;
  update hotel_bookings h set party_id = g.party_id
    from guests g where g.id = h.guest_id;
  alter table hotel_bookings alter column party_id set not null;
  alter table hotel_bookings drop constraint hotel_bookings_pk;
  alter table hotel_bookings
    add constraint hotel_bookings_party_fk
      foreign key (party_id) references guest_parties(id) on delete cascade;
  alter table hotel_bookings drop column guest_id;
  alter table hotel_bookings
    add constraint hotel_bookings_pk primary key (hotel_id, party_id);
  create index hotel_bookings_party_idx on hotel_bookings(party_id);

  /* Сопоставление old primary → новая companion живёт только внутри
   * миграции. Новая person наследует уже обещанные RSVP/table/menu/diet/
   * transfer, чтобы число мест и порций после backfill не изменилось. */
  create temporary table guest_020_companion_map (
    primary_id uuid primary key,
    companion_id uuid not null unique
  ) on commit drop;

  insert into guest_020_companion_map(primary_id, companion_id)
  select id, gen_random_uuid() from guests where plus_one = true;

  /* Token уже у party, значит person token больше не источник истины.
   * Сначала разрешаем NULL, чтобы вставить companion. */
  alter table guests alter column rsvp_token drop not null;

  insert into guests (
    id, wedding_id, name, phone, rsvp, plus_one, group_name,
    diet, diet_note, transfer, table_id, menu_option_id,
    rsvp_token, comment, created_at, party_id, is_primary
  )
  select
    m.companion_id, g.wedding_id, 'Спутник/спутница', null, g.rsvp, false, g.group_name,
    g.diet, g.diet_note, g.transfer, g.table_id, g.menu_option_id,
    null, null, g.created_at, g.party_id, false
  from guest_020_companion_map m
  join guests g on g.id = m.primary_id;

  /* Один старый голос представлял двоих — после разделения это два person
   * votes с тем же выбором. Их можно изменить независимо через новый API. */
  insert into menu_votes(guest_id, option_id, at)
  select m.companion_id, v.option_id, v.at
    from guest_020_companion_map m
    join menu_votes v on v.guest_id = m.primary_id
  on conflict (guest_id) do nothing;

  /* Автобус раньше держал persons=2 в одной booking. Теперь каждая row =
   * одна person. Вторую row создаём на том же маршруте и затем убираем
   * производный persons/plus_one механизм. */
  insert into bus_bookings(bus_id, guest_id, created_at, persons)
  select b.bus_id, m.companion_id, b.created_at, 1
    from guest_020_companion_map m
    join bus_bookings b on b.guest_id = m.primary_id
  on conflict (bus_id, guest_id) do nothing;

  update bus_bookings set persons = 1;

  drop trigger if exists guests_plus_one_seats on guests;
  drop function if exists bus_bookings_follow_plus_one();
  drop trigger if exists bus_bookings_persons on bus_bookings;
  drop function if exists bus_booking_persons();
  drop trigger if exists bus_bookings_count on bus_bookings;

  create or replace function bus_seat_counter() returns trigger as $$
  begin
    if TG_OP = 'INSERT' then
      update bus_routes set taken = taken + 1 where id = NEW.bus_id;
      return NEW;
    else
      update bus_routes set taken = taken - 1 where id = OLD.bus_id;
      return OLD;
    end if;
  end;
  $$ language plpgsql;

  create trigger bus_bookings_count
    after insert or delete on bus_bookings
    for each row execute function bus_seat_counter();

  update bus_routes r set taken =
    (select count(*) from bus_bookings b where b.bus_id = r.id);

  alter table bus_bookings drop constraint if exists bus_bookings_persons_range;
  alter table bus_bookings drop column persons;

  /* Gift reserve cleanup переезжает с guest token на party token. Деньги
   * contribution не удаляются, как и прежде; удаляется только живой reserve. */
  drop trigger if exists guests_release_reservations on guests;
  drop function if exists release_guest_reservations();

  create function release_guest_party_reservations() returns trigger as $$
  begin
    delete from gift_reservations r using gifts g
     where r.gift_id = g.id
       and g.wedding_id = OLD.wedding_id
       and r.guest_token = OLD.rsvp_token;
    return OLD;
  end;
  $$ language plpgsql;

  create trigger guest_parties_release_reservations
    after delete or update of rsvp_token on guest_parties
    for each row execute function release_guest_party_reservations();

  /* После backfill семантика plus_one/token физически удаляется с person. */
  alter table guests drop column plus_one;
  alter table guests drop column rsvp_token;
`);

exports.down = () => {
  throw new Error('020 guest-party migration is intentionally irreversible: split persons can diverge after rollout');
};
