exports.up = pgm => {
  pgm.sql(`
    ALTER TABLE timeline_events
      ADD COLUMN duration_minutes double precision,
      ADD COLUMN fixed boolean NOT NULL DEFAULT false,
      ADD COLUMN travel_minutes double precision NOT NULL DEFAULT 0,
      ADD COLUMN buffer_minutes double precision NOT NULL DEFAULT 0,
      ADD CONSTRAINT timeline_events_wedding_identity UNIQUE (wedding_id,id);
    -- Derive only known intervals; migration is not a user edit.
    ALTER TABLE timeline_events DISABLE TRIGGER timeline_revision_changed;
    UPDATE timeline_events SET duration_minutes=extract(epoch FROM ends_at-starts_at)/60
      WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL
        AND ends_at>=starts_at AND ends_at-starts_at<=interval '7 days';
    ALTER TABLE timeline_events ENABLE TRIGGER timeline_revision_changed;
    ALTER TABLE timeline_events
      ADD CONSTRAINT timeline_duration_range CHECK (duration_minutes BETWEEN 0 AND 10080),
      ADD CONSTRAINT timeline_travel_range CHECK (travel_minutes BETWEEN 0 AND 10080),
      ADD CONSTRAINT timeline_buffer_range CHECK (buffer_minutes BETWEEN 0 AND 10080),
      ADD CONSTRAINT timeline_fixed_start CHECK (NOT fixed OR starts_at IS NOT NULL),
      ADD CONSTRAINT timeline_interval_valid CHECK (
        ends_at IS NULL OR (starts_at IS NOT NULL AND ends_at>=starts_at
          AND ends_at-starts_at<=interval '7 days')) NOT VALID,
      ADD CONSTRAINT timeline_duration_consistent CHECK (
        starts_at IS NULL OR duration_minutes IS NULL OR (ends_at IS NOT NULL
          AND abs(extract(epoch FROM ends_at-starts_at)-duration_minutes*60)<=0.001)) NOT VALID;
    DO $$ DECLARE invalid_intervals bigint; BEGIN
      SELECT count(*) INTO invalid_intervals FROM timeline_events
        WHERE ends_at IS NOT NULL AND (starts_at IS NULL OR ends_at<starts_at OR ends_at-starts_at>interval '7 days');
      IF invalid_intervals=0 THEN
        ALTER TABLE timeline_events VALIDATE CONSTRAINT timeline_interval_valid;
      ELSE
        RAISE NOTICE 'timeline_interval_valid: % historical intervals need explicit correction; new writes are checked', invalid_intervals;
      END IF;
      ALTER TABLE timeline_events VALIDATE CONSTRAINT timeline_duration_consistent;
    END $$;
    ALTER TABLE guests ADD CONSTRAINT guests_wedding_identity UNIQUE (wedding_id,id);
    ALTER TABLE deals ADD CONSTRAINT deals_wedding_identity UNIQUE (wedding_id,id);
    CREATE TABLE timeline_dependencies (
      wedding_id uuid NOT NULL,
      event_id uuid NOT NULL,
      depends_on uuid NOT NULL,
      PRIMARY KEY (event_id,depends_on),
      CHECK (event_id<>depends_on),
      FOREIGN KEY (wedding_id,event_id) REFERENCES timeline_events(wedding_id,id) ON DELETE CASCADE,
      FOREIGN KEY (wedding_id,depends_on) REFERENCES timeline_events(wedding_id,id) ON DELETE CASCADE
    );
    CREATE INDEX timeline_dependencies_wedding ON timeline_dependencies(wedding_id);
    CREATE INDEX timeline_dependencies_target ON timeline_dependencies(depends_on);
    CREATE TABLE timeline_assignments (
      wedding_id uuid NOT NULL,
      event_id uuid NOT NULL,
      role text NOT NULL CHECK (role IN ('responsible','participant')),
      kind text NOT NULL CHECK (kind IN ('member','guest','deal')),
      reference_id uuid NOT NULL,
      member_id uuid GENERATED ALWAYS AS (CASE WHEN kind='member' THEN reference_id END) STORED,
      guest_id uuid GENERATED ALWAYS AS (CASE WHEN kind='guest' THEN reference_id END) STORED,
      deal_id uuid GENERATED ALWAYS AS (CASE WHEN kind='deal' THEN reference_id END) STORED,
      PRIMARY KEY (event_id,role,kind,reference_id),
      FOREIGN KEY (wedding_id,event_id) REFERENCES timeline_events(wedding_id,id) ON DELETE CASCADE,
      FOREIGN KEY (wedding_id,member_id) REFERENCES wedding_members(wedding_id,user_id) ON DELETE CASCADE,
      FOREIGN KEY (wedding_id,guest_id) REFERENCES guests(wedding_id,id) ON DELETE CASCADE,
      FOREIGN KEY (wedding_id,deal_id) REFERENCES deals(wedding_id,id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX timeline_one_responsible ON timeline_assignments(event_id) WHERE role='responsible';
    CREATE INDEX timeline_assignments_wedding ON timeline_assignments(wedding_id);
    CREATE INDEX timeline_assignments_member ON timeline_assignments(member_id);
    CREATE INDEX timeline_assignments_guest ON timeline_assignments(guest_id);
    CREATE INDEX timeline_assignments_deal ON timeline_assignments(deal_id);

    CREATE FUNCTION lock_timeline_relation() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target uuid;
    BEGIN
      IF TG_OP='UPDATE' AND OLD.wedding_id IS DISTINCT FROM NEW.wedding_id THEN
        RAISE EXCEPTION 'timeline relations cannot move weddings' USING ERRCODE='23514';
      END IF;
      IF TG_OP='DELETE' THEN target:=OLD.wedding_id; ELSE target:=NEW.wedding_id; END IF;
      PERFORM id FROM weddings WHERE id=target FOR UPDATE;
      IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
    END $$;
    CREATE TRIGGER timeline_dependency_lock BEFORE INSERT OR UPDATE OR DELETE ON timeline_dependencies
      FOR EACH ROW EXECUTE FUNCTION lock_timeline_relation();
    CREATE TRIGGER a_timeline_assignment_lock BEFORE INSERT OR UPDATE OR DELETE ON timeline_assignments
      FOR EACH ROW EXECUTE FUNCTION lock_timeline_relation();
    CREATE TRIGGER timeline_dependency_revision AFTER INSERT OR UPDATE OR DELETE ON timeline_dependencies
      FOR EACH ROW EXECUTE FUNCTION record_timeline_change();
    CREATE TRIGGER timeline_assignment_revision AFTER INSERT OR UPDATE OR DELETE ON timeline_assignments
      FOR EACH ROW EXECUTE FUNCTION record_timeline_change();

    CREATE FUNCTION check_timeline_cycles() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (
        WITH RECURSIVE reach(event_id,depends_on) AS (
          SELECT event_id,depends_on FROM timeline_dependencies WHERE wedding_id=NEW.wedding_id
          UNION
          SELECT r.event_id,d.depends_on FROM reach r JOIN timeline_dependencies d ON d.event_id=r.depends_on
            WHERE d.wedding_id=NEW.wedding_id
        ) SELECT 1 FROM reach WHERE event_id=depends_on
      ) THEN RAISE EXCEPTION 'timeline dependency cycle' USING ERRCODE='23514'; END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER timeline_dependencies_acyclic AFTER INSERT OR UPDATE ON timeline_dependencies
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_timeline_cycles();

    CREATE FUNCTION check_timeline_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.kind='member' THEN
        PERFORM u.id FROM users u JOIN wedding_members m ON m.user_id=u.id
          WHERE u.id=NEW.reference_id AND m.wedding_id=NEW.wedding_id AND u.deleted_at IS NULL
            AND m.role IN ('couple','helper','coordinator') FOR SHARE OF u,m;
        IF NOT FOUND THEN RAISE EXCEPTION 'timeline member is unavailable' USING ERRCODE='23514'; END IF;
      ELSIF NEW.kind='deal' THEN
        PERFORM id FROM deals WHERE id=NEW.reference_id AND wedding_id=NEW.wedding_id
          AND state IN ('booked','paid_deposit','done') FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION 'timeline contractor is not booked' USING ERRCODE='23514'; END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER timeline_assignment_available BEFORE INSERT OR UPDATE ON timeline_assignments
      FOR EACH ROW EXECUTE FUNCTION check_timeline_assignment();

    CREATE FUNCTION clear_unavailable_timeline_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='users' THEN
        IF NEW.deleted_at IS NOT NULL THEN DELETE FROM timeline_assignments WHERE member_id=NEW.id; END IF;
      ELSIF TG_TABLE_NAME='wedding_members' THEN
        IF NEW.role NOT IN ('couple','helper','coordinator') THEN
          DELETE FROM timeline_assignments WHERE wedding_id=NEW.wedding_id AND member_id=NEW.user_id;
        END IF;
      ELSIF NEW.state NOT IN ('booked','paid_deposit','done') THEN
        DELETE FROM timeline_assignments WHERE deal_id=NEW.id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER timeline_clear_deleted_member AFTER UPDATE OF deleted_at ON users
      FOR EACH ROW EXECUTE FUNCTION clear_unavailable_timeline_assignment();
    CREATE TRIGGER timeline_clear_ineligible_member AFTER UPDATE OF role ON wedding_members
      FOR EACH ROW EXECUTE FUNCTION clear_unavailable_timeline_assignment();
    CREATE TRIGGER timeline_clear_unbooked_deal AFTER UPDATE OF state ON deals
      FOR EACH ROW EXECUTE FUNCTION clear_unavailable_timeline_assignment();
    CREATE FUNCTION record_timeline_context_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE weddings SET timeline_version=timeline_version+1,timeline_updated_at=clock_timestamp(),
        timeline_updated_by=nullif(current_setting('tili.timeline_actor',true),'')::uuid WHERE id=NEW.id;
      RETURN NULL;
    END $$;
    CREATE TRIGGER timeline_context_changed AFTER UPDATE OF date,tz ON weddings
      FOR EACH ROW WHEN (OLD.date IS DISTINCT FROM NEW.date OR OLD.tz IS DISTINCT FROM NEW.tz)
      EXECUTE FUNCTION record_timeline_context_change();
  `)
}

