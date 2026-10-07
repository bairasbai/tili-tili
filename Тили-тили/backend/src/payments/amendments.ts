import { createHash } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, validationFailed } from '../errors.js'
import { isUuid, uuidv7 } from '../ids.js'
import { lockOrderPrincipal, type OrderActor } from '../orders/context.js'
import { readKeyHeader } from '../deals/idempotency.js'
import { assertSeatingToken } from '../wedding/access.js'
import { PAID_SUM } from '../deals/repo.js'
import { buildPage, encodeCursor, parsePageQuery, timestampKey } from '../pagination.js'
import { asMoney, assertPaidOn, assertPayable, assertVersion, financeAudit, type FinancialDeal, type PaymentMethod } from './model.js'

export const MAX_PAYMENT_VERSION = 2147483647
export function assertVersionCapacity(version: number) {
  if (version >= MAX_PAYMENT_VERSION) throw conflict('payment_version_exhausted', 'Версия исчерпана — нужна сверка данных')
}
export type AmendmentActor = OrderActor
export interface AmendmentContext {
  weddingId: string; actor: AmendmentActor; weddingCancelled: boolean
  deal: FinancialDeal & { currency: string }
}
/** Lock the current principal and scope before any claim/entity wait. Cancelled history remains readable. */
export async function lockAmendmentContext(tx: Queryable, weddingId: string, actor: AmendmentActor,
  target: { type: 'payment' | 'installment'; id: string }, write = false): Promise<AmendmentContext> {
  if (!isUuid(target.id)) throw notFound('Финансовая запись не найдена')
  const wedding = await tx.query<{ cancelled: boolean }>(`select cancelled_at is not null as cancelled
    from weddings where id=$1 and archived_at is null for share`, [weddingId])
  if (!wedding.rows[0]) throw notFound('Свадьба не найдена')
  await lockOrderPrincipal(tx, actor)
  const member = await tx.query<{ role: string }>('select role from wedding_members where wedding_id=$1 and user_id=$2 for share', [weddingId, actor.userId])
  if (!member.rows[0]) throw notFound('Свадьба не найдена')
  if (member.rows[0].role !== 'couple') throw forbidden('Финансовый раздел доступен только паре')
  const table = target.type === 'payment' ? 'payments' : 'payment_installments'
  const parent = await tx.query<{ deal_id: string }>(`select p.deal_id from ${table} p join deals d on d.id=p.deal_id where p.id=$1 and d.wedding_id=$2`, [target.id, weddingId])
  if (!parent.rows[0]) throw notFound('Финансовая запись не найдена')
  const deal = await tx.query<AmendmentContext['deal']>(`select id,state,price::text as price,currency from deals where id=$1 and wedding_id=$2 for ${write ? 'update' : 'share'}`, [parent.rows[0].deal_id, weddingId])
  if (!deal.rows[0]) throw notFound('Сделка не найдена')
  const record = await tx.query(`select id from ${table} where id=$1 and deal_id=$2 for ${write ? 'update' : 'share'}`, [target.id, deal.rows[0].id])
  if (!record.rows[0]) throw notFound('Финансовая запись не найдена')
  return { weddingId, actor, weddingCancelled: wedding.rows[0].cancelled, deal: deal.rows[0] }
}
export function assertAmendmentWritable(context: AmendmentContext) {
  if (context.weddingCancelled) throw conflict('wedding_cancelled', 'Свадьба отменена — финансовая история доступна только для чтения')
}

/** The receipt and effect commit together. A later private response failure never releases that receipt.
 * Old stage receipts can be replayed: only their identity is used, never their saved private projection. */
