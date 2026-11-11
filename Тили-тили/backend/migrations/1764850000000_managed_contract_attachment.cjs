/* FR-054. One checked attachment per version with its own author and date. */
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const owner = `(vendor_id is not null and album_wedding_id is null and album_party_id is null
    and album_guest_id is null and album_consent_at is null)
  or (vendor_id is null and album_wedding_id is not null and album_consent_at is not null and album_consent_at <= created_at
    and ((album_party_id is not null and album_guest_id is not null)
      or (album_party_id is null and album_guest_id is null and state in ('ready','deleted','expired'))))`
const photos = "content_type in ('image/jpeg','image/png','image/webp')"
const replaceChecks = (documentSupport) => {
  const suffix = documentSupport ? "(case when document_id is null then '.webp' else '.pdf' end)" : "'.webp'"
  const extensions = documentSupport ? '(webp|pdf)' : 'webp'
  const writerSuffix = documentSupport ? "'.'||split_part(key,'.',2)" : "'.webp'"
  const ready = documentSupport
    ? `((document_id is null and width is not null and height is not null)
      or (document_id is not null and width is null and height is null and output_bytes=size_bytes))`
    : 'width is not null and height is not null'
  return `
    alter table media_objects
      drop constraint media_object_key, drop constraint media_object_writer_key,
      add constraint media_object_key check(key ~ '^(quarantine/${uuid}/original|clean/${uuid}/${uuid}\\.${extensions})$'),
      add constraint media_object_writer_key check(write_phase not in ('inflight','settled','uncertain')
        or (writer_nonce is not null and key='clean/'||split_part(key,'/',2)||'/'||writer_nonce::text||${writerSuffix}));
    alter table media_uploads
      drop constraint media_uploads_content_type_check, drop constraint media_upload_key_identity,
      drop constraint media_upload_candidate_identity, drop constraint media_upload_ready,
      add constraint media_uploads_content_type_check check(${documentSupport
        ? `case when document_id is null then ${photos} else content_type='application/pdf' end` : photos}),
      add constraint media_upload_key_identity check(quarantine_key='quarantine/'||id::text||'/original'
        and (clean_key is null or clean_key ~ (${documentSupport
          ? `'^clean/'||id::text||'/${uuid}\\'||${suffix}||'$'` : `'^clean/'||id::text||'/${uuid}\\.webp$'` }))),
      add constraint media_upload_candidate_identity check(state<>'processing' or
        (clean_key is not null and clean_key='clean/'||id::text||'/'||nonce::text||${suffix})),
      add constraint media_upload_ready check(state<>'ready' or (clean_key is not null and ready_at is not null
        and output_bytes is not null and ${ready} and sha256 is not null));
  `
}

exports.up = (pgm) => pgm.sql(`
  alter table media_uploads
    add column document_id uuid references documents(id) on delete cascade,
    add column document_author_id uuid references users(id),
    add column document_author_side text,
    drop constraint media_album_owner,
    add constraint media_album_owner check (
      (document_id is null and document_author_id is null and document_author_side is null and (${owner}))
      or (document_id is not null and vendor_id is null and album_wedding_id is null and album_party_id is null
        and album_guest_id is null and album_consent_at is null and document_author_side is not null
        and document_author_side in ('couple','vendor')
        and (document_author_id is not null or state in ('ready','deleted','expired')))
    );
  ${replaceChecks(true)}
  create index media_contract_uploads on media_uploads(document_id) where document_id is not null;
  create index media_contract_author on media_uploads(document_author_id) where document_author_id is not null;
  create unique index media_contract_idempotency on media_uploads(document_id,document_author_id,idempotency_key)
    where document_id is not null;
  create unique index media_contract_ready on media_uploads(document_id) where document_id is not null and state='ready';

  create function media_detach_contract_author_t005() returns trigger language plpgsql as $$
  begin
    update media_uploads set document_author_id=null,
      state=case when state in ('pending','processing','failed') then 'deleted' else state end,
      deleted_at=case when state in ('pending','processing','failed') then clock_timestamp() else deleted_at end,
      nonce=null,lease_until=null where document_author_id=OLD.id;
    return OLD;
  end $$;
  create trigger media_detach_contract_author_t005 before delete on users
    for each row execute function media_detach_contract_author_t005();
`)

exports.down = (pgm) => pgm.sql(`
  do $$ begin
    if exists(select 1 from media_uploads where document_id is not null)
      or exists(select 1 from media_objects where key like 'clean/%.pdf') then
      raise exception using errcode='23514',constraint='media_contract_preserving_down_t005',
        message='Managed contract attachments and cleanup obligations must be preserved';
    end if;
  end $$;
  ${replaceChecks(false)}
  drop trigger media_detach_contract_author_t005 on users;
  drop function media_detach_contract_author_t005();
  alter table media_uploads drop constraint media_album_owner,
    add constraint media_album_owner check (${owner}),
    drop column document_author_side, drop column document_author_id, drop column document_id;
`)
