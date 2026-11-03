/* FULL372 forward schema95: same financial root adoption of an accepted legacy holder
 * into a native resource commitment. One holder of one effective bounds version becomes
 * an action='adopt' commitment (revision 1, state reserved) without any DATE/slot/financial
 * mutation; the holder's legacy barriers are released by an action='adopted' resolution
 * event pinned to an exact same-transaction proof. The source stays current/finite for
 * every retained holder. Down restores the exact schema94 bodies and refuses while any
 * adoption evidence exists.
 */
exports.up = pgm => {
  pgm.sql(String.raw`
    create table legacy_calendar_adoption_proofs(
      id uuid primary key,source_id uuid not null,source_version_id uuid not null,
      wedding_id uuid not null,deal_id uuid not null,
      bounds_version_id uuid not null,terms_id uuid not null,plan_revision_id uuid not null,
      commitment_version_id uuid not null,
      source_fingerprint text not null,bounds_digest text not null,
      created_at timestamptz not null default clock_timestamp(),
      transaction_id bigint not null default txid_current(),backend_pid integer not null default pg_backend_pid(),
      unique(source_id,id),unique(wedding_id,deal_id,id),unique(commitment_version_id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      foreign key(source_id,source_version_id) references legacy_calendar_versions(source_id,id) deferrable initially deferred,
      foreign key(source_id,bounds_version_id) references legacy_calendar_bounds_versions(source_id,id) deferrable initially deferred,
      foreign key(wedding_id,deal_id,terms_id) references deal_terms_versions(wedding_id,deal_id,id) deferrable initially deferred,
      foreign key(wedding_id,deal_id,plan_revision_id) references deal_resource_plan_versions(wedding_id,deal_id,id) deferrable initially deferred,
      foreign key(wedding_id,deal_id,commitment_version_id) references deal_resource_commitment_versions(wedding_id,deal_id,id) deferrable initially deferred,
      check(source_fingerprint~'^[0-9a-f]{64}$' and bounds_digest~'^[0-9a-f]{64}$')
    );
    create index legacy_calendar_adoption_proofs_transaction on legacy_calendar_adoption_proofs(transaction_id,backend_pid);
    alter table deal_resource_commitment_versions add column legacy_adoption_proof_id uuid;
    alter table deal_resource_commitment_versions add constraint deal_resource_commitment_versions_adoption_proof
      foreign key(wedding_id,deal_id,legacy_adoption_proof_id) references legacy_calendar_adoption_proofs(wedding_id,deal_id,id)
      deferrable initially deferred;
    do $$ declare r record;n integer;
    begin
      select count(*) into n from pg_catalog.pg_constraint where conrelid='deal_resource_commitment_versions'::regclass
        and contype='c' and pg_catalog.pg_get_constraintdef(oid) like '%action%';
      if n<>2 then raise exception 'unexpected commitment version checks' using errcode='23514';end if;
      for r in select conname from pg_catalog.pg_constraint where conrelid='deal_resource_commitment_versions'::regclass
        and contype='c' and pg_catalog.pg_get_constraintdef(oid) like '%action%' loop
        execute format('alter table deal_resource_commitment_versions drop constraint %I',r.conname);
      end loop;
      select count(*) into n from pg_catalog.pg_constraint where conrelid='legacy_calendar_resolution_events'::regclass
        and contype='c' and pg_catalog.pg_get_constraintdef(oid) like '%activate%';
      if n<>1 then raise exception 'unexpected resolution event checks' using errcode='23514';end if;
      for r in select conname from pg_catalog.pg_constraint where conrelid='legacy_calendar_resolution_events'::regclass
        and contype='c' and pg_catalog.pg_get_constraintdef(oid) like '%activate%' loop
        execute format('alter table legacy_calendar_resolution_events drop constraint %I',r.conname);
      end loop;
    end $$;
    alter table deal_resource_commitment_versions
      add constraint deal_resource_commitment_versions_action_check check(action in('commit','replace','release','adopt')),
      add constraint deal_resource_commitment_versions_state_reason_check
        check((action='release' and state='released' and reason is not null) or
          (action in('commit','replace','adopt') and state='reserved' and reason is null)),
      add constraint deal_resource_commitment_versions_adoption_proof_check
        check((action='adopt')=(legacy_adoption_proof_id is not null));
    alter table legacy_calendar_resolution_events
      add constraint legacy_calendar_resolution_events_action_check
        check(action in('activate','holder_cancelled','source_unavailable','source_stale','superseded','negotiation_committed','adopted'));
    alter table deal_terms_versions drop constraint resource_plan_terms_format;
    alter table deal_terms_versions add constraint resource_plan_terms_format check(
      (snapshot->>'schemaVersion'='1' and resource_plan_id is null) or
      (snapshot->>'schemaVersion' in('2','3') and resource_plan_id is not null
        and snapshot->'resourcePlan'->>'planRevisionId'=resource_plan_id::text));
    comment on table legacy_calendar_adoption_proofs is 'Same-transaction proof that an accepted legacy holder was adopted into an exact native resource commitment; immutable once written';
    comment on column deal_resource_commitment_versions.legacy_adoption_proof_id is 'Exact adoption proof for action=adopt versions; null for every other action';
  `)
  pgm.sql(String.raw`
    create function legacy_calendar_bounds_adoption_material(p_proof_id uuid) returns jsonb language sql stable as $$
      select jsonb_build_object('encoding','legacy-calendar-adoption/1','proofId',p.id,'sourceId',p.source_id,
        'sourceVersionId',p.source_version_id,'weddingId',p.wedding_id,'dealId',p.deal_id,
        'boundsVersionId',p.bounds_version_id,'boundsDigest',p.bounds_digest,'sourceFingerprint',p.source_fingerprint,
        'termsId',p.terms_id,'planRevisionId',p.plan_revision_id,'commitmentVersionId',p.commitment_version_id)
        from legacy_calendar_adoption_proofs p where p.id=p_proof_id
    $$;
    create function legacy_calendar_bounds_assert_adopted(p_event_id uuid) returns void language plpgsql volatile as $$
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
    create function legacy_calendar_bounds_assert_adoption(p_proof_id uuid) returns void language plpgsql volatile as $$
    declare p legacy_calendar_adoption_proofs%rowtype;
    begin
      select * into p from legacy_calendar_adoption_proofs where id=p_proof_id;
      if not found or p.transaction_id<>txid_current() or p.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_adoption_proofs own where own.id=p.id and legacy_day_transaction_owns(own.xmin)) then return;end if;
      if not exists(select 1 from legacy_calendar_resolution_events e where e.source_id=p.source_id and e.action='adopted'
        and e.material is not distinct from legacy_calendar_bounds_adoption_material(p.id)
        and e.transaction_id=p.transaction_id and e.backend_pid=p.backend_pid) then
        perform legacy_calendar_bounds_fail('Adoption proof must finish in an exact adopted resolution');end if;
    end $$;
    create function protect_legacy_calendar_adoption_proof() returns trigger language plpgsql as $$
    declare s legacy_calendar_sources%rowtype;effect jsonb;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          perform legacy_calendar_bounds_fail('Adoption evidence can only be erased with wedding','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' then
        perform legacy_calendar_bounds_fail('Adoption evidence is immutable','legacy_calendar_bounds_immutable');end if;
      perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'weddingIds',jsonb_build_array(NEW.wedding_id)));
      select * into s from legacy_calendar_sources where id=NEW.source_id;
      if not found or not legacy_calendar_present(s) then
        perform legacy_calendar_bounds_fail('Adoption requires a present source','legacy_calendar_bounds_source_changed');end if;
      effect:=legacy_calendar_bounds_current_effect(NEW.source_id);
      if effect->>'freshness'<>'current' or effect->>'state'<>'finite' or (effect->>'effectiveVersionId')::uuid is distinct from NEW.bounds_version_id then
        perform legacy_calendar_bounds_fail('Adoption requires a current finite effective bounds version','legacy_calendar_bounds_not_agreed');end if;
      if not exists(select 1 from legacy_calendar_bounds_versions bv
          join legacy_calendar_bounds_heads hd on hd.source_id=bv.source_id
          join legacy_calendar_resolution_events ev on ev.id=hd.effective_event_id and ev.action='activate' and ev.bounds_version_id=bv.id
          where bv.id=NEW.bounds_version_id and bv.source_id=NEW.source_id and bv.digest=NEW.bounds_digest and bv.source_fingerprint=NEW.source_fingerprint)
        or not exists(select 1 from legacy_calendar_heads ih where ih.source_id=NEW.source_id and ih.current_version_id=NEW.source_version_id) then
        perform legacy_calendar_bounds_fail('Adoption pins must name the exact effective inventory and bounds','legacy_calendar_bounds_source_changed');end if;
      if not exists(select 1 from legacy_calendar_bounds_holders hh where hh.bounds_version_id=NEW.bounds_version_id
        and hh.wedding_id=NEW.wedding_id and hh.deal_id=NEW.deal_id) then
        perform legacy_calendar_bounds_fail('Adoption requires an actual holder of the effective bounds','legacy_calendar_bounds_declaration');end if;
      if not exists(select 1 from deals d where d.wedding_id=NEW.wedding_id and d.id=NEW.deal_id and d.state in('booked','paid_deposit'))
        or not exists(select 1 from deal_resource_commitments ch where ch.wedding_id=NEW.wedding_id and ch.deal_id=NEW.deal_id
          and ch.revision=0 and ch.state='not_reserved' and ch.current_version_id is null) then
        perform legacy_calendar_bounds_fail('Adoption requires a booked deal with an empty commitment head','legacy_calendar_adoption_state');end if;
      if not exists(select 1 from deal_orders o
          join deal_terms_versions t on t.wedding_id=o.wedding_id and t.deal_id=o.deal_id and t.id=NEW.terms_id
          join deal_resource_plan_versions plan on plan.wedding_id=o.wedding_id and plan.deal_id=o.deal_id and plan.id=NEW.plan_revision_id
          where o.wedding_id=NEW.wedding_id and o.deal_id=NEW.deal_id
            and o.proposed_terms_id=NEW.terms_id and o.agreed_terms_id=NEW.terms_id and o.resource_plan_id=NEW.plan_revision_id
            and t.resource_plan_id=NEW.plan_revision_id and t.snapshot->>'schemaVersion'='3'
            and t.snapshot->'legacyTransition'->>'purpose'='adopt-legacy-calendar'
            and (t.snapshot->'legacyTransition'->>'sourceId')::uuid=NEW.source_id
            and (t.snapshot->'legacyTransition'->>'sourceVersionId')::uuid=NEW.source_version_id
            and t.snapshot->'legacyTransition'->>'sourceFingerprint'=NEW.source_fingerprint
            and (t.snapshot->'legacyTransition'->>'effectiveBoundsVersionId')::uuid=NEW.bounds_version_id
            and t.snapshot->'legacyTransition'->>'effectiveBoundsDigest'=NEW.bounds_digest
            and t.snapshot->'legacyTransition'->>'disposition'='replace_this_holder_company_barrier_with_this_resource_plan') then
        perform legacy_calendar_bounds_fail('Adoption requires the exact accepted schema3 transition head','legacy_calendar_adoption_terms');end if;
      NEW.created_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      return NEW;
    end $$;
  `)
  pgm.sql(String.raw`
    create or replace function protect_resource_commitment_version() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;t deal_terms_versions%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'commitment evidence can only be erased with wedding' using errcode='23514';
        end if;return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'created_by')<>(to_jsonb(OLD)-'created_by') or
          (NEW.created_by is distinct from OLD.created_by and not(OLD.created_by is not null and NEW.created_by is null
            and not exists(select 1 from users where id=OLD.created_by))) then
          raise exception 'commitment evidence is immutable' using errcode='23514';
        end if;return NEW;
      end if;
      select * into h from deal_resource_commitments where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id for update;
      if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'commitment requires next scoped head revision' using errcode='23514';
      end if;
      select * into t from deal_terms_versions where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id and id=NEW.terms_id;
      if not found or t.resource_plan_id is distinct from NEW.plan_revision_id or
        not exists(select 1 from deal_resource_plan_versions p where p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id
          and p.id=NEW.plan_revision_id and p.vendor_id=NEW.vendor_id) then
        raise exception 'commitment requires exact scoped accepted resource plan' using errcode='23514';
      end if;
      if NEW.action='release' then
        if h.state<>'reserved' or not exists(select 1 from deal_resource_commitment_versions v where v.id=h.current_version_id
          and v.terms_id=NEW.terms_id and v.plan_revision_id=NEW.plan_revision_id and v.vendor_id=NEW.vendor_id
          and v.policy_revision=NEW.policy_revision) then
          raise exception 'release retains previous accepted proof' using errcode='23514';
        end if;
      elsif not exists(select 1 from deal_orders o where o.wedding_id=NEW.wedding_id and o.deal_id=NEW.deal_id
        and o.proposed_terms_id=NEW.terms_id and o.agreed_terms_id=NEW.terms_id and o.resource_plan_id=NEW.plan_revision_id) then
        raise exception 'commitment requires current agreed head' using errcode='23514';
      end if;
      if NEW.action='adopt' and (NEW.legacy_adoption_proof_id is null or
        not exists(select 1 from legacy_calendar_adoption_proofs p where p.id=NEW.legacy_adoption_proof_id
          and p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id and p.commitment_version_id=NEW.id
          and p.terms_id=NEW.terms_id and p.plan_revision_id=NEW.plan_revision_id)) then
        raise exception 'adoption requires exact scoped proof' using errcode='23514';
      end if;
      if (NEW.action in('commit','adopt') and h.revision<>0) or (NEW.action='replace' and h.state<>'reserved') then
        raise exception 'invalid commitment transition' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create or replace function check_resource_commitment_proof() returns trigger language plpgsql as $$
    begin
      if NEW.action in('commit','replace') then
        if not exists(select 1 from deals d join vendor_availability_policy p on p.vendor_id=d.vendor_id
          where d.wedding_id=NEW.wedding_id and d.id=NEW.deal_id and d.vendor_id=NEW.vendor_id
            and p.mode='resources' and p.revision=NEW.policy_revision
            and ((NEW.action='commit' and d.state in ('candidate','contacted','negotiating')) or
              (NEW.action='replace' and d.state in ('booked','paid_deposit')))) or
          not exists(select 1 from deal_terms_receipts c join deal_terms_receipts v
            on v.wedding_id=c.wedding_id and v.deal_id=c.deal_id and v.terms_id=c.terms_id
            join deal_terms_versions t on t.wedding_id=c.wedding_id and t.deal_id=c.deal_id and t.id=c.terms_id
            where c.wedding_id=NEW.wedding_id and c.deal_id=NEW.deal_id and c.terms_id=NEW.terms_id
              and c.party='customer' and v.party='performer' and c.user_id<>v.user_id
              and c.session_id<>v.session_id and c.digest=t.digest and v.digest=t.digest) then
          raise exception 'booking requires exact company policy and distinct accepted proof' using errcode='23514';
        end if;
      elsif NEW.action='adopt' then
        if not exists(select 1 from deals d join vendor_availability_policy p on p.vendor_id=d.vendor_id
          where d.wedding_id=NEW.wedding_id and d.id=NEW.deal_id and d.vendor_id=NEW.vendor_id
            and p.mode='resources' and p.revision=NEW.policy_revision and d.state in('booked','paid_deposit')) or
          not exists(select 1 from deal_terms_receipts c join deal_terms_receipts v
            on v.wedding_id=c.wedding_id and v.deal_id=c.deal_id and v.terms_id=c.terms_id
            join deal_terms_versions t on t.wedding_id=c.wedding_id and t.deal_id=c.deal_id and t.id=c.terms_id
            where c.wedding_id=NEW.wedding_id and c.deal_id=NEW.deal_id and c.terms_id=NEW.terms_id
              and c.party='customer' and v.party='performer' and c.user_id<>v.user_id
              and c.session_id<>v.session_id and c.digest=t.digest and v.digest=t.digest) or
          not exists(select 1 from deal_terms_versions t
            join legacy_calendar_adoption_proofs p on p.wedding_id=t.wedding_id and p.deal_id=t.deal_id and p.terms_id=t.id
            join legacy_calendar_bounds_versions bv on bv.source_id=p.source_id and bv.id=p.bounds_version_id
            where t.wedding_id=NEW.wedding_id and t.deal_id=NEW.deal_id and t.id=NEW.terms_id
              and p.id=NEW.legacy_adoption_proof_id and p.commitment_version_id=NEW.id and p.plan_revision_id=NEW.plan_revision_id
              and bv.digest=p.bounds_digest and bv.source_fingerprint=p.source_fingerprint
              and t.snapshot->>'schemaVersion'='3'
              and t.snapshot->'legacyTransition'->>'purpose'='adopt-legacy-calendar'
              and (t.snapshot->'legacyTransition'->>'sourceId')::uuid=p.source_id
              and (t.snapshot->'legacyTransition'->>'sourceVersionId')::uuid=p.source_version_id
              and t.snapshot->'legacyTransition'->>'sourceFingerprint'=p.source_fingerprint
              and (t.snapshot->'legacyTransition'->>'effectiveBoundsVersionId')::uuid=p.bounds_version_id
              and t.snapshot->'legacyTransition'->>'effectiveBoundsDigest'=p.bounds_digest
              and t.snapshot->'legacyTransition'->>'disposition'='replace_this_holder_company_barrier_with_this_resource_plan') then
          raise exception 'adoption requires exact booked proof and accepted legacy transition' using errcode='23514';
        end if;
      elsif NEW.reason='deal_cancelled' then
        if not exists(select 1 from deals where wedding_id=NEW.wedding_id and id=NEW.deal_id and state='cancelled') then
          raise exception 'release requires actual financial cancellation' using errcode='23514';
        end if;
      elsif NEW.reason='vendor_erased' then
        if not exists(select 1 from deals where wedding_id=NEW.wedding_id and id=NEW.deal_id
          and vendor_id is null and external_name='Удалённый подрядчик') then
          raise exception 'release requires actual vendor erasure transition' using errcode='23514';
        end if;
      elsif NEW.reason='wedding_erased' then
        if not exists(select 1 from weddings w join users owner on owner.id=w.owner_id where w.id=NEW.wedding_id
          and (w.archived_at is not null or w.cancelled_at is not null or
            (owner.deleted_at is not null and not exists(select 1 from wedding_members m join users heir on heir.id=m.user_id
              where m.wedding_id=w.id and m.role='couple' and m.user_id<>w.owner_id
                and (heir.deleted_at is null or heir.deleted_at>clock_timestamp()-interval '30 days'))))) then
          raise exception 'release requires eligible wedding erasure scope' using errcode='23514';
        end if;
      end if;return NEW;
    end $$;
    create or replace function check_resource_commitment_complete() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;v deal_resource_commitment_versions%rowtype;target uuid;n integer;
    begin
      target=coalesce(NEW.deal_id,OLD.deal_id);
      select * into h from deal_resource_commitments where deal_id=target;
      if not found then return null;end if;
      if TG_TABLE_NAME='deal_resource_commitment_versions' then
        if not exists(
        with recursive ancestry as (
          select id,previous_version_id from deal_resource_commitment_versions where id=h.current_version_id
          union all select p.id,p.previous_version_id from deal_resource_commitment_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=NEW.id) then
        raise exception 'orphan commitment version' using errcode='23514';
      end if;
      end if;
      if h.revision=0 then
        if exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'empty head has allocations' using errcode='23514';
        end if;return null;
      end if;
      select * into v from deal_resource_commitment_versions where id=h.current_version_id and wedding_id=h.wedding_id and deal_id=h.deal_id;
      if not found or v.revision<>h.revision or v.state<>h.state then
        raise exception 'invalid commitment head' using errcode='23514';
      end if;
      if h.state='released' then
        if exists(select 1 from deal_resource_commitment_members where version_id=v.id) or
          exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'released head retains live allocations' using errcode='23514';
        end if;
      else
        select jsonb_array_length(private_snapshot->'lines') into n from deal_resource_plan_versions where id=v.plan_revision_id;
        if n=0 or (select count(*) from deal_resource_commitment_members where version_id=v.id)<>n or
          (select count(*) from resource_allocations where deal_id=target and released_at is null)<>n or
          exists(select 1 from deal_resource_commitment_members m join resource_allocations a on a.id=m.allocation_id
            where m.version_id=v.id and (a.released_at is not null or m.line_index>=n)) or
          exists(select 1 from resource_allocations a where a.deal_id=target and a.released_at is null and
            not exists(select 1 from deal_resource_commitment_members m where m.version_id=v.id and m.allocation_id=a.id)) then
          raise exception 'current commitment membership incomplete' using errcode='23514';
        end if;
      end if;
      if v.action='adopt' then
        if v.legacy_adoption_proof_id is null or not exists(select 1 from legacy_calendar_adoption_proofs p
          where p.id=v.legacy_adoption_proof_id and p.wedding_id=v.wedding_id and p.deal_id=v.deal_id
            and p.commitment_version_id=v.id and p.terms_id=v.terms_id and p.plan_revision_id=v.plan_revision_id) or
          not exists(select 1 from legacy_calendar_adoption_proofs p join legacy_calendar_resolution_events e
            on e.source_id=p.source_id and e.action='adopted' and e.material->>'proofId'=p.id::text
            where p.id=v.legacy_adoption_proof_id and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid()) then
          raise exception 'adopted commitment requires exact proof and same-transaction resolution' using errcode='23514';
        end if;
      end if;return null;
    end $$;
  `)
  pgm.sql(String.raw`
    create or replace function legacy_calendar_bounds_release_valid(p_occupancy resource_occupancy,p_event uuid,p_reason text) returns boolean language plpgsql stable as $$
    declare e legacy_calendar_resolution_events%rowtype;c resource_occupancy_origin_certificates%rowtype;line jsonb;owner uuid;
    begin
      select * into c from resource_occupancy_origin_certificates where id=p_occupancy.certificate_id;
      select * into e from legacy_calendar_resolution_events where id=p_event;
      if c.id is null or e.id is null or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events x where x.id=e.id and legacy_day_transaction_owns(x.xmin)) then return false;end if;
      -- Cross-source release exists only for adoption: the adopted holder's barrier
      -- lines are released across every certificate of the same vendor.
      if e.source_id<>c.source_identity then
        if p_reason<>'adopted' or e.action<>'adopted' then return false;end if;
        select x into line from jsonb_array_elements(c.canonical::jsonb->'lines') x where (x->>'lineIndex')::int=p_occupancy.origin_line_index;
        owner:=(line->>'ownerKey')::uuid;
        return exists(select 1 from legacy_calendar_adoption_proofs p
          where p.id=(e.material->>'proofId')::uuid and p.source_id=e.source_id
            and p.transaction_id=txid_current() and p.backend_pid=pg_backend_pid()
            and exists(select 1 from deals d where d.wedding_id=p.wedding_id and d.id=p.deal_id and d.vendor_id=c.vendor_identity)
            and exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'ranges') r
              where r->>'ownerKey'=owner::text and (r->>'weddingId')::uuid=p.wedding_id and (r->>'dealId')::uuid=p.deal_id));
      end if;
      if p_reason='superseded' then return e.action='activate' and e.bounds_version_id<>c.bounds_version_identity and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version);end if;
      if p_reason='adopted' and e.action='adopted' then
        select x into line from jsonb_array_elements(c.canonical::jsonb->'lines') x where (x->>'lineIndex')::int=p_occupancy.origin_line_index;
        owner:=(line->>'ownerKey')::uuid;
        return exists(select 1 from legacy_calendar_adoption_proofs p
          where p.id=(e.material->>'proofId')::uuid and p.source_id=e.source_id and p.bounds_version_id=c.bounds_version_identity
            and p.transaction_id=txid_current() and p.backend_pid=pg_backend_pid()
            and exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'ranges') r
              where r->>'ownerKey'=owner::text and (r->>'weddingId')::uuid=p.wedding_id and (r->>'dealId')::uuid=p.deal_id));
      end if;
      if p_reason='negotiation_committed' then
        return e.action='negotiation_committed' and c.canonical::jsonb->>'sourceKind'='live_negotiation'
          and exists(select 1 from legacy_calendar_initial_commit_witnesses w join legacy_calendar_sources s on s.root_deal_id=w.deal_id
            where s.id=c.source_identity and e.material->>'witnessId'=w.id::text and legacy_calendar_bounds_initial_current(w.id,w.deal_id));
      end if;
      if p_reason='holder_cancelled' and e.action='holder_cancelled' then
        select x into line from jsonb_array_elements(c.canonical::jsonb->'lines') x where (x->>'lineIndex')::int=p_occupancy.origin_line_index;
        owner:=(line->>'ownerKey')::uuid;
        return exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'ranges') r join deals d on d.id=(r->>'dealId')::uuid and d.wedding_id=(r->>'weddingId')::uuid
          where r->>'ownerKey'=owner::text and d.state='cancelled' and e.material->>'dealId'=d.id::text);
      end if;
      return false;
    end $$;
  `)
  // Adopted-holder carve-out: the adopt-created live allocations of a proved adopted
  // holder are not a source mutation; every other holder input still stales the source.
  pgm.sql(String.raw`
    create or replace function legacy_calendar_bounds_source_material(p_source_id uuid) returns jsonb language plpgsql stable as $$
    declare src legacy_calendar_sources%rowtype;inv jsonb;ctx jsonb;person_scope jsonb;holders jsonb;holder jsonb;inputs jsonb;
      original_date date;complete text;reason text;owner uuid;available boolean;policy_mode text;policy_revision text;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then return null;end if;
      inv:=legacy_calendar_current_inventory_material(src);ctx:=legacy_calendar_bounds_related(src.id);
      complete:=inv->>'completeness';reason:=inv->>'reason';
      if not legacy_calendar_present(src) then complete:='unknown';reason:='source_changed';end if;
      if exists(select 1 from legacy_day_groups g where g.day_id=any(legacy_calendar_bounds_ids(ctx->'dayIds'))
        and(g.classification='opaque' or cardinality(g.legacy_candidates)>0 or g.wedding_id is distinct from src.wedding_id))
        or exists(select 1 from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) d cross join lateral legacy_day_known_holders(d) k
          where k.wedding_id is distinct from src.wedding_id) then complete:='unknown';reason:='mixed_scope';end if;
      original_date:=(src.origin->>'date')::date;
      if src.kind='app_root' then
        select case when count(distinct b.date)=1 then min(b.date) else null end into original_date
          from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) day(day_id) join vendor_busy_dates b on b.id=day.day_id
          where exists(select 1 from legacy_day_known_holders(b.id) k where k.deal_id=src.root_deal_id and k.wedding_id=src.wedding_id);
      end if;
      select v.user_id,v.blocked_at is null and u.deleted_at is null into owner,available from vendors v join users u on u.id=v.user_id where v.id=src.vendor_id;
      select mode,revision::text into policy_mode,policy_revision from vendor_availability_policy where vendor_id=src.vendor_id;
      person_scope:=legacy_calendar_bounds_known_person_scope(src.vendor_id);holders:='[]';
      for holder in select value from jsonb_array_elements(inv->'holders') order by value->>'weddingId',value->>'dealId' loop
        select jsonb_build_object(
          'parts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'version',p.version::text,'assignmentId',p.assignment_id,'details',p.details) order by p.id)
            from order_parts p where p.wedding_id=(holder->>'weddingId')::uuid and p.deal_id=(holder->>'dealId')::uuid and p.cancelled_at is null),'[]'),
          'plan',coalesce(legacy_calendar_adoption_calendar_projection((holder->>'weddingId')::uuid,(holder->>'dealId')::uuid)->'plan',(select jsonb_build_object('id',p.id,'version',p.version::text,'privateDigest',p.private_digest,'lines',
            (select coalesce(jsonb_agg(x.value-'label' order by x.ordinality),'[]') from jsonb_array_elements(p.private_snapshot->'lines') with ordinality x(value,ordinality)))
            from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id where o.wedding_id=(holder->>'weddingId')::uuid and o.deal_id=(holder->>'dealId')::uuid)),
          'allocations',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'originVersionId',a.origin_version_id,'originLineIndex',a.origin_line_index,'resourceId',a.resource_id,
            'windowId',a.capacity_window_id,'kind',a.kind,'identity',a.conflict_identity,'quantity',a.quantity,'startsAt',a.occupied_starts_at,'endsAt',a.occupied_ends_at) order by a.id)
            from resource_allocations a where a.wedding_id=(holder->>'weddingId')::uuid and a.deal_id=(holder->>'dealId')::uuid and a.released_at is null
              and not legacy_calendar_adopted_version(a.deal_id,a.origin_version_id)),'[]'),
          'relatedSources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'material',legacy_calendar_current_inventory_material(s)) order by s.id)
            from legacy_calendar_sources s where s.id=any(legacy_calendar_bounds_ids(ctx->'sourceIds'))),'[]')) into inputs;
        holders:=holders||jsonb_build_array(jsonb_build_object('weddingId',holder->'weddingId','dealId',holder->'dealId','slotId',holder->'slot'->'id',
          'orderVersion',holder->'order'->'version','holderSnapshot',holder,'holderFingerprint',legacy_calendar_bounds_fingerprint(holder),'calendarInputs',inputs));
      end loop;
      if jsonb_array_length(holders)>128 then perform legacy_calendar_bounds_fail('Holder limit exceeded','legacy_calendar_bounds_scope');end if;
      return jsonb_build_object('encoding','legacy-calendar-bounds-source/1','sourceId',src.id,'kind',src.kind,'vendorId',src.vendor_id,
        'weddingId',src.wedding_id,'companyId',src.company_id,'originDate',original_date,'sourceRevision',
        case when src.day_id is null then '0' else coalesce((select source_revision::text from vendor_busy_dates where id=src.day_id),'0') end,
        'scopeCompleteness',complete,'unavailableReason',reason,'inventoryMaterial',inv,'holders',holders,'context',ctx,'personScope',person_scope,
        'vendorOwnerId',owner,'ownerAvailable',coalesce(available,false),'policyMode',coalesce(policy_mode,'legacy_day'),'policyRevision',coalesce(policy_revision,'0'));
    end $$;
  `)
  // Follow only scoped, strictly decreasing immutable version edges to the exact
  // adoption proof and resolution. Pending descendant origins are used only for
  // allocation projection; existing deferred graph guards still require a head.
  pgm.sql(String.raw`
    create function legacy_calendar_adopted_version(p_deal_id uuid,p_version_id uuid) returns boolean language sql stable as $$
      with recursive ancestry as(
        select id,wedding_id,deal_id,vendor_id,revision,previous_version_id,terms_id,plan_revision_id,action,state,legacy_adoption_proof_id
          from deal_resource_commitment_versions where id=p_version_id and deal_id=p_deal_id
        union all
        select v.id,v.wedding_id,v.deal_id,v.vendor_id,v.revision,v.previous_version_id,v.terms_id,v.plan_revision_id,v.action,v.state,v.legacy_adoption_proof_id
          from ancestry child join deal_resource_commitment_versions v on v.id=child.previous_version_id
            and v.wedding_id=child.wedding_id and v.deal_id=child.deal_id
            and v.vendor_id is not distinct from child.vendor_id and v.revision=child.revision-1
      )
      select exists(select 1 from ancestry v
        join legacy_calendar_adoption_proofs p on p.id=v.legacy_adoption_proof_id and p.commitment_version_id=v.id
          and p.wedding_id=v.wedding_id and p.deal_id=v.deal_id and p.terms_id=v.terms_id and p.plan_revision_id=v.plan_revision_id
        join legacy_calendar_resolution_events e on e.source_id=p.source_id and e.bounds_version_id=p.bounds_version_id
          and e.action='adopted' and e.material is not distinct from legacy_calendar_bounds_adoption_material(p.id)
        where v.revision=1 and v.action='adopt' and v.state='reserved' and v.previous_version_id is null)
    $$;
    create function legacy_calendar_adopted_commitment(p_deal_id uuid) returns boolean language sql stable as $$
      select exists(select 1 from deal_resource_commitments c
        join deal_resource_commitment_versions v on v.id=c.current_version_id and v.wedding_id=c.wedding_id and v.deal_id=c.deal_id
          and v.revision=c.revision and v.state=c.state
        where c.deal_id=p_deal_id and legacy_calendar_adopted_version(c.deal_id,v.id))
    $$;
    create function legacy_calendar_adoption_calendar_projection(p_wedding_id uuid,p_deal_id uuid) returns jsonb language plpgsql stable as $$
    declare origin legacy_calendar_adoption_proofs%rowtype;
      original_plan deal_resource_plan_versions%rowtype;current_plan deal_resource_plan_versions%rowtype;
      order_row deal_orders%rowtype;original_order jsonb;pair record;current_vendor uuid;
    begin
      if not legacy_calendar_adopted_commitment(p_deal_id) then return null;end if;
      with recursive chain as(
        select v.id,v.wedding_id,v.deal_id,v.vendor_id,v.revision,v.previous_version_id,v.legacy_adoption_proof_id
          from deal_resource_commitments c join deal_resource_commitment_versions v
            on v.id=c.current_version_id and v.wedding_id=c.wedding_id and v.deal_id=c.deal_id and v.revision=c.revision and v.state=c.state
          where c.wedding_id=p_wedding_id and c.deal_id=p_deal_id
        union all
        select v.id,v.wedding_id,v.deal_id,v.vendor_id,v.revision,v.previous_version_id,v.legacy_adoption_proof_id
          from chain child join deal_resource_commitment_versions v on v.id=child.previous_version_id
            and v.wedding_id=child.wedding_id and v.deal_id=child.deal_id and v.vendor_id is not distinct from child.vendor_id
            and v.revision=child.revision-1
      )
      select p.* into origin from chain v join legacy_calendar_adoption_proofs p
        on p.id=v.legacy_adoption_proof_id and p.commitment_version_id=v.id and p.wedding_id=v.wedding_id and p.deal_id=v.deal_id
        where v.revision=1 and v.previous_version_id is null;
      if not found then return null;end if;
      select * into order_row from deal_orders where wedding_id=p_wedding_id and deal_id=p_deal_id;
      if not found then return null;end if;
      select * into original_plan from deal_resource_plan_versions
        where id=origin.plan_revision_id and wedding_id=p_wedding_id and deal_id=p_deal_id;
      if not found then return null;end if;
      select * into current_plan from deal_resource_plan_versions
        where id=order_row.resource_plan_id and wedding_id=p_wedding_id and deal_id=p_deal_id;
      if not found or current_plan.id=original_plan.id or current_plan.vendor_id is distinct from original_plan.vendor_id
        or current_plan.version<=original_plan.version or order_row.version<>current_plan.source_order_version then return null;end if;
      select vendor_id into current_vendor from deals where wedding_id=p_wedding_id and id=p_deal_id;
      if current_vendor is null or current_plan.vendor_id is distinct from current_vendor then return null;end if;
      select snapshot->'order' into original_order from legacy_calendar_version_holders
        where version_id=origin.source_version_id and wedding_id=p_wedding_id and deal_id=p_deal_id;
      if jsonb_typeof(original_order) is distinct from 'object'
        or original_order->>'resourcePlanId' is distinct from original_plan.id::text
        or coalesce(original_order->>'version','') !~ '^[1-9][0-9]{0,18}$' then return null;end if;
      -- Every intervening order version must be exactly a plan revision, not a
      -- hidden edit before/after the final plan. Other holder fields stay live.
      if order_row.version::numeric is distinct from (original_order->>'version')::numeric+current_plan.version-original_plan.version then return null;end if;
      if (original_plan.private_snapshot-'lines') is distinct from (current_plan.private_snapshot-'lines')
        or jsonb_typeof(original_plan.private_snapshot->'lines') is distinct from 'array'
        or jsonb_typeof(current_plan.private_snapshot->'lines') is distinct from 'array' then return null;end if;
      if jsonb_array_length(original_plan.private_snapshot->'lines')=0
        or jsonb_array_length(original_plan.private_snapshot->'lines')<>jsonb_array_length(current_plan.private_snapshot->'lines') then return null;end if;
      for pair in select a.line old_line,b.line new_line
        from jsonb_array_elements(original_plan.private_snapshot->'lines') with ordinality a(line,n)
        join jsonb_array_elements(current_plan.private_snapshot->'lines') with ordinality b(line,n) using(n) loop
        if jsonb_typeof(pair.old_line) is distinct from 'object' or jsonb_typeof(pair.new_line) is distinct from 'object'
          or coalesce(pair.old_line->>'kind','') not in('equipment','person','capacity') then return null;end if;
        if (select array_agg(k order by k) from jsonb_object_keys(pair.old_line) keys(k)) is distinct from
          (select array_agg(k order by k) from jsonb_object_keys(pair.new_line) keys(k)) then return null;end if;
        if pair.old_line->>'kind'='equipment' and pair.new_line->>'kind'='equipment' then
          if (pair.old_line-array['resourceId','conflictIdentity','label']) is distinct from
            (pair.new_line-array['resourceId','conflictIdentity','label']) then return null;end if;
          if not exists(select 1 from vendor_resources r where r.id::text=pair.new_line->>'resourceId'
            and r.vendor_id=current_vendor and r.kind='equipment' and r.conflict_identity::text=pair.new_line->>'conflictIdentity') then return null;end if;
        elsif pair.old_line is distinct from pair.new_line then return null;
        end if;
      end loop;
      return jsonb_build_object('order',original_order,'plan',jsonb_build_object('id',original_plan.id,'version',original_plan.version::text,
        'privateDigest',original_plan.private_digest,'lines',(select coalesce(jsonb_agg(x.value-'label' order by x.ordinality),'[]')
          from jsonb_array_elements(original_plan.private_snapshot->'lines') with ordinality x(value,ordinality))));
    end $$;

    create or replace function legacy_day_assert_root(root_id uuid) returns void language plpgsql as $$
    declare v deal_day_scope_versions%rowtype;
    begin
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=$1;
      if not found or not exists(select 1 from deals where id=$1) then return; end if;
      if v.operation='retain_done' and v.binding_state='external'
        and not exists(select 1 from deals d where d.id=root_id
          and d.wedding_id=v.wedding_id and d.state='done') then
        raise exception 'External retained head requires a completed root'
          using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if not deal_day_scope_matches_current(v) and not
        (not legacy_day_version_new(v.id) and (legacy_day_erased_catalog(v)
          or (v.binding_state in ('unknown','external') and exists(select 1 from deals d where d.id=$1 and d.state='done')))) then
        raise exception 'Managed root requires a final current tuple' using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if v.binding_state in ('active','done_retained') and exists(select 1 from deal_resource_commitments c
        where c.deal_id=$1 and c.revision>0) and not legacy_calendar_adopted_commitment(root_id) then
        raise exception 'Resource agreement cannot become a legacy DATE holder'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
    end $$;
  `)
  // The adopted root stays a proven legacy DATE holder: a proved adopt head is not a new
  // financial freshness gate for day-scope and source-presence guards.
  pgm.sql(String.raw`
    create or replace function legacy_day_known_holders(target uuid) returns setof deal_day_scope_versions language sql stable as $$
      select v.* from deal_day_scope_heads h join deal_day_scope_versions v
        on v.id=h.current_version_id and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
      join vendor_busy_dates b on b.id=v.day_id and b.vendor_id=v.vendor_id and b.date=v.service_date and b.source='deal'
      where b.id=target and v.binding_state in ('active','done_retained')
        and legacy_day_tuple_current(v)
        and (not exists(select 1 from deal_resource_commitments c where c.deal_id=v.deal_id and c.revision>0)
          or legacy_calendar_adopted_commitment(v.deal_id))
    $$;
    create or replace function legacy_day_group_wedding(target uuid) returns uuid language sql stable as $$
      select p.wedding_id from vendor_busy_dates b join deals p on p.id=b.deal_id
        join weddings w on w.id=p.wedding_id
      where b.id=target and b.source='deal' and p.vendor_id=b.vendor_id and p.state in ('booked','paid_deposit','done')
        and not exists(select 1 from legacy_calendar_sources s where s.day_id=b.id and s.kind='app_day'
          and s.wedding_id is distinct from p.wedding_id)
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where v.day_id=b.id and v.wedding_id is distinct from p.wedding_id)
        and (not exists(select 1 from deal_resource_commitments c where c.deal_id=p.id and c.revision>0)
          or legacy_calendar_adopted_commitment(p.id))
    $$;
    create or replace function legacy_calendar_present(source legacy_calendar_sources) returns boolean language plpgsql stable as $$
    declare mat jsonb; wedding_row weddings%rowtype;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        return exists(select 1 from vendor_busy_dates where id=source.day_id);
      end if;
      mat := legacy_calendar_current_inventory_material(source);
      if not exists(select 1 from deals d where d.id=source.root_deal_id and d.wedding_id=source.wedding_id
        and d.vendor_id=source.vendor_id and ((source.kind='app_root' and d.state in ('booked','paid_deposit','done')
          and (not exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0)
            or legacy_calendar_adopted_commitment(d.id)))
          or (source.kind='live_negotiation' and d.state='negotiating'))) then return false; end if;
      if source.kind<>'live_negotiation' then return true; end if;
      if (mat->'negotiation'->>'negotiatingUntil') is null then return false; end if;
      if (mat->'negotiation'->>'negotiatingUntil')::timestamptz<=clock_timestamp() then return false; end if;
      if (mat->'negotiation'->>'weddingArchived')::boolean or (mat->'negotiation'->>'weddingCancelled')::boolean then return false; end if;
      return true;
    end $$;
  `)
  // A head with proven adoption ancestry keeps reading
  // as its pre-adoption self: commitmentRevision stays '0' and the app_root origin stays
  // rooted. Without this mask the first group adoption would stale the source fingerprint
  // and block every sibling holder (RA372-P05).
  pgm.sql(String.raw`
    create or replace function legacy_calendar_holder(p_wedding_id uuid, p_deal_id uuid) returns jsonb language sql stable as $$
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
        'order',coalesce(legacy_calendar_adoption_calendar_projection(d.wedding_id,d.id)->'order',(select jsonb_build_object('version',o.version::text,'resourcePlanRevision',o.resource_plan_revision::text,
            'resourcePlanId',case when o.resource_plan_id is null then null else lower(o.resource_plan_id::text) end)
          from deal_orders o where o.wedding_id=d.wedding_id and o.deal_id=d.id)),
        'economics',jsonb_build_object('price',case when d.price is null then null else d.price::text end,
          'currency',d.currency,'packageId',case when d.package_id is null then null else lower(d.package_id::text) end),
        'commitmentRevision',case when legacy_calendar_adopted_commitment(d.id) then '0'
          else coalesce((select c.revision::text from deal_resource_commitments c where c.deal_id=d.id),'0') end,
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
    create or replace function legacy_calendar_inventory_material(source legacy_calendar_sources) returns jsonb language plpgsql stable as $$
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
              and (coalesce((select c.revision from deal_resource_commitments c where c.deal_id=root_deal.id),0)=0
                or legacy_calendar_adopted_commitment(root_deal.id)))
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
  `)
  // protect_legacy_calendar_bounds_history gains the 'adopted' resolution branch; every other branch is byte-identical to schema94.
  pgm.sql(String.raw`
    create or replace function protect_legacy_calendar_bounds_history() returns trigger language plpgsql as $$
    declare n jsonb;o jsonb;v legacy_calendar_bounds_versions%rowtype;h legacy_calendar_bounds_holders%rowtype;s legacy_calendar_sources%rowtype;
      head legacy_calendar_bounds_heads%rowtype;event legacy_calendar_resolution_events%rowtype;captured legacy_calendar_version_holders%rowtype;
      material jsonb;part jsonb;expected jsonb;field text;parent_table text;parent_exists boolean;available boolean;erasure_update boolean:=false;
    begin
      if TG_OP='DELETE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' and
          ((o->>'wedding_id' is not null and not exists(select 1 from weddings where id=(o->>'wedding_id')::uuid)) or
           (o->>'company_id' is not null and not exists(select 1 from vendors where id=(o->>'company_id')::uuid))) then return OLD;end if;
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_holders' or TG_TABLE_NAME='legacy_calendar_bounds_spans' or TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then parent_table:='legacy_calendar_bounds_versions';field:='bounds_version_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then parent_table:='legacy_calendar_bounds_holders';field:='holder_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_events' or TG_TABLE_NAME='legacy_calendar_bounds_heads' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then parent_table:='legacy_calendar_resolution_events';field:='event_id';
        elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then parent_table:='weddings';field:='wedding_id';
        else perform legacy_calendar_bounds_fail('Evidence cannot be directly deleted','legacy_calendar_bounds_immutable');end if;
        execute format('select exists(select 1 from %I where %I=$1)',parent_table,case when parent_table='legacy_calendar_sources' then 'id' else 'id' end)
          into parent_exists using (o->>field)::uuid;
        if parent_exists then perform legacy_calendar_bounds_fail('Evidence may disappear only with its actual parent','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      n:=to_jsonb(NEW);
      if TG_OP='UPDATE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
          if n=o then return NEW;end if;
          if NEW.source_id<>OLD.source_id or NEW.revision<>OLD.revision+1 then perform legacy_calendar_bounds_fail('Bounds head must advance one revision');end if;
          if NEW.proposed_version_id is distinct from OLD.proposed_version_id then
            select * into v from legacy_calendar_bounds_versions where id=NEW.proposed_version_id and source_id=NEW.source_id;
            if not found or v.version<>OLD.proposed_version+1 or v.previous_version_id is distinct from OLD.proposed_version_id
              or NEW.proposed_version<>v.version or NEW.effective_event_id is distinct from OLD.effective_event_id then perform legacy_calendar_bounds_fail('Proposal head ancestry mismatch');end if;
          else
            select * into event from legacy_calendar_resolution_events where id=NEW.effective_event_id and source_id=NEW.source_id;
            if not found or event.action<>'activate' or event.bounds_version_id is distinct from NEW.proposed_version_id or NEW.proposed_version<>OLD.proposed_version
              or event.transaction_id<>txid_current() or event.backend_pid<>pg_backend_pid() then perform legacy_calendar_bounds_fail('Effective head requires native activation');end if;
          end if;
          NEW.updated_at:=clock_timestamp();return NEW;
        end if;
        -- History updates only perform actual users/sessions FK erasure nulling.
        for field,parent_table in select * from(values('created_by','users'),('created_session_id','sessions'),('user_id','users'),('session_id','sessions'),('actor_id','users')) x(f,t) loop
          if n ? field and o->field is distinct from n->field then
            if o->field='null'::jsonb or n->field<>'null'::jsonb then perform legacy_calendar_bounds_fail('History identity is immutable');end if;
            execute format('select exists(select 1 from %I where id=$1)',parent_table) into available using (o->>field)::uuid;
            if available then perform legacy_calendar_bounds_fail('History nulling requires actual parent erasure');end if;
            erasure_update:=true;
          end if;
          n:=n-field;o:=o-field;
        end loop;
        if not erasure_update or n is distinct from o then perform legacy_calendar_bounds_fail('Bounds evidence is immutable','legacy_calendar_bounds_immutable');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
        if NEW.revision<>0 or NEW.proposed_version<>0 or NEW.proposed_version_id is not null or NEW.effective_event_id is not null then perform legacy_calendar_bounds_fail('Initial bounds head is empty');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.created_by,'sessionId',NEW.created_session_id,'policyVersion',NEW.policy_version)));
        select * into s from legacy_calendar_sources where id=NEW.source_id;
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        material:=legacy_calendar_bounds_material(NEW.source_id,NEW.inventory_version_id,NEW.declaration);
        if NEW.wedding_id is distinct from s.wedding_id or NEW.company_id is distinct from s.company_id or NEW.version<>head.proposed_version+1
          or NEW.previous_version_id is distinct from head.proposed_version_id or NEW.canonical is distinct from material::text
          or NEW.source_fingerprint is distinct from material->>'sourceFingerprint'
          or NEW.source_revision::text is distinct from legacy_calendar_bounds_source_material(s.id)->>'sourceRevision'
          or NEW.inventory_revision::text is distinct from material->'inventory'->>'revision' or NEW.inventory_digest is distinct from material->'inventory'->>'digest'
          or NEW.association_fingerprint is distinct from legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_known_person_scope(s.vendor_id))
          or NEW.staffing_completeness is distinct from NEW.declaration->'staffing'->>'completeness'
          or not legacy_calendar_bounds_principal_current(s.id,null,null,'performer',NEW.created_by,NEW.created_session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Proposal must equal exact current owner material');end if;
        NEW.created_at:=clock_timestamp();return NEW;
      end if;
      if n ? 'bounds_version_id' and n->>'bounds_version_id' is not null then
        select * into v from legacy_calendar_bounds_versions where id=(n->>'bounds_version_id')::uuid;
        if not found then perform legacy_calendar_bounds_fail('Proposal parent missing');end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_holders' then
        select * into captured from legacy_calendar_version_holders where version_id=v.inventory_version_id and wedding_id=NEW.wedding_id and deal_id=NEW.deal_id;
        select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=NEW.wedding_id::text and value->>'dealId'=NEW.deal_id::text;
        if captured.version_id is null or part is null or NEW.source_id<>v.source_id or NEW.inventory_version_id<>v.inventory_version_id
          or NEW.holder_snapshot is distinct from captured.snapshot or NEW.holder_fingerprint<>captured.fingerprint or NEW.slot_id::text is distinct from captured.snapshot->'slot'->>'id'
          or NEW.day_version_id is distinct from(captured.snapshot#>>'{dayScope,version,id}')::uuid
          or NEW.expected_order_version::text is distinct from part->>'expectedOrderVersion' or NEW.outcome is distinct from part->>'outcome' or NEW.closure_reason is distinct from part->>'closureReason'
          or NEW.wedding_id is distinct from v.wedding_id then perform legacy_calendar_bounds_fail('Bounds holder must equal captured exact holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_spans' then
        if NEW.holder_id is null then part:=v.declaration->'manualBounds';
          if v.company_id is null then perform legacy_calendar_bounds_fail('Manual span in app proposal');end if;
        else
          select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
          select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=h.wedding_id::text and value->>'dealId'=h.deal_id::text;
        end if;
        expected:=part->'spans'->NEW.span_index;
        if expected is null or legacy_calendar_bounds_span_json(NEW) is distinct from expected
          or NEW.original_date is distinct from legacy_calendar_bounds_span_original_date(v.source_id,NEW.holder_id,expected)
          or legacy_calendar_bounds_span_valid(expected,NEW.original_date) is not true then perform legacy_calendar_bounds_fail('Span must equal native accepted declaration');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then
        if not v.declaration->'staffing'->'personIds' @> to_jsonb(array[NEW.person_identity])
          or NEW.context_material is distinct from legacy_calendar_bounds_known_person_scope((v.canonical::jsonb->>'vendorId')::uuid) then perform legacy_calendar_bounds_fail('Person scope must equal observed conservative context');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        select * into head from legacy_calendar_bounds_heads where source_id=v.source_id;
        expected:=jsonb_build_object('purpose','calendar-bounds-read','sourceId',v.source_id,'inventoryVersionId',v.inventory_version_id,'boundsVersionId',v.id,'version',v.version::text,'digest',v.digest,
          'weddingId',h.wedding_id,'dealId',h.deal_id,'userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version,'iss','tili-tili','aud','calendar-bounds-read','iat',NEW.read_iat,'exp',NEW.read_exp);
        if h.id is null or NEW.source_id<>v.source_id or head.proposed_version_id is distinct from v.id or NEW.digest<>v.digest or NEW.read_claims is distinct from expected
          or NEW.read_iat>floor(extract(epoch from clock_timestamp())) or NEW.read_exp<=floor(extract(epoch from clock_timestamp()))
          or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,NEW.party,NEW.user_id,NEW.session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Receipt requires current exact read proof and party');end if;
        NEW.accepted_at:=clock_timestamp();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_events' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id)));
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        if NEW.previous_event_id is distinct from head.effective_event_id then perform legacy_calendar_bounds_fail('Resolution ancestry mismatch');end if;
        if NEW.action='activate' then
          if NEW.material is distinct from legacy_calendar_bounds_activation_material(v.id,NEW.policy_version) or legacy_calendar_bounds_agreed(v.id,NEW.policy_version) is not true
            or (not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',NEW.actor_id,NEW.session_id,NEW.policy_version)
              and not exists(select 1 from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id and legacy_calendar_bounds_principal_current(v.source_id,x.wedding_id,x.deal_id,'customer',NEW.actor_id,NEW.session_id,NEW.policy_version))) then
            perform legacy_calendar_bounds_fail('Activation requires real current whole proof');end if;
        elsif NEW.action='holder_cancelled' then
          if not exists(select 1 from legacy_calendar_bounds_holders x join deals d on d.id=x.deal_id and d.wedding_id=x.wedding_id
            where x.bounds_version_id=v.id and d.state='cancelled' and NEW.material->>'dealId'=d.id::text) then perform legacy_calendar_bounds_fail('Cancellation resolution requires actual own cancelled holder');end if;
        elsif NEW.action='negotiation_committed' then
          if not exists(select 1 from legacy_calendar_sources source join legacy_calendar_initial_commit_witnesses w on w.deal_id=source.root_deal_id
            join deal_resource_commitments ch on ch.deal_id=w.deal_id join deal_resource_commitment_versions cv on cv.id=ch.current_version_id
            where source.id=NEW.source_id and source.kind='live_negotiation' and NEW.material->>'witnessId'=w.id::text
              and NEW.material->>'commitmentVersionId'=cv.id::text and cv.revision=1 and cv.action='commit' and legacy_calendar_bounds_initial_current(w.id,w.deal_id)) then
            perform legacy_calendar_bounds_fail('Negotiation resolution requires actual initial conversion');end if;
        elsif NEW.action='adopted' then
          if NEW.bounds_version_id is null or NEW.material is distinct from legacy_calendar_bounds_adoption_material((NEW.material->>'proofId')::uuid)
            or not exists(select 1 from legacy_calendar_adoption_proofs p where p.id=(NEW.material->>'proofId')::uuid
              and p.source_id=NEW.source_id and p.bounds_version_id=NEW.bounds_version_id
              and p.transaction_id=txid_current() and p.backend_pid=pg_backend_pid()
              and exists(select 1 from legacy_calendar_adoption_proofs own where own.id=p.id and legacy_day_transaction_owns(own.xmin))) then
            perform legacy_calendar_bounds_fail('Adoption resolution requires exact same-transaction proof');end if;
        elsif NEW.action in('source_stale','source_unavailable') then
          if v.id is not null and v.source_fingerprint=legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_source_material(NEW.source_id)) then
            perform legacy_calendar_bounds_fail('Unchanged source cannot be declared stale');end if;
        elsif NEW.action='superseded' then
          if not exists(select 1 from legacy_calendar_resolution_events e where e.id=(NEW.material->>'newEventId')::uuid and e.source_id=NEW.source_id
            and e.action='activate' and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid() and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version)) then perform legacy_calendar_bounds_fail('Supersession requires actual newly agreed activation');end if;
        else perform legacy_calendar_bounds_fail('Unknown resolution action');end if;
        NEW.created_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then
        select * into event from legacy_calendar_resolution_events where id=NEW.event_id;
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        expected:=jsonb_build_object('encoding','legacy-calendar-holder-resolution/1','holderId',h.id,'weddingId',h.wedding_id,'dealId',h.deal_id,'outcome',h.outcome,'boundsDigest',v.digest);
        if event.action<>'activate' or event.bounds_version_id<>v.id or NEW.source_id<>v.source_id or NEW.outcome<>h.outcome or NEW.material is distinct from expected then perform legacy_calendar_bounds_fail('Resolution member is not exact native holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(NEW.wedding_id),'actor',jsonb_build_object('userId',NEW.actor_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        if legacy_calendar_bounds_initial_preconditions(NEW.wedding_id,NEW.deal_id,NEW.vendor_id,NEW.terms_id,NEW.plan_revision_id,NEW.policy_revision,
          NEW.actor_id,NEW.session_id,NEW.policy_version,NEW.pending_state) is not true then
          perform legacy_calendar_bounds_fail('Witness is not a genuine initial pending context','legacy_calendar_initial_commit');end if;
        NEW.recorded_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      end if;
      return NEW;
    end $$;
  `)
  // check_legacy_calendar_bounds_complete gains the adopted-event COMMIT loop and the proof-table branch; the rest is byte-identical to schema94.
  pgm.sql(String.raw`
    create or replace function check_legacy_calendar_bounds_complete() returns trigger language plpgsql as $$
    declare v record;r record;e record;c record;h record;source jsonb;
    begin
      -- Only newly written proposal/read/activation evidence rechecks current auth/input.
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' and TG_OP='INSERT' then
        select x.* into v from legacy_calendar_bounds_versions x where x.id=NEW.id;
        if found then
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not exists(select 1 from legacy_calendar_bounds_heads hd where hd.source_id=v.source_id and hd.proposed_version>=v.version)
          or not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',v.created_by,v.created_session_id,v.policy_version)
          or (not exists(select 1 from legacy_calendar_bounds_heads hd where hd.proposed_version_id=v.id)
            and not exists(select 1 from legacy_calendar_bounds_versions nx where nx.source_id=v.source_id and nx.previous_version_id=v.id)) then perform legacy_calendar_bounds_fail('New proposal graph must finish complete/current');end if;
        end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_receipts' and TG_OP='INSERT' then
        select x.* into r from legacy_calendar_bounds_receipts x where x.id=NEW.id;
        if found then
        select * into h from legacy_calendar_bounds_holders where id=r.holder_id;
        select * into v from legacy_calendar_bounds_versions where id=r.bounds_version_id;
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,r.party,r.user_id,r.session_id,r.policy_version) then perform legacy_calendar_bounds_fail('New receipt must finish with current exact party/material');end if;
        end if;
      end if;
      for e in select id from legacy_calendar_resolution_events where action='activate' and transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_applied(e.id);end loop;
      for e in select id from legacy_calendar_resolution_events where action='adopted' and transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_adopted(e.id);end loop;
      if TG_TABLE_NAME='resource_occupancy_origin_certificates' then
        perform legacy_calendar_bounds_assert_certificate(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(OLD.certificate_id);end if;
        if TG_OP<>'DELETE' and NEW.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(NEW.certificate_id);end if;
      end if;
      if TG_TABLE_NAME='resource_allocations' then
        perform legacy_calendar_bounds_assert_mirror(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(OLD.allocation_id);end if;
        if TG_OP<>'DELETE' and NEW.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(NEW.allocation_id);end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_adoption_proofs' then
        perform legacy_calendar_bounds_assert_adoption(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      end if;
      for e in select id from legacy_calendar_initial_commit_witnesses where transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_initial(e.id);end loop;
      -- Old committed proofs become conservatively stale, never rejected just for logout/input evolution.
      -- No live FK/source loss ever releases retained certificates.
      return null;
    end $$;
    create trigger protect_legacy_calendar_adoption_proof before insert or update or delete on legacy_calendar_adoption_proofs
      for each row execute function protect_legacy_calendar_adoption_proof();
    create constraint trigger check_legacy_calendar_bounds_complete after insert or update or delete on legacy_calendar_adoption_proofs
      deferrable initially deferred for each row execute function check_legacy_calendar_bounds_complete();
  `)
}

