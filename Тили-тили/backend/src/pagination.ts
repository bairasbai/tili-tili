import { AppError } from './errors.js'
import { UUID_RE } from './ids.js'
import { isRealDate } from './wedding/dates.js'

/**
 * Пагинация по курсору, а не по offset.
 *
 * offset ломается на живых данных: пока гость листает каталог, кто-то добавляет
 * анкету — и вторая страница показывает запись, которую пользователь уже видел
 * на первой. Курсор указывает на конкретную строку, вставки его не сдвигают.
 *
 * Курсор — base64url от `${sortValue}|${id}`. Второй ключ обязателен: у двух
 * анкет может совпасть дата создания, и без id порядок между ними не определён.
 */
export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 100

export interface PageQuery {
  limit: number
  cursor: Cursor | null
}

export interface Cursor {
  sort: string
  id: string
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

export function encodeCursor(sort: string, id: string): string {
  return Buffer.from(`${sort}|${id}`, 'utf8').toString('base64url')
}

/**
 * Ключ курсора по времени — текстом из базы, с микросекундами.
 *
 * Драйвер отдаёт `timestamptz` как `Date`, а у него миллисекунды: курсор
 * `(created_at, id) > ($cursor, $id)` с усечённым временем пропускал строки,
 * записанные в те же миллисекунды после последней на странице (фича 014,
 * D4-23 — лента сообщений; ревью 015 — очереди панели и лента отзывов).
 * Формат — ISO с шестью знаками дроби, который `decodeCursor` принимает и
 * `::timestamptz` приводит без потерь. Аргумент — выражение колонки.
 */
export function timestampKey(column: string): string {
  return `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
}

/**
 * Чем сортирует маршрут: этим задаётся тип, к которому приводится ключ в SQL.
 * По времени листают почти все — каталог сортирует числами (рейтинг, цена).
 *
 * Регулярное выражение — для ключа составного вида: каталог несёт в курсоре
 * имя сортировки и признак понижения рядом со значением, и форму такого
 * ключа знает только он (D5-09, D5-10). Проверка всё равно идёт здесь, до
 * базы: испорченный курсор — 400, а не ошибка приведения типа и 500.
 */
export type CursorSort = 'timestamp' | 'number' | RegExp

/** Идентификатор в курсоре — всегда uuid: он сравнивается с колонкой `id`. */
const CURSOR_ID = UUID_RE
/* Ключ по времени — только ISO-вид, каким его выдаёт `Date#toISOString`:
   `Date.parse` принимает и `'2026'`, и `'1'`, а `'2026'::timestamptz` в
   PostgreSQL 16 — ошибка приведения, то есть 500 (ERR-0221). */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/
/** Числовой ключ. Своё, а не `Number()`: тот принимает `0x10` и ` 12 `, база — нет. */
const CURSOR_NUMBER = /^-?\d+(\.\d+)?$/

export function badCursor(): never {
  throw new AppError(400, 'bad_cursor', 'Курсор испорчен. Начните листать заново, без параметра cursor.')
}

/**
 * Курсор по времени — календарная дата, час и смещение пояса в пределах,
 * которые PostgreSQL действительно принимает.
 *
 * `CURSOR_TIMESTAMP` и `Date.parse` проверяют только форму: 30 февраля,
 * 31 апреля и год 0000 форму ISO проходят, и `Date.parse` их молча переносит
 * на соседние календарные даты вместо `NaN`; смещение пояса шире ±16:00
 * `Date.parse` тоже принимает (вплоть до ±23:59) — а `'…'::timestamptz` в
 * PostgreSQL 16 на обоих падает ошибкой приведения — 500 вместо 400
 * (ERR-0221 / ERR-0276). Час ≥ 25 форму ISO не проходит по смыслу, но и
 * отдельно: `Date.parse` в этой реализации V8 уже даёт на нём `NaN` — проверка
 * часа ниже не обходит существующую дыру, а задаёт явный контракт для часа,
 * ровно равного 24. Курсоры мы выдаём сами (`timestampKey`, смещение всегда
 * `Z`), поэтому «широкий» пришедший обратно — подделка, а не наш формат.
 *
 * `24:00:00` — законная запись PostgreSQL для полуночи конца суток
 * (документированное поведение `timestamp`/`timestamptz`), и только она:
 * любой другой час, равный 24, — уже не эта запись.
 */
/** PostgreSQL 16 отклоняет смещение пояса от ±16:00 («вне диапазона»); `Date.parse` рвётся только на ±24:00. */
const MAX_ZONE_OFFSET_HOUR = 15

function isRealTimestamp(sort: string): boolean {
  if (!CURSOR_TIMESTAMP.test(sort) || Number.isNaN(Date.parse(sort))) return false
  if (!isRealDate(sort.slice(0, 10))) return false
  const zone = /[+-](\d{2}):\d{2}$/.exec(sort)
  if (zone && Number(zone[1]) > MAX_ZONE_OFFSET_HOUR) return false
  const hour = Number(sort.slice(11, 13))
  if (hour < 24) return true
  return hour === 24 && /^24:00:00(Z|[+-]\d{2}:\d{2})$/.test(sort.slice(11))
}

/**
 * Обе половинки курсора приходят от клиента и уходят в запрос С ПРИВЕДЕНИЕМ
 * ТИПА: `$1::timestamptz`, `$2::uuid`, `::bigint`. Строка, которую PostgreSQL
 * привести не может, роняет запрос ошибкой синтаксиса, а обработчик переводит
 * её в 500 «внутренняя ошибка» с записью в лог как о падении сервера. То есть
 * любой вошедший пользователь одной подделанной строкой запроса пишет в журнал
 * аварию. Проверка формата здесь, до базы: испорченный курсор — это 400.
 *
 * Разделителя `|` мало: он был единственной проверкой, и `мусор|мусор` её
 * проходил.
 */
export function decodeCursor(raw: string, kind: CursorSort = 'timestamp'): Cursor {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const sep = text.lastIndexOf('|')
  if (sep <= 0 || sep === text.length - 1) badCursor()

  const sort = text.slice(0, sep)
  const id = text.slice(sep + 1)
  if (!CURSOR_ID.test(id)) badCursor()
  // Курсоры мы выдаём в ISO — только такой вид и принимаем обратно: всё, что
  // шире, база может не привести, и тогда это 500, а не 400.
  const sortOk =
    kind === 'timestamp'
      ? isRealTimestamp(sort)
      : kind === 'number'
        ? CURSOR_NUMBER.test(sort)
        : kind.test(sort)
  if (!sortOk) badCursor()
  return { sort, id }
}

export function parsePageQuery(
  query: { limit?: unknown; cursor?: unknown },
  kind: CursorSort = 'timestamp',
): PageQuery {
  let limit = DEFAULT_LIMIT
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit)
    if (!Number.isInteger(n) || n < 1) {
      throw new AppError(400, 'bad_limit', 'limit — целое число от 1 до 100.')
    }
    limit = Math.min(n, MAX_LIMIT)
  }
  const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? decodeCursor(query.cursor, kind) : null
  return { limit, cursor }
}

/**
 * Из базы берём limit + 1 строку. Лишняя не отдаётся — она только отвечает
 * на вопрос «есть ли следующая страница», без второго COUNT-запроса.
 */
export function buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => string): Page<T> {
  if (rows.length <= limit) return { items: rows, nextCursor: null }
  const items = rows.slice(0, limit)
  const last = items[items.length - 1] as T
  return { items, nextCursor: cursorOf(last) }
}
