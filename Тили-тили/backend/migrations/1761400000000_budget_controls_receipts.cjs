/**
 * 018-B: user-controlled budget limits/reserve and private payment evidence.
 *
 * Ревью 018 (миграция ещё не выкладывалась — правится на месте):
 * - `uploaded_by` обнуляется при стирании аккаунта (BB-02): без `on delete set null`
 *   `delete from users` в `eraseUser` падал на первом же чеке, если свадьба
 *   оставалась у партнёра, — и вместе с ним уборка удалённых и вход по коду;
 * - у лимита категории есть `currency` с CHECK = 'RUB', как у остальных денежных
 *   таблиц (audit52): сумма без валюты — не деньги.
 * - индексы под квоту свадьбы и под обнуление автора при стирании;
 * - откат на базе с данными — только с `tili.allow_data_loss=yes`, как у 018-A.
 */
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
    currency char(3) not null default 'RUB' constraint budget_category_limits_currency_rub check (currency = 'RUB'),
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
    uploaded_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now()
  );
  create index payment_receipts_payment_idx on payment_receipts(payment_id, created_at, id);
  -- Квота свадьбы считается на каждой загрузке; стирание аккаунта обнуляет автора (ревью 018, BB-01/BB-02).
  create index payment_receipts_wedding_idx on payment_receipts(wedding_id);
  create index payment_receipts_uploaded_by_idx on payment_receipts(uploaded_by) where uploaded_by is not null;
`);
/* Откат стирает лимиты, резерв и сами файлы подтверждений. На базе с данными —
 * только осознанно, как у 018-A: `PGOPTIONS='-c tili.allow_data_loss=yes'`. */
exports.down = pgm => pgm.sql(`
  do $guard$ begin
    if (exists (select 1 from payment_receipts) or exists (select 1 from budget_category_limits)
        or exists (select 1 from wedding_budget_settings))
       and coalesce(current_setting('tili.allow_data_loss', true), '') <> 'yes' then
      raise exception 'Откат 018-B сотрёт лимиты, резерв и подтверждения оплат: задайте tili.allow_data_loss=yes, если это осознанно';
    end if;
  end $guard$;
  drop table if exists payment_receipts;
  drop table if exists budget_category_limits;
  drop table if exists wedding_budget_settings;
`);
