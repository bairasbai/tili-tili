import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound } from '../errors.js'
import { lockTimelineForRequest, timelineETag } from '../timeline/version.js'
import { readProgram } from '../vendor/program.js'

interface VendorRow { id: string; user_id: string; name: string }
interface UserRow { id: string; deleted_at: Date | null; name: string | null }
interface DealRow { id: string; slot_id: string; vendor_id: string | null; external_name: string | null; current_program_invite_id: string | null }
interface InviteRow { program_identity: string; program_deal_id: string; slot_id: string; expires_at: Date; revoked_at: Date | null }
interface Receipt { sourceVersion: string; acknowledgedAt: string; acknowledgedBy: string | null }
type Status = 'pending' | 'acknowledged' | 'unassigned' | 'unavailable'

export async function timelineAcknowledgmentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/weddings/:weddingId/timeline/acknowledgments', async (request, reply) => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db.tx(async client => {
      const snapshot = await lockTimelineForRequest(client, request, false)
      const weddingId = request.member!.weddingId
      const wedding = (await client.query<{ title: string; cancelled_at: Date | null }>(
        'select title,cancelled_at from weddings where id=$1', [weddingId],
      )).rows[0]!
      if (wedding.cancelled_at) throw notFound('Программа недоступна')
      const candidates = (await client.query<VendorRow>(
        `select distinct v.id,v.user_id,v.name from vendors v join deals d on d.vendor_id=v.id
          where d.wedding_id=$1 and d.state in ('booked','paid_deposit','done') order by v.id`, [weddingId],
      )).rows
      const candidateDeals = (await client.query<DealRow>(
        `select id,slot_id,vendor_id,external_name,current_program_invite_id from deals where wedding_id=$1
          and state in ('booked','paid_deposit','done') order by id`, [weddingId],
      )).rows
      // Both readers lock their actor before the deal: user/vendor or invite/slot.
      const users = (await client.query<UserRow>(
        'select id,deleted_at,name from users where id=any($1::uuid[]) order by id for share',
        [candidates.map(v => v.user_id)],
      )).rows
      const vendors = (await client.query<VendorRow>(
        'select id,user_id,name from vendors where id=any($1::uuid[]) order by id for share', [candidates.map(v => v.id)],
      )).rows
      if (vendors.some(v => !users.some(u => u.id === v.user_id))) throw conflict('program_actors_changed', 'Состав исполнителей изменился — обновите сводку')
      const externalCandidates = candidateDeals.filter(d => d.vendor_id === null)
      const invites = (await client.query<InviteRow>(
        `select program_identity,program_deal_id,slot_id,expires_at,revoked_at from external_invites
          where wedding_id=$1 and program_identity=any($2::uuid[]) order by program_identity for share`,
        [weddingId, externalCandidates.map(d => d.current_program_invite_id).filter(id => id !== null)],
      )).rows
      const slots = (await client.query<{ id: string; deal_id: string | null }>(
        'select id,deal_id from slots where wedding_id=$1 and id=any($2::uuid[]) order by id for share',
        [weddingId, externalCandidates.map(d => d.slot_id)],
      )).rows
      const deals = (await client.query<DealRow>(
        `select id,slot_id,vendor_id,external_name,current_program_invite_id from deals where wedding_id=$1
          and state in ('booked','paid_deposit','done') order by id for share`, [weddingId],
      )).rows
      if (deals.some(d => d.vendor_id && !vendors.some(v => v.id === d.vendor_id))) throw conflict('program_actors_changed', 'Состав исполнителей изменился — обновите сводку')
      if (deals.some(d => d.vendor_id === null && !externalCandidates.some(c =>
        c.id === d.id && c.slot_id === d.slot_id && c.current_program_invite_id === d.current_program_invite_id))) {
        throw conflict('program_actors_changed', 'Состав исполнителей изменился — обновите сводку')
      }
      const groups = [
        ...vendors.filter(v => deals.some(d => d.vendor_id === v.id)).map(v => ({
          kind: 'registered' as const, id: v.id, name: v.name, userId: v.user_id,
          dealIds: deals.filter(d => d.vendor_id === v.id).map(d => d.id),
        })),
        ...deals.filter(d => d.vendor_id === null).map(d => ({
          kind: 'external' as const, id: d.id, name: d.external_name, userId: null, dealIds: [d.id],
          slotId: d.slot_id, inviteId: d.current_program_invite_id,
        })),
      ]
      const items = []
      const externalExpiry = new Map<string, { expiresAt: Date; latest: Receipt | null }>()
      for (const group of groups) {
        const { payload, digest } = await readProgram(client, weddingId, { snapshot, dealIds: group.dealIds, wedding: wedding.title })
        let current: Receipt | null = null, previousAcknowledgment: Receipt | null = null
        const owner = users.find(u => u.id === group.userId)
        let available = Boolean(owner && !owner.deleted_at)
        if (group.kind === 'registered') {
          const receiptFor = async (matching: boolean): Promise<Receipt | null> => {
            const row = (await client.query<{ version: string; acknowledged_at: Date; name: string | null }>(
              `select a.version::text,a.acknowledged_at,
                    case when u.deleted_at is null then nullif(u.name,'') else null end as name
               from vendor_program_acknowledgments a left join users u on u.id=a.user_id
              where a.wedding_id=$1 and a.vendor_id=$2
                and ${matching ? '' : 'not'} ($6::bool and a.user_id=$3 and a.version=$4 and a.digest=$5)
              order by a.acknowledged_at desc,a.user_id,a.digest limit 1`,
              [weddingId, group.id, group.userId, snapshot.version, digest, Boolean(owner && !owner.deleted_at)],
            )).rows[0]
            return row ? { sourceVersion: row.version, acknowledgedAt: row.acknowledged_at.toISOString(), acknowledgedBy: row.name } : null
          }
          current = await receiptFor(true)
          previousAcknowledgment = await receiptFor(false)
        } else {
          const invite = invites.find(i => i.program_identity === group.inviteId && i.program_deal_id === group.id && i.slot_id === group.slotId)
          available = Boolean(invite && !invite.revoked_at
            && slots.some(s => s.id === group.slotId && s.deal_id === group.id))
          const receiptFor = async (matching: boolean | null): Promise<Receipt | null> => {
            const row = (await client.query<{ version: string; acknowledged_at: Date }>(
              `select a.version::text,a.acknowledged_at from external_program_acknowledgments a
                where a.wedding_id=$1 and a.deal_id=$2
                  and ($7::bool or ${matching ? '' : 'not'} ($6::bool and a.invite_id=$3::uuid and a.version=$4 and a.digest=$5))
                order by a.acknowledged_at desc,a.invite_id,a.digest limit 1`,
              [weddingId, group.id, group.inviteId, snapshot.version, digest, available, matching === null],
            )).rows[0]
            return row ? { sourceVersion: row.version, acknowledgedAt: row.acknowledged_at.toISOString(), acknowledgedBy: null } : null
          }
          current = await receiptFor(true)
          previousAcknowledgment = await receiptFor(false)
          if (invite) externalExpiry.set(group.id, { expiresAt: invite.expires_at, latest: current ? await receiptFor(null) : previousAcknowledgment })
        }
        const blockCount = payload.blocks.length
        const status: Status = blockCount === 0 ? 'unassigned' : !available ? 'unavailable' : current ? 'acknowledged' : 'pending'
        items.push({ kind: group.kind, id: group.id, name: group.name, blockCount, status,
          acknowledgedAt: status === 'acknowledged' ? current!.acknowledgedAt : null,
          acknowledgedBy: status === 'acknowledged' ? current!.acknowledgedBy : null, previousAcknowledgment })
      }
      // A link may expire while another actor/projection/receipt query is waiting.
      const now = (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now
      for (const item of items) {
        const expiry = item.kind === 'external' ? externalExpiry.get(item.id) : undefined
        if (!expiry || now < expiry.expiresAt) continue
        if (item.status !== 'unassigned') item.status = 'unavailable'
        item.acknowledgedAt = null; item.acknowledgedBy = null
        item.previousAcknowledgment = expiry.latest
      }
      reply.header('ETag', timelineETag(snapshot.version)).header('Cache-Control', 'no-store')
      return { sourceVersion: snapshot.version, updatedAt: snapshot.updated_at?.toISOString() ?? null, items }
    })
  })
}