exports.down = pgm => {
  pgm.sql(String.raw`
    set local lock_timeout='5s';
    lock table legacy_calendar_adoption_proofs,deal_resource_commitment_versions,legacy_calendar_resolution_events in access exclusive mode;
    do $$ begin
      if exists(select 1 from legacy_calendar_adoption_proofs)
        or exists(select 1 from deal_resource_commitment_versions where action='adopt' or legacy_adoption_proof_id is not null)
        or exists(select 1 from legacy_calendar_resolution_events where action='adopted')
        or exists(select 1 from deal_terms_versions where snapshot->>'schemaVersion'='3') then
        raise exception 'adoption evidence exists; use preserving forward migration' using errcode='23514',constraint='legacy_calendar_adoption_preserving_down';
      end if;
    end $$;
    drop trigger check_legacy_calendar_bounds_complete on legacy_calendar_adoption_proofs;
    drop trigger protect_legacy_calendar_adoption_proof on legacy_calendar_adoption_proofs;
    alter table deal_resource_commitment_versions drop constraint deal_resource_commitment_versions_adoption_proof;
    alter table deal_resource_commitment_versions
      drop constraint deal_resource_commitment_versions_action_check,
      drop constraint deal_resource_commitment_versions_state_reason_check,
      drop constraint deal_resource_commitment_versions_adoption_proof_check;
    alter table legacy_calendar_resolution_events drop constraint legacy_calendar_resolution_events_action_check;
    alter table deal_resource_commitment_versions drop column legacy_adoption_proof_id;
    alter table deal_resource_commitment_versions
      add check(action in ('commit','replace','release')),
      add check((action='release' and state='released' and reason is not null) or
        (action in ('commit','replace') and state='reserved' and reason is null));
    alter table legacy_calendar_resolution_events
      add check(action in('activate','holder_cancelled','source_unavailable','source_stale','superseded','negotiation_committed'));
    alter table deal_terms_versions drop constraint resource_plan_terms_format;
    alter table deal_terms_versions add constraint resource_plan_terms_format check(
      (snapshot->>'schemaVersion'='1' and resource_plan_id is null) or
      (snapshot->>'schemaVersion'='2' and resource_plan_id is not null
        and snapshot->'resourcePlan'->>'planRevisionId'=resource_plan_id::text));
  `)
  // Restore the exact schema94 bodies of every create-or-replaced function.
  pgm.sql(String.raw`
    create or replace function protect_resource_commitment_version() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;t deal_terms_versions%rowtype;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'commitment evidence can only be erased with wedding' using errcode='23514';
        end if;return OLD;
      end if;
      if TG_OP='UPDATE' then
        if (to_jsonb(NEW)-'created_by')<>(to_jsonb(OLD)-'created_by') or
          (NEW.created_by is distinct from OLD.created_by and not(OLD.created_by is not null and NEW.created_by is null
            and not exists(select 1 from users where id=OLD.created_by))) then
          raise exception 'commitment evidence is immutable' using errcode='23514';
        end if;return NEW;
      end if;
      select * into h from deal_resource_commitments where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id for update;
      if not found or NEW.revision<>h.revision+1 or NEW.previous_version_id is distinct from h.current_version_id then
        raise exception 'commitment requires next scoped head revision' using errcode='23514';
      end if;
      select * into t from deal_terms_versions where wedding_id=NEW.wedding_id and deal_id=NEW.deal_id and id=NEW.terms_id;
      if not found or t.resource_plan_id is distinct from NEW.plan_revision_id or
        not exists(select 1 from deal_resource_plan_versions p where p.wedding_id=NEW.wedding_id and p.deal_id=NEW.deal_id
          and p.id=NEW.plan_revision_id and p.vendor_id=NEW.vendor_id) then
        raise exception 'commitment requires exact scoped accepted resource plan' using errcode='23514';
      end if;
      if NEW.action='release' then
        if h.state<>'reserved' or not exists(select 1 from deal_resource_commitment_versions v where v.id=h.current_version_id
          and v.terms_id=NEW.terms_id and v.plan_revision_id=NEW.plan_revision_id and v.vendor_id=NEW.vendor_id
          and v.policy_revision=NEW.policy_revision) then
          raise exception 'release retains previous accepted proof' using errcode='23514';
        end if;
      elsif not exists(select 1 from deal_orders o where o.wedding_id=NEW.wedding_id and o.deal_id=NEW.deal_id
        and o.proposed_terms_id=NEW.terms_id and o.agreed_terms_id=NEW.terms_id and o.resource_plan_id=NEW.plan_revision_id) then
        raise exception 'commitment requires current agreed head' using errcode='23514';
      end if;
      if (NEW.action='commit' and h.revision<>0) or (NEW.action='replace' and h.state<>'reserved') then
        raise exception 'invalid commitment transition' using errcode='23514';
      end if;
      return NEW;
    end $$;
    create or replace function check_resource_commitment_proof() returns trigger language plpgsql as $$
    begin
      if NEW.action<>'release' then
        if not exists(select 1 from deals d join vendor_availability_policy p on p.vendor_id=d.vendor_id
          where d.wedding_id=NEW.wedding_id and d.id=NEW.deal_id and d.vendor_id=NEW.vendor_id
            and p.mode='resources' and p.revision=NEW.policy_revision
            and ((NEW.action='commit' and d.state in ('candidate','contacted','negotiating')) or
              (NEW.action='replace' and d.state in ('booked','paid_deposit')))) or
          not exists(select 1 from deal_terms_receipts c join deal_terms_receipts v
            on v.wedding_id=c.wedding_id and v.deal_id=c.deal_id and v.terms_id=c.terms_id
            join deal_terms_versions t on t.wedding_id=c.wedding_id and t.deal_id=c.deal_id and t.id=c.terms_id
            where c.wedding_id=NEW.wedding_id and c.deal_id=NEW.deal_id and c.terms_id=NEW.terms_id
              and c.party='customer' and v.party='performer' and c.user_id<>v.user_id
              and c.session_id<>v.session_id and c.digest=t.digest and v.digest=t.digest) then
          raise exception 'booking requires exact company policy and distinct accepted proof' using errcode='23514';
        end if;
      elsif NEW.reason='deal_cancelled' then
        if not exists(select 1 from deals where wedding_id=NEW.wedding_id and id=NEW.deal_id and state='cancelled') then
          raise exception 'release requires actual financial cancellation' using errcode='23514';
        end if;
      elsif NEW.reason='vendor_erased' then
        if not exists(select 1 from deals where wedding_id=NEW.wedding_id and id=NEW.deal_id
          and vendor_id is null and external_name='Удалённый подрядчик') then
          raise exception 'release requires actual vendor erasure transition' using errcode='23514';
        end if;
      elsif NEW.reason='wedding_erased' then
        if not exists(select 1 from weddings w join users owner on owner.id=w.owner_id where w.id=NEW.wedding_id
          and (w.archived_at is not null or w.cancelled_at is not null or
            (owner.deleted_at is not null and not exists(select 1 from wedding_members m join users heir on heir.id=m.user_id
              where m.wedding_id=w.id and m.role='couple' and m.user_id<>w.owner_id
                and (heir.deleted_at is null or heir.deleted_at>clock_timestamp()-interval '30 days'))))) then
          raise exception 'release requires eligible wedding erasure scope' using errcode='23514';
        end if;
      end if;return NEW;
    end $$;
    create or replace function check_resource_commitment_complete() returns trigger language plpgsql as $$
    declare h deal_resource_commitments%rowtype;v deal_resource_commitment_versions%rowtype;target uuid;n integer;
    begin
      target=coalesce(NEW.deal_id,OLD.deal_id);
      select * into h from deal_resource_commitments where deal_id=target;
      if not found then return null;end if;
      if TG_TABLE_NAME='deal_resource_commitment_versions' then
        if not exists(
        with recursive ancestry as (
          select id,previous_version_id from deal_resource_commitment_versions where id=h.current_version_id
          union all select p.id,p.previous_version_id from deal_resource_commitment_versions p join ancestry a on p.id=a.previous_version_id
        ) select 1 from ancestry where id=NEW.id) then
        raise exception 'orphan commitment version' using errcode='23514';
      end if;
      end if;
      if h.revision=0 then
        if exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'empty head has allocations' using errcode='23514';
        end if;return null;
      end if;
      select * into v from deal_resource_commitment_versions where id=h.current_version_id and wedding_id=h.wedding_id and deal_id=h.deal_id;
      if not found or v.revision<>h.revision or v.state<>h.state then
        raise exception 'invalid commitment head' using errcode='23514';
      end if;
      if h.state='released' then
        if exists(select 1 from deal_resource_commitment_members where version_id=v.id) or
          exists(select 1 from resource_allocations where deal_id=target and released_at is null) then
          raise exception 'released head retains live allocations' using errcode='23514';
        end if;
      else
        select jsonb_array_length(private_snapshot->'lines') into n from deal_resource_plan_versions where id=v.plan_revision_id;
        if n=0 or (select count(*) from deal_resource_commitment_members where version_id=v.id)<>n or
          (select count(*) from resource_allocations where deal_id=target and released_at is null)<>n or
          exists(select 1 from deal_resource_commitment_members m join resource_allocations a on a.id=m.allocation_id
            where m.version_id=v.id and (a.released_at is not null or m.line_index>=n)) or
          exists(select 1 from resource_allocations a where a.deal_id=target and a.released_at is null and
            not exists(select 1 from deal_resource_commitment_members m where m.version_id=v.id and m.allocation_id=a.id)) then
          raise exception 'current commitment membership incomplete' using errcode='23514';
        end if;
      end if;return null;
    end $$;
  `)
  pgm.sql(String.raw`
    create or replace function legacy_calendar_bounds_release_valid(p_occupancy resource_occupancy,p_event uuid,p_reason text) returns boolean language plpgsql stable as $$
    declare e legacy_calendar_resolution_events%rowtype;c resource_occupancy_origin_certificates%rowtype;line jsonb;owner uuid;
    begin
      select * into c from resource_occupancy_origin_certificates where id=p_occupancy.certificate_id;
      select * into e from legacy_calendar_resolution_events where id=p_event;
      if c.id is null or e.id is null or e.source_id<>c.source_identity or e.transaction_id<>txid_current() or e.backend_pid<>pg_backend_pid()
        or not exists(select 1 from legacy_calendar_resolution_events x where x.id=e.id and legacy_day_transaction_owns(x.xmin)) then return false;end if;
      if p_reason='superseded' then return e.action='activate' and e.bounds_version_id<>c.bounds_version_identity and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version);end if;
      if p_reason='negotiation_committed' then
        return e.action='negotiation_committed' and c.canonical::jsonb->>'sourceKind'='live_negotiation'
          and exists(select 1 from legacy_calendar_initial_commit_witnesses w join legacy_calendar_sources s on s.root_deal_id=w.deal_id
            where s.id=c.source_identity and e.material->>'witnessId'=w.id::text and legacy_calendar_bounds_initial_current(w.id,w.deal_id));
      end if;
      if p_reason='holder_cancelled' and e.action='holder_cancelled' then
        select x into line from jsonb_array_elements(c.canonical::jsonb->'lines') x where (x->>'lineIndex')::int=p_occupancy.origin_line_index;
        owner:=(line->>'ownerKey')::uuid;
        return exists(select 1 from jsonb_array_elements(c.canonical::jsonb->'ranges') r join deals d on d.id=(r->>'dealId')::uuid and d.wedding_id=(r->>'weddingId')::uuid
          where r->>'ownerKey'=owner::text and d.state='cancelled' and e.material->>'dealId'=d.id::text);
      end if;
      return false;
    end $$;
  `)
  pgm.sql(String.raw`
    create or replace function protect_legacy_calendar_bounds_history() returns trigger language plpgsql as $$
    declare n jsonb;o jsonb;v legacy_calendar_bounds_versions%rowtype;h legacy_calendar_bounds_holders%rowtype;s legacy_calendar_sources%rowtype;
      head legacy_calendar_bounds_heads%rowtype;event legacy_calendar_resolution_events%rowtype;captured legacy_calendar_version_holders%rowtype;
      material jsonb;part jsonb;expected jsonb;field text;parent_table text;parent_exists boolean;available boolean;erasure_update boolean:=false;
    begin
      if TG_OP='DELETE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' and
          ((o->>'wedding_id' is not null and not exists(select 1 from weddings where id=(o->>'wedding_id')::uuid)) or
           (o->>'company_id' is not null and not exists(select 1 from vendors where id=(o->>'company_id')::uuid))) then return OLD;end if;
        if TG_TABLE_NAME='legacy_calendar_bounds_versions' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_holders' or TG_TABLE_NAME='legacy_calendar_bounds_spans' or TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then parent_table:='legacy_calendar_bounds_versions';field:='bounds_version_id';
        elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then parent_table:='legacy_calendar_bounds_holders';field:='holder_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_events' or TG_TABLE_NAME='legacy_calendar_bounds_heads' then parent_table:='legacy_calendar_sources';field:='source_id';
        elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then parent_table:='legacy_calendar_resolution_events';field:='event_id';
        elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then parent_table:='weddings';field:='wedding_id';
        else perform legacy_calendar_bounds_fail('Evidence cannot be directly deleted','legacy_calendar_bounds_immutable');end if;
        execute format('select exists(select 1 from %I where %I=$1)',parent_table,case when parent_table='legacy_calendar_sources' then 'id' else 'id' end)
          into parent_exists using (o->>field)::uuid;
        if parent_exists then perform legacy_calendar_bounds_fail('Evidence may disappear only with its actual parent','legacy_calendar_bounds_immutable');end if;
        return OLD;
      end if;
      n:=to_jsonb(NEW);
      if TG_OP='UPDATE' then
        o:=to_jsonb(OLD);
        if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
          if n=o then return NEW;end if;
          if NEW.source_id<>OLD.source_id or NEW.revision<>OLD.revision+1 then perform legacy_calendar_bounds_fail('Bounds head must advance one revision');end if;
          if NEW.proposed_version_id is distinct from OLD.proposed_version_id then
            select * into v from legacy_calendar_bounds_versions where id=NEW.proposed_version_id and source_id=NEW.source_id;
            if not found or v.version<>OLD.proposed_version+1 or v.previous_version_id is distinct from OLD.proposed_version_id
              or NEW.proposed_version<>v.version or NEW.effective_event_id is distinct from OLD.effective_event_id then perform legacy_calendar_bounds_fail('Proposal head ancestry mismatch');end if;
          else
            select * into event from legacy_calendar_resolution_events where id=NEW.effective_event_id and source_id=NEW.source_id;
            if not found or event.action<>'activate' or event.bounds_version_id is distinct from NEW.proposed_version_id or NEW.proposed_version<>OLD.proposed_version
              or event.transaction_id<>txid_current() or event.backend_pid<>pg_backend_pid() then perform legacy_calendar_bounds_fail('Effective head requires native activation');end if;
          end if;
          NEW.updated_at:=clock_timestamp();return NEW;
        end if;
        -- History updates only perform actual users/sessions FK erasure nulling.
        for field,parent_table in select * from(values('created_by','users'),('created_session_id','sessions'),('user_id','users'),('session_id','sessions'),('actor_id','users')) x(f,t) loop
          if n ? field and o->field is distinct from n->field then
            if o->field='null'::jsonb or n->field<>'null'::jsonb then perform legacy_calendar_bounds_fail('History identity is immutable');end if;
            execute format('select exists(select 1 from %I where id=$1)',parent_table) into available using (o->>field)::uuid;
            if available then perform legacy_calendar_bounds_fail('History nulling requires actual parent erasure');end if;
            erasure_update:=true;
          end if;
          n:=n-field;o:=o-field;
        end loop;
        if not erasure_update or n is distinct from o then perform legacy_calendar_bounds_fail('Bounds evidence is immutable','legacy_calendar_bounds_immutable');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_heads' then
        if NEW.revision<>0 or NEW.proposed_version<>0 or NEW.proposed_version_id is not null or NEW.effective_event_id is not null then perform legacy_calendar_bounds_fail('Initial bounds head is empty');end if;
        return NEW;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.created_by,'sessionId',NEW.created_session_id,'policyVersion',NEW.policy_version)));
        select * into s from legacy_calendar_sources where id=NEW.source_id;
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        material:=legacy_calendar_bounds_material(NEW.source_id,NEW.inventory_version_id,NEW.declaration);
        if NEW.wedding_id is distinct from s.wedding_id or NEW.company_id is distinct from s.company_id or NEW.version<>head.proposed_version+1
          or NEW.previous_version_id is distinct from head.proposed_version_id or NEW.canonical is distinct from material::text
          or NEW.source_fingerprint is distinct from material->>'sourceFingerprint'
          or NEW.source_revision::text is distinct from legacy_calendar_bounds_source_material(s.id)->>'sourceRevision'
          or NEW.inventory_revision::text is distinct from material->'inventory'->>'revision' or NEW.inventory_digest is distinct from material->'inventory'->>'digest'
          or NEW.association_fingerprint is distinct from legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_known_person_scope(s.vendor_id))
          or NEW.staffing_completeness is distinct from NEW.declaration->'staffing'->>'completeness'
          or not legacy_calendar_bounds_principal_current(s.id,null,null,'performer',NEW.created_by,NEW.created_session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Proposal must equal exact current owner material');end if;
        NEW.created_at:=clock_timestamp();return NEW;
      end if;
      if n ? 'bounds_version_id' and n->>'bounds_version_id' is not null then
        select * into v from legacy_calendar_bounds_versions where id=(n->>'bounds_version_id')::uuid;
        if not found then perform legacy_calendar_bounds_fail('Proposal parent missing');end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_holders' then
        select * into captured from legacy_calendar_version_holders where version_id=v.inventory_version_id and wedding_id=NEW.wedding_id and deal_id=NEW.deal_id;
        select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=NEW.wedding_id::text and value->>'dealId'=NEW.deal_id::text;
        if captured.version_id is null or part is null or NEW.source_id<>v.source_id or NEW.inventory_version_id<>v.inventory_version_id
          or NEW.holder_snapshot is distinct from captured.snapshot or NEW.holder_fingerprint<>captured.fingerprint or NEW.slot_id::text is distinct from captured.snapshot->'slot'->>'id'
          or NEW.day_version_id is distinct from(captured.snapshot#>>'{dayScope,version,id}')::uuid
          or NEW.expected_order_version::text is distinct from part->>'expectedOrderVersion' or NEW.outcome is distinct from part->>'outcome' or NEW.closure_reason is distinct from part->>'closureReason'
          or NEW.wedding_id is distinct from v.wedding_id then perform legacy_calendar_bounds_fail('Bounds holder must equal captured exact holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_spans' then
        if NEW.holder_id is null then part:=v.declaration->'manualBounds';
          if v.company_id is null then perform legacy_calendar_bounds_fail('Manual span in app proposal');end if;
        else
          select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
          select value into part from jsonb_array_elements(v.declaration->'holders') where value->>'weddingId'=h.wedding_id::text and value->>'dealId'=h.deal_id::text;
        end if;
        expected:=part->'spans'->NEW.span_index;
        if expected is null or legacy_calendar_bounds_span_json(NEW) is distinct from expected
          or NEW.original_date is distinct from legacy_calendar_bounds_span_original_date(v.source_id,NEW.holder_id,expected)
          or legacy_calendar_bounds_span_valid(expected,NEW.original_date) is not true then perform legacy_calendar_bounds_fail('Span must equal native accepted declaration');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_person_scope' then
        if not v.declaration->'staffing'->'personIds' @> to_jsonb(array[NEW.person_identity])
          or NEW.context_material is distinct from legacy_calendar_bounds_known_person_scope((v.canonical::jsonb->>'vendorId')::uuid) then perform legacy_calendar_bounds_fail('Person scope must equal observed conservative context');end if;
      elsif TG_TABLE_NAME='legacy_calendar_bounds_receipts' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id),'actor',jsonb_build_object('userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        select * into head from legacy_calendar_bounds_heads where source_id=v.source_id;
        expected:=jsonb_build_object('purpose','calendar-bounds-read','sourceId',v.source_id,'inventoryVersionId',v.inventory_version_id,'boundsVersionId',v.id,'version',v.version::text,'digest',v.digest,
          'weddingId',h.wedding_id,'dealId',h.deal_id,'userId',NEW.user_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version,'iss','tili-tili','aud','calendar-bounds-read','iat',NEW.read_iat,'exp',NEW.read_exp);
        if h.id is null or NEW.source_id<>v.source_id or head.proposed_version_id is distinct from v.id or NEW.digest<>v.digest or NEW.read_claims is distinct from expected
          or NEW.read_iat>floor(extract(epoch from clock_timestamp())) or NEW.read_exp<=floor(extract(epoch from clock_timestamp()))
          or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,NEW.party,NEW.user_id,NEW.session_id,NEW.policy_version) then perform legacy_calendar_bounds_fail('Receipt requires current exact read proof and party');end if;
        NEW.accepted_at:=clock_timestamp();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_events' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('sourceIds',jsonb_build_array(NEW.source_id)));
        select * into head from legacy_calendar_bounds_heads where source_id=NEW.source_id;
        if NEW.previous_event_id is distinct from head.effective_event_id then perform legacy_calendar_bounds_fail('Resolution ancestry mismatch');end if;
        if NEW.action='activate' then
          if NEW.material is distinct from legacy_calendar_bounds_activation_material(v.id,NEW.policy_version) or legacy_calendar_bounds_agreed(v.id,NEW.policy_version) is not true
            or (not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',NEW.actor_id,NEW.session_id,NEW.policy_version)
              and not exists(select 1 from legacy_calendar_bounds_holders x where x.bounds_version_id=v.id and legacy_calendar_bounds_principal_current(v.source_id,x.wedding_id,x.deal_id,'customer',NEW.actor_id,NEW.session_id,NEW.policy_version))) then
            perform legacy_calendar_bounds_fail('Activation requires real current whole proof');end if;
        elsif NEW.action='holder_cancelled' then
          if not exists(select 1 from legacy_calendar_bounds_holders x join deals d on d.id=x.deal_id and d.wedding_id=x.wedding_id
            where x.bounds_version_id=v.id and d.state='cancelled' and NEW.material->>'dealId'=d.id::text) then perform legacy_calendar_bounds_fail('Cancellation resolution requires actual own cancelled holder');end if;
        elsif NEW.action='negotiation_committed' then
          if not exists(select 1 from legacy_calendar_sources source join legacy_calendar_initial_commit_witnesses w on w.deal_id=source.root_deal_id
            join deal_resource_commitments ch on ch.deal_id=w.deal_id join deal_resource_commitment_versions cv on cv.id=ch.current_version_id
            where source.id=NEW.source_id and source.kind='live_negotiation' and NEW.material->>'witnessId'=w.id::text
              and NEW.material->>'commitmentVersionId'=cv.id::text and cv.revision=1 and cv.action='commit' and legacy_calendar_bounds_initial_current(w.id,w.deal_id)) then
            perform legacy_calendar_bounds_fail('Negotiation resolution requires actual initial conversion');end if;
        elsif NEW.action in('source_stale','source_unavailable') then
          if v.id is not null and v.source_fingerprint=legacy_calendar_bounds_fingerprint(legacy_calendar_bounds_source_material(NEW.source_id)) then
            perform legacy_calendar_bounds_fail('Unchanged source cannot be declared stale');end if;
        elsif NEW.action='superseded' then
          if not exists(select 1 from legacy_calendar_resolution_events e where e.id=(NEW.material->>'newEventId')::uuid and e.source_id=NEW.source_id
            and e.action='activate' and e.transaction_id=txid_current() and e.backend_pid=pg_backend_pid() and legacy_calendar_bounds_agreed(e.bounds_version_id,e.policy_version)) then perform legacy_calendar_bounds_fail('Supersession requires actual newly agreed activation');end if;
        else perform legacy_calendar_bounds_fail('Unknown resolution action');end if;
        NEW.created_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      elsif TG_TABLE_NAME='legacy_calendar_resolution_holders' then
        select * into event from legacy_calendar_resolution_events where id=NEW.event_id;
        select * into h from legacy_calendar_bounds_holders where id=NEW.holder_id and bounds_version_id=v.id;
        expected:=jsonb_build_object('encoding','legacy-calendar-holder-resolution/1','holderId',h.id,'weddingId',h.wedding_id,'dealId',h.deal_id,'outcome',h.outcome,'boundsDigest',v.digest);
        if event.action<>'activate' or event.bounds_version_id<>v.id or NEW.source_id<>v.source_id or NEW.outcome<>h.outcome or NEW.material is distinct from expected then perform legacy_calendar_bounds_fail('Resolution member is not exact native holder');end if;
      elsif TG_TABLE_NAME='legacy_calendar_initial_commit_witnesses' then
        perform legacy_calendar_bounds_require_scope(jsonb_build_object('weddingIds',jsonb_build_array(NEW.wedding_id),'actor',jsonb_build_object('userId',NEW.actor_id,'sessionId',NEW.session_id,'policyVersion',NEW.policy_version)));
        if legacy_calendar_bounds_initial_preconditions(NEW.wedding_id,NEW.deal_id,NEW.vendor_id,NEW.terms_id,NEW.plan_revision_id,NEW.policy_revision,
          NEW.actor_id,NEW.session_id,NEW.policy_version,NEW.pending_state) is not true then
          perform legacy_calendar_bounds_fail('Witness is not a genuine initial pending context','legacy_calendar_initial_commit');end if;
        NEW.recorded_at:=clock_timestamp();NEW.transaction_id:=txid_current();NEW.backend_pid:=pg_backend_pid();
      end if;
      return NEW;
    end $$;
  `)
  pgm.sql(String.raw`
    create or replace function check_legacy_calendar_bounds_complete() returns trigger language plpgsql as $$
    declare v record;r record;e record;c record;h record;source jsonb;
    begin
      -- Only newly written proposal/read/activation evidence rechecks current auth/input.
      if TG_TABLE_NAME='legacy_calendar_bounds_versions' and TG_OP='INSERT' then
        select x.* into v from legacy_calendar_bounds_versions x where x.id=NEW.id;
        if found then
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not exists(select 1 from legacy_calendar_bounds_heads hd where hd.source_id=v.source_id and hd.proposed_version>=v.version)
          or not legacy_calendar_bounds_principal_current(v.source_id,null,null,'performer',v.created_by,v.created_session_id,v.policy_version)
          or (not exists(select 1 from legacy_calendar_bounds_heads hd where hd.proposed_version_id=v.id)
            and not exists(select 1 from legacy_calendar_bounds_versions nx where nx.source_id=v.source_id and nx.previous_version_id=v.id)) then perform legacy_calendar_bounds_fail('New proposal graph must finish complete/current');end if;
        end if;
      end if;
      if TG_TABLE_NAME='legacy_calendar_bounds_receipts' and TG_OP='INSERT' then
        select x.* into r from legacy_calendar_bounds_receipts x where x.id=NEW.id;
        if found then
        select * into h from legacy_calendar_bounds_holders where id=r.holder_id;
        select * into v from legacy_calendar_bounds_versions where id=r.bounds_version_id;
        if legacy_calendar_bounds_complete(v.id) is not true or v.canonical is distinct from legacy_calendar_bounds_material(v.source_id,v.inventory_version_id,v.declaration)::text
          or not legacy_calendar_bounds_principal_current(v.source_id,h.wedding_id,h.deal_id,r.party,r.user_id,r.session_id,r.policy_version) then perform legacy_calendar_bounds_fail('New receipt must finish with current exact party/material');end if;
        end if;
      end if;
      for e in select id from legacy_calendar_resolution_events where action='activate' and transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_applied(e.id);end loop;
      if TG_TABLE_NAME='resource_occupancy_origin_certificates' then
        perform legacy_calendar_bounds_assert_certificate(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(OLD.certificate_id);end if;
        if TG_OP<>'DELETE' and NEW.certificate_id is not null then perform legacy_calendar_bounds_assert_certificate(NEW.certificate_id);end if;
      end if;
      if TG_TABLE_NAME='resource_allocations' then
        perform legacy_calendar_bounds_assert_mirror(case when TG_OP='DELETE' then OLD.id else NEW.id end);
      elsif TG_TABLE_NAME='resource_occupancy' then
        if TG_OP<>'INSERT' and OLD.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(OLD.allocation_id);end if;
        if TG_OP<>'DELETE' and NEW.allocation_id is not null then perform legacy_calendar_bounds_assert_mirror(NEW.allocation_id);end if;
      end if;
      for e in select id from legacy_calendar_initial_commit_witnesses where transaction_id=txid_current() and backend_pid=pg_backend_pid() loop perform legacy_calendar_bounds_assert_initial(e.id);end loop;
      -- Old committed proofs become conservatively stale, never rejected just for logout/input evolution.
      -- No live FK/source loss ever releases retained certificates.
      return null;
    end $$;
  `)
  // Restore the exact schema94 bodies of the day-scope/source-presence guards.
  pgm.sql(String.raw`
    create or replace function legacy_day_known_holders(target uuid) returns setof deal_day_scope_versions language sql stable as $$
      select v.* from deal_day_scope_heads h join deal_day_scope_versions v
        on v.id=h.current_version_id and v.wedding_id=h.wedding_id and v.deal_id=h.deal_id and v.revision=h.revision
      join vendor_busy_dates b on b.id=v.day_id and b.vendor_id=v.vendor_id and b.date=v.service_date and b.source='deal'
      where b.id=target and v.binding_state in ('active','done_retained')
        and legacy_day_tuple_current(v)
        and not exists(select 1 from deal_resource_commitments c where c.deal_id=v.deal_id and c.revision>0)
    $$;
    create or replace function legacy_day_group_wedding(target uuid) returns uuid language sql stable as $$
      select p.wedding_id from vendor_busy_dates b join deals p on p.id=b.deal_id
        join weddings w on w.id=p.wedding_id
      where b.id=target and b.source='deal' and p.vendor_id=b.vendor_id and p.state in ('booked','paid_deposit','done')
        and not exists(select 1 from legacy_calendar_sources s where s.day_id=b.id and s.kind='app_day'
          and s.wedding_id is distinct from p.wedding_id)
        and not exists(select 1 from deal_day_scope_heads h join deal_day_scope_versions v on v.id=h.current_version_id
          where v.day_id=b.id and v.wedding_id is distinct from p.wedding_id)
        and not exists(select 1 from deal_resource_commitments c where c.deal_id=p.id and c.revision>0)
    $$;
    create or replace function legacy_calendar_present(source legacy_calendar_sources) returns boolean language plpgsql stable as $$
    declare mat jsonb; wedding_row weddings%rowtype;
    begin
      if source.kind in ('app_day','manual_day','orphan_day') then
        return exists(select 1 from vendor_busy_dates where id=source.day_id);
      end if;
      mat := legacy_calendar_current_inventory_material(source);
      if not exists(select 1 from deals d where d.id=source.root_deal_id and d.wedding_id=source.wedding_id
        and d.vendor_id=source.vendor_id and ((source.kind='app_root' and d.state in ('booked','paid_deposit','done')
          and not exists(select 1 from deal_resource_commitments c where c.deal_id=d.id and c.revision>0))
          or (source.kind='live_negotiation' and d.state='negotiating'))) then return false; end if;
      if source.kind<>'live_negotiation' then return true; end if;
      if (mat->'negotiation'->>'negotiatingUntil') is null then return false; end if;
      if (mat->'negotiation'->>'negotiatingUntil')::timestamptz<=clock_timestamp() then return false; end if;
      if (mat->'negotiation'->>'weddingArchived')::boolean or (mat->'negotiation'->>'weddingCancelled')::boolean then return false; end if;
      return true;
    end $$;
    create or replace function legacy_calendar_holder(p_wedding_id uuid, p_deal_id uuid) returns jsonb language sql stable as $$
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
    create or replace function legacy_calendar_inventory_material(source legacy_calendar_sources) returns jsonb language plpgsql stable as $$
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
    drop function legacy_calendar_adoption_calendar_projection(uuid,uuid),legacy_calendar_adopted_commitment(uuid),legacy_calendar_adopted_version(uuid,uuid);
  `)
  // Restore the exact schema94 body of legacy_day_assert_root.
  pgm.sql(String.raw`
    create or replace function legacy_day_assert_root(root_id uuid) returns void language plpgsql as $$
    declare v deal_day_scope_versions%rowtype;
    begin
      select x.* into v from deal_day_scope_heads h join deal_day_scope_versions x on x.id=h.current_version_id
        where h.deal_id=$1;
      if not found or not exists(select 1 from deals where id=$1) then return; end if;
      if v.operation='retain_done' and v.binding_state='external'
        and not exists(select 1 from deals d where d.id=root_id
          and d.wedding_id=v.wedding_id and d.state='done') then
        raise exception 'External retained head requires a completed root'
          using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if not deal_day_scope_matches_current(v) and not
        (not legacy_day_version_new(v.id) and (legacy_day_erased_catalog(v)
          or (v.binding_state in ('unknown','external') and exists(select 1 from deals d where d.id=$1 and d.state='done')))) then
        raise exception 'Managed root requires a final current tuple' using errcode='23514',constraint='deal_day_scope_current';
      end if;
      if v.binding_state in ('active','done_retained') and exists(select 1 from deal_resource_commitments c
        where c.deal_id=$1 and c.revision>0) then
        raise exception 'Resource agreement cannot become a legacy DATE holder'
          using errcode='23514',constraint='legacy_day_group_current';
      end if;
    end $$;
  `)
  // Restore the exact schema94 body of legacy_calendar_bounds_source_material.
  pgm.sql(String.raw`
    create or replace function legacy_calendar_bounds_source_material(p_source_id uuid) returns jsonb language plpgsql stable as $$
    declare src legacy_calendar_sources%rowtype;inv jsonb;ctx jsonb;person_scope jsonb;holders jsonb;holder jsonb;inputs jsonb;
      original_date date;complete text;reason text;owner uuid;available boolean;policy_mode text;policy_revision text;
    begin
      select * into src from legacy_calendar_sources where id=p_source_id;
      if not found then return null;end if;
      inv:=legacy_calendar_current_inventory_material(src);ctx:=legacy_calendar_bounds_related(src.id);
      complete:=inv->>'completeness';reason:=inv->>'reason';
      if not legacy_calendar_present(src) then complete:='unknown';reason:='source_changed';end if;
      if exists(select 1 from legacy_day_groups g where g.day_id=any(legacy_calendar_bounds_ids(ctx->'dayIds'))
        and(g.classification='opaque' or cardinality(g.legacy_candidates)>0 or g.wedding_id is distinct from src.wedding_id))
        or exists(select 1 from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) d cross join lateral legacy_day_known_holders(d) k
          where k.wedding_id is distinct from src.wedding_id) then complete:='unknown';reason:='mixed_scope';end if;
      original_date:=(src.origin->>'date')::date;
      if src.kind='app_root' then
        select case when count(distinct b.date)=1 then min(b.date) else null end into original_date
          from unnest(legacy_calendar_bounds_ids(ctx->'dayIds')) day(day_id) join vendor_busy_dates b on b.id=day.day_id
          where exists(select 1 from legacy_day_known_holders(b.id) k where k.deal_id=src.root_deal_id and k.wedding_id=src.wedding_id);
      end if;
      select v.user_id,v.blocked_at is null and u.deleted_at is null into owner,available from vendors v join users u on u.id=v.user_id where v.id=src.vendor_id;
      select mode,revision::text into policy_mode,policy_revision from vendor_availability_policy where vendor_id=src.vendor_id;
      person_scope:=legacy_calendar_bounds_known_person_scope(src.vendor_id);holders:='[]';
      for holder in select value from jsonb_array_elements(inv->'holders') order by value->>'weddingId',value->>'dealId' loop
        select jsonb_build_object(
          'parts',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'kind',p.kind,'version',p.version::text,'assignmentId',p.assignment_id,'details',p.details) order by p.id)
            from order_parts p where p.wedding_id=(holder->>'weddingId')::uuid and p.deal_id=(holder->>'dealId')::uuid and p.cancelled_at is null),'[]'),
          'plan',(select jsonb_build_object('id',p.id,'version',p.version::text,'privateDigest',p.private_digest,'lines',
            (select coalesce(jsonb_agg(x.value-'label' order by x.ordinality),'[]') from jsonb_array_elements(p.private_snapshot->'lines') with ordinality x(value,ordinality)))
            from deal_orders o join deal_resource_plan_versions p on p.id=o.resource_plan_id where o.wedding_id=(holder->>'weddingId')::uuid and o.deal_id=(holder->>'dealId')::uuid),
          'allocations',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'originVersionId',a.origin_version_id,'originLineIndex',a.origin_line_index,'resourceId',a.resource_id,
            'windowId',a.capacity_window_id,'kind',a.kind,'identity',a.conflict_identity,'quantity',a.quantity,'startsAt',a.occupied_starts_at,'endsAt',a.occupied_ends_at) order by a.id)
            from resource_allocations a where a.wedding_id=(holder->>'weddingId')::uuid and a.deal_id=(holder->>'dealId')::uuid and a.released_at is null),'[]'),
          'relatedSources',coalesce((select jsonb_agg(jsonb_build_object('sourceId',s.id,'material',legacy_calendar_current_inventory_material(s)) order by s.id)
            from legacy_calendar_sources s where s.id=any(legacy_calendar_bounds_ids(ctx->'sourceIds'))),'[]')) into inputs;
        holders:=holders||jsonb_build_array(jsonb_build_object('weddingId',holder->'weddingId','dealId',holder->'dealId','slotId',holder->'slot'->'id',
          'orderVersion',holder->'order'->'version','holderSnapshot',holder,'holderFingerprint',legacy_calendar_bounds_fingerprint(holder),'calendarInputs',inputs));
      end loop;
      if jsonb_array_length(holders)>128 then perform legacy_calendar_bounds_fail('Holder limit exceeded','legacy_calendar_bounds_scope');end if;
      return jsonb_build_object('encoding','legacy-calendar-bounds-source/1','sourceId',src.id,'kind',src.kind,'vendorId',src.vendor_id,
        'weddingId',src.wedding_id,'companyId',src.company_id,'originDate',original_date,'sourceRevision',
        case when src.day_id is null then '0' else coalesce((select source_revision::text from vendor_busy_dates where id=src.day_id),'0') end,
        'scopeCompleteness',complete,'unavailableReason',reason,'inventoryMaterial',inv,'holders',holders,'context',ctx,'personScope',person_scope,
        'vendorOwnerId',owner,'ownerAvailable',coalesce(available,false),'policyMode',coalesce(policy_mode,'legacy_day'),'policyRevision',coalesce(policy_revision,'0'));
    end $$;
  `)
  pgm.sql(String.raw`
    drop function legacy_calendar_bounds_adoption_material(uuid),legacy_calendar_bounds_assert_adopted(uuid),
      legacy_calendar_bounds_assert_adoption(uuid),protect_legacy_calendar_adoption_proof();
    drop table legacy_calendar_adoption_proofs;
  `)
}
