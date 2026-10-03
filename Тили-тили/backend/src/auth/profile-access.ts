import type { FastifyRequest } from 'fastify'
import type { Queryable } from '../plugins/db.js'
import { AppError, forbidden, unauthorized } from '../errors.js'
import { consentState } from './consent.js'
import { assertSeatingToken } from '../wedding/access.js'

/** Self-profile mutation: no wedding/company roots may be acquired after this prefix.
 * The registered caller must own the transaction; this helper does not open one. */
export async function lockProfileMutation(client: Queryable, request: FastifyRequest): Promise<void> {
  const caller = request.caller!
  const user = await client.query<{ deleted_at: Date | null }>(
    'select deleted_at from users where id=$1 for update', [caller.userId],
  )
  if (!user.rows[0] || user.rows[0].deleted_at) throw unauthorized('Аккаунт удалён')
  const session = await client.query(
    'select id from sessions where id=$1 and user_id=$2 and revoked_at is null for share',
    [caller.sessionId, caller.userId],
  )
  if (session.rowCount === 0) throw unauthorized('Сессия завершена')
  const state = await consentState(client, caller.userId, request.server.appConfig.policyVersion, { lock: true })
  if (state === 'none') throw forbidden('Нужно согласие на обработку персональных данных')
  if (state === 'outdated') {
    throw new AppError(403, 'consent_outdated', 'Мы обновили документы — подтвердите новую редакцию, чтобы продолжить')
  }
  await assertSeatingToken(request)
}
