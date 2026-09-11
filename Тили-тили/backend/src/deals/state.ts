import { AppError } from '../errors.js'

/**
 * Шесть состояний сделки плюс отмена (План §8.1, решение владельца 2026-09-02).
 *
 * Мягкая бронь на 72 часа — НЕ состояние, а срок жизни `negotiating` (§18.3).
 * Отдельное состояние «hold» пришлось бы синхронизировать с таймером, и
 * рассинхрон был бы виден паре как «бронь висит, хотя срок вышел».
 */
export const DEAL_STATES = [
  'candidate',
  'contacted',
  'negotiating',
  'booked',
  'paid_deposit',
  'done',
  'cancelled',
] as const

export type DealState = (typeof DEAL_STATES)[number]

/** Сколько живёт мягкая бронь. */
export const HOLD_HOURS = 72

const ORDER: DealState[] = ['candidate', 'contacted', 'negotiating', 'booked', 'paid_deposit', 'done']

/**
 * Разрешены только переходы вперёд по цепочке и отмена из любого состояния.
 *
 * Движение назад запрещено намеренно: «разбронировать обратно в переговоры»
 * означало бы, что дата уже освобождена, а сделка выглядит живой. Отмена —
 * явная и отдельная; из неё нет пути назад, заводится новая сделка.
 */
export function canTransition(from: DealState, to: DealState): boolean {
  if (from === to) return false
  if (from === 'cancelled' || from === 'done') return false
  if (to === 'cancelled') return true
  if (to === 'candidate') return false
  const a = ORDER.indexOf(from)
  const b = ORDER.indexOf(to)
  return a >= 0 && b > a
}

export function assertTransition(from: DealState, to: DealState): void {
  if (!canTransition(from, to)) {
    throw new AppError(409, 'bad_transition', `Из состояния «${from}» нельзя перейти в «${to}»`)
  }
}

/**
 * Подпись плитки в мозаике команды. Производная от состояния сделки:
 * клиент не вычисляет её сам, иначе экраны разойдутся между собой.
 */
export function tileState(state: DealState | null): 'empty' | 'candidate' | 'hold' | 'booked' | 'paid' {
  switch (state) {
    case null:
    case 'cancelled':
      return 'empty'
    case 'candidate':
    case 'contacted':
      return 'candidate'
    case 'negotiating':
      return 'hold'
    case 'booked':
      return 'booked'
    case 'paid_deposit':
    case 'done':
      return 'paid'
  }
}

/** Состояния, в которых дата подрядчика занята и деньги обещаны. */
export const COMMITTED: DealState[] = ['booked', 'paid_deposit', 'done']

/**
 * Брони, у которых день ещё впереди.
 *
 * Перенос свадьбы двигает занятость только по ним: у `done` работа уже
 * сделана, и её день остаётся отработанным, а не переезжает на новую дату,
 * блокируя подрядчику будущий день под сделку, по которой работы больше нет.
 * Тот же список, что у отмены свадьбы (ERR-0205, R-217).
 */
export const OPEN_BOOKINGS: DealState[] = ['booked', 'paid_deposit']

/**
 * Обязательства пары. Мягкая бронь входит: пара уже назвала сумму и держит
 * дату — показывать её вне «потрачено» значит обещать деньги, которых нет
 * (так считает `app/src/lib/budget.ts`, и это тот же вопрос).
 */
export const COMMITTED_WITH_HOLD: DealState[] = [...COMMITTED, 'negotiating']
