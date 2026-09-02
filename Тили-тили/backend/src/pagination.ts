import { AppError } from './errors.js'

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

export function decodeCursor(raw: string): Cursor {
  const text = Buffer.from(raw, 'base64url').toString('utf8')
  const sep = text.lastIndexOf('|')
  if (sep <= 0 || sep === text.length - 1) {
    throw new AppError(400, 'bad_cursor', 'Курсор испорчен. Начните листать заново, без параметра cursor.')
  }
  return { sort: text.slice(0, sep), id: text.slice(sep + 1) }
}

export function parsePageQuery(query: { limit?: unknown; cursor?: unknown }): PageQuery {
  let limit = DEFAULT_LIMIT
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit)
    if (!Number.isInteger(n) || n < 1) {
      throw new AppError(400, 'bad_limit', 'limit — целое число от 1 до 100.')
    }
    limit = Math.min(n, MAX_LIMIT)
  }
  const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? decodeCursor(query.cursor) : null
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
