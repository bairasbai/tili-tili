// Forward-only correction after schema97. Keep the current certificate's exact
// adoption proof and forbid every remaining live alias barrier. Previously
// released history already passed the immutable, one-way native release guards.
exports.up = pgm => {
  pgm.sql(String.raw`
create or replace function legacy_calendar_bounds_assert_adopted(p_event_id uuid) returns void language plpgsql volatile as $$
    declare e legacy_calendar_resolution_events%rowtype;p legacy_calendar_adoption_proofs%rowtype;
      v deal_resource_commitment_versions%rowtype;h deal_resource_commitments%rowtype;
      c resource_occupancy_origin_certificates%rowtype;expected jsonb;actual jsonb;
    begin
      select * into e from legacy_calendar_resolution_events where id=p_event_id;
      if not found or e.action<>'adopted' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events own where own.id=e.id and legacy_day_transaction_owns(own.xmin)) then return;end if;
      select * into p from legacy_calendar_adoption_proofs where id=(e.material->>'proofId')::uuid;
      if not found or p.source_id<>e.source_id or p.bounds_version_id is distinct from e.bounds_version_id
        or e.material is distinct from legacy_calendar_bounds_adoption_material(p.id)
        or not exists(select 1 from legacy_calendar_adoption_proofs own where own.id=p.id and legacy_day_transaction_owns(own.xmin)) then
        perform legacy_calendar_bounds_fail('Adopted resolution must retain exact same-transaction proof');end if;
      select * into v from deal_resource_commitment_versions where wedding_id=p.wedding_id and deal_id=p.deal_id and id=p.commitment_version_id;
      if not found or v.action<>'adopt' or v.revision<>1 or v.previous_version_id is not null or v.state<>'reserved'
        or v.legacy_adoption_proof_id is distinct from p.id or v.terms_id<>p.terms_id or v.plan_revision_id<>p.plan_revision_id
        or not exists(select 1 from deal_resource_commitment_versions own where own.id=v.id and legacy_day_transaction_owns(own.xmin)) then
        perform legacy_calendar_bounds_fail('Adopted resolution requires exact new adopted commitment');end if;
      select * into h from deal_resource_commitments where wedding_id=p.wedding_id and deal_id=p.deal_id;
      if not found or h.revision<>1 or h.state<>'reserved' or h.current_version_id<>v.id then
        perform legacy_calendar_bounds_fail('Adopted resolution requires exact new reserved head');end if;
      select * into c from resource_occupancy_origin_certificates where source_identity=p.source_id and bounds_version_identity=p.bounds_version_id;
      if not found then perform legacy_calendar_bounds_fail('Adopted resolution requires the effective origin certificate');end if;
      select coalesce(jsonb_agg(line_index order by line_index),'[]') into expected
        from (select distinct (line.value->>'lineIndex')::int as line_index
          from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id) distinct_lines;
      select coalesce(jsonb_agg(o.origin_line_index order by o.origin_line_index),'[]') into actual
        from resource_occupancy o where o.certificate_id=c.id and o.release_event_id=e.id;
      if expected='[]'::jsonb or actual is distinct from expected
        or exists(select 1 from resource_occupancy o where o.certificate_id=c.id and o.release_event_id=e.id
          and(o.released_at is null or o.release_reason<>'adopted'))
        or exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          join resource_occupancy o on o.certificate_id=c.id and o.origin_line_index=(line.value->>'lineIndex')::int and o.released_at is null
          where (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id)
        or exists(select 1 from resource_occupancy o
          join resource_occupancy_origin_certificates oc on oc.id=o.certificate_id
          join jsonb_array_elements(oc.canonical::jsonb->'lines') line on (line.value->>'lineIndex')::int=o.origin_line_index
          join jsonb_array_elements(oc.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where oc.vendor_identity=(select d.vendor_id from deals d where d.wedding_id=p.wedding_id and d.id=p.deal_id)
            and (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id
            and o.released_at is null) then
        perform legacy_calendar_bounds_fail('Adopted resolution must release exactly the holder legacy barriers');end if;
    end $$;
  `)
}

