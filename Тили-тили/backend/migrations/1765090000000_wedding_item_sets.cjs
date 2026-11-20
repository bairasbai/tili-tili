exports.up = pgm => pgm.sql(`
  create table wedding_item_versions (
    wedding_id uuid not null references weddings(id) on delete cascade,
    id uuid not null,
    version integer not null check(version > 0),
    title text not null check(length(btrim(title)) between 1 and 160),
    kit text not null check(kit in ('bride_morning','groom_morning','ceremony','venue','emergency')),
    holder_user_id uuid,
    deliverer_user_id uuid,
    purchase_id uuid,
    purchase_first_version integer generated always as (case when purchase_id is not null then 1 end) stored,
    archived boolean not null default false,
    actor_id uuid references users(id) on delete set null,
    recorded_at timestamptz not null default now(),
    primary key(wedding_id,id,version),
    foreign key(wedding_id,holder_user_id) references wedding_members(wedding_id,user_id) on delete set null (holder_user_id),
    foreign key(wedding_id,deliverer_user_id) references wedding_members(wedding_id,user_id) on delete set null (deliverer_user_id),
    foreign key(wedding_id,purchase_id,purchase_first_version) references wedding_purchase_versions(wedding_id,id,version)
      deferrable initially deferred
  );
  create index wedding_item_latest on wedding_item_versions(wedding_id,id,version desc);
  create index wedding_item_holder on wedding_item_versions(wedding_id,holder_user_id) where holder_user_id is not null;
  create index wedding_item_deliverer on wedding_item_versions(wedding_id,deliverer_user_id) where deliverer_user_id is not null;
  create index wedding_item_purchase on wedding_item_versions(wedding_id,purchase_id) where purchase_id is not null;
`)

exports.down = pgm => pgm.sql(`
  do $$ begin
    if exists (select 1 from wedding_item_versions) then
      raise exception using errcode='23514', message='wedding_item_sets_rollback_preserves_history';
    end if;
  end $$;
  drop table wedding_item_versions;
`)
