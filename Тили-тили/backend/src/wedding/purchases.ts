import type { components } from '../contract/api.generated.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { assertActiveDeal, listBudgetDealChoices } from './budget.js'
import { assertRealDate } from './dates.js'
import { listWeddingMemberOptions, lockAssignableWeddingMember } from './member-options.js'
import { CURRENT_PURCHASES } from './purchase-budget.js'
import { RENTAL_COLUMNS, rentalOf, validateRental, type RentalRow } from './rental-deposits.js'
import { BUDGET_CATEGORIES } from './templates.js'

type Schemas = components['schemas']
type Write = Schemas['WeddingPurchaseWrite']
type Draft = Required<Omit<Write, 'version' | 'rental'>> & { rental: Schemas['RentalDetails'] | null }
type Status = Schemas['WeddingPurchaseStatus']
type Row = RentalRow & {
  id: string; version: number; title: string; quantity: string; unit: string; category_id: string
  estimated_amount: string | null; agreed_amount: string | null; seller: string | null; seller_url: string | null
  due_on: string | null; assignee_id: string | null; event_id: string | null; linked_deal_id: string | null
  status: Status; recorded_at: Date
}

const transitions: Record<Status, Status[]> = {
  needed: ['ordered', 'cancelled'],
  ordered: ['received', 'cancelled'],
  received: ['delivered', 'returned'],
  delivered: ['done', 'returned'],
  done: ['returned'],
  cancelled: [],
  returned: [],
}
const fields = `id,version,title,trim_scale(quantity)::text as quantity,unit,category_id,estimated_amount::text,
  agreed_amount::text,seller,seller_url,due_on::text,assignee_id,event_id,linked_deal_id,status,recorded_at,${RENTAL_COLUMNS}`

function dataOf(row: Row): Draft {
  return { title: row.title, quantity: row.quantity, unit: row.unit, categoryId: row.category_id,
    estimatedAmount: row.estimated_amount === null ? null : Number(row.estimated_amount),
    agreedAmount: row.agreed_amount === null ? null : Number(row.agreed_amount),
    seller: row.seller, sellerUrl: row.seller_url, dueOn: row.due_on, assigneeId: row.assignee_id,
    eventId: row.event_id, linkedDealId: row.linked_deal_id, status: row.status, rental: rentalOf(row) }
}

function view(row: Row): Schemas['WeddingPurchase'] {
  const { rental, ...data } = dataOf(row)
  return { ...data, ...(rental ? { rental } : {}), id: row.id, version: row.version, updatedAt: row.recorded_at.toISOString(),
    nextStatuses: transitions[row.status] }
}

