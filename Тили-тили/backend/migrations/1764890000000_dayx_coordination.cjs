exports.up = (pgm) => {
  pgm.sql(`
    create table dayx_vendor_status (
      wedding_id uuid not null,
      deal_id uuid not null,
      scope_key text not null check (scope_key ~ '^[0-9a-f]{64}$'),
      revision uuid not null,
      planned_arrival_at timestamptz,
      arrived_at timestamptz,
      arrived_by uuid references users(id) on delete set null,
      ready_at timestamptz,
      ready_by uuid references users(id) on delete set null,
      primary key (wedding_id, deal_id, scope_key),
      foreign key (wedding_id, deal_id) references deals(wedding_id, id) on delete cascade,
      check (arrived_at is not null or arrived_by is null),
      check (ready_at is not null or ready_by is null)
    );
    create index dayx_vendor_status_arrived_by on dayx_vendor_status(arrived_by) where arrived_by is not null;
    create index dayx_vendor_status_ready_by on dayx_vendor_status(ready_by) where ready_by is not null;
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table dayx_vendor_status in access exclusive mode;
    do $$ begin
      if exists (select 1 from dayx_vendor_status) then
        raise exception 'dayx_coordination_preserving_down_t016';
      end if;
    end $$;
    drop table dayx_vendor_status;
  `)
}
