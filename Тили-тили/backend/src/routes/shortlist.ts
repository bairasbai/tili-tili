import type { OfferComparisonTerms } from '../offers/comparison-terms.js'
import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, unauthorized, validationFailed } from '../errors.js'
import { isUuid, UUID_ID, uuidv7 } from '../ids.js'
import { notifyVendorOfferEvent } from '../offers/notify.js'
import type { Queryable } from '../plugins/db.js'
import { publicRating } from '../reviews/rating.js'
import type { Role } from '../wedding/access.js'

type Occupancy = 'free' | 'held' | 'busy' | null

interface PackageJson {
  id: string
  name: string
  price: string | null
  currency: string
  includes: string[]
}

interface ShortlistRow {
  id: string
  slot_id: string
  position: number
  shortlisted_at: Date
  vendor_id: string | null
  vendor_name: string | null
  vendor_category_id: string | null
  city: string | null
  price_from: string | null
  currency: string | null
  rating: string | null
  reviews_count: number | null
  couple_reviews_count: number | null
  photo_url: string | null
  verified_at: Date | null
  has_video: boolean
  booking_mode: 'legacy_day' | 'resources'
  packages: PackageJson[]
  profile_live: boolean | null
  available: boolean | null
  occupancy: Occupancy
  availability_date: string | null
  availability_checked_at: Date
  request_id: string | null
  request_status: 'open' | 'closed' | null
  request_close_reason:
    | 'removed'
    | 'booked_other'
    | 'booked'
    | 'wedding_cancelled'
    | 'date_changed'
    | 'vendor_erased'
    | null
  request_wedding_date: string | null
  request_guests: number | null
  request_city: string | null
  request_wishes: string | null
  request_budget_hint: string | null
  request_currency: string | null
  request_created_at: Date | null
  offer_id: string | null
  offer_kind: 'offer' | 'decline' | null
  offer_package_id: string | null
  offer_title: string | null
  offer_price: string | null
  offer_currency: string | null
  offer_includes: string[] | null
  offer_message: string | null
  offer_valid_until: string | null
  offer_comparison_terms: OfferComparisonTerms | null
}

interface OfferView {
  id: string
  requestId: string
  kind: 'offer' | 'decline'
  packageId: string | null
  title: string | null
  price: { amount: number; currency: string } | null
  includes: string[]
  message: string | null
  validUntil: string | null
  comparisonTerms: OfferComparisonTerms | null
}

interface OfferRequestView {
  id: string
  status: 'open' | 'closed'
  closeReason?: NonNullable<ShortlistRow['request_close_reason']>
  weddingDate: string | null
  guests: number | null
  city: string | null
  wishes: string | null
  createdAt: string
  budgetHint?: { amount: number; currency: string }
  offer?: OfferView
}

export interface ShortlistEntry {
  id: string
  slotId: string
  position: number
  createdAt: string
  available: boolean | null
  occupancy: Occupancy
  availabilityObservation: { source: 'legacy_day'; date: string; checkedAt: string } | null
  vendor: {
    id: string
    name: string
    categoryId: string
    city: string | null
    priceFrom: { amount: number; currency: string } | null
    rating: number | null
    reviewsCount: number
    photoUrl: string | null
    verified: boolean
    hasVideo: boolean
    bookingMode?: 'legacy_day' | 'resources'
    packages: {
      id: string
      name: string
      price: { amount: number; currency: string } | null
      includes: string[]
    }[]
  } | null
  request?: OfferRequestView | { status: 'pending' | 'responded' }
}

