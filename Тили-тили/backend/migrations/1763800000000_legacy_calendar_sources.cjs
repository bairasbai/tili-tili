/**
 * 030/370: технический инвентарь прежнего календаря (DATE-строки и корни без
 * ресурсной книги) — обнаружение и свежесть, без HTTP/OpenAPI/UI (D2).
 *
 * Обнаружение — триггерами БД на vendor_busy_dates/deals (D3), не правками
 * TS-писателей. Свежесть не хранится, а вычисляется из текущего материала
 * (D4); материал строит один SQL-построитель (D5). История: app_day/app_root/
 * live_negotiation — свадьбы (FK CASCADE); manual_day/orphan_day — компании
 * (FK CASCADE). vendor_id источника — идентичность без FK, как vendor_id в
 * истории брони 365 (D6). Строка дня: id/created_at/vendor_id/date/source
 * неизменны — писатели их не правят (D7, grep подтверждён). Миграция делает
 * платформенный захват (rev1, migration_backfill) всех найденных источников
 * (D8).
 *
 * Лок-безопасность обнаружения (риск §1 независимого ревью): каждый путь
 * обнаружения берёт НЕ БОЛЬШЕ, чем KEY SHARE на уже удерживаемую писателем
 * свадьбу/компанию.
 *  - app_day/app_root/live_negotiation: FK sources.wedding_id -> weddings
 *    берёт KEY SHARE на строку свадьбы при INSERT. Эта строка уже
 *    заблокирована писателем (FOR SHARE в book.ts/PATCH/reschedule, FOR
 *    UPDATE в lockOrderContext/reserve()) СИЛЬНЕЕ, чем KEY SHARE — тот же
 *    самозамок, без ожидания и инверсии.
 *  - manual_day: FK sources.company_id -> vendors берёт KEY SHARE на строку
 *    компании; ручной день (`POST /vendor/calendar/busy`) уже держит
 *    vendors FOR UPDATE (lockResourceScope) той же транзакцией.
 *  - orphan_day (самый чувствительный путь): deal удаляется только каскадом
 *    свадьбы/пользователя; `prepareWeddingResourceErasure`/
 *    `prepareUserResourceErasure` (resources/erasure.ts) уже лочат weddings
 *    FOR UPDATE, deals FOR UPDATE и — через lockSourceUnion — ВСЕ vendor_id
 *    затронутых сделок (включая легаси-дни без ресурсной книги) FOR UPDATE
 *    ДО фактического DELETE. Поэтому к моменту каскада
 *    (deals DELETE -> vendor_busy_dates.deal_id SET NULL -> наш AFTER UPDATE
 *    -> INSERT orphan_day с company_id FK) вендор уже FOR UPDATE в этой же
 *    транзакции; KEY SHARE на свою же строку — самозамок, не ожидание.
 *    Вся экосистема писателей (lockVendorProfileWrite, lockResourceScope,
 *    lockSources/commitments.ts) лочит в порядке «свадьба/заявки/сделки
 *    раньше компании», то же самое соблюдает erasure.ts — порядка инверсии с
 *    обнаружением нет ни в одном известном писателе.
 *  - Прочитано (не трогаем): deals/repo.ts (hold L191/release L242-270),
 *    resources/commitments.ts (legacyBoundary L135, lockSources),
 *    orders/context.ts (lockOrderPrincipal), vendor/profile-locks.ts,
 *    resources/model.ts (lockResourceScope), resources/booking-boundary.ts,
 *    resources/erasure.ts, wedding/reschedule.ts, routes/vendor.ts.
 *
 * D7 grep (писатели vendor_busy_dates — repo.ts, jobs/index.ts, routes/
 * vendor.ts, wedding/reschedule.ts): единственный UPDATE трогает только
 * deal_id (repo.ts releaseVendorDate, reschedule.ts); INSERT/DELETE никогда
 * не правят id/created_at/vendor_id/date/source постфактум — подтверждено,
 * инвариант не нарушается этой миграцией.
 */
