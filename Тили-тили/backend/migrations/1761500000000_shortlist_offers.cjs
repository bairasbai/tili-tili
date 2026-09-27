/**
 * 019: кандидаты места, запросы предложений и неизменяемые условия сделки.
 *
 * `vendor_id` в шорт-листе и запросе nullable + SET NULL намеренно: после
 * стирания подрядчика пара должна увидеть обезличенную позицию «анкета
 * недоступна», а не потерять историю выбора. Свободные тексты непринятых
 * предложений перед стиранием удаляет `eraseUser`; принятые условия к этому
 * моменту уже скопированы в снимок сделки.
 *
 * Деньги хранятся в minor units и только в RUB. Позиции 1..3, единственный
 * открытый запрос и единственная действующая версия предложения защищены
 * ограничениями базы, а не предварительными SELECT в обработчиках.
 */
exports.up = pgm => pgm.sql(`
  alter table deals
    add column package_title_snapshot text,
    add column package_includes_snapshot jsonb,
    add constraint deals_package_title_snapshot_valid
      check (package_title_snapshot is null or length(btrim(package_title_snapshot)) between 1 and 200),
    add constraint deals_package_includes_snapshot_array
      check (package_includes_snapshot is null or jsonb_typeof(package_includes_snapshot) = 'array'),
    add constraint deals_package_snapshot_pair
      check ((package_title_snapshot is null) = (package_includes_snapshot is null));

  -- Условия уже существующих сделок фиксируются, пока живая ссылка ещё есть.
  -- Пакеты, потерянные до этой миграции, восстановить достоверно невозможно.
  update deals d
     set package_title_snapshot = p.name,
         package_includes_snapshot = p.items
    from vendor_packages p
   where p.id = d.package_id;

  create table slot_shortlist (
    id uuid primary key,
    slot_id uuid not null references slots(id) on delete cascade,
    vendor_id uuid references vendors(id) on delete set null,
    position smallint not null check (position between 1 and 3),
    added_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    unique (slot_id, position)
  );
  create unique index slot_shortlist_slot_vendor_unique
    on slot_shortlist(slot_id, vendor_id) where vendor_id is not null;
  create index slot_shortlist_vendor_idx
    on slot_shortlist(vendor_id) where vendor_id is not null;
  create index slot_shortlist_added_by_idx
    on slot_shortlist(added_by) where added_by is not null;

  create table offer_requests (
    id uuid primary key,
    slot_id uuid not null references slots(id) on delete cascade,
    vendor_id uuid references vendors(id) on delete set null,
    status text not null default 'open'
      constraint offer_requests_status_known check (status in ('open','closed')),
    close_reason text
      constraint offer_requests_close_reason_known
      check (close_reason is null or close_reason in
        ('removed','booked_other','booked','wedding_cancelled','date_changed','vendor_erased')),
    closed_at timestamptz,
    wedding_date date check (wedding_date is null or wedding_date between '2000-01-01' and '2100-12-31'),
    guests integer check (guests is null or guests between 0 and 5000),
    city text check (city is null or length(btrim(city)) between 1 and 200),
    wishes text check (wishes is null or length(wishes) <= 2000),
    budget_hint bigint check (budget_hint is null or budget_hint between 1 and 9007199254740991),
    currency char(3) not null default 'RUB'
      constraint offer_requests_currency_rub check (currency = 'RUB'),
    created_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint offer_requests_lifecycle_consistent check (
      (status = 'open' and close_reason is null and closed_at is null)
      or (status = 'closed' and close_reason is not null and closed_at is not null)
    ),
    constraint offer_requests_closed_after_created
      check (closed_at is null or closed_at >= created_at)
  );
  create unique index offer_requests_open_slot_vendor_unique
    on offer_requests(slot_id, vendor_id)
    where status = 'open' and vendor_id is not null;
  create index offer_requests_slot_created_idx on offer_requests(slot_id, created_at);
  create index offer_requests_vendor_idx
    on offer_requests(vendor_id) where vendor_id is not null;
  create index offer_requests_created_by_idx
    on offer_requests(created_by) where created_by is not null;

  create table offers (
    id uuid primary key,
    request_id uuid not null references offer_requests(id) on delete cascade,
    kind text not null constraint offers_kind_known check (kind in ('offer','decline')),
    package_id uuid references vendor_packages(id) on delete set null,
    package_snapshot jsonb
      check (package_snapshot is null or jsonb_typeof(package_snapshot) = 'object'),
    title text check (title is null or length(btrim(title)) between 1 and 200),
    price bigint check (price is null or price between 1 and 9007199254740991),
    currency char(3) not null default 'RUB'
      constraint offers_currency_rub check (currency = 'RUB'),
    includes jsonb not null default '[]'::jsonb
      constraint offers_includes_array check (jsonb_typeof(includes) = 'array'),
    message text check (message is null or length(message) <= 2000),
    valid_until date check (valid_until is null or valid_until between '2000-01-01' and '2100-12-31'),
    superseded_at timestamptz,
    accepted_at timestamptz,
    deal_id uuid references deals(id) on delete cascade,
    created_by uuid references users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint offers_kind_fields_consistent check (
      (kind = 'decline' and title is null and price is null and valid_until is null
        and package_id is null and package_snapshot is null and accepted_at is null and deal_id is null)
      or (kind = 'offer' and title is not null and price is not null and valid_until is not null)
    ),
    constraint offers_acceptance_consistent check ((accepted_at is null) = (deal_id is null)),
    constraint offers_accepted_not_superseded check (accepted_at is null or superseded_at is null),
    constraint offers_timestamps_ordered check (
      (superseded_at is null or superseded_at >= created_at)
      and (accepted_at is null or accepted_at >= created_at)
    )
  );
  create unique index offers_request_active_unique
    on offers(request_id) where superseded_at is null;
  create index offers_request_created_idx on offers(request_id, created_at);
  create index offers_package_idx on offers(package_id) where package_id is not null;
  create index offers_deal_idx on offers(deal_id) where deal_id is not null;
  create index offers_created_by_idx on offers(created_by) where created_by is not null;
`);

/* Откат стирает кандидатов, запросы, ответы и снимки условий сделок. Даже если
 * новых таблиц ещё никто не заполнял, backfill мог уже зафиксировать старые
 * пакеты — поэтому снимки тоже входят в guard. */
exports.down = pgm => pgm.sql(`
  do $guard$ begin
    if (exists (select 1 from slot_shortlist)
        or exists (select 1 from offer_requests)
        or exists (select 1 from offers)
        or exists (select 1 from deals
                    where package_title_snapshot is not null
                       or package_includes_snapshot is not null))
       and coalesce(current_setting('tili.allow_data_loss', true), '') <> 'yes' then
      raise exception 'Откат 019 сотрёт кандидатов, предложения и снимки условий: задайте tili.allow_data_loss=yes, если это осознанно';
    end if;
  end $guard$;
  drop table if exists offers;
  drop table if exists offer_requests;
  drop table if exists slot_shortlist;
  alter table deals
    drop constraint if exists deals_package_snapshot_pair,
    drop constraint if exists deals_package_includes_snapshot_array,
    drop constraint if exists deals_package_title_snapshot_valid,
    drop column if exists package_includes_snapshot,
    drop column if exists package_title_snapshot;
`);
