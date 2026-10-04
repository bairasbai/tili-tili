/** FR018: literal selected offer terms, never inferred from message/current package. */
exports.up = pgm => pgm.sql(`
  alter table offers add column comparison_terms jsonb,
    add constraint offers_comparison_terms_canonical check (comparison_terms is null or case when jsonb_typeof(comparison_terms) = 'object' then
      comparison_terms ?& array['hours','team','result','delivery','extras','cancellation','reschedule']
      and comparison_terms - array['hours','team','result','delivery','extras','cancellation','reschedule'] = '{}'::jsonb
      and comparison_terms <> '{"hours":null,"team":null,"result":null,"delivery":null,"extras":null,"cancellation":null,"reschedule":null}'::jsonb
      and (comparison_terms->'hours' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'hours') = 'string' and char_length(comparison_terms->>'hours') between 1 and 2000))
      and (comparison_terms->'team' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'team') = 'string' and char_length(comparison_terms->>'team') between 1 and 2000))
      and (comparison_terms->'result' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'result') = 'string' and char_length(comparison_terms->>'result') between 1 and 2000))
      and (comparison_terms->'delivery' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'delivery') = 'string' and char_length(comparison_terms->>'delivery') between 1 and 2000))
      and (comparison_terms->'extras' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'extras') = 'string' and char_length(comparison_terms->>'extras') between 1 and 2000))
      and (comparison_terms->'cancellation' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'cancellation') = 'string' and char_length(comparison_terms->>'cancellation') between 1 and 2000))
      and (comparison_terms->'reschedule' = 'null'::jsonb or (jsonb_typeof(comparison_terms->'reschedule') = 'string' and char_length(comparison_terms->>'reschedule') between 1 and 2000))
      else false end),
    add constraint offers_decline_no_comparison_terms check (kind <> 'decline' or comparison_terms is null);
  alter table deals add column offer_comparison_terms_snapshot jsonb,
    add constraint deals_offer_comparison_terms_canonical check (offer_comparison_terms_snapshot is null or case when jsonb_typeof(offer_comparison_terms_snapshot) = 'object' then
      offer_comparison_terms_snapshot ?& array['hours','team','result','delivery','extras','cancellation','reschedule']
      and offer_comparison_terms_snapshot - array['hours','team','result','delivery','extras','cancellation','reschedule'] = '{}'::jsonb
      and offer_comparison_terms_snapshot <> '{"hours":null,"team":null,"result":null,"delivery":null,"extras":null,"cancellation":null,"reschedule":null}'::jsonb
      and (offer_comparison_terms_snapshot->'hours' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'hours') = 'string' and char_length(offer_comparison_terms_snapshot->>'hours') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'team' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'team') = 'string' and char_length(offer_comparison_terms_snapshot->>'team') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'result' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'result') = 'string' and char_length(offer_comparison_terms_snapshot->>'result') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'delivery' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'delivery') = 'string' and char_length(offer_comparison_terms_snapshot->>'delivery') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'extras' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'extras') = 'string' and char_length(offer_comparison_terms_snapshot->>'extras') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'cancellation' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'cancellation') = 'string' and char_length(offer_comparison_terms_snapshot->>'cancellation') between 1 and 2000))
      and (offer_comparison_terms_snapshot->'reschedule' = 'null'::jsonb or (jsonb_typeof(offer_comparison_terms_snapshot->'reschedule') = 'string' and char_length(offer_comparison_terms_snapshot->>'reschedule') between 1 and 2000))
      else false end);
`);

exports.down = pgm => pgm.sql(`
  lock table public.deals, public.offers in access exclusive mode;
  do $fr018_down_guard$
  begin
    if exists (select 1 from public.offers where comparison_terms is not null)
      or exists (select 1 from public.deals where offer_comparison_terms_snapshot is not null) then
      raise exception 'stored offer comparison terms or accepted snapshots exist; use a preserving forward migration'
        using errcode = '23514', constraint = 'offer_comparison_terms_down_preservation';
    end if;
  end;
  $fr018_down_guard$;
  alter table deals drop constraint deals_offer_comparison_terms_canonical, drop column offer_comparison_terms_snapshot;
  alter table offers drop constraint offers_decline_no_comparison_terms, drop constraint offers_comparison_terms_canonical, drop column comparison_terms;
`);
