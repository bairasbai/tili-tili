import { createHmac, randomInt } from 'node:crypto'
import { AppError } from '../errors.js'

/**
 * Код из SMS. Четыре цифры — так на экране входа во фронте.
 *
 * Четырёх цифр мало само по себе (10 000 вариантов), поэтому защита не в длине,
 * а в трёх ограничениях сразу: код живёт 5 минут, ввести можно 5 раз, запросить
 * — 5 раз в час на номер. Перебор упирается в SMS, а не в проверку.
 */
export const CODE_LENGTH = 4
export const CODE_TTL_SECONDS = 5 * 60
export const RESEND_AFTER_SECONDS = 60
export const MAX_ATTEMPTS = 5
export const MAX_SENDS_PER_HOUR = 5

export function generateCode(): string {
  // randomInt, а не Math.random: предсказуемый код — это вход в чужой аккаунт.
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, '0')
}

/**
 * Хеш с серверным секретом, а не голый sha256: без секрета таблица кодов,
 * попавшая наружу, вскрывается перебором десяти тысяч вариантов за секунду.
 * Телефон входит в хеш, чтобы код от одного номера не подошёл к другому.
 */
export function hashCode(secret: string, phone: string, code: string): string {
  return createHmac('sha256', secret).update(`${phone}:${code}`).digest('hex')
}

/**
 * Приведение к E.164. Фронт присылает 10 цифр после +7, но люди вставляют
 * номер из записной книжки как угодно: 8 917…, +7 (917) …, 7917…
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  let d = digits
  if (d.length === 10) d = '7' + d
  else if (d.length === 11 && d.startsWith('8')) d = '7' + d.slice(1)

  if (!/^[1-9][0-9]{7,14}$/.test(d)) {
    throw new AppError(422, 'bad_phone', 'Номер телефона не похож на настоящий. Ожидается 10 цифр после +7.')
  }
  return '+' + d
}

/** Для лога и ответов: +7917****567 — по нему человек узнаёт свой номер, чужой не восстановит. */
export function maskPhone(phone: string): string {
  if (phone.length < 8) return '***'
  return phone.slice(0, 5) + '*'.repeat(phone.length - 8) + phone.slice(-3)
}

export class TooManyRequests extends AppError {
  readonly retryAfter: number
  constructor(retryAfter: number, message: string) {
    super(429, 'too_many_requests', message)
    this.retryAfter = retryAfter
  }
}
