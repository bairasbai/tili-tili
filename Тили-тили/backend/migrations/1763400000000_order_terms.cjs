exports.up = pgm => {
  pgm.sql(`
    create table deal_terms_versions(
      id uuid primary key,
      wedding_id uuid not null,
      deal_id uuid not null,
      version bigint not null check(version>0),
      source_order_version bigint not null check(source_order_version>0),
      source_fingerprint text not null check(source_fingerprint ~ '^[0-9a-f]{64}$'),
      canonical_payload text not null,
      snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
      digest text not null check(digest ~ '^[0-9a-f]{64}$'),
      published_by uuid references users(id) on delete set null,
      published_side text not null check(published_side in ('customer','performer')),
      published_at timestamptz not null default clock_timestamp(),
      unique(deal_id,version),
      unique(wedding_id,deal_id,id),
      foreign key(wedding_id,deal_id) references deal_orders(wedding_id,deal_id) on delete cascade,
      check(snapshot=canonical_payload::jsonb),
      check(digest=encode(pg_catalog.sha256(convert_to(canonical_payload,'UTF8')),'hex'))
    );
    create table deal_terms_receipts(
      id uuid primary key,
      wedding_id uuid not null,
      deal_id uuid not null,
      terms_id uuid not null,
      party text not null check(party in ('customer','performer')),
      user_id uuid references users(id) on delete set null,
      session_id uuid references sessions(id) on delete set null,
      digest text not null check(digest ~ '^[0-9a-f]{64}$'),
      accepted_at timestamptz not null default clock_timestamp(),
      unique(terms_id,party),
      foreign key(wedding_id,deal_id,terms_id) references deal_terms_versions(wedding_id,deal_id,id) on delete cascade
    );
    alter table deal_orders add column terms_revision bigint not null default 0 check(terms_revision>=0),
      add column proposed_terms_id uuid, add column agreed_terms_id uuid;
    alter table deal_orders add constraint proposed_order_terms_scope
      foreign key(wedding_id,deal_id,proposed_terms_id) references deal_terms_versions(wedding_id,deal_id,id) deferrable initially deferred,
      add constraint agreed_order_terms_scope
      foreign key(wedding_id,deal_id,agreed_terms_id) references deal_terms_versions(wedding_id,deal_id,id) deferrable initially deferred;
    create function protect_order_terms_history() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from weddings where id=OLD.wedding_id) then
          raise exception 'Order terms history can only be erased with its wedding' using errcode='23514';
        end if;
        return OLD;
      end if;
      if TG_TABLE_NAME='deal_terms_versions' then
        if (to_jsonb(NEW)-'published_by')<>(to_jsonb(OLD)-'published_by')
          or (NEW.published_by is distinct from OLD.published_by and not
            (OLD.published_by is not null and NEW.published_by is null and not exists(select 1 from users where id=OLD.published_by))) then
          raise exception 'Published order terms are immutable' using errcode='23514';
        end if;
      else
        if (to_jsonb(NEW)-'user_id'-'session_id')<>(to_jsonb(OLD)-'user_id'-'session_id')
          or (NEW.user_id is distinct from OLD.user_id and not
            (OLD.user_id is not null and NEW.user_id is null and not exists(select 1 from users where id=OLD.user_id)))
          or (NEW.session_id is distinct from OLD.session_id and not
            (OLD.session_id is not null and NEW.session_id is null and not exists(select 1 from sessions where id=OLD.session_id))) then
          raise exception 'Order terms receipts are immutable' using errcode='23514';
        end if;
      end if;
      return NEW;
    end $$;
    create trigger immutable_order_terms before update or delete on deal_terms_versions
      for each row execute function protect_order_terms_history();
    create trigger immutable_order_terms_receipt before update or delete on deal_terms_receipts
      for each row execute function protect_order_terms_history();
    comment on table deal_terms_receipts is 'Actual platform acceptance of one published version; not a payment, program acknowledgment, device read receipt or proof of legal signature';
  `)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from deal_terms_versions) or exists(select 1 from deal_terms_receipts)
      or exists(select 1 from deal_orders where terms_revision<>0 or proposed_terms_id is not null or agreed_terms_id is not null) then
      raise exception 'Cannot discard published order terms or acceptance history';
    end if;
  end $$;
  alter table deal_orders drop constraint proposed_order_terms_scope,drop constraint agreed_order_terms_scope,
    drop column proposed_terms_id,drop column agreed_terms_id,drop column terms_revision;
  drop table deal_terms_receipts,deal_terms_versions;
  drop function protect_order_terms_history();`)
}
