import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { port, requireLocal } from './common.mjs'

export function readS3Credentials(directory, readText = path => readFileSync(path, 'utf8')) {
  try {
    const accessKeyId = readText(join(directory, 'root-user')).trim()
    const secretAccessKey = readText(join(directory, 'root-password')).trim()
    const instance = readText(join(directory, '.tili-local-instance')).trim()
    requireLocal(/^TL[0-9A-F]{18}$/.test(accessKeyId) && /^[0-9a-f]{64}$/.test(secretAccessKey)
      && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(instance), 'LOCAL_S3_CREDENTIAL_FILES_INVALID')
    return { accessKeyId, secretAccessKey, instance }
  } catch {
    throw new Error('LOCAL_S3_CREDENTIAL_FILES_INVALID')
  }
}

export function s3ProcessEnvironment(credentials, webPort) {
  return {
    HOME: '/root',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    MINIO_ROOT_USER: credentials.accessKeyId,
    MINIO_ROOT_PASSWORD: credentials.secretAccessKey,
    MINIO_BROWSER: 'off',
    MINIO_UPDATE: 'off',
    MINIO_SYNC_BOOT: 'on',
    MINIO_API_CORS_ALLOW_ORIGIN: `http://127.0.0.1:${port(webPort)}`,
  }
}

export function assertNonRootS3Signer(root, env) {
  requireLocal(typeof env.MEDIA_S3_ACCESS_KEY === 'string' && env.MEDIA_S3_ACCESS_KEY.length > 0
    && typeof env.MEDIA_S3_SECRET_KEY === 'string' && env.MEDIA_S3_SECRET_KEY.length > 0, 'LOCAL_S3_SIGNER_MISSING')
  requireLocal(env.MEDIA_S3_ACCESS_KEY !== root.accessKeyId
    && env.MEDIA_S3_SECRET_KEY !== root.secretAccessKey, 'LOCAL_S3_ROOT_SIGNER_FORBIDDEN')
}

export function assertS3PhaseReady(phase) {
  requireLocal(phase.stage === 'ready', 'LOCAL_STARTUP_FENCE_PENDING')
  requireLocal(phase.s3Signer === 'non-root', 'LOCAL_S3_SIGNER_NOT_VERIFIED')
}
