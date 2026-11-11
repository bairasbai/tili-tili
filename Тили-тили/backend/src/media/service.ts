import { createHash, randomUUID } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import type { Db, Queryable } from '../plugins/db.js'
import { AppError, conflict, forbidden, notFound, quotaExceeded, unauthorized } from '../errors.js'
import { guestByToken, type GuestCaller } from '../guests/access.js'
import { lockOrderWedding } from '../orders/context.js'
import { lockVendorProfileWrite } from '../vendor/profile-locks.js'
import { assertSeatingToken, lockGuestReadAccess } from '../wedding/access.js'
import { lockCurrentConsent } from '../auth/consent.js'
import { mediaStorageIdentity, type MediaStorageConfig } from './config.js'
import { S3MediaStore, PDF_MAX_BYTES, PHOTO_MAX_BYTES, pdfInvalid, photoInvalid, storageUnavailable, type MediaStore } from './storage.js'
import { ClamMediaScanner, type MediaScanner } from './scanner.js'
import { normalizePortfolioPhoto } from './photo.js'
import { prepareContractPdf } from './contractPdf.js'
import { assertPhotoQuota, photoOccupiesQuota, refreshPortfolioPhoto } from './portfolio.js'

interface Asset {
  id: string; vendor_id: string | null; storage_id: string; content_type: string; size_bytes: number
  state: 'pending' | 'processing' | 'ready' | 'failed' | 'deleted' | 'expired'
  created_at: Date; expires_at: Date; quarantine_key: string; clean_key: string | null; file_url: string
  nonce: string | null; lease_until: Date | null; attempts: number; ready_at: Date | null
  deleted_at: Date | null; output_bytes: number | null; width: number | null; height: number | null; error_code: string | null; sha256: string | null
}
interface AlbumPhotoRow { id: string; url: string; approved: boolean; created_at: Date; media_upload_id: string | null }
export const albumPhotoDto = (photo: AlbumPhotoRow) => ({ id: photo.id, url: photo.url, approved: photo.approved,
  createdAt: photo.created_at.toISOString(), managed: photo.media_upload_id !== null })
interface ObjectRow { key: string; storage_id: string; state: string; not_before: Date; external_until: Date | null; nonce: string | null; lease_until: Date | null; attempts: number
  write_phase: 'registered' | 'inflight' | 'settled' | 'uncertain' | 'external'; writer_nonce: string | null; obligation_version: string }
export interface UploadInput { kind: string; contentType: string; sizeBytes: number }
export interface AlbumUploadInput { contentType: string; sizeBytes: number; consent: boolean }
type PhotoInput = Pick<UploadInput, 'contentType' | 'sizeBytes'>
type AssetTransaction = <T>(action: (q: Queryable, asset: Asset) => Promise<T>) => Promise<T>
type LinkAsset = (q: Queryable, asset: Asset) => Promise<void>
type ContractSide = 'couple' | 'vendor'
export interface ContractMediaScope {
  dealId: string; documentId: string; actorId: string
  lockAccess(q: Queryable, write: boolean): Promise<ContractSide>
  assertCurrent(): Promise<void>
}
const disabled = () => new AppError(501, 'storage_not_configured', 'Загрузка файлов пока не подключена')
const now = async (q: Queryable) => (await q.query<{ at: Date }>('select clock_timestamp() at')).rows[0]!.at
const dto = (a: Asset, at: Date) => ({ uploadId: a.id, state: a.state, contentType: a.content_type,
  sizeBytes: a.size_bytes, createdAt: a.created_at.toISOString(), expiresAt: a.expires_at.toISOString(),
  readyAt: a.ready_at?.toISOString() ?? null, deletedAt: a.deleted_at?.toISOString() ?? null,
  fileUrl: a.state === 'ready' ? a.file_url : null, outputBytes: a.output_bytes, width: a.width, height: a.height,
  errorCode: a.error_code, retryable: ['pending', 'failed', 'processing'].includes(a.state) && a.expires_at > at && a.attempts < 3 })

function validateUploadKey(key: string): void {
  if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new AppError(422, 'idempotency_key_required', 'Нужен Idempotency-Key длиной 1–128 символов')
}

function validatePhotoInput(input: PhotoInput, key: string): void {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(input.contentType) || !Number.isSafeInteger(input.sizeBytes)
    || input.sizeBytes < 1 || input.sizeBytes > PHOTO_MAX_BYTES) throw photoInvalid()
  validateUploadKey(key)
}

