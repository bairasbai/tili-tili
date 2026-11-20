import { isDeepStrictEqual } from 'node:util'
import { conflict, validationFailed } from '../errors.js'
import { uuidv7 } from '../ids.js'
import type { Queryable } from '../plugins/db.js'

export const PLAN_B_SCENARIOS = ['rain', 'vendor_missing', 'power', 'transport'] as const
export type PlanBScenario = typeof PLAN_B_SCENARIOS[number]
export const scenarioSchema = { type: 'string', enum: [...PLAN_B_SCENARIOS] }

type Contact = { label: string; value: string }
type Action = { title: string; responsibleUserId: string | null }
type Plan = {
  reason: string
  triggerCondition: string
  reserveAddress: string | null
  contacts: Contact[]
  actions: Action[]
}
type SavedPlan = Plan & { revision: string }
export type PlanBSave = Omit<Plan, 'actions'> & {
  expectedRevision: string | null
  actions: { title: string; responsibleUserId: string }[]
}

const line = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '^(?![\\s\\S]*\\x00)[\\s\\S]*\\S' })
const uuid = { type: 'string', format: 'uuid' }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

export const planBSaveSchema = {
  type: 'object', additionalProperties: false,
  required: ['expectedRevision', 'reason', 'triggerCondition', 'reserveAddress', 'contacts', 'actions'],
  properties: {
    expectedRevision: nullable(uuid), reason: line(1000), triggerCondition: line(1000),
    reserveAddress: nullable(line(500)),
    contacts: { type: 'array', maxItems: 8, items: {
      type: 'object', additionalProperties: false, required: ['label', 'value'],
      properties: { label: line(100), value: line(250) },
    } },
    actions: { type: 'array', minItems: 1, maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['title', 'responsibleUserId'],
      properties: { title: line(500), responsibleUserId: uuid },
    } },
  },
}

export async function readPlanBScenario(client: Queryable, weddingId: string, scenario: PlanBScenario) {
  const { rows } = await client.query<SavedPlan>(`
    select p.revision, p.reason, p.trigger_condition as "triggerCondition", p.reserve_address as "reserveAddress", p.contacts,
           coalesce((select json_agg(json_build_object('title',a.title,'responsibleUserId',u.id) order by a.position)
              from planb_scenario_actions a left join users u on u.id=a.responsible_user_id and u.deleted_at is null
             where a.wedding_id=p.wedding_id and a.scenario=p.scenario), '[]'::json) as actions
      from planb_scenarios p where p.wedding_id=$1 and p.scenario=$2`, [weddingId, scenario])
  return rows[0] ?? null
}

export async function savePlanBScenario(client: Queryable, weddingId: string, scenario: PlanBScenario, input: PlanBSave) {
  // Caller holds the wedding lock used by activation and team changes.
  const current = await readPlanBScenario(client, weddingId, scenario)
  if ((current?.revision ?? null) !== (input.expectedRevision?.toLowerCase() ?? null)) {
    throw conflict('planb_scenario_changed', 'Сценарий изменился. Откройте актуальную версию')
  }
  const actions = input.actions.map(({ title, responsibleUserId }) => ({
    title: title.trim(), responsibleUserId: responsibleUserId.toLowerCase(),
  }))
  const contacts = input.contacts.map(({ label, value }) => ({ label: label.trim(), value: value.trim() }))
  const reason = input.reason.trim(), triggerCondition = input.triggerCondition.trim(), reserveAddress = input.reserveAddress?.trim() ?? null
  const ids = [...new Set(actions.map(action => action.responsibleUserId))]
  const { rowCount } = await client.query(`select u.id from users u
    join wedding_members m on m.user_id=u.id where m.wedding_id=$1 and u.id=any($2::uuid[]) and u.deleted_at is null
    order by u.id for share of u,m`, [weddingId, ids])
  if (rowCount !== ids.length) throw validationFailed({ actions: 'Выберите ответственных из действующей команды' })
  if (current && isDeepStrictEqual(current, { revision: current.revision, reason, triggerCondition, reserveAddress, contacts, actions })) return current

  const revision = uuidv7()
  await client.query(`insert into planb_scenarios(wedding_id,scenario,revision,reason,trigger_condition,reserve_address,contacts)
    values($1,$2,$3,$4,$5,$6,$7) on conflict(wedding_id,scenario) do update set revision=excluded.revision,
      reason=excluded.reason,trigger_condition=excluded.trigger_condition,reserve_address=excluded.reserve_address,contacts=excluded.contacts`,
  [weddingId, scenario, revision, reason, triggerCondition, reserveAddress, JSON.stringify(contacts)])
  await client.query('delete from planb_scenario_actions where wedding_id=$1 and scenario=$2', [weddingId, scenario])
  await client.query(`insert into planb_scenario_actions(wedding_id,scenario,position,title,responsible_user_id)
    select $1,$2,ordinality,title,responsible_user_id
      from unnest($3::text[],$4::uuid[]) with ordinality as a(title,responsible_user_id,ordinality)`,
  [weddingId, scenario, actions.map(a => a.title), actions.map(a => a.responsibleUserId)])
  return readPlanBScenario(client, weddingId, scenario)
}
