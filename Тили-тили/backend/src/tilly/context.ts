import type { Db } from '../plugins/db.js'
import { loadSlots } from '../deals/repo.js'
import { COMMITTED_WITH_HOLD } from '../deals/state.js'
import { BUDGET_BY_VENDOR_CATEGORY, BUDGET_CATEGORIES, BUDGET_FALLBACK } from '../wedding/templates.js'

/*
 * Контекст свадьбы для модели (фича 010, План §18 «в LLM уходят только данные
 * проекта, без паспортов/телефонов гостей»).
 *
 * Собирается здесь, и только здесь, из ЯВНО перечисленных полей — не
 * `select *` и не JSON ответов контракта: там лежат телефоны гостей и своих
 * подрядчиков, комментарии гостей, тексты договоров. Тест утверждает, что в
 * запросе к модели нет ни одного телефона и e-mail; правило простое —
 * добавляя поле, спроси, нужно ли оно Тилю для совета, а не для связи.
 */

export interface WeddingContext {
  text: string
  tz: string
}

const MOSCOW = 'Europe/Moscow'
/** Сколько имён гостей уходит модели — дальше только числа. */
const GUEST_NAMES_MAX = 40

const rub = (minor: number | string | null): string =>
  minor === null ? '—' : `${Math.round(Number(minor) / 100).toLocaleString('ru-RU')} ₽`

/** Календарная дата «сейчас» в поясе свадьбы, `YYYY-MM-DD` — как в `routes/day.ts`. */
export function todayIn(tz: string, now: Date): string {
  const opts = { year: 'numeric', month: '2-digit', day: '2-digit' } as const
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: tz }).format(now)
  } catch {
    return new Intl.DateTimeFormat('en-CA', opts).format(now)
  }
}

const daysBetween = (fromIso: string, toIso: string): number =>
  Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000)

const timeIn = (at: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(at)
  } catch {
    return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  }
}

const STATE_RU: Record<string, string> = {
  candidate: 'кандидат (не забронирован)',
  contacted: 'связались, не забронирован',
  negotiating: 'мягкая бронь (переговоры)',
  booked: 'забронирован',
  paid_deposit: 'внесён аванс',
  done: 'выполнено',
  cancelled: 'отменено',
}

const RSVP_RU: Record<string, string> = { yes: 'придёт', no: 'не придёт', pending: 'без ответа' }

