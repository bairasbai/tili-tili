// Select the latest revision before filtering terminal states.
export const CURRENT_PURCHASES = `select distinct on (id) * from wedding_purchase_versions
  where wedding_id=$1 order by id,version desc`
export const PURCHASE_COUNTS_IN_BUDGET = "p.status not in ('cancelled','returned')"
