/*
 * Деньги.
 *
 * Решение владельца 2026-09-02: суммы хранятся в минорных единицах — копейках —
 * вместе с кодом валюты. Так делают платёжные системы: целые числа не копят
 * ошибку округления, а «85 000,50 ₽» невозможно представить дробным рублём без
 * сюрпризов. Пользователю по-прежнему показываются рубли.
 *
 * Правило: во всём коде суммы — копейки. Литерал в рублях оборачивается в rub(),
 * ввод пользователя переводится через rub(), вывод — только через fmt().
 */

/** Код валюты по ISO 4217. Пока одна, но поле есть с самого начала. */
export const CURRENCY = 'RUB'

/** Сумма в копейках. Псевдоним нужен, чтобы намерение читалось в сигнатурах. */
export type Kopecks = number

/** Рубли → копейки. Единственный способ внести сумму в рублях. */
export const rub = (rubles: number): Kopecks => Math.round(rubles * 100)

/** Копейки → рубли. Нужно там, где сумму отдают наружу как число. */
export const toRubles = (k: Kopecks): number => k / 100

const WHOLE = new Intl.NumberFormat('ru-RU')
const WITH_COINS = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Показ пользователю. Копейки печатаются, только если они не нулевые. */
export function fmt(k: Kopecks): string {
  const rubles = k / 100
  return (Number.isInteger(rubles) ? WHOLE : WITH_COINS).format(rubles) + ' ₽'
}

/** Строгий ввод рублей с необязательными копейками → минорные единицы. */
export function parsePaymentRubles(input: string): number | null {
  const text = input.trim().replace(/[ \u00a0\u202f]/g, '').replace(',', '.')
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text)
  if (!match || text.length > 22) return null
  const minor = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return minor > 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null
}

/** Минорные единицы → строка рублей с двумя знаками для поля ввода. */
export function paymentRubles(minor: number): string {
  const whole = Math.floor(minor / 100)
  return `${whole}.${String(minor % 100).padStart(2, '0')}`
}

/** Целые рубли: только цифры/пробелы, без молчаливого округления или удаления знаков. */
export function parseWholeRubles(input: string): number | null {
  const text = input.trim().replace(/[ \u00a0\u202f]/g, '')
  return /^\d{1,13}$/.test(text) ? Number(text) : null
}

