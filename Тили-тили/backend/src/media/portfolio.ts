import type { Queryable } from '../plugins/db.js'
import { AppError, conflict } from '../errors.js'
import { uuidv7 } from '../ids.js'

export const PHOTO_LIMIT = 5
export const CLEANUP_GRACE_SECONDS = 120
export interface PortfolioItem { kind: 'photo' | 'video'; url: string; durationS?: number | null }

/** A failed/deleted intent still owes storage and may still have a live S3 POST.
 * Count each managed upload once; ready vendor_media is not counted a second time. */
export async function assertPhotoQuota(client: Queryable, vendorId: string, additional = 0): Promise<void> {
  const row = (await client.query<{ used: number }>(`select (
    (select count(*) from vendor_media where vendor_id=$1 and kind='photo' and media_upload_id is null)
    +(select count(*) from media_uploads a where a.vendor_id=$1 and (
      a.state='ready' or a.expires_at+interval '2 minutes'>clock_timestamp()
      or (a.state='processing' and a.lease_until>clock_timestamp())
      or exists(select 1 from media_objects o where o.state<>'done' and
        (o.key=a.quarantine_key or o.key like 'clean/'||a.id::text||'/%')))))::int used`, [vendorId])).rows[0]!
  if (row.used + additional > PHOTO_LIMIT) throw conflict('media_photo_limit', 'Не больше пяти фотографий, включая загрузки и ожидающую очистку')
}

export async function refreshPortfolioPhoto(client: Queryable, vendorId: string): Promise<void> {
  await client.query(`update vendors set photo_url=(select url from vendor_media
    where vendor_id=$1 and kind='photo' order by sort,id limit 1) where id=$1`, [vendorId])
}

const managedPath = (url: string, prefixes: string[]) => {
  try {
    const value = new URL(url)
    return prefixes.some(prefix => {
      const own = new URL(prefix)
      return own.origin === value.origin && value.pathname.startsWith(own.pathname)
    })
  } catch { return false }
}

/** Caller already owns lockVendorProfileWrite. Managed identities are retained;
 * dropping one row invokes durable unlink, rather than delete-all/reinsert. */
export async function replacePortfolio(client: Queryable, vendorId: string, incoming: PortfolioItem[], deliveryBaseUrl: string | null): Promise<void> {
  const existing = (await client.query<{ id: string; kind: string; url: string; media_upload_id: string | null }>(
    'select id,kind,url,media_upload_id from vendor_media where vendor_id=$1 order by sort,id', [vendorId])).rows
  const ready = (await client.query<{ id: string; file_url: string }>(
    "select id,file_url from media_uploads where vendor_id=$1 and state='ready'", [vendorId])).rows
  // Retain historic operator origins too, including deleted/foreign uploads.
  // External services may legitimately use the same pathname on their origin.
  const prefixes = (await client.query<{ prefix: string }>('select distinct left(file_url,length(file_url)-36) prefix from media_uploads')).rows.map(r => r.prefix)
  if (deliveryBaseUrl) prefixes.push(`${deliveryBaseUrl}/media/photos/`)
  const owned = new Map(ready.map(a => [a.file_url, a.id])), seen = new Set<string>(), kept = new Set<string>()
  const rows = incoming.map(m => {
    const managedId = owned.get(m.url)
    if ((managedId && m.kind !== 'photo') || (!managedId && managedPath(m.url, prefixes))) {
      throw new AppError(422, 'media_foreign_asset', 'Проверенная фотография не найдена в вашей анкете')
    }
    const identity = `${m.kind}\0${m.url}`
    if (seen.has(identity)) throw new AppError(422, 'media_duplicate', 'Одна работа указана дважды')
    seen.add(identity)
    const old = existing.find(e => e.kind === m.kind && e.url === m.url)
    const id = old?.id ?? uuidv7(); kept.add(id)
    return { ...m, id, managedId: managedId ?? null, old: !!old }
  })
  await client.query('delete from vendor_media where vendor_id=$1 and id<>all($2::uuid[])', [vendorId, [...kept]])
  for (const [sort, row] of rows.entries()) {
    if (row.old) await client.query('update vendor_media set sort=$3,duration_s=$4 where vendor_id=$1 and id=$2', [vendorId, row.id, sort, row.durationS ?? null])
    else await client.query(`insert into vendor_media(id,vendor_id,kind,url,duration_s,sort,media_upload_id)
      values($1,$2,$3,$4,$5,$6,$7)`, [row.id, vendorId, row.kind, row.url, row.durationS ?? null, sort, row.managedId])
  }
  await assertPhotoQuota(client, vendorId)
  await refreshPortfolioPhoto(client, vendorId)
}
