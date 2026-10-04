import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, unauthorized } from '../errors.js'
import { consentState } from '../auth/consent.js'
import { lockOrderPrincipal } from '../orders/context.js'
import { assertSeatingToken } from '../wedding/access.js'
import { guestByToken } from '../guests/access.js'
import { captureNotification, placeCapturedNotification, type CapturedNotification, type NewNotification } from './notify.js'
import { prepareFanoutScope, type FanoutLocator } from './fanout-scope.js'

export type EnrolledOwner = 'timeline.shift' | 'rsvp.request' | 'events.patch' | 'weddings.patch'
  | 'weddings.reschedule' | 'weddings.cancel' | 'offer-requests.create' | 'offers.accept'
  | 'slots.book' | 'slots.replace' | 'slots.external' | 'vendor.offers.reply'

export interface EnrolledEmission {
  emit(client: Queryable, item: NewNotification, now?: Date, weddingTz?: string | null): Promise<void>
  emitWedding(client: Queryable, weddingId: string, exceptUserId: string | null,
    item: Omit<NewNotification, 'userId'>, now?: Date, withVendors?: boolean,
    roles?: readonly string[] | null): Promise<void>
  flush(): Promise<void>
  /** Read-only checks over already pinned sources, after receipt's final wait. */
  afterLastWrite(check: () => Promise<void>): void
}
interface EnrolledInput extends FanoutLocator {
  owner: EnrolledOwner
  request: FastifyRequest
  afterReceipt?: boolean
  guest?: { token: string; partyId: string }
}
const pending = new WeakMap<Queryable, () => Promise<void>>()

/** Ownership-filtered nonlocking locator. Wedding precedes the request mutex;
 * the original request query is repeated under prepared parents afterwards. */
export async function locateVendorReplyFanout(client: Queryable, request: FastifyRequest,
  requestId: string): Promise<FanoutLocator> {
  const row = (await client.query<{ wedding_id: string; vendor_id: string }>(
    `select s.wedding_id,r.vendor_id from offer_requests r
      join vendors owner on owner.id=r.vendor_id and owner.user_id=$2
      join slots s on s.id=r.slot_id where r.id=$1`, [requestId, request.caller!.userId])).rows[0]
  if (!row) throw notFound('Запрос не найден')
  return { weddingId: row.wedding_id, actorId: request.caller!.userId, extraVendorIds: [row.vendor_id] }
}

/** Explicit opt-in IdempotentTx hook; generic/replay paths never consult it. */
export async function finishEnrolledFanoutAfterReceipt(client: Queryable): Promise<void> {
  const finish = pending.get(client)
  if (!finish) throw new Error('Missing explicitly enrolled receipt finalizer')
  pending.delete(client)
  await finish()
}

/** Only registered outer owned callbacks call this helper. It opens no TX,
 * publishes no pending notice ID, and never changes immediate notify results. */
