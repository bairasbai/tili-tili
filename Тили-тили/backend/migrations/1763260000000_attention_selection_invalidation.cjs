exports.up = pgm => {
  pgm.sql(`create function invalidate_cleared_attention_selection() returns trigger language plpgsql as $$ begin
    if OLD.attention_coordinator_user_id is not null and NEW.attention_coordinator_user_id is null
       and NEW.attention_version=OLD.attention_version then
      NEW.attention_version:=OLD.attention_version+1;
      insert into audit_log(actor_id,action,entity,entity_id,diff)
        values(null,'wedding.attention_selection_cleared','wedding',OLD.id,
          jsonb_build_object('beforeVersion',OLD.attention_version::text,'afterVersion',NEW.attention_version::text,
            'beforeCoordinatorUserId',OLD.attention_coordinator_user_id,'afterCoordinatorUserId',null));
    end if;
    return NEW;
  end $$;
  create trigger attention_selection_invalidation before update of attention_coordinator_user_id on weddings
    for each row execute function invalidate_cleared_attention_selection();`)
}
exports.down = pgm => {
  pgm.sql(`drop trigger attention_selection_invalidation on weddings;
    drop function invalidate_cleared_attention_selection();`)
}
