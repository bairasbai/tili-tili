import { afterAll, beforeAll, expect, it } from 'vitest'
import { AdditionalEventFixture, ok } from './helpers/additionalEventFixture.js'

const h = new AdditionalEventFixture()
beforeAll(async () => { await h.start() })
afterAll(async () => { await h.close() })
it('FE09 accepting a helper invite returns its wedding identity while preserving an existing couple wedding', async () => {
  const own = await h.fixture(), target = await h.fixture()
  const invite = ok<{ code: string }>(await h.call('A22_INVITE', target.pair, { method: 'POST', url: `/weddings/${target.wedding}/invites`, payload: { role: 'helper' } }), 201)
  const accepted = ok<{ weddingId: string; role: string }>(await h.call('A22_ACCEPT', own.pair, { method: 'POST', url: `/invites/${invite.code}/accept` }))
  expect(accepted).toMatchObject({ weddingId: target.wedding, role: 'helper' })
  const roles = await h.db.query<{ wedding_id: string; role: string }>('select wedding_id,role from wedding_members where user_id=$1 order by wedding_id', [own.pair.id])
  expect(roles.rows).toContainEqual({ wedding_id: own.wedding, role: 'couple' })
  expect(roles.rows).toContainEqual({ wedding_id: target.wedding, role: 'helper' })
})
