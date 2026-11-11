import { createHash } from 'node:crypto'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { createPresignedPost } from '@aws-sdk/s3-presigned-post'
import { AppError } from '../errors.js'
import type { MediaStorageConfig } from './config.js'

export const PHOTO_MAX_BYTES = 10 * 1024 * 1024
export const PDF_MAX_BYTES = 10 * 1024 * 1024
export interface UploadGrant { url: string; fields: Record<string, string> }
export interface MediaStore {
  grant(key: string, contentType: string, bytes: number, expiresSeconds: number): Promise<UploadGrant>
  read(key: string, maximum: number, invalid?: () => AppError): Promise<Buffer>
  put(key: string, bytes: Buffer): Promise<void>
  remove(key: string): Promise<void>
  close(): void
}
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY = new RegExp(`^(quarantine/${UUID}/original|clean/${UUID}/${UUID}\\.(webp|pdf))(?![\\s\\S])`)
export function checkStorageKey(key: string): void {
  if (!KEY.test(key)) throw new AppError(500, 'media_storage_key_invalid', 'Не удалось обработать файл')
}
export const storageUnavailable = () => new AppError(503, 'media_storage_unavailable', 'Хранилище временно недоступно — попробуйте позже')
export const photoInvalid = () => new AppError(422, 'media_invalid_photo', 'Нужна корректная фотография JPEG, PNG или WebP в пределах лимитов')
export const pdfInvalid = () => new AppError(422, 'media_invalid_pdf', 'Нужен PDF размером до 10 МиБ')

const CONTROL_MAX_BYTES = 64 * 1024
/** The SDK collects error/control bodies before read() sees a successful Body. */
async function collectControlBody(stream: unknown): Promise<Uint8Array> {
  if (stream instanceof Uint8Array) {
    if (stream.byteLength > CONTROL_MAX_BYTES) throw storageUnavailable()
    return stream
  }
  const body = stream as (AsyncIterable<Uint8Array> & { destroy?: () => void; headers?: Record<string, string | string[] | undefined> }) | undefined
  if (!body || typeof body[Symbol.asyncIterator] !== 'function') throw storageUnavailable()
  const length = body.headers?.['content-length']
  if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > CONTROL_MAX_BYTES) {
    body.destroy?.(); throw storageUnavailable()
  }
  const chunks: Buffer[] = []; let bytes = 0
  try {
    for await (const chunk of body) {
      if (!(chunk instanceof Uint8Array) || (bytes += chunk.byteLength) > CONTROL_MAX_BYTES) throw storageUnavailable()
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks, bytes)
  } catch { body.destroy?.(); throw storageUnavailable() }
}

/** The only endpoints/credentials are the operator's explicit configuration. */
export class S3MediaStore implements MediaStore {
  private readonly client: S3Client
  constructor(private readonly config: MediaStorageConfig, private readonly timeoutMs = 15_000) {
    this.client = new S3Client({ endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      // A candidate key has exactly one remote writer. A transparent retry
      // would introduce a second uncertain producer after the first timeout.
      maxAttempts: 1, followRegionRedirects: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      streamCollector: collectControlBody,
      requestHandler: { connectionTimeout: Math.min(3_000, timeoutMs), requestTimeout: timeoutMs } })
  }
  async grant(key: string, contentType: string, bytes: number, expiresSeconds: number): Promise<UploadGrant> {
    checkStorageKey(key)
    const pdf = contentType === 'application/pdf'
    if (!key.startsWith('quarantine/') || (!pdf && !['image/jpeg', 'image/png', 'image/webp'].includes(contentType))
      || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > (pdf ? PDF_MAX_BYTES : PHOTO_MAX_BYTES)
      || !Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 300) throw pdf ? pdfInvalid() : photoInvalid()
    try {
      return await createPresignedPost(this.client, { Bucket: this.config.bucket, Key: key,
        Fields: { 'Content-Type': contentType }, Expires: expiresSeconds,
        Conditions: [['eq', '$Content-Type', contentType], ['content-length-range', bytes, bytes]] })
    } catch { throw storageUnavailable() }
  }
  async read(key: string, maximum: number, invalid = photoInvalid): Promise<Buffer> {
    checkStorageKey(key)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > Math.max(PDF_MAX_BYTES, PHOTO_MAX_BYTES)) throw invalid()
    const controller = new AbortController()
    let stream: (AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }) | undefined
    const timer = setTimeout(() => { controller.abort(); stream?.destroy?.(storageUnavailable()) }, this.timeoutMs)
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: controller.signal })
      stream = result.Body as typeof stream
      if (!stream || (result.ContentLength !== undefined && result.ContentLength > maximum)) { stream?.destroy?.(); throw invalid() }
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of stream) {
        size += chunk.byteLength
        if (size > maximum) { stream.destroy?.(); throw invalid() }
        chunks.push(Buffer.from(chunk))
      }
      if (!size) throw invalid()
      return Buffer.concat(chunks, size)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw storageUnavailable()
    } finally { clearTimeout(timer) }
  }
  async put(key: string, bytes: Buffer): Promise<void> {
    checkStorageKey(key)
    const pdf = key.endsWith('.pdf')
    if (!key.startsWith('clean/') || !bytes.length || bytes.length > (pdf ? PDF_MAX_BYTES : PHOTO_MAX_BYTES)) throw pdf ? pdfInvalid() : photoInvalid()
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: key, Body: bytes,
        ContentType: pdf ? 'application/pdf' : 'image/webp', ContentLength: bytes.length, CacheControl: 'private, no-store',
        ContentMD5: createHash('md5').update(bytes).digest('base64'), IfNoneMatch: '*' }), { abortSignal: AbortSignal.timeout(this.timeoutMs) })
    } catch { throw storageUnavailable() }
  }
  async remove(key: string): Promise<void> {
    checkStorageKey(key)
    try { await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }), { abortSignal: AbortSignal.timeout(this.timeoutMs) }) }
    catch { throw storageUnavailable() }
  }
  close(): void { this.client.destroy() }
}
