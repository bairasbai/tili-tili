exports.up = pgm => pgm.sql(`
  create table home_tip_decisions (
    wedding_id uuid not null references weddings(id) on delete cascade,
    tip_id text not null check (tip_id ~ '^[0-9a-f]{64}$'),
    state text check (state in ('resolved','not_applicable')),
    revision integer not null check (revision > 0),
    primary key(wedding_id,tip_id)
  );
`)

exports.down = pgm => pgm.sql(`
  lock table home_tip_decisions in access exclusive mode;
  do $$ begin
    if exists (select 1 from home_tip_decisions) then
      raise exception using errcode='23514', message='home_tip_decisions_preserving_down_fr063';
    end if;
  end $$;
  drop table home_tip_decisions;
`)
