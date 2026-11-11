exports.up = pgm => pgm.sql(`
  alter table complaints add column public_reason text;
  alter table complaints add constraint complaints_public_reason_valid check (
    public_reason is null or (status='resolved' and resolution is not null
      and resolved_at is not null and length(btrim(public_reason)) between 1 and 2000)
  );
  create index complaints_reporter_history on complaints(reporter_id,created_at,id)
    where reporter_id is not null;
`)

exports.down = pgm => pgm.sql(`
  lock table complaints in access exclusive mode;
  do $$ begin
    if exists(select 1 from complaints where public_reason is not null) then
      raise exception using errcode='23514', message='complaint_public_reason_preserving_down_fr069';
    end if;
  end $$;
  drop index complaints_reporter_history;
  alter table complaints drop column public_reason;
`)
