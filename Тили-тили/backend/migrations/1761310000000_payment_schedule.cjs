/**
 * 018-A: график платежей. План не вносит денег; прежние оплаты остаются без этапа.
 *
 * Номер 1761310000000, а не 1761300000000: тот занят миграцией квиза из PR №2
 * (`1761300000000_quiz_answers_matter`) — два файла с одним префиксом упорядочиваются
 * по суффиксу, и выкладка зависела бы от порядка слияния (ревью 018, C-08).
 *
 * `paid` — сумма привязанных к этапу отметок (возвраты со знаком минус, отменённые не
 * считаются); ведёт её триггер `payment_installment_version`, а CHECK держит её в
 * [0; amount]. Раньше правило держал только код под замком сделки — любой писатель
 * без `lockDeal` переплатил бы этап молча (инвариант 11; ревью 018, M-02/C-07).
 */
exports.up = pgm => pgm.sql(`
  create table payment_installments (
    id uuid primary key,
    deal_id uuid not null references deals(id) on delete cascade,
    title text not null check (length(btrim(title)) between 1 and 200),
    amount bigint not null check (amount > 0 and amount <= 9007199254740991),
    currency char(3) not null default 'RUB' constraint payment_installments_currency_rub check (currency = 'RUB'),
    due date not null check (due between '2000-01-01' and '2100-12-31'),
    version integer not null default 1 check (version > 0),
    cancelled_at timestamptz,
    cancel_reason text check (cancel_reason is null or length(cancel_reason) <= 500),
    paid bigint not null default 0 constraint payment_installments_paid_range check (paid between 0 and amount),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(id,deal_id)
  );
  create index payment_installments_deal_due_idx on payment_installments(deal_id,due,id);
  alter table payments add column installment_id uuid,
    add column plan_version integer not null default 1 check (plan_version > 0),
    add constraint payments_installment_deal_fk foreign key (installment_id,deal_id)
      references payment_installments(id,deal_id) on delete set null (installment_id);
  create index payments_installment_idx on payments(installment_id) where installment_id is not null;

  create function payment_link_version() returns trigger language plpgsql as $$
  begin
    if row(new.installment_id,new.amount,new.kind,new.status)
      is distinct from row(old.installment_id,old.amount,old.kind,old.status) then
      new.plan_version := old.plan_version + 1;
    end if;
    return new;
  end $$;
  create trigger payments_link_version before update on payments
    for each row execute function payment_link_version();

  create function payment_installment_version() returns trigger language plpgsql as $$
  declare old_id uuid; new_id uuid; target uuid;
  begin
    if tg_op <> 'INSERT' then old_id := old.installment_id; end if;
    if tg_op <> 'DELETE' then new_id := new.installment_id; end if;
    if tg_op = 'UPDATE' and row(new.installment_id,new.amount,new.kind,new.status)
      is not distinct from row(old.installment_id,old.amount,old.kind,old.status) then return null; end if;
    for target in select id from payment_installments where id in (old_id,new_id) order by id loop
      update payment_installments set version=version+1,updated_at=now(),
        paid=(select coalesce(sum(case when p.kind='refund' then -p.amount else p.amount end),0)
                from payments p where p.installment_id=target and p.status <> 'cancelled')
        where id=target;
    end loop;
    return null;
  end $$;
  create trigger payments_installment_version after insert or update or delete on payments
    for each row execute function payment_installment_version();

  create function payment_schedule_deal_change() returns trigger language plpgsql as $$
  begin
    if new.state = 'cancelled' and old.state <> 'cancelled' then
      update payment_installments set cancelled_at=now(),cancel_reason='Сделка отменена',
        version=version+1,updated_at=now() where deal_id=new.id and cancelled_at is null;
    elsif new.price is distinct from old.price then
      -- No invented new amounts or dates: invalidate drafts and show reconciliation.
      update payment_installments set version=version+1,updated_at=now()
        where deal_id=new.id and cancelled_at is null;
    end if;
    return new;
  end $$;
  create trigger deals_payment_schedule after update of state,price on deals
    for each row execute function payment_schedule_deal_change();
`);
/* Откат стирает этапы и привязки оплат к ним (сами оплаты остаются). На базе с
 * данными — только осознанно: `SET tili.allow_data_loss = 'yes'` в сессии миграции
 * (например, `PGOPTIONS='-c tili.allow_data_loss=yes'`). Ревью 018, C-09/M-12. */
exports.down = pgm => pgm.sql(`
  do $guard$ begin
    if exists (select 1 from payment_installments)
       and coalesce(current_setting('tili.allow_data_loss', true), '') <> 'yes' then
      raise exception 'Откат 018-A сотрёт этапы графика платежей: задайте tili.allow_data_loss=yes, если это осознанно';
    end if;
  end $guard$;
  drop trigger if exists deals_payment_schedule on deals;
  drop function if exists payment_schedule_deal_change();
  drop trigger if exists payments_installment_version on payments;
  drop function if exists payment_installment_version();
  drop trigger if exists payments_link_version on payments;
  drop function if exists payment_link_version();
  alter table payments drop constraint payments_installment_deal_fk,
    drop column installment_id,drop column plan_version;
  drop table payment_installments;
`);