export async function weddingContext(db: Db, weddingId: string, now = new Date()): Promise<WeddingContext> {
  const { rows: w } = await db.query<{
    title: string
    date: string | null
    tz: string
    city: string | null
    region: string | null
    venue: string | null
    style: string | null
    guests_planned: number | null
    budget_total: string | null
    planb_scenario: string | null
    planb_at: Date | null
  }>(
    `select w.title, w.date::text as date, coalesce(w.tz, $2) as tz, c.name as city, c.region, w.venue, w.style,
            w.guests_planned, w.budget_total::text as budget_total, w.planb_scenario, w.planb_at
       from weddings w left join cities c on c.id = w.city_id
      where w.id = $1`,
    [weddingId, MOSCOW],
  )
  const wedding = w[0]
  if (!wedding) throw new Error('свадьба не найдена')
  const tz = wedding.tz
  const today = todayIn(tz, now)

  const lines: string[] = []
  lines.push('## Свадьба')
  lines.push(`Название: ${wedding.title}`)
  if (wedding.date) {
    const days = daysBetween(today, wedding.date)
    const when = days > 0 ? `через ${days} дн.` : days === 0 ? 'сегодня' : `прошла ${-days} дн. назад`
    lines.push(`Дата: ${wedding.date} (${when}); сегодня по месту: ${today}, пояс ${tz}`)
  } else {
    lines.push(`Дата ещё не выбрана; сегодня: ${today}`)
  }
  lines.push(`Город: ${wedding.city ? `${wedding.city}${wedding.region ? `, ${wedding.region}` : ''}` : 'не выбран'}`)
  lines.push(`Площадка: ${wedding.venue ?? 'не указана'}`)
  lines.push(`Стиль: ${wedding.style ?? 'не выбран'}`)
  lines.push(`Гостей планируется: ${wedding.guests_planned ?? 'не указано'}`)
  lines.push(`Общий бюджет: ${rub(wedding.budget_total)}`)

  /* Гости — имена и ответы, без телефонов, e-mail и комментариев. */
  const { rows: guests } = await db.query<{ name: string; rsvp: string; plus_one: boolean }>(
    'select name, rsvp, plus_one from guests where wedding_id = $1 order by created_at',
    [weddingId],
  )
  const count = (status: string) => guests.filter((g) => g.rsvp === status).length
  const plusOnes = guests.filter((g) => g.plus_one && g.rsvp !== 'no').length
  lines.push('', '## Гости')
  lines.push(`В списке: ${guests.length} (придут: ${count('yes')}, не придут: ${count('no')}, без ответа: ${count('pending')}); с «+1»: ${plusOnes}`)
  for (const g of guests.slice(0, GUEST_NAMES_MAX)) {
    lines.push(`- ${g.name} — ${RSVP_RU[g.rsvp] ?? g.rsvp}${g.plus_one ? ', +1' : ''}`)
  }
  if (guests.length > GUEST_NAMES_MAX) lines.push(`… и ещё ${guests.length - GUEST_NAMES_MAX}`)

  /* Слоты команды — как на мозаике пары: категория, состояние, кто, цена сделки (это цена ПАРЫ по договорённости, не анкеты). */
  const slots = await loadSlots(db, weddingId, true)
  lines.push('', '## Команда подрядчиков (слоты)')
  for (const s of slots) {
    if (!s.deal) {
      lines.push(`- ${s.label}: пусто — подрядчик не выбран`)
      continue
    }
    const who = s.deal.vendor?.name ?? s.deal.externalName ?? 'без имени'
    const price = 'price' in s.deal && s.deal.price ? `, цена сделки ${rub(s.deal.price.amount)}` : ''
    const own = s.deal.vendor ? '' : ' (свой подрядчик вне каталога)'
    lines.push(`- ${s.label}: ${STATE_RU[s.deal.state] ?? s.deal.state} — ${who}${own}${price}${s.deal.packageName ? `, пакет «${s.deal.packageName}»` : ''}`)
  }

  /* Бюджет — та же формула, что у GET …/budget: доля от общего + обязательства по сделкам + ручные статьи. */
  const total = Number(wedding.budget_total ?? 0)
  const { rows: committed } = await db.query<{ category_id: string; amount: string }>(
    `select s.category_id, sum(d.price)::text as amount
       from deals d join slots s on s.id = d.slot_id
      where d.wedding_id = $1 and d.state = any($2) and d.price is not null
      group by s.category_id`,
    [weddingId, COMMITTED_WITH_HOLD],
  )
  const { rows: items } = await db.query<{ title: string; category_id: string; amount: string }>(
    'select title, category_id, amount::text as amount from budget_items where wedding_id = $1 order by created_at',
    [weddingId],
  )
  const fromSlots = new Map<string, number>()
  for (const row of committed) {
    const id = BUDGET_BY_VENDOR_CATEGORY[row.category_id] ?? BUDGET_FALLBACK
    fromSlots.set(id, (fromSlots.get(id) ?? 0) + Number(row.amount))
  }
  lines.push('', '## Бюджет по категориям (план — доля от общего; факт — сделки и ручные статьи)')
  let spentAll = 0
  for (const c of BUDGET_CATEGORIES) {
    const manual = items.filter((i) => i.category_id === c.id)
    const spent = (fromSlots.get(c.id) ?? 0) + manual.reduce((sum, i) => sum + Number(i.amount), 0)
    spentAll += spent
    const planned = Math.round(total * c.share)
    const share = planned > 0 ? ` (${Math.round((spent / planned) * 100)}% плана)` : ''
    lines.push(`- ${c.title}: план ${total ? rub(planned) : '—'}, факт ${rub(spent)}${share}${manual.length ? `; ручные статьи: ${manual.map((i) => `${i.title} ${rub(i.amount)}`).join(', ')}` : ''}`)
  }
  lines.push(`Итого обязательств: ${rub(spentAll)}${total ? ` из ${rub(total)}; резерв на непредвиденное — 10% (${rub(Math.round(total * 0.1))})` : ''}`)

  /* Задачи — невыполненные со сроком; просроченные отмечены. */
  const { rows: tasks } = await db.query<{ title: string; due: string | null; done_at: Date | null; kind: string | null }>(
    'select title, due::text as due, done_at, kind from tasks where wedding_id = $1 order by due nulls last, sort',
    [weddingId],
  )
  const open = tasks.filter((t) => !t.done_at && t.kind !== 'planb')
  const doneCount = tasks.filter((t) => t.done_at && t.kind !== 'planb').length
  lines.push('', `## Задачи чек-листа (сделано ${doneCount}, открыто ${open.length})`)
  for (const t of open.slice(0, 40)) {
    const overdue = t.due && t.due < today ? ' — ПРОСРОЧЕНО' : ''
    lines.push(`- ${t.title}${t.due ? ` (срок ${t.due})` : ' (без срока)'}${overdue}`)
  }
  if (open.length > 40) lines.push(`… и ещё ${open.length - 40}`)

  /* Тайминг дня — блоки во времени площадки. */
  const { rows: events } = await db.query<{ name: string; location: string | null; starts_at: Date; ends_at: Date | null; for_guests: boolean }>(
    'select name, location, starts_at, ends_at, for_guests from timeline_events where wedding_id = $1 order by sort, starts_at',
    [weddingId],
  )
  lines.push('', '## Тайминг дня')
  if (!events.length) lines.push('Тайминг ещё не составлен')
  for (const e of events) {
    const till = e.ends_at ? `–${timeIn(e.ends_at, tz)}` : ''
    lines.push(`- ${timeIn(e.starts_at, tz)}${till} ${e.name}${e.location ? ` (${e.location})` : ''}${e.for_guests ? '' : ' [только команда]'}`)
  }

  lines.push('', '## План Б')
  lines.push(wedding.planb_at ? `Активирован ${wedding.planb_at.toISOString().slice(0, 10)}: сценарий «${wedding.planb_scenario ?? ''}»` : 'Не активирован')

  return { text: lines.join('\n'), tz }
}
