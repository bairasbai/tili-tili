import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const BUDGET_DEAL_LINK_LATEST = 1765060000000
export const BUDGET_DEAL_LINK_MIGRATION = '1765060000000_budget_deal_links'

export async function runBudgetDealLinkCycle({ db, migrate, snapshot }, ownerId) {
  const [wedding, otherWedding, slot, deal, item] = Array.from({ length: 5 }, () => randomUUID())
  await db.query("insert into weddings(id,owner_id,title,invite_code) values($1,$3,'Synthetic expense',$4),($2,$3,'Synthetic other wedding',$5)",
    [wedding, otherWedding, ownerId, wedding, otherWedding])
  await db.query("insert into slots(id,wedding_id,category_id,label) values($1,$2,'photo','Synthetic slot')", [slot, wedding])
  await db.query("insert into deals(id,wedding_id,slot_id,external_name,state,price,booked_at) values($1,$2,$3,'Synthetic deal','booked',30000,now())",
    [deal, wedding, slot])
  await db.query("insert into budget_items(id,wedding_id,title,category_id,amount,currency) values($1,$2,'Synthetic expense','b2',15000,'RUB')", [item, wedding])

  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 121)
  await migrate('up', BUDGET_DEAL_LINK_LATEST)
  const installed = await snapshot()
  const { budget_items: items, pgmigrations, ...existing } = installed.data
  assert.equal(pgmigrations.length, 122)
  assert.equal(items.length, before.data.budget_items.length)
  assert(items.every(row => row.linked_deal_id === null && row.deal_link_version === 0))
  const previousItems = items.map(({ linked_deal_id: _deal, deal_link_version: _version, ...row }) => row)
  previousItems.sort((a, b) => a.id.localeCompare(b.id))
  assert.deepEqual(previousItems, [...before.data.budget_items].sort((a, b) => a.id.localeCompare(b.id)))
  assert.deepEqual({ ...existing, budget_items: before.data.budget_items,
    pgmigrations: pgmigrations.filter(row => row.name !== BUDGET_DEAL_LINK_MIGRATION) }, before.data)
  await migrate('up', BUDGET_DEAL_LINK_LATEST)
  assert.deepEqual(await snapshot(), installed)
  await migrate('down', BUDGET_DEAL_LINK_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)

  await migrate('up', BUDGET_DEAL_LINK_LATEST)
  await assert.rejects(() => db.query(`insert into budget_items(id,wedding_id,title,category_id,amount,currency,linked_deal_id,deal_link_version)
    values($1,$2,'Synthetic cross-scope attempt','b2',100,'RUB',$3,1)`, [randomUUID(), otherWedding, deal]),
  { code: '23503', constraint: 'budget_item_deal_link_wedding' })
  await assert.rejects(() => db.query('update budget_items set linked_deal_id=$2 where id=$1', [item, deal]), { code: '23514' })
  await db.query('update budget_items set linked_deal_id=$2,deal_link_version=1 where id=$1', [item, deal])
  await assert.rejects(() => db.query('delete from deals where id=$1', [deal]), { code: '23503', constraint: 'budget_item_deal_link_wedding' })
  const populated = await snapshot()
  await migrate('down', BUDGET_DEAL_LINK_MIGRATION, 'budget_deal_links_rollback_preserves_associations', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from weddings where id=any($1::uuid[])', [[wedding, otherWedding]])
  const remaining = await db.query('select id from budget_items where id=$1', [item])
  assert.equal(remaining.rowCount, 0)
  process.stdout.write('SC002_BUDGET_DEAL_LINK_MIGRATION_PASSED\n')
}
