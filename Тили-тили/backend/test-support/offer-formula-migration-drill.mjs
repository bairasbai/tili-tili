import assert from 'node:assert/strict'

export const OFFER_FORMULA_LATEST = 1765040000000
export const OFFER_FORMULA_MIGRATION = '1765040000000_offer_price_formula'

export async function runOfferFormulaCycle({ db, migrate, snapshot }, dealId) {
  const { rows: [deal] } = await db.query('select price::text as price from deals where id=$1', [dealId])
  assert(deal?.price && BigInt(deal.price) > 0n)
  const insert = 'insert into offer_price_breakdowns(deal_id,base_amount,components) values($1,$2,$3::jsonb) returning id'
  const money = amount => ({ amount, currency: 'RUB' })
  const fixed = { kind: 'delivery', status: 'separate', amount: money(2500) }
  const add = line => db.query(insert, [dealId, deal.price, JSON.stringify([line])])
  const remove = id => db.query('delete from offer_price_breakdowns where id=$1', [id])
  const { rows: [legacy] } = await add(fixed)
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 119)
  await migrate('up', OFFER_FORMULA_LATEST)
  const installed = await snapshot()
  assert.equal(installed.data.pgmigrations.length, 120)
  const { pgmigrations, ...existing } = installed.data
  assert.deepEqual({ ...existing, pgmigrations: pgmigrations.filter(row => row.name !== OFFER_FORMULA_MIGRATION) }, before.data)
  await migrate('up', OFFER_FORMULA_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', OFFER_FORMULA_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', OFFER_FORMULA_LATEST)
  await remove(legacy.id)
  const formula = { ...fixed, amount: money(31263), formula: { unit: 'hour', quantity: '2.5', rate: money(12505) } }
  await assert.rejects(() => add({ ...formula, amount: money(31262) }), { code: '23514' })
  await assert.rejects(() => add({ ...formula, formula: { ...formula.formula, quantity: null } }), { code: '23514' })
  const { rows: [calculated] } = await add(formula)
  const populated = await snapshot()
  await migrate('down', OFFER_FORMULA_MIGRATION, 'offer_price_formula_preserving_down_fr014', true)
  assert.deepEqual(await snapshot(), populated)
  await remove(calculated.id)
  process.stdout.write('FR014_OFFER_FORMULA_MIGRATION_PASSED\n')
}
