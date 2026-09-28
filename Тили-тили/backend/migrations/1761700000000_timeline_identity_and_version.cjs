/**
 * Feature 021: aggregate version for the wedding timeline.
 *
 * Timeline event UUIDs already exist, but before 021 every full PUT deleted
 * all rows and generated new UUIDs. The aggregate version belongs to the
 * wedding because replacement/reorder is one schedule-level operation.
 *
 * Version starts at 1 for both existing and future weddings. Every committed
 * timeline mutation must increment it: full replacement, day-X shift and
 * wedding-date reschedule. T005 will use it for optimistic concurrency.
 */
exports.up = (pgm) => {
  pgm.addColumns('weddings', {
    timeline_version: { type: 'integer', notNull: true, default: 1 },
  })
  pgm.addConstraint(
    'weddings',
    'weddings_timeline_version_positive',
    'CHECK (timeline_version > 0)',
  )
}

exports.down = (pgm) => {
  pgm.dropConstraint('weddings', 'weddings_timeline_version_positive')
  pgm.dropColumns('weddings', ['timeline_version'])
}