function text(input: string, field: string): string {
  const value = input.trim()
  if ([...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw validationFailed({ [field]: 'Укажите значение без управляющих символов' })
  }
  return value
}

function normalize(body: Write, previous: Draft | null): Draft {
  const title = text(body.title, 'title'), unit = text(body.unit, 'unit')
  if (!title || !unit) throw validationFailed({ [title ? 'unit' : 'title']: 'Заполните поле' })
  const [whole, tail] = body.quantity.split('.')
  const fraction = tail?.replace(/0+$/, '') ?? ''
  const quantity = Number(whole) + (fraction ? '.' + fraction : '')
  if (Number(quantity) <= 0) throw validationFailed({ quantity: 'Количество должно быть больше нуля' })
  if (!BUDGET_CATEGORIES.some(category => category.id === body.categoryId)) {
    throw validationFailed({ categoryId: 'Неизвестная категория бюджета' })
  }
  const address = body.sellerUrl ? text(body.sellerUrl, 'sellerUrl') : ''
  const sellerUrl = address ? URL.parse(address) : null
  if (address) {
    if (!sellerUrl || !['http:', 'https:'].includes(sellerUrl.protocol) || sellerUrl.username || sellerUrl.password || sellerUrl.href.length > 1024) {
      throw validationFailed({ sellerUrl: 'Укажите ссылку HTTP или HTTPS без данных для входа' })
    }
  }
  if (body.dueOn) assertRealDate(body.dueOn, 'dueOn')
  if (previous && !previous.rental && body.rental) throw validationFailed({ rental: 'Тип сохранённой карточки изменить нельзя' })
  return { title, quantity, unit, categoryId: body.categoryId,
    estimatedAmount: body.estimatedAmount ?? null, agreedAmount: body.agreedAmount ?? null,
    seller: body.seller ? text(body.seller, 'seller') || null : null, sellerUrl: sellerUrl?.href ?? null,
    dueOn: body.dueOn ?? null, assigneeId: body.assigneeId ?? null, eventId: body.eventId ?? null,
    linkedDealId: body.linkedDealId ?? null, status: body.status,
    rental: body.rental ? validateRental(body.rental) : previous?.rental ?? null }
}

/** The caller owns the exclusive wedding lock, including when the ID is new. */
export async function saveWeddingPurchase(db: Queryable, weddingId: string, id: string, actorId: string, body: Write) {
  const { rows: [current] } = await db.query<Row>(`select ${fields} from wedding_purchase_versions
    where wedding_id=$1 and id=$2 order by version desc limit 1`, [weddingId, id])
  if (!current && body.version !== 0) throw notFound('Покупка не найдена')
  const previous = current ? dataOf(current) : null
  const data = normalize(body, previous)
  if (current && JSON.stringify(previous) === JSON.stringify(data)
    && (current.version === body.version || current.version === body.version + 1)) return view(current)
  if ((current?.version ?? 0) !== body.version || body.version === 2147483647) {
    throw conflict('stale_wedding_purchase', 'Покупка уже изменилась. Обновите список.')
  }
  const allowed = current ? [current.status, ...transitions[current.status]] : ['needed']
  if (!allowed.includes(data.status)) throw conflict('wedding_purchase_transition', 'Этот переход для покупки недоступен')
  if (data.assigneeId && data.assigneeId !== previous?.assigneeId) {
    if (!await lockAssignableWeddingMember(db, weddingId, data.assigneeId)) {
      throw validationFailed({ assigneeId: 'Выберите участника команды этой свадьбы' })
    }
  }
  if (data.eventId && data.eventId !== previous?.eventId) {
    const event = await db.query('select id from wedding_events where wedding_id=$1 and id=$2 for share', [weddingId, data.eventId])
    if (!event.rowCount) throw validationFailed({ eventId: 'Выберите мероприятие этой свадьбы' })
  }
  if (data.linkedDealId && data.linkedDealId !== previous?.linkedDealId) await assertActiveDeal(db, weddingId, data.linkedDealId)
  const rental = data.rental
  const { rows: [saved] } = await db.query<Row>(`insert into wedding_purchase_versions
    (wedding_id,id,version,title,quantity,unit,category_id,estimated_amount,agreed_amount,seller,seller_url,
      due_on,assignee_id,event_id,linked_deal_id,status,status_changed,actor_id,
      rental_pickup_on,rental_return_on,deposit_expected,deposit_paid,deposit_refunded,deposit_disputed,rental_changed)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
    returning ${fields}`, [weddingId,id,body.version+1,data.title,data.quantity,data.unit,data.categoryId,
    data.estimatedAmount,data.agreedAmount,data.seller,data.sellerUrl,data.dueOn,data.assigneeId,data.eventId,
    data.linkedDealId,data.status,previous?.status !== data.status,actorId,
    rental?.pickupOn ?? null,rental?.returnOn ?? null,rental?.depositAmount ?? null,rental?.paidAmount ?? null,
    rental?.refundedAmount ?? null,rental?.disputedAmount ?? null,
    rental !== null && JSON.stringify(rental) !== JSON.stringify(previous?.rental ?? null)])
  return view(saved!)
}

export async function listWeddingPurchases(db: Queryable, weddingId: string): Promise<Schemas['WeddingPurchaseList']> {
  type Option = Schemas['WeddingPurchaseOption']
  const { rows } = await db.query<Row>(`select ${fields} from (${CURRENT_PURCHASES}) p order by recorded_at desc,id`, [weddingId])
  const members = await listWeddingMemberOptions(db, weddingId)
  const { rows: events } = await db.query<Option>('select id,name as label from wedding_events where wedding_id=$1 order by is_main desc,date,id', [weddingId])
  const { rows: [state] } = await db.query<{ read_only: boolean }>('select cancelled_at is not null as read_only from weddings where id=$1', [weddingId])
  return { items: rows.map(view), members, events, deals: await listBudgetDealChoices(db, weddingId),
    categories: BUDGET_CATEGORIES.map(category => ({ id: category.id, label: category.title })), readOnly: state!.read_only }
}

export async function weddingPurchaseHistory(db: Queryable, weddingId: string, id: string): Promise<Schemas['WeddingPurchaseHistory']> {
  const { rows } = await db.query<RentalRow & { version: number; status: Status; name: string | null; recorded_at: Date }>(`
    select p.version,p.status,u.name,p.recorded_at,${RENTAL_COLUMNS} from wedding_purchase_versions p
    left join users u on u.id=p.actor_id and u.deleted_at is null
    where p.wedding_id=$1 and p.id=$2 and (p.status_changed or p.rental_changed) order by p.version desc`, [weddingId, id])
  if (!rows.length) throw notFound('Покупка не найдена')
  return { items: rows.map(row => {
    const rental = rentalOf(row)
    return { version: row.version, status: row.status, actorName: row.name, recordedAt: row.recorded_at.toISOString(),
      ...(rental ? { rental } : {}) }
  }) }
}
