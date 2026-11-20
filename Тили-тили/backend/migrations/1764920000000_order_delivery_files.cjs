const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const photos = "content_type in ('image/jpeg','image/png','image/webp')"
const previousScopes = `(document_id is null and document_author_id is null and document_author_side is null and (
    (vendor_id is not null and album_wedding_id is null and album_party_id is null
      and album_guest_id is null and album_consent_at is null)
    or (vendor_id is null and album_wedding_id is not null and album_consent_at is not null and album_consent_at <= created_at
      and ((album_party_id is not null and album_guest_id is not null)
        or (album_party_id is null and album_guest_id is null and state in ('ready','deleted','expired'))))))
  or (document_id is not null and vendor_id is null and album_wedding_id is null and album_party_id is null
    and album_guest_id is null and album_consent_at is null and document_author_side is not null
    and document_author_side in ('couple','vendor')
    and (document_author_id is not null or state in ('ready','deleted','expired')))`

function mediaChecks(delivery) {
  const pdf = delivery ? "document_id is not null or (delivery_deal_id is not null and content_type='application/pdf')" : 'document_id is not null'
  const suffix = delivery ? `(case when ${pdf} then '.pdf' else '.webp' end)` : "(case when document_id is null then '.webp' else '.pdf' end)"
  const mime = delivery ? `case when document_id is not null then content_type='application/pdf'
    when delivery_deal_id is not null then (${photos} or content_type='application/pdf') else ${photos} end`
    : `case when document_id is null then ${photos} else content_type='application/pdf' end`
  const dimensions = delivery
    ? `((not (${pdf}) and width is not null and height is not null)
      or ((${pdf}) and width is null and height is null and output_bytes=size_bytes))`
    : `((document_id is null and width is not null and height is not null)
      or (document_id is not null and width is null and height is null and output_bytes=size_bytes))`
  return `
    alter table media_uploads
      drop constraint media_uploads_content_type_check, drop constraint media_upload_key_identity,
      drop constraint media_upload_candidate_identity, drop constraint media_upload_ready,
      add constraint media_uploads_content_type_check check(${mime}),
      add constraint media_upload_key_identity check(quarantine_key='quarantine/'||id::text||'/original'
        and (clean_key is null or clean_key ~ ('^clean/'||id::text||'/${uuid}\\'||${suffix}||'$'))),
      add constraint media_upload_candidate_identity check(state<>'processing' or
        (clean_key is not null and clean_key='clean/'||id::text||'/'||nonce::text||${suffix})),
      add constraint media_upload_ready check(state<>'ready' or (clean_key is not null and ready_at is not null
        and output_bytes is not null and ${dimensions} and sha256 is not null));
  `
}

const payload = (requireUrl) => `
  (kind = 'submitted' and summary is not null and length(btrim(summary)) between 1 and 1000
    and ${requireUrl ? "material_url is not null and length(material_url) <= 2048 and material_url like 'https://%'"
      : "(material_url is null or (length(material_url) <= 2048 and material_url like 'https://%'))"}
    and due_on is not null and comment is null)
  or (kind = 'changes_requested' and summary is null and material_url is null and due_on is null
    and comment is not null and length(btrim(comment)) between 1 and 1000)
  or (kind = 'accepted' and summary is null and material_url is null and due_on is null and comment is null)`

