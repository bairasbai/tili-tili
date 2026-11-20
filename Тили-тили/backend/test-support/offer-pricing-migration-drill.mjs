import assert from 'node:assert/strict'

export const OFFER_PRICING_LATEST = 1765030000000
export const OFFER_PRICING_MIGRATION = '1765030000000_offer_price_breakdowns'

export async function runOfferPricingCycle({ db, migrate, snapshot }, dealId) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 118)
  await migrate('up', OFFER_PRICING_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 119)
  const { offer_price_breakdowns: pricing, pgmigrations, ...existing } = installed.data
  assert.deepEqual(pricing, [])
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== OFFER_PRICING_MIGRATION) }, before.data)
  await migrate('up', OFFER_PRICING_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', OFFER_PRICING_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', OFFER_PRICING_LATEST)
  const { rows: [deal] } = await db.query('select price::text as price from deals where id=$1', [dealId])
  assert(deal?.price && BigInt(deal.price) > 0n)
  const insert = 'insert into offer_price_breakdowns(deal_id,base_amount,components) values($1,$2,$3::jsonb) returning id'
  const line = { kind: 'delivery', status: 'separate', amount: { amount: 2500, currency: 'RUB' } }
  await assert.rejects(() => db.query(insert, [dealId, deal.price, JSON.stringify([line, line])]), { code: '23514' })
  await assert.rejects(() => db.query(insert, [dealId, '0', JSON.stringify([line])]), { code: '23514' })
  const { rows: [price] } = await db.query(insert, [dealId, deal.price, JSON.stringify([line])])
  await assert.rejects(() => db.query('update offer_price_breakdowns set base_amount=base_amount+1 where id=$1', [price.id]), { code: '23514' })
  const populated = await snapshot()
  await migrate('down', OFFER_PRICING_MIGRATION, 'offer_price_breakdowns_preserving_down_fr013', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from offer_price_breakdowns where id=$1', [price.id])
  process.stdout.write('FR013_OFFER_PRICING_MIGRATION_PASSED\n')
}
