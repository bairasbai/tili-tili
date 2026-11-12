exports.up = pgm => pgm.sql(`
  create function offer_price_components_valid(base bigint, lines jsonb) returns boolean
    language plpgsql immutable strict as $$
  declare
    entry jsonb;
    item_kind text;
    item_status text;
    amount jsonb;
    minor numeric;
    known numeric := base;
    seen text[] := array[]::text[];
  begin
    if base < 0 or base > 9007199254740991 or jsonb_typeof(lines) <> 'array' then return false; end if;
    if jsonb_array_length(lines) not between 1 and 13 then return false; end if;
    for entry in select value from jsonb_array_elements(lines) loop
      if jsonb_typeof(entry) <> 'object' then return false; end if;
      if not (entry ?& array['kind','status','amount'])
        or entry - array['kind','status','amount'] <> '{}'::jsonb then return false; end if;
      item_kind := entry->>'kind';
      item_status := entry->>'status';
      amount := entry->'amount';
      if item_kind is null or item_kind <> all(array['delivery','setup','teardown','corkage','overtime','transfer','printing','packaging','accessories','consumables','rehearsal','lighting','rental_extension'])
        or item_kind = any(seen) or item_status is null
        or item_status <> all(array['included','separate','not_required','unknown']) then return false; end if;
      seen := array_append(seen,item_kind);
      if amount = 'null'::jsonb then continue; end if;
      if item_status <> 'separate' or jsonb_typeof(amount) <> 'object' then return false; end if;
      if not (amount ?& array['amount','currency']) or amount - array['amount','currency'] <> '{}'::jsonb
        or amount->>'currency' is distinct from 'RUB'
        or jsonb_typeof(amount->'amount') is distinct from 'number' then return false; end if;
      minor := (amount->>'amount')::numeric;
      if minor <> trunc(minor) or minor < 0 or minor > 9007199254740991 then return false; end if;
      known := known + minor;
      if known > 9007199254740991 then return false; end if;
    end loop;
    return true;
  end $$;

  create table offer_price_breakdowns (
    id uuid primary key default gen_random_uuid(),
    offer_id uuid unique references offers(id) on delete cascade,
    deal_id uuid unique references deals(id) on delete cascade,
    base_amount bigint not null,
    components jsonb not null,
    constraint offer_price_breakdowns_one_owner check (num_nonnulls(offer_id,deal_id)=1),
    constraint offer_price_breakdowns_canonical check (offer_price_components_valid(base_amount,components))
  );

  create function keep_offer_price_breakdown() returns trigger language plpgsql as $$
  declare parent_amount bigint;
  begin
    if tg_op='UPDATE' then
      if new is distinct from old then
        raise exception using errcode='23514', message='offer_price_breakdown_immutable';
      end if;
      return new;
    end if;
    if new.offer_id is not null then
      select price into parent_amount from offers where id=new.offer_id and kind='offer';
    else
      select price into parent_amount from deals where id=new.deal_id;
    end if;
    if parent_amount is distinct from new.base_amount then
      raise exception using errcode='23514', message='offer_price_breakdown_parent_amount';
    end if;
    return new;
  end $$;
  create trigger offer_price_breakdown_immutable before insert or update on offer_price_breakdowns
    for each row execute function keep_offer_price_breakdown();
`)

exports.down = pgm => pgm.sql(`
  lock table offer_price_breakdowns in access exclusive mode;
  do $$ begin
    if exists(select 1 from offer_price_breakdowns) then
      raise exception using errcode='23514', message='offer_price_breakdowns_preserving_down_fr013';
    end if;
  end $$;
  drop table offer_price_breakdowns;
  drop function keep_offer_price_breakdown();
  drop function offer_price_components_valid(bigint,jsonb);
`)
