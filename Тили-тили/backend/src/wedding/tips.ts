import type { Queryable } from '../plugins/db.js'
import { COMMITTED } from '../deals/state.js'
import { VENDOR_LIVE_JOIN } from '../catalog/vendors.js'
import { loadBudget } from './budget.js'

/*
 * Подсказки Тиля по правилам (Бизнес-логика §3.14, «правила — на бэкенде»).
 *
 * Три правила, все — из данных свадьбы, ни одно не гадает:
 *  1. Мало кандидатов: слот не закрыт бронью, до его мероприятия меньше
 *     восьми месяцев, и legacy-анкет без отметки занятости на эту дату ≤ 6.
 *     Это кандидаты, а доступность и время подтверждает сам исполнитель.
 *     Ресурсный календарь без выбранного плана не даёт числового обещания.
 *  2. Блокирующий слот: блок тайминга из шаблона зависит от категории, а её
 *     слот пуст — «Доставка букета» без флориста. Связь блок → категории
 *     задана здесь по именам шаблона (`wedding/templates.ts`): у блока нет
 *     поля категории, а строка `who` — свободный текст. Свои блоки пары
 *     правилу не видны — честно ничего, а не догадка по названию.
 *  3. Лимит бюджета: категория обещана больше чем на 85 % плана (бронь и
 *     свои статьи против доли общего бюджета) — дальше только за счёт
 *     резерва. Считается той же функцией, что экран бюджета (`loadBudget`).
 *
 * Слот с отметкой «уже забронировано вне приложения» (фича 018) не открыт:
 * пара ответила в квизе, что подрядчик найден, — звать его искать нельзя,
 * как нельзя и после брони. Экраны считают такой слот забронированным.
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
  priority: {
    reason: 'blocks_timeline' | 'budget_over_limit' | 'limited_candidates' | 'budget_near_limit'
    referenceDate: string | null
  }
}

/** Сколько legacy-анкет без отметки занятости считается «мало» (§3.14 п. 1). */
export const DEFICIT_THRESHOLD = 6
/** Кандидатов смотрим только когда до мероприятия меньше восьми месяцев (§3.14 п. 1). */
export const DEFICIT_MONTHS = 8
/** Порог лимита категории (§3.14 п. 3). */
export const BUDGET_ALERT_RATIO = 0.85

/**
 * Какие слоты держат блок тайминга из шаблона — по имени блока. Названы блоки
 * шаблонов всех форматов (`timelineTemplate`, фича 018); пустой список — блок
 * не держится ни на одном слоте команды, это решение, а не пропуск.
 * «Выездная церемония» держится и на слотах, которые добавляет её формат, —
 * площадке церемонии и церемониймейстере; у свадьбы без них ничего не меняется.
 * «Ужин» камерной свадьбы — на площадке: DJ камерный формат не предполагает, а
 * камерный ведущий бывает (План §8.1), но ужин без него состоится; о пустом
 * «Ведущем» подсказывает «Выездная церемония» — в камерном тайминге она есть.
 */
export const BLOCK_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  'Сборы невесты': ['stylist'],
  'Сборы жениха': [],
  'Доставка букета и деталей': ['florist'],
  'Выездная церемония': ['venue', 'host', 'decor', 'ceremony', 'registrar'],
  'Регистрация в ЗАГСе': [],
  'Банкет': ['venue', 'host', 'dj'],
  'Ужин': ['venue'],
  'Салют и финал': [],
  'День 2: бранч': [],
  'День 2: продолжение праздника': [],
}

const rubles = (kopecks: number) => `${Math.round(kopecks / 100).toLocaleString('ru-RU')} ₽`
const slotKey = (eventId: string | null, categoryId: string) => `${eventId ?? ''}:${categoryId}`
const searchLink = (slot: { id: string; category_id: string; additional: boolean }) =>
  `/search/${slot.category_id}${slot.additional ? `?slotId=${encodeURIComponent(slot.id)}` : ''}`

