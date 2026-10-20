import type { Queryable } from '../plugins/db.js'
import { isUuid } from '../ids.js'

/** Storage inspection only. Even a current observation grants no booking,
 * release or financial authority. Old writers do not advance this ledger. */
export interface DealDayScopeView {
  revision: string
  versionId: string
  origin: {
    knowledge: 'observed_tracking' | 'legacy_unknown'
    eventId: string | null
    date: string | null
    timeZone: string | null
  }
  current: {
    bindingState: 'unknown' | 'undated' | 'external' | 'active' | 'done_retained' | 'done_undated' | 'released'
    performerKind: 'catalog' | 'external' | 'unknown'
    contextKind: 'implicit_main' | 'explicit_main' | 'explicit_event' | 'unknown'
    slotId: string
    eventId: string | null
    vendorId: string | null
    date: string | null
    timeZone: string | null
    dayId: string | null
  }
  freshness: 'current' | 'stale'
}

interface ScopeRow {
  revision: string
  version_id: string
  origin_knowledge: DealDayScopeView['origin']['knowledge']
  origin_event_id: string | null
  origin_date: string | null
  origin_time_zone: string | null
  binding_state: DealDayScopeView['current']['bindingState']
  performer_kind: DealDayScopeView['current']['performerKind']
  context_kind: DealDayScopeView['current']['contextKind']
  slot_id: string
  event_id: string | null
  vendor_id: string | null
  service_date: string | null
  time_zone: string | null
  day_id: string | null
  matches_current: boolean
}

export async function loadDealDayScope(
  client: Queryable,
  input: { weddingId: string; dealId: string },
): Promise<DealDayScopeView | null> {
  if (!isUuid(input.weddingId) || !isUuid(input.dealId)) return null
  const row = (await client.query<ScopeRow>(`
    select h.revision::text,v.id::text version_id,o.origin_knowledge,
      o.event_id::text origin_event_id,o.service_date::text origin_date,o.time_zone origin_time_zone,
      v.binding_state,v.performer_kind,v.context_kind,v.slot_id::text,v.event_id::text,v.vendor_id::text,
      v.service_date::text,v.time_zone,v.day_id::text,deal_day_scope_matches_current(v) matches_current
    from deal_day_scope_heads h
    join deal_day_scope_versions v on v.wedding_id=h.wedding_id and v.deal_id=h.deal_id
      and v.id=h.current_version_id and v.revision=h.revision
    join deal_day_scope_versions o on o.wedding_id=h.wedding_id and o.deal_id=h.deal_id and o.revision=1
    where h.wedding_id=$1 and h.deal_id=$2`, [input.weddingId, input.dealId])).rows[0]
  if (!row) return null
  const knownOrigin = row.origin_knowledge === 'observed_tracking'
  return {
    revision: row.revision,
    versionId: row.version_id,
    origin: {
      knowledge: row.origin_knowledge,
      eventId: knownOrigin ? row.origin_event_id : null,
      date: knownOrigin ? row.origin_date : null,
      timeZone: knownOrigin ? row.origin_time_zone : null,
    },
    current: {
      bindingState: row.binding_state,
      performerKind: row.performer_kind,
      contextKind: row.context_kind,
      slotId: row.slot_id,
      eventId: row.event_id,
      vendorId: row.vendor_id,
      date: row.service_date,
      timeZone: row.time_zone,
      dayId: row.day_id,
    },
    freshness: row.matches_current ? 'current' : 'stale',
  }
}
