exports.up = pgm => pgm.sql(`
  lock table weddings, tasks in share row exclusive mode;
  insert into tasks(id,wedding_id,title,period,due,source,kind,sort)
  select gen_random_uuid(),w.id,t.title,t.period,
    case when t.period='12' then (w.date - interval '12 months')::date else w.date + t.days end,
    'system','checklist',t.sort
  from weddings w
  cross join (values
    ('Определить формат и концепцию свадьбы','12',12,null::int),
    ('Подтвердить время и места встречи с командой','last_week',13,-7),
    ('Проверить документы, кольца и контакты команды','wedding_day',14,0),
    ('Проверить выполненные заказы и закрывающие документы','after_wedding',15,7)
  ) as t(title,period,sort,days)
  where w.archived_at is null and w.cancelled_at is null
    and not exists (
      select 1 from tasks existing where existing.wedding_id=w.id
        and existing.kind='checklist' and existing.source='system'
        and existing.period=t.period and existing.sort=t.sort
    );
`)

exports.down = pgm => pgm.sql(`
  lock table tasks in share row exclusive mode;
  do $$ begin
    if exists (
      select 1 from tasks where kind='checklist' and source='system'
        and (period,sort) in (('12',12),('last_week',13),('wedding_day',14),('after_wedding',15))
    ) then
      raise exception using errcode='23514', message='checklist_preserve_plan_stages_fr003';
    end if;
  end $$;
`)
