import { COMMITTED } from '../deals/state.js'
import { VENDOR_LIVE_JOIN } from '../catalog/vendors.js'
import { notFound } from '../errors.js'
import { loadInstallmentStages } from '../payments/read.js'
import type { Queryable } from '../plugins/db.js'
import type { components } from '../contract/api.generated.js'
import type { Role } from './access.js'

type Week = components['schemas']['WeddingWeek']
type Item = components['schemas']['WeddingWeekItem']
type Range = Week['range']

async function taskItems(db: Queryable, weddingId: string, range: Range): Promise<Item[]> {
  const { rows } = await db.query<{ id: string; title: string; due: string; assignee_id: string | null; name: string | null }>(`
    select t.id,t.title,t.due::text,u.id as assignee_id,u.name
      from tasks t left join wedding_members m on m.wedding_id=t.wedding_id and m.user_id=t.assignee_id
        and m.role in ('couple','helper','coordinator')
      left join users u on u.id=m.user_id and u.deleted_at is null
     where t.wedding_id=$1 and t.kind='checklist' and t.done_at is null and t.excluded_reason is null and t.due between $2 and $3`,
  [weddingId, range.startsOn, range.endsOn])
  return rows.map(row => ({ kind: 'task', id: row.id, title: row.title, due: row.due,
    responsible: row.assignee_id ? 'member' : 'unassigned', responsibleName: row.name,
    href: `/wedding/checklist?task=${row.id}&wedding=${weddingId}` }))
}

async function guestItems(db: Queryable, weddingId: string, range: Range): Promise<Item[]> {
  const { rows } = await db.query<{ id: string; title: string; due: string | null; is_main: boolean; pending: number }>(`
    select e.id,e.name as title,e.rsvp_deadline::text as due,e.is_main,
      (case when e.is_main then (select count(*) from guests g where g.wedding_id=e.wedding_id and g.rsvp='pending')
        else (select count(*) from guest_event_invitations i
          left join event_guest_participation p on p.wedding_id=i.wedding_id and p.program_event_id=i.event_id and p.guest_id=i.guest_id
          where i.wedding_id=e.wedding_id and i.event_id=e.id and coalesce(p.status,'unknown')='unknown') end)::int as pending
      from wedding_events e join weddings w on w.id=e.wedding_id
     where e.wedding_id=$1
       and (e.rsvp_deadline is null or e.rsvp_deadline between $2 and $3)
       and (coalesce(case when e.is_main then w.date else e.date end,'infinity'::date)
         >= (now() at time zone coalesce(case when e.is_main then w.tz else e.time_zone end,w.tz,'Europe/Moscow'))::date)`,
  [weddingId, range.startsOn, range.endsOn])
  return rows.filter(row => row.pending > 0).map(row => ({ kind: 'guest_reply', id: row.id, title: row.title, due: row.due,
    responsible: 'guest', responsibleName: null, pendingCount: row.pending,
    href: row.is_main ? '/wedding/guests' : `/wedding/events/${row.id}/rsvp` }))
}

async function coupleItems(db: Queryable, weddingId: string, range: Range): Promise<Item[]> {
  const stages = await loadInstallmentStages(db, weddingId, range.today, COMMITTED)
  const payments: Item[] = stages.filter(row => row.due >= range.startsOn && row.due <= range.endsOn
    && (row.status === 'pending' || row.status === 'partial')).map(row => ({
    kind: 'payment', id: row.id, title: row.title, due: row.due, responsible: 'couple', responsibleName: null,
    amount: row.unknownAmountPayments > 0 ? null : row.remaining, href: `/wedding/payments?installment=${row.id}`,
  }))
  const { rows: offers } = await db.query<{ id: string; slot_id: string; title: string; name: string }>(`
    select r.id,r.slot_id,s.label as title,v.name
      from offer_requests r join slots s on s.id=r.slot_id
      join slot_shortlist ss on ss.slot_id=r.slot_id and ss.vendor_id=r.vendor_id
      join vendors v on v.id=r.vendor_id ${VENDOR_LIVE_JOIN}
     where s.wedding_id=$1 and r.status='open'
       and not exists(select 1 from offers o where o.request_id=r.id and o.superseded_at is null)`, [weddingId])
  const { rows: terms } = await db.query<{ id: string; deal_id: string; title: string; name: string | null;
    customer_pending: boolean; performer_pending: boolean }>(`
    select o.proposed_terms_id as id,d.id as deal_id,s.label as title,v.name,
      not exists(select 1 from deal_terms_receipts a where a.terms_id=o.proposed_terms_id and a.party='customer') as customer_pending,
      d.vendor_id is not null and not exists(select 1 from deal_terms_receipts a where a.terms_id=o.proposed_terms_id and a.party='performer') as performer_pending
      from deal_orders o join deals d on d.wedding_id=o.wedding_id and d.id=o.deal_id
      join slots s on s.wedding_id=d.wedding_id and s.id=d.slot_id
      left join vendors v on v.id=d.vendor_id
     where o.wedding_id=$1 and o.proposed_terms_id is not null and o.proposed_terms_id is distinct from o.agreed_terms_id
       and d.state not in ('done','cancelled')`, [weddingId])
  return [
    ...payments,
    ...offers.map<Item>(row => ({ kind: 'offer_reply', id: row.id, title: row.title, due: null,
      responsible: 'performer', responsibleName: row.name, href: `/wedding/slot/${row.slot_id}` })),
    ...terms.filter(row => row.customer_pending || row.performer_pending).map<Item>(row => ({
      kind: 'terms', id: row.id, title: row.title, due: null,
      responsible: row.customer_pending && row.performer_pending ? 'both' : row.customer_pending ? 'couple' : 'performer',
      responsibleName: row.customer_pending ? null : row.name, href: `/wedding/week/terms/${row.deal_id}`,
    })),
  ]
}

export async function loadWeddingWeek(db: Queryable, weddingId: string, role: Role): Promise<Week> {
  const { rows } = await db.query<Range & { cancelled: boolean }>(`
    select (date_trunc('week',local.today))::date::text as "startsOn",
      (date_trunc('week',local.today)::date+6)::text as "endsOn",
      local.today::date::text as today,coalesce(w.tz,'Europe/Moscow') as "timeZone",w.cancelled_at is not null as cancelled
      from weddings w cross join lateral (select now() at time zone coalesce(w.tz,'Europe/Moscow') as today) local
     where w.id=$1`, [weddingId])
  const row = rows[0]
  if (!row) throw notFound('Свадьба не найдена')
  const { cancelled, ...range } = row
  if (cancelled) return { range, readOnly: true, items: [] }
  const tasks = await taskItems(db, weddingId, range)
  const guests = await guestItems(db, weddingId, range)
  const privateItems = role === 'couple' ? await coupleItems(db, weddingId, range) : []
  const items = [...tasks, ...guests, ...privateItems].sort((a, b) =>
    (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  return { range, readOnly: false, items }
}
