/** FR011: preserve both history tables while naming their existing RUB checks. */
function rename(pgm, forward) {
  const from = forward ? '_currency_check' : '_currency_rub'
  const to = forward ? '_currency_rub' : '_currency_check'
  pgm.sql(`
    lock table payment_corrections, payment_installment_edits in access exclusive mode;
    do $$
    declare t text; source_name text; target_name text; currency_att smallint;
    begin
      foreach t in array array['payment_corrections','payment_installment_edits'] loop
        source_name := t || '${from}'; target_name := t || '${to}';
        select attnum into strict currency_att from pg_attribute
          where attrelid=('public.' || t)::regclass and attname='currency' and not attisdropped;
        if (select count(*) from pg_constraint where conrelid=('public.' || t)::regclass
              and contype='c' and convalidated and conkey=array[currency_att]
              and pg_get_constraintdef(oid) = 'CHECK ((currency = ''RUB''::bpchar))') <> 1
           or not exists (select 1 from pg_constraint where conrelid=('public.' || t)::regclass
              and conname=source_name and contype='c' and convalidated and conkey=array[currency_att]
              and pg_get_constraintdef(oid) = 'CHECK ((currency = ''RUB''::bpchar))')
           or exists (select 1 from pg_constraint where conrelid=('public.' || t)::regclass and conname=target_name) then
          raise exception 'FR011 currency check structure differs for %', t;
        end if;
        execute format('alter table public.%I rename constraint %I to %I', t, source_name, target_name);
      end loop;
    end $$;
  `)
}
exports.up = pgm => rename(pgm, true)
exports.down = pgm => rename(pgm, false)
