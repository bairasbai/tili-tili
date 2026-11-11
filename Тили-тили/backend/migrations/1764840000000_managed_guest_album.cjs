/* T005. Album uploads share the existing durable object and cleanup lifecycle. */
exports.up = (pgm) => pgm.sql(`
  alter table media_uploads
    alter column vendor_id drop not null,
    add column album_wedding_id uuid,
    add column album_party_id uuid,
    add column album_guest_id uuid,
    add column album_consent_at timestamptz,
    add constraint media_album_owner check (
      (vendor_id is not null and album_wedding_id is null and album_party_id is null
        and album_guest_id is null and album_consent_at is null)
      or (vendor_id is null and album_wedding_id is not null and album_party_id is not null
        and album_guest_id is not null and album_consent_at is not null and album_consent_at <= created_at)
    ),
    add constraint media_album_party foreign key (album_wedding_id, album_party_id)
      references guest_parties(wedding_id, id) on delete cascade,
    add constraint media_album_guest foreign key (album_wedding_id, album_guest_id)
      references guests(wedding_id, id) on delete cascade,
    add constraint media_album_upload_wedding unique (id, album_wedding_id);

  create unique index media_album_idempotency on media_uploads
    (album_wedding_id, album_party_id, album_guest_id, idempotency_key) where album_wedding_id is not null;
  create index media_album_guest_uploads on media_uploads
    (album_wedding_id, album_guest_id) where album_wedding_id is not null;

  alter table album_photos add column media_upload_id uuid unique;
  alter table album_photos add constraint album_photo_managed_wedding
    foreign key (media_upload_id, wedding_id) references media_uploads(id, album_wedding_id) on delete cascade;

  create function media_link_album_t005() returns trigger language plpgsql as $$
  begin
    if (NEW.media_upload_id is null and exists(select 1 from media_uploads a where a.file_url=NEW.url))
      or (NEW.media_upload_id is not null and not exists (
        select 1 from media_uploads a where a.id=NEW.media_upload_id and a.album_wedding_id=NEW.wedding_id
          and a.album_guest_id=NEW.uploaded_by and a.state='ready' and a.file_url=NEW.url
      )) then
      raise exception using errcode='23514',constraint='album_photo_managed_link_t005';
    end if;
    return NEW;
  end $$;
  create trigger media_link_album_t005 before insert or update of media_upload_id,wedding_id,url on album_photos
    for each row execute function media_link_album_t005();

  create function media_unlink_album_t005() returns trigger language plpgsql as $$
  begin
    if OLD.media_upload_id is not null and (TG_OP='DELETE' or NEW.media_upload_id is distinct from OLD.media_upload_id) then
      update media_uploads set state='deleted',deleted_at=clock_timestamp(),nonce=null,lease_until=null
      where id=OLD.media_upload_id and album_wedding_id=OLD.wedding_id and state<>'deleted';
    end if;
    if TG_OP='DELETE' then return OLD; end if;
    return NEW;
  end $$;
  create trigger media_unlink_album_t005 before delete or update of media_upload_id on album_photos
    for each row execute function media_unlink_album_t005();
`)

exports.down = (pgm) => pgm.sql(`
  do $$ begin
    if exists(select 1 from media_uploads where album_wedding_id is not null)
      or exists(select 1 from album_photos where media_upload_id is not null) then
      raise exception using errcode='23514',constraint='media_album_preserving_down_t005',
        message='Managed album media data must be preserved';
    end if;
  end $$;
  drop trigger media_unlink_album_t005 on album_photos;
  drop function media_unlink_album_t005();
  drop trigger media_link_album_t005 on album_photos;
  drop function media_link_album_t005();
  alter table album_photos drop column media_upload_id;
  alter table media_uploads
    drop constraint media_album_upload_wedding,
    drop column album_consent_at,
    drop column album_guest_id,
    drop column album_party_id,
    drop column album_wedding_id,
    alter column vendor_id set not null;
`)
