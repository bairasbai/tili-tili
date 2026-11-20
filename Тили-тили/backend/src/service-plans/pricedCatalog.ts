import type { components } from '../contract/api.generated.js'
import { AppError, conflict, forbidden, validationFailed } from '../errors.js'
import type { Db, Queryable } from '../plugins/db.js'
import { lockOrderPrincipal, type OrderActor } from '../orders/context.js'

type Schemas = components['schemas']
type PlanCode = Schemas['ServicePlanCode']
type PublishPrice = Schemas['PublishServicePlanPrice']

type PriceRow = {
  id: string
  plan_code: PlanCode
  revision: number
  amount: number
  effective_at: Date
  published_at: Date
  published_by: string | null
}

function price(row: Pick<PriceRow, 'id' | 'amount'>, effectiveAt: Date | string): Schemas['ServicePlanPrice'] {
  return {
    id: row.id,
    amount: row.amount,
    currency: 'RUB',
    effectiveAt: new Date(effectiveAt).toISOString(),
  }
}

const stillPublished = `not exists (
  select 1 from service_plan_prices replacement
  where replacement.plan_code = prices.plan_code and replacement.replaces_id = prices.id
)`

export async function readServicePlans(db: Queryable): Promise<Schemas['ServicePlanOfferCatalog']> {
  const { rows } = await db.query<PriceRow>(`
    select distinct on (plan_code) prices.*
    from service_plan_prices prices
    where effective_at <= statement_timestamp() and ${stillPublished}
    order by plan_code, effective_at desc, revision desc
  `)
  return { plans: rows.map(row => ({ code: row.plan_code, price: price(row, row.effective_at), checkoutAvailable: false })) }
}

export async function requirePriceStaff(db: Queryable, userId: string): Promise<void> {
  const { rowCount } = await db.query(
    `select id from users where id = $1 and is_staff and deleted_at is null`,
    [userId],
  )
  if (!rowCount) throw forbidden('У вас нет доступа к управлению тарифами')
}

export async function lockServicePriceOperator(tx: Queryable, actor: OrderActor): Promise<void> {
  await lockOrderPrincipal(tx, actor)
  await requirePriceStaff(tx, actor.userId)
}

export async function readAdminServicePlans(db: Queryable): Promise<Schemas['AdminServicePlanCatalog']> {
  const { rows } = await db.query<{
    plan_code: PlanCode
    latest_id: string | null
    active_id: string | null
    scheduled_id: string | null
    history: Array<Omit<PriceRow, 'effective_at' | 'published_at'> & { effective_at: string; published_at: string }>
  }>(`
    select plans.code as plan_code,
      newest.id as latest_id, active.id as active_id, scheduled.id as scheduled_id,
      coalesce(recent.history, '[]'::json) as history
    from service_plans plans
    left join lateral (
      select id from service_plan_prices where plan_code = plans.code
      order by revision desc limit 1
    ) newest on true
    left join lateral (
      select id from service_plan_prices prices where plan_code = plans.code
        and effective_at <= statement_timestamp() and ${stillPublished}
      order by effective_at desc, revision desc limit 1
    ) active on true
    left join lateral (
      select id from service_plan_prices prices where plan_code = plans.code
        and effective_at > statement_timestamp() and ${stillPublished}
      order by effective_at, revision desc limit 1
    ) scheduled on true
    left join lateral (
      select json_agg(p order by p.revision desc) as history
      from (
        select prices.* from service_plan_prices prices where plan_code = plans.code
        order by coalesce(id in (active.id, scheduled.id), false) desc, revision desc limit 20
      ) p
    ) recent on true
    order by plans.code desc
  `)
  return {
    plans: rows.map(row => ({
      code: row.plan_code,
      latestVersionId: row.latest_id,
      activeVersionId: row.active_id,
      scheduledVersionId: row.scheduled_id,
      history: row.history.map(entry => ({
        ...price(entry, entry.effective_at),
        publishedAt: new Date(entry.published_at).toISOString(),
        publishedBy: entry.published_by,
      })),
    })),
  }
}

export async function publishServicePlanPrice(
  db: Db,
  code: PlanCode,
  actor: OrderActor,
  publication: PublishPrice,
): Promise<void> {
  await db.tx(async tx => {
    await lockServicePriceOperator(tx, actor)
    await tx.query('select code from service_plans where code = $1 for update', [code])
    const { rows: [state] } = await tx.query<{
      latest_id: string | null
      revision: number
      active_id: string | null
      pending_id: string | null
      published_at: Date
      is_future: boolean
    }>(`
      select newest.id as latest_id, coalesce(newest.revision, 0) as revision,
        active.id as active_id, pending.id as pending_id,
        statement_timestamp() as published_at,
        ($2::timestamptz is null or $2::timestamptz > statement_timestamp()) as is_future
      from service_plans plans
      left join lateral (
        select id, revision from service_plan_prices where plan_code = plans.code
        order by revision desc limit 1
      ) newest on true
      left join lateral (
        select id from service_plan_prices prices where plan_code = plans.code
          and effective_at <= statement_timestamp() and ${stillPublished}
        order by effective_at desc, revision desc limit 1
      ) active on true
      left join lateral (
        select id from service_plan_prices prices where plan_code = plans.code
          and effective_at > statement_timestamp() and ${stillPublished}
        order by revision desc limit 1
      ) pending on true
      where plans.code = $1
    `, [code, publication.effectiveAt])
    if (!state) throw new AppError(503, 'service_plan_unavailable', 'Тариф недоступен')
    if (state.latest_id !== publication.expectedVersionId || state.active_id !== publication.expectedActiveVersionId) {
      throw conflict('service_price_changed', 'Цена изменилась. Обновите тарифы.')
    }
    if (!state.is_future) {
      throw validationFailed({ effectiveAt: 'Укажите будущую дату или опубликуйте сейчас' })
    }
    await tx.query(`
      insert into service_plan_prices
        (plan_code, revision, amount, effective_at, published_at, published_by, replaces_id)
      values ($1, $2, $3, coalesce($4::timestamptz, $5), $5, $6, $7)
    `, [code, state.revision + 1, publication.amount, publication.effectiveAt,
      state.published_at, actor.userId, state.pending_id])
  })
}
