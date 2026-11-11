import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { atomic, json, localState, present, reportFailure, requireLocal, secretsRoot } from './common.mjs'
import { assertNonRootS3Signer, readS3Credentials } from './s3-credentials.mjs'
import { applicationAccessKey, assertLaunchTicket, portfolioBucket, portfolioPolicy, privateS3Port, provisionS3User } from './s3-policy.mjs'
import { checkPrivateBucket, checkSigner, clientFor } from './s3-checks.mjs'

const exec = promisify(execFile)
const auth = '/local-s3-auth'
const ticketPath = join(auth, 'launch.json')

async function provision() {
  const { identity, phase, api } = localState()
  requireLocal(phase.stage === 'pending', 'LOCAL_PROVISION_PHASE_INVALID')
  requireLocal(readFileSync('/local-objects/.tili-local-instance', 'utf8').trim() === identity.instance, 'LOCAL_VOLUME_IDENTITY_MISMATCH')
  const root = readS3Credentials(auth), ticket = json(ticketPath)
  assertLaunchTicket(ticket, root, 'private', phase)
  assertNonRootS3Signer(root, api.env)
  const { MEDIA_S3_ACCESS_KEY: accessKey, MEDIA_S3_SECRET_KEY: secretKey } = api.env
  requireLocal(api.env.MEDIA_S3_BUCKET === portfolioBucket && accessKey === applicationAccessKey(identity.instance)
    && /^[0-9a-f]{64}$/.test(secretKey), 'LOCAL_S3_SIGNER_IDENTITY_INVALID')

  const port = privateS3Port(identity.s3Port)
  const env = { ...api.env, MEDIA_S3_ENDPOINT: `http://127.0.0.1:${port}` }
  const admin = clientFor(env, { accessKeyId: root.accessKeyId, secretAccessKey: root.secretAccessKey })
  const directory = mkdtempSync('/tmp/tili-minio-')
  try {
    await checkPrivateBucket(admin, identity, true)
    const policyPath = join(directory, 'policy.json')
    writeFileSync(policyPath, JSON.stringify(portfolioPolicy()), { flag: 'wx', mode: 0o600 })
    const mc = async args => {
      try {
        const { stdout } = await exec('/usr/local/bin/mc', ['--json', '--no-color', '--config-dir', directory, ...args], {
          cwd: directory, timeout: 30_000, maxBuffer: 1024 * 1024,
          env: { HOME: directory, PATH: '/usr/local/bin:/usr/bin:/bin', MC_HOST_local: `http://${root.accessKeyId}:${root.secretAccessKey}@127.0.0.1:${port}` },
        })
        return stdout
      } catch {
        // The client includes command arguments in its errors. Never print them.
        throw new Error(`LOCAL_S3_ADMIN_${args.slice(1, 3).join('_').toUpperCase()}_FAILED`)
      }
    }
    await provisionS3User(mc, accessKey, secretKey, policyPath)
    const previousPath = join(secretsRoot, 'previous-api.json')
    const priorKeyRejection = await checkSigner(env, present(previousPath) ? json(previousPath).env : null)
    atomic(ticketPath, { ...ticket, stage: 'public', appAccessKeyId: accessKey })
    console.log('LOCAL_S3_SCOPED_SIGNER_PREPARED', JSON.stringify({ generation: phase.generation, priorKeyRejection }))
  } finally {
    admin.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
}

provision().catch(reportFailure)
