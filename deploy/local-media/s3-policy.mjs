import { port, requireLocal } from './common.mjs'

export const portfolioBucket = 'tili-local-media'
export const portfolioPolicyName = 'tili-portfolio-application'

export function portfolioPolicy() {
  const bucket = `arn:aws:s3:::${portfolioBucket}`
  return { Version: '2012-10-17', Statement: [
    { Effect: 'Allow', Action: ['s3:GetBucketLocation'], Resource: [bucket] },
    { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
      Resource: [`${bucket}/quarantine/*`, `${bucket}/clean/*`] },
  ] }
}

export function applicationAccessKey(instance) {
  return 'TA' + instance.replaceAll('-', '').slice(0, 18).toUpperCase()
}

export function privateS3Port(publicPort) {
  return port(publicPort) === 39001 ? 39002 : 39001
}

export function s3Listener(env) {
  if (env.LOCAL_S3_STAGE === 'private') return { host: '127.0.0.1', port: privateS3Port(env.LOCAL_S3_PORT) }
  requireLocal(env.LOCAL_S3_STAGE === 'public', 'LOCAL_S3_STAGE_INVALID')
  return { host: '0.0.0.0', port: port(env.LOCAL_S3_PORT) }
}

export function assertLaunchTicket(ticket, credentials, stage, phase) {
  requireLocal(ticket?.format === 1 && ticket.stage === stage && ticket.instance === credentials.instance
    && ticket.rootAccessKeyId === credentials.accessKeyId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(ticket.generation)
    && (stage !== 'public' || ticket.appAccessKeyId === applicationAccessKey(ticket.instance))
    && (!phase || (phase.instance === ticket.instance && phase.generation === ticket.generation)), 'LOCAL_S3_LAUNCH_TICKET_INVALID')
}

export function assertOwnedS3Users(rows, accessKey, provisioned = false) {
  requireLocal(Array.isArray(rows) && rows.length <= 1 && rows.every(user => user?.status === 'success'
    && user.accessKey === accessKey), 'LOCAL_S3_FOREIGN_IDENTITY')
  if (provisioned) {
    const user = rows[0]
    requireLocal(user?.policyName === portfolioPolicyName && user.userStatus === 'enabled'
      && (user.memberOf === undefined || (Array.isArray(user.memberOf) && user.memberOf.length === 0)), 'LOCAL_S3_POLICY_NOT_EXCLUSIVE')
  }
  return rows.length === 1
}

export function parseS3Users(output) {
  const entries = output.trim()
  if (!entries) return []
  try { return entries.split(/\r?\n(?=\{)/).map(entry => JSON.parse(entry)) }
  catch { throw new Error('LOCAL_S3_USER_LIST_INVALID') }
}

export async function provisionS3User(mc, accessKey, secretKey, policyPath) {
  const list = async () => parseS3Users(await mc(['admin', 'user', 'list', 'local']))
  if (assertOwnedS3Users(await list(), accessKey)) {
    // Recreating the owned user removes its previous policy associations.
    await mc(['admin', 'user', 'remove', 'local', accessKey])
  }
  await mc(['admin', 'policy', 'create', 'local', portfolioPolicyName, policyPath])
  await mc(['admin', 'user', 'add', 'local', accessKey, secretKey])
  await mc(['admin', 'policy', 'attach', 'local', portfolioPolicyName, '--user', accessKey])
  assertOwnedS3Users(await list(), accessKey, true)
}