async function lockAlbumGuest(q: Queryable, token: string, write: boolean): Promise<GuestCaller> {
  const before = await guestByToken(q, token)
  // Same wedding → invitation → person order as guest participation writes.
  try { await lockOrderWedding(q, before.weddingId, false) }
  catch (error) {
    if (error instanceof AppError && error.statusCode === 404) throw unauthorized('Ссылка недействительна')
    throw error
  }
  const party = await q.query('select id from guest_parties where id=$1 and wedding_id=$2 and invite_token=$3 for share',
    [before.partyId, before.weddingId, token])
  if (!party.rows[0]) throw unauthorized('Ссылка недействительна')
  const person = await q.query(`select id from guests where id=$1 and wedding_id=$2 and party_id=$3 for ${write ? 'update' : 'share'}`,
    [before.guestId, before.weddingId, before.partyId])
  if (!person.rows[0]) throw unauthorized('Ссылка недействительна')
  const current = await guestByToken(q, token)
  if (current.guestId !== before.guestId || current.partyId !== before.partyId || current.weddingId !== before.weddingId) {
    throw unauthorized('Ссылка недействительна')
  }
  return current
}

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
  private canIssue(environment: string): boolean {
    if (!this.config) return false
    return this.config.localUnboundedPost === true
      ? environment !== 'production' && this.config.postMaxSeconds === undefined
      : this.boundedPost()
  }
  canUploadContract(environment: string): boolean { return this.canIssue(environment) }
  private enabled(): { store: MediaStore; scanner: MediaScanner; config: MediaStorageConfig } {
    if (!this.store || !this.scanner || !this.config) throw disabled()
    return { store: this.store, scanner: this.scanner, config: this.config }
  }
  private sameStorage(a: Asset): void {
    if (!this.storageId || a.storage_id !== this.storageId) throw storageUnavailable()
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
  private albumOwner<T>(token: string, action: (q: Queryable, guest: GuestCaller) => Promise<T>, write = true): Promise<T> {
    return this.db.tx(async q => action(q, await lockAlbumGuest(q, token, write)))
  }
  private async albumAsset(q: Queryable, guest: GuestCaller, id: string): Promise<Asset> {
    const a = (await q.query<Asset>(`select * from media_uploads where id=$1 and album_wedding_id=$2
      and album_party_id=$3 and album_guest_id=$4 for update`, [id, guest.weddingId, guest.partyId, guest.guestId])).rows[0]
    if (!a) throw notFound('Загрузка не найдена')
    return a
  }
  private contractOwner<T>(scope: ContractMediaScope, write: boolean, action: (q: Queryable, side: ContractSide) => Promise<T>) {
    return this.db.tx(async q => {
      const side = await scope.lockAccess(q, write)
      const document = await q.query(`select id from documents where id=$1 and deal_id=$2 for ${write ? 'update' : 'share'}`,
        [scope.documentId, scope.dealId])
      if (!document.rows[0]) throw notFound('Версия договора не найдена')
      const result = await action(q, side)
      await scope.assertCurrent()
      return result
    })
  }
  private contractAuthor(scope: ContractMediaScope, id: string, write: boolean): AssetTransaction {
    return action => this.contractOwner(scope, write, async (q, side) => {
      const asset = (await q.query<Asset>(`select * from media_uploads where document_id=$1 and id=$2
        and document_author_id=$3 and document_author_side=$4 for ${write ? 'update' : 'share'}`,
      [scope.documentId, id, scope.actorId, side])).rows[0]
      if (!asset) throw notFound('Загрузка не найдена')
      return action(q, asset)
    })
  }
  private async reusableGrant(q: Queryable, asset: Asset, input: PhotoInput) {
    this.sameStorage(asset)
    if (asset.content_type !== input.contentType || asset.size_bytes !== input.sizeBytes) throw conflict('idempotency_conflict', 'Этот ключ уже использован для другой загрузки')
    if (['deleted', 'expired'].includes(asset.state) || asset.expires_at <= await now(q)) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
    return asset
  }
  private async reserveOriginal(q: Queryable, config: MediaStorageConfig) {
    const id = randomUUID(), quarantine = `quarantine/${id}/original`, at = await now(q), expires = new Date(at.getTime() + 300_000)
    // External POST producers require the operator's independently qualified
    // absolute request bound <=60s and <=30s clock skew; 120s is the drain margin.
    // Unqualified local POST producers are retired only by the offline fence.
    const drain = config.localUnboundedPost ? 'infinity' : new Date(expires.getTime() + config.postMaxSeconds! * 1000 + 120_000)
    await q.query("insert into media_objects(key,storage_id,not_before,write_phase,external_until) values($1,$2,$3,'external',$3)", [quarantine, this.storageId, drain])
    return { id, quarantine, at, expires }
  }
  async issue(request: FastifyRequest, input: UploadInput, key: string) {
    const { store, config } = this.enabled()
    if (!this.canIssue(request.server.appConfig.env)) throw disabled()
    if (input.kind !== 'vendor_photo') throw new AppError(501, 'media_kind_not_enabled', 'Этот вид файлов пока не подключён')
    validatePhotoInput(input, key)
    const a = await this.owner(request, async (q, vendor) => {
      const old = (await q.query<Asset>('select * from media_uploads where vendor_id=$1 and idempotency_key=$2 for update', [vendor, key])).rows[0]
      if (old) return this.reusableGrant(q, old, input)
      await assertPhotoQuota(q, vendor, 1)
      const { id, quarantine, at, expires } = await this.reserveOriginal(q, config)
      return (await q.query<Asset>(`insert into media_uploads(id,vendor_id,idempotency_key,content_type,size_bytes,
        created_at,expires_at,quarantine_key,file_url,storage_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
      [id, vendor, key, input.contentType, input.sizeBytes, at, expires, quarantine, `${config.deliveryBaseUrl}/media/photos/${id}`, this.storageId])).rows[0]!
    })
    return this.signedGrant(store, a, action => this.owner(request, async (q, vendor) => action(q, await this.asset(q, vendor, a.id))))
  }
  async issueAlbum(token: string, input: AlbumUploadInput, key: string, limit: number, environment: string) {
    if (input.consent !== true) throw new AppError(422, 'consent_required', 'Нужно согласие на публикацию кадра в альбоме')
    validatePhotoInput(input, key)
    const { store, config } = this.enabled()
    if (!this.canIssue(environment)) throw disabled()
    const a = await this.albumOwner(token, async (q, guest) => {
      const scope = [guest.weddingId, guest.partyId, guest.guestId]
      const old = (await q.query<Asset>(`select * from media_uploads where album_wedding_id=$1 and album_party_id=$2
        and album_guest_id=$3 and idempotency_key=$4 for update`, [...scope, key])).rows[0]
      if (old) return this.reusableGrant(q, old, input)
      const used = (await q.query<{ n: string }>(`select (
        (select count(*) from album_photos where wedding_id=$1 and uploaded_by=$2 and media_upload_id is null) +
        (select count(*) from media_uploads a where album_wedding_id=$1 and album_guest_id=$2 and ${photoOccupiesQuota})
        )::text as n`, [guest.weddingId, guest.guestId])).rows[0]!
      if (Number(used.n) >= limit) throw quotaExceeded('album_limit', `Больше ${limit} кадров от одного гостя не принимаем`)
      const { id, quarantine, at, expires } = await this.reserveOriginal(q, config)
      const fileUrl = `${config.deliveryBaseUrl}/weddings/${guest.weddingId}/album/${id}/content`
      return (await q.query<Asset>(`insert into media_uploads(id,album_wedding_id,album_party_id,album_guest_id,
        album_consent_at,idempotency_key,content_type,size_bytes,created_at,expires_at,quarantine_key,file_url,storage_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$5,$9,$10,$11,$12) returning *`,
      [id, ...scope, at, key, input.contentType, input.sizeBytes, expires, quarantine, fileUrl, this.storageId])).rows[0]!
    })
    return this.signedGrant(store, a, action => this.albumOwner(token, async (q, guest) => action(q, await this.albumAsset(q, guest, a.id))))
  }
  async issueContract(scope: ContractMediaScope, sizeBytes: number, key: string, environment: string) {
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > PDF_MAX_BYTES) throw pdfInvalid()
    validateUploadKey(key)
    const input = { contentType: 'application/pdf', sizeBytes }
    const { store, config } = this.enabled()
    if (!this.canIssue(environment)) throw disabled()
    const a = await this.contractOwner(scope, true, async (q, side) => {
      const old = (await q.query<Asset & { document_author_side: ContractSide }>(`select * from media_uploads
        where document_id=$1 and document_author_id=$2 and idempotency_key=$3 for update`,
      [scope.documentId, scope.actorId, key])).rows[0]
      if (old) {
        if (old.document_author_side !== side) throw notFound('Загрузка не найдена')
        if (old.state === 'ready') throw conflict('media_contract_attached', 'К этой версии уже прикреплён файл')
        return this.reusableGrant(q, old, input)
      }
      const active = await q.query(`select id from media_uploads where document_id=$1 and (state='ready'
        or (state in ('pending','processing','failed') and expires_at>clock_timestamp()))`, [scope.documentId])
      if (active.rows[0]) throw conflict('media_contract_slot_busy', 'Для этой версии уже есть файл или активная загрузка')
      // The deal lock serializes the quota across all versions of this deal.
      const used = (await q.query<{ n: number }>(`select count(*)::int as n from media_uploads a join documents d on d.id=a.document_id
        where d.deal_id=$1 and ${photoOccupiesQuota}`, [scope.dealId])).rows[0]!.n
      if (used >= 20) throw quotaExceeded('media_contract_limit', 'Достигнут лимит файлов договора с учётом ожидающих очистки')
      const { id, quarantine, at, expires } = await this.reserveOriginal(q, config)
      const fileUrl = `${config.deliveryBaseUrl}/deals/${scope.dealId}/documents/${scope.documentId}/attachments/${id}/content`
      return (await q.query<Asset>(`insert into media_uploads(id,document_id,document_author_id,document_author_side,
        idempotency_key,content_type,size_bytes,created_at,expires_at,quarantine_key,file_url,storage_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
      [id, scope.documentId, scope.actorId, side, key, input.contentType, sizeBytes, at, expires, quarantine, fileUrl, this.storageId])).rows[0]!
    })
    return this.signedGrant(store, a, this.contractAuthor(scope, a.id, false))
  }
  private async signedGrant(store: MediaStore, a: Asset, transaction: AssetTransaction) {
    // Round DOWN and verify the actual signed deadline. A delayed signer must
    // never disclose a capability that outlives its durable reservation.
    const seconds = Math.floor((a.expires_at.getTime() - Date.now()) / 1000) - 1
    if (seconds < 1) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
    const grant = await store.grant(a.quarantine_key, a.content_type, a.size_bytes, Math.min(299, seconds))
    let expiration: number
    try { expiration = Date.parse(JSON.parse(Buffer.from(grant.fields.Policy!, 'base64').toString('utf8')).expiration) }
    catch { throw new AppError(503, 'media_storage_unavailable', 'Не удалось подготовить загрузку') }
    if (!Number.isFinite(expiration) || expiration > a.expires_at.getTime() || expiration <= Date.now()) throw new AppError(503, 'media_storage_unavailable', 'Не удалось подготовить загрузку')
    await transaction(async (q, current) => {
      if (['deleted', 'expired'].includes(current.state) || current.expires_at <= await now(q)) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
    })
    return { uploadId: a.id, method: 'POST' as const, uploadUrl: grant.url, fields: grant.fields, expiresAt: new Date(expiration).toISOString() }
  }
  async list(request: FastifyRequest) {
    return this.owner(request, async (q, vendor) => {
      const rows = (await q.query<Asset>("select * from media_uploads where vendor_id=$1 and state<>'deleted' order by created_at,id", [vendor])).rows
      const at = await now(q)
      return { enabled: this.canIssue(request.server.appConfig.env), items: rows.map(a => dto(a, at)) }
    }, { blocked: true })
  }
  async status(request: FastifyRequest, id: string) {
    return this.owner(request, async (q, vendor) => dto(await this.asset(q, vendor, id), await now(q)), { blocked: true })
  }
  albumStatus(token: string, id: string) {
    return this.albumOwner(token, async (q, guest) => dto(await this.albumAsset(q, guest, id), await now(q)), false)
  }
  contractStatus(scope: ContractMediaScope, id: string) {
    return this.contractAuthor(scope, id, false)(async (q, a) => dto(a, await now(q)))
  }
  removeContract(scope: ContractMediaScope, id: string) {
    return this.contractAuthor(scope, id, true)(async (q, a) => {
      if (a.state !== 'deleted') {
        await q.query("update media_uploads set state='deleted',deleted_at=clock_timestamp(),nonce=null,lease_until=null where id=$1", [id])
      }
      return { uploadId: id, state: 'deleted' as const, deletion: 'queued' as const }
    })
  }
  async guestAlbum(token: string, environment: string) {
    return { photos: await this.listGuestAlbum(token), uploadEnabled: this.canIssue(environment) }
  }
  listGuestAlbum(token: string, expectedWeddingId?: string) {
    return this.albumOwner(token, async (q, guest) => {
      if (expectedWeddingId !== undefined && guest.weddingId !== expectedWeddingId) throw notFound('Свадьба не найдена')
      const { rows } = await q.query<AlbumPhotoRow>(`select id,url,approved,created_at,media_upload_id from album_photos
        where wedding_id=$1 and approved order by created_at desc,id desc`, [guest.weddingId])
      return rows.map(albumPhotoDto)
    }, false)
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
  complete(request: FastifyRequest, id: string) {
    const transaction: AssetTransaction = action => this.owner(request, async (q, vendor) => action(q, await this.asset(q, vendor, id)))
    return this.completeAsset(id, transaction, async (q, ready) => {
      const vendor = ready.vendor_id!
      await q.query(`insert into vendor_media(id,vendor_id,kind,url,sort,media_upload_id)
        select $1,$2,'photo',$3,coalesce(max(sort)+1,0),$4 from vendor_media where vendor_id=$2`, [randomUUID(), vendor, ready.file_url, id])
      await assertPhotoQuota(q, vendor)
      await refreshPortfolioPhoto(q, vendor)
    })
  }
  completeAlbum(token: string, id: string) {
    const transaction: AssetTransaction = action => this.albumOwner(token, async (q, guest) => action(q, await this.albumAsset(q, guest, id)))
    return this.completeAsset(id, transaction, async (q, ready) => {
      await q.query(`insert into album_photos(id,wedding_id,url,approved,uploaded_by,media_upload_id)
        select id,album_wedding_id,file_url,false,album_guest_id,id from media_uploads where id=$1`, [ready.id])
    })
  }
  completeContract(scope: ContractMediaScope, id: string) {
    return this.completeAsset(id, this.contractAuthor(scope, id, true))
  }
  private async completeAsset(id: string, transaction: AssetTransaction, link?: LinkAsset) {
    const { store, scanner } = this.enabled()
    if (this.processing >= 2) throw new AppError(503, 'media_processing_busy', 'Проверка занята — попробуйте позже')
    this.processing++
    let claim: Asset | null = null
    try {
      const started = await transaction(async (q, a) => {
        const at = await now(q)
        this.sameStorage(a)
        if (a.state === 'ready') return { result: dto(a, at) }
        if (['deleted', 'expired'].includes(a.state) || a.expires_at <= at) throw conflict('media_upload_expired', 'Срок загрузки истёк — начните новую')
        if (a.state === 'processing' && a.lease_until! > at) return { result: dto(a, at) }
        if (a.attempts >= 3) throw conflict('media_retry_limit', 'Попытки проверки исчерпаны — удалите загрузку и дождитесь очистки')
        const extension = a.content_type === 'application/pdf' ? 'pdf' : 'webp'
        const nonce = randomUUID(), candidate = `clean/${id}/${nonce}.${extension}`, lease = new Date(at.getTime() + 90_000)
        // Durable registration BEFORE the first possible external candidate write.
        await q.query('insert into media_objects(key,not_before,storage_id) values($1,$2,$3)', [candidate, new Date(Math.max(a.expires_at.getTime(), lease.getTime()) + 120_000), this.storageId])
        const claimed = (await q.query<Asset>(`update media_uploads set state='processing',nonce=$2,lease_until=$3,
          clean_key=$4,attempts=attempts+1,error_code=null where id=$1 returning *`, [id, nonce, lease, candidate])).rows[0]!
        return { claim: claimed }
      })
      if ('result' in started) return started.result!
      claim = started.claim!
      const pdf = claim.content_type === 'application/pdf'
      const invalid = pdf ? pdfInvalid : photoInvalid
      const raw = await store.read(claim.quarantine_key, claim.size_bytes, invalid)
      if (raw.length !== claim.size_bytes) throw invalid()
      await scanner.scan(raw)
      const prepared = pdf ? prepareContractPdf(raw) : await normalizePortfolioPhoto(raw, claim.content_type)
      await transaction(async (q, a) => {
        await this.assertClaim(q, a, claim!, 'registered')
        const writing = await q.query(`update media_objects set write_phase='inflight',writer_nonce=$2,
          obligation_version=obligation_version+1,updated_at=clock_timestamp()
          where key=$1 and state='pending' and write_phase='registered' returning key`, [claim!.clean_key, claim!.nonce])
        if (!writing.rows[0]) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
      })
      // Dispatch ONLY after the durable inflight transaction acknowledges COMMIT.
      // Exactly one SDK attempt exists for this key. A timeout remains uncertain.
      try { await store.put(claim.clean_key!, prepared.bytes) }
      catch (error) { await this.writeOutcome(claim, 'uncertain').catch(() => undefined); throw error }
      await this.writeOutcome(claim, 'settled')
      return await transaction(async (q, a) => {
        await this.assertClaim(q, a, claim!, 'settled')
        const ready = (await q.query<Asset>(`update media_uploads set state='ready',nonce=null,lease_until=null,ready_at=clock_timestamp(),
          output_bytes=$2,width=$3,height=$4,sha256=$5,error_code=null where id=$1 and state='processing'
          and nonce=$6 and clean_key=$7 and lease_until>clock_timestamp() and expires_at>clock_timestamp()
          and exists(select 1 from media_objects o where o.key=$7 and o.state='pending' and o.write_phase='settled' and o.writer_nonce=$6) returning *`,
        [id, prepared.bytes.length, prepared.width, prepared.height, prepared.sha256, claim!.nonce, claim!.clean_key])).rows[0]
        if (!ready) throw conflict('media_processing_expired', 'Эта попытка проверки больше не действует')
        await link?.(q, ready)
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
  private async assertClaim(q: Queryable, a: Asset, claim: Asset, phase: 'registered' | 'settled') {
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
  private async albumDeliveryAccess(q: Queryable, weddingId: string, photoId: string, canSeePending: boolean): Promise<Asset> {
    const a = (await q.query<Asset>(`select a.* from album_photos p join media_uploads a on a.id=p.media_upload_id
      and a.album_wedding_id=p.wedding_id where p.id=$1 and p.wedding_id=$2 and (p.approved or $3) and a.state='ready'
      for share of p,a`, [photoId, weddingId, canSeePending])).rows[0]
    if (!a) throw notFound('Фотография не найдена')
    return a
  }
  deliverGuestAlbum(token: string, photoId: string) {
    return this.deliverPhoto(() => this.albumOwner(token, (q, guest) => this.albumDeliveryAccess(q, guest.weddingId, photoId, false), false))
  }
  deliverTeamAlbum(request: FastifyRequest, photoId: string) {
    return this.deliverPhoto(() => this.db.tx(async q => {
      const role = await lockGuestReadAccess(q, request)
      const asset = await this.albumDeliveryAccess(q, request.member!.weddingId, photoId, role === 'couple')
      await assertSeatingToken(request)
      return asset
    }))
  }
  deliver(request: FastifyRequest, id: string) {
    return this.deliverPhoto(() => this.deliveryAccess(request, id))
  }
  deliverContract(scope: ContractMediaScope, id: string) {
    const missing = () => notFound('Вложение договора не найдено')
    return this.deliverAsset(() => this.contractOwner(scope, false, async q => {
      const asset = (await q.query<Asset>(`select * from media_uploads where document_id=$1 and id=$2 and state='ready' for share`,
        [scope.documentId, id])).rows[0]
      if (!asset) throw missing()
      return asset
    }), PDF_MAX_BYTES, missing, pdfInvalid)
  }
  private deliverPhoto(access: () => Promise<Asset>) {
    return this.deliverAsset(access, PHOTO_MAX_BYTES, () => notFound('Фотография не найдена'), photoInvalid)
  }
  private async deliverAsset(access: () => Promise<Asset>, maxBytes: number, missing: () => AppError, invalid: () => AppError) {
    const { store } = this.enabled()
    // Bound buffered public downloads as well as the two scanning pipelines.
    // Five ordinary portfolio previews fit without rejecting the normal screen.
    if (this.delivering >= 8) throw storageUnavailable()
    this.delivering++
    let owned = true
    const release = () => { if (owned) { owned = false; this.delivering-- } }
    try {
      const before = await access()
      this.sameStorage(before)
      const bytes = await store.read(before.clean_key!, maxBytes, invalid)
      const current = await access()
      if (current.clean_key !== before.clean_key || bytes.length !== current.output_bytes) throw missing()
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
