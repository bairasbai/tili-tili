/**
 * 020 / family invitations: one invited person = one guests row.
 *
 * This migration is intentionally additive first. Legacy APIs may still expose
 * plusOne while 020 is being rolled out, but counters stop treating the flag as
 * an invisible second person once the application switches to invitations.
 */
exports.up = (pgm) => {
  pgm.createTable('guest_invitations', {
    id: { type: 'uuid', primaryKey: true },
    wedding_id: { type: 'uuid', notNull: true, references: 'weddings', onDelete: 'CASCADE' },
    label: { type: 'text' },
    phone: { type: 'text' },
    rsvp_token: { type: 'text', notNull: true, unique: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  })
  pgm.createIndex('guest_invitations', ['wedding_id', 'created_at'])

  pgm.addColumns('guests', {
    invitation_id: { type: 'uuid', references: 'guest_invitations', onDelete: 'CASCADE' },
    legacy_plus_one: { type: 'boolean', notNull: true, default: false },
    migrated_plus_one_companion: { type: 'boolean', notNull: true, default: false },
  })
  pgm.addColumns('guest_invite_codes', {
    invitation_id: { type: 'uuid', references: 'guest_invitations', onDelete: 'CASCADE' },
  })

  /* Compatibility bridge while API/UI are migrated in this same feature.
   * Old insert paths still write guests directly. A BEFORE INSERT trigger
   * creates the one-person invitation atomically so NOT NULL never breaks
   * existing flows. New family API supplies invitation_id explicitly. */
  pgm.sql(`
    CREATE FUNCTION ensure_guest_invitation() RETURNS trigger AS $$
    DECLARE
      invite_id uuid;
      invite_token text;
    BEGIN
      IF NEW.invitation_id IS NOT NULL THEN
        RETURN NEW;
      END IF;
      invite_id := NEW.id;
      invite_token := coalesce(NEW.rsvp_token, encode(gen_random_bytes(32), 'hex'));
      INSERT INTO guest_invitations (id, wedding_id, label, phone, rsvp_token, created_at)
      VALUES (invite_id, NEW.wedding_id, NEW.name, NEW.phone, invite_token, coalesce(NEW.created_at, now()));
      NEW.invitation_id := invite_id;
      NEW.rsvp_token := invite_token;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guests_ensure_invitation
      BEFORE INSERT ON guests
      FOR EACH ROW EXECUTE FUNCTION ensure_guest_invitation();
  `)

  pgm.sql(`
    -- Existing one-person invitations become one invitation with one person.
    INSERT INTO guest_invitations (id, wedding_id, label, phone, rsvp_token, created_at)
    SELECT id, wedding_id, name, phone, rsvp_token, created_at
      FROM guests;

    UPDATE guests
       SET invitation_id = id,
           legacy_plus_one = plus_one;

    ALTER TABLE guests ALTER COLUMN invitation_id SET NOT NULL;

    UPDATE guest_invite_codes c
       SET invitation_id = g.invitation_id
      FROM guests g
     WHERE g.id = c.guest_id;
    ALTER TABLE guest_invite_codes ALTER COLUMN invitation_id SET NOT NULL;
    CREATE INDEX guest_invite_codes_invitation_idx
      ON guest_invite_codes(invitation_id);

    -- A legacy +1 becomes a real second person. It intentionally starts with
    -- its own RSVP/menu/diet/seat/logistics state instead of copying the first
    -- person's choices and creating double bookings.
    INSERT INTO guests (
      id, wedding_id, name, phone, rsvp, plus_one, group_name, diet, diet_note,
      transfer, table_id, menu_option_id, rsvp_token, comment, created_at,
      invitation_id, legacy_plus_one, migrated_plus_one_companion
    )
    SELECT gen_random_uuid(), g.wedding_id, 'Гость ' || g.name, NULL,
           'pending', false, g.group_name, NULL, NULL, NULL, NULL, NULL,
           encode(gen_random_bytes(32), 'hex'), NULL, g.created_at,
           g.invitation_id, false, true
      FROM guests g
     WHERE g.legacy_plus_one = true;

    UPDATE guests SET plus_one = false;
    ALTER TABLE guests ADD CONSTRAINT guests_plus_one_disabled CHECK (plus_one = false);

    -- From 020 onward each bus booking is exactly one person/seat.
    DROP TRIGGER IF EXISTS guests_plus_one_seats ON guests;
    DROP FUNCTION IF EXISTS bus_bookings_follow_plus_one();
    DROP TRIGGER IF EXISTS bus_bookings_persons ON bus_bookings;
    DROP FUNCTION IF EXISTS bus_booking_persons();

    UPDATE bus_bookings SET persons = 1;
    ALTER TABLE bus_bookings DROP CONSTRAINT IF EXISTS bus_bookings_persons_range;
    ALTER TABLE bus_bookings ADD CONSTRAINT bus_bookings_persons_range CHECK (persons = 1);

    CREATE OR REPLACE FUNCTION bus_seat_counter() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE bus_routes SET taken = taken + 1 WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        RETURN NEW;
      ELSE
        UPDATE bus_routes SET taken = taken - 1 WHERE id = OLD.bus_id;
        RETURN OLD;
      END IF;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS bus_bookings_count ON bus_bookings;
    CREATE TRIGGER bus_bookings_count
      AFTER INSERT OR DELETE ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_seat_counter();

    UPDATE bus_routes r SET taken = coalesce(
      (SELECT count(*) FROM bus_bookings b WHERE b.bus_id = r.id), 0);

    /* Gift reservation ownership follows the invitation session from 020.
     * Rotating/deleting that shared token must release anonymous whole-gift
     * reservations exactly like legacy guest-token rotation did. */
    CREATE FUNCTION release_invitation_reservations() RETURNS trigger AS $$
    BEGIN
      DELETE FROM gift_reservations r USING gifts g
       WHERE r.gift_id = g.id
         AND g.wedding_id = OLD.wedding_id
         AND r.guest_token = OLD.rsvp_token;
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER guest_invitations_release_reservations
      AFTER DELETE OR UPDATE OF rsvp_token ON guest_invitations
      FOR EACH ROW EXECUTE FUNCTION release_invitation_reservations();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS guest_invitations_release_reservations ON guest_invitations;
    DROP FUNCTION IF EXISTS release_invitation_reservations();
    DROP TRIGGER IF EXISTS guests_ensure_invitation ON guests;
    DROP FUNCTION IF EXISTS ensure_guest_invitation();
    ALTER TABLE guests DROP CONSTRAINT IF EXISTS guests_plus_one_disabled;

    UPDATE guests SET plus_one = true
      WHERE legacy_plus_one = true;

    DELETE FROM guests
      WHERE migrated_plus_one_companion = true;

    /* Restore the exact pre-020 bus invariant from migration 175930…:
     * one legacy guest row may represent one or two people. */
    DROP TRIGGER IF EXISTS bus_bookings_count ON bus_bookings;

    CREATE FUNCTION bus_booking_persons() RETURNS trigger AS $
    BEGIN
      SELECT 1 + plus_one::int INTO NEW.persons FROM guests WHERE id = NEW.guest_id;
      NEW.persons := coalesce(NEW.persons, 1);
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;

    CREATE TRIGGER bus_bookings_persons
      BEFORE INSERT ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_booking_persons();

    CREATE OR REPLACE FUNCTION bus_seat_counter() RETURNS trigger AS $
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE bus_routes SET taken = taken + NEW.persons WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSIF TG_OP = 'UPDATE' THEN
        UPDATE bus_routes SET taken = taken + (NEW.persons - OLD.persons) WHERE id = NEW.bus_id;
        RETURN NEW;
      ELSE
        UPDATE bus_routes SET taken = taken - OLD.persons WHERE id = OLD.bus_id;
        RETURN OLD;
      END IF;
    END;
    $ LANGUAGE plpgsql;

    CREATE TRIGGER bus_bookings_count
      AFTER INSERT OR DELETE OR UPDATE OF persons ON bus_bookings
      FOR EACH ROW EXECUTE FUNCTION bus_seat_counter();

    CREATE FUNCTION bus_bookings_follow_plus_one() RETURNS trigger AS $
    BEGIN
      UPDATE bus_bookings SET persons = 1 + NEW.plus_one::int WHERE guest_id = NEW.id;
      RETURN NEW;
    END;
    $ LANGUAGE plpgsql;

    CREATE TRIGGER guests_plus_one_seats
      AFTER UPDATE OF plus_one ON guests
      FOR EACH ROW WHEN (OLD.plus_one IS DISTINCT FROM NEW.plus_one)
      EXECUTE FUNCTION bus_bookings_follow_plus_one();

    UPDATE bus_bookings b SET persons = 1 + g.plus_one::int
      FROM guests g WHERE g.id = b.guest_id;

    ALTER TABLE bus_bookings DROP CONSTRAINT IF EXISTS bus_bookings_persons_range;
    ALTER TABLE bus_bookings ADD CONSTRAINT bus_bookings_persons_range CHECK (persons BETWEEN 1 AND 2);

    UPDATE bus_routes r SET taken = coalesce(
      (SELECT sum(b.persons) FROM bus_bookings b WHERE b.bus_id = r.id), 0);
  `)
  pgm.dropColumns('guest_invite_codes', ['invitation_id'])
  pgm.dropColumns('guests', ['invitation_id', 'legacy_plus_one', 'migrated_plus_one_companion'])
  pgm.dropTable('guest_invitations')
}
