exports.up = pgm => {
  pgm.sql(`
    create function check_resource_commitment_proof() returns trigger language plpgsql as $$
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
    create trigger resource_commitment_accepted_proof before insert on deal_resource_commitment_versions
      for each row execute function check_resource_commitment_proof();
  `)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_resource_commitment_versions) then
      raise exception 'accepted booking proof exists; use preserving forward migration';
    end if;
  end $$;
  drop trigger resource_commitment_accepted_proof on deal_resource_commitment_versions;
  drop function check_resource_commitment_proof();`)
}
