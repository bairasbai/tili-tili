// Both projections use the same aliases and pass the worker's max age as $2.
export const NOTICE_PUSH_STATE_SQL = `case
  when delivery.provider_accepted_at is not null then 'provider_accepted'
  when n.push_disposition = 'inbox_only' then 'inbox_only'
  when n.push_disposition = 'planned' and n.pushed_at is null
    and n.deliver_after > now() - $2::double precision * interval '1 millisecond'
    and (n.expires_at is null or n.expires_at > now())
    and (delivery.attempt_count = 0 or delivery.pending) then 'queued'
  else 'unconfirmed'
end`

export const NOTICE_PUSH_DELIVERY_JOIN_SQL = `cross join lateral (
  select min(d.provider_accepted_at) as provider_accepted_at, count(*) as attempt_count,
         bool_or(d.status in ('queued','claimed','retry_wait')) as pending
    from notification_push_deliveries d where d.notification_id = n.id
) delivery`
