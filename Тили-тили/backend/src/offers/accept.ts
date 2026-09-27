import { bookVendor, lockBookingContext } from '../deals/book.js'
import { loadSlot } from '../deals/repo.js'
import { conflict, forbidden, notFound } from '../errors.js'
import { isUuid } from '../ids.js'
import type { Queryable } from '../plugins/db.js'

/** R-317: wedding → actor → slot → requests → vendor → package → offer.
 * The request is the response/accept mutex. Never lock an offer before its
 * package: ON DELETE SET NULL takes the opposite order on package removal. */
export async function acceptOffer(
  client: Queryable,
  input: { weddingId: string; actorId: string; offerId: string },
) {
  if (!isUuid(input.offerId)) throw notFound('Предложение не найдено')
  const { rows: found } = await client.query<{ slot_id: string; request_id: string }>(
    `select r.slot_id, r.id as request_id from offers o
       join offer_requests r on r.id = o.request_id
       join slots s on s.id = r.slot_id
      where o.id = $1 and s.wedding_id = $2`,
    [input.offerId, input.weddingId],
  )
  if (!found[0]) throw notFound('Предложение не найдено')
  const context = await lockBookingContext(client, { ...input, slotId: found[0].slot_id })
  // Recheck membership under the wedding lock, not only in the HTTP hook.
  const { rows: members } = await client.query<{ role: string }>(
    'select role from wedding_members where wedding_id = $1 and user_id = $2',
    [input.weddingId, input.actorId],
  )
  if (members[0]?.role !== 'couple') throw forbidden('Принять предложение может только пара')

  // Lock ALL requests in id order, just like bookVendor. Taking only the
  // selected one first would reverse the order for two different offers.
  await client.query('select id from offer_requests where slot_id = $1 order by id for update', [context.slotId])
  const { rows } = await client.query<{
    status: string; close_reason: string | null; vendor_id: string | null
    wedding_date: string | null; kind: string; package_id: string | null
    title: string | null; price: string | null; includes: string[]
    superseded_at: Date | null; accepted_at: Date | null; expired: boolean
  }>(
    `select r.status, r.close_reason, r.vendor_id, r.wedding_date::text,
            o.kind, o.package_id, o.title, o.price::text, o.includes,
            o.superseded_at, o.accepted_at,
            (o.valid_until < (now() at time zone $3)::date) as expired
       from offers o join offer_requests r on r.id = o.request_id
      where o.id = $1 and r.id = $2`,
    [input.offerId, found[0].request_id, context.weddingTz ?? 'Europe/Moscow'],
  )
  const offer = rows[0]
  if (!offer) throw notFound('Предложение не найдено')
  if (offer.wedding_date !== context.date || offer.close_reason === 'date_changed') {
    throw conflict('offer_stale_date', 'Предложение на прежнюю дату — запросите новое')
  }
  if (offer.status !== 'open') throw conflict('request_closed', 'Запрос предложения закрыт')
  if (offer.superseded_at) throw conflict('offer_superseded', 'Подрядчик обновил предложение')
  if (offer.accepted_at) throw conflict('offer_accepted', 'Предложение уже принято')
  if (offer.kind !== 'offer') throw conflict('offer_declined', 'Подрядчик отказался от запроса')
  if (offer.expired) throw conflict('offer_expired', 'Срок предложения истёк')
  if (!offer.vendor_id) throw conflict('vendor_unavailable', 'Анкета подрядчика недоступна')
  // Database constraints guarantee title/price for kind=offer; do not accept
  // a caller-supplied amount or read mutable catalog terms here.
  const dealId = await bookVendor(client, context, {
    performer: { kind: 'offer', vendorId: offer.vendor_id, packageId: offer.package_id,
      packageTitle: offer.title!, packageIncludes: offer.includes },
    price: Number(offer.price),
  })
  await client.query('update offers set accepted_at = now(), deal_id = $2 where id = $1', [input.offerId, dealId])
  return loadSlot(client, context.slotId, true)
}
