import { paymentOverview } from '../payments/read.js'
import type { Queryable } from '../plugins/db.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import { BUDGET_BY_VENDOR_CATEGORY, BUDGET_CATEGORIES, BUDGET_FALLBACK } from './templates.js'

const rub = (amount: number) => ({ amount, currency: 'RUB' })

/**
 * Резерв на непредвиденное (План ч. 283).
 *
 * Отдельной строкой, а не категорией: категории делят сто процентов между
 * собой, и резерв внутри них означал бы, что часть сметы просто уменьшили.
 * Доля считается на сервере — иначе два экрана посчитают её по-разному.
 */
const RESERVE_SHARE = 0.1

/**
 * Бюджет свадьбы целиком — одна функция для `GET …/budget` и для подсказок
 * §3.14 (`wedding/tips.ts`): лимит категории и «сколько уже обещано» должны
 * считаться в одном месте, иначе экран бюджета и подсказка назовут разные
 * проценты (ERR-0012 ровно про это).
 */
export async function loadBudget(db: Queryable, weddingId: string) {
    const { rows: wedding } = await db.query<{ budget_total: string | null; currency: string }>(
      'select budget_total::text as budget_total, currency from weddings where id = $1',
      [weddingId],
    )
    const total = Number(wedding[0]?.budget_total ?? 0)

    // Мягкая бронь входит в обязательства: пара назвала сумму и держит дату.
    const { rows: deals } = await db.query<{ category_id: string; amount: string; vendor: string }>(
      `select s.category_id, sum(d.price)::text as amount,
              string_agg(coalesce(ven.name, d.external_name), ' · ') as vendor
         from deals d
         join slots s on s.id = d.slot_id
         left join vendors ven on ven.id = d.vendor_id
        where d.wedding_id = $1 and d.state = any($2) and d.price is not null
          and (d.state <> 'negotiating' or d.negotiating_until is null or d.negotiating_until > now())
        group by s.category_id`,
      [weddingId, COMMITTED_WITH_HOLD],
    )

    const { rows: items } = await db.query<{
      id: string
      title: string
      category_id: string
      amount: string
      currency: string
    }>(
      'select id, title, category_id, amount::text as amount, currency from budget_items where wedding_id = $1 order by created_at',
      [weddingId],
    )

    const fromSlots = new Map<string, number>()
    const liveNames = new Map<string, string[]>()
    for (const row of deals) {
      const budgetId = BUDGET_BY_VENDOR_CATEGORY[row.category_id] ?? BUDGET_FALLBACK
      fromSlots.set(budgetId, (fromSlots.get(budgetId) ?? 0) + Number(row.amount))
      if (row.vendor) liveNames.set(budgetId, [...(liveNames.get(budgetId) ?? []), row.vendor])
    }

    const categories = BUDGET_CATEGORIES.map((c) => {
      const mine = items.filter((i) => i.category_id === c.id)
      const auto = fromSlots.get(c.id) ?? 0
      return {
        id: c.id,
        title: c.title,
        color: c.color,
        // План — доля от общего бюджета пары: лимиты мока заданы под свадьбу
        // за 1,5 млн, а у каждой пары бюджет свой.
        planned: rub(Math.round(total * c.share)),
        fromSlots: auto,
        live: liveNames.get(c.id)?.join(' · ') ?? null,
        items: mine.map((i) => ({
          id: i.id,
          title: i.title,
          amount: rub(Number(i.amount)),
          categoryId: i.category_id,
          custom: true,
        })),
      }
    })

    const spent =
      [...fromSlots.values()].reduce((a, b) => a + b, 0) + items.reduce((a, i) => a + Number(i.amount), 0)

    const { summary: paymentSummary } = await paymentOverview(db, weddingId)
    return { paymentSummary, total: rub(total), spent: rub(spent), reserve: rub(Math.round(total * RESERVE_SHARE)), categories }
}

