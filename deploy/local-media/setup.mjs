import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { S3MediaStore } from '../dist/media/storage.js'
import { ClamMediaScanner } from '../dist/media/scanner.js'
import { parseMediaStorage, mediaStorageIdentity } from '../dist/media/config.js'
import { atomic, json, localState, reportFailure, requireLocal, secretsRoot as root, present } from './common.mjs'
import { assertNonRootS3Signer, readS3Credentials } from './s3-credentials.mjs'
import { assertLaunchTicket, portfolioBucket } from './s3-policy.mjs'
import { checkPrivateBucket, checkSigner, clientFor, request, status } from './s3-checks.mjs'
import { retireLocalMediaObjects } from './retire-objects.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function setup() {
  const { identity, phase, api } = localState()
  requireLocal(phase.stage === 'pending', 'LOCAL_SETUP_PHASE_INVALID')
  for (const directory of ['/local-pg', '/local-objects', '/local-api-auth', '/local-pg-auth', '/local-s3-auth']) {
    requireLocal(readFileSync(join(directory, '.tili-local-instance'), 'utf8').trim() === identity.instance, 'LOCAL_VOLUME_IDENTITY_MISMATCH')
  }
  const rootCredentials = readS3Credentials('/local-s3-auth')
  requireLocal(rootCredentials.instance === identity.instance, 'LOCAL_VOLUME_IDENTITY_MISMATCH')
  assertNonRootS3Signer(rootCredentials, api.env)
  const ticket = json('/local-s3-auth/launch.json')
  assertLaunchTicket(ticket, rootCredentials, 'public', phase)
  requireLocal(ticket.appAccessKeyId === api.env.MEDIA_S3_ACCESS_KEY, 'LOCAL_S3_SIGNER_IDENTITY_INVALID')
  const config = parseMediaStorage(api.env, false), storageId = mediaStorageIdentity(config)
  requireLocal(config.localUnboundedPost === true && config.bucket === portfolioBucket, 'LOCAL_CONFIGURATION_INVALID')
  const db = new pg.Client({ connectionString: `postgres://tili_local_admin:${identity.adminPassword}@127.0.0.1:15432/tili_local?application_name=tili-local-maintenance` })
  const s3 = clientFor(api.env, { accessKeyId: rootCredentials.accessKeyId, secretAccessKey: rootCredentials.secretAccessKey })
  const store = new S3MediaStore(config)
  await db.connect()
  try {
    // The old API/S3 graph has been removed by the exclusive launcher. Wait for
    // PostgreSQL to finish every remaining old client/transaction before reading assets.
    let others = 1
    for (let n = 0; n < 100; n++) {
      others = (await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and backend_type='client backend' and pid<>pg_backend_pid()" )).rows[0].n
      if (!others) break
      await sleep(100)
    }
    requireLocal(others === 0, 'LOCAL_OLD_DATABASE_CLIENTS_ALIVE')
    const comment = (await db.query("select shobj_description(oid,'pg_database') value from pg_database where datname=current_database()" )).rows[0].value
    const expectedComment = 'tili-local-media:' + identity.instance
    requireLocal(comment === expectedComment || (!identity.everReady && comment === null), 'LOCAL_DATABASE_IDENTITY_MISMATCH')
    if (comment === null) await db.query(`comment on database tili_local is '${expectedComment}'`)
    const bucket = config.bucket
    await checkPrivateBucket(s3, identity)
    const anonymous = await fetch(`${config.endpoint}/${bucket}/`, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5000) })
    requireLocal(anonymous.status === 403, 'LOCAL_ANONYMOUS_BUCKET_ACCESS')
    // MinIO uses server-level API CORS; bucket-level PutBucketCors is 501.
    // Qualify both the intended origin and a rejected origin against the live server.
    for (const origin of [`http://127.0.0.1:${identity.webPort}`, 'https://untrusted.invalid']) {
      const cors = await fetch(`${config.endpoint}/${bucket}/`, { method: 'OPTIONS', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
      const allowed = cors.headers.get('access-control-allow-origin')
      requireLocal(origin.endsWith('.invalid') ? allowed === null : cors.status === 204 && allowed === origin
        && cors.headers.get('access-control-allow-methods')?.split(',').map(method => method.trim()).includes('POST'), 'LOCAL_CORS_INVALID')
      await cors.arrayBuffer()
    }
    const previous = present(join(root, 'previous-api.json')) ? json(join(root, 'previous-api.json')).env : null
    const priorKeyRejection = await checkSigner(api.env, previous)
    const deadline = performance.now() + 15 * 60_000
    for (;;) {
      try { await new ClamMediaScanner(config.scannerHost, config.scannerPort, 1000).scan(Buffer.from('Tili local clean readiness control\n')); break }
      catch { requireLocal(performance.now() < deadline, 'LOCAL_SCANNER_UNAVAILABLE'); await sleep(1000) }
    }
    const retired = await retireLocalMediaObjects(db, storageId, async key => {
      await store.remove(key)
      let absent = false
      try { await request(s3, new HeadObjectCommand({ Bucket: bucket, Key: key })) }
      catch (error) { if (status(error) === 404) absent = true; else throw error }
      requireLocal(absent, 'LOCAL_DELETION_NOT_CONFIRMED')
    })
    identity.everReady = true
    atomic(join(root, 'identity.json'), identity, { mode: 0o600 })
    const ready = { ...phase, stage: 'ready', s3Signer: 'non-root', retired,
      storeProof: createHash('sha256').update(identity.instance + ':' + storageId).digest('hex') }
    atomic(join(root, 'phase.json'), ready, { mode: 0o444 })
    atomic('/local-api-auth/phase.json', ready, { mode: 0o444 })
    console.log('LOCAL_OFFLINE_FENCE_READY', JSON.stringify({ generation: phase.generation, retired, priorKeyRejection }))
  } finally { await db.end(); store.close(); s3.destroy() }
}
setup().catch(reportFailure)
