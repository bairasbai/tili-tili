exports.up = (pgm) => {
  pgm.sql(`create table invitation_designs (
    wedding_id uuid primary key references weddings(id) on delete cascade,
    draft jsonb not null default '{"schemaVersion":1,"content":[]}'::jsonb,
    published jsonb,
    version bigint not null default 0 check(version >= 0),
    published_at timestamptz,
    updated_at timestamptz not null default now(),
    updated_by uuid references users(id) on delete set null,
    check(jsonb_typeof(draft)='object' and octet_length(draft::text)<=786432),
    check(published is null or (jsonb_typeof(published)='object' and octet_length(published::text)<=786432)),
    check((published is null)=(published_at is null))
  )`)
}
exports.down = (pgm) => {
  pgm.sql(`do $$ begin
    if exists(select 1 from invitation_designs) then
      raise exception using errcode='55000',message='invitation_designs_down_refused: stored drafts/publications must be preserved';
    end if;
  end $$`)
  pgm.dropTable('invitation_designs')
}
