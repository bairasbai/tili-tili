import type { FastifyInstance } from 'fastify'
import { AppError, conflict, notFound, forbidden, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'
import { holdDatesOf } from '../catalog/holds.js'
import { exportVendorCalendar } from '../catalog/calendar-export.js'
import { CalendarImportError, EXTERNAL_CALENDAR_FILE_LIMIT, EXTERNAL_CALENDAR_MAX_DAYS, readCalendarImport } from '../catalog/calendar-import.js'
import { assertCalendarZone, externalBusyDates, freshCalendarConfirmationSql, writeExternalCalendar } from '../catalog/external-calendar.js'
import { assertRealDate } from '../wedding/dates.js'
import { VENDOR_COLUMNS, loadDetail, type VendorRow } from '../catalog/vendors.js'
import { profileCompleteness } from '../vendor/completeness.js'
import { lockResourceScope } from '../resources/model.js'
import { assertLegacyDateBookingAllowed } from '../resources/booking-boundary.js'
import { lockVendorProfileWrite } from '../vendor/profile-locks.js'
import { replacePortfolio } from '../media/portfolio.js'
import { assertSeatingToken } from '../wedding/access.js'
import { lockOrderPrincipal } from '../orders/context.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER
export const MAX_VIDEO_SECONDS = 180

/**
 * Ссылка из анкеты подставляется в галерею на странице у пары. `javascript:`
 * в атрибуте — это выполнение чужого кода в её браузере, `data:` — своя
 * страница внутри нашей. Пропускаем только обычные http и https.
 *
 * Проверка схемой, а не кодом: человек получает 422 с именем поля, а не
 * общий отказ «что-то не так с анкетой».
 */
const URL_SCHEMA = { type: 'string', maxLength: 500, pattern: '^https?://[^ ]+$' } as const

const MONEY_SCHEMA = {
  type: 'object',
  required: ['amount', 'currency'],
  additionalProperties: false,
  properties: {
    amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
    currency: { type: 'string', enum: ['RUB'] },
  },
} as const

interface UpsertBody {
  name: string
  categoryId: string
  city: { name: string; region: string }
  about?: string
  phone?: string | null
  priceFrom?: { amount: number }
  /** Права на фото и видео портфолио и согласие снятых (152-ФЗ, план §7): `true` ставит момент, не снимается. */
  mediaRights?: boolean
  /** С `id` — свой пакет, который остаётся тем же; без `id` — новый (019, FR-006). */
  packages?: { id?: string; name: string; price?: { amount: number }; includes?: string[] }[]
  portfolioUrls?: string[]
  media?: { kind: 'photo' | 'video'; url: string; durationS?: number | null }[]
}

export async function vendorRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  /** Анкета текущего пользователя. Одна на аккаунт — так стоит UNIQUE в БД. */
  const myVendorId = async (userId: string): Promise<string | null> => {
    const { rows } = await db().query<{ id: string }>('select id from vendors where user_id = $1', [userId])
    return rows[0]?.id ?? null
  }

  /**
   * Анкета обязательна — иначе 403, как у путей кабинета (`vendorCabinet.ts`).
   *
   * Только `GET /vendor/profile` отвечает 404: по нему экран отличает «анкеты
   * ещё нет» от поломки (`VendorApp`, `noProfile`). Публикация, календарь и
   * занятость до ревью 015 отвечали тем же 404 — «адреса нет» на путь
   * контракта (§5.10), и кабинет с двумя кодами на одно и то же.
   */
  const requireVendorId = async (userId: string): Promise<string> => {
    const id = await myVendorId(userId)
    if (!id) throw forbidden('Кабинет доступен только подрядчику с анкетой')
    return id
  }

  /** `q` — клиент транзакции, когда ответ должен показать именно эту запись, а не следующую. */
  const loadMine = async (vendorId: string, q: Queryable = db()) => {
    const { rows } = await q.query<VendorRow & { about: string | null; city_region: string | null }>(
      `select ${VENDOR_COLUMNS}, v.about, c.region as city_region
         from vendors v left join cities c on c.id = v.city_id
        where v.id = $1`,
      [vendorId],
    )
    // Своя анкета видна владельцу и до публикации — иначе мастер не покажет,
    // что уже заполнено.
    const detail = await loadDetail(q, vendorId, rows[0]!)
    const { rows: state } = await q.query<{
      published_at: Date | null
      moderated_at: Date | null
      blocked_at: Date | null
      media_rights_at: Date | null
      moderation_reason: string | null
    }>(`select v.published_at, v.moderated_at, v.blocked_at, v.media_rights_at,
        case when v.published_at is null and v.blocked_at is null then (
          select nullif(btrim(l.diff->>'reason'), '') from audit_log l
          where l.entity='vendor' and l.entity_id=v.id and l.action='vendor.reject' and l.at=v.moderated_at
          order by l.id desc limit 1
        ) end as moderation_reason
      from vendors v where v.id=$1`, [vendorId])
    return {
      ...detail,
      /* Регион отдаём владельцу: город в ответе — одна строка, и без региона
         анкету нельзя вернуть обратно, не потеряв справочную привязку. */
      cityRegion: rows[0]!.city_region,
      published: state[0]!.published_at !== null,
      moderated: state[0]!.moderated_at !== null,
      ...(state[0]!.moderation_reason ? { moderationReason: state[0]!.moderation_reason } : {}),
      /* Блокировка по жалобе (`block`, §18.2) — только владельцу: в каталоге
         анкеты нет, публикация отвечает 409, и кабинет обязан сказать почему,
         а не показывать «не опубликована» с кнопкой, которая не сработает
         (D5-23, фича 005). Чужому читателю вопрос не стоит — он её не видит. */
      blocked: state[0]!.blocked_at !== null,
      /* Подтверждение прав на портфолио (152-ФЗ, план §7) — только владельцу:
         мастер по нему решает, показывать ли галочку заново. */
      mediaRights: state[0]!.media_rights_at !== null,
      /* Заполненность — одним правилом с панелью (`vendor/completeness.ts`):
         кабинет считал своё на клиенте, и одна анкета получала два процента. */
      completeness: profileCompleteness({
        about: rows[0]!.about,
        phone: detail.phone ?? null,
        priceFrom: detail.priceFrom?.amount ?? null,
        packagesCount: detail.packages.length,
      }),
    }
  }

  /* ── моя анкета ───────────────────────────────────────────────────── */
  app.get('/vendor/profile', { preHandler: app.requireConsent }, async (request) => {
    const id = await myVendorId(request.caller!.userId)
    if (!id) throw notFound('Анкета ещё не создана')
    return loadMine(id)
  })

  app.put(
    '/vendor/profile',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['name', 'categoryId', 'city'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 120 },
            categoryId: { type: 'string', maxLength: 40 },
            /* Регион необязателен: в ответе город приходит одной строкой, и
               клиент, который просто вернул анкету обратно, региона не знает.
               Пока имя города в справочнике единственное — этого хватает. */
            city: {
              type: 'object',
              required: ['name'],
              additionalProperties: false,
              properties: { name: { type: 'string' }, region: { type: 'string' } },
            },
            about: { type: 'string', maxLength: 4000 },
            /* Рабочий телефон. Заполняя его, подрядчик соглашается показать
             * номер парам, которые его забронировали: у номера входа такого
             * согласия нет, поэтому поле отдельное. */
            phone: { type: 'string', nullable: true, minLength: 5, maxLength: 32 },
            priceFrom: MONEY_SCHEMA,
            /* Права на фото и согласие снятых (152-ФЗ, план §7). `true` пишет
             * момент подтверждения; `false` и отсутствие поля прежнее не трогают —
             * подтверждение не снимается сохранением имени. */
            mediaRights: { type: 'boolean' },
            packages: {
              type: 'array',
              maxItems: 20,
              items: {
                type: 'object',
                required: ['name'],
                additionalProperties: false,
                properties: {
                  /* Не uuid-формат схемой: чужая или битая строка — один отказ `unknown_package`
                     с именем поля, как у пакета, которого уже нет, а не два разных. */
                  id: { type: 'string', maxLength: 64 },
                  name: { type: 'string', minLength: 1, maxLength: 120 },
                  price: MONEY_SCHEMA,
                  includes: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 200 } },
                },
              },
            },
            portfolioUrls: { type: 'array', maxItems: 60, items: URL_SCHEMA },
            media: {
              type: 'array',
              maxItems: 60,
              items: {
                type: 'object',
                required: ['kind', 'url'],
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', enum: ['photo', 'video'] },
                  url: URL_SCHEMA,
                  // Верхняя граница стоит и здесь, и в БД. Схема даёт человеку
                  // понятный отказ, ограничение БД — гарантию.
                  durationS: { type: 'integer', minimum: 1, maximum: MAX_VIDEO_SECONDS, nullable: true },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as UpsertBody
      const userId = request.caller!.userId

      const { rows: cat } = await db().query('select 1 from categories where id = $1', [body.categoryId])
      if (cat.length === 0) throw notFound(`Категория «${body.categoryId}» не найдена`)

      /* С регионом ищем точно, без региона — по имени. Если одноимённых
         городов несколько, region обязателен: молча выбрать первый значит
         записать подрядчика в чужую область. */
      const { rows: cityRows } = await db().query<{ id: number }>(
        body.city.region
          ? 'select id from cities where name = $1 and region = $2 limit 1'
          : 'select id from cities where name = $1 limit 2',
        body.city.region ? [body.city.name, body.city.region] : [body.city.name],
      )
      if (!cityRows[0]) throw notFound(`Город «${body.city.name}» не найден в справочнике`)
      if (!body.city.region && cityRows.length > 1) {
        throw new AppError(422, 'city_ambiguous', `Городов с названием «${body.city.name}» несколько — укажите регион`)
      }
      // Достаём до транзакции: внутри замыкания TypeScript теряет сужение типа.
      const cityId = cityRows[0].id

      const media = body.media ?? []
      // Схема уже отклонила бы длинное видео, но проверка нужна и здесь:
      // видео без длительности схему проходит, а в БД упрётся в CHECK
      // и вернётся человеку пятисоткой вместо внятного отказа.
      for (const m of media) {
        if (m.kind !== 'video') continue
        if (m.durationS === undefined || m.durationS === null) {
          throw new AppError(422, 'video_duration_required', 'У видео нужно указать длительность в секундах')
        }
        if (m.durationS > MAX_VIDEO_SECONDS) {
          throw new AppError(
            422,
            'video_too_long',
            `Видео длиннее ${MAX_VIDEO_SECONDS} секунд не принимается: ${m.durationS} с`,
          )
        }
      }

      const all = [
        ...(body.portfolioUrls ?? []).map((url) => ({ kind: 'photo' as const, url, durationS: null })),
        ...media,
      ]

      /*
       * Отсутствующее поле — «не трогай», пустой массив — «очисти».
       *
       * Мастер анкеты портфолио не редактирует вовсе: загрузка ждёт хранилища.
       * При прежнем правиле «нет поля — значит пусто» каждое сохранение имени
       * или телефона стирало бы фотографии и видео, о которых форма не знает.
       * Терять чужие работы из-за поля, которого клиент не прислал, — худший
       * из возможных отказов, поэтому список заменяется только тогда, когда о
       * нём сказали явно.
       */
      const touchesMedia = body.portfolioUrls !== undefined || body.media !== undefined
      const touchesPackages = body.packages !== undefined

      /* Сохранение — одной транзакцией.
       *
       * Медиа заменяются целиком, пакеты — по id; и там и там есть удаление. Раздельными
       * запросами сбой на середине оставлял анкету разорённой: пакеты стёрты,
       * медиа заменены наполовину, и вернуть их неоткуда — форму прислали
       * один раз. Портфолио из шестидесяти работ так теряется от одной ошибки
       * вставки (ERR-0109). Соседние «заменить целиком» — тайминг и опрос меню
       * в `day.ts` — давно в транзакции; этот выпал.
       *
       * Ответ читается в той же транзакции: мастер переносит из него id новых пакетов
       * в черновик по порядку (019, FR-006), и сохранение из второй вкладки, вставшее
       * между коммитом и чтением, раздало бы черновику чужие id. */
      return db().tx(async (client) => {
        const lockedVendorId = await lockVendorProfileWrite(client, { userId, sessionId: request.caller!.sessionId,
          policyVersion: app.appConfig.policyVersion }, body.packages)
        // Existing companies are updated by the ID held under the complete
        // scope. Do not send a phantom INSERT through association/birth guards.
        // The creation branch retains its unique-owner conflict protection.
        const { rows: saved } = await client.query<{ id: string }>(
          lockedVendorId !== null
            ? `update vendors set category_id=$3, city_id=$4, name=$5, about=$6, price_from=$7, phone=$8
               where id=$1 and user_id=$2 returning id`
            : `insert into vendors (id, user_id, category_id, city_id, name, about, price_from, currency, phone)
           values ($1, $2, $3, $4, $5, $6, $7, 'RUB', $8)
           on conflict (user_id) do update
              set category_id = excluded.category_id, city_id = excluded.city_id,
                  name = excluded.name, about = excluded.about, price_from = excluded.price_from,
                  phone = excluded.phone
           returning id`,
          [
            lockedVendorId ?? uuidv7(),
            userId,
            body.categoryId,
            cityId,
            body.name,
            body.about ?? null,
            body.priceFrom?.amount ?? null,
            body.phone ?? null,
          ],
        )
        const id = saved[0]!.id

        // Подтверждение прав — событие с датой, ставится один раз (152-ФЗ, план §7).
        if (body.mediaRights === true) {
          await client.query('update vendors set media_rights_at = coalesce(media_rights_at, now()) where id = $1', [id])
        }

        /* Пакеты — по id (019, FR-006). Присланный с id — тот же пакет: имя, цена, состав и
         * место в списке обновляются, id остаётся, и брони, которые на него ссылаются,
         * называют его и дальше. Без id — новый. Неприсланный — удаляется: сделка
         * теряет только живую ссылку (`on delete set null`), а название и состав уже
         * заключённой сделки остаются в её снимке (019, FR-018). Список не прислан —
         * не трогается вовсе.
         *
         * Прежде присланный список заменял прежний целиком — стереть всё и вставить
         * заново, — и каждое «Далее» мастера выдавало пакетам новые id: брони теряли
         * пакет, а мастер, не знавший состава, стирал его (ERR-0318).
         *
         * Чужой, удалённый или не-uuid id — 422 `unknown_package` до единой записи пакетов;
         * повтор одного id — 422 поля. Сверка идёт со своими пакетами под замком строки
         * анкеты — его взял префикс сохранения выше и держит до конца
         * транзакции, — поэтому сохранения из двух вкладок идут по очереди, и пакет,
         * удалённый одной, не воскресает из устаревшего черновика другой. */
        if (touchesPackages) {
          const incoming = body.packages ?? []
          const { rows: own } = await client.query<{ id: string }>('select id from vendor_packages where vendor_id = $1', [id])
          const known = new Set(own.map((r) => r.id))
          const kept = new Set<string>()
          for (const [i, pkg] of incoming.entries()) {
            if (pkg.id === undefined) continue
            if (kept.has(pkg.id)) throw validationFailed({ [`packages/${i}/id`]: 'пакет указан дважды' })
            if (!known.has(pkg.id)) {
              throw new AppError(422, 'unknown_package', 'Такого пакета в анкете уже нет — обновите страницу', {
                [`packages/${i}/id`]: 'пакет не найден в этой анкете',
              })
            }
            kept.add(pkg.id)
          }
          await client.query('delete from vendor_packages where vendor_id = $1 and id <> all($2::uuid[])', [id, [...kept]])
          for (const [sort, pkg] of incoming.entries()) {
            const fields = [pkg.name, pkg.price?.amount ?? null, JSON.stringify(pkg.includes ?? []), sort]
            await (pkg.id === undefined
              ? client.query(
                  `insert into vendor_packages (id, vendor_id, name, price, items, sort, currency)
                   values ($1, $2, $3, $4, $5, $6, 'RUB')`,
                  [uuidv7(), id, ...fields],
                )
              : client.query(
                  'update vendor_packages set name = $3, price = $4, items = $5, sort = $6 where id = $1 and vendor_id = $2',
                  [pkg.id, id, ...fields],
                ))
          }
        }

        if (touchesMedia) {
          await replacePortfolio(client, id, all, app.appConfig.mediaStorage?.deliveryBaseUrl ?? null)
        }
        const result = await loadMine(id, client)
        await assertSeatingToken(request)
        return result
      })
    },
  )

  /* ── публикация ───────────────────────────────────────────────────── */
  app.post('/vendor/profile/publish', { preHandler: app.requireConsent }, async (request) => {
    const vendorId = await requireVendorId(request.caller!.userId)

    /* Автопубликация с пост-модерацией (План §19.2): анкета попадает в выдачу
     * сразу. Держать её в очереди значит терять подрядчика, который пришёл
     * один раз и больше не вернётся.
     *
     * Снятая модератором анкета (`published_at` пуст, `moderated_at` стоит
     * от решения) публикуется заново как НОВАЯ: `moderated_at` сбрасывается,
     * и она снова встаёт в очередь. Раньше метка решения оставалась, анкета
     * возвращалась в каталог одной кнопкой без единой правки и в очередь не
     * попадала никогда — санкция отменялась самим подрядчиком (D5-03).
     * Выражения в `set` читают старые значения строки, поэтому условие по
     * `published_at` смотрит на состояние до записи.
     *
     * Заблокированная (`blocked_at`) не публикуется вовсе: блокировка —
     * крайняя санкция §18.2, и «опубликована» ей отвечать нельзя, каталог
     * её всё равно не покажет. 409 объявлен контрактом. */
    const { rows } = await db().query<{ moderated_at: Date | null }>(
      `update vendors
          set published_at = coalesce(published_at, now()),
              moderated_at = case when published_at is null then null else moderated_at end
        where id = $1 and blocked_at is null
        returning moderated_at`,
      [vendorId],
    )
    if (rows.length === 0) {
      throw conflict('vendor_blocked', 'Анкета заблокирована модерацией — публикация закрыта')
    }
    await db().query(
      `insert into audit_log (actor_id, action, entity, entity_id) values ($1, 'vendor.published', 'vendor', $2)`,
      [request.caller!.userId, vendorId],
    )
    return { status: rows[0]!.moderated_at ? 'live' : 'moderation' }
  })

  /* ── календарь ────────────────────────────────────────────────────── */
  app.get(
    '/vendor/calendar',
    {
      preHandler: app.requireConsent,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
        },
      },
    },
    async (request) => {
      const vendorId = await requireVendorId(request.caller!.userId)
      const { month } = request.query as { month?: string }

      const conditions = ['vendor_id = $1']
      const args: unknown[] = [vendorId]
      if (month) {
        const [y, m] = month.split('-').map(Number) as [number, number]
        args.push(
          new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10),
          new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1)).toISOString().slice(0, 10),
        )
        conditions.push('date >= $2::date', 'date < $3::date')
      }
      return db().tx(async snapshot => {
        // При подтверждении сделки исчезает hold и появляется busy. Обе
        // выборки должны видеть один снимок, иначе можно пропустить дату.
        await snapshot.query('set transaction isolation level repeatable read read only')
        const { rows } = await snapshot.query<{ date: string; source: 'manual' | 'deal'; created_at: Date }>(
          `select date::text as date, source, created_at from vendor_busy_dates where ${conditions.join(' and ')}`,
          args,
        )
        const range = month ? { from: String(args[1]), to: String(args[2]) } : undefined
        const holdDates = await holdDatesOf(snapshot, vendorId, range)
        const external = await externalBusyDates(snapshot, vendorId, range)
        const resources = month ? (await snapshot.query<{ date: string; marked_at: Date | null }>(`
          select g.day::date::text as date,max(v.created_at) as marked_at
            from resource_occupancy o
            join deal_resource_commitment_versions v on v.id=o.origin_version_id
            cross join lateral generate_series($2::date::timestamp,($3::date-1)::timestamp,interval '1 day') g(day)
           where o.vendor_identity=$1 and o.released_at is null
             and tstzrange(o.occupied_starts_at,o.occupied_ends_at,'[)') &&
               tstzrange(g.day at time zone 'UTC',(g.day+interval '1 day') at time zone 'UTC','[)')
             and o.origin_kind='commitment'
           group by g.day
        `, args)).rows : []
        const free = await snapshot.query<{ date: string; confirmed_at: Date }>(
          `select date::text as date, confirmed_at from vendor_free_date_confirmations
            where ${conditions.join(' and ')}
              and ${freshCalendarConfirmationSql}
              and not exists (select 1 from vendor_availability_policy where vendor_id=$1 and mode='resources')
              and not exists (select 1 from resource_allocations where vendor_id=$1 and released_at is null)`,
          args,
        )
        const booked = new Set(rows.map(r => r.date))
        const occupied = new Set([...booked, ...resources.map(r => r.date)])
        const busy = new Set([...occupied, ...external.map(r => r.date)])
        const holds = new Set(holdDates)
        return [
          ...rows.map(r => ({ date: r.date, status: 'busy' as const, source: r.source, markedAt: r.created_at.toISOString() })),
          ...resources.filter(r => !booked.has(r.date)).map(r => ({
            date: r.date, status: 'busy' as const, source: 'resource' as const, ...(r.marked_at && { markedAt: r.marked_at.toISOString() }),
          })),
          ...external.filter(r => !occupied.has(r.date)).map(r => ({
            date: r.date, status: 'busy' as const, source: r.source, markedAt: r.marked_at.toISOString(),
          })),
          ...holdDates.filter(d => !busy.has(d)).map(date => ({ date, status: 'hold' as const })),
          ...free.rows.filter(r => !busy.has(r.date) && !holds.has(r.date)).map(r => ({
            date: r.date, status: 'free' as const, source: 'manual' as const, markedAt: r.confirmed_at.toISOString(),
          })),
        ].sort((a, b) => a.date.localeCompare(b.date))
      })
    },
  )

  app.post(
    '/vendor/calendar/busy',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['dates', 'status'],
          additionalProperties: false,
          properties: {
            dates: {
              type: 'array',
              minItems: 1,
              maxItems: 366,
              items: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            },
            status: { type: 'string', enum: ['free', 'busy'] },
          },
        },
      },
    },
    async (request, reply) => {
      const vendorId = await requireVendorId(request.caller!.userId)
      const { dates, status } = request.body as { dates: string[]; status: 'free' | 'busy' }
      // Шаблон пропускает 30 февраля, а PostgreSQL на такой дате падает.
      for (const date of dates) assertRealDate(date, 'dates')

      await db().tx(async client => {
        const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
        const scope = await lockResourceScope(client, { vendorId, actor })
        if (scope.ownerId !== actor.userId.toLowerCase()) throw forbidden('Календарём распоряжается действующий владелец компании')
        await assertLegacyDateBookingAllowed(client, vendorId, status === 'busy')
        await client.query('select legacy_day_lock_vendors($1::uuid[])', [[vendorId]])
        if (status === 'busy') {
          for (const date of dates) {
            await client.query(
              `insert into vendor_busy_dates (vendor_id, date, source) values ($1, $2::date, 'manual')
               on conflict (vendor_id, date) do nothing`,
              [vendorId, date],
            )
          }
        } else {
          // A manual calendar change never releases a deal or resource promise.
          await client.query(
            `delete from vendor_busy_dates
              where vendor_id = $1 and source = 'manual' and date = any($2::date[])`,
            [vendorId, dates],
          )
        }
        await scope.assertCalendarCurrent()
      })
      return reply.code(204).send()
    },
  )

  app.put(
    '/vendor/calendar/availability',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object', required: ['dates'], additionalProperties: false,
          properties: {
            dates: { type: 'array', minItems: 1, maxItems: 366, items: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } },
          },
        },
      },
    },
    async (request, reply) => {
      const vendorId = await requireVendorId(request.caller!.userId)
      const { dates } = request.body as { dates: string[] }
      const uniqueDates = [...new Set(dates)].sort()
      for (const date of uniqueDates) assertRealDate(date, 'dates')

      await db().tx(async client => {
        const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
        const scope = await lockResourceScope(client, { vendorId, actor })
        if (scope.ownerId !== actor.userId.toLowerCase()) throw forbidden('Календарём распоряжается действующий владелец компании')
        await assertLegacyDateBookingAllowed(client, vendorId)
        await client.query('select legacy_day_lock_vendors($1::uuid[])', [[vendorId]])
        const busy = await client.query(`
          select 1 from vendor_busy_dates where vendor_id=$1 and date=any($2::date[])
          union all
          select 1 from vendor_external_calendar_periods
           where vendor_id=$1 and exists (select 1 from unnest($2::date[]) as d(day) where days @> d.day)
          limit 1`, [vendorId, uniqueDates])
        const holds = new Set(await holdDatesOf(client, vendorId))
        if (busy.rowCount || uniqueDates.some(date => holds.has(date))) {
          throw conflict('vendor_date_unavailable', 'Сначала снимите ручную занятость или дождитесь освобождения брони')
        }
        await client.query(
          `insert into vendor_free_date_confirmations(vendor_id,date)
            select $1, day from unnest($2::date[]) as days(day)
            on conflict (vendor_id,date) do update set confirmed_at=excluded.confirmed_at`,
          [vendorId, uniqueDates],
        )
        await scope.assertCalendarCurrent()
      })
      return reply.code(204).send()
    },
  )

  app.get('/vendor/calendar/export', {
    preHandler: app.requireConsent,
    schema: {
      querystring: {
        type: 'object', additionalProperties: false, required: ['month'],
        properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
      },
    },
  }, async (request, reply) => {
    const { month } = request.query as { month: string }
    const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
    const output = await db().tx(async client => {
      await lockOrderPrincipal(client, actor)
      const vendor = await client.query<{ id: string }>(
        'select id from vendors where user_id=$1 and blocked_at is null for share', [actor.userId],
      )
      if (!vendor.rows[0]) throw forbidden('Календарь доступен только действующему владельцу компании')
      return exportVendorCalendar(client, vendor.rows[0].id, month)
    })
    return reply.type('text/calendar; charset=utf-8')
      .header('content-disposition', 'attachment; filename="availability.ics"')
      .header('cache-control', 'private, no-store').send(output)
  })

  app.put(
    '/vendor/calendar/import',
    {
      preHandler: app.requireConsent,
      bodyLimit: 512 * 1024,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['timeZone', 'calendar'],
          properties: {
            timeZone: { type: 'string', minLength: 1, maxLength: 100 },
            calendar: { type: 'string', maxLength: EXTERNAL_CALENDAR_FILE_LIMIT },
          },
        },
      },
    },
    async (request) => {
      const vendorId = await requireVendorId(request.caller!.userId)
      const { timeZone, calendar } = request.body as { timeZone: string; calendar: string }
      let periods
      try { periods = readCalendarImport(calendar) }
      catch (error) {
        if (error instanceof CalendarImportError) throw validationFailed({ calendar: error.message })
        throw error
      }
      return db().tx(async client => {
        const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
        const scope = await lockResourceScope(client, { vendorId, actor })
        if (scope.ownerId !== actor.userId.toLowerCase()) throw forbidden('Календарём распоряжается действующий владелец компании')
        await assertCalendarZone(client, timeZone)
        const count = await writeExternalCalendar(client, vendorId, 'ics', timeZone, periods)
        await scope.assertCalendarCurrent()
        return { count }
      })
    },
  )

  app.post(
    '/vendor/calendar/external',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object', additionalProperties: false, required: ['timeZone', 'periods'],
          properties: {
            timeZone: { type: 'string', minLength: 1, maxLength: 100 },
            periods: {
              type: 'array', minItems: 1, maxItems: 366,
              items: {
                type: 'object', required: ['start', 'end'], additionalProperties: false,
                properties: {
                  start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                  end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const vendorId = await requireVendorId(request.caller!.userId)
      const { timeZone, periods } = request.body as { timeZone: string; periods: { start: string; end: string }[] }
      for (const { start, end } of periods) {
        assertRealDate(start, 'start')
        assertRealDate(end, 'end')
        if (end <= start || Date.parse(end) - Date.parse(start) > EXTERNAL_CALENDAR_MAX_DAYS * 86_400_000) {
          throw validationFailed({ periods: 'Укажите конечную дату после начала, не дальше 370 дней' })
        }
      }
      return db().tx(async client => {
        const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
        const scope = await lockResourceScope(client, { vendorId, actor })
        if (scope.ownerId !== actor.userId.toLowerCase()) throw forbidden('Календарём распоряжается действующий владелец компании')
        await assertCalendarZone(client, timeZone)
        const count = await writeExternalCalendar(client, vendorId, 'external', timeZone, periods.map(p => ({ kind: 'day', ...p })))
        await scope.assertCalendarCurrent()
        return { count }
      })
    },
  )

  app.delete('/vendor/calendar/external', {
    preHandler: app.requireConsent,
    schema: {
      querystring: {
        type: 'object', required: ['start', 'end'], additionalProperties: false,
        properties: {
          start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        },
      },
    },
  }, async (request, reply) => {
    const vendorId = await requireVendorId(request.caller!.userId)
    const { start, end } = request.query as { start: string; end: string }
    assertRealDate(start, 'start')
    assertRealDate(end, 'end')
    if (end <= start) throw validationFailed({ end: 'Укажите конечную дату после начала' })
    await db().tx(async client => {
      const actor = { ...request.caller!, policyVersion: app.appConfig.policyVersion }
      const scope = await lockResourceScope(client, { vendorId, actor })
      if (scope.ownerId !== actor.userId.toLowerCase()) throw forbidden('Календарём распоряжается действующий владелец компании')
      await client.query(`
        delete from vendor_external_calendar_periods where vendor_id=$1 and source='external' and days=daterange($2::date,$3::date,'[)')
      `, [vendorId, start, end])
      await scope.assertCalendarCurrent()
    })
    return reply.code(204).send()
  })

  app.get('/vendor/calendar/external', { preHandler: app.requireConsent }, async request => {
    const vendorId = await requireVendorId(request.caller!.userId)
    const { rows } = await db().query<{ start: string; end: string }>(`
      select distinct lower(days)::text start,upper(days)::text "end"
      from vendor_external_calendar_periods where vendor_id=$1 and source='external'
      order by start,"end"
    `, [vendorId])
    return rows
  })

}
