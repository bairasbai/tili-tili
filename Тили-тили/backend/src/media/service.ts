import { createHash, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound } from '../errors.js'
import { lockVendorProfileWrite } from '../vendor/profile-locks.js'
import { assertSeatingToken } from '../wedding/access.js'
import { lockCurrentConsent } from '../auth/consent.js'
import { mediaStorageIdentity, type MediaStorageConfig } from './config.js'
import { S3MediaStore, PHOTO_MAX_BYTES, photoInvalid, storageUnavailable, type MediaStore } from './storage.js'
import { ClamMediaScanner, type MediaScanner } from './scanner.js'
import { normalizePortfolioPhoto } from './photo.js'
import { assertPhotoQuota, refreshPortfolioPhoto } from './portfolio.js'

interface Asset {
  id: string; vendor_id: string; storage_id: string; content_type: string; size_bytes: number
  state: 'pending' | 'processing' | 'ready' | 'failed' | 'deleted' | 'expired'
  created_at: Date; expires_at: Date; quarantine_key: string; clean_key: string | null; file_url: string
  nonce: string | null; lease_until: Date | null; attempts: number; ready_at: Date | null
  deleted_at: Date | null; output_bytes: number | null; width: number | null; height: number | null; error_code: string | null; sha256: string | null
}
interface ObjectRow { key: string; storage_id: string; state: string; not_before: Date; external_until: Date | null; nonce: string | null; lease_until: Date | null; attempts: number
  write_phase: 'registered' | 'inflight' | 'settled' | 'uncertain' | 'external'; writer_nonce: string | null; obligation_version: string }