export async function computeTips(db: Queryable, weddingId: string): Promise<Tip[]> {
  const tips: Tip[] = []

  const { rows: w } = await db.query<{ city: string | null }>(
    `select c.name as city
       from weddings w left join cities c on c.id = w.city_id
      where w.id = $1`,
    [weddingId],
  )
  const wedding = w[0]
  if (!wedding) return tips

  /* Слоты без брони: нет сделки или сделка не дошла до `booked` — и нет отметки «уже забронировано». */
  const { rows: slots } = await db.query<{ id: string; category_id: string; label: string; open: boolean; additional: boolean; program_event_id: string | null;
    service_date: string | null; time_zone: string | null; months: number | null }>(
    `select s.id, s.category_id, s.label, s.program_event_id, ctx.date::text as service_date, ctx.time_zone,
            (s.program_event_id is not null and not coalesce(e.is_main,false)) as additional,
            case when ctx.date is null then null
                 else (extract(year from age(ctx.date, (current_timestamp at time zone ctx.time_zone)::date)) * 12
                   + extract(month from age(ctx.date, (current_timestamp at time zone ctx.time_zone)::date)))::int end as months,
            s.prebooked_at is null
              and not exists (select 1 from deals d where d.id = s.deal_id and d.state = any($2)) as open
       from slots s join weddings w on w.id=s.wedding_id
       left join wedding_events e on e.wedding_id=s.wedding_id and e.id=s.program_event_id
       cross join lateral (select
         case when s.program_event_id is null or e.is_main then w.date else e.date end as date,
         case when s.program_event_id is null or e.is_main then w.tz else e.time_zone end as time_zone) ctx
       where s.wedding_id = $1 order by s.sort, s.id`,
    [weddingId, COMMITTED],
  )
  const openSlots = slots.filter((s) => s.open)

  /* 1. Кандидаты на фактическую дату позиции. Дата/TZ другого мероприятия
   * не заменяют неизвестный контекст. Число анкет не гарантирует доступность. */
  if (wedding.city) {
    for (const slot of openSlots) {
      if (!slot.service_date || !slot.time_zone || slot.months === null || slot.months < 0 || slot.months >= DEFICIT_MONTHS) continue
      const { rows: candidates } = await db.query<{ n: string; resources: string }>(
        `select count(*) filter (where coalesce(p.mode,'legacy_day')='legacy_day'
                  and not exists (select 1 from vendor_busy_dates b where b.vendor_id=v.id and b.date=$3::date))::text as n,
                count(*) filter (where p.mode='resources')::text as resources
           from vendors v ${VENDOR_LIVE_JOIN}
           join cities c on c.id = v.city_id
           left join vendor_availability_policy p on p.vendor_id=v.id
          where v.category_id = $1 and v.published_at is not null and c.name = $2`,
        [slot.category_id, wedding.city, slot.service_date],
      )
      // Without a selected resource/interval the total candidate pool is
      // unknown. Do not label a mixed category as scarce or available.
      if (Number(candidates[0]!.resources) > 0) continue
      const n = Number(candidates[0]!.n)
      if (n <= DEFICIT_THRESHOLD) {
        tips.push({
          kind: 'deficit',
          categoryId: slot.category_id,
          title: `Найдено анкет «${slot.label}» без отметки занятости: ${n}`,
          body: `На дату ${slot.service_date} в городе ${wedding.city}. Доступность и время работы подтвердите с исполнителем`,
          link: searchLink(slot),
          priority: { reason: 'limited_candidates', referenceDate: slot.service_date },
        })
      }
    }
  }

  /* 2. Блокирующий слот. */
  const { rows: blocks } = await db.query<{ name: string; program_event_id: string | null; block_date: string | null }>(
    `select t.name, case when e.is_main then null else e.id end as program_event_id,
            (t.starts_at at time zone (case when e.is_main then w.tz else e.time_zone end))::date::text as block_date
       from timeline_events t join weddings w on w.id=t.wedding_id
       join wedding_events e on e.wedding_id=t.wedding_id and e.id=t.program_event_id
      where t.wedding_id=$1 order by t.starts_at nulls last, t.sort, t.id`,
    [weddingId],
  )
  const openByEventAndCategory = new Map<string, (typeof openSlots)[number]>()
  for (const slot of openSlots) {
    const key = slotKey(slot.additional ? slot.program_event_id : null, slot.category_id)
    if (!openByEventAndCategory.has(key)) openByEventAndCategory.set(key, slot)
  }
  for (const block of blocks) {
    const needs = BLOCK_DEPENDENCIES[block.name]
    if (!needs) continue
    for (const categoryId of needs) {
      const key = slotKey(block.program_event_id, categoryId)
      const slot = openByEventAndCategory.get(key)
      if (!slot) continue
      openByEventAndCategory.delete(key)
      tips.push({
        kind: 'blocking_slot',
        categoryId,
        title: `«${block.name}» держится на слоте «${slot.label}» — он пуст`,
        body: 'Блок стоит в тайминге, а исполнителя под него нет',
        link: searchLink(slot),
        priority: { reason: 'blocks_timeline', referenceDate: block.block_date },
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
        /* Резерв пара может обнулить (018-B): «за счёт резерва» при 0 % — обещание
         * денег, которых нет (ревью 018, BB-08). */
        body: committed > planned
          ? `Обещано ${rubles(committed)} при плане ${rubles(planned)} — ${budget.reserveBps > 0
            ? 'дальше только за счёт резерва' : 'резерв выключен, дальше — только за счёт других категорий'}`
          : `Обещано ${rubles(committed)} из ${rubles(planned)} — зафиксируйте состав, пока укладываетесь`,
        link: '/wedding/budget',
        priority: { reason: committed > planned ? 'budget_over_limit' : 'budget_near_limit', referenceDate: null },
      })
    }
  }

  return tips
}
