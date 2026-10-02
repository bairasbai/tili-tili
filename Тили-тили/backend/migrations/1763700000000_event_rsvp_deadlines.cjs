/**
 * T012: единый срок ответа на ДОПОЛНИТЕЛЬНОЕ мероприятие (`is_main=false`),
 * позднюю просьбу гостя организатору и правку ответа парой («внесено
 * организатором», `source='organizer_correction'`).
 *
 * Основной RSVP (`guests.rsvp`, `event_guest_participation` с
 * `source='legacy_main_rsvp'`) не трогаем — у него срока нет (решение D2,
 * контракт T012).
 */
exports.up = (pgm) => {
  pgm.sql(`
    alter table wedding_events add column rsvp_deadline date;
    -- Срок бывает только у дополнительного мероприятия с известным поясом:
    -- без пояса «прошёл/не прошёл» неоднозначно, а у основной программы
    -- срока нет вовсе. Смена time_zone на null при заданном сроке запрещена
    -- этим же CHECK — отдельный триггер-страж не нужен.
    alter table wedding_events add constraint wedding_events_rsvp_deadline_valid
      check (rsvp_deadline is null or (not is_main and time_zone is not null));
    -- Срок не может быть позже даты мероприятия (P2-4). Раньше это проверял
    -- только обработчик PATCH (events.ts) — значение в базе от прямой правки
    -- в обход API не было защищено.
    alter table wedding_events add constraint wedding_events_rsvp_deadline_before_date
      check (rsvp_deadline is null or date is null or rsvp_deadline <= date);

    -- «Внесено организатором» — новый источник ответа persons/event (D3);
    -- team_observation остаётся прежним по смыслу и T012 его не расширяет.
    alter table event_guest_participation drop constraint event_guest_participation_source_check;
    alter table event_guest_participation add constraint event_guest_participation_source_check
      check (source in ('legacy_main_rsvp','guest_response','team_observation','organizer_correction'));

    -- event_rsvp_requests ссылается на приглашение (party_id) составным
    -- ключом, как уже сделано для guests/wedding_events; guest_parties его
    -- раньше не имел.
    alter table guest_parties add constraint guest_parties_wedding_id_unique unique (wedding_id, id);
    -- Составной ключ (wedding_id,id,party_id) на guests — чтобы FK ниже
    -- связывал guest_id С ЕГО ЖЕ party_id декларативно (P3-9): раньше
    -- guest_id и party_id были двумя независимыми FK, и ничто не мешало
    -- записать party_id чужой семьи для верного guest_id. id уже уникален
    -- сам по себе — ограничение только даёт FK на что сослаться.
    alter table guests add constraint guests_wedding_id_id_party_id_unique unique (wedding_id, id, party_id);

    create table event_rsvp_requests (
      id uuid primary key default gen_random_uuid(),
      wedding_id uuid not null,
      program_event_id uuid not null,
      guest_id uuid not null,
      party_id uuid not null,
      requested_status text not null check (requested_status in ('attending','declined')),
      comment text check (comment is null or length(comment) <= 500),
      state text not null default 'pending' check (state in ('pending','accepted','rejected')),
      decision_note text check (decision_note is null or length(decision_note) <= 500),
      decided_by uuid references users(id) on delete set null,
      decided_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      version bigint not null default 1 check (version > 0),
      -- Повтор POST с тем же Idempotency-Key должен вернуть тот же 201, а не
      -- завести вторую просьбу (гостевой токен — не аккаунт, общая таблица
      -- idempotency_keys ключуется users.id и сюда не подходит; тот же приём,
      -- что у gift_contributions.idempotency_key).
      idempotency_key text not null check (length(idempotency_key) between 1 and 200),
      foreign key (wedding_id, program_event_id) references wedding_events(wedding_id, id) on delete cascade,
      -- Составной FK на (guest_id,party_id) вместе (P3-9): party_id обязан
      -- быть ИМЕННО party_id этого guest_id, а не любой валидной семьёй
      -- свадьбы — иначе роспись осталась бы в коде обработчика, а не в базе
      -- (CLAUDE.md §5.11).
      foreign key (wedding_id, guest_id, party_id) references guests(wedding_id, id, party_id) on delete cascade,
      foreign key (wedding_id, party_id) references guest_parties(wedding_id, id) on delete cascade,
      unique (guest_id, idempotency_key),
      check ((state = 'pending') = (decided_at is null))
    );
    -- Одна необработанная просьба на персону/мероприятие одновременно.
    create unique index event_rsvp_request_pending on event_rsvp_requests(program_event_id, guest_id) where state = 'pending';
    create index event_rsvp_request_event on event_rsvp_requests(wedding_id, program_event_id, id);
    create index event_rsvp_request_decided_by on event_rsvp_requests(decided_by) where decided_by is not null;
    -- Индекс под FK (wedding_id,party_id) -> guest_parties (P3-9): без него
    -- у ссылающейся стороны FK нет собственного индекса, и удаление/правка
    -- семьи идёт последовательным сканированием просьб всей свадьбы.
    create index event_rsvp_request_party on event_rsvp_requests(wedding_id, party_id);

    -- DELETE нарочно без предохранителя (P1-1): раньше BEFORE DELETE
    -- запрещал стирать строку, пока жива свадьба, — задумано как «история
    -- просьбы живёт, пока жива свадьба», но тот же запрет бил и по ON DELETE
    -- CASCADE от guest_id/party_id/program_event_id, то есть по ОБЫЧНОМУ
    -- удалению гостя, последнего члена семьи, +1 (легаси POST /rsvp/token
    -- с plusOne:false) или дополнительного мероприятия — все они падали
    -- 500-й, хотя сама операция была легитимна. Прямого DELETE FROM
    -- event_rsvp_requests в коде нет нигде (проверено) — только каскад от
    -- гостя/семьи/мероприятия/свадьбы, так что отдельный запрет не защищает
    -- ни от чего, кроме честного администрирования базы. UPDATE-неизменность
    -- (ниже) остаётся.
    create function protect_event_rsvp_request() returns trigger language plpgsql as $$
    begin
      -- id/wedding/event/guest/party/requested_status/comment/created_at/
      -- idempotency_key неизменны; state/decision_note/decided_at/version
      -- меняет решение пары. decided_by — тоже, но только в две стороны:
      -- null -> реальный пользователь (само решение) и реальный пользователь
      -- -> null (эрозия аккаунта, ON DELETE SET NULL); любой другой переход
      -- (например, подмена решившего на другого пользователя задним числом)
      -- остаётся запрещён.
      if (to_jsonb(NEW) - 'state' - 'decision_note' - 'decided_by' - 'decided_at' - 'version')
          <> (to_jsonb(OLD) - 'state' - 'decision_note' - 'decided_by' - 'decided_at' - 'version')
        or (NEW.decided_by is distinct from OLD.decided_by and not (
          (OLD.decided_by is null and NEW.decided_by is not null) or
          (OLD.decided_by is not null and NEW.decided_by is null and not exists(select 1 from users where id = OLD.decided_by))
        ))
        -- Решённая просьба не возвращается в pending и не меняет решение на
        -- другое: единственный живой путь — из pending в accepted/rejected
        -- (P3-9); decideRequest сам проверяет state='pending' до UPDATE,
        -- это — тот же инвариант задним числом, в базе, а не только в коде.
        or (OLD.state <> 'pending' and NEW.state is distinct from OLD.state) then
        raise exception 'event rsvp request identity is immutable' using errcode = '23514';
      end if;
      return NEW;
    end $$;
    create trigger immutable_event_rsvp_request before update on event_rsvp_requests
      for each row execute function protect_event_rsvp_request();
  `)
}

exports.down = (pgm) => {
  pgm.sql(`
    do $$ begin
      if exists(select 1 from event_rsvp_requests)
        or exists(select 1 from event_guest_participation where source = 'organizer_correction')
        or exists(select 1 from wedding_events where rsvp_deadline is not null) then
        raise exception 'Refusing rollback with event RSVP deadlines, requests or organizer corrections';
      end if;
    end $$;
    drop trigger immutable_event_rsvp_request on event_rsvp_requests;
    drop function protect_event_rsvp_request();
    drop table event_rsvp_requests;
    alter table guests drop constraint guests_wedding_id_id_party_id_unique;
    alter table guest_parties drop constraint guest_parties_wedding_id_unique;
    alter table event_guest_participation drop constraint event_guest_participation_source_check;
    alter table event_guest_participation add constraint event_guest_participation_source_check
      check (source in ('legacy_main_rsvp','guest_response','team_observation'));
    alter table wedding_events drop constraint wedding_events_rsvp_deadline_before_date;
    alter table wedding_events drop constraint wedding_events_rsvp_deadline_valid;
    alter table wedding_events drop column rsvp_deadline;
  `)
}
