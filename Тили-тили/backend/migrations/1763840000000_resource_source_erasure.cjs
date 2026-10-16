/* Account erasure reaches retained resources through overlapping user, company,
 * staff and session cascades. Check the complete source-reference graph after
 * those actions finish; keep every existing ON DELETE/UPDATE action and row.
 * No resource identity, allocation, financial or audit history is rewritten.
 */
const sourceForeignKeys = [
  ['vendor_resources', 'vendor_resources_vendor_id_fkey'],
  ['vendor_resources', 'vendor_resources_person_user_id_fkey'],
  ['vendor_resources', 'vendor_resources_staff_member_id_fkey'],
  ['vendor_resources', 'vendor_resources_created_by_fkey'],
  ['vendor_staff_members', 'vendor_staff_members_vendor_id_fkey'],
  ['vendor_staff_members', 'vendor_staff_members_user_id_fkey'],
  ['vendor_staff_members', 'vendor_staff_members_invited_by_fkey'],
  ['vendor_staff_members', 'vendor_staff_members_accepted_session_id_fkey'],
]

exports.up = pgm => {
  for (const [table, constraint] of sourceForeignKeys) {
    pgm.sql(`alter table ${table} alter constraint ${constraint} deferrable initially deferred`)
  }
}

/* Timing-only rollback. Existing records are retained; the old overlapping
 * cascade failure can recur once these checks are immediate again.
 */
exports.down = pgm => {
  for (const [table, constraint] of sourceForeignKeys) {
    pgm.sql(`alter table ${table} alter constraint ${constraint} not deferrable`)
  }
}
