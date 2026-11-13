exports.up = pgm => pgm.sql(`
  update tasks t set done_at = now()
  from weddings w
  where w.id = t.wedding_id and w.date is not null
    and w.archived_at is null and w.cancelled_at is null
    and t.source = 'system' and t.kind = 'checklist' and t.sort = 0 and t.period = '9'
    and t.done_at is null and t.excluded_reason is null;
`)

// Keep task completions and reminder history when rolling back application code.
exports.down = () => {}
