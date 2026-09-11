import type { Db, Queryable } from '../plugins/db.js'
import { notFound } from '../errors.js'
import { publicRating } from '../reviews/rating.js'

/**
 * Сборка карточек подрядчика в один слой.
 *
 * Здесь же проходит граница «что видно снаружи»: в ответ попадают только эти
 * поля. Документы верификации (`vendor_verifications.file_url`) не выбираются
 * ни одним запросом каталога — наружу выходит только признак `verified`
 * (план §6). Это условие закреплено тестом, который ищет `file_url` в теле.
 */
export interface VendorRow {
  id: string
  name: string
  category_id: string
  city: string | null
  price_from: string | null
  currency: string
  rating: string | null
  reviews_count: number
  photo_url: string | null
  verified_at: Date | null
  has_video: boolean
  created_at: Date
  /** Рабочий телефон. В карточку попадает не всегда — см. `loadDetail`. */
  phone?: string | null
}

/**
 * Анкета видна в каталоге, только пока её владелец в сервисе.
 *
 * Удаление аккаунта мягкое — строка остаётся на 30 дней, — но человек уже
 * ушёл: показывать его анкету и принимать по ней заявки нельзя. Условие
 * живёт здесь, рядом с набором колонок, чтобы его нельзя было забыть
 * в очередном запросе каталога.
 */
/* Живая анкета: аккаунт не удалён и подрядчик не заблокирован модерацией.
 * Блокировка — крайняя санкция §18.2, и она означает «нет в выдаче»,
 * а не «есть, но с пометкой». */
export const VENDOR_LIVE_JOIN =
  'join users u on u.id = v.user_id and u.deleted_at is null and v.blocked_at is null'

/**
 * Анкета живая и опубликована — иначе 404.
 *
 * Одно условие на все пути анкеты: карточку, ленту отзывов и календарь
 * занятости. Пока лента и календарь проверяли только форму идентификатора,
 * отзывы и даты заблокированной, снятой или удалённой анкеты читались по
 * прямой ссылке, а неизвестный id получал `200 []` (D5-20).
 */
export async function assertVendorLive(db: Queryable, vendorId: string): Promise<void> {
  const { rows } = await db.query(
    `select 1 from vendors v ${VENDOR_LIVE_JOIN} where v.id = $1 and v.published_at is not null`,
    [vendorId],
  )
  if (rows.length === 0) throw notFound('Анкета не найдена')
}

/**
 * `%`, `_` и `\` в поисковой строке — буквы, а не шаблон `LIKE`.
 *
 * Без экранирования `q=%` возвращал всю категорию (и весь справочник
 * городов), а «Foto_Studio» находился по «FotoXStudio»: выдача по запросу,
 * которого человек не задавал (D5-11). Запрос всё равно параметр — это не
 * инъекция, — но смысл его был чужой. Экранированную строку ставить только
 * в `like … escape '\'`.
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

export const VENDOR_COLUMNS = `
  v.id, v.name, v.category_id, c.name as city, v.price_from::text as price_from, v.currency,
  v.rating::text as rating, v.reviews_count, v.photo_url, v.verified_at, v.created_at, v.phone,
  exists (select 1 from vendor_media m where m.vendor_id = v.id and m.kind = 'video') as has_video`

export function toVendor(r: VendorRow) {
  return {
    id: r.id,
    name: r.name,
    categoryId: r.category_id,
    city: r.city,
    priceFrom: r.price_from === null ? null : { amount: Number(r.price_from), currency: r.currency },
    /* До трёх отзывов числа нет — в выдаче стоит «Новый на платформе»
     * (План §18.2). Один отзыв от знакомого это 5,0 и первое место, и
     * прятать цифру надо здесь, в одном месте на все ответы каталога. */
    rating: publicRating(r.rating === null ? null : Number(r.rating), r.reviews_count),
    reviewsCount: r.reviews_count,
    photoUrl: r.photo_url,
    verified: r.verified_at !== null,
    hasVideo: r.has_video,
  }
}

export interface PackageRow {
  id: string
  name: string
  price: string | null
  currency: string
  items: string[]
}

export interface MediaRow {
  kind: 'photo' | 'video'
  url: string
  duration_s: number | null
}

/**
 * Кто уже вправе позвонить.
 *
 * Решение владельца 2026-09-03: телефон в анкете видит пара, которая этого
 * подрядчика забронировала, — до брони разговор идёт в чате. Право даёт
 * не роль, а сделка: помощник и координатор той же свадьбы звонят по тому
 * же поводу, что и пара, и в день X контакты команды нужны всем троим.
 *
 * Троим — и только им. Участник с ролью `vendor` (другой подрядчик, принятый
 * ПОДР-ссылкой) в решении не назван: без условия по роли он читал телефоны
 * всех забронированных коллег по свадьбе (D5-25, D1-04).
 */
