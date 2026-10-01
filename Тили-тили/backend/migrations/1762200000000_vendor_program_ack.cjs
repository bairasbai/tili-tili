exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE vendor_program_acknowledgments (
      wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
      vendor_id uuid NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id uuid REFERENCES sessions(id) ON DELETE SET NULL,
      version bigint NOT NULL CHECK (version >= 0),
      digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
      program_snapshot jsonb NOT NULL CHECK (jsonb_typeof(program_snapshot) = 'object'),
      acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (wedding_id, vendor_id, user_id, version, digest)
    );
    CREATE INDEX vendor_program_ack_by_vendor ON vendor_program_acknowledgments(vendor_id,wedding_id);
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM vendor_program_acknowledgments) THEN
        RAISE EXCEPTION 'Cannot remove recorded vendor program acknowledgments';
      END IF;
    END $$;
    DROP TABLE vendor_program_acknowledgments;
  `)
}
