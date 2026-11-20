import type { components } from '../contract/api.generated.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { listWeddingMemberOptions, lockAssignableWeddingMember } from './member-options.js'
import { CURRENT_PURCHASES } from './purchase-budget.js'

type Schemas = components['schemas']
type Write = Schemas['WeddingItemWrite']
type Draft = Required<Omit<Write, 'version'>>
type Option = Schemas['WeddingPurchaseOption']
type Row = {
  id: string; version: number; title: string; kit: Schemas['WeddingItemKit']; holder_user_id: string | null
  deliverer_user_id: string | null; purchase_id: string | null; archived: boolean; recorded_at: Date
  actor_name: string | null; holder_name: string | null; deliverer_name: string | null
}
const kits: Schemas['WeddingItemKit'][] = ['bride_morning', 'groom_morning', 'ceremony', 'venue', 'emergency']
const columns = `i.id,i.version,i.title,i.kit,i.holder_user_id,i.deliverer_user_id,i.purchase_id,i.archived,i.recorded_at,
  a.name as actor_name,h.name as holder_name,d.name as deliverer_name`
const names = `left join users a on a.id=i.actor_id and a.deleted_at is null
  left join users h on h.id=i.holder_user_id and h.deleted_at is null
  left join users d on d.id=i.deliverer_user_id and d.deleted_at is null`
const availablePurchases = "p.status not in ('cancelled','returned')"
const titleKey = (title: string) => title.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/[\p{P}\s]+/gu, ' ').trim()

function draftOf(row: Row): Draft {
  return { title: row.title, kit: row.kit, holderId: row.holder_user_id, delivererId: row.deliverer_user_id,
    purchaseId: row.purchase_id, archived: row.archived }
}

function view(row: Row): Schemas['WeddingItem'] {
  return { ...draftOf(row), id: row.id, version: row.version, recordedAt: row.recorded_at.toISOString(),
    actorName: row.actor_name, holderName: row.holder_name, delivererName: row.deliverer_name }
}

async function currentItem(db: Queryable, weddingId: string, id: string) {
  const { rows: [item] } = await db.query<Row>(`select ${columns}
    from wedding_item_versions i ${names} where i.wedding_id=$1 and i.id=$2 order by i.version desc limit 1`, [weddingId, id])
  return item
}

/** The caller holds the exclusive wedding lock, including on the first write. */
export async function saveWeddingItem(db: Queryable, weddingId: string, id: string, actorId: string, body: Write) {
  const title = body.title.trim()
  if (!title || [...title].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw validationFailed({ title: 'Укажите название вещи без управляющих символов' })
  }
  const current = await currentItem(db, weddingId, id)
  if (!current && body.version !== 0) throw notFound('Вещь не найдена')
  if (!current && body.archived) throw validationFailed({ archived: 'Сначала сохраните вещь' })
  const data: Draft = { title, kit: body.kit, holderId: body.holderId ?? null, delivererId: body.delivererId ?? null,
    purchaseId: body.purchaseId ?? null, archived: body.archived }
  const previous = current ? draftOf(current) : null
  if (current && JSON.stringify(data) === JSON.stringify(previous)
    && (current.version === body.version || current.version === body.version + 1)) return view(current)
  if ((current?.version ?? 0) !== body.version || body.version === 2147483647) {
    throw conflict('stale_wedding_item', 'Карточка вещи уже изменилась. Обновите список.')
  }
  for (const field of ['holderId', 'delivererId'] as const) {
    const member = data[field]
    if (member && member !== previous?.[field] && !await lockAssignableWeddingMember(db, weddingId, member)) {
      throw validationFailed({ [field]: 'Выберите участника команды этой свадьбы' })
    }
  }
  if (data.purchaseId && data.purchaseId !== previous?.purchaseId) {
    const purchase = await db.query(`select p.id from (${CURRENT_PURCHASES}) p where p.id=$2 and ${availablePurchases}`,
      [weddingId, data.purchaseId])
    if (!purchase.rowCount) throw validationFailed({ purchaseId: 'Выберите действующую покупку или аренду этой свадьбы' })
  }
  await db.query(`insert into wedding_item_versions(wedding_id,id,version,title,kit,holder_user_id,deliverer_user_id,purchase_id,archived,actor_id)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [weddingId,id,body.version+1,data.title,data.kit,data.holderId,data.delivererId,data.purchaseId,data.archived,actorId])
  return view((await currentItem(db, weddingId, id))!)
}

export async function listWeddingItems(db: Queryable, weddingId: string): Promise<Schemas['WeddingItemList']> {
  const { rows } = await db.query<Row>(`select ${columns} from (
      select distinct on (id) * from wedding_item_versions where wedding_id=$1 order by id,version desc
    ) i ${names} order by i.archived,i.title,i.id`, [weddingId])
  const { rows: purchases } = await db.query<Option>(`select p.id,p.title as label from (${CURRENT_PURCHASES}) p
    where ${availablePurchases} order by p.title,p.id`, [weddingId])
  const matches = new Map<string, Option[]>()
  for (const purchase of purchases) {
    const key = titleKey(purchase.label)
    if (!key) continue
    const options = matches.get(key) ?? []
    if (options.length < 5) options.push(purchase)
    matches.set(key, options)
  }
  const items = rows.map(row => ({ ...view(row), possiblePurchases: row.archived || row.purchase_id ? [] : matches.get(titleKey(row.title)) ?? [] }))
  const { rows: [state] } = await db.query<{ read_only: boolean }>('select cancelled_at is not null as read_only from weddings where id=$1', [weddingId])
  return { kits, items, members: await listWeddingMemberOptions(db, weddingId), purchases, readOnly: state!.read_only }
}

export async function weddingItemHistory(db: Queryable, weddingId: string, id: string): Promise<Schemas['WeddingItemHistory']> {
  const { rows } = await db.query<Row>(`select ${columns}
    from wedding_item_versions i ${names} where i.wedding_id=$1 and i.id=$2 order by i.version desc`, [weddingId, id])
  if (!rows.length) throw notFound('Вещь не найдена')
  return { items: rows.map(view) }
}
