exports.up = pgm => pgm.sql(`
  create table budget_family_contribution_versions (
    wedding_id uuid not null references weddings(id) on delete cascade,
    id uuid not null,
    version integer not null check (version > 0),
    label text not null check (char_length(btrim(label)) between 1 and 120),
    promised_amount bigint not null check (promised_amount between 0 and 9007199254740991),
    received_amount bigint not null check (received_amount between 0 and 9007199254740991),
    archived boolean not null,
    recorded_at timestamptz not null default clock_timestamp(),
    primary key (wedding_id,id,version),
    check (archived or promised_amount > 0 or received_amount > 0)
  );

  create function protect_budget_family_contribution_versions() returns trigger language plpgsql as $$
  begin
    if TG_OP = 'DELETE' and not exists(select 1 from weddings where id=OLD.wedding_id) then
      return OLD;
    end if;
    raise exception using errcode='23514', message='budget_family_contribution_history_immutable';
  end $$;

  create trigger immutable_budget_family_contribution_versions
    before update or delete on budget_family_contribution_versions
    for each row execute function protect_budget_family_contribution_versions();
`)

exports.down = pgm => pgm.sql(`
  lock table budget_family_contribution_versions in access exclusive mode;
  do $$ begin
    if exists(select 1 from budget_family_contribution_versions) then
      raise exception using errcode='23514', message='budget_family_contribution_preserving_down_fr016';
    end if;
  end $$;
  drop table budget_family_contribution_versions;
  drop function protect_budget_family_contribution_versions();
`)
