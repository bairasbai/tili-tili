/**
 * Feature 021: fixed/flexible timeline blocks, dependency graph and structured assignees.
 *
 * Existing timeline_events stays the source of truth. Relationship tables carry wedding_id
 * as part of composite foreign keys, so an event cannot reference a member/deal/event from
 * another wedding even if application validation regresses.
 */
exports.up = (pgm) => {
  pgm.addColumns('timeline_events', {
    timing_mode: { type: 'text', notNull: true, default: 'flexible' },
  })
  pgm.addConstraint(
    'timeline_events',
    'timeline_events_timing_mode_known',
    "CHECK (timing_mode IN ('fixed','flexible'))",
  )

  // Composite unique keys are explicit FK targets for wedding-scoped relationships.
  pgm.addConstraint('timeline_events', 'timeline_events_wedding_id_id_unique', { unique: ['wedding_id', 'id'] })
  pgm.addConstraint('deals', 'deals_wedding_id_id_unique', { unique: ['wedding_id', 'id'] })

  pgm.createTable('timeline_event_dependencies', {
    wedding_id: { type: 'uuid', notNull: true },
    event_id: { type: 'uuid', notNull: true },
    depends_on_event_id: { type: 'uuid', notNull: true },
    travel_minutes: { type: 'integer', notNull: true, default: 0 },
    buffer_minutes: { type: 'integer', notNull: true, default: 0 },
  })
  pgm.addConstraint('timeline_event_dependencies', 'timeline_event_dependencies_pk', {
    primaryKey: ['event_id', 'depends_on_event_id'],
  })
  pgm.addConstraint(
    'timeline_event_dependencies',
    'timeline_event_dependencies_not_self',
    'CHECK (event_id <> depends_on_event_id)',
  )
  pgm.addConstraint(
    'timeline_event_dependencies',
    'timeline_event_dependencies_minutes_bounded',
    'CHECK (travel_minutes BETWEEN 0 AND 1440 AND buffer_minutes BETWEEN 0 AND 1440)',
  )
  pgm.sql(`
    ALTER TABLE timeline_event_dependencies
      ADD CONSTRAINT timeline_event_dependencies_event_fk
      FOREIGN KEY (wedding_id, event_id)
      REFERENCES timeline_events (wedding_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT timeline_event_dependencies_parent_fk
      FOREIGN KEY (wedding_id, depends_on_event_id)
      REFERENCES timeline_events (wedding_id, id) ON DELETE CASCADE;
  `)
  pgm.createIndex('timeline_event_dependencies', 'wedding_id')

  pgm.createTable('timeline_event_members', {
    wedding_id: { type: 'uuid', notNull: true },
    event_id: { type: 'uuid', notNull: true },
    user_id: { type: 'uuid', notNull: true },
  })
  pgm.addConstraint('timeline_event_members', 'timeline_event_members_pk', {
    primaryKey: ['event_id', 'user_id'],
  })
  pgm.sql(`
    ALTER TABLE timeline_event_members
      ADD CONSTRAINT timeline_event_members_event_fk
      FOREIGN KEY (wedding_id, event_id)
      REFERENCES timeline_events (wedding_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT timeline_event_members_member_fk
      FOREIGN KEY (wedding_id, user_id)
      REFERENCES wedding_members (wedding_id, user_id) ON DELETE CASCADE;
  `)
  pgm.createIndex('timeline_event_members', 'wedding_id')

  pgm.createTable('timeline_event_deals', {
    wedding_id: { type: 'uuid', notNull: true },
    event_id: { type: 'uuid', notNull: true },
    deal_id: { type: 'uuid', notNull: true },
  })
  pgm.addConstraint('timeline_event_deals', 'timeline_event_deals_pk', {
    primaryKey: ['event_id', 'deal_id'],
  })
  pgm.sql(`
    ALTER TABLE timeline_event_deals
      ADD CONSTRAINT timeline_event_deals_event_fk
      FOREIGN KEY (wedding_id, event_id)
      REFERENCES timeline_events (wedding_id, id) ON DELETE CASCADE,
      ADD CONSTRAINT timeline_event_deals_deal_fk
      FOREIGN KEY (wedding_id, deal_id)
      REFERENCES deals (wedding_id, id) ON DELETE CASCADE;
  `)
  pgm.createIndex('timeline_event_deals', 'wedding_id')
}

exports.down = (pgm) => {
  pgm.dropTable('timeline_event_deals')
  pgm.dropTable('timeline_event_members')
  pgm.dropTable('timeline_event_dependencies')
  pgm.dropConstraint('deals', 'deals_wedding_id_id_unique')
  pgm.dropConstraint('timeline_events', 'timeline_events_wedding_id_id_unique')
  pgm.dropConstraint('timeline_events', 'timeline_events_timing_mode_known')
  pgm.dropColumns('timeline_events', ['timing_mode'])
}
