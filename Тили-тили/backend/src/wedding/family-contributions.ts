import type { components } from '../contract/api.generated.js'
import { conflict, notFound, validationFailed } from '../errors.js'
import { asMoney } from '../payments/model.js'
import type { Queryable } from '../plugins/db.js'

type Schemas = components['schemas']
type Write = Schemas['FamilyContributionWrite']
type Contribution = Schemas['FamilyContribution']
type Row = {
  id: string
  version: number
  label: string
  promised_amount: string
  received_amount: string
  archived: boolean
  recorded_at: Date
}
const columns = 'id,version,label,promised_amount::text,received_amount::text,archived,recorded_at'
const view = (row: Row): Contribution => ({
  id: row.id, version: row.version, label: row.label, archived: row.archived,
  promised: asMoney(row.promised_amount), received: asMoney(row.received_amount), recordedAt: row.recorded_at.toISOString(),
})

export async function listFamilyContributions(client: Queryable, weddingId: string): Promise<Schemas['FamilyContributionSummary']> {
  const { rows } = await client.query<Row>(`
    select * from (
      select distinct on (id) ${columns} from budget_family_contribution_versions
      where wedding_id=$1 order by id,version desc
    ) latest order by archived,recorded_at desc,id`, [weddingId])
  let outstanding = 0n, received = 0n
  for (const row of rows) {
    if (row.archived) continue
    const paid = BigInt(row.received_amount), expected = BigInt(row.promised_amount) - paid
    if (expected > 0n) outstanding += expected
    received += paid
  }
  return { items: rows.map(view), outstanding: asMoney(outstanding), received: asMoney(received) }
}

export async function readFamilyContributionHistory(client: Queryable, weddingId: string, id: string) {
  const { rows } = await client.query<Row>(`select ${columns} from budget_family_contribution_versions
    where wedding_id=$1 and id=$2 order by version desc`, [weddingId, id])
  if (!rows.length) throw notFound('Запись о вкладе не найдена')
  return { items: rows.map(view) }
}

/** The caller owns the wedding write lock, including when this ID has no row yet. */
export async function saveFamilyContribution(client: Queryable, weddingId: string, id: string, actorId: string,
  body: Write): Promise<Contribution> {
  const label = body.label.trim()
  const hasControlCharacter = Array.from(label).some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (!label || hasControlCharacter) throw validationFailed({ label: 'Укажите название записи' })
  if (body.promised.currency !== 'RUB' || body.received.currency !== 'RUB') {
    throw validationFailed({ promised: 'Укажите суммы в рублях' })
  }
  const { rows: [current] } = await client.query<Row>(`select ${columns} from budget_family_contribution_versions
    where wedding_id=$1 and id=$2 order by version desc limit 1`, [weddingId, id])
  if (!current && body.version !== 0) throw notFound('Запись о вкладе не найдена')
  if (!current && body.archived) throw validationFailed({ archived: 'Сначала сохраните запись о вкладе' })
  if (!body.archived && body.promised.amount === 0 && body.received.amount === 0) {
    throw validationFailed({ promised: 'Укажите обещанную или полученную сумму' })
  }
  if (current && (current.version === body.version || current.version === body.version + 1)
    && current.label === label && current.promised_amount === String(body.promised.amount)
    && current.received_amount === String(body.received.amount) && current.archived === body.archived) return view(current)

  if ((current?.version ?? 0) !== body.version || body.version === 2147483647) {
    throw conflict('stale_family_contribution', 'Запись о вкладе уже изменилась. Обновите бюджет.')
  }
  const version = body.version + 1
  const { rows: [written] } = await client.query<Row>(`insert into budget_family_contribution_versions
    (wedding_id,id,version,label,promised_amount,received_amount,archived) values($1,$2,$3,$4,$5,$6,$7)
    returning ${columns}`, [weddingId, id, version, label, body.promised.amount, body.received.amount, body.archived])
  // The Money contract must remain representable even across several records.
  await listFamilyContributions(client, weddingId)
  const action = current ? 'budget.family_contribution_updated' : 'budget.family_contribution_created'
  await client.query("insert into audit_log(actor_id,action,entity,entity_id,diff) values($1,$2,'family_contribution',$3,$4::jsonb)",
    [actorId, action, id, JSON.stringify({ weddingId, version, archived: body.archived })])
  return view(written!)
}
