exports.up = pgm => {
  pgm.sql(`alter table order_assignments add constraint staff_assignment_event_identity
      unique(wedding_id,deal_id,id,program_event_id);
    alter table vendor_staff_duties add constraint staff_duty_assignment_event_scope
      foreign key(wedding_id,deal_id,assignment_id,program_event_id)
      references order_assignments(wedding_id,deal_id,id,program_event_id)
      deferrable initially deferred;`)
}

exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from vendor_staff_duties where assignment_id is not null) then
      raise exception 'scoped staff duties exist; do not weaken event binding';
    end if;
  end $$;
  alter table vendor_staff_duties drop constraint staff_duty_assignment_event_scope;
  alter table order_assignments drop constraint staff_assignment_event_identity;`)
}
