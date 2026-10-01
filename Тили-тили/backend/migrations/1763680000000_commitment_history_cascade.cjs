exports.up = pgm => {
  // Keep scoped NO ACTION references and immutable evidence. Defer their
  // checks until all branches of the whole-wedding cascade have completed.
  pgm.sql(`do $$ declare c record;n integer:=0;begin
    for c in select conrelid::regclass as rel,conname from pg_constraint where contype='f' and
      ((conrelid='deal_resource_commitment_versions'::regclass and confrelid in
        ('deal_terms_versions'::regclass,'deal_resource_plan_versions'::regclass,'deal_resource_commitment_versions'::regclass)) or
       (conrelid='resource_allocations'::regclass and confrelid='deal_resource_commitment_versions'::regclass))
    loop
      execute format('alter table %s alter constraint %I deferrable initially deferred',c.rel,c.conname);n:=n+1;
    end loop;
    if n<>4 then raise exception 'expected four scoped history references';end if;
  end $$;`)
}

exports.down = pgm => {
  pgm.sql(`do $$ declare c record;begin
    if exists(select 1 from deal_resource_commitment_versions) then
      raise exception 'booking evidence exists; use preserving forward migration';
    end if;
    for c in select conrelid::regclass as rel,conname from pg_constraint where contype='f' and
      ((conrelid='deal_resource_commitment_versions'::regclass and confrelid in
        ('deal_terms_versions'::regclass,'deal_resource_plan_versions'::regclass,'deal_resource_commitment_versions'::regclass)) or
       (conrelid='resource_allocations'::regclass and confrelid='deal_resource_commitment_versions'::regclass))
    loop execute format('alter table %s alter constraint %I not deferrable',c.rel,c.conname);end loop;
  end $$;`)
}
