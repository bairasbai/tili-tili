exports.up = pgm => pgm.sql(`
  lock table weddings, tasks in share row exclusive mode;
  insert into tasks(id,wedding_id,title,period,due,source,kind,sort)
  select gen_random_uuid(),w.id,'Утвердить окончательное меню','1',
    (w.date-interval '1 month')::date,'system','checklist',16
  from weddings w
  where w.archived_at is null and w.cancelled_at is null
    and not exists (
      select 1 from tasks t where t.wedding_id=w.id and t.kind='checklist'
        and t.source='system' and t.period='1' and t.sort=16
    );
`)

exports.down = pgm => pgm.sql(`
  lock table tasks in share row exclusive mode;
  do $$ begin
    if exists (select 1 from tasks where kind='checklist' and source='system' and period='1' and sort=16) then
      raise exception using errcode='23514', message='checklist_preserve_final_menu_fr005';
    end if;
  end $$;
`)
