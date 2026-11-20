exports.up = pgm => pgm.sql(`
  create table guest_thanks_batches (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    actor_id uuid references users(id) on delete set null,
    body text not null check(length(btrim(body)) between 1 and 2000),
    recipient_count integer not null check(recipient_count between 1 and 500),
    sent_at timestamptz not null default clock_timestamp(),
    unique(wedding_id,id)
  );
  create table guest_thanks_recipients (
    wedding_id uuid not null,
    party_id uuid not null,
    batch_id uuid not null,
    invitation_hash text not null check(invitation_hash ~ '^[0-9a-f]{64}$'),
    primary key(wedding_id,party_id,batch_id),
    foreign key(wedding_id,party_id) references guest_parties(wedding_id,id) on delete cascade,
    foreign key(wedding_id,batch_id) references guest_thanks_batches(wedding_id,id) on delete cascade
  );
  create index guest_thanks_recipients_batch on guest_thanks_recipients(wedding_id,batch_id);
`)

exports.down = pgm => pgm.sql(`
  lock table guest_thanks_batches,guest_thanks_recipients in access exclusive mode;
  do $$ begin
    if exists(select 1 from guest_thanks_batches) then
      raise exception using errcode='23514', message='guest_thanks_preserving_down_t021';
    end if;
  end $$;
  drop table guest_thanks_recipients,guest_thanks_batches;
`)