export async function amendAndRead<T extends object>(db: Db, request: FastifyRequest, reply: FastifyReply, route: string,
  lock: (tx: Queryable, write: boolean) => Promise<AmendmentContext>,
  change: (tx: Queryable, context: AmendmentContext) => Promise<{ body: unknown; eventId?: string | null }>,
  read: (tx: Queryable, context: AmendmentContext) => Promise<T>): Promise<T & { amendmentId: string | null }> {
  const clientKey = readKeyHeader(request, true)!
  const key = `${request.caller!.userId}:${route}:${clientKey}`
  const hash = createHash('sha256').update(`${request.url}\n${JSON.stringify(request.body ?? null)}`).digest('hex')
  const receipt = await db.tx(async tx => {
    const context = await lock(tx, true)
    await assertSeatingToken(request)
    await tx.query("delete from idempotency_keys where key=$1 and created_at < now()-interval '1 day'", [key])
    const inserted = await tx.query(`insert into idempotency_keys(key,user_id,route,request_hash) values($1,$2,$3,$4)
      on conflict(key) do nothing returning key`, [key, context.actor.userId, route, hash])
    await assertSeatingToken(request)
    if (!inserted.rowCount) {
      const seen = (await tx.query<{ status: number | null; request_hash: string; body: unknown }>('select status,request_hash,body from idempotency_keys where key=$1 for update', [key])).rows[0]
      await assertSeatingToken(request)
      if (!seen || seen.status === null) throw conflict('idempotency_in_progress', 'Запрос ещё выполняется — повторите попытку')
      if (seen.request_hash !== hash) throw conflict('idempotency_key_reused', 'Этот ключ уже использован для другого запроса')
      const previous = seen.body as { amendmentId?: unknown } | null
      return { replay: true, eventId: previous && typeof previous.amendmentId === 'string' && isUuid(previous.amendmentId) ? previous.amendmentId : null }
    }
    assertAmendmentWritable(context)
    const result = await change(tx, context)
    const saved = await tx.query('update idempotency_keys set status=200,body=$2 where key=$1 and status is null', [key, JSON.stringify({ ...result.body as object, amendmentId: result.eventId ?? null })])
    if (saved.rowCount !== 1) throw new AppError(500, 'payment_receipt_missing', 'Не удалось сохранить результат изменения')
    await assertSeatingToken(request)
    return { replay: false, eventId: result.eventId ?? null }
  })
  if (receipt.replay) reply.header('idempotent-replay', 'true')
  // Separate transaction after COMMIT, deliberately outside a releaseKey catch.
  return db.tx(async tx => {
    const context = await lock(tx, false)
    const current = await read(tx, context)
    await assertSeatingToken(request)
    return { ...current, amendmentId: receipt.eventId }
  })
}

export interface CorrectionInput {
  version: number; amountKnown: boolean; amount: { amount: number; currency: 'RUB' } | null
  paidOn: string; paymentMethod: PaymentMethod; reason: string
}
/** Coercion by AJV cannot turn an unintended scalar into a financial instruction. */
export function validateCorrection(raw: unknown): asserts raw is CorrectionInput {
  const fail = (field: string): never => { throw validationFailed({ [field]: 'Некорректное поле исправления' }) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('body')
  const b = raw as Record<string, unknown>, fields = ['version', 'amountKnown', 'amount', 'paidOn', 'paymentMethod', 'reason']
  if (Object.keys(b).length !== fields.length || fields.some(k => !(k in b)) || Object.keys(b).some(k => !fields.includes(k))) fail('body')
  if (typeof b.version !== 'number' || !Number.isInteger(b.version) || b.version < 1 || b.version > MAX_PAYMENT_VERSION) fail('version')
  if (typeof b.amountKnown !== 'boolean') fail('amountKnown')
  if (b.amountKnown) {
    const a = b.amount as Record<string, unknown> | null
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).length !== 2 || a.currency !== 'RUB'
      || typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) fail('amount')
  } else if (b.amount !== null) fail('amount')
  if (typeof b.paidOn !== 'string') fail('paidOn')
  assertPaidOn(b.paidOn as string)
  if (typeof b.paymentMethod !== 'string' || !['cash', 'bank_transfer', 'card', 'other'].includes(b.paymentMethod)) fail('paymentMethod')
  if (typeof b.reason !== 'string' || Array.from(b.reason.trim()).length < 1 || Array.from(b.reason.trim()).length > 500) fail('reason')
}

