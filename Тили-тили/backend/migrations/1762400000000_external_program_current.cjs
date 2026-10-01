exports.up = pgm => {
  pgm.sql(`
    alter table deals add column current_program_invite_id uuid;
    alter table deals add constraint deals_current_program_external_check
      check (current_program_invite_id is null or (vendor_id is null and external_name is not null));
    alter table deals add constraint deals_current_program_invite_fk
      foreign key (wedding_id,current_program_invite_id,id)
      references external_invites(wedding_id,program_identity,program_deal_id)
      on delete set null (current_program_invite_id);
  `)
}

exports.down = pgm => {
  pgm.sql(`
    do $$ begin
      if exists (select 1 from deals where current_program_invite_id is not null) then
        raise exception 'Cannot remove recorded current program invitation';
      end if;
    end $$;
    alter table deals drop constraint deals_current_program_invite_fk;
    alter table deals drop constraint deals_current_program_external_check;
    alter table deals drop column current_program_invite_id;
  `)
}
