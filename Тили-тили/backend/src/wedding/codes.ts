import { randomInt } from 'node:crypto'
import type { Role } from './access.js'

/**
 * Алфавит без похожих знаков: нет 0 и O, 1 и I и L, 5 и S, 8 и B.
 * Код читают вслух и переписывают с экрана — «ноль или буква О» стоит
 * дороже, чем четыре лишних символа.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXYZ234679'

export const CODE_GROUPS = 2
export const CODE_GROUP_LENGTH = 4

/**
 * Приставка по роли — чтобы человек, которому прислали ссылку, понимал,
 * кем его зовут, ещё до открытия.
 *
 * План перечисляет три (ПАРА, ДРУГ, ПОДР); координатору нужна своя,
 * иначе помощника и координатора не отличить по коду.
 */
const PREFIX: Record<Role, string> = {
  couple: 'ПАРА',
  helper: 'ДРУГ',
  coordinator: 'КООР',
  vendor: 'ПОДР',
}

function group(): string {
  let out = ''
  // randomInt, а не Math.random: код — это доступ к чужой свадьбе.
  for (let i = 0; i < CODE_GROUP_LENGTH; i++) out += ALPHABET[randomInt(0, ALPHABET.length)]
  return out
}

/**
 * `ДРУГ-7F3K-QX9M`.
 *
 * Восемь знаков, а не четыре как в примере контракта: четыре из этого
 * алфавита — это около 20 бит, миллион вариантов, перебираемых скриптом
 * за минуты. Восемь дают ~38 бит; вместе с семью днями жизни, одноразовостью
 * и ограничением частоты этого достаточно. План §6 требует 128 бит для
 * гостевых токенов — они не читаются вслух и остаются длинными.
 */
export function inviteCode(role: Role): string {
  return [PREFIX[role], ...Array.from({ length: CODE_GROUPS }, group)].join('-')
}

/** Публичный код свадьбы для ссылки-приглашения гостям. */
export function weddingCode(): string {
  return Array.from({ length: CODE_GROUPS }, group).join('-')
}

/**
 * Реферальный код вида ТИЛИ-АЛИНА: его называют вслух и переписывают, поэтому
 * имя важнее случайности. Имён «Алина» много, и второй такой код занять нельзя —
 * тогда к имени добавляется группа: ТИЛИ-АЛИНА-7F3K. Полностью случайный код
 * остаётся на случай, когда имени нет вовсе.
 *
 * @param attempt номер попытки: 0 — чистое имя, дальше с добавкой
 */
export function referralCode(name: string | null, attempt = 0): string {
  const cleaned = (name ?? '')
    .toUpperCase()
    .replace(/[^А-ЯЁ]/g, '')
    .slice(0, 10)
  if (cleaned.length < 3) return 'ТИЛИ-' + group()
  return attempt === 0 ? `ТИЛИ-${cleaned}` : `ТИЛИ-${cleaned}-${group()}`
}

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase()
}
