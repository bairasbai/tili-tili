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
  /** Primary person kept for legacy single-person paths (reviews/chat/album). */
  guestId: string
  /** Family/company invitation that owns the token. */
  partyId: string
  weddingId: string
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
  const { rows } = await db.query<{ party_id: string; id: string; wedding_id: string; name: string }>(
    `select p.id as party_id, primary_person.id, p.wedding_id, primary_person.name
       from guest_parties p
       join weddings w on w.id = p.wedding_id
       join lateral (
         select g.id, g.name
           from guests g
          where g.party_id = p.id
          order by g.is_primary desc, g.created_at, g.id
          limit 1
       ) primary_person on true
      where p.rsvp_token = $1 and w.cancelled_at is null and w.archived_at is null`,
    [token],
  )
  const guest = rows[0]
  // Один и тот же ответ на «нет такого токена» и «свадьба отменена»:
  // по кодам ответа не должно быть видно, существовал ли токен.
  if (!guest) throw new AppError(401, 'unauthorized', 'Ссылка недействительна')
  return { guestId: guest.id, partyId: guest.party_id, weddingId: guest.wedding_id, name: guest.name }
}

/**
 * Person selected inside a family invitation.
 *
 * A token authenticates the party, not an arbitrary guest row. Every route
 * accepting personId must pass through this helper; a UUID from another
 * family is deliberately a 404 so the token cannot be used as an existence
 * oracle for another invitation.
 */
export async function guestPersonByToken(
  db: Queryable,
  token: string,
  personId?: string | null,
): Promise<GuestCaller & { personId: string; personName: string }> {
  const caller = await guestByToken(db, token)
  const wanted = personId ?? caller.guestId
  const { rows } = await db.query<{ id: string; name: string }>(
    'select id, name from guests where id = $1 and party_id = $2',
    [wanted, caller.partyId],
  )
  const person = rows[0]
  if (!person) throw new AppError(404, 'not_found', 'Персона не найдена')
  return { ...caller, personId: person.id, personName: person.name }
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
