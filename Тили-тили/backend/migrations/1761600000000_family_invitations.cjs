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

    -- A legacy +1 becomes a real second person. It intentionally starts with
    -- its own RSVP/menu/diet/seat/logistics state instead of copying the first
    -- person's choices and creating double bookings.
    INSERT INTO guests (
      id, wedding_id, name, phone, rsvp, plus_one, group_name, diet, diet_note,
      transfer, table_id, menu_option_id, rsvp_token, comment, created_at,
      invitation_id, legacy_plus_one
    )
    SELECT gen_random_uuid(), g.wedding_id, 'Гость ' || g.name, NULL,
           'pending', false, g.group_name, NULL, NULL, NULL, NULL, NULL,
           encode(gen_random_bytes(32), 'hex'), NULL, g.created_at,
           g.invitation_id, false
      FROM guests g
     WHERE g.legacy_plus_one = true;

    UPDATE guests SET plus_one = false;

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
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER IF EXISTS guests_ensure_invitation ON guests;
    DROP FUNCTION IF EXISTS ensure_guest_invitation();

    UPDATE guests g SET plus_one = true
      WHERE g.legacy_plus_one = true;

    DELETE FROM guests child
     WHERE child.legacy_plus_one = false
       AND child.name LIKE 'Гость %'
       AND EXISTS (
         SELECT 1 FROM guests parent
          WHERE parent.invitation_id = child.invitation_id
            AND parent.legacy_plus_one = true
       );

    ALTER TABLE bus_bookings DROP CONSTRAINT IF EXISTS bus_bookings_persons_range;
    ALTER TABLE bus_bookings ADD CONSTRAINT bus_bookings_persons_range CHECK (persons BETWEEN 1 AND 2);
  `)
  pgm.dropColumns('guests', ['invitation_id', 'legacy_plus_one'])
  pgm.dropTable('guest_invitations')
}
