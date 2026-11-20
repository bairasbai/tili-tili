import { randomBytes, randomInt } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError, unauthorized } from '../errors.js'
import { lockOrderWedding } from '../orders/context.js'

/**
 * Гость работает без аккаунта — по персональному токену.
 *
 * Токен паре не отдаётся НИКОГДА (ERR-0019): она пересылает одноразовую
 * ссылку, гость меняет её на токен в своём браузере. Иначе пара откроет
 * гостевую страницу и увидит его резерв подарка — а анонимность резервов
 * обещана в §9 бизнес-логики.
 */
export interface GuestCaller {
  /** Primary person used by legacy single-person guest paths during 020 rollout. */
  guestId: string
  /** Family invitation identity. Gift quota/token and hotel room belong here. */
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
  const { rows } = await db.query<{ id: string; party_id: string; wedding_id: string; name: string }>(
    `select g.id, p.id as party_id, p.wedding_id, g.name
       from guest_parties p
       join weddings w on w.id = p.wedding_id
       join lateral (
         select id, name from guests
          where party_id = p.id
          order by party_position, created_at, id
          limit 1
       ) g on true
      where p.invite_token = $1
        and w.cancelled_at is null and w.archived_at is null`,
    [token],
  )
  const guest = rows[0]
  // Один и тот же ответ на «нет такого токена» и «свадьба отменена»:
  // по кодам ответа не должно быть видно, существовал ли токен.
  if (!guest) throw new AppError(401, 'unauthorized', 'Ссылка недействительна')
  return { guestId: guest.id, partyId: guest.party_id, weddingId: guest.wedding_id, name: guest.name }
}

/** The caller supplies its transaction client. Pin wedding, invitation and person in that order. */
export function lockGuestInvitation(client: Queryable, token: string, writePerson = false): Promise<GuestCaller> {
  return pinGuestInvitation(client, token, writePerson ? 'person' : 'read')
}

export function lockGuestInvitationForPartyWrite(client: Queryable, token: string): Promise<GuestCaller> {
  return pinGuestInvitation(client, token, 'party')
}

async function pinGuestInvitation(client: Queryable, token: string, mode: 'read' | 'person' | 'party'): Promise<GuestCaller> {
  const before = await guestByToken(client, token)
  try { await lockOrderWedding(client, before.weddingId, false) }
  catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw unauthorized('Ссылка недействительна')
    throw error
  }
  const party = await client.query(`select id from guest_parties where id=$1 and wedding_id=$2 and invite_token=$3 for ${mode === 'party' ? 'update' : 'share'}`,
    [before.partyId, before.weddingId, token])
  if (!party.rows[0]) throw unauthorized('Ссылка недействительна')
  const person = await client.query(`select id from guests where id=$1 and wedding_id=$2 and party_id=$3 for ${mode === 'person' ? 'update' : 'share'}`,
    [before.guestId, before.weddingId, before.partyId])
  if (!person.rows[0]) throw unauthorized('Ссылка недействительна')
  const current = await guestByToken(client, token)
  if (current.guestId !== before.guestId || current.partyId !== before.partyId || current.weddingId !== before.weddingId) {
    throw unauthorized('Ссылка недействительна')
  }
  return current
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
