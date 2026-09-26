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
const DEFAULT_RESERVE_BPS = 1000

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
    const { rows: settings } = await db.query<{ reserve_bps: number; version: number }>(
      'select reserve_bps, version from wedding_budget_settings where wedding_id = $1', [weddingId],
    )
    const reserveBps = settings[0]?.reserve_bps ?? DEFAULT_RESERVE_BPS
    const settingsVersion = settings[0]?.version ?? 0
    const { rows: savedLimits } = await db.query<{ category_id: string; amount: string; version: number; is_custom: boolean }>(
      'select category_id, amount::text as amount, version, is_custom from budget_category_limits where wedding_id = $1', [weddingId],
    )
    // Keep reset rows as version tombstones: deleting them would allow an old version=0 client
    // to write again after a custom -> auto cycle (ABA). Only is_custom rows override the auto limit.
    const limitStates = new Map(savedLimits.map(row => [row.category_id, row]))
    const limits = new Map(savedLimits.filter(row => row.is_custom).map(row => [row.category_id, row]))

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
        planned: rub(limits.has(c.id) ? Number(limits.get(c.id)!.amount) : Math.round(total * c.share)),
        limitCustom: limits.has(c.id),
        limitVersion: limitStates.get(c.id)?.version ?? 0,
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
    return {
      paymentSummary, total: rub(total), spent: rub(spent),
      reserve: rub(Math.round(total * reserveBps / 10000)),
      reserveBps, settingsVersion, categories,
    }
}

