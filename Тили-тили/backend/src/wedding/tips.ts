import type { Queryable } from '../plugins/db.js'
import { COMMITTED } from '../deals/state.js'
import { VENDOR_LIVE_JOIN } from '../catalog/vendors.js'
import { loadBudget } from './budget.js'

/*
 * Подсказки Тиля по правилам (Бизнес-логика §3.14, «правила — на бэкенде»).
 *
 * Три правила, все — из данных свадьбы, ни одно не гадает:
 *  1. Дефицит категории: слот не закрыт бронью, до свадьбы меньше восьми
 *     месяцев, и свободных на дату анкет этой категории в городе свадьбы
 *     осталось ≤ 6 (свободна — опубликована, жива и не занята на дату).
 *  2. Блокирующий слот: блок тайминга из шаблона зависит от категории, а её
 *     слот пуст — «Доставка букета» без флориста. Связь блок → категории
 *     задана здесь по именам шаблона (`wedding/templates.ts`): у блока нет
 *     поля категории, а строка `who` — свободный текст. Свои блоки пары
 *     правилу не видны — честно ничего, а не догадка по названию.
 *  3. Лимит бюджета: категория обещана больше чем на 85 % плана (бронь и
 *     свои статьи против доли общего бюджета) — дальше только за счёт
 *     резерва. Считается той же функцией, что экран бюджета (`loadBudget`).
 *
 * До этого правила жили на клиенте: порог 80 % считался по загруженной
 * странице, дефицита и блокирующих слотов не было вовсе (сверка планов
 * 2026-09-18). Модель здесь не нужна — это арифметика; Тиль-чат (фича 010)
 * получает те же факты в контексте.
 */

export interface Tip {
  kind: 'deficit' | 'blocking_slot' | 'budget'
  title: string
  body: string
  link: string
  categoryId?: string
}

/** Сколько свободных анкет считается «мало» (§3.14 п. 1). */
export const DEFICIT_THRESHOLD = 6
/** Дефицит смотрим только когда до свадьбы меньше восьми месяцев (§3.14 п. 1). */
export const DEFICIT_MONTHS = 8
/** Порог лимита категории (§3.14 п. 3). */
export const BUDGET_ALERT_RATIO = 0.85

/** Какие слоты держат блок тайминга из шаблона — по имени блока. */
export const BLOCK_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'Сборы невесты': ['stylist'],
  'Сборы жениха': [],
  'Доставка букета и деталей': ['florist'],
  'Выездная церемония': ['venue', 'host', 'decor'],
  'Банкет': ['venue', 'host', 'dj'],
  'Салют и финал': [],
}

const rubles = (kopecks: number) => `${Math.round(kopecks / 100).toLocaleString('ru-RU')} ₽`

export async function computeTips(db: Queryable, weddingId: string): Promise<Tip[]> {
  const tips: Tip[] = []

  const { rows: w } = await db.query<{ date: string | null; city: string | null; months: number | null }>(
    `select w.date::text as date, c.name as city,
            case when w.date is null then null
                 else (extract(year from age(w.date, current_date)) * 12 + extract(month from age(w.date, current_date)))::int end as months
       from weddings w left join cities c on c.id = w.city_id
      where w.id = $1`,
    [weddingId],
  )
  const wedding = w[0]
  if (!wedding) return tips

  /* Слоты без брони: нет сделки или сделка не дошла до `booked`. */
  const { rows: slots } = await db.query<{ category_id: string; label: string; open: boolean }>(
    `select s.category_id, s.label,
            not exists (select 1 from deals d where d.id = s.deal_id and d.state = any($2)) as open
       from slots s where s.wedding_id = $1 order by s.sort`,
    [weddingId, COMMITTED],
  )
  const openSlots = slots.filter((s) => s.open)

  /* 1. Дефицит категории. */
  if (wedding.date && wedding.months !== null && wedding.months >= 0 && wedding.months < DEFICIT_MONTHS && wedding.city) {
    for (const slot of openSlots) {
      const { rows: free } = await db.query<{ n: string }>(
        `select count(*)::text as n
           from vendors v ${VENDOR_LIVE_JOIN}
           join cities c on c.id = v.city_id
          where v.category_id = $1 and v.published_at is not null and c.name = $2
            and not exists (select 1 from vendor_busy_dates b where b.vendor_id = v.id and b.date = $3::date)`,
        [slot.category_id, wedding.city, wedding.date],
      )
      const n = Number(free[0]!.n)
      if (n <= DEFICIT_THRESHOLD) {
        tips.push({
          kind: 'deficit',
          categoryId: slot.category_id,
          title: `Свободных «${slot.label}» на вашу дату: ${n}`,
          body: n === 0
            ? `В городе ${wedding.city} на вашу дату свободных анкет нет — расширьте радиус или дату`
            : `До свадьбы меньше ${DEFICIT_MONTHS} месяцев — бронируйте, пока есть из кого выбирать`,
          link: `/search/${slot.category_id}`,
        })
      }
    }
  }

  /* 2. Блокирующий слот. */
  const { rows: blocks } = await db.query<{ name: string }>(
    'select name from timeline_events where wedding_id = $1 order by starts_at nulls last, sort',
    [weddingId],
  )
  const openByCategory = new Map(openSlots.map((s) => [s.category_id, s.label]))
  const seen = new Set<string>()
  for (const block of blocks) {
    const needs = BLOCK_DEPENDENCIES[block.name]
    if (!needs) continue
    for (const categoryId of needs) {
      const label = openByCategory.get(categoryId)
      if (!label || seen.has(categoryId)) continue
      seen.add(categoryId)
      tips.push({
        kind: 'blocking_slot',
        categoryId,
        title: `«${block.name}» держится на слоте «${label}» — он пуст`,
        body: 'Блок стоит в тайминге, а исполнителя под него нет',
        link: `/search/${categoryId}`,
      })
    }
  }

  /* 3. Лимит бюджета. */
  const budget = await loadBudget(db, weddingId)
  for (const c of budget.categories) {
    const planned = c.planned.amount
    if (planned <= 0) continue
    const committed = c.fromSlots + c.items.reduce((sum, i) => sum + i.amount.amount, 0)
    if (committed / planned > BUDGET_ALERT_RATIO) {
      const pct = Math.round((committed / planned) * 100)
      tips.push({
        kind: 'budget',
        categoryId: c.id,
        title: `«${c.title}» — ${pct} % лимита`,
        body: committed > planned
          ? `Обещано ${rubles(committed)} при плане ${rubles(planned)} — дальше только за счёт резерва`
          : `Обещано ${rubles(committed)} из ${rubles(planned)} — зафиксируйте состав, пока укладываетесь`,
        link: '/wedding/budget',
      })
    }
  }

  return tips
}
