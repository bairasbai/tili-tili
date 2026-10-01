exports.up = pgm => {
  pgm.addColumns('weddings', {
    timeline_version: { type: 'bigint', notNull: true, default: 0 },
    timeline_updated_at: { type: 'timestamptz' },
    timeline_updated_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
  })
  pgm.addConstraint('weddings', 'weddings_timeline_version_nonnegative', 'CHECK (timeline_version >= 0)')
  // Historical mutation time and actor are unknown; do not backfill guesses.
  pgm.sql(`
    CREATE FUNCTION record_timeline_change() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid; actor text;
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.wedding_id IS DISTINCT FROM NEW.wedding_id THEN
        RAISE EXCEPTION 'timeline blocks cannot move between weddings' USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'DELETE' THEN target := OLD.wedding_id; ELSE target := NEW.wedding_id; END IF;
      actor := nullif(current_setting('tili.timeline_actor', true), '');
      UPDATE weddings SET timeline_version = timeline_version + 1,
        timeline_updated_at = clock_timestamp(), timeline_updated_by = actor::uuid
        WHERE id = target;
      RETURN NULL;
    END $$;
    CREATE TRIGGER timeline_revision_changed AFTER INSERT OR UPDATE OR DELETE ON timeline_events
      FOR EACH ROW EXECUTE FUNCTION record_timeline_change();
  `)
}

exports.down = pgm => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM weddings WHERE timeline_updated_at IS NOT NULL) THEN
      RAISE EXCEPTION 'refusing rollback after versioned timeline mutations';
    END IF;
  END $$;`)
  pgm.sql('DROP TRIGGER timeline_revision_changed ON timeline_events; DROP FUNCTION record_timeline_change();')
  pgm.dropConstraint('weddings', 'weddings_timeline_version_nonnegative')
  pgm.dropColumns('weddings', ['timeline_version', 'timeline_updated_at', 'timeline_updated_by'])
}
