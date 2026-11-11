import { createHash } from 'node:crypto'

export interface MediaStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  deliveryBaseUrl: string
  scannerHost: string
  scannerPort: number
  /** Operator-qualified absolute POST duration; not established by the env value itself. */
  postMaxSeconds?: number
  /** Development only: external debt stays at SQL infinity until an offline producer fence. */
  localUnboundedPost?: true
}

/** Credential rotation preserves identity; switching a bucket/endpoint does not. */
export function mediaStorageIdentity(config: MediaStorageConfig): string {
  return createHash('sha256').update(JSON.stringify([config.endpoint, config.region, config.bucket])).digest('hex')
}

/** No ambient AWS credential chain and no partially enabled upload capability. */
export function parseMediaStorage(source: NodeJS.ProcessEnv, production: boolean): MediaStorageConfig | null {
  const localFlag = source.MEDIA_LOCAL_UNBOUNDED_POST
  if (localFlag !== undefined && localFlag !== '' && localFlag !== '1') throw new Error('MEDIA_LOCAL_UNBOUNDED_POST: допустимы только пустое значение или 1')
  const localUnboundedPost = localFlag === '1'
  if (localUnboundedPost && (production || source.MEDIA_S3_POST_MAX_SECONDS)) throw new Error('MEDIA_LOCAL_UNBOUNDED_POST: только вне production и без утверждения POST_MAX_SECONDS')
  const keys = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_REGION', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY',
    'MEDIA_S3_SECRET_KEY', 'MEDIA_DELIVERY_BASE_URL', 'MEDIA_SCAN_HOST', 'MEDIA_SCAN_PORT', 'MEDIA_S3_POST_MAX_SECONDS'] as const
  if (!localUnboundedPost && keys.every(key => !source[key]?.trim())) return null
  const field = (key: typeof keys[number]): string => {
    const value = source[key]
    if (!value || value.length > 1024 || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw new Error(`${key}: требуется непустое корректное значение`)
    return value
  }
  const url = (key: 'MEDIA_S3_ENDPOINT' | 'MEDIA_DELIVERY_BASE_URL'): string => {
    let parsed: URL
    try { parsed = new URL(field(key)) } catch { throw new Error(`${key}: нужен корректный адрес`) }
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
    if (parsed.username || parsed.password || parsed.search || parsed.hash
      || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && !production && loopback))
      || (key === 'MEDIA_S3_ENDPOINT' && parsed.pathname !== '/')) throw new Error(`${key}: недопустимый адрес`)
    return parsed.toString().replace(/\/$/, '')
  }
  const endpoint = url('MEDIA_S3_ENDPOINT'), deliveryBaseUrl = url('MEDIA_DELIVERY_BASE_URL')
  const region = field('MEDIA_S3_REGION'), bucket = field('MEDIA_S3_BUCKET')
  if (!/^[a-z0-9-]{1,63}$/.test(region)) throw new Error('MEDIA_S3_REGION: недопустимый регион')
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) throw new Error('MEDIA_S3_BUCKET: недопустимое имя')
  const scannerHost = field('MEDIA_SCAN_HOST'), rawPort = field('MEDIA_SCAN_PORT')
  if (!/^[a-zA-Z0-9.:-]{1,253}$/.test(scannerHost)) throw new Error('MEDIA_SCAN_HOST: недопустимый узел')
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(Number(rawPort)) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('MEDIA_SCAN_PORT: нужен целый порт 1..65535')
  if (localUnboundedPost) {
    const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
    if (![new URL(endpoint).hostname, new URL(deliveryBaseUrl).hostname, scannerHost].every(host => loopback.has(host))) throw new Error('MEDIA_LOCAL_UNBOUNDED_POST: все узлы должны быть loopback')
    return { endpoint, deliveryBaseUrl, region, bucket, accessKey: field('MEDIA_S3_ACCESS_KEY'),
      secretKey: field('MEDIA_S3_SECRET_KEY'), scannerHost, scannerPort: Number(rawPort), localUnboundedPost: true }
  }
  const postMax = field('MEDIA_S3_POST_MAX_SECONDS')
  if (!/^\d+$/.test(postMax) || Number(postMax) < 1 || Number(postMax) > 60) throw new Error('MEDIA_S3_POST_MAX_SECONDS: нужен подтверждённый абсолютный предел 1..60 секунд')
  return { endpoint, deliveryBaseUrl, region, bucket, accessKey: field('MEDIA_S3_ACCESS_KEY'),
    secretKey: field('MEDIA_S3_SECRET_KEY'), scannerHost, scannerPort: Number(rawPort), postMaxSeconds: Number(postMax) }
}
