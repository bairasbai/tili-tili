import type { Queryable } from '../plugins/db.js'
import { AppError, forbidden, notFound } from '../errors.js'
import type { Role } from '../wedding/access.js'
import { isUuid } from '../ids.js'

/**
 * Кто какой чат видит — раздел 6 плана, одним списком.
 *
 * Чаты живут вне адресов со свадьбой, поэтому общий хук доступа их не
 * закрывает. Правила собраны здесь по той же причине, по какой собрана
 * матрица: проверка, размазанная по обработчикам, забывается ровно один
 * раз — и этого достаточно.
 */
export type ChatKind = 'vendor' | 'team' | 'day' | 'tilly' | 'external' | 'crew'

/**
 * Что роль видит из чатов свадьбы. Роли, которой нет в списке, — ничего.
 *
 * `crew` у пары намеренно нет. Чат исполнителей ведёт координатор, и пара
 * в нём не состоит (решение владельца 2026-09-03) — но САМ ФАКТ чата она
 * видит: строку в списке отдаёт запрос в `routes/chats.ts`, а сюда пара
 * не попадает и переписку не читает.
 */
const VISIBLE: Partial<Record<Role, ChatKind[]>> = {
  // Тиль — личный помощник пары; помощнику и координатору он не нужен.
  couple: ['vendor', 'team', 'day', 'tilly', 'external'],
  // Координатор ведёт переписку со ВСЕМИ подрядчиками — и с теми, кого пара
  // нашла сама: в день X разница между ними исчезает (Бизнес-логика §2).
  coordinator: ['vendor', 'team', 'day', 'external', 'crew'],
  helper: ['team', 'day'],
}

/** Что видит подрядчик со своей стороны — ролью в свадьбе он не числится. */
const VENDOR_VISIBLE: ChatKind[] = ['vendor', 'team', 'crew']

/**
 * Какие роли свадьбы видят чат этого вида.
 *
 * Выводится из `VISIBLE`, а не пишется вторым списком. Второй список уже
 * разошёлся: рассылка уведомлений в `routes/chats.ts` учитывала единственный
 * случай (`crew` — только координатору) и слала всем участникам всё остальное.
 * Помощник получал в теле уведомления первые 120 символов переписки пары
 * с подрядчиком — той самой, которую матрица от него закрывает, и открыть
 * её по ссылке он не мог: 403 (ERR-0099).
 */
export function rolesSeeing(kind: ChatKind): Role[] {
  return (Object.keys(VISIBLE) as Role[]).filter((role) => (VISIBLE[role] ?? []).includes(kind))
}

export interface ChatRow {
  id: string
  wedding_id: string
  kind: ChatKind
  vendor_id: string | null
  /** Заполнен только у чата со своим подрядчиком: по нему список чатов находит слот. */
  slot_id: string | null
  /**
   * Только у чата со своим подрядчиком: переписка принадлежит СДЕЛКЕ, не
   * слоту. Слот переживает подрядчика — пара убрала А и позвала Б в тот же
   * слот, и чат по слоту отдавал Б реплики А (ERR-0219). Ключ по сделке
   * держит уникальный индекс `chats(deal_id) where kind='external'`.
   */
  deal_id: string | null
  opens_at: Date | null
}

export interface ChatCaller {
  chat: ChatRow
  /** `vendor` — подрядчик пришёл в свой чат, роли в свадьбе у него нет. */
  as: Role
}

export const CHAT_COLUMNS = 'c.id, c.wedding_id, c.kind, c.vendor_id, c.slot_id, c.deal_id, c.opens_at'

/**
 * Достаёт чат и проверяет право читать его.
 *
 * Чужой чат — 404, а не 403: по кодам ответа не должно быть видно, какие
 * идентификаторы существуют. 403 остаётся для своего же участника свадьбы,
 * которому этот вид чата не положен: он и так знает, что чат есть.
 */
export async function chatForUser(db: Queryable, chatId: string, userId: string): Promise<ChatCaller> {
  if (!isUuid(chatId)) throw notFound('Чат не найден')

  const { rows } = await db.query<
    ChatRow & { role: Role | null; owner_id: string | null; booked: boolean; caller_blocked: boolean }
  >(
    `select ${CHAT_COLUMNS}, m.role, v.user_id as owner_id,
            exists(select 1 from deals d join vendors mine on mine.id = d.vendor_id
                    where d.wedding_id = c.wedding_id and mine.user_id = $2
                      and d.state in ('booked','paid_deposit','done')) as booked,
            -- Анкета того, кто пришёл, заблокирована модератором.
            exists(select 1 from vendors b where b.user_id = $2 and b.blocked_at is not null) as caller_blocked
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
    slot_id: row.slot_id,
    deal_id: row.deal_id,
    opens_at: row.opens_at,
  }

  if (row.role) {
    if (!(VISIBLE[row.role] ?? []).includes(row.kind)) {
      // Паре про чат исполнителей объясняем прямо: она его видит в списке,
      // и «не для вашей роли» выглядело бы поломкой, а не устройством.
      if (row.kind === 'crew') {
        throw forbidden('Чат исполнителей ведёт координатор — переписка в нём паре не показывается')
      }
      throw forbidden('Этот чат не для вашей роли')
    }
    return { chat, as: row.role }
  }
  /* Подрядчик участником свадьбы не числится — он приходит со своей стороны.
   * Свой чат открыт ему всегда, общие — только пока он забронирован:
   * §3.11 говорит про «забронированных подрядчиков», а кандидат чужую
   * кухню обсуждать не должен. */
  const asVendor = (row.owner_id !== null && row.owner_id === userId) || (row.booked && VENDOR_VISIBLE.includes(row.kind))
  if (!asVendor) throw notFound('Чат не найден')
  /* Блокировка — высшая санкция модератора (План §18.2), и переписка в неё
   * входит: заблокированный за спам или мошенничество не должен продолжать
   * писать парам из своих чатов и сидеть в общих чатах свадьбы, пока сделка
   * числится забронированной. Каталог его уже не показывает (ERR-0197) —
   * чаты закрываются той же дверью. 403, а не 404: чат есть, и он его знает. */
  if (row.caller_blocked) {
    throw new AppError(403, 'vendor_blocked', 'Анкета заблокирована — переписка на платформе недоступна')
  }
  return { chat, as: 'vendor' }
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
