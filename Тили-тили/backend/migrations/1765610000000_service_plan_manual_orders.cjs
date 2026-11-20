exports.up = (pgm) => pgm.sql(`
  create table service_plan_manual_orders (
    order_id uuid primary key references service_plan_orders(id) on delete restrict,
    save_receipt_copy boolean not null,
    receipt_email text check (length(receipt_email) between 3 and 254),
    receipt_inn text check (receipt_inn ~ '^([0-9]{10}|[0-9]{12})$'),
    submitted_at timestamptz,
    reviewed_at timestamptz,
    reviewed_by uuid references users(id) on delete set null,
    closed_at timestamptz,
    closed_by uuid references users(id) on delete set null,
    receipt_url text unique check (length(receipt_url) <= 512),
    check (reviewed_at is not null or (reviewed_by is null and receipt_url is null)),
    check (closed_at is not null or closed_by is null),
    check (closed_at is null or reviewed_at is null),
    check (receipt_url is null or save_receipt_copy),
    check (reviewed_at is null or not save_receipt_copy or receipt_url is not null)
  );

  create function erase_service_plan_receipt_contact() returns trigger language plpgsql as $$
  begin
    update service_plan_manual_orders set receipt_email = null, receipt_inn = null where order_id = new.id;
    return new;
  end;
  $$;
  create trigger service_plan_receipt_contact_erasure after update of customer_id on service_plan_orders
    for each row when (old.customer_id is not null and new.customer_id is null)
    execute function erase_service_plan_receipt_contact();
`)

exports.down = (pgm) => pgm.sql(`
  lock table service_plan_manual_orders in access exclusive mode;
  do $$ begin
    if exists (select 1 from service_plan_manual_orders) then
      raise exception using errcode = '23514', constraint = 'service_plan_manual_orders_preserve',
        message = 'Manual service plan orders must be preserved';
    end if;
  end $$;
  drop trigger service_plan_receipt_contact_erasure on service_plan_orders;
  drop function erase_service_plan_receipt_contact();
  drop table service_plan_manual_orders;
`)
