export interface MediaStorageConfig {
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  deliveryBaseUrl: string
  scannerHost: string
  scannerPort: number
}

/** No ambient AWS credential chain and no partially enabled upload capability. */
export function parseMediaStorage(source: NodeJS.ProcessEnv, production: boolean): MediaStorageConfig | null {
  const keys = ['MEDIA_S3_ENDPOINT', 'MEDIA_S3_REGION', 'MEDIA_S3_BUCKET', 'MEDIA_S3_ACCESS_KEY',
    'MEDIA_S3_SECRET_KEY', 'MEDIA_DELIVERY_BASE_URL', 'MEDIA_SCAN_HOST', 'MEDIA_SCAN_PORT'] as const
  if (keys.every(key => !source[key]?.trim())) return null
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
  return { endpoint, deliveryBaseUrl, region, bucket, accessKey: field('MEDIA_S3_ACCESS_KEY'),
    secretKey: field('MEDIA_S3_SECRET_KEY'), scannerHost, scannerPort: Number(rawPort) }
}
