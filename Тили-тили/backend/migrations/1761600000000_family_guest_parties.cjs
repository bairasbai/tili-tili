/**
 * 020: family invitations and separate guest persons.
 *
 * One invitation (guest_parties) can contain multiple people (guests).
 * The existing guest token becomes the party token so old links and gift
 * identity survive the migration. Legacy plus_one rows are expanded into a
 * real second person in the same party; the old boolean is then cleared.
 *
 * Resource cardinality after 020:
 *   - table/menu/bus: person (guest_id)
 *   - hotel/gifts: invitation/family (party/token)
 */
exports.up = (pgm) => {
  pgm.createTable('guest_parties', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    invite_token: { type: 'text', notNull: true, unique: true },
    label: { type: 'text' },
    contact_phone: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.addConstraint(
    'guest_parties',
    'guest_parties_label_valid',
    "CHECK (label IS NULL OR length(btrim(label)) BETWEEN 1 AND 120)",
  )
  pgm.createIndex('guest_parties', ['wedding_id', 'created_at'])

  pgm.addColumns('guests', {
    party_id: { type: 'uuid', references: 'guest_parties', onDelete: 'CASCADE' },
    party_position: { type: 'smallint', notNull: true, default: 1 },
    is_placeholder: { type: 'boolean', notNull: true, default: false },
  })
  pgm.addConstraint('guests', 'guests_party_position_range', 'CHECK (party_position BETWEEN 1 AND 10)')

  /* Compatibility door for old fixtures/workers during the rollout.
   * Any legacy INSERT that only knows guests creates a one-person party in
   * the same statement. New 020 paths pass party_id explicitly and skip it. */
  pgm.sql(`
    CREATE FUNCTION guest_party_for_legacy_insert() RETURNS trigger AS $family020$
    DECLARE
      new_party_id uuid;
    BEGIN
      IF NEW.party_id IS NULL THEN
        new_party_id := gen_random_uuid();
        INSERT INTO guest_parties (id, wedding_id, invite_token, label, contact_phone, created_at)
        VALUES (new_party_id, NEW.wedding_id, NEW.rsvp_token, NEW.name, NEW.phone, coalesce(NEW.created_at, now()));
        NEW.party_id := new_party_id;
        NEW.party_position := 1;
      END IF;
      RETURN NEW;
    END;
    $family020$ LANGUAGE plpgsql;

    CREATE TRIGGER guests_legacy_party
      BEFORE INSERT ON guests
      FOR EACH ROW EXECUTE FUNCTION guest_party_for_legacy_insert();
  `)

  pgm.sql(`
    INSERT INTO guest_parties (id, wedding_id, invite_token, label, contact_phone, created_at)
    SELECT gen_random_uuid(), g.wedding_id, g.rsvp_token, g.name, g.phone, g.created_at
      FROM guests g;

    UPDATE guests g
       SET party_id = p.id,
           party_position = 1
      FROM guest_parties p
     WHERE p.wedding_id = g.wedding_id
       AND p.invite_token = g.rsvp_token;

    CREATE TEMP TABLE family020_companions (
      original_id uuid PRIMARY KEY,
      companion_id uuid NOT NULL,
      party_id uuid NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO family020_companions (original_id, companion_id, party_id)
    SELECT g.id, gen_random_uuid(), g.party_id
      FROM guests g
     WHERE g.plus_one = true;

    INSERT INTO guests (
      id, wedding_id, name, phone, rsvp, plus_one, group_name, diet, diet_note,
      transfer, table_id, menu_option_id, rsvp_token, comment, created_at,
      party_id, party_position, is_placeholder
    )
    SELECT c.companion_id,
           g.wedding_id,
           'Спутник ' || g.name,
           NULL,
           g.rsvp,
           false,
           g.group_name,
           g.diet,
           g.diet_note,
           g.transfer,
           g.table_id,
           g.menu_option_id,
           'family020-' || replace(gen_random_uuid()::text, '-', ''),
           NULL,
           g.created_at + interval '1 microsecond',
           g.party_id,
           2,
           true
      FROM family020_companions c
      JOIN guests g ON g.id = c.original_id;

    /* Existing menu choice represented the whole old +1 row. Duplicate it
     * for the migrated second person so the new per-person tally preserves
     * the old intent until the family changes either choice. */
    INSERT INTO menu_votes (guest_id, option_id, at)
    SELECT c.companion_id, v.option_id, v.at
      FROM family020_companions c
      JOIN menu_votes v ON v.guest_id = c.original_id
    ON CONFLICT (guest_id) DO NOTHING;

    /* Turning plus_one off first converts an existing bus booking 2 -> 1
     * through the current trigger. Inserting the companion adds the second
     * 1-seat booking, keeping route.taken unchanged. */
    UPDATE guests g
       SET plus_one = false
      FROM family020_companions c
     WHERE g.id = c.original_id;

    INSERT INTO bus_bookings (bus_id, guest_id)
    SELECT b.bus_id, c.companion_id
      FROM family020_companions c
      JOIN bus_bookings b ON b.guest_id = c.original_id
    ON CONFLICT DO NOTHING;

    /* A hotel row is a room, not a person. party_id marks that ownership and
     * a partial unique index prevents the two people of one invitation from
     * consuming two rows in the same hotel by accident. Existing code can
     * keep inserting guest_id during the compatibility phase; the trigger
     * derives party_id from that person. */
  `)

  pgm.addColumns('guest_invite_codes', {
    party_id: { type: 'uuid', references: 'guest_parties', onDelete: 'CASCADE' },
  })
  pgm.sql(`
    UPDATE guest_invite_codes c
       SET party_id = g.party_id
      FROM guests g
     WHERE g.id = c.guest_id;
  `)
  pgm.createIndex('guest_invite_codes', 'party_id')

  pgm.addColumns('hotel_bookings', {
    party_id: { type: 'uuid', references: 'guest_parties', onDelete: 'CASCADE' },
  })
  pgm.sql(`
    UPDATE hotel_bookings b
       SET party_id = g.party_id
      FROM guests g
     WHERE g.id = b.guest_id;

    CREATE UNIQUE INDEX hotel_bookings_hotel_party_unique
      ON hotel_bookings(hotel_id, party_id)
      WHERE party_id IS NOT NULL;

    CREATE FUNCTION hotel_booking_party_from_guest() RETURNS trigger AS $$
    BEGIN
      IF NEW.party_id IS NULL AND NEW.guest_id IS NOT NULL THEN
        SELECT party_id INTO NEW.party_id FROM guests WHERE id = NEW.guest_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER hotel_bookings_party
      BEFORE INSERT OR UPDATE OF guest_id, party_id ON hotel_bookings
      FOR EACH ROW EXECUTE FUNCTION hotel_booking_party_from_guest();
  `)

  /* Gift reservations/contributions remain keyed by text token. Move the
   * lifecycle trigger from one person to the family invitation: deleting or
   * renaming a member must not silently release the family's gift. */
  pgm.sql(`
    DROP TRIGGER IF EXISTS guests_release_reservations ON guests;
    DROP FUNCTION IF EXISTS release_guest_reservations();

    CREATE FUNCTION release_party_reservations() RETURNS trigger AS $$
    BEGIN
      DELETE FROM gift_reservations r USING gifts g
       WHERE r.gift_id = g.id
         AND g.wedding_id = OLD.wedding_id
         AND r.guest_token = OLD.invite_token;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guest_parties_release_reservations
      AFTER DELETE OR UPDATE OF invite_token ON guest_parties
      FOR EACH ROW EXECUTE FUNCTION release_party_reservations();
  `)

  pgm.alterColumn('guests', 'party_id', { notNull: true })
  pgm.createIndex('guests', ['party_id', 'party_position'], { unique: true })
  pgm.createIndex('guests', 'party_id')
}

exports.down = (pgm) => {
  /* Rollback collapses migrated placeholder companions back to legacy +1.
   * A non-placeholder family created after 020 cannot be represented by the
   * old model without data loss, so only generated migration companions are
   * collapsed automatically. */
  pgm.sql(`
    DROP TRIGGER IF EXISTS guests_legacy_party ON guests;
    DROP FUNCTION IF EXISTS guest_party_for_legacy_insert();

    UPDATE guests primary_guest
       SET plus_one = true
      FROM guests companion
     WHERE companion.party_id = primary_guest.party_id
       AND primary_guest.party_position = 1
       AND companion.party_position = 2
       AND companion.is_placeholder = true;

    DELETE FROM guests
     WHERE party_position = 2 AND is_placeholder = true;

    DROP TRIGGER IF EXISTS guest_parties_release_reservations ON guest_parties;
    DROP FUNCTION IF EXISTS release_party_reservations();

    CREATE FUNCTION release_guest_reservations() RETURNS trigger AS $$
    BEGIN
      DELETE FROM gift_reservations r USING gifts g
       WHERE r.gift_id = g.id
         AND g.wedding_id = OLD.wedding_id
         AND r.guest_token = OLD.rsvp_token;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guests_release_reservations
      AFTER DELETE OR UPDATE OF rsvp_token ON guests
      FOR EACH ROW EXECUTE FUNCTION release_guest_reservations();

    DROP TRIGGER IF EXISTS hotel_bookings_party ON hotel_bookings;
    DROP FUNCTION IF EXISTS hotel_booking_party_from_guest();
    DROP INDEX IF EXISTS hotel_bookings_hotel_party_unique;
  `)

  pgm.dropColumns('hotel_bookings', ['party_id'])
  pgm.dropIndex('guest_invite_codes', 'party_id')
  pgm.dropColumns('guest_invite_codes', ['party_id'])
  pgm.dropIndex('guests', 'party_id')
  pgm.dropIndex('guests', ['party_id', 'party_position'], { unique: true })
  pgm.dropConstraint('guests', 'guests_party_position_range')
  pgm.dropColumns('guests', ['party_id', 'party_position', 'is_placeholder'])
  pgm.dropTable('guest_parties')
}
