exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE external_invites
      ADD COLUMN program_identity uuid NOT NULL DEFAULT gen_random_uuid(),
      ADD COLUMN program_deal_id uuid,
      ADD CONSTRAINT external_invites_program_identity UNIQUE (wedding_id,program_identity),
      ADD CONSTRAINT external_invites_program_binding UNIQUE (wedding_id,program_identity,program_deal_id),
      ADD CONSTRAINT external_invites_program_deal FOREIGN KEY (wedding_id,program_deal_id)
        REFERENCES deals(wedding_id,id) ON DELETE CASCADE;
    -- Existing links have no verified issuance-time deal binding. Do not guess it.
    CREATE TABLE external_program_acknowledgments (
      wedding_id uuid NOT NULL,
      invite_id uuid NOT NULL,
      deal_id uuid NOT NULL,
      version bigint NOT NULL CHECK (version>=0),
      digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
      program_snapshot jsonb NOT NULL CHECK (jsonb_typeof(program_snapshot)='object'),
      acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (wedding_id,invite_id,deal_id,version,digest),
      FOREIGN KEY (wedding_id,invite_id,deal_id)
        REFERENCES external_invites(wedding_id,program_identity,program_deal_id) ON DELETE CASCADE,
      FOREIGN KEY (wedding_id,deal_id) REFERENCES deals(wedding_id,id) ON DELETE CASCADE
    );
    CREATE INDEX external_program_ack_by_deal ON external_program_acknowledgments(wedding_id,deal_id,acknowledged_at DESC);
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM external_program_acknowledgments) THEN
        RAISE EXCEPTION 'Cannot remove recorded external program acknowledgments';
      END IF;
      IF EXISTS (SELECT 1 FROM external_invites WHERE program_deal_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Cannot remove issued external program deal bindings';
      END IF;
    END $$;
    DROP TABLE external_program_acknowledgments;
    ALTER TABLE external_invites DROP CONSTRAINT external_invites_program_deal,
      DROP CONSTRAINT external_invites_program_identity,
      DROP CONSTRAINT external_invites_program_binding,
      DROP COLUMN program_deal_id,DROP COLUMN program_identity;
  `)
}
