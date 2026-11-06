/* 032-B. Object deletion obligations deliberately outlive account/vendor cascades. */
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
exports.up = (pgm) => pgm.sql(`
  create table media_objects (
    key text primary key,
    storage_id text not null check(storage_id ~ '^[a-f0-9]{64}$'),
    not_before timestamptz not null,
    state text not null default 'pending' check(state in ('pending','deleting','done','failed')),
    write_phase text not null default 'registered' check(write_phase in ('registered','inflight','settled','uncertain','external')),
    writer_nonce uuid,
    external_until timestamptz,
    obligation_version bigint not null default 0 check(obligation_version>=0),
    nonce uuid,
    lease_until timestamptz,
    attempts integer not null default 0 check(attempts between 0 and 8),
    last_error text check(last_error in ('media_storage_unavailable','media_write_uncertain')),
    updated_at timestamptz not null default clock_timestamp(),
    unique(key,storage_id),
    constraint media_object_key check(key ~ '^(quarantine/${uuid}/original|clean/${uuid}/${uuid}\\.webp)$'),
    constraint media_object_claim check((state='deleting' and nonce is not null and lease_until is not null)
      or (state<>'deleting' and nonce is null and lease_until is null)),
    constraint media_object_writer check((write_phase in ('inflight','settled','uncertain'))=(writer_nonce is not null)),
    constraint media_object_writer_key check(write_phase not in ('inflight','settled','uncertain')
      or (writer_nonce is not null and key='clean/'||split_part(key,'/',2)||'/'||writer_nonce::text||'.webp')),
    constraint media_object_done check(state<>'done' or write_phase in ('registered','settled','external')),
    constraint media_object_external check((write_phase='external')=(external_until is not null)
      and (key like 'quarantine/%')=(write_phase='external') and (external_until is null or not_before>=external_until))
  );
  create index media_objects_due on media_objects(storage_id,not_before,key) where state in ('pending','deleting');
  create table media_uploads (
    id uuid primary key,
    vendor_id uuid not null references vendors(id) on delete cascade,
    storage_id text not null check(storage_id ~ '^[a-f0-9]{64}$'),
    idempotency_key text not null check(length(idempotency_key) between 1 and 128),
    content_type text not null check(content_type in ('image/jpeg','image/png','image/webp')),
    size_bytes integer not null check(size_bytes between 1 and 10485760),
    state text not null default 'pending' check(state in ('pending','processing','ready','failed','deleted','expired')),
    created_at timestamptz not null default clock_timestamp(),
    expires_at timestamptz not null default (clock_timestamp()+interval '5 minutes'),
    quarantine_key text not null unique,
    clean_key text unique,
    file_url text not null unique,
    nonce uuid,
    lease_until timestamptz,
    attempts integer not null default 0 check(attempts between 0 and 3),
    ready_at timestamptz,
    deleted_at timestamptz,
    output_bytes integer check(output_bytes between 1 and 10485760),
    width integer check(width between 1 and 8192),
    height integer check(height between 1 and 8192),
    sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),
    error_code text,
    unique(vendor_id,idempotency_key),
    unique(id,vendor_id),
    foreign key(quarantine_key,storage_id) references media_objects(key,storage_id),
    foreign key(clean_key,storage_id) references media_objects(key,storage_id),
    constraint media_upload_key_identity check(quarantine_key='quarantine/'||id::text||'/original'
      and (clean_key is null or clean_key ~ ('^clean/'||id::text||'/${uuid}\\.webp$'))),
    constraint media_upload_window check(expires_at>created_at and expires_at<=created_at+interval '5 minutes 1 second'),
    constraint media_upload_claim check((state='processing' and nonce is not null and lease_until is not null)
      or (state<>'processing' and nonce is null and lease_until is null)),
    constraint media_upload_candidate_identity check(state<>'processing' or (clean_key is not null and clean_key='clean/'||id::text||'/'||nonce::text||'.webp')),
    constraint media_upload_ready check(state<>'ready' or (clean_key is not null and ready_at is not null and output_bytes is not null and width is not null and height is not null and sha256 is not null))
  );
  create index media_uploads_company on media_uploads(vendor_id,created_at,id);
  alter table vendor_media add column media_upload_id uuid unique;
  alter table vendor_media add constraint vendor_media_managed_company foreign key(media_upload_id,vendor_id)
    references media_uploads(id,vendor_id) on delete cascade;
  alter table vendor_media add constraint vendor_media_managed_photo check(media_upload_id is null or kind='photo');

  create function media_link_portfolio_032() returns trigger language plpgsql as $$
  begin
    if (NEW.media_upload_id is null and exists(select 1 from media_uploads a where a.file_url=NEW.url))
      or (NEW.media_upload_id is not null and not exists(select 1 from media_uploads a
        where a.id=NEW.media_upload_id and a.vendor_id=NEW.vendor_id and a.state='ready' and a.file_url=NEW.url)) then
      raise exception using errcode='23514',constraint='vendor_media_managed_link_032';
    end if;
    return NEW;
  end $$;
  create trigger media_link_portfolio_032 before insert or update of media_upload_id,vendor_id,url on vendor_media
    for each row execute function media_link_portfolio_032();

  create function media_capture_cleanup_032() returns trigger language plpgsql as $$
  begin
    -- Always keep existing obligations, including uncertain prior candidates.
    -- No object is removed here, even when account erasure owns the transaction.
    update media_objects set
      not_before=greatest(not_before,OLD.expires_at+interval '2 minutes',coalesce(OLD.lease_until,clock_timestamp())+interval '2 minutes'),
      state=case when state='done' then 'pending' else state end,
      obligation_version=obligation_version+1,
      updated_at=clock_timestamp()
    where key=OLD.quarantine_key or key like 'clean/'||OLD.id::text||'/%';
    return OLD;
  end $$;
  create trigger media_capture_cleanup_032 before delete on media_uploads for each row execute function media_capture_cleanup_032();

  create function media_unlink_portfolio_032() returns trigger language plpgsql as $$
  begin
    if OLD.media_upload_id is not null and (TG_OP='DELETE' or NEW.media_upload_id is distinct from OLD.media_upload_id) then
      update media_uploads set state='deleted',deleted_at=clock_timestamp(),nonce=null,lease_until=null
      where id=OLD.media_upload_id and state<>'deleted';
      -- not_before was registered before every external write. Never shorten it.
    end if;
    if TG_OP='DELETE' then return OLD; end if;
    return NEW;
  end $$;
  create trigger media_unlink_portfolio_032 before delete or update of media_upload_id on vendor_media
    for each row execute function media_unlink_portfolio_032();
`)

exports.down = (pgm) => pgm.sql(`
  -- A successful managed-data downgrade would discard required deletion keys.
  -- Refuse before any DDL; legacy-only databases can actually down/up/replay.
  do $$ begin
    if exists(select 1 from media_uploads) or exists(select 1 from media_objects) then
      raise exception using errcode='23514',constraint='media_preserving_down_032',
        message='Managed media data must be preserved; use the reviewed recovery procedure';
    end if;
  end $$;
  drop trigger media_unlink_portfolio_032 on vendor_media;
  drop function media_unlink_portfolio_032();
  drop trigger media_link_portfolio_032 on vendor_media;
  drop function media_link_portfolio_032();
  alter table vendor_media drop column media_upload_id;
  drop table media_uploads;
  drop function media_capture_cleanup_032() cascade;
  drop table media_objects;
`)