exports.up = pgm => pgm.sql(`
  alter table media_uploads
    add column delivery_deal_id uuid references deal_orders(deal_id) on delete cascade,
    add column delivery_revision integer,
    add column delivery_author_id uuid references users(id),
    add constraint media_delivery_identity unique(delivery_deal_id,delivery_revision,id),
    drop constraint media_album_owner,
    add constraint media_album_owner check(
      (delivery_deal_id is null and delivery_revision is null and delivery_author_id is null and (${previousScopes}))
      or (delivery_deal_id is not null and delivery_revision is not null and delivery_revision > 0
        and (delivery_author_id is not null or state in ('ready','deleted','expired'))
        and vendor_id is null and document_id is null and document_author_id is null and document_author_side is null
        and album_wedding_id is null and album_party_id is null and album_guest_id is null and album_consent_at is null)
    );
  ${mediaChecks(true)}
  create unique index media_delivery_idempotency on media_uploads(delivery_deal_id,delivery_author_id,delivery_revision,idempotency_key)
    where delivery_deal_id is not null;
  create index media_delivery_author on media_uploads(delivery_author_id) where delivery_author_id is not null;

  create table order_delivery_attachments(
    wedding_id uuid not null,
    deal_id uuid not null,
    revision integer not null,
    step_kind text generated always as ('submitted'::text) stored,
    position smallint not null check(position between 1 and 5),
    upload_id uuid not null unique,
    primary key(wedding_id,deal_id,revision,position),
    foreign key(wedding_id,deal_id,revision,step_kind)
      references order_delivery_steps(wedding_id,deal_id,revision,kind) on delete cascade,
    foreign key(deal_id,revision,upload_id)
      references media_uploads(delivery_deal_id,delivery_revision,id) deferrable initially deferred
  );
  alter table order_delivery_steps drop constraint order_delivery_payload,
    add constraint order_delivery_payload check(${payload(false)});

  create function order_delivery_require_material_t012() returns trigger language plpgsql as $$
  declare w uuid; d uuid; r integer;
  begin
    if TG_TABLE_NAME = 'order_delivery_steps' then w := NEW.wedding_id; d := NEW.deal_id; r := NEW.revision;
    else w := OLD.wedding_id; d := OLD.deal_id; r := OLD.revision;
    end if;
    if exists(select 1 from order_delivery_steps s
        where s.wedding_id=w and s.deal_id=d and s.revision=r and s.kind='submitted' and s.material_url is null)
      and not exists(select 1 from order_delivery_attachments a where a.wedding_id=w and a.deal_id=d and a.revision=r) then
      raise exception using errcode='23514', constraint='order_delivery_material_required';
    end if;
    return null;
  end $$;
  create constraint trigger order_delivery_step_material_t012 after insert or update on order_delivery_steps
    deferrable initially deferred for each row execute function order_delivery_require_material_t012();
  create constraint trigger order_delivery_attachment_material_t012 after delete or update on order_delivery_attachments
    deferrable initially deferred for each row execute function order_delivery_require_material_t012();

  create function order_delivery_check_attachment_t012() returns trigger language plpgsql as $$
  begin
    perform u.id from media_uploads u join order_delivery_steps s on s.wedding_id=NEW.wedding_id and s.deal_id=NEW.deal_id
      and s.revision=NEW.revision and s.actor_id=u.delivery_author_id
      where u.id=NEW.upload_id and u.delivery_deal_id=NEW.deal_id and u.delivery_revision=NEW.revision and u.state='ready'
      for share of u;
    if not found then raise exception using errcode='23514', constraint='order_delivery_attachment_not_ready'; end if;
    return NEW;
  end $$;
  create trigger order_delivery_check_attachment_t012 before insert or update on order_delivery_attachments
    for each row execute function order_delivery_check_attachment_t012();

  create function order_delivery_preserve_attachment_t012() returns trigger language plpgsql as $$
  begin
    if NEW.state <> 'ready' and exists(select 1 from order_delivery_attachments where upload_id=OLD.id) then
      raise exception using errcode='23514', constraint='order_delivery_attachment_published';
    end if;
    return NEW;
  end $$;
  create trigger order_delivery_preserve_attachment_t012 before update of state on media_uploads
    for each row when (OLD.delivery_deal_id is not null and OLD.state='ready')
    execute function order_delivery_preserve_attachment_t012();

  create function order_delivery_detach_author_t012() returns trigger language plpgsql as $$
  begin
    update media_uploads u set delivery_author_id=null
      where u.delivery_author_id=OLD.id and exists(select 1 from order_delivery_attachments a where a.upload_id=u.id);
    update media_uploads set delivery_author_id=null,state='deleted',deleted_at=coalesce(deleted_at,clock_timestamp()),
      nonce=null,lease_until=null where delivery_author_id=OLD.id;
    return OLD;
  end $$;
  create trigger order_delivery_detach_author_t012 before delete on users
    for each row execute function order_delivery_detach_author_t012();
`)

exports.down = pgm => pgm.sql(`
  lock table order_delivery_steps,order_delivery_attachments,media_uploads in access exclusive mode;
  do $$ begin
    if exists(select 1 from media_uploads where delivery_deal_id is not null)
      or exists(select 1 from order_delivery_attachments) then
      raise exception using errcode='23514', message='order_delivery_files_preserving_down_t012';
    end if;
  end $$;
  drop trigger order_delivery_detach_author_t012 on users;
  drop function order_delivery_detach_author_t012();
  drop trigger order_delivery_preserve_attachment_t012 on media_uploads;
  drop function order_delivery_preserve_attachment_t012();
  drop trigger order_delivery_step_material_t012 on order_delivery_steps;
  drop table order_delivery_attachments;
  drop function order_delivery_require_material_t012();
  drop function order_delivery_check_attachment_t012();
  alter table order_delivery_steps drop constraint order_delivery_payload,
    add constraint order_delivery_payload check(${payload(true)});
  ${mediaChecks(false)}
  alter table media_uploads drop constraint media_album_owner, drop constraint media_delivery_identity,
    add constraint media_album_owner check (${previousScopes}),
    drop column delivery_author_id, drop column delivery_revision, drop column delivery_deal_id;
`)
