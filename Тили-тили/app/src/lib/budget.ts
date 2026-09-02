import { budgetItems, couple, type Slot } from './data'
import { t } from './i18n'

/*
 * Единый расчёт денег.
 *
 * Раньше каждый экран считал по-своему, и пара одновременно видела три разных
 * ответа на вопрос «сколько уже потрачено»: 455 000 ₽ на главной (только бронь),
 * 560 000 ₽ в «Нашем дне» (бронь и мягкая бронь) и 677 000 ₽ в бюджете
 * (живые цены вперемешку с демо-остатками). Теперь число одно, а разные
 * вопросы разведены явно.
 */

/** Категория бюджета для категории подрядчика. */
export function categoryOf(): Record<string, string> {
  return {
    venue: t('Площадка и кейтеринг'),
    photo: t('Фото и видео'), video: t('Фото и видео'),
    dress: t('Одежда и красота'), stylist: t('Одежда и красота'), rings: t('Одежда и красота'),
    host: t('Развлечения и декор'), dj: t('Развлечения и декор'), florist: t('Развлечения и декор'),
    decor: t('Развлечения и декор'), cake: t('Развлечения и декор'),
    transport: t('Прочее'),
  }
}

export interface BudgetRow { name: string; amount: number; limit: number; color: string; live?: string }

/** Слоты, по которым пара уже взяла обязательства: бронь и мягкая бронь. */
export const committedSlots = (slots: Slot[]): Slot[] =>
  slots.filter(s => (s.state === 'booked' || s.state === 'hold') && s.price)

/** Обязательства перед подрядчиками. Отвечает на вопрос «сколько уже обещано». */
export const committedTotal = (slots: Slot[]): number =>
  committedSlots(slots).reduce((a, s) => a + (s.price ?? 0), 0)

/**
 * Строки бюджета. Категория, в которой есть подрядчик из команды, показывает
 * живую сумму; остальные — расходы вне приложения (платье, кольца, полиграфия
 * из типографии). Без них бюджет врёт на 15–25% — см. план §19.7.
 */
export function budgetRows(slots: Slot[], custom: BudgetRow[] = []): BudgetRow[] {
  const cat = categoryOf()
  const committed = committedSlots(slots)
  return budgetItems.map(b => {
    const inCat = committed.filter(s => cat[s.categoryId] === b.name)
    if (!inCat.length) return { ...b }
    return { ...b, amount: inCat.reduce((a, s) => a + (s.price ?? 0), 0), live: inCat.map(s => s.vendor).join(' · ') }
  }).concat(custom)
}

/** Всё распределённое: подрядчики, покупки вне приложения и свои статьи. */
export const spentTotal = (slots: Slot[], custom: BudgetRow[] = []): number =>
  budgetRows(slots, custom).reduce((a, b) => a + b.amount, 0)

/** Доля от общего бюджета пары, целыми процентами. */
export const spentPct = (slots: Slot[], custom: BudgetRow[] = []): number =>
  Math.round((spentTotal(slots, custom) / couple.budgetTotal) * 100)
