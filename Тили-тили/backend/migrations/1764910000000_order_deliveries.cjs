exports.up = pgm => {
  pgm.sql(`
    create table order_delivery_steps (
      wedding_id uuid not null,
      deal_id uuid not null,
      revision integer not null check (revision > 0),
      kind text not null,
      previous_revision integer generated always as (nullif(revision - 1, 0)) stored,
      previous_kind text,
      actor_id uuid references users(id) on delete set null,
      summary text,
      material_url text,
      due_on date,
      comment text,
      created_at timestamptz not null default clock_timestamp(),
      primary key (wedding_id, deal_id, revision),
      unique (wedding_id, deal_id, revision, kind),
      foreign key (wedding_id, deal_id) references deal_orders(wedding_id, deal_id) on delete cascade,
      foreign key (wedding_id, deal_id, previous_revision, previous_kind)
        references order_delivery_steps(wedding_id, deal_id, revision, kind),
      constraint order_delivery_transition check (
        (revision = 1 and previous_kind is null and kind = 'submitted')
        or (revision > 1 and previous_kind is not null and (
          (kind = 'submitted' and previous_kind = 'changes_requested')
          or (kind in ('changes_requested', 'accepted') and previous_kind = 'submitted')
        ))
      ),
      constraint order_delivery_payload check (
        (kind = 'submitted' and summary is not null and length(btrim(summary)) between 1 and 1000
          and material_url is not null and length(material_url) <= 2048
          and material_url like 'https://%' and due_on is not null and comment is null)
        or (kind = 'changes_requested' and summary is null and material_url is null and due_on is null
          and comment is not null and length(btrim(comment)) between 1 and 1000)
        or (kind = 'accepted' and summary is null and material_url is null and due_on is null and comment is null)
      )
    );
  `)
}

exports.down = pgm => {
  pgm.sql(`
    lock table order_delivery_steps in access exclusive mode;
    do $$ begin
      if exists (select 1 from order_delivery_steps) then
        raise exception using errcode = '23514', message = 'order_delivery_preserving_down_t012';
      end if;
    end $$;
    drop table order_delivery_steps;
  `)
}
