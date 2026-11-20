/* FR-053. A proposal fixes one document and its ready attachment. */
exports.up = pgm => pgm.sql(`
  alter table media_uploads add constraint media_contract_agreement_attachment_key unique(document_id,id);
  create table contract_agreements (
    document_id uuid primary key references documents(id) on delete cascade,
    attachment_id uuid,
    proposed_side text not null check(proposed_side in ('couple','vendor')),
    proposed_by uuid references users(id) on delete set null,
    proposed_at timestamptz not null default clock_timestamp(),
    couple_by uuid references users(id) on delete set null,
    couple_at timestamptz,
    vendor_by uuid references users(id) on delete set null,
    vendor_at timestamptz,
    constraint contract_agreement_couple_receipt check(
      (couple_by is null or couple_at is not null) and (couple_at is null or couple_at >= proposed_at)),
    constraint contract_agreement_vendor_receipt check(
      (vendor_by is null or vendor_at is not null) and (vendor_at is null or vendor_at >= proposed_at)),
    constraint contract_agreement_distinct_receipts check(
      couple_by is null or vendor_by is null or couple_by <> vendor_by),
    foreign key(document_id,attachment_id) references media_uploads(document_id,id) deferrable initially deferred
  );
  create index contract_agreement_proposer on contract_agreements(proposed_by) where proposed_by is not null;
  create index contract_agreement_couple on contract_agreements(couple_by) where couple_by is not null;
  create index contract_agreement_vendor on contract_agreements(vendor_by) where vendor_by is not null;

  create function protect_proposed_contract() returns trigger language plpgsql as $$
  begin
    if exists(select 1 from contract_agreements where document_id=OLD.id) then
      raise exception using errcode='23514', message='proposed_contract_is_immutable';
    end if;
    return NEW;
  end $$;
  create trigger protect_proposed_contract before update of id,deal_id,template_code,version,fields,file_url,docx_url on documents
    for each row when (OLD is distinct from NEW) execute function protect_proposed_contract();

  create function protect_proposed_contract_attachment() returns trigger language plpgsql as $$
  begin
    if TG_OP='INSERT' then
      if exists(select 1 from contract_agreements where document_id=NEW.document_id) then
        raise exception using errcode='23514', message='proposed_contract_attachment_is_immutable';
      end if;
    elsif exists(select 1 from contract_agreements where attachment_id=OLD.id) then
      raise exception using errcode='23514', message='proposed_contract_attachment_is_immutable';
    end if;
    return NEW;
  end $$;
  create trigger protect_new_contract_attachment before insert on media_uploads
    for each row when (NEW.document_id is not null) execute function protect_proposed_contract_attachment();
  create trigger protect_proposed_contract_attachment before update of state,document_id,clean_key,storage_id,output_bytes,sha256 on media_uploads
    for each row when (OLD.document_id is not null and
      (OLD.state,OLD.document_id,OLD.clean_key,OLD.storage_id,OLD.output_bytes,OLD.sha256)
        is distinct from (NEW.state,NEW.document_id,NEW.clean_key,NEW.storage_id,NEW.output_bytes,NEW.sha256))
      execute function protect_proposed_contract_attachment();
`)

exports.down = pgm => pgm.sql(`
  lock table contract_agreements in access exclusive mode;
  do $$ begin
    if exists(select 1 from contract_agreements) then
      raise exception using errcode='23514', message='contract_agreements_preserving_down';
    end if;
  end $$;
  drop trigger protect_proposed_contract on documents;
  drop function protect_proposed_contract();
  drop trigger protect_new_contract_attachment on media_uploads;
  drop trigger protect_proposed_contract_attachment on media_uploads;
  drop function protect_proposed_contract_attachment();
  drop table contract_agreements;
  alter table media_uploads drop constraint media_contract_agreement_attachment_key;
`)
