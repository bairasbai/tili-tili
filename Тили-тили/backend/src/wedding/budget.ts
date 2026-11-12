import { paymentOverview } from '../payments/read.js'
import { conflict, notFound } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import { CURRENT_PURCHASES, PURCHASE_COUNTS_IN_BUDGET } from './purchase-budget.js'
import { BUDGET_BY_VENDOR_CATEGORY, BUDGET_CATEGORIES, BUDGET_FALLBACK } from './templates.js'

const rub = (amount: number) => ({ amount, currency: 'RUB' })
const ACTIVE_DEAL = `d.state = any($2)
  and (d.state <> 'negotiating' or d.negotiating_until is null or d.negotiating_until > now())`
const DEAL_LABEL = "concat_ws(' · ',s.label,coalesce(v.name,d.external_name))"
const ITEM_COLUMNS = `i.id,i.title,i.category_id,i.amount::text as amount,i.linked_deal_id,i.deal_link_version,
  case when d.id is not null then ${DEAL_LABEL} end as linked_deal_label`
const ITEM_FROM = `from budget_items i
  left join deals d on (d.wedding_id,d.id)=(i.wedding_id,i.linked_deal_id)
  left join slots s on (s.wedding_id,s.id)=(d.wedding_id,d.slot_id)
  left join vendors v on v.id=d.vendor_id`

interface BudgetItemRow {
  id: string
  title: string
  category_id: string
  amount: string
  linked_deal_id: string | null
  linked_deal_label: string | null
  deal_link_version: number
  from_purchase?: true
}
type ActiveDealRow = { id: string; label: string; category_id: string; amount: string | null; vendor: string | null }
type PurchaseCost = { id: string; title: string; category_id: string; agreed_amount: string | null
  estimated_amount: string | null; linked_deal_id: string | null; linked_deal_label: string | null }

const budgetItem = (row: BudgetItemRow) => ({
  id: row.id, title: row.title, amount: rub(Number(row.amount)), categoryId: row.category_id, custom: !row.from_purchase,
  linkedDealId: row.linked_deal_id, linkedDealLabel: row.linked_deal_label,
  ...(row.from_purchase ? { purchaseId: row.id } : { dealLinkVersion: row.deal_link_version }),
})

async function readBudgetItem(db: Queryable, weddingId: string, itemId: string, lock = false) {
  const { rows: [row] } = await db.query<BudgetItemRow>(`select ${ITEM_COLUMNS} ${ITEM_FROM}
    where i.wedding_id=$1 and i.id=$2 ${lock ? 'for update of i' : ''}`, [weddingId, itemId])
  if (!row) throw notFound('Статья не найдена')
  return row
}

export async function assertActiveDeal(db: Queryable, weddingId: string, dealId: string) {
  const match = await db.query(`select d.id from deals d
    join slots s on (s.wedding_id,s.id)=(d.wedding_id,d.slot_id)
    where d.wedding_id=$1 and ${ACTIVE_DEAL} and d.id=$3 for share of d`, [weddingId, COMMITTED_WITH_HOLD, dealId])
  if (!match.rowCount) throw notFound('Действующая сделка не найдена')
}

export async function listBudgetDealChoices(db: Queryable, weddingId: string) {
  const { rows } = await db.query<{ id: string; label: string }>(`select d.id,${DEAL_LABEL} as label
    from deals d join slots s on (s.wedding_id,s.id)=(d.wedding_id,d.slot_id) left join vendors v on v.id=d.vendor_id
    where d.wedding_id=$1 and ${ACTIVE_DEAL} order by label,d.id`, [weddingId, COMMITTED_WITH_HOLD])
  return rows
}

async function recordBudgetItemLink(db: Queryable, actorId: string, itemId: string, diff: {
  weddingId: string; previousDealId: string | null; dealId: string | null; version: number
}) {
  await db.query(`insert into audit_log(actor_id,action,entity,entity_id,diff)
    values($1,'budget.item_deal_link_changed','budget_item',$2,$3::jsonb)`, [actorId, itemId, JSON.stringify(diff)])
}

export async function createBudgetItem(db: Queryable, weddingId: string, itemId: string, actorId: string,
  body: { title: string; categoryId: string; amount: { amount: number }; linkedDealId?: string }) {
  const linked = body.linkedDealId ?? null
  if (linked) await assertActiveDeal(db, weddingId, linked)
  await db.query(`insert into budget_items(id,wedding_id,title,category_id,amount,currency,linked_deal_id,deal_link_version)
    values($1,$2,$3,$4,$5,'RUB',$6,$7)`, [itemId, weddingId, body.title, body.categoryId, body.amount.amount, linked, linked ? 1 : 0])
  if (linked) await recordBudgetItemLink(db, actorId, itemId, { weddingId, previousDealId: null, dealId: linked, version: 1 })
  return budgetItem(await readBudgetItem(db, weddingId, itemId))
}

