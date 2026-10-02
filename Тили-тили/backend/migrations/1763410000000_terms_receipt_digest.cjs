exports.up = pgm => {
  pgm.sql(`alter table deal_terms_versions add constraint published_terms_digest_identity unique(wedding_id,deal_id,id,digest);
    alter table deal_terms_receipts add constraint receipt_published_digest_scope
      foreign key(wedding_id,deal_id,terms_id,digest) references deal_terms_versions(wedding_id,deal_id,id,digest) on delete cascade;
  `)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_terms_receipts) then
      raise exception 'Cannot remove recorded terms receipt digest protection';
    end if;
  end $$;
  alter table deal_terms_receipts drop constraint receipt_published_digest_scope;
  alter table deal_terms_versions drop constraint published_terms_digest_identity;`)
}
