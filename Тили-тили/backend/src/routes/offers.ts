import type { FastifyInstance } from 'fastify'
import { withIdempotency } from '../deals/idempotency.js'
import { AppError, conflict, notFound, quotaExceeded, unauthorized, validationFailed } from '../errors.js'
import { isUuid, UUID_ID, uuidv7 } from '../ids.js'
import { notifyVendorOfferEvent } from '../offers/notify.js'
import type { Queryable } from '../plugins/db.js'

interface OfferRequestBody {
  entryIds: string[]
  wishes?: string
  budgetHint?: { amount: number; currency: 'RUB' }
}

type RequestFailure =
  | 'not_shortlisted'
  | 'busy'
  | 'already_open'
  | 'unavailable'
  | 'category_changed'

type RequestResult =
  | { entryId: string; status: 'sent'; requestId: string }
  | { entryId: string; status: RequestFailure }

interface WeddingSnapshot {
  date: string | null
  guests_planned: number | null
  city: string | null
  tz: string | null
  archived_at: Date | null
  cancelled_at: Date | null
}

interface RequestedCandidate {
  entry_id: string
  vendor_id: string | null
}

interface LockedVendor {
  id: string
  user_id: string
  category_id: string
  deleted_at: Date | null
  published_at: Date | null
  blocked_at: Date | null
}

async function lockWedding(client: Queryable, weddingId: string): Promise<WeddingSnapshot> {
  const { rows } = await client.query<WeddingSnapshot>(
    `select w.date::text as date, w.guests_planned, c.name as city, w.tz,
            w.archived_at, w.cancelled_at
       from weddings w left join cities c on c.id = w.city_id
      where w.id = $1
      for update of w`,
    [weddingId],
  )
  const wedding = rows[0]
  if (!wedding || wedding.archived_at) throw notFound('Свадьба не найдена')
  if (wedding.cancelled_at) {
    throw conflict('wedding_cancelled', 'Свадьба отменена — запросы предложений отправлять нельзя')
  }
  return wedding
}

