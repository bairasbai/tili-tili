exports.up = pgm => pgm.sql(`
  alter table wedding_purchase_versions
    add column rental_pickup_on date,
    add column rental_return_on date,
    add column deposit_expected bigint,
    add column deposit_paid bigint,
    add column deposit_refunded bigint,
    add column deposit_disputed bigint,
    add column rental_changed boolean not null default false,
    add constraint wedding_purchase_rental_shape check (
      (rental_pickup_on is null and rental_return_on is null and deposit_expected is null
        and deposit_paid is null and deposit_refunded is null and deposit_disputed is null and not rental_changed)
      or
      (rental_pickup_on is not null and rental_return_on is not null and rental_return_on >= rental_pickup_on
        and deposit_expected is not null and deposit_expected between 0 and 9007199254740991
        and deposit_paid is not null and deposit_paid between 0 and deposit_expected
        and deposit_refunded is not null and deposit_refunded between 0 and deposit_paid
        and deposit_disputed is not null and deposit_disputed between 0 and deposit_paid - deposit_refunded)
    );
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists (select 1 from wedding_purchase_versions where rental_pickup_on is not null) then
      raise exception using errcode='23514', message='wedding_rental_deposits_rollback_preserves_history';
    end if;
  end $$;
  alter table wedding_purchase_versions
    drop constraint wedding_purchase_rental_shape,
    drop column rental_pickup_on, drop column rental_return_on, drop column deposit_expected,
    drop column deposit_paid, drop column deposit_refunded, drop column deposit_disputed, drop column rental_changed;
`)
