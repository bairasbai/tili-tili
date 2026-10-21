import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import type { Queryable } from '../../src/plugins/db.js'
import { uuidv7 } from '../../src/ids.js'
import { openLead } from '../../src/vendor/leads.js'
import { finishDayTransition, finishMainDayChange, observeMainDayChange, prepareDayTransition,
  prepareMainDayChange, prepareTerminalDayTransition } from '../../src/deals/day-scope-write.js'

type FixtureMutation = (client: Queryable) => Promise<unknown>
type TerminalState = 'done' | 'cancelled'

/** Fixture-only adapter: keep the caller's state/timestamp SQL and the real
 * ledger transition in the SAME transaction, including a caller-held blocker. */
export async function withTerminalDayFixtureClient(client: Queryable, weddingId: string, dealId: string,
  target: TerminalState, mutate: FixtureMutation): Promise<void> {
  const prepared = target === 'done'
    ? await prepareTerminalDayTransition(client, weddingId, dealId)
    : await prepareDayTransition(client, weddingId, dealId)
  await mutate(client)
  await finishDayTransition(client, prepared, target)
}

export async function withTerminalDayFixture(app: FastifyInstance, dealId: string,
  target: TerminalState, mutate: FixtureMutation): Promise<void> {
  await app.db!.tx(async client => {
    const root = await client.query<{ wedding_id: string }>('select wedding_id from deals where id=$1', [dealId])
    assert.equal(root.rows.length, 1, 'Terminal fixture requires its existing own root')
    await withTerminalDayFixtureClient(client, root.rows[0]!.wedding_id, dealId, target, mutate)
  })
}

/** Past-date fixture, not a public reschedule acceptance. The existing main
 * event trigger follows the exact caller SQL that changes weddings.date/tz. */
export async function withMainDayFixture(app: FastifyInstance, weddingId: string,
  mutate: FixtureMutation): Promise<void> {
  await app.db!.tx(async client => {
    const prepared = await prepareMainDayChange(client, weddingId)
    await observeMainDayChange(client, prepared)
    await mutate(client)
    await finishMainDayChange(client, prepared)
  })
}

interface UntrackedSlotDeal {
  weddingId: string; slotId: string
  state: 'candidate' | 'contacted' | 'negotiating' | 'booked'
  vendorId?: string; externalName?: string; externalPhone?: string
  price: number | null; packageId?: string; negotiatingUntil?: string | null
}

/** An explicitly untracked historical/schema fixture from its first INSERT.
 * Never turns a tracked booking backwards or removes its ledger/DATE/history.
 * Public parents and the later HTTP command remain the caller's responsibility. */
export async function seedUntrackedSlotDeal(app: FastifyInstance, input: UntrackedSlotDeal): Promise<{ dealId: string; slotId: string }> {
  assert.equal(Boolean(input.vendorId) !== Boolean(input.externalName), true, 'Fixture requires exactly one performer')
  const dealId = uuidv7()
  await app.db!.tx(async client => {
    const slot = await client.query<{ deal_id: string | null; prebooked_at: Date | null }>(
      'select deal_id,prebooked_at from slots where wedding_id=$1 and id=$2 for update', [input.weddingId, input.slotId])
    assert.equal(slot.rows.length, 1, 'Legacy fixture requires its own existing slot')
    assert.equal(slot.rows[0]!.deal_id, null, 'Legacy fixture must start in an empty slot')
    assert.equal(slot.rows[0]!.prebooked_at, null, 'Legacy fixture must not replace a prebooked selection')
    const pkg = input.packageId ? (await client.query<{ name: string; items: unknown }>(
      'select name,items from vendor_packages where id=$1 and vendor_id=$2', [input.packageId, input.vendorId])).rows[0] : undefined
    assert(!input.packageId || pkg, 'Legacy fixture package must belong to its performer')
    await client.query(`insert into deals(id,wedding_id,slot_id,vendor_id,external_name,external_phone,state,price,currency,
      booked_at,package_id,package_title_snapshot,package_includes_snapshot,negotiating_until)
      values($1,$2,$3,$4,$5,$6,$7,$8,'RUB',case when $7='booked' then now() end,$9,$10,$11::jsonb,$12::timestamptz)`,
    [dealId, input.weddingId, input.slotId, input.vendorId ?? null, input.externalName ?? null, input.externalPhone ?? null,
      input.state, input.price, input.packageId ?? null, pkg?.name ?? null, pkg ? JSON.stringify(pkg.items) : null, input.negotiatingUntil ?? null])
    const selected = await client.query('update slots set deal_id=$2 where id=$1 and wedding_id=$3 and deal_id is null',
      [input.slotId, dealId, input.weddingId])
    assert.equal(selected.rowCount, 1, 'Own empty fixture slot must select the new root')
    if (input.vendorId) await openLead(client, input.weddingId, input.vendorId, null, true)
    else await client.query("insert into chats(id,wedding_id,kind,slot_id,deal_id) values($1,$2,'external',$3,$4)",
      [uuidv7(), input.weddingId, input.slotId, dealId])
  })
  return { dealId, slotId: input.slotId }
}
