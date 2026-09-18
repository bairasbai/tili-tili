import type { FastifyInstance } from 'fastify'
import { AppError, notFound, validationFailed } from '../errors.js'
import { UUID_ID, uuidv7, isUuid } from '../ids.js'
import { buildPage, encodeCursor, parsePageQuery } from '../pagination.js'
import { MIN_REVIEWS_TO_SHOW } from '../reviews/rating.js'
import { holdDatesOf } from '../catalog/holds.js'
import { assertRealDate } from '../wedding/dates.js'
import {
  VENDOR_COLUMNS,
  VENDOR_LIVE_JOIN,
  assertVendorLive,
  escapeLike,
  loadDetail,
  rotateNewcomers,
  toVendor,
  type VendorRow,
} from '../catalog/vendors.js'

const MONEY_MAX = Number.MAX_SAFE_INTEGER

/**
 * Сортировки выдачи и ключ для листания.
 *
 * Курсор обязан нести ЗНАЧЕНИЕ, по которому идёт сортировка, а не только
 * идентификатор. Иначе «следующая страница» при сортировке по рейтингу
 * означает «все, у кого id больше», а это другой набор строк: пара листает
 * каталог и видит одних дважды, а других не видит вовсе.
 *
 * `coalesce` нужен, чтобы пустое значение участвовало в сравнении наравне
 * с остальными: строка с `null` иначе выпадает из условия и теряется.
 */
/* Рейтинг, который показан: до трёх отзывов ПАР числа на экране нет (План
 * §18.2; фича 005, В4), и ранжировать по нему нельзя — иначе одна пятёрка
 * от знакомого ставит анкету на первое место «по рейтингу», притом без
 * цифры рядом. Столбец `vendors.rating` заполнен уже при первом отзыве;
 * наружу его прячет `publicRating`, здесь — то же условие (ERR-0216). */
const SHOWN_RATING = `case when v.couple_reviews_count >= ${MIN_REVIEWS_TO_SHOW} then v.rating end`

/* `key` — форма значения в курсоре по типу колонки: дробь законна только
 * у рейтинга, `4.5::bigint` и «9223372036854775807::int» база не примет и
 * упадёт ошибкой приведения, то есть 500 (D5-09). Проверяется до запроса. */
const INTEGER_KEY = /^-?\d+$/
const SORTS = {
  rating: { expr: `coalesce(${SHOWN_RATING}, -1)`, dir: 'desc', cast: '::numeric', key: /^-?\d+(\.\d+)?$/ },
  price_asc: { expr: 'coalesce(v.price_from, 9223372036854775807)', dir: 'asc', cast: '::bigint', key: INTEGER_KEY },
  price_desc: { expr: 'coalesce(v.price_from, -1)', dir: 'desc', cast: '::bigint', key: INTEGER_KEY },
  popular: { expr: 'v.reviews_count', dir: 'desc', cast: '::int', key: INTEGER_KEY },
} as const

type SortName = keyof typeof SORTS

/** Пониженная санкцией анкета идёт после всех непониженных (ERR-0071). */
const DOWNRANKED = '(v.downranked_at is not null)::int'

/**
 * Курсор каталога: `сортировка|понижение|значение` плюс идентификатор.
 *
 * Имя сортировки — чтобы курсор от `sort=rating` не приводился к типу
 * `sort=price_asc` и не ронял запрос (D5-09): чужой курсор — 400. Признак
 * понижения — потому что он первый ключ `ORDER BY`: без него условие «после
 * курсора» сравнивало только значение, и пониженные анкеты при листании
 * либо терялись (ключ пониженной выше ключа последней строки страницы),
 * либо дублировали уже показанных (D5-10, R-47).
 */
const CATALOG_CURSOR = /^(rating|price_asc|price_desc|popular)\|[01]\|-?\d+(\.\d+)?$/

function catalogCursor(sort: SortName, down: boolean, key: string, id: string): string {
  return encodeCursor(`${sort}|${down ? 1 : 0}|${key}`, id)
}

