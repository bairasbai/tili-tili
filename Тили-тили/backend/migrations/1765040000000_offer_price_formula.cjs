exports.up = pgm => pgm.sql(`
  alter function offer_price_components_valid(bigint,jsonb) rename to offer_price_components_fixed_valid;

  create function offer_price_components_valid(base bigint, lines jsonb) returns boolean
    language plpgsql immutable strict as $$
  declare
    fixed_lines jsonb;
    entry jsonb;
    formula jsonb;
    rate jsonb;
    quantity jsonb;
    minor numeric;
    expected numeric;
  begin
    if jsonb_typeof(lines) <> 'array' then return false; end if;
    select jsonb_agg(case when jsonb_typeof(value)='object' then value-'formula' else value end order by ord)
      into fixed_lines from jsonb_array_elements(lines) with ordinality as line(value,ord);
    if offer_price_components_fixed_valid(base,fixed_lines) is distinct from true then return false; end if;

    for entry in select value from jsonb_array_elements(lines) where value ? 'formula' loop
      formula := entry->'formula';
      if entry->>'status' <> 'separate' or jsonb_typeof(formula) <> 'object' then return false; end if;
      if not (formula ?& array['unit','quantity','rate'])
        or formula - array['unit','quantity','rate'] <> '{}'::jsonb
        or jsonb_typeof(formula->'unit') <> 'string'
        or formula->>'unit' <> all(array['item','person','hour','minute','trip','day','set','kilometer','meter','kilogram'])
      then return false; end if;
      quantity := formula->'quantity';
      rate := formula->'rate';
      if quantity <> 'null'::jsonb then
        if jsonb_typeof(quantity) <> 'string'
          or (formula->>'quantity') !~ '^(0|[1-9][0-9]{0,5})([.][0-9]{1,3})?$' then return false; end if;
      end if;
      if rate <> 'null'::jsonb then
        if jsonb_typeof(rate) <> 'object' then return false; end if;
        if not (rate ?& array['amount','currency']) or rate - array['amount','currency'] <> '{}'::jsonb
          or rate->>'currency' is distinct from 'RUB'
          or jsonb_typeof(rate->'amount') is distinct from 'number' then return false; end if;
        minor := (rate->>'amount')::numeric;
        if minor <> trunc(minor) or minor < 0 or minor > 9007199254740991 then return false; end if;
      end if;
      if quantity = 'null'::jsonb or rate = 'null'::jsonb then
        if entry->'amount' <> 'null'::jsonb then return false; end if;
      else
        expected := round(minor * (formula->>'quantity')::numeric);
        if (entry->'amount'->>'amount')::numeric is distinct from expected then return false; end if;
      end if;
    end loop;
    return true;
  end $$;

  alter table offer_price_breakdowns
    drop constraint offer_price_breakdowns_canonical,
    add constraint offer_price_breakdowns_canonical check (offer_price_components_valid(base_amount,components));
`)

exports.down = pgm => pgm.sql(`
  lock table offer_price_breakdowns in access exclusive mode;
  do $$ begin
    if exists(select 1 from offer_price_breakdowns p, jsonb_array_elements(p.components) as line(value) where value ? 'formula') then
      raise exception using errcode='23514', message='offer_price_formula_preserving_down_fr014';
    end if;
  end $$;
  alter table offer_price_breakdowns drop constraint offer_price_breakdowns_canonical;
  drop function offer_price_components_valid(bigint,jsonb);
  alter function offer_price_components_fixed_valid(bigint,jsonb) rename to offer_price_components_valid;
  alter table offer_price_breakdowns
    add constraint offer_price_breakdowns_canonical check (offer_price_components_valid(base_amount,components));
`)
