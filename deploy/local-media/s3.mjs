import { json, requireLocal, reportFailure } from './common.mjs'
import { readS3Credentials, s3ProcessEnvironment } from './s3-credentials.mjs'
import { assertLaunchTicket, s3Listener } from './s3-policy.mjs'

try {
  // MinIO silently falls back to default credentials for missing/empty files.
  // Refuse before exec/listen; setup and the API gate happen too late for S3.
  const credentials = readS3Credentials('/run/s3-auth')
  const listener = s3Listener(process.env)
  assertLaunchTicket(json('/run/s3-auth/launch.json'), credentials, process.env.LOCAL_S3_STAGE)
  // Pass the validated values once. MinIO receives no *_FILE or config override.
  const env = s3ProcessEnvironment(credentials, process.env.LOCAL_WEB_PORT)
  requireLocal(typeof process.execve === 'function', 'LOCAL_EXECVE_UNAVAILABLE')
  process.execve('/usr/local/bin/minio', ['minio', 'server', '--quiet', '--address', `${listener.host}:${listener.port}`, '/data/data'], env)
} catch (error) { reportFailure(error) }
