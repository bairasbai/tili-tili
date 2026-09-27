import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomUUID } from 'node:crypto'
import { buildApp } from '../src/app.js'

const DB = process.env.TEST_DATABASE_URL

describe.skipIf(!DB)('020 / family invitations migration invariants', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await buildApp({
      env: 'test',
      databaseUrl: DB ?? null,
      redisUrl: null,
      corsOrigins: [],
      jwtAccessSecret: 'a'.repeat(48),
      jwtRefreshSecret: 'b'.repeat(48),
      policyVersion: '2026-09-02',
    })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })

  it('schema makes every current guest belong to exactly one invitation', async () => {
    const { rows } = await app.db!.query<{ missing: string }>(
      'select count(*)::text as missing from guests where invitation_id is null',
    )
    expect(Number(rows[0]!.missing)).toBe(0)
  })

  it('legacy plusOne no longer survives as an invisible second person', async () => {
    const { rows } = await app.db!.query<{ plus: string; migrated: string }>(
      `select
         count(*) filter (where plus_one)::text as plus,
         count(*) filter (where legacy_plus_one)::text as migrated
       from guests`,
    )
    expect(Number(rows[0]!.plus)).toBe(0)
    expect(Number(rows[0]!.migrated)).toBeGreaterThanOrEqual(0)
  })

  it('one bus booking is constrained to exactly one person', async () => {
    const weddingId = randomUUID()
    const invitationId = randomUUID()
    const guestId = randomUUID()
    const busId = randomUUID()
    const ownerId = randomUUID()
    await app.db!.query(
      `insert into users (id, phone, name) values ($1, $2, $3)`,
      [ownerId, '+7999' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0'), '020 owner'],
    )
    await app.db!.query(
      `insert into weddings (id, owner_id, title, tz, invite_code)
       values ($1, $2, $3, $4, $5)`,
      [weddingId, ownerId, '020', 'Asia/Yekaterinburg', 'f020-' + randomUUID()],
    )
    await app.db!.query('insert into guest_invitations (id,wedding_id,label,rsvp_token) values ($1,$2,$3,$4)', [
      invitationId,weddingId,'Семья','inv-'+randomUUID(),
    ])
    await app.db!.query(`insert into guests (id,wedding_id,name,rsvp_token,invitation_id)
      values ($1,$2,$3,$4,$5)`, [guestId,weddingId,'Персона','g-'+randomUUID(),invitationId])
    await app.db!.query('insert into bus_routes (id,wedding_id,name,seats) values ($1,$2,$3,2)', [busId,weddingId,'020 bus'])
    await app.db!.query('insert into bus_bookings (bus_id,guest_id) values ($1,$2)', [busId,guestId])
    const { rows } = await app.db!.query<{ persons:number;taken:number }>(
      'select b.persons,r.taken from bus_bookings b join bus_routes r on r.id=b.bus_id where b.bus_id=$1 and b.guest_id=$2',
      [busId,guestId],
    )
    expect(rows[0]).toEqual({ persons: 1, taken: 1 })
    await expect(app.db!.query('update bus_bookings set persons=2 where bus_id=$1 and guest_id=$2',[busId,guestId]))
      .rejects.toMatchObject({ code: '23514' })
    await app.db!.query('delete from weddings where id=$1',[weddingId])
  })
})
