exports.up = (pgm) => {
  pgm.sql(`
    create table planb_scenarios (
      wedding_id uuid not null references weddings(id) on delete cascade,
      scenario text not null check (scenario in ('rain','vendor_missing','power','transport')),
      revision uuid not null,
      reason text not null,
      trigger_condition text not null,
      reserve_address text,
      contacts jsonb not null,
      primary key (wedding_id, scenario)
    );
    create table planb_scenario_actions (
      wedding_id uuid not null,
      scenario text not null,
      position integer not null,
      title text not null,
      responsible_user_id uuid,
      primary key (wedding_id, scenario, position),
      foreign key (wedding_id, scenario) references planb_scenarios(wedding_id, scenario) on delete cascade,
      foreign key (wedding_id, responsible_user_id) references wedding_members(wedding_id, user_id)
        on delete set null (responsible_user_id)
    );
    create index planb_scenario_actions_responsible on planb_scenario_actions(wedding_id, responsible_user_id)
      where responsible_user_id is not null;
    alter table broadcasts add column planb_revision uuid,
      add constraint broadcasts_planb_revision_action check (planb_revision is null or action like 'planb:%');
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    lock table broadcasts, planb_scenarios, planb_scenario_actions in access exclusive mode;
    do $$ begin
      if exists (select 1 from planb_scenarios) or exists (select 1 from broadcasts where planb_revision is not null) then
        raise exception 'planb_scenario_preserving_down_t016';
      end if;
    end $$;
    alter table broadcasts drop column planb_revision;
    drop table planb_scenario_actions, planb_scenarios;
  `)
}