/** `2027-06` → границы месяца. Без разбора руками: неверный месяц ловится схемой. */
function monthRange(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const from = new Date(Date.UTC(y, m - 1, 1))
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1))
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)]
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const db = () => {
    if (!app.db) throw new AppError(503, 'db_unavailable', 'База недоступна')
    return app.db
  }

  // Каталог — не публичная витрина: и контракт, и матрица доступа раздела 6
  // говорят, что он за входом (у гостя в строке `/catalog/*` стоит «—»).
  // Открытый каталог отдаёт всю базу подрядчиков любому скрипту.
  const authed = { preHandler: app.requireConsent }

  /* ── справочник категорий ─────────────────────────────────────────── */
  app.get(
    '/catalog/categories',
    {
      ...authed,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { city: { type: 'string', maxLength: 80 } },
        },
      },
    },
    async (request) => {
      const { city } = request.query as { city?: string }
      /* Сколько живых опубликованных анкет в категории (план миграции §2.7):
       * экран `/search` держится на доводе «здесь есть из кого выбирать», и
       * до этого число либо выдумывалось, либо не показывалось. С `city` —
       * по точному имени города, как якорь выдачи (радиус здесь ни к чему:
       * это довод, а не фильтр); без него — по всей базе. */
      const { rows } = await db().query<{ id: string; name: string; icon: string | null; tile: string | null; description: string | null; vendors: string }>(
        `select k.id, k.name, k.icon, k.tile, k.description,
                (select count(*)::text from vendors v ${VENDOR_LIVE_JOIN}
                   left join cities c on c.id = v.city_id
                  where v.category_id = k.id and v.published_at is not null
                    and ($1::text is null or c.name = $1)) as vendors
           from categories k order by k.sort, k.name`,
        [city ?? null],
      )
      return rows.map((r) => ({ id: r.id, title: r.name, icon: r.icon, tile: r.tile, description: r.description, vendorsCount: Number(r.vendors) }))
    },
  )

  /* ── выдача ───────────────────────────────────────────────────────── */
  app.get(
    '/catalog/vendors',
    {
      ...authed,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 100 },
            categoryId: { type: 'string', maxLength: 40 },
            city: { type: 'string', maxLength: 80 },
            radiusKm: { type: 'integer', minimum: 0, maximum: 1000, default: 100 },
            priceMin: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
            priceMax: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            ratingMin: { type: 'number', minimum: 0, maximum: 5 },
            hasVideo: { type: 'boolean' },
            sort: { type: 'string', enum: ['rating', 'price_asc', 'price_desc', 'popular'], default: 'rating' },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
            cursor: { type: 'string', maxLength: 300 },
          },
        },
      },
    },
    async (request) => {
      const query = request.query as {
        q?: string
        categoryId?: string
        city?: string
        radiusKm?: number
        priceMin?: number
        priceMax?: number
        date?: string
        ratingMin?: number
        hasVideo?: boolean
        sort?: string
        limit?: number
        cursor?: string
      }
      // Каталог листается по рейтингу и цене, а не по времени: ключ курсора
      // приводится к `::numeric`/`::bigint`/`::int`, и проверять его надо как
      // число своей сортировки. Остальные маршруты сортируют временем — там
      // значение по умолчанию.
      const page = parsePageQuery(query, CATALOG_CURSOR)
      const sortName: SortName = query.sort && query.sort in SORTS ? (query.sort as SortName) : 'rating'
      const sort = SORTS[sortName]

      let after: { down: number; key: string; id: string } | null = null
      if (page.cursor) {
        const [name, down, key] = page.cursor.sort.split('|') as [string, string, string]
        if (name !== sortName || !sort.key.test(key)) {
          throw new AppError(
            400,
            'bad_cursor',
            'Курсор от другой сортировки. Начните листать заново, без параметра cursor.',
          )
        }
        after = { down: Number(down), key, id: page.cursor.id }
      }

      const where: string[] = ['v.published_at is not null']
      const args: unknown[] = []
      // Каждый `?` заменяется своим номером по порядку: условие может
      // просить одно значение дважды (поиск по названию и по синониму).
      const add = (sql: string, ...values: unknown[]) => {
        let filled = sql
        for (const value of values) {
          args.push(value)
          filled = filled.replace('?', `$${args.length}`)
        }
        where.push(filled)
      }

      if (query.categoryId) add('v.category_id = ?', query.categoryId)
      /* Расстояние до города поиска — тем же гаверсинусом, что и фильтр по
       * радиусу (фича 011): ноль у своего города, null без координат у
       * одного из городов; без `city` сравнивать нечего — колонка пустая. */
      let distanceSql = 'null::int'
      if (query.city) {
        args.push(query.city)
        distanceSql = `(select round(6371 * acos(least(1, greatest(-1,
                       sin(radians(anchor.lat)) * sin(radians(c.lat))
                     + cos(radians(anchor.lat)) * cos(radians(c.lat)) * cos(radians(c.lon - anchor.lon))))))::int
                       from cities anchor
                      where anchor.name = $${args.length} and anchor.lat is not null and c.lat is not null
                      limit 1)`
      }
      if (query.city) {
        if (query.radiusKm && query.radiusKm > 0) {
          // Радиус считается от координат города-якоря. Координаты есть
          // не у всех населённых пунктов справочника (их привезёт Яндекс
          // Геокодер), поэтому подрядчик из города без координат попадает
          // в выдачу только по точному совпадению названия — молча выкинуть
          // его было бы хуже, чем показать без учёта расстояния.
          args.push(query.city)
          const cityArg = `$${args.length}`
          args.push(query.radiusKm)
          const radiusArg = `$${args.length}`
          where.push(`(
            c.name = ${cityArg}
            or exists (
              select 1 from cities anchor
               where anchor.name = ${cityArg} and anchor.lat is not null
                 and c.lat is not null
                 and 6371 * acos(least(1, greatest(-1,
                       sin(radians(anchor.lat)) * sin(radians(c.lat))
                     + cos(radians(anchor.lat)) * cos(radians(c.lat)) * cos(radians(c.lon - anchor.lon))))) <= ${radiusArg}
            )
          )`)
        } else {
          add('c.name = ?', query.city)
        }
      }
      if (query.priceMin !== undefined) add('v.price_from >= ?', query.priceMin)
      if (query.priceMax !== undefined) add('v.price_from <= ?', query.priceMax)
      // Фильтр по рейтингу считается только по анкетам, где число показано:
      // иначе выдача отсеивается по цифре, которой на экране нет.
      if (query.ratingMin !== undefined) {
        add(`v.rating >= ? and v.couple_reviews_count >= ${MIN_REVIEWS_TO_SHOW}`, query.ratingMin)
      }
      /* Поиск идёт и по названию, и по словарю синонимов: человек ищет
       * «тамада», а категория называется «Ведущий» (План §19.2). Без
       * словаря такой запрос возвращает пустоту, и это выглядит как
       * «у вас никого нет». */
      if (query.q) {
        add(
          `(lower(v.name) like '%' || lower(?) || '%' escape '\\'
            or v.category_id in (select category_id from category_synonyms where word = lower(?)))`,
          escapeLike(query.q),
          query.q,
        )
      }
      if (query.hasVideo) where.push("exists (select 1 from vendor_media m where m.vendor_id = v.id and m.kind = 'video')")
      if (query.date) {
        // Фильтр по несуществующей дате роняет запрос в базе, а не пустой ответ.
        assertRealDate(query.date, 'date')
        // Занятого на эту дату в выдаче быть не должно: иначе пара пишет тому,
        // кто заведомо не сможет, и тратит на это день.
        add('not exists (select 1 from vendor_busy_dates b where b.vendor_id = v.id and b.date = ?::date)', query.date)
      }

      // Условие «строго после курсора» при разнонаправленных ключах не
      // выражается сравнением кортежей: понижение и идентификатор идут по
      // возрастанию, значение — по убыванию или возрастанию. Поэтому ветки
      // явно, в том же порядке, что и `ORDER BY`: сначала признак понижения,
      // внутри него — значение, внутри значения — идентификатор.
      if (after) {
        args.push(after.down)
        const downArg = `$${args.length}::int`
        args.push(after.key)
        const keyArg = `$${args.length}${sort.cast}`
        args.push(after.id)
        const idArg = `$${args.length}`
        const beyond = sort.dir === 'desc' ? '<' : '>'
        where.push(
          `(${DOWNRANKED} > ${downArg} or (${DOWNRANKED} = ${downArg}
             and (${sort.expr} ${beyond} ${keyArg} or (${sort.expr} = ${keyArg} and v.id > ${idArg}))))`,
        )
      }

      args.push(page.limit + 1)
      const { rows } = await db().query<VendorRow & { sort_key: string; down: boolean }>(
        `select ${VENDOR_COLUMNS}, ${distanceSql} as distance_km, ${sort.expr}::text as sort_key, (v.downranked_at is not null) as down
           from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
          where ${where.join(' and ')}
          order by ${DOWNRANKED}, ${sort.expr} ${sort.dir}, v.id asc
          limit $${args.length}`,
        args,
      )

      const withKeys = rows.map((r) => ({ ...toVendor(r), _key: r.sort_key, _down: r.down }))
      const result = buildPage(withKeys, page.limit, (v) => catalogCursor(sortName, v._down, v._key, v.id))
      const strip = <T extends { _key: string; _down: boolean }>(list: T[]) =>
        list.map(({ _key, _down, ...rest }) => {
          void _key
          void _down
          return rest
        })
      const items = strip(result.items)

      // Ротация новичков — только на первой странице (см. rotateNewcomers).
      if (!page.cursor) {
        /* Пониженная санкцией анкета (`downrank`, §18.2) в квоту новичков не
         * идёт: основная выдача ставит её после всех, а ротация поднимала бы
         * её на первую страницу как «новую» — санкция сводилась к нулю у
         * анкеты без отзывов, то есть ровно у той, что понижена (ревью 015). */
        const { rows: fresh } = await db().query<VendorRow>(
          `select ${VENDOR_COLUMNS}, ${distanceSql} as distance_km
             from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
            where ${where.join(' and ')} and v.reviews_count = 0 and v.downranked_at is null
            order by v.created_at desc
            limit ${page.limit}`,
          args.slice(0, -1),
        )
        const rotated = rotateNewcomers(items, page.limit, fresh.map(toVendor))
        // Курсор берётся по последней ОСТАВШЕЙСЯ строке основной выдачи,
        // а не по исходной последней: иначе вытесненные новичками анкеты
        // не попадут и на вторую страницу — то есть исчезнут насовсем.
        // Цена — новичок может встретиться ещё раз ниже по списку; это видно
        // и безобидно, в отличие от пропажи.
        // Курсор по якорю — той же формы, что и обычный: с именем сортировки
        // и признаком понижения. Иначе вторая страница получает 400 на свой
        // же курсор (D5-09).
        const anchor = result.items[rotated.keptFromMain - 1]
        const nextCursor =
          result.nextCursor === null && rotated.keptFromMain === items.length
            ? null
            : anchor
              ? catalogCursor(sortName, anchor._down, anchor._key, anchor.id)
              : result.nextCursor
        return { items: rotated.items, nextCursor }
      }

      return { items, nextCursor: result.nextCursor }
    },
  )

  /* ── анкета ───────────────────────────────────────────────────────── */
  app.get('/catalog/vendors/:vendorId', authed, async (request) => {
    const { vendorId } = request.params as { vendorId: string }
    if (!isUuid(vendorId)) throw notFound('Анкета не найдена')
    const { rows } = await db().query<VendorRow & { about: string | null; user_id: string }>(
      `select ${VENDOR_COLUMNS}, v.about, v.user_id
         from vendors v ${VENDOR_LIVE_JOIN} left join cities c on c.id = v.city_id
        where v.id = $1 and v.published_at is not null`,
      [vendorId],
    )
    if (rows[0] && rows[0].user_id === request.caller!.userId) {
      /* Своя живая анкета — та же форма, что у своей неопубликованной ниже:
       * с телефоном (он свой) и признаками `published`/`blocked`. До ревью 015
       * владелец опубликованной анкеты проходил веткой пары: телефон
       * прятался «до брони», признаков не было, и предпросмотр «глазами
       * пары» отличался от предпросмотра черновика. Просмотр не считается —
       * условие `user_id <> caller` у счётчика ниже. */
      return { ...(await loadDetail(db(), vendorId, rows[0])), published: true, blocked: false }
    }
    if (!rows[0]) {
      /* Своя анкета — владельцу и до публикации, и под блокировкой: так он
       * смотрит её «глазами пары» из кабинета (фича 007). Чужой черновик —
       * 404, как и раньше: по адресу нельзя узнать, существует ли он.
       * Условие `user_id = caller` — тем же запросом, а не отдельной проверкой
       * прав: две строки для одного факта расходятся. */
      const { rows: mine } = await db().query<VendorRow & { about: string | null; published_at: Date | null; blocked_at: Date | null }>(
        `select ${VENDOR_COLUMNS}, v.about, v.published_at, v.blocked_at
           from vendors v join users u on u.id = v.user_id left join cities c on c.id = v.city_id
          where v.id = $1 and v.user_id = $2`,
        [vendorId, request.caller!.userId],
      )
      if (!mine[0]) throw notFound('Анкета не найдена')
      const own = await loadDetail(db(), vendorId, mine[0])
      return { ...own, published: mine[0].published_at !== null, blocked: mine[0].blocked_at !== null }
    }
    /* Счётчик просмотров — первая ступень воронки в кабинете подрядчика.
     * Считаем открытие карточки, а не показ в списке: в списке анкету
     * пролистывают, а сюда заходят осознанно.
     *
     * Сотрудник платформы в воронку не идёт: модератор открывает карточку
     * по жалобе, а подрядчик читает эту цифру как интерес пары. Владелец
     * анкеты — тем более: свои открытия карточки интересом пар не являются,
     * а до этого каждое его «посмотреть, как выглядит» шло в счётчик
     * (D5-13; уникальность по паре и дню — таблица просмотров, владельцу).
     * Условие — тем же запросом, а не отдельным чтением: два запроса ради
     * счётчика на каждое открытие карточки. */
    await db().query(
      `update vendors set views = views + 1
        where id = $1 and user_id <> $2
          and not exists (select 1 from users where id = $2 and is_staff)`,
      [vendorId, request.caller!.userId],
    )
    // Телефон уходит только тому, кто этого подрядчика уже забронировал.
    return loadDetail(db(), vendorId, rows[0], request.caller!.userId)
  })

  /* ── занятость ────────────────────────────────────────────────────── */
  app.get(
    '/catalog/vendors/:vendorId/availability',
    {
      ...authed,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } },
        },
      },
    },
    async (request) => {
      const { vendorId } = request.params as { vendorId: string }
      const { month } = request.query as { month?: string }
      if (!isUuid(vendorId)) throw notFound('Анкета не найдена')
      /* Календарь — часть анкеты, и живость у него та же, что у карточки:
       * занятость заблокированной, снятой или удалённой анкеты не читается
       * по прямой ссылке, неизвестный id — 404, а не пустой календарь
       * «всё свободно» (D5-20). */
      await assertVendorLive(db(), vendorId)

      const conditions = ['b.vendor_id = $1']
      const args: unknown[] = [vendorId]
      if (month) {
        const [from, to] = monthRange(month)
        args.push(from, to)
        conditions.push('b.date >= $2::date', 'b.date < $3::date')
      }
      const { rows } = await db().query<{ date: string; source: string }>(
        `select b.date::text as date, b.source from vendor_busy_dates b
          where ${conditions.join(' and ')} order by b.date`,
        args,
      )
      /* Дата под мягкой бронью не свободна и не занята: переговоры идут,
       * а договорённости ещё нет. Пустой список означал бы «свободно»,
       * и вторая пара тратила бы время на дату, которая вот-вот уйдёт
       * (План §18.3). */
      const holdDates = await holdDatesOf(
        db(),
        vendorId,
        month ? { from: monthRange(month)[0], to: monthRange(month)[1] } : undefined,
      )
      const busy = new Set(rows.map((r) => r.date))
      return {
        busyDates: [...busy],
        // Занятая дата уже не «под вопросом»: подрядчик мог подтвердить
        // одну бронь, и остальные при этом никуда не делись.
        holdDates: holdDates.filter((d) => !busy.has(d)),
      }
    },
  )

  /* ── консьерж ─────────────────────────────────────────────────────── */
  app.post(
    '/catalog/concierge',
    {
      preHandler: app.requireConsent,
      schema: {
        body: {
          type: 'object',
          required: ['categoryId'],
          additionalProperties: false,
          properties: {
            categoryId: { type: 'string', maxLength: 40 },
            city: { type: 'string', maxLength: 80 },
            budget: {
              type: 'object',
              required: ['amount', 'currency'],
              additionalProperties: false,
              properties: {
                amount: { type: 'integer', minimum: 0, maximum: MONEY_MAX },
                currency: { type: 'string', enum: ['RUB'] },
              },
            },
            comment: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        categoryId: string
        city?: string
        budget?: { amount: number }
        comment?: string
      }
      const { rows: cat } = await db().query('select 1 from categories where id = $1', [body.categoryId])
      if (cat.length === 0) throw notFound('Категория не найдена')

      /* Город — только из справочника: экран берёт его у свадьбы (фича 014),
       * и неизвестное имя здесь — ошибка клиента, а не «без города».
       * До ревью 015 такой город молча становился `null`, и консьерж искал
       * подрядчика неизвестно где (класс ERR-0034). */
      let cityId: number | null = null
      if (body.city) {
        const { rows } = await db().query<{ id: number }>('select id from cities where name = $1 limit 1', [body.city])
        if (!rows[0]) throw validationFailed({ city: 'город не найден в справочнике' })
        cityId = rows[0].id
      }

      await db().tx(async (client) => {
        /* Строка пользователя под замком: «одна открытая заявка на категорию»
         * — правило, а не ограничение базы, и два одновременных нажатия иначе
         * оба видели пустую очередь и заводили две (R-49; ревью 015, V6). */
        await client.query('select 1 from users where id = $1 for update', [request.caller!.userId])
        // Каждая заявка — ручная работа человека: он ищет подрядчика и звонит.
        // Вторая открытая заявка по той же категории новой работы не создаёт,
        // а только плодит очередь, за которую платит владелец.
        const { rows: pending } = await client.query(
          `select 1 from concierge_requests
            where user_id = $1 and category_id = $2 and status in ('new','in_progress')`,
          [request.caller!.userId, body.categoryId],
        )
        if (pending.length > 0) {
          throw new AppError(409, 'concierge_pending', 'Заявка по этой категории уже в работе — мы свяжемся в течение суток')
        }
        await client.query(
          `insert into concierge_requests (id, user_id, category_id, city_id, budget, comment)
           values ($1, $2, $3, $4, $5, $6)`,
          [uuidv7(), request.caller!.userId, body.categoryId, cityId, body.budget?.amount ?? null, body.comment ?? null],
        )
      })
      return reply.code(201).send()
    },
  )

  /* ── избранное ────────────────────────────────────────────────────── */
  app.get('/me/favorites', { preHandler: app.requireConsent }, async (request) => {
    /* Живость та же, что у карточки, включая `published_at`: снятая
     * модератором анкета оставалась в избранном, а карточка по ней
     * отвечала 404 — сердечко вело в никуда (D5-20). */
    const { rows } = await db().query<VendorRow>(
      `select ${VENDOR_COLUMNS}
         from favorites f
         join vendors v on v.id = f.vendor_id
         ${VENDOR_LIVE_JOIN}
         left join cities c on c.id = v.city_id
        where f.user_id = $1 and v.published_at is not null
        order by f.created_at desc`,
      [request.caller!.userId],
    )
    return rows.map(toVendor)
  })

  app.put('/me/favorites/:vendorId', { preHandler: app.requireConsent }, async (request, reply) => {
    const { vendorId } = request.params as { vendorId: string }
    if (!isUuid(vendorId)) throw notFound('Анкета не найдена')
    const { rows } = await db().query(
      `select 1 from vendors v ${VENDOR_LIVE_JOIN} where v.id = $1 and v.published_at is not null`,
      [vendorId],
    )
    if (rows.length === 0) throw notFound('Анкета не найдена')

    // Повторное добавление — не ошибка: человек нажал сердечко дважды.
    await db().query('insert into favorites (user_id, vendor_id) values ($1, $2) on conflict do nothing', [
      request.caller!.userId,
      vendorId,
    ])
    return reply.code(204).send()
  })

  app.delete(
    '/me/favorites/:vendorId',
    {
      preHandler: app.requireConsent,
      // `favorites.vendor_id` — колонка uuid. У соседнего PUT проверка есть,
      // у удаления её не было: чужая строка роняла запрос ошибкой драйвера
      // и превращалась в 500 (ERR-0104, R-118).
      schema: { params: { type: 'object', required: ['vendorId'], properties: { vendorId: UUID_ID } } },
    },
    async (request, reply) => {
      const { vendorId } = request.params as { vendorId: string }
      await db().query('delete from favorites where user_id = $1 and vendor_id = $2', [
        request.caller!.userId,
        vendorId,
      ])
      // Удаление того, чего нет, — тоже успех: результат ровно тот, которого хотели.
      return reply.code(204).send()
    },
  )
}
