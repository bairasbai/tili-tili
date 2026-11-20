exports.up = (pgm) => pgm.sql(`
  create table service_plans (
    code text primary key check (code in ('wedding', 'vendor_month'))
  );
  insert into service_plans(code) values ('wedding'), ('vendor_month');

  create table service_plan_prices (
    id uuid not null default gen_random_uuid(),
    plan_code text not null references service_plans(code),
    revision integer not null check (revision > 0),
    amount integer not null check (amount > 0 and amount % 100 = 0),
    effective_at timestamptz not null,
    published_at timestamptz not null,
    published_by uuid references users(id) on delete set null,
    replaces_id uuid,
    primary key (plan_code, id),
    unique (id),
    unique (plan_code, revision),
    unique (plan_code, id, amount),
    unique (plan_code, replaces_id),
    foreign key (plan_code, replaces_id) references service_plan_prices(plan_code, id),
    check (replaces_id is null or replaces_id <> id),
    check (effective_at >= published_at)
  );
  create index service_plan_prices_effective on service_plan_prices
    (plan_code, effective_at desc, revision desc);

  create table service_plan_orders (
    id uuid primary key default gen_random_uuid(),
    plan_code text not null,
    target_id uuid not null,
    customer_id uuid references users(id) on delete set null,
    price_id uuid not null,
    amount integer not null check (amount > 0 and amount % 100 = 0),
    terms_version integer not null check (terms_version > 0),
    terms_text text not null check (length(btrim(terms_text)) between 1 and 20000),
    created_at timestamptz not null default statement_timestamp(),
    quote_expires_at timestamptz not null,
    provider text not null check (length(provider) between 1 and 40),
    provider_requested_at timestamptz,
    provider_id text,
    state text not null default 'pending' check (state in ('pending', 'paid', 'canceled', 'refunded')),
    refunded_amount integer not null default 0 check (refunded_amount between 0 and amount),
    paid_at timestamptz,
    access_from timestamptz,
    access_until timestamptz,
    unique (provider, provider_id),
    foreign key (plan_code, price_id, amount) references service_plan_prices(plan_code, id, amount),
    check (quote_expires_at > created_at),
    check (provider_requested_at is null or provider_requested_at < quote_expires_at),
    check (provider_id is null or provider_requested_at is not null),
    check (state in ('pending', 'canceled') or provider_id is not null),
    check (state in ('paid', 'refunded') or refunded_amount = 0),
    check ((state = 'refunded') = (refunded_amount = amount)),
    check ((state in ('paid', 'refunded')) = (paid_at is not null)),
    check (
      (state <> 'paid' and access_from is null and access_until is null)
      or (state in ('paid', 'refunded') and access_from is not null and
        ((plan_code = 'wedding' and access_until is null)
          or (plan_code = 'vendor_month' and access_until is not null and access_until > access_from)))
    )
  );
  create unique index service_plan_one_pending on service_plan_orders (plan_code, target_id)
    where state = 'pending';
  create unique index service_plan_one_paid_wedding on service_plan_orders (target_id)
    where state = 'paid' and plan_code = 'wedding';
  create index service_plan_orders_access on service_plan_orders (plan_code, target_id, access_until)
    where state = 'paid';
`)

exports.down = (pgm) => pgm.sql(`
  lock table service_plans, service_plan_prices, service_plan_orders in access exclusive mode;
  do $$ begin
    if exists (select 1 from service_plan_prices) then
      raise exception using errcode = '23514', constraint = 'service_plan_prices_preserve',
        message = 'Published service plan prices must be preserved';
    end if;
  end $$;
  drop table service_plan_orders;
  drop table service_plan_prices;
  drop table service_plans;
`)
