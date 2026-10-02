import type { Queryable } from '../plugins/db.js'
import { forbidden } from '../errors.js'

/**
 * Состояние согласия человека на обработку персональных данных относительно
 * действующей редакции документов (F4, RL-1).
 *
 * - `current` — есть неотозванное согласие под действующей редакцией.
 * - `outdated` — согласие есть, но только под прежней редакцией: редакцию
 *   подняли, а человек её не видел и не подтверждал.
 * - `none` — живого согласия нет вовсе (новый аккаунт, восстановленный после
 *   отзыва, или согласие целиком отозвано).
 */
export type ConsentState = 'current' | 'outdated' | 'none'

/**
 * Единственное место, где код читает `consents` для проверки доступа —
 * сторож `audit54.test.ts#B-T11` следит, чтобы вторая копия не завелась.
 *
 * Один запрос — две пробы одного и того же индекса
 * `consents(user_id, withdrawn_at)` (`migrations/1757100000000_auth_and_geo.cjs:53`):
 * `current` сразу отвечает на вопрос гейта (пускать без второй подписи или
 * нет), `any` отличает «никогда не соглашался» (обычный `forbidden`) от
 * «согласился, но под старой редакцией» (`consent_outdated`) — эти два
 * состояния ведут к разным экранам на фронте.
 */
export async function consentState(
  db: Queryable, userId: string, policyVersion: string, options: { lock?: boolean } = {},
): Promise<ConsentState> {
  if (options.lock) {
    // Transactional access keeps accepted consent stable through later resource waits.
    await db.query('select id from consents where user_id=$1 and withdrawn_at is null order by id for share', [userId])
  }
  const { rows } = await db.query<{ current: boolean; any: boolean }>(
    `select
       exists (select 1 from consents where user_id = $1 and withdrawn_at is null and policy_version = $2) as current,
       exists (select 1 from consents where user_id = $1 and withdrawn_at is null) as any`,
    [userId, policyVersion],
  )
  const row = rows[0]!
  if (row.current) return 'current'
  if (row.any) return 'outdated'
  return 'none'
}

/** Pin the current receipt on the caller's transaction after user/session locks.
 * A pre-handler read alone cannot protect a write that waited for another lock. */
export async function lockCurrentConsent(client: Queryable, userId: string, policyVersion: string): Promise<void> {
  const consent = await client.query('select id from consents where user_id=$1 and policy_version=$2 and withdrawn_at is null for share', [userId, policyVersion])
  if (!consent.rows[0]) throw forbidden('Нужно действующее согласие на обработку персональных данных')
}
