/** FR011: preserving history of manual corrections. No reconstruction of old edits. */
exports.up = pgm => pgm.sql(`
  alter table payments add constraint payments_id_deal_history_key unique(id,deal_id);
  create table payment_corrections (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    deal_id uuid not null,
    payment_id uuid not null,
    actor_id uuid references users(id) on delete set null,
    session_id uuid references sessions(id) on delete set null,
    created_at timestamptz not null default clock_timestamp(),
    before_version integer not null check(before_version>0),
    after_version integer not null check(after_version::bigint=before_version::bigint+1),
    currency char(3) not null check(currency='RUB'),
    before_amount_known boolean not null,
    after_amount_known boolean not null,
    before_amount bigint,
    after_amount bigint,
    before_paid_on date not null check(before_paid_on between '2000-01-01' and '2100-12-31'),
    after_paid_on date not null check(after_paid_on between '2000-01-01' and '2100-12-31'),
    before_payment_method text not null check(before_payment_method in ('cash','bank_transfer','card','other')),
    after_payment_method text not null check(after_payment_method in ('cash','bank_transfer','card','other')),
    reason text not null check(length(reason) between 1 and 500 and length(btrim(reason))>0),
    check((before_amount_known and before_amount is not null and before_amount between 1 and 9007199254740991)
      or (not before_amount_known and before_amount is null)),
    check((after_amount_known and after_amount is not null and after_amount between 1 and 9007199254740991)
      or (not after_amount_known and after_amount is null)),
    check(row(before_amount_known,before_amount,before_paid_on,before_payment_method)
      is distinct from row(after_amount_known,after_amount,after_paid_on,after_payment_method)),
    unique(payment_id,after_version),
    foreign key(wedding_id,deal_id) references deals(wedding_id,id) deferrable initially deferred,
    foreign key(payment_id,deal_id) references payments(id,deal_id) deferrable initially deferred
  );
  create table payment_installment_edits (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    deal_id uuid not null,
    installment_id uuid not null,
    actor_id uuid references users(id) on delete set null,
    session_id uuid references sessions(id) on delete set null,
    created_at timestamptz not null default clock_timestamp(),
    before_version integer not null check(before_version>0),
    after_version integer not null check(after_version::bigint=before_version::bigint+1),
    currency char(3) not null check(currency='RUB'),
    before_title text not null check(length(btrim(before_title)) between 1 and 200),
    after_title text not null check(length(btrim(after_title)) between 1 and 200),
    before_amount bigint not null check(before_amount between 1 and 9007199254740991),
    after_amount bigint not null check(after_amount between 1 and 9007199254740991),
    before_due date not null check(before_due between '2000-01-01' and '2100-12-31'),
    after_due date not null check(after_due between '2000-01-01' and '2100-12-31'),
    before_cancelled_at timestamptz,
    after_cancelled_at timestamptz,
    before_cancel_reason text check(before_cancel_reason is null or length(before_cancel_reason)<=500),
    after_cancel_reason text check(after_cancel_reason is null or length(after_cancel_reason)<=500),
    check(row(before_title,before_amount,before_due,before_cancelled_at,before_cancel_reason)
      is distinct from row(after_title,after_amount,after_due,after_cancelled_at,after_cancel_reason)),
    unique(installment_id,after_version),
    foreign key(wedding_id,deal_id) references deals(wedding_id,id) deferrable initially deferred,
    foreign key(installment_id,deal_id) references payment_installments(id,deal_id) deferrable initially deferred
  );
  create index payment_corrections_page on payment_corrections(wedding_id,payment_id,created_at desc,id desc);
  create index installment_edits_page on payment_installment_edits(wedding_id,installment_id,created_at desc,id desc);
  create index payment_corrections_parent on payment_corrections(deal_id,payment_id);
  create index installment_edits_parent on payment_installment_edits(deal_id,installment_id);
  create index payment_corrections_actor on payment_corrections(actor_id) where actor_id is not null;
  create index payment_corrections_session on payment_corrections(session_id) where session_id is not null;
  create index installment_edits_actor on payment_installment_edits(actor_id) where actor_id is not null;
  create index installment_edits_session on payment_installment_edits(session_id) where session_id is not null;

  create function protect_payment_amendment_history() returns trigger language plpgsql as $$
  begin
    if TG_OP='TRUNCATE' then
      raise exception 'Payment amendment history cannot be truncated' using errcode='23514';
    end if;
    if TG_OP='DELETE' then
      if exists(select 1 from weddings where id=OLD.wedding_id) then
        raise exception 'Payment amendment history can only be erased with its wedding' using errcode='23514';
      end if;
      return OLD;
    end if;
    if (to_jsonb(NEW)-'actor_id'-'session_id')<>(to_jsonb(OLD)-'actor_id'-'session_id')
      or (NEW.actor_id is distinct from OLD.actor_id and not
        (OLD.actor_id is not null and NEW.actor_id is null and not exists(select 1 from users where id=OLD.actor_id)))
      or (NEW.session_id is distinct from OLD.session_id and not
        (OLD.session_id is not null and NEW.session_id is null and not exists(select 1 from sessions where id=OLD.session_id))) then
      raise exception 'Payment amendment history is immutable' using errcode='23514';
    end if;
    return NEW;
  end $$;
  create trigger immutable_payment_corrections before update or delete on payment_corrections
    for each row execute function protect_payment_amendment_history();
  create trigger immutable_installment_edits before update or delete on payment_installment_edits
    for each row execute function protect_payment_amendment_history();
  create trigger no_truncate_payment_corrections before truncate on payment_corrections
    for each statement execute function protect_payment_amendment_history();
  create trigger no_truncate_installment_edits before truncate on payment_installment_edits
    for each statement execute function protect_payment_amendment_history();

  -- One shared payment version. Leave the signed installment arithmetic trigger intact.
  create or replace function payment_link_version() returns trigger language plpgsql as $$
  begin
    if row(new.installment_id,new.amount,new.kind,new.status,new.amount_known,new.paid_on,new.payment_method)
      is distinct from row(old.installment_id,old.amount,old.kind,old.status,old.amount_known,old.paid_on,old.payment_method) then
      if old.plan_version=2147483647 then
        raise exception 'Payment version exhausted' using errcode='23514';
      end if;
      new.plan_version := old.plan_version + 1;
    end if;
    return new;
  end $$;
`);

exports.down = pgm => pgm.sql(`
  lock table payment_corrections,payment_installment_edits in access exclusive mode;
  do $$ begin
    if exists(select 1 from payment_corrections) or exists(select 1 from payment_installment_edits) then
      raise exception 'Cannot discard payment amendment history';
    end if;
  end $$;
  drop table payment_corrections,payment_installment_edits;
  drop function protect_payment_amendment_history();
  alter table payments drop constraint payments_id_deal_history_key;
  create or replace function payment_link_version() returns trigger language plpgsql as $$
  begin
    if row(new.installment_id,new.amount,new.kind,new.status)
      is distinct from row(old.installment_id,old.amount,old.kind,old.status) then
      new.plan_version := old.plan_version + 1;
    end if;
    return new;
  end $$;
`);
