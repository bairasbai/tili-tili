/** 018-B: user-controlled budget limits/reserve and private payment evidence. */
exports.up = pgm => pgm.sql(`
  create table wedding_budget_settings (
    wedding_id uuid primary key references weddings(id) on delete cascade,
    reserve_bps integer not null default 1000 check (reserve_bps between 0 and 5000),
    version integer not null default 1 check (version > 0),
    updated_at timestamptz not null default now()
  );
  create table budget_category_limits (
    wedding_id uuid not null references weddings(id) on delete cascade,
    category_id text not null,
    amount bigint not null check (amount >= 0 and amount <= 9007199254740991),
    version integer not null default 1 check (version > 0),
    is_custom boolean not null default true,
    updated_at timestamptz not null default now(),
    primary key (wedding_id, category_id)
  );
  create table payment_receipts (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    payment_id uuid not null references payments(id) on delete cascade,
    filename text not null check (length(filename) between 1 and 180),
    mime_type text not null check (mime_type in ('application/pdf','image/jpeg','image/png','image/webp')),
    size_bytes integer not null check (size_bytes > 0 and size_bytes <= 524288),
    content bytea not null check (octet_length(content) = size_bytes),
    uploaded_by uuid not null references users(id),
    created_at timestamptz not null default now()
  );
  create index payment_receipts_payment_idx on payment_receipts(payment_id, created_at, id);
`);
exports.down = pgm => pgm.sql(`
  drop table if exists payment_receipts;
  drop table if exists budget_category_limits;
  drop table if exists wedding_budget_settings;
`);
