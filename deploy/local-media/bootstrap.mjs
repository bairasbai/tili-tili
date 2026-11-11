import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomic, json, port, projectName, requireLocal, reportFailure, secretsRoot as root } from './common.mjs'
import { applicationAccessKey, portfolioBucket } from './s3-policy.mjs'

const dataRoots = ['/local-pg', '/local-objects']
const authRoots = ['/local-api-auth', '/local-pg-auth', '/local-s3-auth']
const secret = () => randomBytes(32).toString('hex')
try {
  const project = projectName(process.env.LOCAL_PROJECT), webPort = port(process.env.LOCAL_WEB_PORT), s3Port = port(process.env.LOCAL_S3_PORT)
  requireLocal(webPort !== s3Port, 'LOCAL_PORT_COLLISION')
  mkdirSync(root, { recursive: true }); chmodSync(root, 0o755)
  const identityPath = join(root, 'identity.json')
  let identity
  if (existsSync(identityPath)) identity = json(identityPath)
  else {
    requireLocal(readdirSync(root).length === 0 && [...dataRoots, ...authRoots].every(p => readdirSync(p).length === 0), 'LOCAL_UNOWNED_PERSISTENT_DATA')
    identity = { format: 1, provider: 'minio-chainguard-v1', instance: randomUUID(), project, webPort, s3Port, everReady: false,
      dbPassword: secret(), adminPassword: secret(), accessSecret: secret(), refreshSecret: secret() }
    atomic(identityPath, identity, { mode: 0o600 })
  }
  requireLocal(identity.format === 1 && identity.provider === 'minio-chainguard-v1' && identity.project === project
    && identity.webPort === webPort && identity.s3Port === s3Port, 'LOCAL_IDENTITY_MISMATCH')
  requireLocal(/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(identity.instance) && typeof identity.everReady === 'boolean'
    && ['dbPassword', 'adminPassword', 'accessSecret', 'refreshSecret'].every(key => /^[0-9a-f]{64}$/.test(identity[key])), 'LOCAL_IDENTITY_INVALID')
  for (const directory of [...dataRoots, ...authRoots]) {
    const marker = join(directory, '.tili-local-instance')
    if (existsSync(marker)) requireLocal(readFileSync(marker, 'utf8').trim() === identity.instance, 'LOCAL_VOLUME_IDENTITY_MISMATCH')
    else {
      requireLocal(!identity.everReady && readdirSync(directory).length === 0, 'LOCAL_VOLUME_IDENTITY_MISSING')
      atomic(marker, identity.instance + '\n', { mode: 0o444 })
    }
    if (dataRoots.includes(directory)) mkdirSync(join(directory, directory === '/local-pg' ? 'pgdata' : 'data'), { recursive: true })
  }
  const generation = randomUUID()
  if (existsSync(join(root, 'phase.json')) && existsSync(join(root, 'api.json'))) {
    const lastPhase = json(join(root, 'phase.json')), lastApi = json(join(root, 'api.json'))
    requireLocal(lastPhase.project === project && lastPhase.instance === identity.instance
      && lastApi.instance === identity.instance, 'LOCAL_GENERATION_MISMATCH')
    // Preserve the last published credentials through interrupted attempts.
    if (lastPhase.stage === 'ready') {
      requireLocal(lastApi.generation === lastPhase.generation, 'LOCAL_GENERATION_MISMATCH')
      atomic(join(root, 'previous-api.json'), lastApi)
    }
  }
  atomic(join(root, 'phase.json'), { format: 1, project, instance: identity.instance, generation, stage: 'pending' }, { mode: 0o444 })
  atomic('/local-api-auth/phase.json', { format: 1, project, instance: identity.instance, generation, stage: 'pending' }, { mode: 0o444 })
  const rootUser = 'TL' + randomBytes(9).toString('hex').toUpperCase(), rootPassword = secret()
  const env = { NODE_ENV: 'development', HOST: '0.0.0.0', PORT: '3001',
    DATABASE_URL: `postgres://tili_local:${identity.dbPassword}@127.0.0.1:15432/tili_local?application_name=tili-local-api`,
    REDIS_URL: 'redis://127.0.0.1:56379', JWT_ACCESS_SECRET: identity.accessSecret, JWT_REFRESH_SECRET: identity.refreshSecret,
    POLICY_VERSION: '2026-09-02', TRUST_PROXY: '1', CORS_ORIGINS: `http://127.0.0.1:${webPort}`,
    MEDIA_S3_ENDPOINT: `http://127.0.0.1:${s3Port}`, MEDIA_S3_REGION: 'us-east-1', MEDIA_S3_BUCKET: portfolioBucket,
    MEDIA_S3_ACCESS_KEY: applicationAccessKey(identity.instance), MEDIA_S3_SECRET_KEY: secret(),
    MEDIA_DELIVERY_BASE_URL: `http://127.0.0.1:${webPort}/api`,
    MEDIA_SCAN_HOST: '127.0.0.1', MEDIA_SCAN_PORT: '3310', MEDIA_LOCAL_UNBOUNDED_POST: '1', MEDIA_S3_POST_MAX_SECONDS: '' }
  atomic(join(root, 'api.json'), { instance: identity.instance, generation, env })
  atomic('/local-api-auth/api.json', { instance: identity.instance, generation, env }, { uid: 1000 })
  atomic('/local-pg-auth/postgres-admin-password', identity.adminPassword + '\n', { uid: 70 })
  atomic('/local-pg-auth/10-app-role.sql', `CREATE ROLE tili_local LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${identity.dbPassword}';\nALTER DATABASE tili_local OWNER TO tili_local;\n`, { uid: 70 })
  atomic('/local-s3-auth/root-user', rootUser + '\n')
  atomic('/local-s3-auth/root-password', rootPassword + '\n')
  atomic('/local-s3-auth/launch.json', { format: 1, instance: identity.instance, generation, rootAccessKeyId: rootUser, stage: 'private' })
  console.log('LOCAL_CREDENTIAL_GENERATION_PREPARED', generation)
} catch (error) { reportFailure(error) }
