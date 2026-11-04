exports.up = (pgm) => {
  pgm.sql(`
    create function tilly_real_date_031(value text) returns boolean language plpgsql immutable strict as $$ begin
      if value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
      perform make_date(substring(value,1,4)::int,substring(value,6,2)::int,substring(value,9,2)::int);
      return true;
    exception when datetime_field_overflow then return false; end $$;
    alter table tasks add column revision bigint not null default 1 check(revision>0);
    create function tasks_advance_revision_031() returns trigger language plpgsql as $$ begin
      if TG_OP='INSERT' then
        if NEW.revision<>1 then raise exception using errcode='23514',constraint='tasks_revision_owned'; end if;
      else
        if NEW.revision is distinct from OLD.revision then raise exception using errcode='23514',constraint='tasks_revision_owned'; end if;
        NEW.revision:=OLD.revision+1;
      end if;
      return NEW;
    end $$;
    create trigger tasks_advance_revision_031 before insert or update on tasks for each row execute function tasks_advance_revision_031();
    alter table chats add constraint chats_wedding_message_scope_031 unique(wedding_id,id);
    alter table messages add constraint messages_chat_identity_031 unique(chat_id,id);
    alter table messages add constraint messages_question_author_031 unique(chat_id,id,sender_id);
    create table tilly_actions(
      id uuid primary key,
      wedding_id uuid not null references weddings(id) on delete cascade,
      chat_id uuid not null,
      message_id uuid not null,
      ordinal smallint not null check(ordinal between 0 and 2),
      question_message_id uuid not null,
      recipient_user_id uuid not null references users(id) on delete cascade,
      kind text not null check(kind in('create_task','complete_task','reschedule_task')),
      payload jsonb not null,
      target_task_id uuid,
      expected_revision bigint,
      state text not null default 'pending' check(state in('pending','applied','stale','dismissed')),
      result jsonb,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null default(now()+interval '24 hours'),
      resolved_at timestamptz,
      foreign key(wedding_id,chat_id) references chats(wedding_id,id) on delete cascade,
      foreign key(chat_id,message_id) references messages(chat_id,id) on delete cascade,
      foreign key(chat_id,question_message_id,recipient_user_id) references messages(chat_id,id,sender_id) on delete cascade deferrable initially deferred,
      check(expires_at=created_at+interval '24 hours'),
      check(isfinite(created_at) and isfinite(expires_at) and (resolved_at is null or isfinite(resolved_at))),
      unique(message_id,ordinal),
      check((kind='create_task' and target_task_id is null and expected_revision is null) or (kind<>'create_task' and target_task_id is not null and expected_revision is not null and expected_revision>0)),
      check(jsonb_typeof(payload)='object' and payload ?& array['title','due'] and payload-array['title','due']='{}'::jsonb),
      check(jsonb_typeof(payload->'title')='string' and length(payload->>'title') between 1 and 200 and length(btrim(payload->>'title'))>0),
      check(payload->'due'='null'::jsonb or (jsonb_typeof(payload->'due')='string' and tilly_real_date_031(payload->>'due'))),
      check(kind<>'reschedule_task' or jsonb_typeof(payload->'due')='string'),
      check(kind<>'complete_task' or payload->'due'='null'::jsonb),
      check((state='pending')=(resolved_at is null)),
      check((state='applied')=(result is not null)),
      check(state<>'applied' or kind='create_task' or result->>'taskId'=target_task_id::text),
      check(result is null or (jsonb_typeof(result)='object' and result ? 'taskId' and result-'taskId'='{}'::jsonb and jsonb_typeof(result->'taskId')='string' and result->>'taskId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'))
    );
    create index tilly_actions_message_031 on tilly_actions(chat_id,message_id,created_at,id);
    create function tilly_actions_immutable_031() returns trigger language plpgsql as $$ begin
      if TG_OP='INSERT' then
        if not exists(select 1 from chats where id=NEW.chat_id and wedding_id=NEW.wedding_id and kind='tilly')
          or not exists(select 1 from messages where id=NEW.message_id and chat_id=NEW.chat_id and sender_id is null and guest_id is null)
          or NEW.state<>'pending' or NEW.result is not null or NEW.created_at>clock_timestamp() then
          raise exception using errcode='23514',constraint='tilly_actions_causal_identity';
        end if;
      else
        if OLD.state='pending' and NEW.state='applied' and clock_timestamp()>=OLD.expires_at then
          raise exception using errcode='23514',constraint='tilly_action_expired';
        end if;
        if row(NEW.id,NEW.wedding_id,NEW.chat_id,NEW.message_id,NEW.ordinal,NEW.question_message_id,NEW.recipient_user_id,NEW.kind,NEW.payload,NEW.target_task_id,NEW.expected_revision,NEW.created_at,NEW.expires_at)
          is distinct from row(OLD.id,OLD.wedding_id,OLD.chat_id,OLD.message_id,OLD.ordinal,OLD.question_message_id,OLD.recipient_user_id,OLD.kind,OLD.payload,OLD.target_task_id,OLD.expected_revision,OLD.created_at,OLD.expires_at)
          or (OLD.state<>'pending' and NEW is distinct from OLD) then
          raise exception using errcode='23514',constraint='tilly_actions_immutable';
        end if;
      end if;
      return NEW;
    end $$;
    create trigger tilly_actions_immutable_031 before insert or update on tilly_actions for each row execute function tilly_actions_immutable_031();
  `)
}
exports.down = (pgm) => {
  pgm.sql(`do $$ begin if exists(select 1 from tilly_actions) then
    raise exception using errcode='55000',message='tilly_actions_down_refused: action receipts must be preserved';
  end if; end $$;
  drop table tilly_actions;
  drop function tilly_actions_immutable_031();
  alter table messages drop constraint messages_question_author_031;
  alter table messages drop constraint messages_chat_identity_031;
  alter table chats drop constraint chats_wedding_message_scope_031;
  drop trigger tasks_advance_revision_031 on tasks;
  drop function tasks_advance_revision_031();
  alter table tasks drop column revision;`)
  pgm.sql('drop function tilly_real_date_031(text)')
}
