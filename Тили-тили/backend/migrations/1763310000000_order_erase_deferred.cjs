exports.up = pgm => {
  // These links preserve history on individual deletion, but a whole-wedding
  // cascade must be allowed to finish before its sibling branches are checked.
  pgm.sql(`alter table slots alter constraint order_slot_event_fk deferrable initially deferred;
    alter table order_assignments alter constraint order_assignments_wedding_id_slot_id_fkey deferrable initially deferred;
    alter table order_assignments alter constraint order_assignments_wedding_id_program_event_id_fkey deferrable initially deferred;
    alter table order_parts alter constraint order_parts_wedding_id_deal_id_assignment_id_fkey deferrable initially deferred;`)
}
exports.down = pgm => {
  pgm.sql(`do $$ begin
    if exists(select 1 from order_assignments) or exists(select 1 from order_parts)
      or exists(select 1 from slots where program_event_id is not null) then
      raise exception 'Cannot restore immediate checks with structured order dependencies';
    end if;
  end $$;
  alter table slots alter constraint order_slot_event_fk not deferrable;
  alter table order_assignments alter constraint order_assignments_wedding_id_slot_id_fkey not deferrable;
  alter table order_assignments alter constraint order_assignments_wedding_id_program_event_id_fkey not deferrable;
  alter table order_parts alter constraint order_parts_wedding_id_deal_id_assignment_id_fkey not deferrable;`)
}