export async function runEnrolledFanout<T>(client: Queryable, input: EnrolledInput,
  action: (emissions: EnrolledEmission) => Promise<T>): Promise<T> {
  if (pending.has(client)) throw new Error('One enrolled outer owner per transaction')
  const request = input.request, caller = input.guest ? undefined : request.caller
  const member = request.member
  // Read current authority over the prepared roots without acquiring any new
  // parent. A revoked caller keeps its original refusal before source409.
  const checkCurrentAuthority = async () => {
    if (input.guest) {
      const current = await guestByToken(client, input.guest.token)
      if (current.partyId !== input.guest.partyId || current.weddingId !== input.weddingId) throw unauthorized('Ссылка недействительна')
      return
    }
    if (!caller) throw unauthorized('Нужен вход')
    const user = (await client.query<{ deleted_at: Date | null }>('select deleted_at from users where id=$1', [caller.userId])).rows[0]
    if (!user || user.deleted_at) throw unauthorized('Аккаунт удалён')
    const session = await client.query('select id from sessions where id=$1 and user_id=$2 and revoked_at is null', [caller.sessionId, caller.userId])
    if (!session.rowCount) throw unauthorized('Сессия завершена')
    if (member) {
      const current = (await client.query<{ role: string }>(
        'select role from wedding_members where wedding_id=$1 and user_id=$2', [input.weddingId, caller.userId])).rows[0]
      if (!current || member.weddingId !== input.weddingId) throw notFound('Свадьба не найдена')
      if (current.role !== member.role) throw forbidden('Недостаточно прав')
    }
    // No new consent row/parent acquisition after quota. Withdrawal and profile
    // writers are excluded by the user SHARE; the boot principal is pinned.
    const state = await consentState(client, caller.userId, request.server.appConfig.policyVersion)
    if (state === 'none') throw forbidden('Нужно согласие на обработку персональных данных')
    if (state === 'outdated') throw new AppError(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить')
  }
  const scope = await prepareFanoutScope(client, input, checkCurrentAuthority)
  if (caller) await lockOrderPrincipal(client, { userId: caller.userId, sessionId: caller.sessionId,
    policyVersion: request.server.appConfig.policyVersion })
  const checkAuthority = async () => {
    await checkCurrentAuthority()
    await scope.assertParents()
  }
  await checkAuthority()
  const captures: CapturedNotification[] = [], finalChecks: (() => Promise<void>)[] = []
  let sealed = false, flushed = false
  const emit: EnrolledEmission['emit'] = async (target, item, now = new Date(), weddingTz = null) => {
    if (target !== client || sealed) throw new Error('Emission outside its exact enrolled client/domain phase')
    const snapshot = structuredClone(item), invokedAt = new Date(now)
    await scope.assertIdentity()
    if (!scope.accounts.has(snapshot.userId.toLowerCase())) throw conflict('resource_source_changed', 'Получатель изменился — обновите данные')
    const captured = await captureNotification(client, snapshot, invokedAt, weddingTz)
    if (captured) captures.push(captured)
  }
  const flush = async () => {
    if (flushed) return
    sealed = true
    await checkAuthority()
    // PostgreSQL's actual signed int keys, DISTINCT including hash collisions.
    const keys = (await client.query<{ key: number }>(
      'select distinct hashtext(u) as key from unnest($1::text[]) u order by key',
      [captures.filter(c => c.pushRequested).map(c => c.item.userId)])).rows
    for (const { key } of keys) {
      if (!Number.isInteger(key) || key < -2147483648 || key > 2147483647) throw new Error('Invalid PostgreSQL quota key')
      await client.query('select pg_advisory_xact_lock($1::int,$2::int)', [4_210_005, key])
    }
    await checkAuthority()
    for (const captured of captures) await placeCapturedNotification(client, captured, true)
    flushed = true
  }
  const emissions: EnrolledEmission = {
    emit,
    emitWedding: async (target, weddingId, exceptUserId, item, now = new Date(), withVendors = false, roles = null) => {
      if (target !== client || weddingId !== input.weddingId || sealed) throw new Error('Wedding emission outside prepared source')
      // Same original selector and iteration order; no coalescing distinct calls.
      const { rows } = await client.query<{ user_id: string; tz: string | null }>(
        `select m.user_id, w.tz from wedding_members m join weddings w on w.id = m.wedding_id
          where m.wedding_id = $1 and ($3::text[] is null or m.role = any($3))
          union
         select v.user_id, w.tz from deals d join vendors v on v.id = d.vendor_id join weddings w on w.id = d.wedding_id
          where d.wedding_id = $1 and $2 and d.state in ('booked','paid_deposit','done')`,
        [weddingId, withVendors, roles])
      for (const row of rows) if (row.user_id !== exceptUserId) await emit(client, { ...item, userId: row.user_id }, now, row.tz)
    },
    flush,
    afterLastWrite: check => { if (flushed) throw new Error('Late finalizer registration'); finalChecks.push(check) },
  }
  const finish = async () => {
    if (!flushed) throw new Error('Finalizer precedes enrolled flush')
    await checkAuthority()
    for (const check of finalChecks) await check()
    // JWT clock check is last, after all source/receipt/projection waits.
    if (caller) await assertSeatingToken(request)
  }
  try {
    const result = await action(emissions)
    await flush()
    if (input.afterReceipt) pending.set(client, finish)
    else await finish()
    return result
  } catch (error) { sealed = true; pending.delete(client); throw error }
}
