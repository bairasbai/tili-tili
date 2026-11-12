import { createHash } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import type { components } from '../contract/api.generated.js'
import { OPEN_BOOKINGS } from '../deals/state.js'
import { conflict, notFound } from '../errors.js'
import type { Queryable } from '../plugins/db.js'
import { taskDueSql } from './checklist-dates.js'

type Preview = components['schemas']['WeddingReschedulePreview']
type Impact = Omit<Preview, 'previewToken'>
type Snapshot = Omit<Impact, 'canConfirm' | 'closingRequests'> & { requestIds: string[] }
export type ReschedulePreviewOrigin = { weddingId: string; userId: string; sessionId: string; date: string }

const AUDIENCE = 'tili-wedding-reschedule-preview'
const TTL_SECONDS = 600
const key = (secret: string) => createHash('sha256').update(AUDIENCE + '\n' + secret).digest()
const digest = (snapshot: Snapshot) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
const actualTime = async (db: Queryable) =>
  (await db.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]!.now

/** The writer and preview use the same DATE conflict rule, including shared own holds. */
export const rescheduleVendorBusySql = `exists (
  select 1 from vendor_busy_dates b
    where b.vendor_id=d.vendor_id and b.date=$2::date
      and (b.deal_id is null or not exists (select 1 from deals own where own.id=b.deal_id and own.wedding_id=$1))
)`

/** One statement gives the preview a consistent snapshot without taking the calendar write prefix. */
async function readSnapshot(db: Queryable, { weddingId, date }: ReschedulePreviewOrigin) {
  const initialDue = taskDueSql('$2::date', 't.period', "t.source='system' and t.kind='checklist'")
  const { rows: [snapshot] } = await db.query<Snapshot>(`
    with wedding as (
      select date,coalesce(tz,'Europe/Moscow') as tz, date is distinct from $2::date as changed
      from weddings where id=$1 and archived_at is null and cancelled_at is null
    ), deadlines as (
      select t.id,t.title,t.due,
        case when w.date is null and t.due is null then ${initialDue}
          when w.date is not null then t.due+($2::date-w.date) else t.due end as next_due
      from wedding w cross join tasks t
      where t.wedding_id=$1 and w.changed and t.due_mode='relative'
    ), timeline as (
      select t.id,t.name,t.starts_at,t.ends_at,
        case when w.date is not null then t.starts_at+make_interval(days=>($2::date-w.date))
          else (($2::date+t.template_day_offset)+t.template_start) at time zone w.tz end as next_start,
        case when w.date is not null then t.ends_at+make_interval(days=>($2::date-w.date))
          else ((($2::date+t.template_day_offset)+t.template_start) at time zone w.tz)
            + make_interval(secs=>t.duration_minutes*60) end as next_end
      from wedding w cross join timeline_events t
      join wedding_events e on e.id=t.program_event_id and e.wedding_id=t.wedding_id and e.is_main
      where t.wedding_id=$1 and w.changed and not t.fixed
        and (w.date is not null or (t.starts_at is null and t.template_start is not null))
    ), bookings as (
      select d.id,coalesce(v.name,d.external_name,s.label) as name,e.id as event_id,
        (s.program_event_id is null or coalesce(e.is_main,false)) as moves,
        case
          when c.deal_id is not null then 'agreement_required'
          when v.id is null then 'unknown'
          when ${rescheduleVendorBusySql} then 'busy'
          when p.mode='resources' or exists (select 1 from resource_allocations a where a.vendor_id=v.id and a.released_at is null)
            then 'agreement_required'
          else 'calendar_clear'
        end as availability
      from wedding w cross join deals d
      join slots s on s.id=d.slot_id and s.wedding_id=d.wedding_id
      left join wedding_events e on e.id=s.program_event_id and e.wedding_id=d.wedding_id
      left join vendors v on v.id=d.vendor_id
      left join vendor_availability_policy p on p.vendor_id=v.id
      left join deal_resource_commitments c on c.deal_id=d.id and c.wedding_id=d.wedding_id and c.state='reserved'
      where d.wedding_id=$1 and d.state=any($3) and w.changed
        and (s.program_event_id is null or e.is_main or c.deal_id is not null)
    )
    select w.date::text as "currentDate",$2::text as "newDate",w.tz as "timeZone",
      coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'before',due,'after',next_due) order by id)
        from deadlines where due is distinct from next_due),'[]'::jsonb) as tasks,
      coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'beforeStart',starts_at,'afterStart',next_start,
        'beforeEnd',ends_at,'afterEnd',next_end) order by id)
        from timeline where row(starts_at,ends_at) is distinct from row(next_start,next_end)),'[]'::jsonb) as timeline,
      coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'before',e.date,
        'after',case when e.is_main then $2::date else e.date end,'main',e.is_main) order by e.is_main desc,e.date nulls last,e.id)
        from wedding_events e where e.wedding_id=$1),'[]'::jsonb) as events,
      coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'eventId',event_id,'moves',moves,
        'availability',availability) order by id) from bookings),'[]'::jsonb) as bookings,
      coalesce((select jsonb_agg(r.id order by r.id) from offer_requests r join slots s on s.id=r.slot_id
        where s.wedding_id=$1 and r.status='open' and w.changed),'[]'::jsonb) as "requestIds"
    from wedding w`, [weddingId, date, OPEN_BOOKINGS])
  if (!snapshot) throw notFound('Свадьба не найдена')
  return snapshot
}

function canConfirm(snapshot: Snapshot) {
  return snapshot.currentDate !== snapshot.newDate &&
    !snapshot.bookings.some(booking => booking.availability === 'busy' || booking.availability === 'agreement_required')
}

export async function issueWeddingReschedulePreview(db: Queryable, origin: ReschedulePreviewOrigin, secret: string): Promise<Preview> {
  const snapshot = await readSnapshot(db, origin)
  const issued = Math.floor((await actualTime(db)).getTime() / 1000)
  const previewToken = await new SignJWT({ ...origin, digest: digest(snapshot) })
    .setProtectedHeader({ alg: 'HS256', typ: AUDIENCE }).setIssuer('tili-tili').setAudience(AUDIENCE)
    .setIssuedAt(issued).setExpirationTime(issued + TTL_SECONDS).sign(key(secret))
  const { requestIds, ...impact } = snapshot
  return { ...impact, previewToken, canConfirm: canConfirm(snapshot), closingRequests: requestIds.length }
}

/** Called after the existing date writer has acquired its wedding and DATE locks. */
export async function assertWeddingReschedulePreview(db: Queryable, origin: ReschedulePreviewOrigin, token: string, secret: string) {
  const changed = () => conflict('reschedule_preview_changed', 'Откройте новый предпросмотр переноса')
  const now = await actualTime(db)
  let expected: unknown
  try {
    const { payload, protectedHeader } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'], issuer: 'tili-tili', audience: AUDIENCE, currentDate: now, requiredClaims: ['iat', 'exp'],
    })
    if (protectedHeader.typ !== AUDIENCE || payload.weddingId !== origin.weddingId || payload.userId !== origin.userId ||
      payload.sessionId !== origin.sessionId || payload.date !== origin.date) throw changed()
    expected = payload.digest
  } catch { throw changed() }
  const snapshot = await readSnapshot(db, origin)
  if (expected !== digest(snapshot)) throw changed()
  if (!canConfirm(snapshot)) throw conflict('reschedule_preview_blocked', 'На выбранную дату есть препятствия для переноса')
}
