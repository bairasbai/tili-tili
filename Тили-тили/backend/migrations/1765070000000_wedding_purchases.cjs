exports.up = pgm => pgm.sql(`
  create table wedding_purchase_versions (
    wedding_id uuid not null references weddings(id) on delete cascade,
    id uuid not null,
    version integer not null check(version > 0),
    title text not null check(length(btrim(title)) between 1 and 160),
    quantity numeric(12,3) not null check(quantity > 0),
    unit text not null check(length(btrim(unit)) between 1 and 32),
    category_id text not null,
    estimated_amount bigint check(estimated_amount between 0 and 9007199254740991),
    agreed_amount bigint check(agreed_amount between 0 and 9007199254740991),
    seller text check(length(seller) between 1 and 160),
    seller_url text check(length(seller_url) between 1 and 1024),
    due_on date,
    assignee_id uuid,
    event_id uuid,
    linked_deal_id uuid,
    status text not null check(status in ('needed','ordered','received','delivered','done','cancelled','returned')),
    status_changed boolean not null,
    actor_id uuid references users(id) on delete set null,
    recorded_at timestamptz not null default now(),
    primary key(wedding_id,id,version),
    foreign key(wedding_id,assignee_id) references wedding_members(wedding_id,user_id) on delete set null (assignee_id),
    foreign key(wedding_id,event_id) references wedding_events(wedding_id,id) on delete set null (event_id),
    foreign key(wedding_id,linked_deal_id) references deals(wedding_id,id) deferrable initially deferred,
    check(version > 1 or (status='needed' and status_changed))
  );
  create index wedding_purchase_latest on wedding_purchase_versions(wedding_id,id,version desc);
  create index wedding_purchase_assignee on wedding_purchase_versions(wedding_id,assignee_id) where assignee_id is not null;
  create index wedding_purchase_event on wedding_purchase_versions(wedding_id,event_id) where event_id is not null;
  create index wedding_purchase_deal on wedding_purchase_versions(wedding_id,linked_deal_id) where linked_deal_id is not null;
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists (select 1 from wedding_purchase_versions) then
      raise exception using errcode='23514', message='wedding_purchases_rollback_preserves_history';
    end if;
  end $$;
  drop table wedding_purchase_versions;
`)
