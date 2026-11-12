import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'

export const THANKS_MIGRATION = '1764930000000_guest_thanks'
export const THANKS_LATEST = 1764930000000

export async function runGuestThanksCycle({ db, migrate, snapshot }, wedding, actor) {
  const before = await snapshot()
  assert.equal(before.data.pgmigrations.length, 108)
  await migrate('up', THANKS_LATEST)
  const empty = await snapshot()
  assert.equal(empty.data.pgmigrations.length, 109)
  const { guest_thanks_batches: batches, guest_thanks_recipients: recipients, ...old } = empty.data
  assert.deepEqual([batches, recipients], [[], []])
  old.pgmigrations = old.pgmigrations.filter(row => row.name !== THANKS_MIGRATION)
  assert.deepEqual(old, before.data)
  await migrate('up', THANKS_LATEST)
  assert.deepEqual(await snapshot(), empty)
  await migrate('down', THANKS_MIGRATION, undefined, true)
  assert.deepEqual(await snapshot(), before)
  await migrate('up', THANKS_LATEST)
  const party = (await db.query('select id,invite_token from guest_parties where wedding_id=$1 order by id limit 1', [wedding])).rows[0]
  assert(party?.invite_token)
  const id = randomUUID()
  await db.query(`insert into guest_thanks_batches(id,wedding_id,actor_id,body,recipient_count)
    values($1,$2,$3,'Synthetic thank you',1)`, [id, wedding, actor])
  await db.query(`insert into guest_thanks_recipients(wedding_id,party_id,batch_id,invitation_hash) values($1,$2,$3,$4)`,
    [wedding, party.id, id, createHash('sha256').update(party.invite_token).digest('hex')])
  const populated = await snapshot()
  await migrate('down', THANKS_MIGRATION, 'guest_thanks_preserving_down_t021', true)
  assert.deepEqual(await snapshot(), populated)
  await db.query('delete from guest_thanks_batches where wedding_id=$1 and id=$2', [wedding, id])
  process.stdout.write('GUEST_THANKS109_PRESERVING_PASSED emptyCycle=1 exactRepeat=1 populatedRefusal=1\n')
}