function toEntry(row: ShortlistRow, role: Role): ShortlistEntry {
  const publicProfile = row.profile_live === true
  const vendor =
    row.vendor_id === null
      ? null
      : {
          id: row.vendor_id,
          name: row.vendor_name!,
          categoryId: row.vendor_category_id!,
          city: row.city,
          priceFrom:
            publicProfile && row.price_from !== null
              ? { amount: Number(row.price_from), currency: row.currency! }
              : null,
          rating: publicProfile
            ? publicRating(row.rating === null ? null : Number(row.rating), row.couple_reviews_count ?? 0)
            : null,
          reviewsCount: row.reviews_count ?? 0,
          photoUrl: publicProfile ? row.photo_url : null,
          verified: row.verified_at !== null,
          hasVideo: publicProfile && row.has_video,
          ...(publicProfile ? { bookingMode: row.booking_mode } : {}),
          packages: publicProfile
            ? row.packages.map((p) => ({
                id: p.id,
                name: p.name,
                price: p.price === null ? null : { amount: Number(p.price), currency: p.currency },
                includes: p.includes,
              }))
            : [],
        }
  const entry: ShortlistEntry = {
    id: row.id,
    slotId: row.slot_id,
    position: row.position,
    createdAt: row.shortlisted_at.toISOString(),
    available: row.available,
    occupancy: row.occupancy,
    availabilityObservation: publicProfile && row.available === true && row.booking_mode === 'legacy_day'
      && row.availability_date && row.occupancy !== null
      ? { source: 'legacy_day', date: row.availability_date, checkedAt: row.availability_checked_at.toISOString() } : null,
    vendor,
  }
  if (row.request_id && row.request_status && row.request_created_at) {
    if (role !== 'couple') {
      entry.request = { status: row.offer_id ? 'responded' : 'pending' }
    } else {
      const offer: OfferView | undefined = row.offer_id && row.offer_kind
        ? {
            id: row.offer_id,
            requestId: row.request_id,
            kind: row.offer_kind,
            packageId: row.offer_package_id,
            title: row.offer_title,
            price: row.offer_price === null
              ? null
              : { amount: Number(row.offer_price), currency: row.offer_currency! },
            includes: row.offer_includes ?? [],
            message: row.offer_message,
            validUntil: row.offer_valid_until,
            comparisonTerms: row.offer_comparison_terms ?? null,
          }
        : undefined
      const full: OfferRequestView = {
        id: row.request_id,
        status: row.request_status,
        weddingDate: row.request_wedding_date,
        guests: row.request_guests,
        city: row.request_city,
        wishes: row.request_wishes,
        createdAt: row.request_created_at.toISOString(),
      }
      if (row.request_close_reason) full.closeReason = row.request_close_reason
      if (row.request_budget_hint !== null) {
        full.budgetHint = {
          amount: Number(row.request_budget_hint),
          currency: row.request_currency!,
        }
      }
      if (offer) full.offer = offer
      entry.request = full
    }
  }
  return entry
}

/**
 * Кандидаты места одним запросом, включая публичные пакеты и занятость.
 *
 * `available = null` означает обезличенный tombstone после стирания
 * подрядчика. `false` оставляет карточку на месте, но запрещает новые
 * действия: анкета скрыта/заблокирована либо подрядчик сменил категорию.
 *
 * Своя подтверждённая бронь этой свадьбы — `free`: экран отвечает на вопрос
 * «можем ли МЫ продолжать с этим подрядчиком», а не повторяет публичный
 * календарь, где дата закономерно занята этой же парой.
 */
