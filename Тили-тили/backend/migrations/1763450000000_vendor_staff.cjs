exports.up = pgm => {
  pgm.sql(`
    create table vendor_staff_members(
      id uuid primary key,
      vendor_id uuid not null references vendors(id) on delete cascade,
      user_id uuid references users(id) on delete set null,
      state text not null default 'invited' check(state in ('invited','active','declined','revoked')),
      role text not null default 'worker' check(role in ('worker','resource_manager')),
      version bigint not null default 1 check(version>0),
      invite_token_hash text not null unique check(invite_token_hash ~ '^[0-9a-f]{64}$'),
      invite_expires_at timestamptz not null check(isfinite(invite_expires_at)),
      invited_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      accepted_at timestamptz,
      accepted_session_id uuid references sessions(id) on delete set null,
      revoked_at timestamptz,
      unique(vendor_id,id),
      check(state<>'active' or accepted_at is not null),
      check((state='revoked')=(revoked_at is not null)),
      check(state not in ('invited','declined') or accepted_at is null)
    );
    create unique index vendor_staff_current_user on vendor_staff_members(vendor_id,user_id)
      where user_id is not null and state in ('invited','active');
    create index vendor_staff_actual_user on vendor_staff_members(user_id,vendor_id) where state='active';
    alter table deals add constraint staff_deal_vendor_identity unique(wedding_id,id,vendor_id);
    create table vendor_staff_duties(
      id uuid primary key,
      vendor_id uuid not null,
      member_id uuid not null,
      wedding_id uuid not null,
      deal_id uuid not null,
      program_event_id uuid not null,
      assignment_id uuid,
      role text not null check(role in ('performer','setup','delivery','driver','kitchen','rental','backup')),
      label text not null check(length(btrim(label)) between 1 and 200),
      version bigint not null default 1 check(version>0),
      created_by uuid references users(id) on delete set null,
      created_at timestamptz not null default clock_timestamp(),
      revoked_at timestamptz,
      unique(vendor_id,wedding_id,deal_id,id),
      foreign key(vendor_id,member_id) references vendor_staff_members(vendor_id,id) on delete cascade,
      foreign key(wedding_id,deal_id,vendor_id) references deals(wedding_id,id,vendor_id)
        on delete cascade deferrable initially deferred,
      foreign key(wedding_id,program_event_id) references wedding_events(wedding_id,id)
        on delete cascade deferrable initially deferred,
      foreign key(wedding_id,deal_id,assignment_id) references order_assignments(wedding_id,deal_id,id)
        on delete cascade deferrable initially deferred
    );
    create unique index vendor_staff_live_duty on vendor_staff_duties(member_id,deal_id,program_event_id,role)
      where revoked_at is null;
    create index vendor_staff_duty_deal on vendor_staff_duties(deal_id,member_id) where revoked_at is null;
    comment on table vendor_staff_members is 'Current accepted company membership; never financial or program-acknowledgment authority by itself';
    comment on table vendor_staff_duties is 'Operational scope only. Revoked membership/account/duty is rechecked by each consumer; no consent is inferred';
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from vendor_staff_members) or exists(select 1 from vendor_staff_duties) then
      raise exception 'vendor staff history exists; use a preserving forward migration';
    end if;
  end $$;
  drop table vendor_staff_duties;
  alter table deals drop constraint staff_deal_vendor_identity;
  drop table vendor_staff_members;`)
}