exports.down = pgm => {
  pgm.sql(String.raw`
create or replace function legacy_calendar_bounds_assert_adopted(p_event_id uuid) returns void language plpgsql volatile as $$
    declare e legacy_calendar_resolution_events%rowtype;p legacy_calendar_adoption_proofs%rowtype;
      v deal_resource_commitment_versions%rowtype;h deal_resource_commitments%rowtype;
      c resource_occupancy_origin_certificates%rowtype;expected jsonb;actual jsonb;
    begin
      select * into e from legacy_calendar_resolution_events where id=p_event_id;
      if not found or e.action<>'adopted' or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events own where own.id=e.id and legacy_day_transaction_owns(own.xmin)) then return;end if;
      select * into p from legacy_calendar_adoption_proofs where id=(e.material->>'proofId')::uuid;
      if not found or p.source_id<>e.source_id or p.bounds_version_id is distinct from e.bounds_version_id
        or e.material is distinct from legacy_calendar_bounds_adoption_material(p.id)
        or not exists(select 1 from legacy_calendar_adoption_proofs own where own.id=p.id and legacy_day_transaction_owns(own.xmin)) then
        perform legacy_calendar_bounds_fail('Adopted resolution must retain exact same-transaction proof');end if;
      select * into v from deal_resource_commitment_versions where wedding_id=p.wedding_id and deal_id=p.deal_id and id=p.commitment_version_id;
      if not found or v.action<>'adopt' or v.revision<>1 or v.previous_version_id is not null or v.state<>'reserved'
        or v.legacy_adoption_proof_id is distinct from p.id or v.terms_id<>p.terms_id or v.plan_revision_id<>p.plan_revision_id
        or not exists(select 1 from deal_resource_commitment_versions own where own.id=v.id and legacy_day_transaction_owns(own.xmin)) then
        perform legacy_calendar_bounds_fail('Adopted resolution requires exact new adopted commitment');end if;
      select * into h from deal_resource_commitments where wedding_id=p.wedding_id and deal_id=p.deal_id;
      if not found or h.revision<>1 or h.state<>'reserved' or h.current_version_id<>v.id then
        perform legacy_calendar_bounds_fail('Adopted resolution requires exact new reserved head');end if;
      select * into c from resource_occupancy_origin_certificates where source_identity=p.source_id and bounds_version_identity=p.bounds_version_id;
      if not found then perform legacy_calendar_bounds_fail('Adopted resolution requires the effective origin certificate');end if;
      select coalesce(jsonb_agg(line_index order by line_index),'[]') into expected
        from (select distinct (line.value->>'lineIndex')::int as line_index
          from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id) distinct_lines;
      select coalesce(jsonb_agg(o.origin_line_index order by o.origin_line_index),'[]') into actual
        from resource_occupancy o where o.certificate_id=c.id and o.release_event_id=e.id;
      if expected='[]'::jsonb or actual is distinct from expected
        or exists(select 1 from resource_occupancy o where o.certificate_id=c.id and o.release_event_id=e.id
          and(o.released_at is null or o.release_reason<>'adopted'))
        or exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'lines') line
          join jsonb_array_elements(c.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          join resource_occupancy o on o.certificate_id=c.id and o.origin_line_index=(line.value->>'lineIndex')::int and o.released_at is null
          where (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id)
        or exists(select 1 from resource_occupancy o
          join resource_occupancy_origin_certificates oc on oc.id=o.certificate_id
          join jsonb_array_elements(oc.canonical::jsonb->'lines') line on (line.value->>'lineIndex')::int=o.origin_line_index
          join jsonb_array_elements(oc.canonical::jsonb->'ranges') r on r.value->>'ownerKey'=line.value->>'ownerKey'
          where oc.vendor_identity=(select d.vendor_id from deals d where d.wedding_id=p.wedding_id and d.id=p.deal_id)
            and (r.value->>'weddingId')::uuid=p.wedding_id and (r.value->>'dealId')::uuid=p.deal_id
            and (o.released_at is null or o.release_event_id is distinct from e.id or o.release_reason<>'adopted')) then
        perform legacy_calendar_bounds_fail('Adopted resolution must release exactly the holder legacy barriers');end if;
    end $$;
  `)
}
