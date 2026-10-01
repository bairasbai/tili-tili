exports.up = (pgm) => {
  pgm.sql(`
    create table notification_push_deliveries (
      notification_id uuid not null references notifications(id) on delete cascade,
      subscription_id uuid not null,
      status text not null default 'queued' check (status in
        ('queued','claimed','retry_wait','provider_accepted','permanent_failure','expired','cancelled')),
      attempts integer not null default 0 check (attempts >= 0 and attempts <= 5),
      next_attempt_at timestamptz not null default now(),
      lease_token uuid,
      lease_until timestamptz,
      provider_accepted_at timestamptz,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      primary key (notification_id, subscription_id),
      constraint notification_push_delivery_lease check (
        (status = 'claimed' and lease_token is not null and lease_until is not null)
        or (status <> 'claimed' and lease_token is null and lease_until is null)
      ),
      constraint notification_push_delivery_acceptance check (
        (status = 'provider_accepted' and provider_accepted_at is not null)
        or (status <> 'provider_accepted' and provider_accepted_at is null)
      )
    );
    create index notification_push_deliveries_due
      on notification_push_deliveries(next_attempt_at)
      where status in ('queued','retry_wait');
    create index notification_push_deliveries_leases
      on notification_push_deliveries(lease_until) where status = 'claimed';
    comment on table notification_push_deliveries is
      'Recoverable per-subscription attempts. Provider acceptance is not device delivery or user acknowledgment.';
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from notification_push_deliveries) then
        raise exception 'Cannot discard notification delivery history; restore from a reviewed backup instead';
      end if;
    end $$;
    drop table notification_push_deliveries;
  `)
}
