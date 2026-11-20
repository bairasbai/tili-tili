exports.up = pgm => pgm.sql(`
  create table wedding_decisions (
    id uuid primary key,
    wedding_id uuid not null references weddings(id) on delete cascade,
    proposer_id uuid references users(id) on delete set null,
    partner_id uuid references users(id) on delete set null,
    request_id uuid not null,
    title text not null check (char_length(title) <= 120 and title ~ '[^[:space:]]'),
    created_at timestamptz not null default now(),
    unique(wedding_id, proposer_id, request_id),
    check (proposer_id is null or partner_id is null or proposer_id <> partner_id)
  );
  create index wedding_decisions_wedding_idx on wedding_decisions(wedding_id, created_at desc, id desc);

  create table wedding_decision_versions (
    decision_id uuid not null references wedding_decisions(id) on delete cascade,
    version integer not null check (version > 0),
    author_id uuid references users(id) on delete set null,
    proposal text not null check (char_length(proposal) <= 2000 and proposal ~ '[^[:space:]]'),
    proposer_response text check (proposer_response in ('approved','rejected')),
    partner_response text check (partner_response in ('approved','rejected')),
    effective_at timestamptz,
    primary key(decision_id, version),
    check ((effective_at is not null) = (proposer_response is not distinct from 'approved'
      and partner_response is not distinct from 'approved'))
  );
`)

exports.down = pgm => pgm.sql(`
  lock table wedding_decisions, wedding_decision_versions in access exclusive mode;
  do $$ begin
    if exists (select 1 from wedding_decisions) then
      raise exception using errcode='23514', message='wedding_decisions_preserving_down_fr007';
    end if;
  end $$;
  drop table wedding_decision_versions;
  drop table wedding_decisions;
`)