export async function loadShortlist(
  client: Queryable,
  weddingId: string,
  slotId: string,
  role: Role,
): Promise<ShortlistEntry[]> {
  const { rows } = await client.query<ShortlistRow>(
    `select ss.id, ss.slot_id, ss.position, ss.created_at as shortlisted_at,
            v.id as vendor_id, v.name as vendor_name, v.category_id as vendor_category_id,
            c.name as city, v.price_from::text as price_from, v.currency,
            v.rating::text as rating, v.reviews_count, v.couple_reviews_count,
            v.photo_url, v.verified_at,
            exists (select 1 from vendor_media m where m.vendor_id = v.id and m.kind = 'video') as has_video,
            coalesce((select p.mode from vendor_availability_policy p where p.vendor_id=v.id), 'legacy_day') as booking_mode,
            coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', p.id,
                       'name', p.name,
                       'price', p.price::text,
                       'currency', p.currency,
                       'includes', p.items
                     ) order by p.sort, p.name, p.id)
                from vendor_packages p
               where p.vendor_id = v.id
            ), '[]'::jsonb) as packages,
            case when v.id is null then null
                 else u.deleted_at is null
                  and v.published_at is not null
                  and v.blocked_at is null
             end as profile_live,
            case when v.id is null then null
                 else u.deleted_at is null
                  and v.published_at is not null
                  and v.blocked_at is null
                  and v.category_id = s.category_id
             end as available,
            case
              when v.id is null or w.date is null
                or exists(select 1 from vendor_availability_policy p where p.vendor_id=v.id and p.mode='resources') then null
              when exists (
                select 1 from vendor_busy_dates b
                  join deals mine on mine.id = b.deal_id
                 where b.vendor_id = v.id and b.date = w.date
                   and mine.wedding_id = w.id
              ) then 'free'
              when exists (
                select 1 from vendor_busy_dates b
                 where b.vendor_id = v.id and b.date = w.date
              ) then 'busy'
              when exists (
                select 1 from deals held
                  join weddings held_wedding on held_wedding.id = held.wedding_id
                 where held.vendor_id = v.id
                   and held.wedding_id <> w.id
                   and held.state = 'negotiating'
                   and held.negotiating_until is not null
                   and held.negotiating_until > now()
                   and held_wedding.date = w.date
                   and held_wedding.archived_at is null
                   and held_wedding.cancelled_at is null
              ) then 'held'
              else 'free'
            end as occupancy,
             w.date::text as availability_date, clock_timestamp() as availability_checked_at,
            request.id as request_id, request.status as request_status,
            request.close_reason as request_close_reason,
            request.wedding_date::text as request_wedding_date,
            request.guests as request_guests, request.city as request_city,
            request.wishes as request_wishes,
            request.budget_hint::text as request_budget_hint,
            request.currency as request_currency,
            request.created_at as request_created_at,
            answer.id as offer_id, answer.kind as offer_kind,
            answer.package_id as offer_package_id, answer.title as offer_title,
            answer.price::text as offer_price, answer.currency as offer_currency,
            answer.includes as offer_includes, answer.message as offer_message,
            answer.valid_until::text as offer_valid_until, answer.comparison_terms as offer_comparison_terms
       from slot_shortlist ss
       join slots s on s.id = ss.slot_id
       join weddings w on w.id = s.wedding_id
       left join vendors v on v.id = ss.vendor_id
       left join users u on u.id = v.user_id
       left join cities c on c.id = v.city_id
       left join lateral (
         select r.id, r.status, r.close_reason, r.wedding_date, r.guests,
                r.city, r.wishes, r.budget_hint, r.currency, r.created_at
           from offer_requests r
          where r.slot_id = ss.slot_id and r.vendor_id = ss.vendor_id
          order by r.created_at desc, r.id desc
          limit 1
       ) request on true
       left join lateral (
         select o.id, o.kind, o.package_id, o.title, o.price, o.currency,
                o.includes, o.message, o.valid_until, o.comparison_terms
           from offers o
          where o.request_id = request.id and o.superseded_at is null
          order by o.created_at desc, o.id desc
          limit 1
       ) answer on true
      where ss.slot_id = $1 and s.wedding_id = $2
      order by ss.position, ss.id`,
    [slotId, weddingId],
  )
  return rows.map((row) => toEntry(row, role))
}