async function lockActor(client: Queryable, userId: string): Promise<void> {
  const { rows } = await client.query<{ deleted_at: Date | null }>(
    'select deleted_at from users where id = $1 for share',
    [userId],
  )
  if (!rows[0] || rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
}

async function lockSlot(
  client: Queryable,
  weddingId: string,
  slotId: string,
): Promise<{ id: string; category_id: string }> {
  if (!isUuid(slotId)) throw notFound('Слот не найден')
  const { rows } = await client.query<{ id: string; category_id: string }>(
    'select id, category_id from slots where id = $1 and wedding_id = $2 for update',
    [slotId, weddingId],
  )
  if (!rows[0]) throw notFound('Слот не найден')
  return rows[0]
}

async function recentRequestCount(client: Queryable, weddingId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int as n
       from offer_requests r join slots s on s.id = r.slot_id
      where s.wedding_id = $1 and r.created_at >= now() - interval '24 hours'`,
    [weddingId],
  )
  return rows[0]?.n ?? 0
}

function requestLimit(): AppError {
  return quotaExceeded(
    'offer_requests_limit',
    'За 24 часа для одной свадьбы можно отправить не больше десяти запросов предложений',
  )
}

export async function offerRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.post(
    '/weddings/:weddingId/slots/:slotId/offer-requests',
    {
      schema: {
        body: {
          type: 'object',
          required: ['entryIds'],
          additionalProperties: false,
          properties: {
            entryIds: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              uniqueItems: true,
              items: UUID_ID,
            },
            wishes: { type: 'string', maxLength: 2000 },
            budgetHint: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const weddingId = request.member!.weddingId
      const actorId = request.caller!.userId
      const { slotId } = request.params as { slotId: string }
      const body = request.body as OfferRequestBody
      const normalizedEntryIds = body.entryIds.map((entryId) => entryId.toLowerCase())
      // PostgreSQL UUID регистронезависим, а JSON Schema uniqueItems — нет:
      // A… и a… иначе прошли бы как два элемента одной и той же записи.
      if (new Set(normalizedEntryIds).size !== normalizedEntryIds.length) {
        throw validationFailed({ entryIds: 'идентификаторы кандидатов не должны повторяться' })
      }

      return withIdempotency(db(), request, reply, 'offer-requests.create', (tx) =>
        tx<unknown>(async (client) => {
          /* Квота принадлежит свадьбе, поэтому эксклюзивный замок свадьбы —
           * первый. Два запроса после девяти увидят 9 и 10 последовательно,
           * а не оба создадут «десятую» строку. */
          const wedding = await lockWedding(client, weddingId)
          await lockActor(client, actorId)
          const slot = await lockSlot(client, weddingId, slotId)

          const recent = await recentRequestCount(client, weddingId)
          // Replay уже вернулся из withIdempotency; новый ключ при полном
          // окне получает 429 даже если один из адресатов уже открыт.
          if (recent >= 10) throw requestLimit()

          const { rows: candidates } = await client.query<RequestedCandidate>(
            `select ss.id as entry_id, ss.vendor_id
               from slot_shortlist ss
              where ss.slot_id = $1 and ss.id = any($2::uuid[])`,
            [slotId, normalizedEntryIds],
          )
          const byEntry = new Map(candidates.map((row) => [row.entry_id, row]))
          const vendorIds = [...new Set(candidates.flatMap((row) => (row.vendor_id ? [row.vendor_id] : [])))].sort()

          /* Общий порядок R-317: запросы до подрядчиков. Сортировка делает
           * порядок одинаковым у batch с entryIds в любом порядке. */
          const { rows: openRequests } = await client.query<{ id: string; vendor_id: string }>(
            `select id, vendor_id from offer_requests
              where slot_id = $1 and vendor_id = any($2::uuid[]) and status = 'open'
              order by id for update`,
            [slotId, vendorIds],
          )
          const openByVendor = new Map(openRequests.map((row) => [row.vendor_id, row.id]))

          const { rows: vendors } = await client.query<LockedVendor>(
            `select v.id, v.user_id, v.category_id, u.deleted_at, v.published_at, v.blocked_at
               from vendors v join users u on u.id = v.user_id
              where v.id = any($1::uuid[])
              order by v.id
              for share of u, v`,
            [vendorIds],
          )
          const byVendor = new Map(vendors.map((row) => [row.id, row]))

          const busyVendors = new Set<string>()
          if (wedding.date && vendorIds.length > 0) {
            const { rows: busy } = await client.query<{ vendor_id: string }>(
              `select b.vendor_id
                 from vendor_busy_dates b
                where b.vendor_id = any($1::uuid[]) and b.date = $2::date
                  and not exists (
                    select 1 from deals mine
                     where mine.id = b.deal_id and mine.wedding_id = $3
                  )
                order by b.vendor_id`,
              [vendorIds, wedding.date, weddingId],
            )
            for (const row of busy) busyVendors.add(row.vendor_id)
          }

          const failures = new Map<string, RequestFailure>()
          const eligible: { entryId: string; vendor: LockedVendor }[] = []
          for (const entryId of body.entryIds) {
            const candidate = byEntry.get(entryId.toLowerCase())
            if (!candidate) {
              failures.set(entryId, 'not_shortlisted')
              continue
            }
            const vendor = candidate.vendor_id ? byVendor.get(candidate.vendor_id) : undefined
            if (!vendor || vendor.deleted_at || !vendor.published_at || vendor.blocked_at) {
              failures.set(entryId, 'unavailable')
              continue
            }
            if (vendor.category_id !== slot.category_id) {
              failures.set(entryId, 'category_changed')
              continue
            }
            if (openByVendor.has(vendor.id)) {
              failures.set(entryId, 'already_open')
              continue
            }
            if (busyVendors.has(vendor.id)) {
              failures.set(entryId, 'busy')
              continue
            }
            eligible.push({ entryId, vendor })
          }

          // Batch неделим относительно квоты: не выбираем «первых, кому
          // хватило», иначе перестановка entryIds меняла бы адресатов.
          if (recent + eligible.length > 10) throw requestLimit()

          const requestByEntry = new Map<string, string>()
          for (const item of [...eligible].sort((a, b) => a.vendor.id.localeCompare(b.vendor.id))) {
            const requestId = uuidv7()
            await client.query(
              `insert into offer_requests (
                 id, slot_id, vendor_id, wedding_date, guests, city, wishes,
                 budget_hint, currency, created_by
               ) values ($1, $2, $3, $4::date, $5, $6, $7, $8, 'RUB', $9)`,
              [
                requestId,
                slotId,
                item.vendor.id,
                wedding.date,
                wedding.guests_planned,
                wedding.city,
                body.wishes ?? null,
                body.budgetHint?.amount ?? null,
                actorId,
              ],
            )
            await notifyVendorOfferEvent(client, item.vendor.user_id, wedding.tz, 'created')
            requestByEntry.set(item.entryId, requestId)
          }

          const results: RequestResult[] = body.entryIds.map((entryId) => {
            const requestId = requestByEntry.get(entryId)
            if (requestId) return { entryId, status: 'sent', requestId }
            return { entryId, status: failures.get(entryId)! }
          })

          if (eligible.length === 0) {
            return {
              status: 409,
              body: {
                error: {
                  code: 'no_request_sent',
                  message: 'Ни одному из выбранных кандидатов запрос не отправлен',
                  details: { results },
                },
              },
            }
          }
          return { status: 201, body: { results } }
        }),
      )
    },
  )
}
