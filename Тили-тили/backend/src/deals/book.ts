import { AppError, conflict, notFound, unauthorized } from '../errors.js'
import { UUID_ID, isUuid, uuidv7 } from '../ids.js'
import { notifyVendorOfferEvent } from '../offers/notify.js'
import type { Queryable } from '../plugins/db.js'
import { openLead } from '../vendor/leads.js'
import { holdVendorDate } from './repo.js'

export interface BookingContext {
  weddingId: string
  slotId: string
  actorId: string
  date: string | null
  weddingTz: string | null
}

export type BookingPerformer =
  | { kind: 'catalog'; vendorId: string; packageId?: string }
  | {
      kind: 'offer'
      vendorId: string
      packageId: string | null
      packageTitle: string
      packageIncludes: string[]
    }
  | { kind: 'external'; name: string; phone?: string }

/**
 * Общий порядок замков любой двери брони (R-317): свадьба → заявитель → слот.
 *
 * Принятие предложения после этого шага берёт mutex запроса, читает
 * предложение без row lock, а затем вызывает `bookVendor`: подрядчик и живой пакет берутся
 * уже внутри него. Нельзя начинать с запроса/пакета и потом повышать замок
 * свадьбы — перенос даты и стирание аккаунта идут в обратном порядке.
 */
export async function lockBookingContext(
  client: Queryable,
  input: { weddingId: string; slotId: string; actorId: string },
): Promise<BookingContext> {
  const { rows: weddings } = await client.query<{ date: string | null; tz: string | null; archived_at: Date | null; cancelled_at: Date | null }>(
    'select date::text as date, tz, archived_at, cancelled_at from weddings where id = $1 for share',
    [input.weddingId],
  )
  // Access may have been checked before waiting for a concurrent cancellation.
  if (!weddings[0] || weddings[0].archived_at || weddings[0].cancelled_at) throw notFound('Свадьба не найдена')

  const { rows: users } = await client.query<{ deleted_at: Date | null }>(
    'select deleted_at from users where id = $1 for share',
    [input.actorId],
  )
  if (!users[0] || users[0].deleted_at) throw unauthorized('Аккаунт удалён')

  if (!isUuid(input.slotId)) throw notFound('Слот не найден')
  const { rows: slots } = await client.query<{ deal_id: string | null }>(
    'select deal_id from slots where id = $1 and wedding_id = $2 for update',
    [input.slotId, input.weddingId],
  )
  if (!slots[0]) throw notFound('Слот не найден')
  if (slots[0].deal_id) throw conflict('slot_taken', 'В этом слоте уже есть сделка — сначала отмените её')

  return {
    ...input,
    date: weddings[0].date,
    weddingTz: weddings[0].tz,
  }
}

interface PackageSnapshot {
  name: string
  items: string[]
}

async function lockLiveVendor(client: Queryable, vendorId: string, forOffer = false): Promise<void> {
  /* Замок пользователя подрядчика сериализует бронь со стиранием аккаунта.
   * Анкета должна быть опубликована и не заблокирована — как в каталоге. */
  const { rows: vendors } = await client.query<{ id: string }>(
    `select v.id from vendors v join users u on u.id = v.user_id and u.deleted_at is null
      where v.id = $1 and v.published_at is not null and v.blocked_at is null
      for share of u, v`,
    [vendorId],
  )
  if (!vendors[0]) {
    if (forOffer) throw conflict('vendor_unavailable', 'Анкета подрядчика недоступна')
    throw notFound('Подрядчик не найден')
  }
}

async function liveCatalogTerms(
  client: Queryable,
  performer: Extract<BookingPerformer, { kind: 'catalog' }>,
): Promise<PackageSnapshot | null> {
  await lockLiveVendor(client, performer.vendorId)
  if (performer.packageId === undefined) return null
  const validId = new RegExp(UUID_ID.pattern).test(performer.packageId)
  const { rows: packages } = validId
    ? await client.query<PackageSnapshot>(
        `select name, items from vendor_packages
          where id = $1 and vendor_id = $2
          for key share`,
        [performer.packageId, performer.vendorId],
      )
    : { rows: [] as PackageSnapshot[] }
  if (!packages[0]) {
    throw new AppError(422, 'unknown_package', 'Такого пакета у подрядчика нет', {
      packageId: 'пакет не найден у этого подрядчика',
    })
  }
  return packages[0]
}