async function assertSlot(
  client: Queryable,
  weddingId: string,
  slotId: string,
  lock = false,
): Promise<{ id: string; category_id: string }> {
  if (!isUuid(slotId)) throw notFound('Слот не найден')
  const { rows } = await client.query<{ id: string; category_id: string }>(
    `select id, category_id from slots where id = $1 and wedding_id = $2${lock ? ' for update' : ''}`,
    [slotId, weddingId],
  )
  if (!rows[0]) throw notFound('Слот не найден')
  return rows[0]
}

async function lockWritableWedding(client: Queryable, weddingId: string): Promise<string | null> {
  const { rows } = await client.query<{ archived_at: Date | null; cancelled_at: Date | null; tz: string | null }>(
    'select archived_at, cancelled_at, tz from weddings where id = $1 for update',
    [weddingId],
  )
  if (!rows[0] || rows[0].archived_at) throw notFound('Свадьба не найдена')
  if (rows[0].cancelled_at) throw conflict('wedding_cancelled', 'Свадьба отменена — кандидатов менять нельзя')
  return rows[0].tz
}

async function lockActor(client: Queryable, userId: string): Promise<void> {
  const { rows } = await client.query<{ deleted_at: Date | null }>(
    'select deleted_at from users where id = $1 for share',
    [userId],
  )
  if (!rows[0] || rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
}

interface CandidateVendor {
  category_id: string
  category_name: string
  live: boolean
}

interface ReplaceCandidateBody {
  replaceEntryId?: string
}

export function readReplaceEntryId(body: unknown): string | undefined {
  // PUT without a body predates atomic replacement and remains valid.
  if (body === undefined) return undefined
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw validationFailed({ body: 'ожидается JSON-объект' })
  }
  const candidate = body as Record<string, unknown>
  const unexpected = Object.keys(candidate).find((key) => key !== 'replaceEntryId')
  if (unexpected) throw validationFailed({ [unexpected]: 'неизвестное поле' })
  if (candidate.replaceEntryId === undefined) return undefined
  if (typeof candidate.replaceEntryId !== 'string' || !isUuid(candidate.replaceEntryId)) {
    throw validationFailed({ replaceEntryId: 'ожидается UUID записи кандидата' })
  }
  return candidate.replaceEntryId
}

async function closeOpenRequestsForRemoval(
  client: Queryable,
  slotId: string,
  vendorId: string | null,
  role: string,
  weddingTz: string | null,
): Promise<void> {
  const { rows: requests } = vendorId
    ? await client.query<{ id: string; vendor_user_id: string | null }>(
        `select r.id, v.user_id as vendor_user_id
           from offer_requests r left join vendors v on v.id = r.vendor_id
          where r.slot_id = $1 and r.vendor_id = $2 and r.status = 'open'
          order by r.id for update of r`,
        [slotId, vendorId],
      )
    : { rows: [] as { id: string; vendor_user_id: string | null }[] }
  if (requests.length > 0 && role !== 'couple') {
    throw conflict('request_open', 'У кандидата есть открытый запрос — его может отозвать только пара')
  }
  if (requests.length > 0) {
    await client.query(
      `update offer_requests
          set status = 'closed', close_reason = 'removed', closed_at = now()
        where id = any($1::uuid[])`,
      [requests.map((row) => row.id)],
    )
    for (const row of requests) {
      if (row.vendor_user_id) {
        await notifyVendorOfferEvent(client, row.vendor_user_id, weddingTz, 'removed')
      }
    }
  }
}

async function readCandidateVendor(
  client: Queryable,
  vendorId: string,
  lock: boolean,
): Promise<CandidateVendor | null> {
  const { rows } = await client.query<CandidateVendor>(
    `select v.category_id, c.name as category_name,
            (u.deleted_at is null and v.published_at is not null and v.blocked_at is null) as live
       from vendors v
       join users u on u.id = v.user_id
       join categories c on c.id = v.category_id
      where v.id = $1${lock ? ' for share of u, v' : ''}`,
    [vendorId],
  )
  return rows[0] ?? null
}

