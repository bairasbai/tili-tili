import type { Queryable } from '../plugins/db.js'
import { AppError, forbidden, notFound } from '../errors.js'
import type { Role } from '../wedding/access.js'

/**
 * Кто какой чат видит — раздел 6 плана, одним списком.
 *
 * Чаты живут вне адресов со свадьбой, поэтому общий хук доступа их не
 * закрывает. Правила собраны здесь по той же причине, по какой собрана
 * матрица: проверка, размазанная по обработчикам, забывается ровно один
 * раз — и этого достаточно.
 */
export type ChatKind = 'vendor' | 'team' | 'day' | 'tilly'

/** Что роль видит из чатов свадьбы. Роли, которой нет в списке, — ничего. */
const VISIBLE: Partial<Record<Role, ChatKind[]>> = {
  // Тиль — личный помощник пары; помощнику и координатору он не нужен.
  couple: ['vendor', 'team', 'day', 'tilly'],
  coordinator: ['vendor', 'team', 'day'],
  helper: ['team', 'day'],
}

export interface ChatRow {
  id: string
  wedding_id: string
  kind: ChatKind
  vendor_id: string | null
  opens_at: Date | null
}

export interface ChatCaller {
  chat: ChatRow
  /** `vendor` — подрядчик пришёл в свой чат, роли в свадьбе у него нет. */
  as: Role
}

export const CHAT_COLUMNS = 'c.id, c.wedding_id, c.kind, c.vendor_id, c.opens_at'

/**
 * Достаёт чат и проверяет право читать его.
 *
 * Чужой чат — 404, а не 403: по кодам ответа не должно быть видно, какие
 * идентификаторы существуют. 403 остаётся для своего же участника свадьбы,
 * которому этот вид чата не положен: он и так знает, что чат есть.
 */
export async function chatForUser(db: Queryable, chatId: string, userId: string): Promise<ChatCaller> {
  if (!/^[0-9a-f-]{36}$/i.test(chatId)) throw notFound('Чат не найден')

  const { rows } = await db.query<ChatRow & { role: Role | null; owner_id: string | null }>(
    `select ${CHAT_COLUMNS}, m.role, v.user_id as owner_id
       from chats c
       join weddings w on w.id = c.wedding_id
       left join wedding_members m on m.wedding_id = c.wedding_id and m.user_id = $2
       left join vendors v on v.id = c.vendor_id
      where c.id = $1 and w.archived_at is null and w.cancelled_at is null`,
    [chatId, userId],
  )
  const row = rows[0]
  if (!row) throw notFound('Чат не найден')

  const chat: ChatRow = {
    id: row.id,
    wedding_id: row.wedding_id,
    kind: row.kind,
    vendor_id: row.vendor_id,
    opens_at: row.opens_at,
  }

  if (row.role) {
    if (!(VISIBLE[row.role] ?? []).includes(row.kind)) throw forbidden('Этот чат не для вашей роли')
    return { chat, as: row.role }
  }
  // Подрядчик участником свадьбы не числится — он приходит в свой чат.
  if (row.owner_id && row.owner_id === userId) return { chat, as: 'vendor' }
  throw notFound('Чат не найден')
}

/**
 * Чат дня X существует с самого начала, но до срока закрыт.
 *
 * 423 вместо 403: доступ не запрещён, он ещё не наступил. Разница видна
 * пользователю — «откроется 13 июня в 09:00» вместо «нет доступа».
 */
export function assertOpen(chat: ChatRow, now = new Date()): void {
  if (chat.kind !== 'day') return
  // Даты нет — открывать нечего: «накануне свадьбы» без свадьбы не наступает.
  // Пустое `opens_at` как «открыт» означало бы чат дня X за год до него.
  if (!chat.opens_at) {
    throw new AppError(423, 'wedding_date_unknown', 'Чат дня X откроется накануне свадьбы — сначала назначьте дату')
  }
  if (chat.opens_at.getTime() <= now.getTime()) return
  throw new AppError(
    423,
    'chat_not_open_yet',
    `Чат дня X откроется ${chat.opens_at.toISOString()} — накануне свадьбы в 09:00`,
  )
}
