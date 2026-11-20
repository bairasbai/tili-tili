exports.up = pgm => pgm.sql(`
  alter table budget_items
    add column linked_deal_id uuid,
    add column deal_link_version integer not null default 0,
    add constraint budget_item_deal_link_version check (deal_link_version >= 0 and (linked_deal_id is null or deal_link_version > 0)),
    add constraint budget_item_deal_link_wedding foreign key (wedding_id, linked_deal_id)
      references deals (wedding_id, id) deferrable initially deferred;

  create index budget_item_linked_deal on budget_items (wedding_id, linked_deal_id)
    where linked_deal_id is not null;
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists (select 1 from budget_items where linked_deal_id is not null or deal_link_version <> 0) then
      raise exception using errcode='23514', message='budget_deal_links_rollback_preserves_associations';
    end if;
  end $$;

  drop index budget_item_linked_deal;
  alter table budget_items
    drop constraint budget_item_deal_link_wedding,
    drop constraint budget_item_deal_link_version,
    drop column linked_deal_id,
    drop column deal_link_version;
`)