export async function shortlistRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  app.get('/weddings/:weddingId/slots/:slotId/shortlist', async (request) => {
    const weddingId = request.member!.weddingId
    const { slotId } = request.params as { slotId: string }
    await assertSlot(db(), weddingId, slotId)
    return loadShortlist(db(), weddingId, slotId, request.member!.role)
  })

  app.put('/weddings/:weddingId/shortlist/:vendorId', {
    /* Fastify валидирует `body: { type: object }` как обязательное.
     * Пустой объект сохраняет старый PUT без body, а схема всё так же
     * проверяет тип, UUID и лишние поля у переданного JSON. */
    preValidation: async (request) => {
      if (request.body === undefined) request.body = {}
    },
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { replaceEntryId: UUID_ID },
      },
    },
  }, async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { vendorId } = request.params as { vendorId: string }
    const replaceEntryId = readReplaceEntryId(request.body as ReplaceCandidateBody | undefined)
    if (!isUuid(vendorId)) throw conflict('vendor_unavailable', 'Анкета недоступна')

    const result = await db().tx(async (client) => {
      /* Первый замок — свадьба. И этот путь, и `POST …/slots`
       * заводят место после него: два одновременных добавления
       * категории не создадут два слота. */
      const weddingTz = await lockWritableWedding(client, weddingId)
      await lockActor(client, request.caller!.userId)

      /* Категория нужна, чтобы найти слот, но замок подрядчика до слота
       * нарушил бы общий порядок R-317. Поэтому сначала безблокировочная
       * подсказка, а после замка слота — повторная проверка под замком. */
      const hint = await readCandidateVendor(client, vendorId, false)
      if (!hint?.live) throw conflict('vendor_unavailable', 'Анкета недоступна')

      const { rows: slots } = await client.query<{ id: string }>(
        `select id from slots
          where wedding_id = $1 and category_id = $2
          order by sort, id limit 1`,
        [weddingId, hint.category_id],
      )
      let slotId = slots[0]?.id
      if (!slotId) {
        if (request.member!.role !== 'couple') {
          const locked = await readCandidateVendor(client, vendorId, true)
          if (!locked?.live || locked.category_id !== hint.category_id) {
            throw conflict('vendor_unavailable', 'Анкета недоступна')
          }
          throw conflict('slot_missing', 'Сначала пара должна добавить это место в свадьбу')
        }
        slotId = uuidv7()
        await client.query(
          `insert into slots (id, wedding_id, category_id, label, sort)
           values ($1, $2, $3, $4,
             (select coalesce(max(sort), 0) + 1 from slots where wedding_id = $2))`,
          [slotId, weddingId, hint.category_id, hint.category_name],
        )
      }

      // Свадьба сериализует создание места, слот — выбор позиции 1…3.
      await assertSlot(client, weddingId, slotId, true)
      /* Замок анкеты берём только в той ветке, где он уже последний
       * по общему порядку request → offer → vendor → package. Для замены
       * сначала блокируем/закрываем открытый запрос удаляемого кандидата.
       * Проверка под замком нужна перед вставкой: смена категории или стирание
       * аккаунта тогда откатывают всю транзакцию. */
      const lockLiveVendor = async () => {
        const vendor = await readCandidateVendor(client, vendorId, true)
        if (!vendor?.live || vendor.category_id !== hint.category_id) {
          throw conflict('vendor_unavailable', 'Анкета недоступна')
        }
      }
      const { rows: existing } = await client.query<{ id: string }>(
        'select id from slot_shortlist where slot_id = $1 and vendor_id = $2',
        [slotId, vendorId],
      )
      if (existing[0]) {
        await lockLiveVendor()
        const entries = await loadShortlist(client, weddingId, slotId, request.member!.role)
        return { kind: 'entry' as const, entry: entries.find((e) => e.id === existing[0]!.id)! }
      }

      const { rows: occupied } = await client.query<{ position: number }>(
        'select position from slot_shortlist where slot_id = $1 order by position',
        [slotId],
      )
      const used = new Set(occupied.map((row) => row.position))
      const position = [1, 2, 3].find((candidate) => !used.has(candidate))
      if (!position) {
        if (!replaceEntryId) {
          await lockLiveVendor()
          return {
            kind: 'full' as const,
            shortlist: await loadShortlist(client, weddingId, slotId, request.member!.role),
          }
        }

        /* Замена — одна транзакция под замком слота. Если chooser устарел или
         * прислал entry другого места, ничего не удаляем и возвращаем свежую
         * тройку. Два клиента, заменяющие одну запись, поэтому не могут
         * оставить две свободные позиции или потерять обоих кандидатов. */
        const { rows: replaced } = await client.query<{
          id: string
          vendor_id: string | null
          position: number
        }>(
          `select id, vendor_id, position from slot_shortlist
            where slot_id = $1 and id = $2
            for update`,
          [slotId, replaceEntryId],
        )
        if (!replaced[0]) {
          return {
            kind: 'full' as const,
            shortlist: await loadShortlist(client, weddingId, slotId, request.member!.role),
          }
        }
        await closeOpenRequestsForRemoval(
          client,
          slotId,
          replaced[0].vendor_id,
          request.member!.role,
          weddingTz,
        )
        await lockLiveVendor()
        await client.query('delete from slot_shortlist where id = $1', [replaceEntryId])

        const id = uuidv7()
        await client.query(
          `insert into slot_shortlist (id, slot_id, vendor_id, position, added_by)
           values ($1, $2, $3, $4, $5)`,
          [id, slotId, vendorId, replaced[0].position, request.caller!.userId],
        )
        const entries = await loadShortlist(client, weddingId, slotId, request.member!.role)
        return { kind: 'entry' as const, entry: entries.find((entry) => entry.id === id)! }
      }

      await lockLiveVendor()
      const id = uuidv7()
      await client.query(
        `insert into slot_shortlist (id, slot_id, vendor_id, position, added_by)
         values ($1, $2, $3, $4, $5)`,
        [id, slotId, vendorId, position, request.caller!.userId],
      )
      const entries = await loadShortlist(client, weddingId, slotId, request.member!.role)
      return { kind: 'entry' as const, entry: entries.find((entry) => entry.id === id)! }
    })

    if (result.kind === 'full') {
      return reply.code(409).send({
        error: {
          code: 'shortlist_full',
          message: 'В этом месте уже три кандидата — сначала выберите, кого заменить',
          details: { shortlist: result.shortlist },
        },
      })
    }
    return result.entry
  })

  app.delete('/weddings/:weddingId/slots/:slotId/shortlist/:entryId', async (request, reply) => {
    const weddingId = request.member!.weddingId
    const { slotId, entryId } = request.params as { slotId: string; entryId: string }
    if (!isUuid(entryId)) throw notFound('Кандидат не найден')

    await db().tx(async (client) => {
      const weddingTz = await lockWritableWedding(client, weddingId)
      await lockActor(client, request.caller!.userId)
      await assertSlot(client, weddingId, slotId, true)
      /* Удаляем по surrogate id записи, а не по vendor_id: после
       * стирания подрядчика vendor_id становится null, но паре всё ещё
       * нужно освободить позицию. */
      const { rows: candidates } = await client.query<{ id: string; vendor_id: string | null }>(
        `select id, vendor_id from slot_shortlist
          where slot_id = $1 and id = $2
          for update`,
        [slotId, entryId],
      )
      if (!candidates[0]) throw notFound('Кандидат не найден')

      await closeOpenRequestsForRemoval(
        client,
        slotId,
        candidates[0].vendor_id,
        request.member!.role,
        weddingTz,
      )
      await client.query('delete from slot_shortlist where id = $1', [entryId])
    })
    return reply.code(204).send()
  })
}