export interface CorrectablePayment {
  id: string; deal_id: string; plan_version: number; installment_id: string | null
  kind: string; status: string; amount_known: boolean; amount: string | null; currency: string
  paid_on: string; payment_method: PaymentMethod; visibility: string; provider_ref: string | null; created_at: Date
}
export const PAYMENT_SELECT = 'id,deal_id,plan_version,installment_id,kind,status,amount_known,amount::text as amount,currency,paid_on::text as paid_on,payment_method,visibility,provider_ref,created_at'
export function canCorrectPayment(p: Pick<CorrectablePayment, 'status' | 'kind' | 'provider_ref' | 'currency' | 'plan_version'>,
  deal: Pick<AmendmentContext['deal'], 'state' | 'price' | 'currency'>, cancelled: boolean) {
  return !cancelled && ['booked', 'paid_deposit', 'done'].includes(deal.state) && deal.price !== null && BigInt(deal.price) > 0n
    && deal.currency === 'RUB' && p.currency === 'RUB' && p.status === 'recorded' && p.provider_ref === null
    && ['deposit', 'balance'].includes(p.kind) && p.plan_version < MAX_PAYMENT_VERSION
}
export async function paymentProjection(tx: Queryable, context: AmendmentContext, id: string) {
  const p = (await tx.query<CorrectablePayment>(`select ${PAYMENT_SELECT} from payments where id=$1 and deal_id=$2`, [id, context.deal.id])).rows[0]
  if (!p) throw notFound('Оплата не найдена')
  if (p.currency !== 'RUB') throw conflict('payment_currency_unsupported', 'Отметка сохранена в неподдерживаемой валюте')
  return { id: p.id, dealId: p.deal_id, installmentId: p.installment_id, version: p.plan_version, kind: p.kind,
    amountKnown: p.amount_known, amount: p.amount_known && p.amount !== null ? asMoney(p.amount) : null,
    paidOn: p.paid_on, paymentMethod: p.payment_method, visibility: p.visibility, status: p.status,
    createdAt: p.created_at.toISOString(), canCorrect: canCorrectPayment(p, context.deal, context.weddingCancelled) }
}
export async function correctPayment(tx: Queryable, context: AmendmentContext, id: string, body: CorrectionInput) {
  assertPayable(context.deal)
  const p = (await tx.query<CorrectablePayment>(`select ${PAYMENT_SELECT} from payments where id=$1 and deal_id=$2 for update`, [id, context.deal.id])).rows[0]!
  assertVersion(p.plan_version, body.version)
  if (context.deal.currency !== 'RUB' || p.currency !== 'RUB') throw conflict('payment_currency_unsupported', 'Исправление доступно для отметок и сделок в рублях')
  if (p.status !== 'recorded' || p.provider_ref !== null || !['deposit', 'balance'].includes(p.kind)) throw conflict('payment_not_correctable', 'Эту отметку нельзя исправить вручную')
  const next = body.amountKnown ? String(body.amount!.amount) : null
  if (p.amount_known === body.amountKnown && p.amount === next && p.paid_on === body.paidOn && p.payment_method === body.paymentMethod) {
    return { body: await paymentProjection(tx, context, id), eventId: null }
  }
  assertVersionCapacity(p.plan_version)
  const old = p.amount_known && p.amount !== null ? BigInt(p.amount) : 0n, contribution = next === null ? 0n : BigInt(next)
  const paid = (await tx.query<{ paid: string }>(`select ${PAID_SUM}::text as paid from deals d where d.id=$1`, [context.deal.id])).rows[0]!.paid
  asMoney(paid); if (p.amount !== null) asMoney(p.amount)
  if (old !== contribution) {
    const projected = BigInt(paid) - old + contribution
    if (projected < 0n || projected > BigInt(context.deal.price!)) throw conflict('payment_over_price', 'Исправление выводит итог оплат за границы цены сделки')
  }
  // NULL and positive amounts differ in the native arithmetic trigger even when a zero contribution is involved.
  if (p.installment_id && p.amount !== next) {
    const stage = (await tx.query<{ paid: string; amount: string; version: number }>('select paid::text,amount::text,version from payment_installments where id=$1 and deal_id=$2 for update', [p.installment_id, context.deal.id])).rows[0]
    if (!stage) throw notFound('Этап не найден')
    const projected = BigInt(stage.paid) - old + contribution
    if (projected < 0n || projected > BigInt(stage.amount)) throw conflict('installment_overpay', 'Исправление выводит оплаты этапа за границы его суммы')
    assertVersionCapacity(stage.version)
  }
  const after = (await tx.query<CorrectablePayment>(`update payments set amount_known=$2,amount=$3,paid_on=$4,payment_method=$5 where id=$1 returning ${PAYMENT_SELECT}`, [id, body.amountKnown, next, body.paidOn, body.paymentMethod])).rows[0]!
  const eventId = uuidv7()
  await tx.query(`insert into payment_corrections(id,wedding_id,deal_id,payment_id,actor_id,session_id,before_version,after_version,currency,
    before_amount_known,after_amount_known,before_amount,after_amount,before_paid_on,after_paid_on,before_payment_method,after_payment_method,reason)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [eventId, context.weddingId, context.deal.id, id, context.actor.userId, context.actor.sessionId, p.plan_version, after.plan_version, p.currency,
    p.amount_known, after.amount_known, p.amount, after.amount, p.paid_on, after.paid_on, p.payment_method, after.payment_method, body.reason.trim()])
  await financeAudit(tx, context.actor.userId, 'payment', id, 'payment.corrected', { correctionId: eventId, previousVersion: p.plan_version, version: after.plan_version,
    changed: ['amountKnown', 'amount', 'paidOn', 'paymentMethod'].filter(k => k === 'amountKnown' ? p.amount_known !== after.amount_known : k === 'amount' ? p.amount !== after.amount : k === 'paidOn' ? p.paid_on !== after.paid_on : p.payment_method !== after.payment_method) })
  return { body: await paymentProjection(tx, context, id), eventId }
}

interface HistoryRow {
  id: string; wedding_id: string; deal_id: string; payment_id: string; installment_id: string
  before_version: number; after_version: number; created_at: Date; sort_key: string; reason: string
  actor_id: string | null; actor_name: string | null
  before_amount_known: boolean; after_amount_known: boolean; before_amount: string | null; after_amount: string | null
  before_paid_on: string; after_paid_on: string; before_payment_method: string; after_payment_method: string
  before_title: string; after_title: string; before_due: string; after_due: string
  before_cancelled_at: Date | null; after_cancelled_at: Date | null; before_cancel_reason: string | null; after_cancel_reason: string | null
}
/** Live author identity is restricted to self/current couple; departed or erased identities are not copied. */
export async function amendmentHistory(tx: Queryable, context: AmendmentContext, type: 'payment' | 'installment', id: string,
  query: { limit?: unknown; cursor?: unknown }) {
  const { limit, cursor } = parsePageQuery(query)
  const table = type === 'payment' ? 'payment_corrections' : 'payment_installment_edits', parent = type === 'payment' ? 'payment_id' : 'installment_id'
  const columns = type === 'payment'
    ? 'h.payment_id,h.before_amount_known,h.after_amount_known,h.before_paid_on::text,h.after_paid_on::text,h.before_payment_method,h.after_payment_method,h.reason'
    : 'h.installment_id,h.before_title,h.after_title,h.before_due::text,h.after_due::text,h.before_cancelled_at,h.after_cancelled_at,h.before_cancel_reason,h.after_cancel_reason'
  const rows = (await tx.query<HistoryRow>(`select h.id,h.wedding_id,h.deal_id,h.before_version,h.after_version,h.created_at,
    ${timestampKey('h.created_at')} as sort_key,h.before_amount::text,h.after_amount::text,${columns},u.id as actor_id,u.name as actor_name
    from ${table} h left join users u on u.id=h.actor_id and u.deleted_at is null and
      (u.id=$4 or exists(select 1 from wedding_members m where m.wedding_id=h.wedding_id and m.user_id=u.id and m.role='couple'))
    where h.wedding_id=$1 and h.${parent}=$2 and h.deal_id=$3
      ${cursor ? 'and (h.created_at,h.id)<($5::timestamptz,$6::uuid)' : ''}
    order by h.created_at desc,h.id desc limit $${cursor ? 7 : 5}`, cursor
    ? [context.weddingId, id, context.deal.id, context.actor.userId, cursor.sort, cursor.id, limit + 1]
    : [context.weddingId, id, context.deal.id, context.actor.userId, limit + 1])).rows
  const page = buildPage(rows, limit, r => encodeCursor(r.sort_key, r.id))
  const tuple = (r: HistoryRow, side: 'before' | 'after') => type === 'payment'
    ? { amountKnown: r[`${side}_amount_known`], amount: r[`${side}_amount`] === null ? null : asMoney(r[`${side}_amount`]!), paidOn: r[`${side}_paid_on`], paymentMethod: r[`${side}_payment_method`] }
    : { title: r[`${side}_title`], amount: asMoney(r[`${side}_amount`]!), due: r[`${side}_due`], cancelledAt: r[`${side}_cancelled_at`]?.toISOString() ?? null, cancelReason: r[`${side}_cancel_reason`] }
  return { items: page.items.map(r => ({ id: r.id, dealId: r.deal_id, [type === 'payment' ? 'paymentId' : 'installmentId']: id,
    beforeVersion: r.before_version, afterVersion: r.after_version, createdAt: r.created_at.toISOString(),
    actor: r.actor_id ? { id: r.actor_id, name: r.actor_name, kind: r.actor_id === context.actor.userId ? 'self' : 'partner' } : null,
    before: tuple(r, 'before'), after: tuple(r, 'after'), ...(type === 'payment' ? { reason: r.reason } : {}) })), nextCursor: page.nextCursor }
}

/** Account export reads its own fresh couple scope, including archived financial history.
 * Locks are held for both queries; the initial account-export wedding list is not authority. */
export async function financialAmendmentExport(db: Db, actor: AmendmentActor, afterRead: () => Promise<void>) {
  return db.tx(async tx => {
    const candidates = (await tx.query<{ wedding_id: string }>("select wedding_id from wedding_members where user_id=$1 and role='couple' order by wedding_id", [actor.userId])).rows.map(r => r.wedding_id)
    await tx.query('select id from weddings where id=any($1::uuid[]) order by id for share', [candidates])
    await lockOrderPrincipal(tx, actor)
    const ids = (await tx.query<{ wedding_id: string }>("select wedding_id from wedding_members where wedding_id=any($1::uuid[]) and user_id=$2 and role='couple' order by wedding_id for share", [candidates, actor.userId])).rows.map(r => r.wedding_id)
    const paymentCorrections = (await tx.query(`select h.id,h.wedding_id,h.deal_id,h.payment_id,h.before_version,h.after_version,h.currency,h.created_at,
      h.before_amount_known,h.after_amount_known,h.before_amount::text,h.after_amount::text,h.before_paid_on::text,h.after_paid_on::text,
      h.before_payment_method,h.after_payment_method,h.reason,u.id as actor_id,u.name as actor_name
      from payment_corrections h left join users u on u.id=h.actor_id and u.deleted_at is null and u.id=$2
      where h.wedding_id=any($1::uuid[]) order by h.created_at,h.id`, [ids, actor.userId])).rows
    const paymentInstallmentEdits = (await tx.query(`select h.id,h.wedding_id,h.deal_id,h.installment_id,h.before_version,h.after_version,h.currency,h.created_at,
      h.before_title,h.after_title,h.before_amount::text,h.after_amount::text,h.before_due::text,h.after_due::text,
      h.before_cancelled_at,h.after_cancelled_at,h.before_cancel_reason,h.after_cancel_reason,u.id as actor_id,u.name as actor_name
      from payment_installment_edits h left join users u on u.id=h.actor_id and u.deleted_at is null and u.id=$2
      where h.wedding_id=any($1::uuid[]) order by h.created_at,h.id`, [ids, actor.userId])).rows
    await afterRead()
    return { paymentCorrections, paymentInstallmentEdits }
  })
}
