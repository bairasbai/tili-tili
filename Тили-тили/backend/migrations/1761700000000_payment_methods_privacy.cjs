/* Feature 021: payment methods, per-payment privacy and amount-unknown facts.
 *
 * Existing rows are preserved. We cannot infer historical method from kind/provider_ref
 * without guessing, so old rows become method=other, visibility=private, amount_known=true.
 */
exports.up = (pgm) => {
  pgm.addColumns('payments', {
    payment_method: { type: 'text', notNull: true, default: 'other' },
    visibility: { type: 'text', notNull: true, default: 'private' },
    amount_known: { type: 'boolean', notNull: true, default: true },
    paid_on: { type: 'date' },
  })

  // Keep the date users already saw before 021: created_at interpreted in the wedding timezone.
  pgm.sql(`update payments p
    set paid_on=(p.created_at at time zone coalesce(w.tz,'Europe/Moscow'))::date
    from deals d join weddings w on w.id=d.wedding_id
    where d.id=p.deal_id and p.paid_on is null`)

  pgm.alterColumn('payments', 'paid_on', { notNull: true })
  // Unknown amount is NULL. It is never 0, and SUM therefore ignores it.
  pgm.alterColumn('payments', 'amount', { notNull: false })

  pgm.addConstraint('payments', 'payments_method_known',
    "CHECK (payment_method IN ('cash','bank_transfer','card','other'))")
  pgm.addConstraint('payments', 'payments_visibility_known',
    "CHECK (visibility IN ('private','finance_members','vendor'))")
  pgm.addConstraint('payments', 'payments_amount_known_consistent',
    'CHECK ((amount_known AND amount IS NOT NULL) OR (NOT amount_known AND amount IS NULL))')
  pgm.addConstraint('payments', 'payments_paid_on_range',
    "CHECK (paid_on >= DATE '2000-01-01' AND paid_on <= DATE '2100-12-31')")
  pgm.createIndex('payments', ['deal_id', 'visibility', 'paid_on'], {
    name: 'payments_deal_visibility_paid_on_idx',
  })
}

exports.down = (pgm) => {
  /* Pre-021 application code has no privacy discriminator. A populated rollback could
   * therefore expose private payment totals to vendors. Refuse it instead of fabricating
   * amounts or silently widening access. Empty/disposable databases remain reversible. */
  pgm.sql(`DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM payments) THEN
      RAISE EXCEPTION 'payment privacy rollback refused on populated payments';
    END IF;
  END $$`)

  pgm.dropIndex('payments', ['deal_id', 'visibility', 'paid_on'], {
    name: 'payments_deal_visibility_paid_on_idx',
  })
  pgm.dropConstraint('payments', 'payments_paid_on_range')
  pgm.dropConstraint('payments', 'payments_amount_known_consistent')
  pgm.dropConstraint('payments', 'payments_visibility_known')
  pgm.dropConstraint('payments', 'payments_method_known')
  pgm.dropColumns('payments', ['payment_method', 'visibility', 'amount_known', 'paid_on'])
  pgm.alterColumn('payments', 'amount', { notNull: true })
}
