import { createHash } from 'node:crypto'
import { errors, jwtVerify, SignJWT } from 'jose'
import { AppError, conflict, notFound, validationFailed } from '../errors.js'
import type { Queryable } from '../plugins/db.js'

export const PLAN_B_SCENARIOS = ['rain', 'vendor_missing', 'power', 'transport'] as const
export type PlanBScenario = typeof PLAN_B_SCENARIOS[number]
const AUDIENCE = 'tili-planb-preview'
const TTL_SECONDS = 600

type Origin = { weddingId: string; userId: string; sessionId: string; scenario: PlanBScenario }
interface Impact {
  currentScenario: string | null
  activationVersion: string | null
  timeZone: string | null
  recipients: { userId: string; name: string | null; kind: 'team' | 'vendor' }[]
  guests: { id: string; name: string }[]
}

export async function readPlanBImpact(client: Queryable, weddingId: string, userId: string): Promise<Impact> {
  const { rows } = await client.query<Impact>(`
    with sources as (
      select user_id, true as is_team, null::text as vendor_name
        from wedding_members where wedding_id=$1
      union all
      select v.user_id, false, nullif(btrim(v.name), '')
        from deals d join vendors v on v.id=d.vendor_id
       where d.wedding_id=$1 and d.state in ('booked','paid_deposit','done')
    ), recipients as (
      select s.user_id,
             case when bool_or(s.is_team) then nullif(btrim(u.name), '') else min(s.vendor_name) end as name,
             case when bool_or(s.is_team) then 'team' else 'vendor' end as kind
        from sources s join users u on u.id=s.user_id
       where s.user_id<>$2 and u.deleted_at is null
       group by s.user_id, u.name
    )
    select w.planb_scenario as "currentScenario", extract(epoch from w.planb_at)::text as "activationVersion",
           w.tz as "timeZone",
           coalesce((select json_agg(json_build_object('userId',r.user_id,'name',r.name,'kind',r.kind) order by r.user_id)
                       from recipients r), '[]'::json) as recipients,
           coalesce((select json_agg(json_build_object('id',g.id,'name',g.name) order by g.id)
                       from guests g where g.wedding_id=w.id and g.rsvp='yes'), '[]'::json) as guests
      from weddings w where w.id=$1`, [weddingId, userId])
  if (!rows[0]) throw notFound('Свадьба не найдена')
  return rows[0]
}

const key = (secret: string) => createHash('sha256').update(`${AUDIENCE}\n${secret}`).digest()
const digest = (impact: Impact) => createHash('sha256').update(JSON.stringify(impact)).digest('hex')
const actualTime = async (client: Queryable) =>
  (await client.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now

export async function issuePlanBPreview(client: Queryable, origin: Origin, impact: Impact, secret: string) {
  const issued = Math.floor((await actualTime(client)).getTime() / 1000)
  const expires = issued + TTL_SECONDS
  const previewToken = await new SignJWT({ ...origin, digest: digest(impact) })
    .setProtectedHeader({ alg: 'HS256', typ: AUDIENCE })
    .setIssuer('tili-tili').setAudience(AUDIENCE)
    .setIssuedAt(issued).setExpirationTime(expires).sign(key(secret))
  return {
    previewToken, expiresAt: new Date(expires * 1000).toISOString(), scenario: origin.scenario,
    currentScenario: impact.currentScenario,
    inAppRecipients: impact.recipients.map(({ name, kind }) => ({ name, kind })),
    manualGuests: impact.guests.map(({ name }) => name),
    reserveAddress: null,
  }
}

export async function verifyPlanBPreview(client: Queryable, origin: Origin, token: string | undefined, secret: string) {
  if (!token) throw new AppError(400, 'planb_preview_required', 'Откройте предпросмотр Плана Б')
  const now = await actualTime(client)
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: AUDIENCE, currentDate: now,
      requiredClaims: ['iat', 'exp'],
    })
    if (protectedHeader.typ !== AUDIENCE || payload.weddingId !== origin.weddingId || payload.userId !== origin.userId
      || payload.sessionId !== origin.sessionId || payload.scenario !== origin.scenario
      || typeof payload.digest !== 'string' || typeof payload.exp !== 'number') {
      throw new Error('Preview scope changed')
    }
    return { digest: payload.digest, expiresAt: payload.exp * 1000 }
  } catch (error) {
    if (error instanceof errors.JWTExpired) throw previewExpired()
    throw validationFailed({ previewToken: 'Откройте предпросмотр для этой свадьбы и сессии' })
  }
}

export function assertPlanBImpact(impact: Impact, expected: string) {
  if (digest(impact) !== expected) throw previewChanged()
}

export async function assertPlanBRecipientsCurrent(client: Queryable, origin: Origin, original: Impact, expiresAt: number) {
  const current = await readPlanBImpact(client, origin.weddingId, origin.userId)
  // The current command already changed its own scenario and activation time.
  assertPlanBImpact({ ...current, currentScenario: original.currentScenario, activationVersion: original.activationVersion }, digest(original))
  if ((await actualTime(client)).getTime() >= expiresAt) throw previewExpired()
}

const previewChanged = () => conflict('planb_preview_changed', 'Сценарий или получатели изменились. Откройте новый предпросмотр')
const previewExpired = () => conflict('planb_preview_expired', 'Предпросмотр истёк. Откройте новый')
