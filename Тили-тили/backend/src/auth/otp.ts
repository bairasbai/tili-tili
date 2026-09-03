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
/**
 * Второй лимит — на источник запроса: лимит на номер не мешает перебирать
 * номера, шлём по одному коду на тысячу чужих телефонов, платим мы.
 *
 * Порог намеренно высокий. У мобильных операторов сотни абонентов сидят
 * за одним адресом (CGNAT): жёсткий лимит вида «10 в час» отрезал бы от входа
 * всех клиентов оператора разом, а это хуже, чем счёт за SMS. Здесь грубый
 * тормоз против скрипта, а точный ограничитель — лимит на номер.
 */
export const MAX_SENDS_PER_HOUR_PER_IP = 100

/**
 * Потолок на все отправки в час — единственное, что действительно ограничивает
 * счёт за SMS.
 *
 * Лимит на номер (5 в час) бесполезен против скрипта с тысячей номеров:
 * он отправит тысячу сообщений и не нарушит ни одного правила. Лимит на адрес
 * обходится ботнетом и не может быть жёстким из-за CGNAT. Остаётся общий
 * потолок: он бьёт по всем сразу, поэтому поставлен заведомо выше настоящей
 * нагрузки и при срабатывании обязан попадать в лог как авария.
 */
export const MAX_SENDS_PER_HOUR_TOTAL = 500

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
