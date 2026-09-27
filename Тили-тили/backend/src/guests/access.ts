import { randomBytes, randomInt } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError } from '../errors.js'

/**
 * Гость работает без аккаунта — по персональному токену.
 *
 * Токен паре не отдаётся НИКОГДА (ERR-0019): она пересылает одноразовую
 * ссылку, гость меняет её на токен в своём браузере. Иначе пара откроет
 * гостевую страницу и увидит его резерв подарка — а анонимность резервов
 * обещана в §9 бизнес-логики.
 */
export interface GuestCaller {
  guestId: string
  weddingId: string
  invitationId: string
  name: string
}

declare module 'fastify' {
  interface FastifyRequest {
    guest?: GuestCaller
  }
}

/** 128 бит: токен живёт в ссылке и вслух не читается, длина важнее удобства. */
export function newGuestToken(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Код одноразовой ссылки. Короткий и читаемый: его пересылают в мессенджере
 * и иногда диктуют. Одноразовость и срок делают короткую длину достаточной.
 */
const SHARE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679'

/**
 * randomInt, а не Math.random — по той же причине, что в `wedding/codes.ts`
 * и `auth/otp.ts`: этот код обменивается на токен гостя, то есть он и есть
 * доступ к чужой свадьбе.
 *
 * Math.random в V8 — xorshift128+ с общим состоянием на весь процесс. Пара,
 * которая выпускает ссылки на СВОЕЙ свадьбе, набирает выборку выходов того же
 * генератора, что обслуживает всех остальных, восстанавливает его состояние
 * и предсказывает коды чужих гостей. Одноразовость и срок жизни от этого
 * не защищают: предсказанный код гасится первым.
 */
export function newShareCode(): string {
  const group = () =>
    Array.from({ length: 4 }, () => SHARE_ALPHABET[randomInt(0, SHARE_ALPHABET.length)]).join('')
  return `${group()}-${group()}`
}

export async function guestByToken(db: Queryable, token: string): Promise<GuestCaller> {
  if (!token || token.length > 200) throw new AppError(401, 'unauthorized', 'Нужна ссылка-приглашение')
  const { rows } = await db.query<{ id: string; wedding_id: string; invitation_id: string; name: string }>(
    `select g.id, g.wedding_id, g.invitation_id, g.name
       from guests g
       join guest_invitations i on i.id = g.invitation_id
       join weddings w on w.id = g.wedding_id
      where (g.rsvp_token = $1 or i.rsvp_token = $1)
        and w.cancelled_at is null and w.archived_at is null
      order by (g.rsvp_token = $1) desc, g.created_at, g.id
      limit 1`,
    [token],
  )
  const guest = rows[0]
  // Один и тот же ответ на «нет такого токена» и «свадьба отменена»:
  // по кодам ответа не должно быть видно, существовал ли токен.
  if (!guest) throw new AppError(401, 'unauthorized', 'Ссылка недействительна')
  return { guestId: guest.id, weddingId: guest.wedding_id, invitationId: guest.invitation_id, name: guest.name }
}

export async function guestPersonByToken(db: Queryable, token: string, guestId: string): Promise<GuestCaller> {
  if (!token || token.length > 200) throw new AppError(401, 'unauthorized', 'Нужна ссылка-приглашение')
  const { rows } = await db.query<{ id: string; wedding_id: string; invitation_id: string; name: string }>(
    `select g.id, g.wedding_id, g.invitation_id, g.name
       from guests g
       join guest_invitations i on i.id = g.invitation_id
       join weddings w on w.id = g.wedding_id
      where g.id = $2
        and (g.rsvp_token = $1 or i.rsvp_token = $1)
        and w.cancelled_at is null and w.archived_at is null`,
    [token, guestId],
  )
  const guest = rows[0]
  if (!guest) throw new AppError(404, 'not_found', 'Гость не найден')
  return { guestId: guest.id, weddingId: guest.wedding_id, invitationId: guest.invitation_id, name: guest.name }
}

export async function guestFamilyByToken(db: Queryable, token: string) {
  const anchor = await guestByToken(db, token)
  const { rows } = await db.query<{
    id: string
    name: string
    rsvp: string
    diet: string | null
    diet_note: string | null
    transfer: string | null
    table_id: string | null
    menu_option_id: string | null
    bus_id: string | null
    hotel_id: string | null
  }>(
    `select g.id, g.name, g.rsvp, g.diet, g.diet_note, g.transfer, g.table_id, g.menu_option_id,
            (select b.bus_id from bus_bookings b where b.guest_id = g.id limit 1) as bus_id,
            (select h.hotel_id from hotel_bookings h where h.guest_id = g.id limit 1) as hotel_id
       from guests g
      where g.invitation_id = $1
      order by g.created_at, g.id`,
    [anchor.invitationId],
  )
  return { ...anchor, people: rows }
}

export function readGuestToken(request: FastifyRequest): string | null {
  const fromPath = (request.params as { guestToken?: string }).guestToken
  if (fromPath) return fromPath
  const fromQuery = (request.query as { guestToken?: string } | undefined)?.guestToken
  return fromQuery ?? null
}

/**
 * Операции, куда гость ходит по токену, хотя в адресе есть идентификатор свадьбы.
 *
 * Ключ — «метод + путь», а не путь: `GET …/guest-reviews` читает пара, и
 * гостю он не положен. Пока список был по пути, хук пускал гостя и на GET,
 * обработчик ждал участника свадьбы, которого нет, — и падал в 500.
 * Гость одним запросом писал в журнал аварию (аудит 2026-09-06, блок 3).
 */
export const GUEST_ACCESSIBLE_WEDDING_PATHS = new Set([
  'GET /weddings/:weddingId/album',
  'POST /weddings/:weddingId/album',
  // Отзыв о подрядчике гость оставляет по своему токену: аккаунта у него
  // нет, и общий хук доступа отвечал бы 401 на законный запрос.
  'POST /weddings/:weddingId/guest-reviews',
])
