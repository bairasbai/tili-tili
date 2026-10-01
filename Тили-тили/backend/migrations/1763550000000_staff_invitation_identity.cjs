/** Preserve invitation addressing across account deletion. Previously-created
 * invitations lack reliable original addressing; keep them explicitly unknown.
 * Current accepted memberships remain valid, but unknown pending invitations
 * must be replaced explicitly instead of being inferred to be open invitations.
 */
exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE vendor_staff_members
      ADD COLUMN invite_target_user_id uuid,
      ADD COLUMN invite_binding_known boolean NOT NULL DEFAULT false,
      ADD CONSTRAINT staff_invitation_binding_known CHECK (invite_binding_known OR invite_target_user_id IS NULL);
    COMMENT ON COLUMN vendor_staff_members.invite_target_user_id IS
      'Immutable original invitation recipient identity; intentionally no FK so erasure cannot turn targeted invitation into open invitation';
    COMMENT ON COLUMN vendor_staff_members.invite_binding_known IS
      'False for preserved historical invitations with unknown original addressing; never infer open scope from a nullable current member account';
    CREATE FUNCTION protect_staff_invitation_identity() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF OLD.invite_target_user_id IS DISTINCT FROM NEW.invite_target_user_id
        OR OLD.invite_binding_known IS DISTINCT FROM NEW.invite_binding_known THEN
        RAISE EXCEPTION 'staff invitation addressing is immutable' USING ERRCODE='23514';
      END IF;
      RETURN NEW;
    END $fn$;
    CREATE TRIGGER staff_invitation_identity BEFORE UPDATE ON vendor_staff_members
      FOR EACH ROW EXECUTE FUNCTION protect_staff_invitation_identity();
  `)
}
exports.down = pgm => {
  pgm.sql(`
    DO $guard$ BEGIN
      IF EXISTS (SELECT 1 FROM vendor_staff_members WHERE invite_binding_known OR invite_target_user_id IS NOT NULL) THEN
        RAISE EXCEPTION 'staff invitation identity history exists; do not discard addressing';
      END IF;
    END $guard$;
    DROP TRIGGER staff_invitation_identity ON vendor_staff_members;
    DROP FUNCTION protect_staff_invitation_identity();
    ALTER TABLE vendor_staff_members DROP CONSTRAINT staff_invitation_binding_known,
      DROP COLUMN invite_target_user_id, DROP COLUMN invite_binding_known;
  `)
}
