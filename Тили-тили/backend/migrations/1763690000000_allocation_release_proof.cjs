exports.up = pgm => {
  pgm.sql(`create function check_resource_allocation_release_proof() returns trigger language plpgsql as $$
    begin
      if not exists(select 1 from deal_resource_commitments h
        join deal_resource_commitment_versions v on v.wedding_id=h.wedding_id and v.deal_id=h.deal_id
          and v.previous_version_id=h.current_version_id and v.revision=h.revision+1
        join deal_resource_commitment_members m on m.version_id=h.current_version_id and m.allocation_id=OLD.id
        where h.wedding_id=OLD.wedding_id and h.deal_id=OLD.deal_id and h.state='reserved'
          and ((NEW.release_reason='replaced' and v.action='replace' and v.state='reserved') or
            (NEW.release_reason in ('deal_cancelled','wedding_erased','vendor_erased')
              and v.action='release' and v.state='released' and v.reason=NEW.release_reason))) then
        raise exception 'allocation release requires matching next scoped commitment proof' using errcode='23514';
      end if;return NEW;
    end $$;
    create trigger resource_allocation_release_proof before update on resource_allocations
      for each row execute function check_resource_allocation_release_proof();`)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_commitment_versions) then
      raise exception 'booking evidence exists; use preserving forward migration';
    end if;
  end $$;
  drop trigger resource_allocation_release_proof on resource_allocations;
  drop function check_resource_allocation_release_proof();`)
}