export interface UploadInput { kind: string; contentType: string; sizeBytes: number }
const disabled = () => new AppError(501, 'storage_not_configured', 'Загрузка фотографий пока не подключена')
const now = async (q: Queryable) => (await q.query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at
const dto = (a: Asset, at: Date) => ({ uploadId: a.id, state: a.state, contentType: a.content_type,
  sizeBytes: a.size_bytes, createdAt: a.created_at.toISOString(), expiresAt: a.expires_at.toISOString(),
  readyAt: a.ready_at?.toISOString() ?? null, deletedAt: a.deleted_at?.toISOString() ?? null,
  fileUrl: a.state === 'ready' ? a.file_url : null, outputBytes: a.output_bytes, width: a.width, height: a.height,
  errorCode: a.error_code, retryable: ['pending', 'failed', 'processing'].includes(a.state) && a.expires_at > at && a.attempts < 3 })

/** No provider operation runs while a SQL transaction or company lock is held. */
export class ManagedMediaService {
  private readonly store: MediaStore | null
  private readonly scanner: MediaScanner | null
  private readonly storageId: string | null
  private processing = 0
  private delivering = 0
  constructor(private readonly db: Db, private readonly config: MediaStorageConfig | null,
    store?: MediaStore, scanner?: MediaScanner) {
    this.store = store ?? (config ? new S3MediaStore(config) : null)
    this.scanner = scanner ?? (config ? new ClamMediaScanner(config.scannerHost, config.scannerPort) : null)
    this.storageId = config ? mediaStorageIdentity(config) : null
  }
  close(): void { this.store?.close() }
  private boundedPost(): boolean {
    const bound = this.config?.postMaxSeconds
    return typeof bound === 'number' && Number.isInteger(bound) && bound >= 1 && bound <= 60
  }
  private enabled(): { store: MediaStore; scanner: MediaScanner; config: MediaStorageConfig } {
    if (!this.store || !this.scanner || !this.config) throw disabled()
    return { store: this.store, scanner: this.scanner, config: this.config }
  }
  private sameStorage(a: Asset): void {
    if (!this.storageId || a.storage_id !== this.storageId) throw new AppError(503, 'media_storage_unavailable', 'Хранилище этой фотографии временно недоступно')
  }
  private async owner<T>(request: FastifyRequest, action: (q: Queryable, vendor: string) => Promise<T>,
    options: { blocked?: boolean; rights?: boolean; missing?: boolean } = {}): Promise<T> {
    return this.db.tx(async q => {
      const caller = request.caller!
      const id = await lockVendorProfileWrite(q, { ...caller, policyVersion: request.server.appConfig.policyVersion }, undefined)
      if (!id && !options.missing) throw forbidden('Нужна собственная анкета подрядчика')
      if (id) {
        const vendor = (await q.query<{ user_id: string; media_rights_at: Date | null; blocked_at: Date | null }>(
          'select user_id,media_rights_at,blocked_at from vendors where id=$1', [id])).rows[0]
        if (!vendor || vendor.user_id !== caller.userId) throw notFound('Анкета не найдена')
        if (!options.blocked && vendor.blocked_at) throw forbidden('Анкета заблокирована')
        if (options.rights !== false && !vendor.media_rights_at) throw forbidden('Подтвердите права на фотографии в анкете')
      }
      const result = await action(q, id ?? '')
      // Includes waits for asset/object locks in action(), not just the pre-handler.
      await assertSeatingToken(request)
      return result
    })
  }
  private async asset(q: Queryable, vendor: string, id: string): Promise<Asset> {
    const a = (await q.query<Asset>('select * from media_uploads where vendor_id=$1 and id=$2 for update', [vendor, id])).rows[0]
    if (!a) throw notFound('Загрузка не найдена')
    return a
  }
  async issue(request: FastifyRequest, input: UploadInput, key: string) {
    const { store, config } = this.enabled()
    if (!this.boundedPost()) throw disabled()
    if (input.kind !== 'vendor_photo') throw new AppError(501, 'media_kind_not_enabled', 'Этот вид файлов пока не подключён')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.contentType) || !Number.isSafeInteger(input.sizeBytes)
      || input.sizeBytes < 1 || input.sizeBytes > PHOTO_MAX_BYTES) throw photoInvalid()
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new AppError(422, 'idempotency_key_required', 'Нужен Idempotency-Key длиной 1–128 символов')
    const a = await this.owner(request, async (q, vendor) => {
      const old = (await q.query<Asset>('select * from media_uploads where vendor_id=$1 and idempotency_key=$2 for update', [vendor, key])).rows[0]
      if (old) {
        this.sameStorage(old)
        if (old.content_type !== input.contentType || old.size_bytes !== input.sizeBytes) throw conflict('idempotency_conflict', 'Этот ключ уже использован для другой загрузки')
        if (['deleted', 'expired'].includes(old.state) || old.expires_at <= await now(q)) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
        return old
      }
      await assertPhotoQuota(q, vendor, 1)
      const id = randomUUID(), quarantine = `quarantine/${id}/original`, at = await now(q), expires = new Date(at.getTime() + 300_000)
      // External POST producers require the operator's independently qualified
      // absolute request bound <=60s and <=30s clock skew; 120s is the drain margin.
      const drain = new Date(expires.getTime() + config.postMaxSeconds! * 1000 + 120_000)
      await q.query("insert into media_objects(key,storage_id,not_before,write_phase,external_until) values($1,$2,$3,'external',$3)", [quarantine, this.storageId, drain])
      return (await q.query<Asset>(`insert into media_uploads(id,vendor_id,idempotency_key,content_type,size_bytes,
        created_at,expires_at,quarantine_key,file_url,storage_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [id, vendor, key, input.contentType, input.sizeBytes, at, expires, quarantine, `${config.deliveryBaseUrl}/media/photos/${id}`, this.storageId])).rows[0]!
    })
    // Round DOWN and verify the actual signed deadline. A delayed signer must
    // never disclose a capability that outlives its durable reservation.
    const seconds = Math.floor((a.expires_at.getTime() - Date.now()) / 1000) - 1
    if (seconds < 1) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
    const grant = await store.grant(a.quarantine_key, a.content_type, a.size_bytes, Math.min(299, seconds))
    let expiration: number
    try { expiration = Date.parse(JSON.parse(Buffer.from(grant.fields.Policy!, 'base64').toString('utf8')).expiration) }
    catch { throw new AppError(503, 'media_storage_unavailable', 'Не удалось подготовить загрузку') }
    if (!Number.isFinite(expiration) || expiration > a.expires_at.getTime() || expiration <= Date.now()) throw new AppError(503, 'media_storage_unavailable', 'Не удалось подготовить загрузку')
    await this.owner(request, async (q, vendor) => {
      const current = await this.asset(q, vendor, a.id)
      if (['deleted', 'expired'].includes(current.state) || current.expires_at <= await now(q)) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
    })
    return { uploadId: a.id, method: 'POST' as const, uploadUrl: grant.url, fields: grant.fields, expiresAt: new Date(expiration).toISOString() }
  }
  async list(request: FastifyRequest) {
    return this.owner(request, async (q, vendor) => {
      const rows = (await q.query<Asset>("select * from media_uploads where vendor_id=$1 and state<>'deleted' order by created_at,id", [vendor])).rows
      const at = await now(q)
      return { enabled: !!this.config && this.boundedPost(), items: rows.map(a => dto(a, at)) }
    }, { blocked: true })
  }
  async status(request: FastifyRequest, id: string) {
    return this.owner(request, async (q, vendor) => dto(await this.asset(q, vendor, id), await now(q)), { blocked: true })
  }
  async export(request: FastifyRequest) {
    return this.owner(request, async (q, vendor) => {
      const rows = vendor ? (await q.query<Asset>('select * from media_uploads where vendor_id=$1 order by created_at,id', [vendor])).rows : []
      const at = await now(q)
      return rows.map(a => dto(a, at))
    }, { blocked: true, rights: false, missing: true })
  }
  async remove(request: FastifyRequest, id: string) {
    return this.owner(request, async (q, vendor) => {
      const a = await this.asset(q, vendor, id)
      if (a.state !== 'deleted') {
        await q.query("update media_uploads set state='deleted',deleted_at=clock_timestamp(),nonce=null,lease_until=null where id=$1", [id])
        await q.query('delete from vendor_media where vendor_id=$1 and media_upload_id=$2', [vendor, id])
        await refreshPortfolioPhoto(q, vendor)
      }
      return { uploadId: id, state: 'deleted' as const, deletion: 'queued' as const }
    }, { blocked: true })
  }
  async complete(request: FastifyRequest, id: string) {
    const { store, scanner } = this.enabled()
    if (this.processing >= 2) throw new AppError(503, 'media_processing_busy', 'Проверка занята — попробуйте позже')
    this.processing++
    let claim: Asset | null = null
    try {
      const started = await this.owner(request, async (q, vendor) => {
        const a = await this.asset(q, vendor, id), at = await now(q)
        this.sameStorage(a)
        if (a.state === 'ready') return { result: dto(a, at) }
        if (['deleted', 'expired'].includes(a.state) || a.expires_at <= at) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
        if (a.state === 'processing' && a.lease_until! > at) return { result: dto(a, at) }
        if (a.attempts >= 3) throw conflict('media_retry_limit', 'Попытки проверки исчерпаны — удалите загрузку и дождитесь очистки')
        const nonce = randomUUID(), candidate = `clean/${id}/${nonce}.webp`, lease = new Date(at.getTime() + 90_000)
        // Durable registration BEFORE the first possible external candidate write.
        await q.query('insert into media_objects(key,not_before,storage_id) values($1,$2,$3)', [candidate, new Date(Math.max(a.expires_at.getTime(), lease.getTime()) + 120_000), this.storageId])
        const claimed = (await q.query<Asset>(`update media_uploads set state='processing',nonce=$2,lease_until=$3,
          clean_key=$4,attempts=attempts+1,error_code=null where id=$1 returning *`, [id, nonce, lease, candidate])).rows[0]!
        return { claim: claimed }
      })
      if ('result' in started) return started.result!
      claim = started.claim!
      const raw = await store.read(claim.quarantine_key, claim.size_bytes)
      if (raw.length !== claim.size_bytes) throw photoInvalid()
      await scanner.scan(raw)
      const photo = await normalizePortfolioPhoto(raw, claim.content_type)
      await this.owner(request, async (q, vendor) => {
        const a = await this.asset(q, vendor, id), at = await now(q)
        await this.assertClaim(q, a, claim!, at, 'registered')
        const writing = await q.query(`update media_objects set write_phase='inflight',writer_nonce=$2,
          obligation_version=obligation_version+1,updated_at=clock_timestamp()
          where key=$1 and state='pending' and write_phase='registered' returning key`, [claim!.clean_key, claim!.nonce])
        if (!writing.rows[0]) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
      })
      // Dispatch ONLY after the durable inflight transaction acknowledges COMMIT.
      // Exactly one SDK attempt exists for this key. A timeout remains uncertain.
      try { await store.put(claim.clean_key!, photo.bytes) }
      catch (error) { await this.writeOutcome(claim, 'uncertain').catch(() => undefined); throw error }
      await this.writeOutcome(claim, 'settled')
      return await this.owner(request, async (q, vendor) => {
        const a = await this.asset(q, vendor, id), at = await now(q)
        await this.assertClaim(q, a, claim!, at, 'settled')
        const ready = (await q.query<Asset>(`update media_uploads set state='ready',nonce=null,lease_until=null,ready_at=clock_timestamp(),
          output_bytes=$2,width=$3,height=$4,sha256=$5,error_code=null where id=$1 and state='processing'
          and nonce=$6 and clean_key=$7 and lease_until>clock_timestamp() and expires_at>clock_timestamp()
          and exists(select 1 from media_objects o where o.key=$7 and o.state='pending' and o.write_phase='settled' and o.writer_nonce=$6) returning *`,
        [id, photo.bytes.length, photo.width, photo.height, photo.sha256, claim!.nonce, claim!.clean_key])).rows[0]
        if (!ready) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
        await q.query(`insert into vendor_media(id,vendor_id,kind,url,sort,media_upload_id)
          select $1,$2,'photo',$3,coalesce(max(sort)+1,0),$4 from vendor_media where vendor_id=$2`, [randomUUID(), vendor, ready.file_url, id])
        await assertPhotoQuota(q, vendor)
        await refreshPortfolioPhoto(q, vendor)
        return dto(ready, await now(q))
      })
    } catch (error) {
      if (claim) {
        const code = error instanceof AppError ? error.code : 'media_processing_failed'
        // A COMMIT failure may mean ready was committed. Never compensate with
        // remote DELETE; this conditional update cannot undo a ready result.
        await this.db.query(`update media_uploads set state='failed',nonce=null,lease_until=null,error_code=$3
          where id=$1 and state='processing' and nonce=$2`, [id, claim.nonce, code]).catch(() => undefined)
      }
      throw error
    } finally { this.processing-- }
  }
  private async writeOutcome(claim: Asset, phase: 'settled' | 'uncertain') {
    // The writer's exact single-attempt acknowledgement is independent of its
    // now-revoked account/lease. It never restores an asset or publish authority.
    // Incrementing the version also fences DELETE-applied-before-PUT / late ACK.
    const result = await this.db.query(`update media_objects set write_phase=$3,
      obligation_version=obligation_version+1,updated_at=clock_timestamp(),
      not_before=greatest(not_before,clock_timestamp()+interval '2 minutes'),
      state=case when $3='settled' then 'pending' else state end,
      nonce=case when $3='settled' then null else nonce end,
      lease_until=case when $3='settled' then null else lease_until end,
      attempts=case when $3='settled' then 0 else attempts end,
      last_error=case when $3='settled' then null else last_error end
      where key=$1 and writer_nonce=$2 and write_phase='inflight' returning key`, [claim.clean_key, claim.nonce, phase])
    if (!result.rows[0]) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
  }
  private async assertClaim(q: Queryable, a: Asset, claim: Asset, _at: Date, phase: 'registered' | 'settled') {
    const object = (await q.query<ObjectRow>('select * from media_objects where key=$1 for update', [claim.clean_key])).rows[0]
    const at = await now(q)
    if (a.state !== 'processing' || a.nonce !== claim.nonce || !a.lease_until || a.lease_until <= at || a.expires_at <= at || a.clean_key !== claim.clean_key) {
      throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
    }
    if (!object || object.state !== 'pending' || object.write_phase !== phase) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
  }
  private async deliveryAccess(request: FastifyRequest, id: string): Promise<Asset> {
    const located = (await this.db.query<Asset & { user_id: string }>('select a.*,v.user_id from media_uploads a join vendors v on v.id=a.vendor_id where a.id=$1', [id])).rows[0]
    if (!located) throw notFound('Фотография не найдена')
    if (request.caller?.userId === located.user_id) {
      return this.owner(request, async (q, vendor) => {
        const a = await this.asset(q, vendor, id)
        if (a.state !== 'ready') throw notFound('Фотография не найдена')
        return a
      }, { blocked: true })
    }
    return this.db.tx(async q => {
      const live = await q.query('select id from users where id=$1 and deleted_at is null for share', [located.user_id])
      if (!live.rows[0]) throw notFound('Фотография не найдена')
      try { await lockCurrentConsent(q, located.user_id, request.server.appConfig.policyVersion) }
      catch { throw notFound('Фотография не найдена') }
      const vendor = await q.query(`select id from vendors where id=$1 and user_id=$2 and published_at is not null
        and blocked_at is null and media_rights_at is not null for share`, [located.vendor_id, located.user_id])
      if (!vendor.rows[0]) throw notFound('Фотография не найдена')
      const a = (await q.query<Asset>("select * from media_uploads where id=$1 and vendor_id=$2 and state='ready' for share", [id, located.vendor_id])).rows[0]
      if (!a) throw notFound('Фотография не найдена')
      return a
    })
  }
  async deliver(request: FastifyRequest, id: string) {
    const { store } = this.enabled()
    // Bound buffered public downloads as well as the two scanning pipelines.
    // Five ordinary portfolio previews fit without rejecting the normal screen.
    if (this.delivering >= 8) throw storageUnavailable()
    this.delivering++
    let owned = true
    const release = () => { if (owned) { owned = false; this.delivering-- } }
    try {
      const before = await this.deliveryAccess(request, id)
      this.sameStorage(before)
      const bytes = await store.read(before.clean_key!, PHOTO_MAX_BYTES)
      const current = await this.deliveryAccess(request, id)
      if (current.clean_key !== before.clean_key || bytes.length !== current.output_bytes) throw notFound('Фотография не найдена')
      if (createHash('sha256').update(bytes).digest('hex') !== current.sha256) throw storageUnavailable()
      // The HTTP owner must hold capacity until finish/close, including a
      // slow socket's queued Buffer. Read completion alone does not retire it.
      return { bytes, release }
    } catch (error) { release(); throw error }
  }
  async collect(limit = 20) {
    const { store } = this.enabled()
    const due = (await this.db.query<{ key: string }>(`select key from media_objects where storage_id=$1 and
      (state='pending' or (state='deleting' and lease_until<=clock_timestamp())) and not_before<=clock_timestamp()
      order by not_before,key limit $2`, [this.storageId, Math.max(1, Math.min(50, limit))])).rows
    let removed = 0, failed = 0
    for (const { key } of due) {
      const claim = await this.db.tx(async q => {
        // All writers/finalize use asset -> object. GC acquires no company or
        // principal AFTER this point, including for orphaned cascade objects.
        const id = key.split('/')[1]!
        const a = (await q.query<Asset>('select * from media_uploads where id=$1 for update', [id])).rows[0]
        const o = (await q.query<ObjectRow>('select * from media_objects where key=$1 for update', [key])).rows[0]
        const at = await now(q)
        if (!o || o.storage_id !== this.storageId || !['pending', 'deleting'].includes(o.state) || o.not_before > at
          || (o.external_until && o.external_until > at) || (o.state === 'deleting' && o.lease_until! > at)) return null
        if (a && ((a.state === 'ready' && a.clean_key === key)
          || (key === a.quarantine_key && a.expires_at.getTime() + 120_000 > at.getTime())
          || (a.state === 'processing' && a.clean_key === key && a.lease_until! > at))) {
          await q.query("update media_objects set not_before=clock_timestamp()+interval '5 minutes' where key=$1", [key])
          return null
        }
        if (a && a.state === 'processing' && a.clean_key === key) await q.query("update media_uploads set state='failed',nonce=null,lease_until=null,error_code='media_processing_expired' where id=$1", [id])
        if (a && a.state === 'pending' && a.expires_at <= at) await q.query("update media_uploads set state='expired' where id=$1", [id])
        if (o.attempts >= 8) { await q.query("update media_objects set state='failed',nonce=null,lease_until=null,last_error='media_storage_unavailable' where key=$1", [key]); return null }
        const nonce = randomUUID()
        await q.query("update media_objects set state='deleting',nonce=$2,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp() where key=$1", [key, nonce])
        return { nonce, version: o.obligation_version,
          // A lease timeout is NOT proof that a dispatched remote write ended.
          canFinish: ['registered', 'settled'].includes(o.write_phase) || (o.write_phase === 'external' && this.boundedPost()) }
      })
      if (!claim) continue
      try {
        await store.remove(key)
        const r = claim.canFinish ? await this.db.query(`update media_objects set state='done',nonce=null,lease_until=null,last_error=null,
          updated_at=clock_timestamp() where key=$1 and state='deleting' and nonce=$2 and obligation_version=$3`, [key, claim.nonce, claim.version]) : null
        if (r?.rowCount) removed += r.rowCount
        else {
          failed++
          await this.releaseCollection(key, claim.nonce)
        }
      } catch {
        failed++
        await this.releaseCollection(key, claim.nonce)
      }
    }
    return { removed, failed }
  }
  private async releaseCollection(key: string, nonce: string) {
    await this.db.query(`update media_objects set state=case when attempts>=8 then 'failed' else 'pending' end,
      nonce=null,lease_until=null,last_error=case when write_phase in ('inflight','uncertain') then 'media_write_uncertain' else 'media_storage_unavailable' end,
      updated_at=clock_timestamp(),not_before=greatest(not_before,clock_timestamp()+least(3600,power(2,attempts)::int*10)*interval '1 second')
      where key=$1 and state='deleting' and nonce=$2`, [key, nonce])
  }
}