export async function changeBudgetItemLink(db: Queryable, weddingId: string, itemId: string, actorId: string,
  body: { dealId: string | null; version: number }) {
  const current = await readBudgetItem(db, weddingId, itemId, true)
  if (current.linked_deal_id === body.dealId && (current.deal_link_version === body.version
    || current.deal_link_version === body.version + 1)) return budgetItem(current)
  if (current.deal_link_version !== body.version || body.version === 2147483647) {
    throw conflict('stale_budget_item_link', 'Связь статьи уже изменена. Обновите бюджет.')
  }
  if (body.dealId) await assertActiveDeal(db, weddingId, body.dealId)
  await db.query('update budget_items set linked_deal_id=$3,deal_link_version=deal_link_version+1 where wedding_id=$1 and id=$2',
    [weddingId, itemId, body.dealId])
  await recordBudgetItemLink(db, actorId, itemId, { weddingId, previousDealId: current.linked_deal_id,
    dealId: body.dealId, version: body.version + 1 })
  return budgetItem(await readBudgetItem(db, weddingId, itemId))
}

/** Deals and their manual counterparts must be read in the same PostgreSQL snapshot. */
async function loadBudgetCosts(db: Queryable, weddingId: string) {
  const { rows: [snapshot] } = await db.query<{ deals: ActiveDealRow[]; items: BudgetItemRow[]; purchases: PurchaseCost[] }>(`
    select coalesce((select jsonb_agg(to_jsonb(a) order by a.label,a.id) from (
      select d.id,${DEAL_LABEL} as label,s.category_id,d.price::text as amount,coalesce(v.name,d.external_name) as vendor
      from deals d join slots s on (s.wedding_id,s.id)=(d.wedding_id,d.slot_id) left join vendors v on v.id=d.vendor_id
      where d.wedding_id=$1 and ${ACTIVE_DEAL}
    ) a),'[]'::jsonb) as deals,
    coalesce((select jsonb_agg(to_jsonb(b)-'created_at' order by b.created_at,b.id) from (
      select ${ITEM_COLUMNS},i.created_at ${ITEM_FROM} where i.wedding_id=$1
    ) b),'[]'::jsonb) as items,
    coalesce((select jsonb_agg(to_jsonb(c) order by c.id) from (
      select p.id,p.title,p.category_id,p.agreed_amount::text,p.estimated_amount::text,p.linked_deal_id,
        case when d.id is not null then ${DEAL_LABEL} end as linked_deal_label
      from (${CURRENT_PURCHASES}) p
      left join deals d on (d.wedding_id,d.id)=(p.wedding_id,p.linked_deal_id)
      left join slots s on (s.wedding_id,s.id)=(d.wedding_id,d.slot_id)
      left join vendors v on v.id=d.vendor_id
      where ${PURCHASE_COUNTS_IN_BUDGET}
    ) c),'[]'::jsonb) as purchases`, [weddingId, COMMITTED_WITH_HOLD])

  const fromSlots = new Map<string, number>()
  const unknownPrices = new Map<string, number>()
  const liveNames = new Map<string, string[]>()
  const manual = new Map<string, number>()
  const estimates = new Map<string, number>()
  const unknownPurchases = new Map<string, number>()
  for (const row of snapshot!.deals) {
    const category = BUDGET_BY_VENDOR_CATEGORY[row.category_id] ?? BUDGET_FALLBACK
    if (row.amount === null) {
      unknownPrices.set(category, (unknownPrices.get(category) ?? 0) + 1)
      continue
    }
    fromSlots.set(category, (fromSlots.get(category) ?? 0) + Number(row.amount))
    if (row.vendor) {
      const names = liveNames.get(category) ?? []
      names.push(row.vendor)
      liveNames.set(category, names)
    }
  }
  const items = [...snapshot!.items]
  for (const purchase of snapshot!.purchases) {
    if (purchase.agreed_amount !== null) {
      items.push({ ...purchase, amount: purchase.agreed_amount, from_purchase: true, deal_link_version: 0 })
    } else if (!purchase.linked_deal_id) {
      const category = purchase.category_id
      if (purchase.estimated_amount === null) unknownPurchases.set(category, (unknownPurchases.get(category) ?? 0) + 1)
      else estimates.set(category, (estimates.get(category) ?? 0) + Number(purchase.estimated_amount))
    }
  }
  for (const row of items) {
    if (row.linked_deal_id === null) manual.set(row.category_id, (manual.get(row.category_id) ?? 0) + Number(row.amount))
  }
  return { fromSlots, unknownPrices, liveNames, manual, items, estimates, unknownPurchases,
    dealChoices: snapshot!.deals.map(({ id, label }) => ({ id, label })) }
}

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

    const { fromSlots, unknownPrices, liveNames, manual, items, dealChoices, estimates, unknownPurchases } = await loadBudgetCosts(db, weddingId)

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
        committed: rub(auto + (manual.get(c.id) ?? 0)),
        ...(estimates.has(c.id) ? { estimatedPurchases: rub(estimates.get(c.id)!) } : {}),
        unknownPurchaseCosts: unknownPurchases.get(c.id) ?? 0,
        unknownPrices: unknownPrices.get(c.id) ?? 0,
        live: liveNames.get(c.id)?.join(' · ') ?? null,
        // Older clients add items to fromSlots themselves.
        items: mine.filter(i => i.linked_deal_id === null).map(budgetItem),
        linkedItems: mine.filter(i => i.linked_deal_id !== null).map(budgetItem),
      }
    })

    const spent =
      [...fromSlots.values(), ...manual.values()].reduce((a, b) => a + b, 0)

    const { summary: paymentSummary } = await paymentOverview(db, weddingId)
    return {
      paymentSummary, total: rub(total), spent: rub(spent),
      reserve: rub(Math.round(total * reserveBps / 10000)),
      reserveBps, settingsVersion, categories, dealChoices,
    }
}