exports.up = (pgm) => {
  pgm.sql(`
    -- === 1. vendor_busy_dates: стабильная идентичность и ревизия указателя (Модель.1) ===
    alter table vendor_busy_dates
      add column id uuid not null default gen_random_uuid(),
      add column source_revision bigint not null default 1 check(source_revision>0);
    alter table vendor_busy_dates add constraint vendor_busy_dates_identity unique(id);
    create index vendor_busy_dates_deal_link on vendor_busy_dates(deal_id) where deal_id is not null;

    -- === 2. legacy_calendar_sources (Модель.2) ===
    create table legacy_calendar_sources(
      id uuid primary key default gen_random_uuid(),
      kind text not null check(kind in ('app_day','app_root','manual_day','orphan_day','live_negotiation')),
      vendor_id uuid not null,
      wedding_id uuid references weddings(id) on delete cascade,
      company_id uuid references vendors(id) on delete cascade,
      day_id uuid,
      root_deal_id uuid,
      origin jsonb not null check(jsonb_typeof(origin)='object'),
      discovered_by text not null check(discovered_by in ('migration','writer')),
      discovered_at timestamptz not null default clock_timestamp(),
      check((kind in ('app_day','manual_day','orphan_day') and day_id is not null and root_deal_id is null) or
            (kind in ('app_root','live_negotiation') and root_deal_id is not null and day_id is null)),
      check((kind in ('app_day','app_root','live_negotiation') and wedding_id is not null and company_id is null) or
            (kind in ('manual_day','orphan_day') and company_id is not null and company_id=vendor_id and wedding_id is null)),
      unique(day_id,kind),
      unique(root_deal_id,kind)
    );
    create index legacy_calendar_sources_vendor on legacy_calendar_sources(vendor_id);
    create index legacy_calendar_sources_wedding on legacy_calendar_sources(wedding_id) where wedding_id is not null;
    create index legacy_calendar_sources_company on legacy_calendar_sources(company_id) where company_id is not null;

    -- === 3. legacy_calendar_versions (Модель.3) ===
    create table legacy_calendar_versions(
      id uuid primary key default gen_random_uuid(),
      source_id uuid not null references legacy_calendar_sources(id) on delete cascade,
      revision bigint not null check(revision>0),
      previous_version_id uuid,
      canonical text not null,
      digest text not null check(digest ~ '^[0-9a-f]{64}$'),
      capture_kind text not null check(capture_kind in ('migration_backfill','owner_capture')),
      captured_by uuid references users(id) on delete set null,
      captured_at timestamptz not null default clock_timestamp(),
      unique(source_id,revision),
      unique(source_id,id),
      foreign key(source_id,previous_version_id) references legacy_calendar_versions(source_id,id) deferrable initially deferred,
      check((revision=1)=(previous_version_id is null)),
      check(canonical::jsonb::text=canonical),
      check(digest=encode(pg_catalog.sha256(convert_to(canonical,'UTF8')),'hex')),
      check(capture_kind<>'migration_backfill' or captured_by is null)
    );

    -- === 4. legacy_calendar_version_holders (Модель.4) ===
    create table legacy_calendar_version_holders(
      source_id uuid not null,
      version_id uuid not null,
      wedding_id uuid not null,
      deal_id uuid not null,
      snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
      fingerprint text not null check(fingerprint ~ '^[0-9a-f]{64}$'),
      primary key(version_id,wedding_id,deal_id),
      foreign key(source_id,version_id) references legacy_calendar_versions(source_id,id) on delete cascade,
      check(fingerprint=encode(pg_catalog.sha256(convert_to(snapshot::text,'UTF8')),'hex'))
    );

    -- === 5. legacy_calendar_heads (Модель.5; нет колонки currency — audit52 считает ровно 17 денежных таблиц) ===
    create table legacy_calendar_heads(
      source_id uuid primary key references legacy_calendar_sources(id) on delete cascade,
      revision bigint not null default 0 check(revision>=0),
      current_version_id uuid,
      check((revision=0)=(current_version_id is null)),
      foreign key(source_id,current_version_id) references legacy_calendar_versions(source_id,id) deferrable initially deferred
    );

    -- === построители (Материал, D5) ===
    create function legacy_calendar_origin(kind text, day_id uuid, root_deal_id uuid) returns jsonb language sql stable as $$
      select case
        when kind in ('app_day','manual_day','orphan_day') then
          (select jsonb_build_object('date',to_char(b.date,'YYYY-MM-DD')) from vendor_busy_dates b where b.id=day_id)
        when kind in ('app_root','live_negotiation') then '{}'::jsonb
        else null
      end
    $$;

    create function legacy_calendar_holder(p_wedding_id uuid, p_deal_id uuid) returns jsonb language sql stable as $$
      select jsonb_build_object(
        'weddingId',lower(d.wedding_id::text),'dealId',lower(d.id::text),
        'vendorId',case when d.vendor_id is null then null else lower(d.vendor_id::text) end,
        'state',d.state,
        'createdAt',to_char(d.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'bookedAt',case when d.booked_at is null then null else to_char(d.booked_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'doneAt',case when d.done_at is null then null else to_char(d.done_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
        'weddingDate',case when w.date is null then null else to_char(w.date,'YYYY-MM-DD') end,
        'slot',jsonb_build_object('id',lower(sl.id::text),'categoryId',sl.category_id,
          'programEventId',case when sl.program_event_id is null then null else lower(sl.program_event_id::text) end,
          'selected',sl.deal_id=d.id),
        'order',(select jsonb_build_object('version',o.version::text,'resourcePlanRevision',o.resource_plan_revision::text,
            'resourcePlanId',case when o.resource_plan_id is null then null else lower(o.resource_plan_id::text) end)
          from deal_orders o where o.wedding_id=d.wedding_id and o.deal_id=d.id),
        'economics',jsonb_build_object('price',case when d.price is null then null else d.price::text end,
          'currency',d.currency,'packageId',case when d.package_id is null then null else lower(d.package_id::text) end),
        'commitmentRevision',coalesce((select c.revision::text from deal_resource_commitments c where c.deal_id=d.id),'0'),
        'ownDays',coalesce((select jsonb_agg(jsonb_build_object('id',lower(o.id::text),'vendorId',lower(o.vendor_id::text),
            'date',to_char(o.date,'YYYY-MM-DD'),'source',o.source,
            'dealId',case when o.deal_id is null then null else lower(o.deal_id::text) end,
            'createdAt',to_char(o.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'sourceRevision',o.source_revision::text) order by o.date,o.id)
          from vendor_busy_dates o where o.deal_id=d.id and o.source='deal'),'[]'::jsonb)
      )
      from deals d join weddings w on w.id=d.wedding_id join slots sl on sl.id=d.slot_id
      where d.wedding_id=p_wedding_id and d.id=p_deal_id
    $$;

    create function legacy_calendar_inventory_material(source legacy_calendar_sources) returns jsonb language plpgsql stable as $$
    declare
      day_row vendor_busy_dates%rowtype;
      pointer jsonb;
      root_deal deals%rowtype;
      wedding_row weddings%rowtype;
      completeness text; reason text; holders jsonb; root jsonb; negotiation jsonb; root_found boolean;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        select * into day_row from vendor_busy_dates where id=source.day_id;
        if not found then
          return jsonb_build_object('encoding','legacy-calendar-inventory/1','sourceId',lower(source.id::text),
            'kind',source.kind,'vendorId',lower(source.vendor_id::text),'completeness','unknown','reason','source_changed',
            'holders','[]'::jsonb,'day',null,'pointer',null);
        end if;
        pointer := case when day_row.deal_id is null then null else
          (select jsonb_build_object('dealId',lower(dd.id::text),'weddingId',lower(dd.wedding_id::text),
              'vendorId',case when dd.vendor_id is null then null else lower(dd.vendor_id::text) end,'state',dd.state)
            from deals dd where dd.id=day_row.deal_id) end;
        if source.kind='manual_day' then
          completeness:='complete'; reason:=null; holders:='[]'::jsonb;
        elsif source.kind='orphan_day' then
          completeness:='unknown'; reason:='orphan'; holders:='[]'::jsonb;
        elsif day_row.deal_id is null then
          completeness:='unknown'; reason:='orphan'; holders:='[]'::jsonb;
        elsif pointer is null or (pointer->>'vendorId') is distinct from lower(source.vendor_id::text)
          or (pointer->>'state') not in ('booked','paid_deposit','done')
          or (pointer->>'weddingId') is distinct from lower(source.wedding_id::text) then
          completeness:='unknown'; reason:='mixed_scope'; holders:='[]'::jsonb;
        else
          completeness:='complete'; reason:=null;
          select coalesce(jsonb_agg(legacy_calendar_holder(dd.wedding_id,dd.id) order by dd.wedding_id,dd.id),'[]'::jsonb) into holders
            from deals dd
           where dd.wedding_id=source.wedding_id and dd.vendor_id=source.vendor_id
             and dd.state in ('booked','paid_deposit','done')
             and (dd.id=day_row.deal_id or dd.state<>'done' or
               not exists(select 1 from vendor_busy_dates o where o.deal_id=dd.id and o.source='deal'));
        end if;
        return jsonb_build_object('encoding','legacy-calendar-inventory/1','sourceId',lower(source.id::text),
          'kind',source.kind,'vendorId',lower(source.vendor_id::text),'completeness',completeness,'reason',reason,
          'holders',holders,
          'day',jsonb_build_object('id',lower(day_row.id::text),'vendorId',lower(day_row.vendor_id::text),
            'date',to_char(day_row.date,'YYYY-MM-DD'),'source',day_row.source,
            'dealId',case when day_row.deal_id is null then null else lower(day_row.deal_id::text) end,
            'createdAt',to_char(day_row.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'sourceRevision',day_row.source_revision::text),
          'pointer',pointer);
      else
        select * into root_deal from deals where id=source.root_deal_id;
        root_found := found and root_deal.vendor_id is not distinct from source.vendor_id
          and root_deal.wedding_id is not distinct from source.wedding_id
          and ((source.kind='app_root' and root_deal.state in ('booked','paid_deposit','done')
              and coalesce((select c.revision from deal_resource_commitments c where c.deal_id=root_deal.id),0)=0)
            or (source.kind='live_negotiation' and root_deal.state='negotiating'));
        if root_found then root := legacy_calendar_holder(root_deal.wedding_id,root_deal.id); else root := null; end if;
        completeness := case when root is null then 'unknown' else 'complete' end;
        reason := case when root is null then 'source_changed' else null end;
        holders := case when root is null then '[]'::jsonb else jsonb_build_array(root) end;
        if source.kind='live_negotiation' then
          select * into wedding_row from weddings where id=source.wedding_id;
          negotiation := jsonb_build_object(
            'negotiatingUntil',case when root_found and root_deal.negotiating_until is not null
              then to_char(root_deal.negotiating_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') else null end,
            'weddingArchived',found and wedding_row.archived_at is not null,
            'weddingCancelled',found and wedding_row.cancelled_at is not null);
          return jsonb_build_object('encoding','legacy-calendar-inventory/1','sourceId',lower(source.id::text),
            'kind',source.kind,'vendorId',lower(source.vendor_id::text),'completeness',completeness,'reason',reason,
            'holders',holders,'root',root,'negotiation',negotiation);
        end if;
        return jsonb_build_object('encoding','legacy-calendar-inventory/1','sourceId',lower(source.id::text),
          'kind',source.kind,'vendorId',lower(source.vendor_id::text),'completeness',completeness,'reason',reason,
          'holders',holders,'root',root);
      end if;
    end $$;

    create function legacy_calendar_present(source legacy_calendar_sources) returns boolean language plpgsql stable as $$
    declare mat jsonb; wedding_row weddings%rowtype;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        return exists(select 1 from vendor_busy_dates where id=source.day_id);
      end if;
      mat := legacy_calendar_inventory_material(source);
      if (mat->>'completeness')<>'complete' then return false; end if;
      if source.kind<>'live_negotiation' then return true; end if;
      if (mat->'negotiation'->>'negotiatingUntil') is null then return false; end if;
      if (mat->'negotiation'->>'negotiatingUntil')::timestamptz<=clock_timestamp() then return false; end if;
      if (mat->'negotiation'->>'weddingArchived')::boolean or (mat->'negotiation'->>'weddingCancelled')::boolean then return false; end if;
      return true;
    end $$;

    -- Один путь для наката и захвата (D5 append).
    create function legacy_calendar_append_version(p_source_id uuid, p_captured_by uuid, p_capture_kind text,
        out version_id uuid, out revision text, out created boolean) language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype; canon text; current_canon text; elem jsonb;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then raise exception 'legacy calendar source not found' using errcode='23503'; end if;
      select * into h from legacy_calendar_heads where source_id=p_source_id for update;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      canon := legacy_calendar_inventory_material(src)::text;
      if h.current_version_id is not null then
        select canonical into current_canon from legacy_calendar_versions where id=h.current_version_id;
        if current_canon=canon then
          version_id := h.current_version_id; revision := h.revision::text; created := false; return;
        end if;
      end if;
      version_id := gen_random_uuid(); revision := (h.revision+1)::text;
      insert into legacy_calendar_versions(id,source_id,revision,previous_version_id,canonical,digest,capture_kind,captured_by)
        values(version_id,p_source_id,h.revision+1,h.current_version_id,canon,
          encode(pg_catalog.sha256(convert_to(canon,'UTF8')),'hex'),p_capture_kind,p_captured_by);
      for elem in select * from jsonb_array_elements(canon::jsonb->'holders') loop
        insert into legacy_calendar_version_holders(source_id,version_id,wedding_id,deal_id,snapshot,fingerprint)
          values(p_source_id,version_id,(elem->>'weddingId')::uuid,(elem->>'dealId')::uuid,elem,
            encode(pg_catalog.sha256(convert_to(elem::text,'UTF8')),'hex'));
      end loop;
      update legacy_calendar_heads set revision=h.revision+1,current_version_id=version_id where source_id=p_source_id;
      created := true;
    end $$;

    -- === 6. Стражи (Модель.6) ===
    create function protect_legacy_calendar_source() returns trigger language plpgsql as $$
    declare day_row vendor_busy_dates%rowtype; root_deal deals%rowtype; ok boolean;
    begin
      if TG_OP='DELETE' then
        if (OLD.wedding_id is not null and exists(select 1 from weddings where id=OLD.wedding_id)) or
          (OLD.company_id is not null and exists(select 1 from vendors where id=OLD.company_id)) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        raise exception 'legacy calendar source is immutable' using errcode='23514';
      end if;
      if NEW.kind in ('app_day','manual_day','orphan_day') then
        select * into day_row from vendor_busy_dates where id=NEW.day_id;
        ok := found and day_row.vendor_id=NEW.vendor_id and (
          (NEW.kind='manual_day' and day_row.source='manual') or
          (NEW.kind='orphan_day' and day_row.source='deal' and day_row.deal_id is null) or
          (NEW.kind='app_day' and day_row.source='deal' and day_row.deal_id is not null and
            exists(select 1 from deals d where d.id=day_row.deal_id and d.wedding_id=NEW.wedding_id)));
      else
        select * into root_deal from deals where id=NEW.root_deal_id;
        ok := found and root_deal.vendor_id=NEW.vendor_id and root_deal.wedding_id=NEW.wedding_id and (
          (NEW.kind='app_root' and root_deal.state in ('booked','paid_deposit','done') and
            not exists(select 1 from deal_resource_commitments c where c.deal_id=root_deal.id and c.revision>0)) or
          (NEW.kind='live_negotiation' and root_deal.state='negotiating'));
      end if;
      if not ok or NEW.origin is distinct from legacy_calendar_origin(NEW.kind,NEW.day_id,NEW.root_deal_id) then
        raise exception 'legacy calendar source must match its actual operational origin' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_calendar_source before insert or update or delete on legacy_calendar_sources
      for each row execute function protect_legacy_calendar_source();

    create function protect_legacy_calendar_version() returns trigger language plpgsql as $$
    declare src legacy_calendar_sources%rowtype; h legacy_calendar_heads%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from legacy_calendar_sources where id=OLD.source_id) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'captured_by')<>(to_jsonb(OLD)-'captured_by') or
          (NEW.captured_by is distinct from OLD.captured_by and not
            (OLD.captured_by is not null and NEW.captured_by is null and not exists(select 1 from users where id=OLD.captured_by))) then
          raise exception 'inventory evidence is immutable' using errcode='23514';
        end if;
        return NEW;
      end if;
      select * into src from legacy_calendar_sources where id=NEW.source_id;
      select * into h from legacy_calendar_heads where source_id=NEW.source_id for update;
      if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'inventory version requires next exact head revision' using errcode='23514';
      end if;
      if NEW.canonical<>legacy_calendar_inventory_material(src)::text then
        raise exception 'inventory version must equal current material' using errcode='23514';
      end if;
      if NEW.capture_kind='migration_backfill' then
        if NEW.revision<>1 or src.discovered_by<>'migration' or NEW.captured_by is not null then
          raise exception 'inventory version must equal current material' using errcode='23514';
        end if;
      else
        if not exists(select 1 from vendors v where v.id=src.vendor_id and v.user_id=NEW.captured_by) then
          raise exception 'inventory capture author must be the current company owner' using errcode='23514';
        end if;
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_calendar_version before insert or update or delete on legacy_calendar_versions
      for each row execute function protect_legacy_calendar_version();

    create function protect_legacy_calendar_holder() returns trigger language plpgsql as $$
    declare v legacy_calendar_versions%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from legacy_calendar_sources where id=OLD.source_id) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        raise exception 'inventory evidence is immutable' using errcode='23514';
      end if;
      select * into v from legacy_calendar_versions where source_id=NEW.source_id and id=NEW.version_id;
      if not found or not exists(
        select 1 from jsonb_array_elements(v.canonical::jsonb->'holders') elem
          where (elem->>'weddingId')::uuid=NEW.wedding_id and (elem->>'dealId')::uuid=NEW.deal_id and elem=NEW.snapshot
      ) then
        raise exception 'inventory holder must match captured material' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_calendar_holder before insert or update or delete on legacy_calendar_version_holders
      for each row execute function protect_legacy_calendar_holder();

    create function protect_legacy_calendar_head() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from legacy_calendar_sources where id=OLD.source_id) then
          raise exception 'legacy calendar history can only be erased with its wedding or company' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_OP='INSERT' then
        if NEW.revision<>0 or NEW.current_version_id is not null then
          raise exception 'inventory head must advance by one exact revision' using errcode='23514';
        end if;
        return NEW;
      end if;
      if NEW.source_id<>OLD.source_id then
        raise exception 'inventory head must advance by one exact revision' using errcode='23514';
      end if;
      if NEW.revision=OLD.revision then
        if NEW.current_version_id is distinct from OLD.current_version_id then
          raise exception 'inventory head must advance by one exact revision' using errcode='23514';
        end if;
        return NEW;
      end if;
      if NEW.revision<>OLD.revision+1 or not exists(
        select 1 from legacy_calendar_versions v where v.source_id=NEW.source_id and v.id=NEW.current_version_id
          and v.revision=NEW.revision and v.previous_version_id is not distinct from OLD.current_version_id) then
        raise exception 'inventory head must advance by one exact revision' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create trigger protect_legacy_calendar_head before insert or update or delete on legacy_calendar_heads
      for each row execute function protect_legacy_calendar_head();

    -- Shared across four differently-shaped tables: a bare NEW.field (even in
    -- an untaken branch of a SQL CASE) is statically type-checked against the
    -- row type bound for THIS firing, so it must never name a column that is
    -- absent on any of the four — to_jsonb(NEW) sidesteps that entirely.
    create function check_legacy_calendar_inventory() returns trigger language plpgsql as $$
    declare target uuid; h legacy_calendar_heads%rowtype; expected int; row_json jsonb;
    begin
      row_json := to_jsonb(NEW);
      target := case when TG_TABLE_NAME='legacy_calendar_sources' then (row_json->>'id')::uuid else (row_json->>'source_id')::uuid end;
      if not exists(select 1 from legacy_calendar_sources where id=target) then return null; end if;
      select * into h from legacy_calendar_heads where source_id=target;
      if not found then raise exception 'legacy calendar source requires a head' using errcode='23514'; end if;
      if h.revision=0 then return null; end if;
      if TG_TABLE_NAME='legacy_calendar_versions' and not exists(
        with recursive ancestry as (
          select id,previous_version_id from legacy_calendar_versions where source_id=target and id=h.current_version_id
          union all
          select p.id,p.previous_version_id from legacy_calendar_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=(row_json->>'id')::uuid
      ) then
        raise exception 'orphan inventory version' using errcode='23514';
      end if;
      select jsonb_array_length(v.canonical::jsonb->'holders') into expected from legacy_calendar_versions v where v.id=h.current_version_id;
      if (select count(*) from legacy_calendar_version_holders where version_id=h.current_version_id)<>expected then
        raise exception 'inventory version holders incomplete' using errcode='23514';
      end if;
      return null;
    end $$;
    create constraint trigger check_legacy_calendar_inventory_sources after insert on legacy_calendar_sources
      deferrable initially deferred for each row execute function check_legacy_calendar_inventory();
    create constraint trigger check_legacy_calendar_inventory_versions after insert on legacy_calendar_versions
      deferrable initially deferred for each row execute function check_legacy_calendar_inventory();
    create constraint trigger check_legacy_calendar_inventory_holders after insert on legacy_calendar_version_holders
      deferrable initially deferred for each row execute function check_legacy_calendar_inventory();
    create constraint trigger check_legacy_calendar_inventory_heads after insert or update on legacy_calendar_heads
      deferrable initially deferred for each row execute function check_legacy_calendar_inventory();

    create function protect_vendor_busy_date_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='INSERT' then
        if NEW.source_revision<>1 then
          raise exception 'source revision is maintained by the database' using errcode='23514';
        end if;
        if exists(select 1 from legacy_calendar_sources where day_id=NEW.id) then
          raise exception 'operational day identity cannot be reused' using errcode='23514';
        end if;
        return NEW;
      end if;
      if NEW.id<>OLD.id or NEW.created_at<>OLD.created_at or NEW.vendor_id<>OLD.vendor_id or NEW.date<>OLD.date or NEW.source<>OLD.source then
        raise exception 'operational day identity is immutable' using errcode='23514';
      end if;
      NEW.source_revision := OLD.source_revision + (case when NEW.deal_id is distinct from OLD.deal_id then 1 else 0 end);
      return NEW;
    end $$;
    create trigger protect_vendor_busy_date_identity before insert or update on vendor_busy_dates
      for each row execute function protect_vendor_busy_date_identity();

    -- === 8. Накат: платформенный захват для каждого найденного источника ===
    insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,origin,discovered_by)
    select
      case when b.source='manual' then 'manual_day' when b.deal_id is null then 'orphan_day' else 'app_day' end,
      b.vendor_id,
      case when b.source='deal' and b.deal_id is not null then (select d.wedding_id from deals d where d.id=b.deal_id) else null end,
      case when b.source='manual' or b.deal_id is null then b.vendor_id else null end,
      b.id,
      legacy_calendar_origin(case when b.source='manual' then 'manual_day' when b.deal_id is null then 'orphan_day' else 'app_day' end,b.id,null),
      'migration'
    from vendor_busy_dates b;

    insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,root_deal_id,origin,discovered_by)
    select 'app_root',d.vendor_id,d.wedding_id,null,null,d.id,legacy_calendar_origin('app_root',null,d.id),'migration'
    from deals d
    where d.vendor_id is not null and d.state in ('booked','paid_deposit','done')
      and coalesce((select c.revision from deal_resource_commitments c where c.deal_id=d.id),0)=0;

    insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,root_deal_id,origin,discovered_by)
    select 'live_negotiation',d.vendor_id,d.wedding_id,null,null,d.id,legacy_calendar_origin('live_negotiation',null,d.id),'migration'
    from deals d
    where d.vendor_id is not null and d.state='negotiating';

    insert into legacy_calendar_heads(source_id) select id from legacy_calendar_sources;

    do $$ declare s record; begin
      for s in select id from legacy_calendar_sources order by id loop
        perform legacy_calendar_append_version(s.id,null,'migration_backfill');
      end loop;
    end $$;

    -- === 7. Обнаружение (D3) — последним, после платформенного захвата ===
    create function legacy_calendar_discover_day() returns trigger language plpgsql as $$
    declare k text; wed uuid; comp uuid; new_source_id uuid; effective_deal_id uuid;
    begin
      if TG_OP='INSERT' then
        effective_deal_id := NEW.deal_id;
        if NEW.source='manual' then k:='manual_day';
        elsif NEW.source='deal' and NEW.deal_id is not null then k:='app_day';
        else return NEW; end if;
      else
        if NEW.source<>'deal' or OLD.deal_id is null or NEW.deal_id is not null then return NEW; end if;
        k:='orphan_day'; effective_deal_id := OLD.deal_id;
      end if;
      -- manual_day and orphan_day are both company-owned (Модель.2); only
      -- app_day resolves a wedding through its live deal pointer.
      if k in ('manual_day','orphan_day') then comp:=NEW.vendor_id; wed:=null;
      else select d.wedding_id into wed from deals d where d.id=effective_deal_id; comp:=null;
      end if;
      insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,origin,discovered_by)
        values(k,NEW.vendor_id,wed,comp,NEW.id,legacy_calendar_origin(k,NEW.id,null),'writer')
        on conflict(day_id,kind) do nothing returning id into new_source_id;
      if new_source_id is not null then
        insert into legacy_calendar_heads(source_id) values(new_source_id);
      end if;
      return NEW;
    end $$;
    create trigger legacy_calendar_discover_day_insert after insert on vendor_busy_dates
      for each row execute function legacy_calendar_discover_day();
    create trigger legacy_calendar_discover_day_orphan after update of deal_id on vendor_busy_dates
      for each row execute function legacy_calendar_discover_day();

    create function legacy_calendar_discover_deal() returns trigger language plpgsql as $$
    declare k text; new_source_id uuid;
    begin
      if NEW.vendor_id is null then return NEW; end if;
      if NEW.state in ('booked','paid_deposit','done') then
        if not exists(select 1 from deal_resource_commitments c where c.deal_id=NEW.id and c.revision>0) then k:='app_root'; end if;
      elsif NEW.state='negotiating' then k:='live_negotiation';
      end if;
      if k is null then return NEW; end if;
      insert into legacy_calendar_sources(kind,vendor_id,wedding_id,company_id,day_id,root_deal_id,origin,discovered_by)
        values(k,NEW.vendor_id,NEW.wedding_id,null,null,NEW.id,legacy_calendar_origin(k,null,NEW.id),'writer')
        on conflict(root_deal_id,kind) do nothing returning id into new_source_id;
      if new_source_id is not null then
        insert into legacy_calendar_heads(source_id) values(new_source_id);
      end if;
      return NEW;
    end $$;
    create trigger legacy_calendar_discover_deal after insert or update of state,vendor_id on deals
      for each row execute function legacy_calendar_discover_deal();

    comment on table legacy_calendar_sources is 'Технический инвентарь прежнего (DATE-only) календаря — обнаружение и свежесть, без решений владельца (370). DTO.state всегда unresolved; legacyBoundary/политика/каталог/перенос не изменены этой таблицей';
    comment on column legacy_calendar_versions.canonical is 'jsonb::text снимок legacy_calendar_inventory_material(source); digest и каноника считаются только в SQL (D5)';
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from legacy_calendar_sources) or exists(select 1 from legacy_calendar_versions)
        or exists(select 1 from legacy_calendar_version_holders) or exists(select 1 from legacy_calendar_heads) then
        raise exception 'legacy calendar inventory evidence exists; use a preserving forward migration';
      end if;
    end $$;
    drop trigger legacy_calendar_discover_deal on deals;
    drop function legacy_calendar_discover_deal();
    drop trigger legacy_calendar_discover_day_orphan on vendor_busy_dates;
    drop trigger legacy_calendar_discover_day_insert on vendor_busy_dates;
    drop function legacy_calendar_discover_day();
    drop trigger protect_vendor_busy_date_identity on vendor_busy_dates;
    drop function protect_vendor_busy_date_identity();
    drop trigger check_legacy_calendar_inventory_heads on legacy_calendar_heads;
    drop trigger check_legacy_calendar_inventory_holders on legacy_calendar_version_holders;
    drop trigger check_legacy_calendar_inventory_versions on legacy_calendar_versions;
    drop trigger check_legacy_calendar_inventory_sources on legacy_calendar_sources;
    drop function check_legacy_calendar_inventory();
    drop trigger protect_legacy_calendar_head on legacy_calendar_heads;
    drop function protect_legacy_calendar_head();
    drop trigger protect_legacy_calendar_holder on legacy_calendar_version_holders;
    drop function protect_legacy_calendar_holder();
    drop trigger protect_legacy_calendar_version on legacy_calendar_versions;
    drop function protect_legacy_calendar_version();
    drop trigger protect_legacy_calendar_source on legacy_calendar_sources;
    drop function protect_legacy_calendar_source();
    drop function legacy_calendar_append_version(uuid,uuid,text);
    -- present()/inventory_material() declare their formal parameter AS the
    -- sources row type (not just %rowtype inside the body), so PostgreSQL
    -- records a real pg_depend edge on it; both must go before the table.
    drop function legacy_calendar_present(legacy_calendar_sources);
    drop function legacy_calendar_inventory_material(legacy_calendar_sources);
    drop function legacy_calendar_holder(uuid,uuid);
    drop function legacy_calendar_origin(text,uuid,uuid);
    drop table legacy_calendar_version_holders;
    drop table legacy_calendar_heads;
    drop table legacy_calendar_versions;
    drop table legacy_calendar_sources;
    drop index vendor_busy_dates_deal_link;
    alter table vendor_busy_dates drop constraint vendor_busy_dates_identity, drop column source_revision, drop column id;
  `)
}
