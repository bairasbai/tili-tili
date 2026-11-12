import type { components } from '../contract/api.generated.js'
import { validationFailed } from '../errors.js'
import { assertRealDate } from './dates.js'

type Rental = components['schemas']['RentalDetails']
export type RentalRow = {
  rental_pickup_on: string | null
  rental_return_on: string | null
  deposit_expected: string | null
  deposit_paid: string | null
  deposit_refunded: string | null
  deposit_disputed: string | null
}
export const RENTAL_COLUMNS = `rental_pickup_on::text,rental_return_on::text,deposit_expected::text,
  deposit_paid::text,deposit_refunded::text,deposit_disputed::text`

export function rentalOf(row: RentalRow): Rental | null {
  if (!row.rental_pickup_on) return null
  return { pickupOn: row.rental_pickup_on, returnOn: row.rental_return_on!,
    depositAmount: Number(row.deposit_expected), paidAmount: Number(row.deposit_paid),
    refundedAmount: Number(row.deposit_refunded), disputedAmount: Number(row.deposit_disputed) }
}

export function validateRental(rental: Rental): Rental {
  const { pickupOn, returnOn, depositAmount, paidAmount, refundedAmount, disputedAmount } = rental
  assertRealDate(pickupOn, 'rental.pickupOn')
  assertRealDate(returnOn, 'rental.returnOn')
  if (returnOn < pickupOn) throw validationFailed({ 'rental.returnOn': 'Возврат должен быть не раньше получения' })
  if (paidAmount > depositAmount) throw validationFailed({ 'rental.paidAmount': 'Внесённый залог превышает согласованный' })
  if (refundedAmount > paidAmount) throw validationFailed({ 'rental.refundedAmount': 'Возврат превышает внесённый залог' })
  if (disputedAmount > paidAmount - refundedAmount) throw validationFailed({ 'rental.disputedAmount': 'Спорная сумма превышает остаток залога' })
  return { pickupOn, returnOn, depositAmount, paidAmount, refundedAmount, disputedAmount }
}

export function rentalDepositSummary(rows: { status: string; deposit_expected: string | null;
  deposit_paid: string | null; deposit_refunded: string | null; deposit_disputed: string | null }[]): components['schemas']['RentalDepositSummary'] {
  let upcoming = 0n, paid = 0n, refunded = 0n, disputed = 0n
  for (const row of rows) {
    if (row.deposit_expected === null) continue
    const actual = BigInt(row.deposit_paid!)
    paid += actual
    refunded += BigInt(row.deposit_refunded!)
    disputed += BigInt(row.deposit_disputed!)
    if (row.status !== 'cancelled' && row.status !== 'returned' && row.status !== 'done') {
      upcoming += BigInt(row.deposit_expected) - actual
    }
  }
  return { upcoming: upcoming.toString(), paid: paid.toString(), refunded: refunded.toString(),
    held: (paid - refunded).toString(), disputed: disputed.toString() }
}