exports.down = pgm => {
  pgm.sql(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM timeline_assignments) OR EXISTS (SELECT 1 FROM timeline_dependencies)
        OR EXISTS (SELECT 1 FROM timeline_events WHERE fixed OR travel_minutes<>0 OR buffer_minutes<>0
          OR (starts_at IS NULL AND duration_minutes IS NOT NULL)) THEN
        RAISE EXCEPTION 'refusing rollback that discards timeline planning';
      END IF;
    END $$;
    DROP TRIGGER timeline_clear_deleted_member ON users;
    DROP TRIGGER timeline_context_changed ON weddings;
    DROP FUNCTION record_timeline_context_change();
    DROP TRIGGER timeline_clear_ineligible_member ON wedding_members;
    DROP TRIGGER timeline_clear_unbooked_deal ON deals;
    DROP FUNCTION clear_unavailable_timeline_assignment();
    DROP TABLE timeline_assignments,timeline_dependencies;
    DROP FUNCTION check_timeline_assignment(),check_timeline_cycles(),lock_timeline_relation();
    ALTER TABLE guests DROP CONSTRAINT guests_wedding_identity;
    ALTER TABLE deals DROP CONSTRAINT deals_wedding_identity;
    ALTER TABLE timeline_events DROP CONSTRAINT timeline_events_wedding_identity,
      DROP CONSTRAINT timeline_interval_valid,
      DROP COLUMN duration_minutes,DROP COLUMN fixed,DROP COLUMN travel_minutes,DROP COLUMN buffer_minutes;
  `)
}
