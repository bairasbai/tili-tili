/* No historical context is inferred. Old main requests retain their NULL
 * snapshot; new event-aware requests carry immutable server-owned material. */
exports.up = pgm => {
  pgm.sql(`
    alter table offer_requests add column program_event_context jsonb;
    create function offer_request_event_context_guard() returns trigger language plpgsql as $$
    declare actual jsonb; extra boolean;
    begin
      if TG_OP='UPDATE' then
        if row(new.program_event_context,new.slot_id,new.wedding_date) is distinct from
          row(old.program_event_context,old.slot_id,old.wedding_date) then
          raise exception 'offer request event snapshot is immutable' using errcode='23514',constraint='offer_request_event_context';
        end if;
        return new;
      end if;
      select jsonb_build_object('id',e.id,'isMain',s.program_event_id is null or e.is_main,
        'date',case when s.program_event_id is null or e.is_main then w.date else e.date end,
        'timeZone',case when s.program_event_id is null or e.is_main then w.tz else e.time_zone end,
        'name',e.name,'kind',e.kind,'location',e.location),
        s.program_event_id is not null and not coalesce(e.is_main,false)
      into actual,extra
      from slots s join weddings w on w.id=s.wedding_id left join wedding_events e
        on e.wedding_id=s.wedding_id and (e.id=s.program_event_id or (s.program_event_id is null and e.is_main))
      where s.id=new.slot_id;
      if new.program_event_context is null then
        if extra then raise exception 'additional offer request needs event context' using errcode='23514',constraint='offer_request_event_context'; end if;
      elsif new.program_event_context is distinct from actual
        or new.wedding_date is distinct from (actual->>'date')::date
        or (extra and (actual->>'id' is null or actual->>'date' is null or actual->>'timeZone' is null)) then
        raise exception 'offer request needs exact current event context' using errcode='23514',constraint='offer_request_event_context';
      end if;
      return new;
    end $$;
    create trigger offer_request_event_context_guard before insert or update of program_event_context,slot_id,wedding_date
      on offer_requests for each row execute function offer_request_event_context_guard();
  `)
}
exports.down = pgm => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from offer_requests where program_event_context is not null) then
        raise exception 'retain event-aware offer requests before downgrade' using errcode='23514';
      end if;
    end $$;
    drop trigger offer_request_event_context_guard on offer_requests;
    drop function offer_request_event_context_guard();
    alter table offer_requests drop column program_event_context;
  `)
}