async function closeSlotRequests(
  client: Queryable,
  context: BookingContext,
  selectedVendorId: string | null,
): Promise<void> {
  const { rows } = await client.query<{
    id: string
    close_reason: 'booked' | 'booked_other'
    vendor_user_id: string | null
  }>(
    `with targets as (
       select id from offer_requests
        where slot_id = $1 and status = 'open'
        order by id
        for update
     ), closed as (
       update offer_requests r
          set status = 'closed',
              close_reason = case when r.vendor_id = $2 then 'booked' else 'booked_other' end,
              closed_at = now()
         from targets t
        where r.id = t.id
        returning r.id, r.vendor_id, r.close_reason
     )
     select c.id, c.close_reason, v.user_id as vendor_user_id
       from closed c left join vendors v on v.id = c.vendor_id
      order by c.id`,
    [context.slotId, selectedVendorId],
  )

  for (const row of rows) {
    if (row.close_reason !== 'booked_other' || !row.vendor_user_id) continue
    await notifyVendorOfferEvent(client, row.vendor_user_id, context.weddingTz, 'booked_other')
  }
}

/**
 * Единственное ядро записи брони для каталога, своего подрядчика и
 * принятия предложения. Вызывающий обязан сначала взять `BookingContext`.
 */
export async function bookVendor(
  client: Queryable,
  context: BookingContext,
  input: { performer: BookingPerformer; price: number },
): Promise<string> {
  // Слот уже заперт; запросы идут до подрядчика и пакета по общему порядку R-317.
  await closeSlotRequests(
    client,
    context,
    input.performer.kind === 'external' ? null : input.performer.vendorId,
  )
  const terms =
    input.performer.kind === 'catalog'
      ? await liveCatalogTerms(client, input.performer)
      : input.performer.kind === 'offer'
        ? { name: input.performer.packageTitle, items: input.performer.packageIncludes }
        : null
  let packageId = input.performer.kind === 'external' ? null : input.performer.packageId ?? null
  if (input.performer.kind === 'offer') {
    await lockLiveVendor(client, input.performer.vendorId, true)
    // The live package is optional: the agreed terms belong to the offer snapshot.
    // Lock a surviving FK target before writing offers, never the opposite order.
    if (packageId) {
      const { rows } = await client.query<{ id: string }>(
        'select id from vendor_packages where id = $1 and vendor_id = $2 for key share',
        [packageId, input.performer.vendorId],
      )
      packageId = rows[0]?.id ?? null
    }
  }

  const dealId = uuidv7()

  if (input.performer.kind !== 'external') {
    await client.query(
      `insert into deals (
         id, wedding_id, slot_id, vendor_id, state, price, currency, booked_at,
         package_id, package_title_snapshot, package_includes_snapshot)
       values ($1, $2, $3, $4, 'booked', $5, 'RUB', now(), $6, $7, $8)`,
      [
        dealId,
        context.weddingId,
        context.slotId,
        input.performer.vendorId,
        input.price,
        packageId,
        terms?.name ?? null,
        terms ? JSON.stringify(terms.items) : null,
      ],
    )
  } else {
    await client.query(
      `insert into deals (
         id, wedding_id, slot_id, external_name, external_phone, state, price, currency, booked_at)
       values ($1, $2, $3, $4, $5, 'booked', $6, 'RUB', now())`,
      [dealId, context.weddingId, context.slotId, input.performer.name, input.performer.phone ?? null, input.price],
    )
  }

  // 018 prebooked и 019 booking должны оставаться одной атомарной операцией:
  // сделка и отметка «уже забронировано вне приложения» одновременно запрещены CHECK базы.
  const taken = await client.query(
    'update slots set deal_id = $2, prebooked_at = null where id = $1 and deal_id is null',
    [context.slotId, dealId],
  )
  if (taken.rowCount === 0) {
    throw conflict('slot_taken', 'В этом слоте уже есть сделка — сначала отмените её')
  }
  await client.query(
    `insert into deal_events (id, deal_id, from_state, to_state, actor_id)
     values ($1, $2, null, 'booked', $3)`,
    [uuidv7(), dealId, context.actorId],
  )

  // Любая новая сделка закрывает прежние ссылки своего подрядчика в слоте.
  await client.query('update external_invites set revoked_at = now() where slot_id = $1 and revoked_at is null', [
    context.slotId,
  ])

  if (input.performer.kind !== 'external') {
    await openLead(client, context.weddingId, input.performer.vendorId, null, true)
    if (context.date) {
      await holdVendorDate(client, input.performer.vendorId, context.date, dealId, context.weddingId)
    }
  } else {
    await client.query(
      `insert into chats (id, wedding_id, kind, slot_id, deal_id)
       values ($1, $2, 'external', $3, $4)`,
      [uuidv7(), context.weddingId, context.slotId, dealId],
    )
  }

  return dealId
}
