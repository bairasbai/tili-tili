exports.up = (pgm) => pgm.sql(`
  alter table guests
    add column child_needs varchar(300),
    add column accessibility_needs varchar(300);
`)

exports.down = (pgm) => pgm.sql(`
  lock table guests in access exclusive mode;
  do $$ begin
    if exists (select 1 from guests where child_needs is not null or accessibility_needs is not null) then
      raise exception using errcode = '23514', constraint = 'guest_accommodation_notes_preserve',
        message = 'Guest accommodation notes must be preserved';
    end if;
  end $$;
  alter table guests drop column child_needs, drop column accessibility_needs;
`)