async function mayCall(db: Db, vendorId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false
  const { rows } = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from deals d
         join wedding_members m on m.wedding_id = d.wedding_id and m.user_id = $2
        where d.vendor_id = $1 and d.state in ('booked','paid_deposit','done')
          and m.role in ('couple','helper','coordinator')
     ) as ok`,
    [vendorId, userId],
  )
  return rows[0]!.ok
}

export async function loadDetail(db: Db, vendorId: string, row: VendorRow, viewerId: string | null = null) {
  const { rows: packages } = await db.query<PackageRow>(
    `select id, name, price::text as price, currency, items from vendor_packages
      where vendor_id = $1 order by sort, name`,
    [vendorId],
  )
  const { rows: media } = await db.query<MediaRow>(
    'select kind, url, duration_s from vendor_media where vendor_id = $1 order by sort, url',
    [vendorId],
  )
  /* Первые отзывы — прямо в карточке. Пустой список означал «отзывов нет»
   * рядом с надписью «4,8 · 47 отзывов»: карточка — главный экран выбора
   * подрядчика, и рейтинг без единого отзыва верить не помогает.
   * Остальные листаются отдельным путём с курсором. */
  const { rows: reviewRows } = await db.query<{
    id: string
    source: string
    stars: number
    text: string | null
    reply: string | null
    replied_at: Date | null
    created_at: Date
  }>(
    `select id, source, stars, text, reply, replied_at, created_at
       from reviews where vendor_id = $1 and hidden_at is null
      order by created_at desc limit 5`,
    [vendorId],
  )
  const reviews = reviewRows.map((r) => ({
    id: r.id,
    source: r.source,
    // Бейдж рисуется по источнику: у пары договор, у гостя впечатление (§15).
    authorName: r.source === 'guest' ? 'Гость свадьбы' : 'Пара со сделкой',
    rating: r.stars,
    text: r.text ?? '',
    createdAt: r.created_at.toISOString(),
    reply: r.reply ? { text: r.reply, createdAt: (r.replied_at ?? r.created_at).toISOString() } : null,
  }))

  /* Своя анкета отдаётся владельцу целиком (`viewerId === null` приходит
   * из кабинета, где строка и так своя), чужая — только с бронью. */
  const phone = row.phone ?? null
  const showPhone = viewerId === null || (await mayCall(db, vendorId, viewerId))

  return {
    ...toVendor(row),
    // Номер приходит пустым, пока сделки нет: это не «телефона не указали»,
    // а «ещё рано». Клиент показывает вместо него кнопку «Написать».
    phone: showPhone ? phone : null,
    about: row_about(row),
    gallery: media.filter((m) => m.kind === 'photo').map((m) => m.url),
    media: media.map((m) => ({ kind: m.kind, url: m.url, durationS: m.duration_s })),
    packages: packages.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price === null ? null : { amount: Number(p.price), currency: p.currency },
      includes: p.items,
    })),
    reviews,
  }
}

/** `about` живёт в той же строке, но не входит в карточку выдачи. */
function row_about(row: VendorRow & { about?: string | null }): string | null {
  return row.about ?? null
}

/**
 * Ротация новичков: доля первой страницы отдана анкетам без отзывов.
 *
 * Без неё каталог зарастает: у кого есть отзывы, тот получает показы, получает
 * ещё отзывы и вытесняет новых навсегда. План §19.2 требует 10 %.
 *
 * Применяется только к первой странице. На страницах с курсором подмена
 * привела бы к повторам и пропускам: строка, вставленная в середину, сдвигает
 * всё, что идёт после неё.
 */
export interface Rotated<T> {
  items: T[]
  /** Сколько строк основной выдачи осталось. По ним считается курсор. */
  keptFromMain: number
}

export function rotateNewcomers<T extends { reviewsCount: number }>(
  items: T[],
  limit: number,
  pool: T[],
): Rotated<T> {
  const need = Math.ceil(limit / 10)
  const have = items.filter((v) => v.reviewsCount === 0).length
  if (have >= need || pool.length === 0) return { items, keptFromMain: items.length }

  const missing = Math.min(need - have, pool.length)
  const known = new Set(items.map((v) => (v as unknown as { id: string }).id))
  const additions = pool.filter((v) => !known.has((v as unknown as { id: string }).id)).slice(0, missing)
  if (additions.length === 0) return { items, keptFromMain: items.length }

  // Новички занимают места в хвосте: верх выдачи остаётся у тех, кого
  // выбрала сортировка, а вытесняются самые слабые из показанных.
  const kept = items.slice(0, Math.max(0, items.length - additions.length))
  return { items: [...kept, ...additions], keptFromMain: kept.length }
}
