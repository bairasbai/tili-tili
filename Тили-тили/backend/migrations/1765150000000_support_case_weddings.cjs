exports.up = pgm => pgm.sql(`
  alter table support_cases add column wedding_id uuid references weddings(id) on delete set null;
  create index support_cases_wedding on support_cases(wedding_id) where wedding_id is not null;
`)

exports.down = pgm => pgm.sql(`
  lock table support_cases in access exclusive mode;
  do $$ begin
    if exists (select 1 from support_cases where wedding_id is not null) then
      raise exception using errcode='23514', message='support_case_weddings_preserving_down';
    end if;
  end $$;
  alter table support_cases drop column wedding_id;
`)
